import { describe, expect, it } from "vitest";
import {
  LIVE_FMP_DEFAULT_REQUEST_BUDGET,
  LIVE_FMP_MAX_REQUEST_BUDGET,
  LIVE_FMP_MAX_SECURITIES,
  LiveFmpUsageError,
  normalizeLiveFmpSymbols,
  parseLiveFmpArguments,
} from "./fmp-live-arguments";

/**
 * The command line, which is refused or accepted before anything else happens: parsing reads no
 * variable and opens nothing, so every refusal below is a refusal "before any network request" by
 * construction.
 */

const parse = (...argv: string[]) => parseLiveFmpArguments(argv);

describe("live FMP command line", () => {
  it("accepts one security", () => {
    expect(parse("--symbols", "AAPL", "--full-history")).toEqual({
      symbols: ["AAPL"],
      budget: LIVE_FMP_DEFAULT_REQUEST_BUDGET,
      plan: false,
    });
  });

  it("accepts two", () => {
    expect(parse("--symbols", "AAPL,MSFT", "--full-history").symbols).toEqual([
      "AAPL",
      "MSFT",
    ]);
  });

  it("accepts exactly three", () => {
    expect(LIVE_FMP_MAX_SECURITIES).toBe(3);
    expect(
      parse("--symbols", "AAPL,MSFT,NVDA", "--full-history").symbols,
    ).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  it("refuses a fourth distinct security", () => {
    expect(() =>
      parse("--symbols", "AAPL,MSFT,NVDA,GOOGL", "--full-history"),
    ).toThrowError(
      /at most 3 distinct securities; 4 were given \(AAPL, MSFT, NVDA, GOOGL\)/,
    );
    expect(() =>
      parse("--symbols", "A,B,C,D,E,F,G,H", "--full-history"),
    ).toThrowError(LiveFmpUsageError);
  });

  it("normalizes deterministically and removes duplicates before counting", () => {
    // Six entries, three securities: accepted.
    expect(
      parse("--symbols", " aapl ,AAPL,msft, Msft ,nvda,NVDA", "--full-history")
        .symbols,
    ).toEqual(["AAPL", "MSFT", "NVDA"]);
    // First-seen order, whatever the spelling, and the same answer every time.
    expect(normalizeLiveFmpSymbols("nvda,AAPL,Nvda,aapl")).toEqual([
      "NVDA",
      "AAPL",
    ]);
    expect(normalizeLiveFmpSymbols("nvda,AAPL,Nvda,aapl")).toEqual(
      normalizeLiveFmpSymbols("nvda,AAPL,Nvda,aapl"),
    );
    // Four entries that are four securities are still refused, however they are spelled.
    expect(() => normalizeLiveFmpSymbols("aapl,Msft,NVDA,googl")).toThrowError(
      /4 were given/,
    );
  });

  it("refuses no securities at all", () => {
    expect(() => parse("--full-history")).toThrowError(/--symbols is required/);
    expect(() => parse("--symbols", "", "--full-history")).toThrowError(
      /empty entry/,
    );
    expect(() => parse("--symbols", " ", "--full-history")).toThrowError(
      /empty entry/,
    );
    expect(() => parse("--symbols", "--full-history")).toThrowError(
      /--symbols needs a value/,
    );
    expect(() => parse()).toThrowError(LiveFmpUsageError);
  });

  it.each([
    "AAPL,",
    ",AAPL",
    "AAPL,,MSFT",
    "AAPL MSFT",
    "AAPL;MSFT",
    "^GSPC",
    "AAPL/MSFT",
    "AAPL\tMSFT",
    "A".repeat(21),
    "*",
    "AAPL,$(whoami)",
  ])("refuses the malformed list %j", (list) => {
    expect(() => parse("--symbols", list, "--full-history")).toThrowError(
      LiveFmpUsageError,
    );
  });

  it("keeps the symbols a listing can really have", () => {
    expect(parse("--symbols", "brk-b,BF.B", "--full-history").symbols).toEqual([
      "BRK-B",
      "BF.B",
    ]);
  });

  it("requires the mode to be named", () => {
    expect(() => parse("--symbols", "AAPL")).toThrowError(
      /--full-history is required/,
    );
  });

  it.each([
    [
      ["--symbols", "AAPL", "--full-history", "--all"],
      /Unknown argument '--all'/,
    ],
    [
      ["--symbols", "AAPL", "--full-history", "MSFT"],
      /Unknown argument 'MSFT'/,
    ],
    [["--symbol", "AAPL", "--full-history"], /Unknown argument '--symbol'/],
    [["--symbols=AAPL", "--full-history"], /Unknown argument '--symbols=AAPL'/],
    [["--symbols", "AAPL", "--full-history", "--dry-run"], /Unknown argument/],
    [["--symbols", "AAPL", "--full-history", "--matrix"], /Unknown argument/],
    [["--symbols", "AAPL", "--full-history", "--force"], /Unknown argument/],
    [["AAPL", "--full-history"], /Unknown argument 'AAPL'/],
  ])("refuses the unknown argument in %j", (argv, message) => {
    expect(() => parseLiveFmpArguments(argv)).toThrowError(message);
  });

  it("refuses a flag given twice rather than guessing how to merge it", () => {
    expect(() =>
      parse(
        "--symbols",
        "AAPL,MSFT",
        "--symbols",
        "NVDA,GOOGL",
        "--full-history",
      ),
    ).toThrowError(/--symbols was given more than once/);
    expect(() =>
      parse("--symbols", "AAPL", "--full-history", "--full-history"),
    ).toThrowError(/--full-history was given more than once/);
    expect(() =>
      parse("--symbols", "AAPL", "--full-history", "--plan", "--plan"),
    ).toThrowError(/--plan was given more than once/);
  });

  it("skips the separator pnpm forwards", () => {
    expect(
      parse("--", "--symbols", "AAPL", "--full-history", "--plan"),
    ).toEqual({
      symbols: ["AAPL"],
      budget: LIVE_FMP_DEFAULT_REQUEST_BUDGET,
      plan: true,
    });
  });

  it("takes a budget inside the safe upper bound and nothing else", () => {
    expect(
      parse("--symbols", "AAPL", "--full-history", "--budget", "40").budget,
    ).toBe(40);
    expect(
      parse(
        "--symbols",
        "AAPL",
        "--full-history",
        "--budget",
        String(LIVE_FMP_MAX_REQUEST_BUDGET),
      ).budget,
    ).toBe(LIVE_FMP_MAX_REQUEST_BUDGET);

    for (const value of [
      String(LIVE_FMP_MAX_REQUEST_BUDGET + 1),
      "100000",
      "0",
      "-5",
      "1.5",
      "1e3",
      "0x10",
      "ten",
      "",
      " 40",
    ]) {
      expect(
        () => parse("--symbols", "AAPL", "--full-history", "--budget", value),
        value,
      ).toThrowError(LiveFmpUsageError);
    }
    expect(() =>
      parse("--symbols", "AAPL", "--full-history", "--budget"),
    ).toThrowError(/--budget needs a value/);
  });

  it("does not let an argument reshape its own error message", () => {
    let message = "";
    try {
      parse("--symbols", "AAPL\n\u001b[31mOK", "--full-history");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\u001b");
    expect(message).toContain("is not a symbol");
  });
});

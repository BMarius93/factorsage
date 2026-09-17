import { describe, expect, it } from "vitest";
import { parsePrewarmArguments } from "./prewarm-benchmark-data";

const TODAY = "2026-09-17";

describe("parsePrewarmArguments", () => {
  it("takes one benchmark code and an explicit range", () => {
    expect(
      parsePrewarmArguments(
        ["--code", "SP500_INDEX", "--from", "1990-01-01", "--to", "2000-12-31"],
        TODAY,
      ),
    ).toEqual({
      codes: ["SP500_INDEX"],
      from: "1990-01-01",
      to: "2000-12-31",
    });
  });

  it("takes several codes in one run", () => {
    expect(
      parsePrewarmArguments(
        [
          "--code",
          "SP500_INDEX",
          "--code",
          "DJIA_INDEX",
          "--code",
          "VIX_INDEX",
          "--from",
          "2006-01-01",
        ],
        TODAY,
      ).codes,
    ).toEqual(["SP500_INDEX", "DJIA_INDEX", "VIX_INDEX"]);
  });

  it("defaults the end of the range to today", () => {
    expect(
      parsePrewarmArguments(["--code", "SP500", "--from", "2000-01-01"], TODAY)
        .to,
    ).toBe(TODAY);
  });

  it("has no baked-in start date: the caller names the history they want", () => {
    // There is deliberately no default `--from`. Hardcoding one would put a claim about how much
    // history the provider has into the tool, where it would quietly rot.
    expect(() =>
      parsePrewarmArguments(["--code", "SP500_INDEX"], TODAY),
    ).toThrow(/--from is required/);
  });

  it("refuses an empty, malformed or inverted request", () => {
    expect(() =>
      parsePrewarmArguments(["--from", "2000-01-01"], TODAY),
    ).toThrow(/At least one --code/);
    expect(() =>
      parsePrewarmArguments(["--code", "SP500", "--from", "01-01-2000"], TODAY),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      parsePrewarmArguments(
        ["--code", "SP500", "--from", "2010-01-01", "--to", "2009-01-01"],
        TODAY,
      ),
    ).toThrow(/is after/);
    expect(() => parsePrewarmArguments(["--everything"], TODAY)).toThrow(
      /Unknown argument/,
    );
    expect(() => parsePrewarmArguments(["--code"], TODAY)).toThrow(
      /--code needs a benchmark code/,
    );
  });
});

import type { BacktestEtfConditionDiagnosticsResponse } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { etfConditionsGuidance } from "./etf-conditions";

const READY_XLK: BacktestEtfConditionDiagnosticsResponse = {
  code: "ETF_XLK",
  ticker: "XLK",
  status: "READY",
  firstSession: "1998-12-22",
  latestSession: "2026-10-13",
  basisGeneration: 0,
};

describe("etfConditionsGuidance", () => {
  it("says nothing for a run whose strategy read no ETF", () => {
    expect(etfConditionsGuidance(undefined)).toBeNull();
    expect(etfConditionsGuidance([])).toBeNull();
  });

  it("states the sessions each readable fund was read over, as information", () => {
    const guidance = etfConditionsGuidance([READY_XLK])!;
    expect(guidance.tone).toBe("info");
    expect(guidance.title).toBe("ETF conditions were evaluated");
    expect(guidance.lines).toEqual([
      {
        code: "ETF_XLK",
        ticker: "XLK",
        ready: true,
        text: "Read from its first session, Dec 22, 1998, through Oct 13, 2026.",
      },
    ]);
    // A rule that did not match on available data is the strategy's own answer — said, so a
    // zero-match run is distinguishable from one whose data was missing.
    expect(guidance.note).toContain(
      "Every ETF this strategy reads had data for this run",
    );
    expect(guidance.note).toContain("that is the strategy's own result");
    // Why a rule may still not have fired: pre-listing dates and warm-up, said once.
    expect(guidance.note).toContain("Before a fund's first session");
    expect(guidance.note).toContain("warming up");
  });

  it("stays information on a zero-trade run whose ETF data was all there", () => {
    expect(etfConditionsGuidance([READY_XLK], { totalTrades: 0 })).toMatchObject({
      tone: "info",
      title: "ETF conditions were evaluated",
    });
  });

  it("says when the run read a history restated after it was submitted", () => {
    const guidance = etfConditionsGuidance([
      { ...READY_XLK, basisGeneration: 2, submittedBasisGeneration: 1 },
    ])!;
    expect(guidance.tone).toBe("info");
    expect(guidance.lines[0]?.text).toBe(
      "Read from its first session, Dec 22, 1998, through Oct 13, 2026. Its price history was restated after this backtest was submitted, so the run used the restated history.",
    );
  });

  it("warns as soon as one fund could not be read, naming the cause of each", () => {
    const guidance = etfConditionsGuidance([
      READY_XLK,
      { code: "ETF_GLD", ticker: "GLD", status: "NOT_BOOTSTRAPPED" },
      { code: "ETF_TLT", ticker: "TLT", status: "NOT_SYNCHRONIZED" },
      { code: "ETF_HYG", ticker: "HYG", status: "NO_FINALIZED_SESSIONS" },
      { code: "ETF_USO", ticker: "USO", status: "LOAD_FAILED" },
    ])!;
    expect(guidance.tone).toBe("warning");
    expect(guidance.title).toBe("Some ETF conditions could not be evaluated");
    expect(guidance.lines.map((line) => [line.ticker, line.ready])).toEqual([
      ["XLK", true],
      ["GLD", false],
      ["TLT", false],
      ["HYG", false],
      ["USO", false],
    ]);
    const text = (ticker: string) =>
      guidance.lines.find((line) => line.ticker === ticker)?.text;
    expect(text("GLD")).toContain("has not been loaded");
    expect(text("TLT")).toContain("has not completed a refresh");
    expect(text("HYG")).toContain("no completed session");
    // The one cause a re-run can fix says so.
    expect(text("USO")).toContain("Run the backtest again");
    // What the missing data did to this run, and what to do about it, naming every fund.
    expect(guidance.note).toBe(
      "Rules that read GLD, TLT, HYG and USO never matched in this run, so its trades — or its having none — do not show what this strategy does with those funds' data. Use “Edit and run again” to change the rules that read them, or run the backtest again once the data is available.",
    );
  });

  it("says so plainly when none of them could be read", () => {
    const guidance = etfConditionsGuidance(
      [{ code: "ETF_GLD", ticker: "GLD", status: "NOT_BOOTSTRAPPED" }],
      { totalTrades: 4 },
    )!;
    expect(guidance.title).toBe("The ETF conditions could not be evaluated");
    expect(guidance.note).toBe(
      "Rules that read GLD never matched in this run, so its trades — or its having none — do not show what this strategy does with that fund's data. Use “Edit and run again” to change the rules that read it, or run the backtest again once the data is available.",
    );
  });

  it("puts a zero-trade result and the missing data in one title", () => {
    // The result most easily mistaken for a strategy that found nothing: both facts, side by
    // side, without claiming one caused the other.
    for (const rows of [
      [{ code: "SP500", ticker: "SPY", status: "NOT_BOOTSTRAPPED" }],
      [READY_XLK, { code: "SP500", ticker: "SPY", status: "LOAD_FAILED" }],
    ] as BacktestEtfConditionDiagnosticsResponse[][]) {
      expect(etfConditionsGuidance(rows, { totalTrades: 0 })).toMatchObject({
        tone: "warning",
        title:
          "This run made no trades, and its ETF conditions could not be evaluated",
      });
    }
  });

  it("reads a status it does not know as unavailable, never as fine", () => {
    const guidance = etfConditionsGuidance([
      {
        code: "ETF_XLF",
        ticker: "XLF",
        status: "SOMETHING_NEW",
      } as unknown as BacktestEtfConditionDiagnosticsResponse,
    ])!;
    expect(guidance.tone).toBe("warning");
    expect(guidance.lines[0]).toMatchObject({
      ready: false,
      text: "Its history was not available to this run.",
    });
  });
});

describe("etfConditionsGuidance with Stock's Sector rules", () => {
  const READY_XLF: BacktestEtfConditionDiagnosticsResponse = {
    code: "ETF_XLF",
    ticker: "XLF",
    status: "READY",
    firstSession: "1998-12-22",
    latestSession: "2026-10-13",
    basisGeneration: 0,
  };
  const TECH = (symbol: string) => ({
    symbol,
    sector: "Technology",
    code: "ETF_XLK",
    ticker: "XLK",
  });

  it("says which fund each stock read, as information, when every stock had one", () => {
    const guidance = etfConditionsGuidance([READY_XLF, READY_XLK], {
      totalTrades: 3,
      stockSectors: [
        TECH("AAPL"),
        { symbol: "JPM", sector: "Financial Services", code: "ETF_XLF", ticker: "XLF" },
        TECH("MSFT"),
      ],
    })!;
    expect(guidance.tone).toBe("info");
    expect(guidance.lines.at(-1)).toEqual({
      code: "STOCK_SECTOR",
      ticker: "Stock's Sector",
      ready: true,
      text: "Read per stock from its FMP sector: JPM reads XLF, AAPL and MSFT read XLK.",
    });
  });

  it("warns, naming the stocks and why, when a stock had no sector ETF — even with every fund read", () => {
    const guidance = etfConditionsGuidance([READY_XLK], {
      totalTrades: 0,
      stockSectors: [
        TECH("AAPL"),
        { symbol: "NOSEC", sector: null, code: null, ticker: null },
        { symbol: "ODD", sector: "Conglomerates", code: null, ticker: null },
      ],
    })!;
    expect(guidance.tone).toBe("warning");
    expect(guidance.title).toBe(
      "This run made no trades, and its ETF conditions could not be evaluated",
    );
    expect(guidance.lines.at(-1)).toEqual({
      code: "STOCK_SECTOR",
      ticker: "Stock's Sector",
      ready: false,
      text: "Read per stock from its FMP sector: AAPL reads XLK. No sector ETF for NOSEC (no FMP sector) and ODD (“Conglomerates” is not one of the eleven sectors), so their Stock's Sector rules were not evaluated.",
    });
    expect(guidance.note).toBe(
      "The Stock's Sector rules of NOSEC and ODD never matched in this run, so its trades — or its having none — do not show what this strategy does with that data. Use “Edit and run again” to change those rules, or run the backtest again once the data is available.",
    );
  });

  it("names an unreadable sector fund and an unclassified stock in one note", () => {
    const guidance = etfConditionsGuidance(
      [{ code: "ETF_XLF", ticker: "XLF", status: "NOT_BOOTSTRAPPED" }, READY_XLK],
      {
        totalTrades: 2,
        stockSectors: [
          TECH("AAPL"),
          { symbol: "JPM", sector: "Financial Services", code: "ETF_XLF", ticker: "XLF" },
          { symbol: "NOSEC", sector: null, code: null, ticker: null },
        ],
      },
    )!;
    expect(guidance.tone).toBe("warning");
    expect(guidance.title).toBe("Some ETF conditions could not be evaluated");
    expect(guidance.note).toContain(
      "Rules that read XLF and the Stock's Sector rules of NOSEC never matched in this run",
    );
  });

  it("speaks for a sector-only run even when no stock resolved to a fund", () => {
    const guidance = etfConditionsGuidance([], {
      totalTrades: 0,
      stockSectors: [{ symbol: "NOSEC", sector: null, code: null, ticker: null }],
    })!;
    expect(guidance.tone).toBe("warning");
    expect(guidance.lines).toEqual([
      {
        code: "STOCK_SECTOR",
        ticker: "Stock's Sector",
        ready: false,
        text: "No sector ETF for NOSEC (no FMP sector), so its Stock's Sector rules were not evaluated.",
      },
    ]);
  });
});

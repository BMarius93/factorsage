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
    expect(guidance.title).toBe("ETF conditions");
    expect(guidance.lines).toEqual([
      {
        code: "ETF_XLK",
        ticker: "XLK",
        ready: true,
        text: "Read from its first session, Dec 22, 1998, through Oct 13, 2026.",
      },
    ]);
    // Why a rule may still not have fired: pre-listing dates and warm-up, said once.
    expect(guidance.note).toContain("Before a fund's first session");
    expect(guidance.note).toContain("warming up");
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
    expect(text("GLD")).toContain("has not been loaded yet");
    expect(text("TLT")).toContain("has not completed a refresh");
    expect(text("HYG")).toContain("no completed session");
    // The one cause a re-run can fix says so.
    expect(text("USO")).toContain("Run the backtest again");
    expect(guidance.note).toBe(
      "A condition that cannot be evaluated never matches, so a signal that needs it did not fire in this run.",
    );
  });

  it("says so plainly when none of them could be read", () => {
    const guidance = etfConditionsGuidance([
      { code: "ETF_GLD", ticker: "GLD", status: "NOT_BOOTSTRAPPED" },
    ])!;
    expect(guidance.title).toBe("The ETF conditions could not be evaluated");
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

import type { BacktestEtfConditionDiagnosticsResponse } from "@intrinsic/contracts";
import { formatDay } from "./format";

/**
 * What a run's ETF condition diagnostics mean to the person reading its result
 * (`ai/architecture/strategy-etf-conditions.md` §7).
 *
 * A rule that reads an ETF is decided on that ETF's own completed sessions, and one that could not
 * be decided simply never fires — which, without this, looks exactly like a strategy that found
 * nothing to buy. The run records, per ETF, whether its history could be read at all; this turns
 * that record into one sentence per fund and says, once, what an undecidable session does.
 *
 * The status is the contract's and the sentence is this file's: nothing here re-derives a cause,
 * and a status this build does not know reads as unavailable rather than as fine.
 */
export type EtfConditionLine = {
  readonly code: string;
  readonly ticker: string;
  readonly ready: boolean;
  readonly text: string;
};

export type EtfConditionsGuidance = {
  /** `warning` as soon as one fund could not be read: its rules never matched. */
  readonly tone: "info" | "warning";
  readonly title: string;
  readonly lines: readonly EtfConditionLine[];
  readonly note: string;
};

function lineFor(row: BacktestEtfConditionDiagnosticsResponse): string {
  switch (row.status) {
    case "READY":
      return row.firstSession && row.latestSession
        ? `Read from its first session, ${formatDay(row.firstSession)}, through ${formatDay(row.latestSession)}.`
        : "Read from its stored history.";
    case "NOT_BOOTSTRAPPED":
      return "Its market history has not been loaded yet, so no condition reading it could be evaluated.";
    case "NOT_SYNCHRONIZED":
      return "Its market data has not completed a refresh yet, so no session of it could be confirmed final.";
    case "NO_FINALIZED_SESSIONS":
      return "It has no completed session yet, so no condition reading it could be evaluated.";
    case "LOAD_FAILED":
      return "Its history could not be read during this run. Run the backtest again to retry.";
    default:
      return "Its history was not available to this run.";
  }
}

/** `null` for a run whose strategy read no ETF: there is nothing to say. */
export function etfConditionsGuidance(
  rows: readonly BacktestEtfConditionDiagnosticsResponse[] | undefined,
): EtfConditionsGuidance | null {
  if (!rows || rows.length === 0) {
    return null;
  }
  const lines = rows.map((row) => ({
    code: row.code,
    ticker: row.ticker,
    ready: row.status === "READY",
    text: lineFor(row),
  }));
  const unavailable = lines.filter((line) => !line.ready);
  return {
    tone: unavailable.length > 0 ? "warning" : "info",
    title:
      unavailable.length === 0
        ? "ETF conditions"
        : unavailable.length === lines.length
          ? "The ETF conditions could not be evaluated"
          : "Some ETF conditions could not be evaluated",
    lines,
    note:
      unavailable.length > 0
        ? "A condition that cannot be evaluated never matches, so a signal that needs it did not fire in this run."
        : "An ETF condition is decided on the ETF's own completed sessions. Before a fund's first session, and while one of its indicators is still warming up, the condition cannot be evaluated and a signal that needs it does not fire.",
  };
}

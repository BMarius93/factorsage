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
  /**
   * `warning` as soon as one fund could not be read: its rules never matched, so the result —
   * a zero-trade one above all — is not the strategy's own answer and must not read as one.
   */
  readonly tone: "info" | "warning";
  readonly title: string;
  readonly lines: readonly EtfConditionLine[];
  readonly note: string;
};

function lineFor(row: BacktestEtfConditionDiagnosticsResponse): string {
  switch (row.status) {
    case "READY": {
      const span =
        row.firstSession && row.latestSession
          ? `Read from its first session, ${formatDay(row.firstSession)}, through ${formatDay(row.latestSession)}.`
          : "Read from its stored history.";
      // The provider restated the fund's history between submission and the run reading it.
      return row.submittedBasisGeneration === undefined
        ? span
        : `${span} Its price history was restated after this backtest was submitted, so the run used the restated history.`;
    }
    case "NOT_BOOTSTRAPPED":
      return "Its market history has not been loaded, so no rule reading it could be evaluated.";
    case "NOT_SYNCHRONIZED":
      return "Its market data has not completed a refresh yet, so no session of it could be confirmed final.";
    case "NO_FINALIZED_SESSIONS":
      return "It has no completed session yet, so no rule reading it could be evaluated.";
    case "LOAD_FAILED":
      return "Its history could not be read during this run. Run the backtest again to retry.";
    default:
      return "Its history was not available to this run.";
  }
}

/** `XLK`, `XLK and GLD`, `XLK, GLD and SPY`. */
function tickerList(tickers: readonly string[]): string {
  return tickers.length <= 1
    ? (tickers[0] ?? "")
    : `${tickers.slice(0, -1).join(", ")} and ${tickers[tickers.length - 1]}`;
}

/**
 * `null` for a run whose strategy read no ETF: there is nothing to say.
 *
 * `totalTrades` is the run's own count. A zero-trade run whose ETF data was missing is the result
 * most easily mistaken for a strategy that simply found nothing, so its title states both facts.
 */
export function etfConditionsGuidance(
  rows: readonly BacktestEtfConditionDiagnosticsResponse[] | undefined,
  options: { readonly totalTrades?: number } = {},
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
  if (unavailable.length === 0) {
    return {
      tone: "info",
      title: "ETF conditions were evaluated",
      lines,
      note:
        "Every ETF this strategy reads had data for this run, so where its rules did not match, that is the strategy's own result. An ETF rule is decided on the fund's own completed sessions. Before a fund's first session, and while one of its indicators is still warming up, the rule cannot be evaluated and a signal that needs it does not fire.",
    };
  }
  const missing = tickerList(unavailable.map((line) => line.ticker));
  const one = unavailable.length === 1;
  return {
    tone: "warning",
    title:
      options.totalTrades === 0
        ? "This run made no trades, and its ETF conditions could not be evaluated"
        : unavailable.length === lines.length
          ? "The ETF conditions could not be evaluated"
          : "Some ETF conditions could not be evaluated",
    lines,
    note: `Rules that read ${missing} never matched in this run, so its trades — or its having none — do not show what this strategy does with ${one ? "that fund's" : "those funds'"} data. Use “Edit and run again” to change the rules that read ${one ? "it" : "them"}, or run the backtest again once the data is available.`,
  };
}

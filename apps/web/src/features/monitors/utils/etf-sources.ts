import type { MonitorEtfSourceStatusResponse } from "@intrinsic/contracts";
import { formatDay } from "../../../lib/dates";

/**
 * What a Monitor's ETF source statuses mean to the person watching it
 * (`ai/architecture/strategy-etf-conditions.md` §7).
 *
 * A stock is evaluated against its live price; an ETF only ever against its own **completed**
 * sessions, so a rule reading one is not evaluable for the current session until that session's
 * end-of-day data is in. Without this a watcher sees `Not evaluable` all day and cannot tell an
 * ordinary wait from a fund whose history was never loaded. The status is the contract's and the
 * sentence is this file's; a status this build does not know reads as unavailable, never as fine.
 */
export type EtfSourceLine = {
  readonly code: string;
  readonly ticker: string;
  /** The fund has a completed session its rules can be decided on. */
  readonly ready: boolean;
  readonly text: string;
};

function lineFor(source: MonitorEtfSourceStatusResponse): string {
  switch (source.status) {
    case "READY":
      return source.latestSession
        ? `latest completed session ${formatDay(source.latestSession)}`
        : "its latest session is complete";
    case "AWAITING_SESSION":
      return "its newest session is not final yet";
    case "NOT_SYNCHRONIZED":
      return "its market data has not completed a refresh yet, so its rules cannot be evaluated";
    case "NOT_BOOTSTRAPPED":
      return "its market history has not been loaded yet, so its rules cannot be evaluated";
    default:
      return "its market data is not available";
  }
}

/** `null` for a Monitor whose strategy reads no ETF: there is nothing to say. */
export function etfSourceLines(
  sources: readonly MonitorEtfSourceStatusResponse[] | undefined,
): readonly EtfSourceLine[] | null {
  if (!sources || sources.length === 0) {
    return null;
  }
  return sources.map((source) => ({
    code: source.code,
    ticker: source.ticker,
    ready: source.status === "READY",
    text: lineFor(source),
  }));
}

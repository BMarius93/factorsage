import type { BacktestFailureResponse } from "@intrinsic/contracts";

/**
 * What a failed run means to the person who submitted it, and what to do next.
 *
 * `BacktestFailureResponse.code` is a stable machine code and `phase` says where the run stopped;
 * neither is shown as the explanation (UI-031). The rule that matters is the recovery: a run that
 * failed because its stocks have no data for the period fails identically if it is simply run
 * again, so that case never recommends a retry — it asks for a different list or period. A run
 * interrupted by the system, by contrast, is fine to run again unchanged.
 */
export type FailureGuidance = {
  readonly title: string;
  readonly cause: string;
  readonly next: string;
  /**
   * `edit` — something in the configuration has to change first.
   * `rerun` — the same configuration is expected to work next time.
   */
  readonly recovery: "edit" | "rerun";
};

export function failureGuidance(
  failure: BacktestFailureResponse | null,
): FailureGuidance {
  switch (failure?.code) {
    case "DATA_UNAVAILABLE":
      return {
        title: "No market data for these stocks and period",
        // The API's own sentence is specific ("…for the stocks in this list over the requested
        // period") and product-safe, so it is the cause.
        cause: failure.message,
        next: "Running it again unchanged would fail the same way. Choose a different stock list, or a period the stocks have data for.",
        recovery: "edit",
      };
    case "NO_TRADING_DAYS":
      return {
        title: "The period has no trading days",
        cause: failure.message,
        next: "Choose a longer period, or one that includes market days.",
        recovery: "edit",
      };
    case "EXECUTION_CALENDAR_UNAVAILABLE":
      return {
        title: "The market calendar could not be read",
        cause:
          "FactorSage could not read the trading calendar this run needs. Nothing in your configuration caused this.",
        next: "Wait a few minutes, then run it again with the same settings.",
        recovery: "rerun",
      };
    case "ENGINE_VERSION_MISMATCH":
      return {
        title: "FactorSage was updated while this run was waiting",
        cause:
          "The run was queued under an older version of the backtest engine, so it was stopped rather than executed under different rules.",
        next: "Run it again with the same settings to use the current version.",
        recovery: "rerun",
      };
    case "ABANDONED":
      return {
        title: "The run was interrupted",
        cause:
          "The process executing this run stopped before it finished. Nothing in your configuration caused this.",
        next: "Run it again with the same settings.",
        recovery: "rerun",
      };
    default:
      // `EXECUTION_FAILED` and anything unknown. Where it stopped is the one real clue.
      return failure?.phase === "PREPARING_DATA"
        ? {
            title: "Market data for this run could not be loaded",
            cause:
              "Loading the price and fundamental data for the stocks in this list failed.",
            next: "This can be temporary. If it happens again, some stocks in the list may have no data available — try a different list or period.",
            recovery: "rerun",
          }
        : {
            title: "The simulation stopped unexpectedly",
            cause:
              "Something went wrong while running this backtest, and no result was saved from the attempt.",
            next: "Run it again with the same settings. If it keeps failing, contact support with the details below.",
            recovery: "rerun",
          };
  }
}

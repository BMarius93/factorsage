import type { LocalDate } from "@intrinsic/domain";
import type { BacktestProcessorDependencies } from "../backtest/backtest-processor.js";
import type { EtfContextLoader } from "./etf-context.js";

/**
 * A venue schedule that opens every weekday — the schedule a test without holidays means. A test
 * about a holiday passes its own.
 */
export async function weekdaySessions(date: LocalDate): Promise<boolean> {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day !== 0 && day !== 6;
}

/**
 * The ETF-context dependency for a test whose strategy reads no ETF: every call is a defect, so a
 * suite that accidentally reaches it fails loudly instead of quietly evaluating against nothing.
 *
 * Test support, not product code; the `.test-helper` suffix keeps Vitest from collecting it.
 */
export function stubEtfContexts(): BacktestProcessorDependencies["etfContexts"] {
  const refuse = (): never => {
    throw new Error("This test composes no ETF context loader");
  };
  const loader: EtfContextLoader = {
    getSeries: refuse,
    readFullBenchmarkHistory: refuse,
    benchmarkRefreshState: refuse,
    missingBenchmarkCoverage: refuse,
  };
  return {
    loader,
    publicationDelayMs: 30 * 60 * 1000,
    isScheduledSession: weekdaySessions,
  };
}

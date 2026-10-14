import type { BacktestProcessorDependencies } from "../backtest/backtest-processor.js";
import type { EtfContextLoader } from "./etf-context.js";

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
  return { loader, publicationDelayMs: 30 * 60 * 1000 };
}

import { createBacktestSimulation } from "./simulation.js";
import type {
  BacktestExecutionInput,
  BacktestResult,
  BacktestSecuritySetup,
  BacktestSimulationOptions,
} from "./types.js";

export { BacktestExecutionError } from "./simulation.js";

/**
 * Runs one deterministic portfolio simulation over the whole period at once.
 *
 * This is the **continuous reference path**: every security's frame covers the entire run, so there
 * is exactly one window and nothing is carried across a boundary. Execution itself is the same
 * {@link BacktestSimulation}, so the two paths cannot drift into two day loops; what the windowed
 * regression suites prove is the thing that genuinely differs between them — that per-year
 * projections plus the retained Trigger context row produce the same trades, fills, positions,
 * cash, curve and summary as one whole-period projection.
 *
 * The worker consumes calendar-year windows instead. See
 * `docs/decisions/backtest-year-window-execution-and-absolute-comparison.md` and
 * `ai/architecture/backtest-execution.md`.
 */
export async function simulateBacktest(
  input: BacktestExecutionInput,
  options: BacktestSimulationOptions = {},
): Promise<BacktestResult> {
  const simulation = createBacktestSimulation(
    { ...input, securities: input.securities.map(securitySetup) },
    options,
  );
  await simulation.consumeWholePeriod(
    input.securities.map((security) => security.frame),
  );
  return simulation.finish();
}

/**
 * Identity and BUY eligibility, read off the frame the caller already projected.
 *
 * A windowed run takes these from the run snapshot instead, because the same security is projected
 * once per calendar year and its identity must not depend on which year is resident.
 */
function securitySetup(security: {
  frame: { securityId: string; symbol: string; name: string };
  buyWindows: BacktestSecuritySetup["buyWindows"];
}): BacktestSecuritySetup {
  return {
    securityId: security.frame.securityId,
    symbol: security.frame.symbol,
    name: security.frame.name,
    buyWindows: security.buyWindows,
  };
}

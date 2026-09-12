import { defineConfig } from "vitest/config";

/**
 * Three suites here drive one real PostgreSQL: the backtest job repository, the Monitor scan
 * schedule and the Monitor evaluation cycle. The last two share a literal singleton row
 * (`MonitorScanSchedule`, id `GLOBAL`) and a cycle that evaluates every enabled Monitor there is.
 *
 * Vitest runs test files in parallel by default, which is right for the pure suites here and wrong
 * for those three: run concurrently they contend for the same rows, and a cycle started by one file
 * would evaluate Monitors another file is in the middle of asserting on. `apps/api/vitest.config.ts`
 * and `packages/stock-data/vitest.config.ts` are the same decision for the same reason.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});

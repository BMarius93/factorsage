import { defineConfig } from "vitest/config";

/**
 * Integration suites in this app drive one real PostgreSQL — and, for the stock slices, one real
 * Redis and one real Redlock — through a fully compiled Nest application.
 *
 * Vitest runs test files in parallel by default, which is right for the pure suites here and wrong
 * for the dozen that compile a Nest module graph and hydrate securities against the shared test
 * database: run concurrently they contend for the same connections, locks and rows, and a suite
 * that passes comfortably on its own starts timing out because another file is holding the
 * database. Serializing files removes the contention at its source rather than granting every
 * affected assertion a longer deadline — widening a timeout would only move the point at which the
 * interference becomes visible. `packages/stock-data/vitest.config.ts` is the same decision for
 * the same reason.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});

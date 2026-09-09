import { defineConfig } from "vitest/config";

/**
 * Integration suites in this package drive one real PostgreSQL and one real Redis.
 *
 * Vitest runs test files in parallel by default, which is right for the pure suites here and wrong
 * for the two that materialize years of price and derived-state history: run concurrently they
 * contend for the same connections and the same rows, and a suite that passes comfortably on its
 * own starts timing out because another file is holding the database. Serializing files removes the
 * contention at its source rather than granting every affected assertion a longer deadline —
 * widening a timeout would only move the point at which the interference becomes visible.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});

import { defineConfig, devices } from "@playwright/test";

/**
 * The data-correctness audit's browser stage (`docs/data-correctness-audit/`).
 *
 * Deliberately separate from `playwright.config.ts`: that suite runs only against the hermetic
 * stack and its seeded personas, while this one reads real canonical data from the QA-matrix
 * database through the servers `pnpm audit:data-correctness` starts for it. It never runs on its
 * own; the audit command writes the expectations this spec reads and collects what it observed.
 */
export default defineConfig({
  testDir: "./e2e/data-correctness",
  testMatch: /.*\.audit\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60 * 1000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 1000 },
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "off",
    screenshot: "only-on-failure",
  },
});

import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE, e2eBaseUrl } from "./e2e/utils/env";

/**
 * Playwright runs against an already-running FactorSage stack and never starts one itself, so a
 * suite run cannot rebuild or reset a developer's database. Seed the QA personas once with
 * `pnpm test:users:seed`; see `ai/workflows/auth-testing.md`.
 */
export default defineConfig({
  testDir: "./e2e",
  // Personas share persistent accounts, so tests stay serial rather than racing each other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === "true",
  retries: process.env.CI === "true" ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: e2eBaseUrl(),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "setup",
      testMatch: /setup\/auth\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "guest",
      testMatch: /.*\.guest\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "user",
      testMatch: /.*\.user\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE.QA_USER,
      },
    },
    {
      name: "admin",
      testMatch: /.*\.admin\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: STORAGE_STATE.QA_ADMIN,
      },
    },
  ],
});

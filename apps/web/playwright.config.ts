import { defineConfig, devices } from "@playwright/test";
import { STORAGE_STATE, e2eBaseUrl } from "./e2e/utils/env";
import type { TestPersonaName } from "@intrinsic/testing/personas";

/**
 * Playwright runs against an already-running FactorSage stack and never starts one itself, so a
 * suite run cannot rebuild or reset a developer's database. Seed the personas and their
 * entitlement fixtures once with `pnpm test:personas:seed`; see `ai/workflows/auth-testing.md`.
 *
 * **One project per persona, and a spec's filename chooses it.** `lists.user.spec.ts` runs as the
 * PRO persona, `monitors.free.spec.ts` as the FREE one. That is what makes entitlement specs
 * independent: a spec signs in as the plan it is about and never changes anyone's plan, so no test
 * can leave a persona in a state the next one depends on, and no ordering rule is needed between
 * them.
 *
 * Execution stays serial. The personas are persistent shared accounts and several fixtures are
 * capacity states — a list exactly at its limit, a persona already at its active-Monitor count —
 * so two workers touching one persona at once would produce entitlement failures that are real
 * refusals but not the ones under test. Serial execution is therefore load-bearing here rather
 * than caution, and it predates entitlements.
 */

/**
 * One project, signed in as one persona, matching `*.<suffix>.spec.ts`.
 *
 * The storage-state path comes from the shared persona registry rather than being written here, so
 * a project and the setup that authenticates it cannot disagree about which file holds the session.
 */
function personaProject(suffix: string, persona: TestPersonaName) {
  return {
    name: suffix,
    testMatch: new RegExp(`.*\\.${suffix}\\.spec\\.ts`),
    dependencies: ["setup"],
    use: {
      ...devices["Desktop Chrome"],
      storageState: STORAGE_STATE[persona],
    },
  };
}

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
    // `user` is the PRO persona: it is the default development account and what every
    // non-entitlement spec has always signed in as, now stated in plan terms rather than implied.
    personaProject("user", "PRO_USER"),
    personaProject("admin", "ADMIN_USER"),
    personaProject("free", "FREE_USER"),
    personaProject("starter", "STARTER_USER"),
    personaProject("pro", "PRO_USER"),
    personaProject("downgraded", "DOWNGRADED_USER"),
  ],
});

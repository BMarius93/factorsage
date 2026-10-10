import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * The billing persona suite (`pnpm test:e2e:billing:personas`): what FactorSage shows for accounts
 * whose billing state was built in real Stripe test mode and reconciled by the application.
 *
 * Kept out of the ordinary run on purpose. `playwright.config.ts` has no project matching
 * `*.billing-persona.spec.ts`, so `pnpm test:e2e` never reaches these specs and stays what it has
 * always been: independent of Stripe, on personas whose plans are seeded.
 *
 * **The stack is still the hermetic one, and that is the point.** These specs only *read*: the
 * billing personas were made true beforehand by `pnpm qa:billing:seed -- --database test`, which is
 * the one step that talks to Stripe. The browser then signs in against the ordinary offline E2E
 * stack — inert Stripe placeholders, egress guard armed — and the same global setup and teardown
 * as the main suite fail the run if any process tried to leave the machine. So a page that needed
 * Stripe to render a subscription would fail here, which is a property worth having tested.
 *
 * Everything else — serial execution, the base URL, the reporters — is the ordinary
 * configuration's. `docs/development/billing-qa-personas.md` is the runbook.
 */
export default defineConfig({
  ...base,
  projects: [
    {
      name: "billing-personas-setup",
      testMatch: /setup\/billing-personas\.setup\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "billing-personas",
      testMatch: /.*\.billing-persona\.spec\.ts/,
      dependencies: ["billing-personas-setup"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

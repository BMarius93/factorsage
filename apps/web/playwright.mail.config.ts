import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

/**
 * The email lifecycle suite (`pnpm test:e2e:mail`): registration, activation, sign-in and password
 * reset through real email, delivered by the application's own SMTP sender to the local Mailpit.
 *
 * Kept out of the ordinary run on purpose. `playwright.config.ts` has no project matching
 * `*.mail.spec.ts`, so `pnpm test:e2e` never reaches these specs, and its global setup refuses an
 * API launched in mail mode. This configuration is the only way in: it runs the one `mail` project
 * against the hermetic stack with its API started by `pnpm dev:api:e2e:mail`, which
 * `e2e/global-setup.mail.ts` demands before anything runs.
 *
 * **Nothing here may persist the URLs the suite navigates to.** It follows one-time activation and
 * reset links, so the token is in the URL: the console `list` reporter only — no HTML report, whose
 * step list records every `page.goto` URL — and tracing off, since a trace records every
 * navigation, request and response. Screenshots and videos on failure stay as in the ordinary
 * configuration: they capture the viewport only, and headless Chromium has no address bar.
 *
 * Everything else — serial execution, the base URL, the failure screenshots and videos — is the
 * ordinary configuration's. The suite signs in as nobody: every account it uses it registers itself
 * as an `authmail` disposable account (`@intrinsic/testing/e2e-accounts`).
 */
export default defineConfig({
  ...base,
  reporter: [["list"]],
  use: { ...base.use, trace: "off" },
  globalSetup: "./e2e/global-setup.mail.ts",
  projects: [
    {
      name: "mail",
      testMatch: /.*\.mail\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

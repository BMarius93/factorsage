import { defineConfig, devices } from "@playwright/test";
import { e2eBaseUrl } from "../utils/env";

/**
 * The independent audits' browser checks (`*.audit.spec.ts`), kept out of the regular suite: the
 * regular projects match `*.guest.spec.ts` and the persona suffixes only, so nothing here runs in
 * `pnpm test:e2e`.
 *
 * An audit spec reads a stack the audit started itself — the hermetic launcher pointed at a copy of
 * the development data (`TEST_DATABASE_URL=<copy> pnpm dev:api:e2e`, see
 * `docs/valuation-ratios-audit/REPORT.md`) — and expectations an audit command wrote from its
 * clean-room oracle, so it has no global setup and signs nobody in: Stock Details is public.
 *
 * ```bash
 * VALUATION_AUDIT_EXPECTATIONS=../../.debug/valuation-audit/browser-expectations.json \
 *   pnpm exec playwright test --config e2e/audit/playwright.audit.config.ts
 * ```
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.audit\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: e2eBaseUrl(),
    trace: "off",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "audit", use: { ...devices["Desktop Chrome"] } }],
});

import { hermeticGlobalSetup } from "./global-setup";

/**
 * The email lifecycle suite's global setup (`pnpm test:e2e:mail`): the same hermetic checks as the
 * ordinary suite, against an API launched in mail mode, plus the local Mailpit's preflight and the
 * mail suite's message cleanup. `global-setup.ts` holds all of it.
 */
export default function globalSetup(): Promise<() => Promise<void>> {
  return hermeticGlobalSetup("mail");
}

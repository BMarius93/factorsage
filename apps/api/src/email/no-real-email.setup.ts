import { vi } from "vitest";

/**
 * Loaded before every API test file (`apps/api/vitest.config.ts`), so no test can deliver mail.
 *
 * Suites that exercise email replace `EMAIL_SENDER` with `InMemoryEmailSender`. That protects the
 * suites that remember to do it; this protects everything else. Several suites call
 * `loadRootEnv()`, which reads a developer's `.env` — and a developer `.env` may configure a real
 * SMTP relay or sandbox. A suite that compiles the real `EmailModule` would then build a working
 * `SmtpEmailSender`, and any registration, resend or recovery request it made would reach that
 * relay. Replacing `nodemailer` for the whole package makes that structurally impossible: the
 * transport can still be constructed, so module compilation is unchanged, but every send rejects
 * before a socket is opened. `email/no-real-email.guard.test.ts` proves it.
 */
vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({
    sendMail: vi.fn(() =>
      Promise.reject(
        new Error(
          "Real SMTP delivery is disabled in API tests (no-real-email.setup.ts)",
        ),
      ),
    ),
  })),
}));

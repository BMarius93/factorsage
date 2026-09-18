import { createTransport } from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { SmtpEmailSender } from "./smtp-email-sender";

/**
 * Proves the package-wide guard in `no-real-email.setup.ts` is live.
 *
 * If this file fails, some API test could be delivering real mail through whatever relay a
 * developer's `.env` configures — stop and fix the guard before running any auth suite.
 */
describe("API tests cannot send real email", () => {
  it("replaces the SMTP library for every test file", () => {
    expect(vi.isMockFunction(createTransport)).toBe(true);
  });

  it("makes the real SMTP sender fail before any connection is attempted", async () => {
    const sender = new SmtpEmailSender({
      host: "smtp.invalid",
      port: 2525,
      secure: false,
      from: "no-reply@example.test",
      auth: { user: "synthetic-user", password: "synthetic-password" },
    });

    await expect(
      sender.send({
        to: "person@example.test",
        subject: "guard",
        text: "guard",
        html: "<p>guard</p>",
      }),
    ).rejects.toThrow("Real SMTP delivery is disabled in API tests");

    const transport = vi.mocked(createTransport).mock.results.at(-1)?.value as {
      sendMail: ReturnType<typeof vi.fn>;
    };
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });
});

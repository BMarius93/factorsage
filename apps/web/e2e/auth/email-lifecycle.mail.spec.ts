import { randomBytes } from "node:crypto";
import { e2eDisposableAccountEmail } from "@intrinsic/testing/e2e-accounts";
import {
  MailpitClient,
  extractActionLink,
  type EmailActionLink,
} from "@intrinsic/testing/mailpit";
import { expect, test, type Page } from "../fixtures";
import { apiBaseUrl } from "../utils/entitlements";
import { e2eBaseUrl } from "../utils/env";

/**
 * The email account lifecycle, end to end through real email (`pnpm test:e2e:mail`).
 *
 * Nothing here is faked or shortcut. The application's own SMTP sender delivers to the local
 * Mailpit (`pnpm dev:api:e2e:mail`); the spec reads the one message it caused, checks the link in it
 * points at this web app, and follows it in the browser exactly as a person would:
 *
 * - registration is email-first (AUTH-003): `/register` takes an address and answers neutrally;
 * - the activation link opens `/verify-email`, where the mailbox holder chooses the account's first
 *   password and accepts the Terms in one step (AUTH-002) — opening the link alone redeems nothing;
 * - sign-in is the ordinary form, and only after activation;
 * - recovery is `/forgot-password`, then the emailed `/reset-password` link, which installs a new
 *   password and ends every existing session (SESSION-002, R3).
 *
 * Every account is an `authmail` disposable account: the run's global setup and teardown remove it
 * in whatever lifecycle state it reached (`apps/api/src/e2e-stack/e2e-accounts.ts`), and each test
 * deletes the Mailpit messages it caused — the teardown sweeps any it missed. Tokens and links are
 * never printed: a failure names a link only in its redacted form.
 */

const ACTIVATION_SUBJECT = "Finish creating your FactorSage account";
const RESET_SUBJECT = "Reset your FactorSage password";
const GENERIC_SIGN_IN_ERROR = "Unable to sign in with those credentials.";
const USED_ACTIVATION_LINK =
  "This verification link is invalid, expired, or has already been used.";
const USED_RESET_LINK =
  "This password reset link is invalid, expired, or has already been used.";

// `e2eBaseUrl()` loads the repository `.env` first, so the Mailpit endpoint below sees it too.
const webOrigin = new URL(e2eBaseUrl()).origin;
const mailpit = new MailpitClient();

/** A fresh password that satisfies the registration policy. Never printed. */
function newPassword(): string {
  return `Authmail-${randomBytes(18).toString("base64url")}`;
}

/** The emailed link's one message to `to`, and the link in it, checked before it is followed. */
async function emailedLink(
  to: string,
  subject: string,
  path: "/verify-email" | "/reset-password",
): Promise<EmailActionLink> {
  const message = await mailpit.waitForMessage({ to, subject });
  return extractActionLink(message, { origin: webOrigin, path });
}

/** Opens an emailed link; a failure names the link only in its redacted form. */
async function openEmailLink(page: Page, link: EmailActionLink): Promise<void> {
  try {
    await page.goto(link.href);
  } catch (error) {
    const token = new URL(link.href).searchParams.get("token") ?? link.href;
    const message = (error instanceof Error ? error.message : String(error))
      .split(link.href)
      .join(link.redacted)
      .split(token)
      .join("[redacted]");
    throw new Error(`Opening ${link.redacted} failed: ${message}`);
  }
}

async function register(page: Page, email: string): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  // Neutral by design (AUTH-003): it never says whether an account was created or mail was sent.
  await expect(page.getByTestId("register-accepted")).toContainText(
    "If this address can be used, you'll receive an email with the next step.",
  );
}

/** Fills and submits the activation form the emailed link opened. */
async function submitActivation(page: Page, password: string): Promise<void> {
  await expect(page.getByTestId("verify-form")).toBeVisible();
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await page.getByTestId("accept-terms-checkbox").check();
  await page.getByRole("button", { name: "Accept and create account" }).click();
}

async function activate(
  page: Page,
  link: EmailActionLink,
  password: string,
): Promise<void> {
  await openEmailLink(page, link);
  await submitActivation(page, password);
  await expect(page.getByTestId("verify-success")).toBeVisible();
}

async function submitReset(page: Page, password: string): Promise<void> {
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Change password" }).click();
}

async function submitSignIn(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function expectSignInRefused(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await submitSignIn(page, email, password);
  await expect(page.getByTestId("login-error")).toHaveText(
    GENERIC_SIGN_IN_ERROR,
  );
  await expect(page.getByTestId("account-menu-trigger")).toHaveCount(0);
}

/** Signs in through the form and proves the session is an ordinary USER on FREE. */
async function expectSignsInAsFreeUser(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await submitSignIn(page, email, password);
  await expect(page.getByTestId("account-menu-trigger")).toBeVisible();

  const me = await page.request.get(`${apiBaseUrl()}/auth/me`);
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ email, role: "USER", plan: "FREE" });
}

test.describe("email account lifecycle through Mailpit", () => {
  // Two Argon2id hashes, two emails and several first-hit page compiles per test.
  test.describe.configure({ timeout: 120_000 });

  test("registers, activates through the emailed link, and signs in as a FREE user", async ({
    page,
  }) => {
    const email = e2eDisposableAccountEmail("authmail");
    const password = newPassword();
    try {
      await register(page, email);
      const activation = await emailedLink(
        email,
        ACTIVATION_SUBJECT,
        "/verify-email",
      );

      // Registration set no password (AUTH-003), so nothing signs in before activation.
      await expectSignInRefused(page, email, password);

      await activate(page, activation, password);

      // Single use: the same link, submitted again, activates nothing.
      await openEmailLink(page, activation);
      await submitActivation(page, newPassword());
      await expect(page.getByTestId("verify-failure")).toContainText(
        USED_ACTIVATION_LINK,
      );

      await expectSignsInAsFreeUser(page, email, password);

      // One registration, one message: nothing else was mailed to this address.
      expect(await mailpit.messagesTo(email)).toHaveLength(1);
    } finally {
      await mailpit.deleteMessagesTo(email);
    }
  });

  test("resets a forgotten password through the emailed link and ends the old sessions", async ({
    page,
    request,
  }) => {
    const email = e2eDisposableAccountEmail("authmail");
    const original = newPassword();
    const replacement = newPassword();
    try {
      // A verified, sign-in-capable account, reached through the product's own flow.
      await register(page, email);
      await activate(
        page,
        await emailedLink(email, ACTIVATION_SUBJECT, "/verify-email"),
        original,
      );

      // A session signed in before the reset, held by another client.
      const earlier = await request.post(`${apiBaseUrl()}/auth/login`, {
        data: { email, password: original },
      });
      expect(earlier.status()).toBe(200);
      expect((await request.get(`${apiBaseUrl()}/auth/me`)).status()).toBe(200);

      await page.goto("/forgot-password");
      await page.getByLabel("Email").fill(email);
      await page.getByRole("button", { name: "Send reset link" }).click();
      await expect(page.getByTestId("forgot-password-sent")).toBeVisible();

      const reset = await emailedLink(email, RESET_SUBJECT, "/reset-password");
      await openEmailLink(page, reset);
      await submitReset(page, replacement);
      await expect(page.getByTestId("reset-password-success")).toBeVisible();

      // Single use: the same link, submitted again, changes nothing.
      await openEmailLink(page, reset);
      await submitReset(page, newPassword());
      await expect(page.getByTestId("reset-password-invalid")).toContainText(
        USED_RESET_LINK,
      );

      await expectSignInRefused(page, email, original);
      await expectSignsInAsFreeUser(page, email, replacement);

      // The reset ended the session issued before it.
      expect((await request.get(`${apiBaseUrl()}/auth/me`)).status()).toBe(401);

      // One activation, one reset: nothing else was mailed to this address.
      expect(
        (await mailpit.messagesTo(email))
          .map((message) => message.Subject)
          .sort(),
      ).toEqual([ACTIVATION_SUBJECT, RESET_SUBJECT].sort());
    } finally {
      await mailpit.deleteMessagesTo(email);
    }
  });
});

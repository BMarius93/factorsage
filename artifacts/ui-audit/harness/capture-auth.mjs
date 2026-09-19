// Section 13 — authentication surfaces. Every email-sending endpoint is mocked in the browser
// (register, resend-verification, forgot-password), so nothing reaches the API's sender at all.
import { launch, personaContext, watch, settle, shot, VIEWPORTS as V, saveManifest, jsonRoute, hangRoute, apiUrl } from "./lib.mjs";

const browser = await launch();
const A = "auth";
const std = [V.d1440, V.t1024, V.m390];

async function guestPage(vp = V.d1440) {
  const ctx = await personaContext(browser, "guest", vp);
  const page = await ctx.newPage();
  watch(page);
  return { ctx, page };
}
async function step(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`  ✗ ${label}: ${String(e).split("\n")[0]}`);
  }
}
const meta = (name, state, extra = {}) => ({ area: A, name, persona: "guest", state, section: "13 Authentication", ...extra });

for (const vp of std) {
  const { ctx, page } = await guestPage(vp);
  await step("login default", async () => {
    await page.goto("/login"); await settle(page);
    await shot(page, { ...meta("login-default", "Sign in, Google not configured (hermetic stack)", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("register default", async () => {
    await page.goto("/register"); await settle(page);
    await shot(page, { ...meta("register-default", "Create account form (email only)", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("forgot default", async () => {
    await page.goto("/forgot-password"); await settle(page);
    await shot(page, { ...meta("forgot-password-default", "Password recovery request form", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("verify no token", async () => {
    await page.goto("/verify-email"); await settle(page);
    await shot(page, { ...meta("verify-email-no-token", "Verification page opened without a token", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("verify with token", async () => {
    await page.goto("/verify-email?token=audit-fake-token"); await settle(page);
    await shot(page, { ...meta("verify-email-set-password", "Verification link opened: choose password form", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("reset no token", async () => {
    await page.goto("/reset-password"); await settle(page);
    await shot(page, { ...meta("reset-password-no-token", "Reset page opened without a token", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("reset with token", async () => {
    await page.goto("/reset-password?token=audit-fake-token"); await settle(page);
    await shot(page, { ...meta("reset-password-form", "Reset link opened: new password form", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await ctx.close();
}

// Google provider available (mocked /auth/providers) — desktop + phone.
for (const vp of [V.d1440, V.m390]) {
  const { ctx, page } = await guestPage(vp);
  await page.route(apiUrl("/auth/providers"), jsonRoute({ google: true }));
  await step("login google", async () => {
    await page.goto("/login"); await settle(page);
    await shot(page, { ...meta("login-with-google", "Sign in with Google offered", { mocks: ["GET /auth/providers → {google:true}"], expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("register google", async () => {
    await page.goto("/register"); await settle(page);
    await shot(page, { ...meta("register-with-google", "Create account with Google offered", { mocks: ["GET /auth/providers → {google:true}"], expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await ctx.close();
}

// Interaction states, desktop + phone.
for (const vp of [V.d1440, V.m390]) {
  const { ctx, page } = await guestPage(vp);
  await step("login empty submit", async () => {
    await page.goto("/login"); await settle(page);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(400);
    await shot(page, { ...meta("login-empty-submit", "Submit with empty fields", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("login invalid", async () => {
    await page.goto("/login"); await settle(page);
    await page.getByLabel("Email").fill("nobody@factorsage.test");
    await page.getByLabel("Password").fill("wrong-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(1200);
    await shot(page, { ...meta("login-invalid-credentials", "Invalid credentials (real API 401)", { expectedFailures: ["/auth/me", "/auth/login"] }), viewport: vp });
  });
  await step("login loading", async () => {
    await page.route(apiUrl("/auth/login"), hangRoute());
    await page.goto("/login"); await settle(page);
    await page.getByLabel("Email").fill("someone@factorsage.test");
    await page.getByLabel("Password").fill("some-password-123");
    await page.getByRole("button", { name: /Sign/ }).click();
    await page.waitForTimeout(500);
    await shot(page, { ...meta("login-submitting", "Sign-in request in flight", { mocks: ["POST /auth/login hangs"], expectedFailures: ["/auth/me"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/login"));
  });
  await step("login 429", async () => {
    await page.route(apiUrl("/auth/login"), jsonRoute({ statusCode: 429, code: "RATE_LIMITED", message: "Too many requests" }, 429));
    await page.goto("/login"); await settle(page);
    await page.getByLabel("Email").fill("someone@factorsage.test");
    await page.getByLabel("Password").fill("some-password-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(800);
    await shot(page, { ...meta("login-rate-limited", "Sign-in refused with 429", { mocks: ["POST /auth/login → 429"], expectedFailures: ["/auth/me", "/auth/login"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/login"));
  });
  await step("login oauth error", async () => {
    await page.goto("/login?error=oauth_link_not_allowed"); await settle(page);
    await shot(page, { ...meta("login-oauth-link-refused", "Returned from Google with ?error=oauth_link_not_allowed", { expectedFailures: ["/auth/me"] }), viewport: vp });
    await page.goto("/login?error=oauth_provider"); await settle(page);
    await shot(page, { ...meta("login-oauth-provider-error", "Returned from Google with ?error=oauth_provider", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("register submitted", async () => {
    await page.route(apiUrl("/auth/register"), jsonRoute({ status: "accepted" }, 202, 300));
    await page.goto("/register"); await settle(page);
    await page.getByLabel("Email").fill("new-person@factorsage.test");
    await page.getByRole("button", { name: /Create|Continue|Sign up|Register/i }).first().click();
    await page.waitForTimeout(1000);
    await shot(page, { ...meta("register-submitted", "Registration accepted (neutral confirmation)", { mocks: ["POST /auth/register → 202 (mocked; no email)"], expectedFailures: ["/auth/me"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/register"));
  });
  await step("register invalid email", async () => {
    await page.goto("/register"); await settle(page);
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: /Create|Continue|Sign up|Register/i }).first().click();
    await page.waitForTimeout(500);
    await shot(page, { ...meta("register-invalid-email", "Malformed email submitted", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("register server error", async () => {
    await page.route(apiUrl("/auth/register"), jsonRoute({ statusCode: 500, message: "Internal server error" }, 500));
    await page.goto("/register"); await settle(page);
    await page.getByLabel("Email").fill("new-person@factorsage.test");
    await page.getByRole("button", { name: /Create|Continue|Sign up|Register/i }).first().click();
    await page.waitForTimeout(800);
    await shot(page, { ...meta("register-server-error", "Registration request failed (500)", { mocks: ["POST /auth/register → 500"], expectedFailures: ["/auth/me", "/auth/register"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/register"));
  });
  await step("forgot submitted", async () => {
    await page.route(apiUrl("/auth/forgot-password"), jsonRoute({ status: "accepted" }, 202, 300));
    await page.goto("/forgot-password"); await settle(page);
    await page.getByLabel("Email").fill("someone@factorsage.test");
    await page.getByRole("button").filter({ hasText: /send|reset|continue/i }).first().click();
    await page.waitForTimeout(1000);
    await shot(page, { ...meta("forgot-password-submitted", "Recovery request accepted (neutral)", { mocks: ["POST /auth/forgot-password → 202 (mocked; no email)"], expectedFailures: ["/auth/me"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/forgot-password"));
  });
  await step("verify mismatch", async () => {
    await page.goto("/verify-email?token=audit-fake-token"); await settle(page);
    await page.getByLabel("New password").fill("abcdefghijklm");
    await page.getByLabel(/Confirm/).fill("abcdefghijklX");
    await page.getByRole("button").filter({ hasText: /./ }).last().click();
    await page.waitForTimeout(400);
    await shot(page, { ...meta("verify-email-mismatch", "Password confirmation mismatch (client-side)", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("verify short", async () => {
    await page.goto("/verify-email?token=audit-fake-token"); await settle(page);
    await page.getByLabel("New password").fill("short");
    await page.getByLabel(/Confirm/).fill("short");
    await page.locator("form[data-testid=verify-form] button[type=submit]").click();
    await page.waitForTimeout(400);
    await shot(page, { ...meta("verify-email-too-short", "Password below minimum length", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("verify success", async () => {
    await page.route(apiUrl("/auth/verify-email"), jsonRoute({ status: "verified" }, 200, 300));
    await page.goto("/verify-email?token=audit-fake-token"); await settle(page);
    await page.getByLabel("New password").fill("a-long-audit-password");
    await page.getByLabel(/Confirm/).fill("a-long-audit-password");
    await page.locator("form[data-testid=verify-form] button[type=submit]").click();
    await page.waitForTimeout(900);
    await shot(page, { ...meta("verify-email-success", "Verified and password set", { mocks: ["POST /auth/verify-email → 200"], expectedFailures: ["/auth/me"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/verify-email"));
  });
  await step("verify invalid", async () => {
    await page.route(apiUrl("/auth/verify-email"), jsonRoute({ statusCode: 401, message: "Unauthorized" }, 401));
    await page.goto("/verify-email?token=audit-fake-token"); await settle(page);
    await page.getByLabel("New password").fill("a-long-audit-password");
    await page.getByLabel(/Confirm/).fill("a-long-audit-password");
    await page.locator("form[data-testid=verify-form] button[type=submit]").click();
    await page.waitForTimeout(900);
    await shot(page, { ...meta("verify-email-invalid-token", "Expired/used/unknown link (401)", { mocks: ["POST /auth/verify-email → 401"], expectedFailures: ["/auth/me", "/auth/verify-email"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/verify-email"));
  });
  await step("reset invalid", async () => {
    await page.route(apiUrl("/auth/reset-password"), jsonRoute({ statusCode: 400, message: "This password reset link is invalid or has expired", error: "Unauthorized" }, 401));
    await page.goto("/reset-password?token=audit-fake-token"); await settle(page);
    await page.locator("input[type=password]").nth(0).fill("a-long-audit-password");
    await page.locator("input[type=password]").nth(1).fill("a-long-audit-password");
    await page.locator("form button[type=submit]").click();
    await page.waitForTimeout(900);
    await shot(page, { ...meta("reset-password-invalid-token", "Reset link rejected (401)", { mocks: ["POST /auth/reset-password → 401"], expectedFailures: ["/auth/me", "/auth/reset-password"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/reset-password"));
  });
  await step("reset success", async () => {
    await page.route(apiUrl("/auth/reset-password"), jsonRoute({ status: "reset" }, 200, 300));
    await page.goto("/reset-password?token=audit-fake-token"); await settle(page);
    await page.locator("input[type=password]").nth(0).fill("a-long-audit-password");
    await page.locator("input[type=password]").nth(1).fill("a-long-audit-password");
    await page.locator("form button[type=submit]").click();
    await page.waitForTimeout(900);
    await shot(page, { ...meta("reset-password-success", "Password reset complete", { mocks: ["POST /auth/reset-password → 200"], expectedFailures: ["/auth/me"] }), viewport: vp });
    await page.unroute(apiUrl("/auth/reset-password"));
  });
  await step("resend from invalid", async () => {
    await page.route(apiUrl("/auth/resend-verification"), jsonRoute({ status: "accepted" }, 202, 200));
    await page.goto("/verify-email"); await settle(page);
    await page.locator("[data-testid=verify-failure] input[type=email]").fill("someone@factorsage.test");
    await page.getByRole("button").filter({ hasText: /send|resend/i }).first().click();
    await page.waitForTimeout(900);
    await shot(page, { ...meta("verify-email-resend-submitted", "Resend verification link submitted", { mocks: ["POST /auth/resend-verification → 202 (mocked; no email)"], expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await step("guest bounce", async () => {
    await page.goto("/strategies/new"); await settle(page, 1200);
    await shot(page, { ...meta("guest-bounced-from-protected-route", "Guest opens /strategies/new → RequireAuth", { expectedFailures: ["/auth/me"] }), viewport: vp });
  });
  await ctx.close();
}

// Signed-in surfaces: account menu, /login while signed in, sign-out.
for (const vp of [V.d1440, V.m390]) {
  const ctx = await personaContext(browser, "pro", vp);
  const page = await ctx.newPage();
  watch(page);
  await step("account menu", async () => {
    await page.goto("/dashboard"); await settle(page);
    await page.getByTestId("account-menu-trigger").click();
    await page.waitForTimeout(400);
    await shot(page, { area: A, name: "pro-account-menu-open", persona: "pro", state: "Account menu open", section: "6 Shell / 13 Auth", viewport: vp, fullPage: false });
  });
  await step("login while signed in", async () => {
    await page.goto("/login"); await settle(page, 1200);
    await shot(page, { area: A, name: "pro-visits-login-while-signed-in", persona: "pro", state: "Signed-in user opens /login", section: "13 Authentication", viewport: vp });
  });
  await ctx.close();
}
for (const persona of ["free-limit", "starter-limit", "master", "guest"]) {
  const ctx = await personaContext(browser, persona, V.d1440);
  const page = await ctx.newPage();
  watch(page);
  await step(`menu ${persona}`, async () => {
    await page.goto("/dashboard"); await settle(page);
    const t = page.getByTestId("account-menu-trigger");
    if (await t.count()) { await t.click(); await page.waitForTimeout(300); }
    await shot(page, { area: A, name: `${persona}-account-menu-open`, persona, state: "Account menu / guest topbar", section: "6 Shell / 13 Auth", viewport: V.d1440, fullPage: false, expectedFailures: persona === "guest" ? ["/auth/me"] : [] });
  });
  await ctx.close();
}
// Sign out in an isolated context (ordinary logout clears only this context's cookie).
await step("sign out", async () => {
  const ctx = await personaContext(browser, "free-empty", V.d1440);
  const page = await ctx.newPage(); watch(page);
  await page.goto("/dashboard"); await settle(page);
  await page.getByTestId("account-menu-trigger").click();
  await page.getByRole("menuitem", { name: /^Sign out$/ }).click();
  await settle(page, 1200);
  await shot(page, { area: A, name: "after-sign-out", persona: "free-empty", state: "Immediately after Sign out", section: "13 Authentication", viewport: V.d1440, expectedFailures: ["/auth/me"] });
  await ctx.close();
});

saveManifest();
await browser.close();

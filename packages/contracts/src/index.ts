import type { UserPlan } from "./entitlements.js";

export type HealthResponse = {
  status: "ok";
  service: "api";
};

export const USER_ROLES = ["USER", "ADMIN"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export type LoginRequest = {
  email: string;
  password: string;
};

export type AuthUser = {
  id: string;
  email: string;
  role: UserRole;
  /**
   * The caller's persisted commercial plan.
   *
   * Server-resolved and read-only, exactly like `role`: it is reported so the UI can annotate and
   * upsell, never so a client can assert it. Every entitlement check reloads plan and role from
   * PostgreSQL and ignores whatever the request carried.
   */
  plan: UserPlan;
};

/** Local-password policy, shared so the registration UI and the API cannot disagree. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 1024;

/**
 * Email-first registration (AUTH-003): the address is the whole request.
 *
 * No password is taken here. The first usable password is chosen by whoever holds the emailed
 * activation link, on `/verify-email` — the only person who has proven control of the mailbox.
 */
export type RegisterRequest = {
  email: string;
};

/**
 * Always the same for a well-formed address. The API deliberately does not report whether the
 * address was new, already registered, pending, signed in with Google, or recently submitted, or
 * whether an email was sent, so registration cannot be used to enumerate accounts.
 */
export type RegisterResponse = {
  status: "accepted";
};

/**
 * Redeems a verification link **and sets the account's password**.
 *
 * The password is chosen by whoever holds the link, which is the only person who has proven
 * control of the mailbox. A password entered at registration is never activated by verification
 * (AUTH-002): anyone can register an address they do not own.
 */
export type VerifyEmailRequest = {
  token: string;
  password: string;
  /**
   * The Terms of Service version the holder of the link accepted, unchecked-to-checked, on the
   * activation form.
   *
   * Required. Activation is the moment the verified mailbox holder becomes the account holder,
   * so it is the only point on the email path at which acceptance can be bound to a person
   * rather than to whoever typed an address into a registration form. The server refuses a
   * missing, unknown or superseded version with `400` and redeems nothing, and it writes the
   * acceptance inside the same transaction that installs the password — so an account can never
   * exist without its acceptance, and a failed acceptance can never leave an activated account.
   *
   * It is deliberately a version rather than a boolean: a boolean records that a box was ticked,
   * not what was agreed to.
   */
  termsVersion: string;
};

export type VerifyEmailResponse = {
  status: "verified";
};

export type ResendVerificationRequest = {
  email: string;
};

/**
 * Always accepted. The API deliberately does not report whether the address exists or is
 * already verified, so the endpoint cannot be used to enumerate accounts.
 */
export type ResendVerificationResponse = {
  status: "accepted";
};

export type ForgotPasswordRequest = {
  email: string;
};

/**
 * Always accepted, and deliberately identical for every address.
 *
 * An unknown address, an address whose account signs in with Google and has no local password,
 * and an address that really was sent a link all produce this one response, so the endpoint
 * cannot be used to discover who has an account or how they sign in.
 */
export type ForgotPasswordResponse = {
  status: "accepted";
};

export type ResetPasswordRequest = {
  token: string;
  password: string;
};

export type ResetPasswordResponse = {
  status: "password_reset";
};

/** Which external identity providers this deployment actually has configured. */
export type AuthProvidersResponse = {
  google: boolean;
};

/**
 * `error` query values the API can put on its post-OAuth redirect back to the web app.
 * The browser never receives provider detail beyond these stable codes.
 */
export const OAUTH_ERROR_CODES = [
  "oauth_state",
  "oauth_provider",
  "oauth_email_unverified",
  /**
   * The provider identity is verified, but the provider is not authoritative for that email
   * address, and a FactorSage account already holds it. Linking automatically would hand the
   * existing account to whoever proved control of the address at the provider, which is not the
   * same as owning it here.
   */
  "oauth_link_not_allowed",
  "oauth_unavailable",
] as const;

export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export type AdminHealthResponse = {
  status: "ok";
  role: "ADMIN";
};

/** One readiness probe: a dependency answered inside the timeout, or how it failed. */
export type ReadinessCheck = {
  status: "ok" | "failed";
  latencyMs: number;
  error?: string;
};

/**
 * `GET /health/ready`. `ok` is served with `200`; `unavailable` is served with `503` and the same
 * body, so the per-dependency detail is visible either way. Only the dependencies every request
 * needs are probed — PostgreSQL and Redis — never the market-data provider.
 */
export type ReadinessResponse = {
  status: "ok" | "unavailable";
  checks: { postgres: ReadinessCheck; redis: ReadinessCheck };
};

export * from "./billing.js";
export * from "./entitlements.js";
export * from "./selectable-series.js";
export * from "./stock-data.js";
export * from "./stock-lists.js";
export * from "./strategies.js";
export * from "./dates.js";
export * from "./backtests.js";
export * from "./monitors.js";
export * from "./builtins.js";
export * from "./dashboard.js";
export * from "./market.js";
export * from "./rate-limits.js";
export * from "./legal.js";
export * from "./legal-documents.js";

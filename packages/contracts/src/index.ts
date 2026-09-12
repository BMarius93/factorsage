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
 * Returned by `POST /auth/login` when the credentials are correct but the local email address
 * has not been verified yet. Correct credentials are required to reach this state, so it does
 * not reveal anything the caller does not already know.
 */
export const EMAIL_NOT_VERIFIED_CODE = "EMAIL_NOT_VERIFIED" as const;

export type RegisterRequest = {
  email: string;
  password: string;
};

export type RegisterResponse = {
  status: "verification_sent";
};

export type VerifyEmailRequest = {
  token: string;
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

export * from "./entitlements.js";
export * from "./selectable-series.js";
export * from "./stock-data.js";
export * from "./stock-lists.js";
export * from "./strategies.js";
export * from "./dates.js";
export * from "./backtests.js";
export * from "./monitors.js";

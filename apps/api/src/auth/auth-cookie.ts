import type { CookieOptions } from "express";
import type { AuthConfig } from "../config/configuration.module";

/** Scoped to `/auth` so the short-lived OAuth transaction cookie only reaches the callback. */
const OAUTH_TRANSACTION_COOKIE_PATH = "/auth";

/** A sign-in round trip that takes longer than this is abandoned rather than replayable. */
const OAUTH_TRANSACTION_TTL_SECONDS = 10 * 60;

export function authCookieOptions(
  config: AuthConfig,
  includeMaxAge: boolean,
): CookieOptions {
  return {
    httpOnly: true,
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    path: "/",
    ...(includeMaxAge ? { maxAge: config.tokenTtlSeconds * 1000 } : {}),
  };
}

export function oauthTransactionCookieName(config: AuthConfig): string {
  return `${config.cookieName}_oauth_tx`;
}

/**
 * HttpOnly so the PKCE verifier, state, and nonce are never readable by browser JavaScript.
 */
export function oauthTransactionCookieOptions(
  config: AuthConfig,
  includeMaxAge: boolean,
): CookieOptions {
  return {
    httpOnly: true,
    // Lax still sends the cookie on the provider's top-level GET redirect back to the callback.
    sameSite: config.cookieSameSite,
    secure: config.cookieSecure,
    path: OAUTH_TRANSACTION_COOKIE_PATH,
    ...(includeMaxAge ? { maxAge: OAUTH_TRANSACTION_TTL_SECONDS * 1000 } : {}),
  };
}

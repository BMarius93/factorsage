/**
 * The session token's claims, and the one rule that decides whether a token is still current.
 *
 * A session token is `{ sub, sv }`: the user id, and the `User.sessionVersion` the account was at
 * when the token was issued. A token is accepted only while `sv` still equals the persisted
 * column, so incrementing the column (password reset, "sign out everywhere") revokes every token
 * issued before it. The database stays the authority: the claim is compared with the row, never
 * trusted on its own. See `ai/architecture/authentication.md`, SESSION-002.
 */

/** JWT claim carrying the session version. Short, like `sub`: it travels on every request. */
export const SESSION_VERSION_CLAIM = "sv";

export type SessionClaims = {
  readonly subject: string;
  /**
   * The version the token was issued under, or `null` for a **legacy** token signed before the
   * claim existed. `null` is never "whatever the account is at now" — see `isCurrentSession`.
   */
  readonly sessionVersion: number | null;
};

/**
 * Extracts `sub` and `sv` from an already signature-verified payload.
 *
 * Returns `null` — an unusable token — for a missing or non-string `sub`, and for an `sv` that is
 * present but is not a non-negative safe integer. A malformed version is refused rather than
 * treated as absent: only a token that genuinely predates the claim gets the legacy rule.
 */
export function parseSessionClaims(payload: unknown): SessionClaims | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  const claims = payload as Record<string, unknown>;
  if (typeof claims.sub !== "string" || claims.sub.length === 0) {
    return null;
  }

  if (!(SESSION_VERSION_CLAIM in claims)) {
    return { subject: claims.sub, sessionVersion: null };
  }

  const version = claims[SESSION_VERSION_CLAIM];
  if (
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 0
  ) {
    return null;
  }

  return { subject: claims.sub, sessionVersion: version };
}

/**
 * Whether a token issued under `claimed` is still a live session for an account now at `current`.
 *
 * Equality, never ordering: a lower claim was revoked, and a higher one was never issued by this
 * server for this account, so both are refused.
 *
 * A legacy token (`claimed === null`) is accepted only while the account is still at version `0`.
 * That is what lets the column ship without signing everybody out: every token that existed before
 * the migration belongs to an account at `0`, and the account's first increment revokes them like
 * any other. Once an account has moved past `0` a claimless token is never current again. Every
 * token issued since the migration carries an explicit `sv`, so after one `AUTH_TOKEN_TTL_SECONDS`
 * no legacy token remains and this branch can be deleted.
 */
export function isCurrentSession(
  claimed: number | null,
  current: number,
): boolean {
  return claimed === null ? current === 0 : claimed === current;
}

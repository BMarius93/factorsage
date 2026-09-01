import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 256 bits each; the base64url alphabet is a subset of the RFC 7636 `code_verifier` set. */
const SECRET_BYTES = 32;

/**
 * Per-sign-in secrets bound to the browser that started the flow.
 *
 * `state` is the anti-CSRF value echoed by the provider, `codeVerifier` is the PKCE secret proven
 * during the token exchange, and `nonce` binds the returned ID token to this one authorization
 * request. None of the three ever reaches browser JavaScript or a log line.
 */
export type OAuthTransaction = {
  readonly state: string;
  readonly codeVerifier: string;
  readonly nonce: string;
};

function randomSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

export function createOAuthTransaction(): OAuthTransaction {
  return {
    state: randomSecret(),
    codeVerifier: randomSecret(),
    nonce: randomSecret(),
  };
}

/**
 * RFC 7636 S256 challenge: `base64url(SHA-256(ASCII(code_verifier)))`.
 *
 * Only S256 is ever used. `plain` would put the verifier itself in the authorization redirect and
 * defeat the point of PKCE.
 */
export function codeChallengeFor(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/**
 * Serializes the transaction for its HttpOnly cookie.
 *
 * Tampering gains an attacker nothing: a modified transaction fails the state comparison, or
 * fails PKCE and nonce validation at Google. What matters is that a third party cannot set this
 * cookie on the victim's browser.
 */
export function encodeOAuthTransaction(transaction: OAuthTransaction): string {
  return Buffer.from(
    JSON.stringify([
      transaction.state,
      transaction.codeVerifier,
      transaction.nonce,
    ]),
  ).toString("base64url");
}

export function decodeOAuthTransaction(
  value: string | undefined,
): OAuthTransaction | null {
  if (!value) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    !parsed.every((part) => typeof part === "string" && part.length > 0)
  ) {
    return null;
  }

  const [state, codeVerifier, nonce] = parsed as [string, string, string];
  return { state, codeVerifier, nonce };
}

/** Constant-time comparison for the per-transaction secrets. */
export function oauthSecretsMatch(
  received: string | undefined,
  expected: string | undefined,
): boolean {
  if (!received || !expected || received.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

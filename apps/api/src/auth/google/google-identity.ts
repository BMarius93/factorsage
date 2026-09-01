import type { OAuthErrorCode } from "@intrinsic/contracts";

/**
 * Identity boundary for Google sign-in.
 *
 * FactorSage only needs Google to assert who the user is, so the port exposes identity and
 * nothing else. Provider access and refresh tokens are deliberately never returned or persisted.
 *
 * Deterministic tests replace this port instead of calling Google.
 */
export type GoogleIdentity = {
  /** Google's stable subject identifier for the account. */
  readonly providerAccountId: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
};

/** What the authorization redirect must carry for this one sign-in attempt. */
export type GoogleAuthorizationRequest = {
  readonly state: string;
  /** PKCE S256 challenge. The verifier itself stays server-side until the token exchange. */
  readonly codeChallenge: string;
  readonly nonce: string;
};

export type GoogleCodeExchange = {
  readonly code: string;
  readonly codeVerifier: string;
  /** Must equal the `nonce` claim of the verified ID token. */
  readonly nonce: string;
};

export interface GoogleIdentityProvider {
  buildAuthorizationUrl(request: GoogleAuthorizationRequest): string;
  exchangeCode(exchange: GoogleCodeExchange): Promise<GoogleIdentity>;
}

export const GOOGLE_IDENTITY_PROVIDER = Symbol("GOOGLE_IDENTITY_PROVIDER");

/** A failure the browser is only ever told about through a stable redirect error code. */
export class GoogleAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GoogleAuthError";
  }
}

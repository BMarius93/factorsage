import type { GoogleOAuthConfig } from "@intrinsic/config";
import {
  CodeChallengeMethod,
  OAuth2Client,
  type TokenPayload,
} from "google-auth-library";
import {
  GoogleAuthError,
  type GoogleAuthorizationRequest,
  type GoogleCodeExchange,
  type GoogleIdentity,
  type GoogleIdentityProvider,
} from "./google-identity";
import { oauthSecretsMatch } from "./oauth-transaction";

/** Identity only: no Gmail, Drive, or profile-write scopes are ever requested. */
const SCOPES = ["openid", "email"];

/**
 * Real Google OpenID Connect provider using the authorization-code flow with PKCE.
 *
 * Identity claims are only ever taken from an ID token that `google-auth-library` has fully
 * validated: Google's signature against Google's published keys, `aud` equal to this deployment's
 * client ID, a valid Google `iss`, and an unexpired `exp`. A token is never decoded and trusted.
 */
export class GoogleOidcIdentityProvider implements GoogleIdentityProvider {
  private readonly client: OAuth2Client;

  constructor(
    private readonly config: GoogleOAuthConfig,
    client?: OAuth2Client,
  ) {
    this.client =
      client ??
      new OAuth2Client({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.callbackUrl,
      });
  }

  buildAuthorizationUrl(request: GoogleAuthorizationRequest): string {
    const url = new URL(
      this.client.generateAuthUrl({
        // Identity is established once per sign-in; there is no offline access to refresh.
        access_type: "online",
        scope: SCOPES,
        state: request.state,
        code_challenge_method: CodeChallengeMethod.S256,
        code_challenge: request.codeChallenge,
        prompt: "select_account",
        redirect_uri: this.config.callbackUrl,
      }),
    );

    // `generateAuthUrl` has no nonce option, but OIDC requires the nonce on the authorization
    // request for the ID token to echo it back.
    url.searchParams.set("nonce", request.nonce);
    return url.toString();
  }

  async exchangeCode(exchange: GoogleCodeExchange): Promise<GoogleIdentity> {
    let idToken: unknown;
    try {
      const { tokens } = await this.client.getToken({
        code: exchange.code,
        codeVerifier: exchange.codeVerifier,
        redirect_uri: this.config.callbackUrl,
      });
      idToken = tokens.id_token;
    } catch (cause) {
      // A token-endpoint failure body can echo the authorization code, so no provider detail is
      // carried into the error that gets logged.
      throw new GoogleAuthError(
        "oauth_provider",
        "Google authorization-code exchange failed",
        { cause },
      );
    }

    if (typeof idToken !== "string" || idToken.length === 0) {
      throw new GoogleAuthError(
        "oauth_provider",
        "Google token response did not contain an ID token",
      );
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.config.clientId,
      });
      payload = ticket.getPayload();
    } catch (cause) {
      throw new GoogleAuthError(
        "oauth_provider",
        "Google ID token failed verification",
        { cause },
      );
    }

    return identityFromVerifiedPayload(payload, exchange.nonce);
  }
}

/**
 * Reads identity from an already-verified ID token payload.
 *
 * Signature, audience, issuer, and expiry are the library's responsibility; the remaining checks
 * are ours: a usable subject and a nonce that belongs to this browser's sign-in transaction.
 */
export function identityFromVerifiedPayload(
  payload: TokenPayload | undefined,
  expectedNonce: string,
): GoogleIdentity {
  if (!payload) {
    throw new GoogleAuthError(
      "oauth_provider",
      "Google ID token carried no claims",
    );
  }

  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new GoogleAuthError(
      "oauth_provider",
      "Google ID token has no subject claim",
    );
  }

  // Blocks replaying an ID token minted for a different authorization request.
  if (!oauthSecretsMatch(payload.nonce, expectedNonce)) {
    throw new GoogleAuthError(
      "oauth_provider",
      "Google ID token nonce did not match the sign-in transaction",
    );
  }

  return {
    providerAccountId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: isAffirmative(payload.email_verified),
  };
}

/** Google emits `email_verified` as a boolean or as the string "true" depending on the endpoint. */
function isAffirmative(value: unknown): boolean {
  return value === true || value === "true";
}

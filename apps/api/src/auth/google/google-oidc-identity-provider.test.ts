import type { GoogleOAuthConfig } from "@intrinsic/config";
import type { OAuth2Client, TokenPayload } from "google-auth-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthError } from "./google-identity";
import {
  GoogleOidcIdentityProvider,
  identityFromVerifiedPayload,
} from "./google-oidc-identity-provider";
import { codeChallengeFor, createOAuthTransaction } from "./oauth-transaction";

const CONFIG: GoogleOAuthConfig = {
  clientId: "client-id.apps.googleusercontent.test",
  clientSecret: "client-secret-value",
  callbackUrl: "https://api.example.test/auth/google/callback",
};

/** Claims an attacker would love to have accepted from an unverified token. */
const FORGED_SUBJECT = "attacker-subject";
const FORGED_EMAIL = "victim@example.test";

type VerifyArgs = { idToken: string; audience?: string | string[] };
type GetTokenArgs = {
  code: string;
  codeVerifier?: string;
  redirect_uri?: string;
};

/**
 * Stands in for `OAuth2Client`.
 *
 * The library owns signature, audience, issuer, and expiry enforcement; what this suite proves is
 * that the provider always asks it to do that with the right arguments and never accepts an
 * identity when it refuses.
 */
function fakeClient(overrides: {
  getToken?: (args: GetTokenArgs) => Promise<{ tokens: { id_token?: unknown } }>;
  verifyIdToken?: (args: VerifyArgs) => Promise<{ getPayload: () => TokenPayload | undefined }>;
}) {
  const generateAuthUrl = vi.fn((options: Record<string, unknown>) => {
    const url = new URL("https://accounts.google.test/o/oauth2/v2/auth");
    for (const [key, value] of Object.entries(options)) {
      url.searchParams.set(
        key,
        Array.isArray(value) ? value.join(" ") : String(value),
      );
    }
    return url.toString();
  });

  const getToken = vi.fn(
    overrides.getToken ??
      (() => Promise.resolve({ tokens: { id_token: "header.payload.signature" } })),
  );

  const verifyIdToken = vi.fn(
    overrides.verifyIdToken ??
      (() =>
        Promise.resolve({
          getPayload: () => ({ sub: "google-subject" }) as TokenPayload,
        })),
  );

  const client = { generateAuthUrl, getToken, verifyIdToken };
  return {
    client: client as unknown as OAuth2Client,
    generateAuthUrl,
    getToken,
    verifyIdToken,
  };
}

function payload(claims: Partial<TokenPayload>): TokenPayload {
  return claims as TokenPayload;
}

describe("GoogleOidcIdentityProvider authorization request", () => {
  it("sends an S256 PKCE challenge, the state, and the nonce, and never the verifier", () => {
    const transaction = createOAuthTransaction();
    const { client } = fakeClient({});
    const provider = new GoogleOidcIdentityProvider(CONFIG, client);

    const url = new URL(
      provider.buildAuthorizationUrl({
        state: transaction.state,
        codeChallenge: codeChallengeFor(transaction.codeVerifier),
        nonce: transaction.nonce,
      }),
    );

    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      codeChallengeFor(transaction.codeVerifier),
    );
    expect(url.searchParams.get("state")).toBe(transaction.state);
    expect(url.searchParams.get("nonce")).toBe(transaction.nonce);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.callbackUrl);
    expect(url.searchParams.get("scope")).toBe("openid email");

    // The verifier is the PKCE secret; putting it in the redirect would defeat the whole point.
    expect(url.toString()).not.toContain(transaction.codeVerifier);
    expect(url.toString()).not.toContain(CONFIG.clientSecret);
  });

  it("never requests the plain challenge method", () => {
    const { client, generateAuthUrl } = fakeClient({});
    new GoogleOidcIdentityProvider(CONFIG, client).buildAuthorizationUrl({
      state: "state",
      codeChallenge: "challenge",
      nonce: "nonce",
    });

    expect(generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({ code_challenge_method: "S256" }),
    );
  });
});

describe("GoogleOidcIdentityProvider code exchange", () => {
  const NONCE = "transaction-nonce";
  const VERIFIER = "transaction-code-verifier";
  /** Distinctive so leak assertions cannot pass by accident. */
  const CODE = "4-0Ax-single-use-grant-value";

  function exchange(client: OAuth2Client) {
    return new GoogleOidcIdentityProvider(CONFIG, client).exchangeCode({
      code: CODE,
      codeVerifier: VERIFIER,
      nonce: NONCE,
    });
  }

  it("proves possession of the PKCE verifier during the token exchange", async () => {
    const { client, getToken } = fakeClient({
      verifyIdToken: () =>
        Promise.resolve({
          getPayload: () =>
            payload({ sub: "google-subject", nonce: NONCE, email_verified: true }),
        }),
    });

    await exchange(client);

    expect(getToken).toHaveBeenCalledWith({
      code: CODE,
      codeVerifier: VERIFIER,
      redirect_uri: CONFIG.callbackUrl,
    });
  });

  it("verifies the ID token against this deployment's client ID", async () => {
    const { client, verifyIdToken } = fakeClient({
      getToken: () => Promise.resolve({ tokens: { id_token: "signed.id.token" } }),
      verifyIdToken: () =>
        Promise.resolve({
          getPayload: () => payload({ sub: "google-subject", nonce: NONCE }),
        }),
    });

    await exchange(client);

    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: "signed.id.token",
      audience: CONFIG.clientId,
    });
  });

  // The library raises these; the provider must turn every one into a refusal rather than a
  // fallback that reads the claims anyway.
  it.each([
    ["signature", "Invalid token signature: header.payload.signature"],
    ["audience", `Wrong recipient, payload audience != requiredAudience`],
    ["issuer", "Invalid issuer, expected one of [accounts.google.com]"],
    ["expiry", "Token used too late, 1700000000 > 1699999999"],
  ])("refuses an identity when %s validation fails", async (_reason, message) => {
    const { client } = fakeClient({
      verifyIdToken: () => Promise.reject(new Error(message)),
    });

    const failure = (await exchange(client).catch(
      (error: unknown) => error,
    )) as GoogleAuthError;

    expect(failure).toBeInstanceOf(GoogleAuthError);
    expect(failure.code).toBe("oauth_provider");
    // One fixed message for every verification failure: the browser and the logs learn nothing
    // about which check failed or what the token claimed.
    expect(failure.message).toBe("Google ID token failed verification");
  });

  it("does not fall back to decoding an unverified token", async () => {
    const forged = `header.${Buffer.from(
      JSON.stringify({
        sub: FORGED_SUBJECT,
        email: FORGED_EMAIL,
        email_verified: true,
        nonce: NONCE,
      }),
    ).toString("base64url")}.signature`;

    const { client } = fakeClient({
      getToken: () => Promise.resolve({ tokens: { id_token: forged } }),
      verifyIdToken: () => Promise.reject(new Error("Invalid token signature")),
    });

    const failure = (await exchange(client).catch(
      (error: unknown) => error,
    )) as GoogleAuthError;

    // No identity is produced, and the claims the forged token asserted go nowhere.
    expect(failure).toBeInstanceOf(GoogleAuthError);
    expect(failure.message).toBe("Google ID token failed verification");
    expect(`${failure.message}${failure.stack ?? ""}`).not.toContain(
      FORGED_SUBJECT,
    );
    expect(`${failure.message}${failure.stack ?? ""}`).not.toContain(
      FORGED_EMAIL,
    );
  });

  it("refuses a token whose nonce does not belong to this sign-in transaction", async () => {
    const { client } = fakeClient({
      verifyIdToken: () =>
        Promise.resolve({
          getPayload: () =>
            payload({ sub: "google-subject", nonce: "a-different-nonce" }),
        }),
    });

    await expect(exchange(client)).rejects.toThrow(
      "nonce did not match the sign-in transaction",
    );
  });

  it("reports a failed token exchange without carrying provider detail", async () => {
    const { client } = fakeClient({
      getToken: () => Promise.reject(new Error("invalid_grant")),
    });

    const failure = (await exchange(client).catch(
      (error: unknown) => error,
    )) as GoogleAuthError;

    expect(failure).toBeInstanceOf(GoogleAuthError);
    // The token endpoint's failure body can echo the authorization code, so the error the API
    // logs and reports carries neither the code nor the client secret.
    expect(failure.message).toBe("Google authorization-code exchange failed");
    expect(failure.message).not.toContain(CODE);
    expect(failure.message).not.toContain(CONFIG.clientSecret);
    expect(failure.message).not.toContain(VERIFIER);
  });

  it("refuses a token response with no ID token", async () => {
    const { client } = fakeClient({
      getToken: () => Promise.resolve({ tokens: {} }),
    });

    await expect(exchange(client)).rejects.toThrow(
      "did not contain an ID token",
    );
  });
});

describe("identityFromVerifiedPayload", () => {
  const NONCE = "transaction-nonce";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the subject, email, and verification flag", () => {
    expect(
      identityFromVerifiedPayload(
        payload({
          sub: "123",
          email: "a@example.test",
          email_verified: true,
          nonce: NONCE,
        }),
        NONCE,
      ),
    ).toEqual({
      providerAccountId: "123",
      email: "a@example.test",
      emailVerified: true,
    });
  });

  it("accepts the string form of email_verified that Google also emits", () => {
    expect(
      identityFromVerifiedPayload(
        payload({
          sub: "123",
          email: "a@example.test",
          email_verified: "true" as unknown as boolean,
          nonce: NONCE,
        }),
        NONCE,
      ).emailVerified,
    ).toBe(true);
  });

  it("treats a missing or non-affirmative verification claim as unverified", () => {
    expect(
      identityFromVerifiedPayload(
        payload({ sub: "123", email: "a@example.test", nonce: NONCE }),
        NONCE,
      ).emailVerified,
    ).toBe(false);
    expect(
      identityFromVerifiedPayload(
        payload({
          sub: "123",
          email: "a@example.test",
          email_verified: "yes" as unknown as boolean,
          nonce: NONCE,
        }),
        NONCE,
      ).emailVerified,
    ).toBe(false);
  });

  it("rejects an empty payload, a missing subject, or a missing nonce", () => {
    expect(() => identityFromVerifiedPayload(undefined, NONCE)).toThrow(
      GoogleAuthError,
    );
    expect(() =>
      identityFromVerifiedPayload(payload({ email: "a@example.test", nonce: NONCE }), NONCE),
    ).toThrow("has no subject claim");
    expect(() => identityFromVerifiedPayload(payload({ sub: "123" }), NONCE)).toThrow(
      "nonce did not match",
    );
  });
});

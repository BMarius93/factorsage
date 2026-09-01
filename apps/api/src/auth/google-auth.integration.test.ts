import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { OAuthProvider } from "@intrinsic/database";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { AUTH_LOGGER } from "./auth.tokens";
import {
  GOOGLE_IDENTITY_PROVIDER,
  GoogleAuthError,
  type GoogleAuthorizationRequest,
  type GoogleCodeExchange,
  type GoogleIdentity,
  type GoogleIdentityProvider,
} from "./google/google-identity";
import {
  codeChallengeFor,
  decodeOAuthTransaction,
} from "./google/oauth-transaction";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

const WEB_BASE_URL = "http://web.example.test";
const TRANSACTION_COOKIE = "test_auth_oauth_tx";

/**
 * Replaces Google at the external boundary.
 *
 * Nothing in this suite performs a network call or drives Google's real consent screen; the
 * token/profile exchange is the only part of the flow that is faked.
 */
class FakeGoogleIdentityProvider implements GoogleIdentityProvider {
  identity: GoogleIdentity = {
    providerAccountId: "unset",
    email: null,
    emailVerified: false,
  };
  failWith: Error | null = null;
  lastRequest: GoogleAuthorizationRequest | null = null;
  lastExchange: GoogleCodeExchange | null = null;

  buildAuthorizationUrl(request: GoogleAuthorizationRequest): string {
    this.lastRequest = request;
    const url = new URL("https://accounts.google.test/authorize");
    url.searchParams.set("state", request.state);
    url.searchParams.set("code_challenge", request.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("nonce", request.nonce);
    return url.toString();
  }

  exchangeCode(exchange: GoogleCodeExchange): Promise<GoogleIdentity> {
    this.lastExchange = exchange;
    return this.failWith
      ? Promise.reject(this.failWith)
      : Promise.resolve(this.identity);
  }
}

/** Captures everything the auth component logs so secret-leak assertions are possible. */
function capturingLogger(): { logger: StructuredLogger; output: () => string } {
  const lines: string[] = [];
  const sink = { write: (chunk: string) => lines.push(chunk) };
  return {
    logger: createLogger({
      service: "api",
      level: "trace",
      base: { component: "auth" },
      stdout: sink,
      stderr: sink,
    }),
    output: () => lines.join(""),
  };
}

/**
 * `Set-Cookie` is an array at runtime but typed as a single header string, and a response may
 * legitimately carry none, one, or several cookies.
 */
function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers["set-cookie"];
  if (Array.isArray(raw)) {
    return raw as string[];
  }
  return typeof raw === "string" ? [raw] : [];
}

/** `Location` is typed as possibly absent; every redirect assertion needs a real string. */
function redirectLocation(response: {
  headers: Record<string, unknown>;
}): string {
  const location = response.headers.location;
  expect(typeof location).toBe("string");
  return location as string;
}

function cookieValue(
  response: { headers: Record<string, unknown> },
  name: string,
): string | undefined {
  const header = setCookies(response).find((value) =>
    value.startsWith(`${name}=`),
  );
  const raw = header?.split(";", 1)[0]?.slice(name.length + 1);
  return raw ? decodeURIComponent(raw) : undefined;
}

describe("Google authentication", () => {
  const suffix = randomUUID();
  const emails: string[] = [];

  function uniqueEmail(prefix: string): string {
    const email = `${prefix}-${suffix}-${emails.length}@example.test`;
    emails.push(email);
    return email;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  const provider = new FakeGoogleIdentityProvider();
  const logs = capturingLogger();

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";
    process.env.WEB_BASE_URL = WEB_BASE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GOOGLE_IDENTITY_PROVIDER)
      .useValue(provider)
      .overrideProvider(AUTH_LOGGER)
      .useValue(logs.logger)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
  });

  beforeEach(() => {
    provider.failWith = null;
    provider.lastRequest = null;
    provider.lastExchange = null;
  });

  afterAll(async () => {
    if (prisma && emails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
    }
    if (app) {
      await app.close();
    }
  });

  type StartedAuthorization = {
    readonly state: string;
    readonly transactionCookie: string;
  };

  /** Starts the flow the way a browser would: follow the redirect, keep the transaction cookie. */
  async function startAuthorization(): Promise<StartedAuthorization> {
    const response = await request(app.getHttpServer())
      .get("/auth/google")
      .expect(302);

    const transactionCookie = cookieValue(response, TRANSACTION_COOKIE);
    expect(transactionCookie).toBeTruthy();

    const state =
      new URL(redirectLocation(response)).searchParams.get("state") ?? "";
    expect(state).toBeTruthy();

    return { state, transactionCookie: transactionCookie ?? "" };
  }

  function callback(options: {
    code?: string;
    state?: string;
    transactionCookie?: string;
  }) {
    const query = new URLSearchParams();
    if (options.code !== undefined) {
      query.set("code", options.code);
    }
    if (options.state !== undefined) {
      query.set("state", options.state);
    }

    const call = request(app.getHttpServer()).get(
      `/auth/google/callback?${query.toString()}`,
    );
    return options.transactionCookie === undefined
      ? call
      : call.set(
          "Cookie",
          `${TRANSACTION_COOKIE}=${encodeURIComponent(options.transactionCookie)}`,
        );
  }

  /** Completes a started flow with the transaction the browser is holding. */
  function completeCallback(
    started: StartedAuthorization,
    code = "auth-code",
  ) {
    return callback({
      code,
      state: started.state,
      transactionCookie: started.transactionCookie,
    });
  }

  it("reports Google as an available provider when it is configured", async () => {
    const response = await request(app.getHttpServer())
      .get("/auth/providers")
      .expect(200);

    expect(response.body).toEqual({ google: true });
  });

  it("redirects to the provider with the transaction held in an HttpOnly cookie", async () => {
    const response = await request(app.getHttpServer())
      .get("/auth/google")
      .expect(302);

    const cookie = setCookies(response)[0] ?? "";
    expect(cookie).toContain(`${TRANSACTION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/auth");
    expect(response.headers.location).toContain("https://accounts.google.test/");
  });

  it("sends an S256 PKCE challenge in the redirect and keeps the verifier server-side", async () => {
    const response = await request(app.getHttpServer())
      .get("/auth/google")
      .expect(302);

    const redirect = new URL(redirectLocation(response));
    expect(redirect.searchParams.get("code_challenge_method")).toBe("S256");
    expect(redirect.searchParams.get("nonce")).toBeTruthy();

    const transaction = decodeOAuthTransaction(
      cookieValue(response, TRANSACTION_COOKIE),
    );
    expect(transaction).not.toBeNull();
    expect(redirect.searchParams.get("code_challenge")).toBe(
      codeChallengeFor(transaction?.codeVerifier ?? ""),
    );

    // Only the derived challenge travels through the browser's address bar.
    expect(response.headers.location).not.toContain(transaction?.codeVerifier);
  });

  it("binds the PKCE verifier and nonce across the round trip without exposing them", async () => {
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email: uniqueEmail("google-pkce"),
      emailVerified: true,
    };

    const started = await startAuthorization();
    const authorizationRequest = provider.lastRequest;
    const response = await completeCallback(started).expect(302);

    // The verifier used at the token exchange is the one the redirect's challenge was derived
    // from, and the nonce is the same across both halves of the flow.
    expect(provider.lastExchange?.codeVerifier).toBeTruthy();
    expect(
      codeChallengeFor(provider.lastExchange?.codeVerifier ?? ""),
    ).toBe(authorizationRequest?.codeChallenge);
    expect(provider.lastExchange?.nonce).toBe(authorizationRequest?.nonce);

    // The verifier never appears in anything the browser can read: not in the redirect the
    // browser followed, and not in any response body or header.
    const verifier = provider.lastExchange?.codeVerifier ?? "";
    expect(response.headers.location).not.toContain(verifier);
    expect(JSON.stringify(response.headers)).not.toContain(verifier);
  });

  it("clears the transaction cookie once the callback has run", async () => {
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email: uniqueEmail("google-cleared"),
      emailVerified: true,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    const cleared = setCookies(response).find((value) =>
      value.startsWith(`${TRANSACTION_COOKIE}=`),
    );
    expect(cleared).toBeDefined();
    expect(cleared).toContain(`${TRANSACTION_COOKIE}=;`);

    // With the cookie gone the browser cannot repeat the callback; single use of the
    // authorization code itself is enforced by the provider.
    const withoutTransaction = await callback({
      code: "auth-code",
      state: started.state,
    }).expect(302);
    expect(withoutTransaction.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=oauth_state`,
    );
  });

  it("creates a new verified user without a local password on first sign-in", async () => {
    const email = uniqueEmail("google-new");
    const providerAccountId = `google-${randomUUID()}`;
    provider.identity = { providerAccountId, email, emailVerified: true };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
    const authCookie = setCookies(response).find((value) =>
      value.startsWith("test_auth="),
    );
    expect(authCookie).toContain("HttpOnly");
    expect(provider.lastExchange?.code).toBe("auth-code");

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { oauthAccounts: true },
    });
    expect(user.passwordHash).toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.oauthAccounts).toHaveLength(1);
    expect(user.oauthAccounts[0]).toMatchObject({
      provider: OAuthProvider.GOOGLE,
      providerAccountId,
    });
  });

  it("issues the normal FactorSage session cookie that /auth/me accepts", async () => {
    const email = uniqueEmail("google-session");
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    const token = cookieValue(response, "test_auth");
    const me = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Cookie", `test_auth=${token}`)
      .expect(200);

    expect(me.body).toMatchObject({ email, role: "USER" });
    expect(Object.keys(me.body).sort()).toEqual(["email", "id", "role"]);
  });

  it("is idempotent for a repeat sign-in with the same Google identity", async () => {
    const email = uniqueEmail("google-repeat");
    const providerAccountId = `google-${randomUUID()}`;
    provider.identity = { providerAccountId, email, emailVerified: true };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const started = await startAuthorization();
      await completeCallback(started).expect(302);
    }

    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(
      await prisma.oAuthAccount.count({
        where: { provider: OAuthProvider.GOOGLE, providerAccountId },
      }),
    ).toBe(1);
  });

  it("links a Google identity to an existing account only when the provider verified the email", async () => {
    const email = uniqueEmail("google-link");
    const existing = await prisma.user.create({
      data: {
        email,
        passwordHash: "$argon2id$placeholder",
        emailVerifiedAt: new Date(),
      },
    });
    const providerAccountId = `google-${randomUUID()}`;
    provider.identity = { providerAccountId, email, emailVerified: true };

    const started = await startAuthorization();
    await completeCallback(started).expect(302);

    const linked = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
      include: { oauthAccounts: true },
    });
    expect(linked.oauthAccounts).toHaveLength(1);
    // Linking must not disturb the existing local credential.
    expect(linked.passwordHash).toBe("$argon2id$placeholder");
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("verifies a previously unverified local account when Google vouches for the address", async () => {
    const email = uniqueEmail("google-link-unverified");
    const existing = await prisma.user.create({
      data: {
        email,
        passwordHash: "$argon2id$placeholder",
        emailVerifiedAt: null,
        verificationTokens: {
          create: {
            tokenHash: `hash-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      },
    });
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
    };

    const started = await startAuthorization();
    await completeCallback(started).expect(302);

    const linked = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(linked.emailVerifiedAt).not.toBeNull();
    // The pending local verification link is meaningless now and is removed.
    expect(
      await prisma.emailVerificationToken.findUnique({
        where: { userId: existing.id },
      }),
    ).toBeNull();
  });

  it("refuses to link or create an account for an unverified provider email", async () => {
    const email = uniqueEmail("google-unverified");
    const existing = await prisma.user.create({
      data: {
        email,
        passwordHash: "$argon2id$placeholder",
        emailVerifiedAt: new Date(),
      },
    });
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: false,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=oauth_email_unverified`,
    );
    expect(setCookies(response).join(";")).not.toContain("test_auth=");
    expect(
      await prisma.oAuthAccount.count({ where: { userId: existing.id } }),
    ).toBe(0);
  });

  it("refuses an identity with no usable email address", async () => {
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email: null,
      emailVerified: true,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=oauth_email_unverified`,
    );
  });

  it("rejects a callback with missing, mismatched, or unaccompanied state", async () => {
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email: uniqueEmail("google-state"),
      emailVerified: true,
    };
    const started = await startAuthorization();
    const expectedLocation = `${WEB_BASE_URL}/login?error=oauth_state`;

    // No transaction cookie at all.
    const noCookie = await callback({ code: "c", state: started.state }).expect(
      302,
    );
    expect(noCookie.headers.location).toBe(expectedLocation);

    // Transaction present but the provider echoed a different state.
    const mismatch = await callback({
      code: "c",
      state: "forged-state-value",
      transactionCookie: started.transactionCookie,
    }).expect(302);
    expect(mismatch.headers.location).toBe(expectedLocation);

    // No state in the query.
    const missing = await callback({
      code: "c",
      transactionCookie: started.transactionCookie,
    }).expect(302);
    expect(missing.headers.location).toBe(expectedLocation);

    // A transaction cookie that is not a decodable transaction at all.
    const corrupt = await callback({
      code: "c",
      state: started.state,
      transactionCookie: "not-a-transaction",
    }).expect(302);
    expect(corrupt.headers.location).toBe(expectedLocation);

    // None of these may reach the provider or create a session.
    expect(provider.lastExchange).toBeNull();
    for (const response of [noCookie, mismatch, missing, corrupt]) {
      expect(setCookies(response).join(";")).not.toContain("test_auth=");
    }
  });

  it("reports a provider failure without leaking provider detail", async () => {
    provider.failWith = new GoogleAuthError(
      "oauth_provider",
      "Google token exchange failed with status 401",
    );

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=oauth_provider`,
    );
    expect(setCookies(response).join(";")).not.toContain("test_auth=");
  });

  it("treats an unexpected provider error as a generic provider failure", async () => {
    provider.failWith = new Error("socket hang up");

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=oauth_provider`,
    );
  });

  it("never writes a transaction secret or session token to the logs", async () => {
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email: uniqueEmail("google-logs"),
      emailVerified: true,
    };

    const started = await startAuthorization();
    const success = await completeCallback(started).expect(302);
    const transaction = decodeOAuthTransaction(started.transactionCookie);

    // Also exercise the failure paths, which are the ones that log an error object.
    provider.failWith = new Error("socket hang up");
    const failed = await startAuthorization();
    await completeCallback(failed).expect(302);
    await callback({ code: "leaked-code", state: "forged" }).expect(302);

    const output = logs.output();
    expect(output).toContain("auth.google.authorize.started");
    expect(output).toContain("auth.google.callback.failed");

    const secrets = [
      transaction?.state,
      transaction?.codeVerifier,
      transaction?.nonce,
      started.transactionCookie,
      cookieValue(success, "test_auth"),
      "auth-code",
      "leaked-code",
    ];

    for (const secret of secrets) {
      expect(typeof secret).toBe("string");
      expect(output).not.toContain(secret as string);
    }
  });

  it("rejects a callback without an authorization code", async () => {
    const started = await startAuthorization();
    const response = await callback({
      state: started.state,
      transactionCookie: started.transactionCookie,
    }).expect(302);

    expect(response.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=oauth_provider`,
    );
  });
});

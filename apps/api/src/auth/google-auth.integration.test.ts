import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { EMAIL_NOT_VERIFIED_CODE } from "@intrinsic/contracts";
import { OAuthProvider } from "@intrinsic/database";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { useIsolatedRateLimits, useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { EMAIL_SENDER } from "../email/email-sender";
import { InMemoryEmailSender } from "../email/in-memory-email-sender";
import { INVALID_CREDENTIALS_MESSAGE } from "./auth.service";
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
// Compiling `AppModule` installs the real rate limiter. Loopback makes every request in this
// file one caller, so its counters get their own namespace and a burst-sized allowance;
// enforcement itself stays on.
useIsolatedRateLimits();

const WEB_BASE_URL = "http://web.example.test";
const TRANSACTION_COOKIE = "test_auth_oauth_tx";

/** Google operates this mailbox, so a verified address in it is Google's to vouch for. */
const GOOGLE_MAILBOX_DOMAIN = "gmail.com";
/** A Workspace domain: authoritative only when the `hd` claim names it. */
const WORKSPACE_DOMAIN = "workspace.test";
/** Anybody's domain. Google may have verified delivery to it and still not speak for it. */
const EXTERNAL_DOMAIN = "example.test";

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
    hostedDomain: null,
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

  /**
   * A never-delivered address in one of three domains, because the domain is now part of the
   * linking rule: Google runs `gmail.com`, an organization can prove it owns `workspace.test`
   * through `hd`, and `example.test` is somebody else's domain entirely.
   */
  function uniqueEmail(prefix: string, domain = EXTERNAL_DOMAIN): string {
    const email = `${prefix}-${suffix}-${emails.length}@${domain}`;
    emails.push(email);
    return email;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  const provider = new FakeGoogleIdentityProvider();
  const logs = capturingLogger();
  // Registration and recovery run for real in the pre-account-takeover cases; their mail never
  // leaves this process.
  const sender = new InMemoryEmailSender();

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
      .overrideProvider(EMAIL_SENDER)
      .useValue(sender)
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

  afterEach(() => {
    sender.reset();
    vi.restoreAllMocks();
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
      hostedDomain: null,
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
      hostedDomain: null,
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
    provider.identity = {
      providerAccountId,
      email,
      emailVerified: true,
      hostedDomain: null,
    };

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
      hostedDomain: null,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    const token = cookieValue(response, "test_auth");
    const me = await request(app.getHttpServer())
      .get("/auth/me")
      .set("Cookie", `test_auth=${token}`)
      .expect(200);

    expect(me.body).toMatchObject({ email, role: "USER" });
    expect(Object.keys(me.body).sort()).toEqual(["email", "id", "plan", "role"]);
  });

  it("issues a token carrying the account's current session version, revocable like any other", async () => {
    const email = uniqueEmail("google-session-version");
    const providerAccountId = `google-${randomUUID()}`;
    provider.identity = {
      providerAccountId,
      email,
      emailVerified: true,
      hostedDomain: null,
    };
    const claimsOf = (token: string | undefined) =>
      JSON.parse(
        Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
    const me = (token: string | undefined) =>
      request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", `test_auth=${token}`);

    // First sign-in creates the account at version 0, and the claim says so explicitly.
    const created = cookieValue(
      await completeCallback(await startAuthorization()).expect(302),
      "test_auth",
    );
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(claimsOf(created)).toMatchObject({ sub: user.id, sv: 0 });

    // A repeat sign-in for an account that has moved on carries the version it is at now.
    await prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: 2 },
    });
    await me(created).expect(401);
    const current = cookieValue(
      await completeCallback(await startAuthorization()).expect(302),
      "test_auth",
    );
    expect(claimsOf(current)).toMatchObject({ sub: user.id, sv: 2 });
    await me(current).expect(200);

    // And "sign out everywhere" ends it like a password session.
    await request(app.getHttpServer())
      .post("/auth/logout-all")
      .set("Cookie", `test_auth=${current}`)
      .expect(204);
    await me(current).expect(401);
  });

  it("issues the linked account's current version when Google adopts an existing account", async () => {
    const email = uniqueEmail("google-link-version", GOOGLE_MAILBOX_DOMAIN);
    const existing = await prisma.user.create({
      data: { email, emailVerifiedAt: new Date(), sessionVersion: 4 },
    });
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
      hostedDomain: null,
    };

    const token = cookieValue(
      await completeCallback(await startAuthorization()).expect(302),
      "test_auth",
    );

    const payload = JSON.parse(
      Buffer.from(token?.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ sub: existing.id, sv: 4 });
  });

  it("is idempotent for a repeat sign-in with the same Google identity", async () => {
    const email = uniqueEmail("google-repeat");
    const providerAccountId = `google-${randomUUID()}`;
    provider.identity = {
      providerAccountId,
      email,
      emailVerified: true,
      hostedDomain: null,
    };

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

  it("links a Gmail identity to the existing account that already holds the address", async () => {
    const email = uniqueEmail("google-link", GOOGLE_MAILBOX_DOMAIN);
    const existing = await prisma.user.create({
      data: {
        email,
        passwordHash: "$argon2id$placeholder",
        emailVerifiedAt: new Date(),
      },
    });
    const providerAccountId = `google-${randomUUID()}`;
    provider.identity = {
      providerAccountId,
      email,
      emailVerified: true,
      hostedDomain: null,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
    const linked = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
      include: { oauthAccounts: true },
    });
    expect(linked.oauthAccounts).toHaveLength(1);
    // Linking must not disturb the existing local credential.
    expect(linked.passwordHash).toBe("$argon2id$placeholder");
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("links a Workspace identity whose hd claim names the address's own domain", async () => {
    const email = uniqueEmail("google-link-workspace", WORKSPACE_DOMAIN);
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
      emailVerified: true,
      hostedDomain: WORKSPACE_DOMAIN,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
    expect(
      await prisma.oAuthAccount.count({ where: { userId: existing.id } }),
    ).toBe(1);
  });

  it("refuses to link an existing account to a verified but non-authoritative email", async () => {
    const email = uniqueEmail("google-link-external", EXTERNAL_DOMAIN);
    const existing = await prisma.user.create({
      data: {
        email,
        passwordHash: "$argon2id$placeholder",
        emailVerifiedAt: new Date(),
      },
    });
    // Exactly the shape of a consumer Google account built around a third-party address:
    // verified at Google, and Google still does not run the domain.
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
      hostedDomain: null,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=oauth_link_not_allowed`,
    );
    expect(setCookies(response).join(";")).not.toContain("test_auth=");
    expect(
      await prisma.oAuthAccount.count({ where: { userId: existing.id } }),
    ).toBe(0);
    // The refusal must change nothing about the account it declined to adopt.
    const untouched = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(untouched.passwordHash).toBe("$argon2id$placeholder");
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("refuses to link when the hd claim does not match the address's domain", async () => {
    const email = uniqueEmail("google-link-hd-mismatch", EXTERNAL_DOMAIN);
    const existing = await prisma.user.create({
      data: {
        email,
        passwordHash: "$argon2id$placeholder",
        emailVerifiedAt: new Date(),
      },
    });
    // An organization that proved it owns `workspace.test` proved nothing about this address.
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
      hostedDomain: WORKSPACE_DOMAIN,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    expect(response.headers.location).toBe(
      `${WEB_BASE_URL}/login?error=oauth_link_not_allowed`,
    );
    expect(
      await prisma.oAuthAccount.count({ where: { userId: existing.id } }),
    ).toBe(0);
  });

  it("still creates a new account for a verified non-authoritative email nobody holds", async () => {
    const email = uniqueEmail("google-new-external", EXTERNAL_DOMAIN);
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: true,
      hostedDomain: null,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    // No account holds the address, so there is nothing to take over: the weaker bar is
    // deliberate, and is the difference between creating and adopting.
    expect(response.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
    const created = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(created.passwordHash).toBeNull();
    expect(created.emailVerifiedAt).not.toBeNull();
  });

  it("signs an already-linked identity in without re-asking whether its email is authoritative", async () => {
    const email = uniqueEmail("google-linked-external", EXTERNAL_DOMAIN);
    const providerAccountId = `google-${randomUUID()}`;
    const existing = await prisma.user.create({
      data: {
        email,
        emailVerifiedAt: new Date(),
        oauthAccounts: {
          create: { provider: OAuthProvider.GOOGLE, providerAccountId },
        },
      },
    });
    provider.identity = {
      providerAccountId,
      email,
      emailVerified: true,
      hostedDomain: null,
    };

    const started = await startAuthorization();
    const response = await completeCallback(started).expect(302);

    // The subject is the identity. Once it is linked, the email claim decides nothing.
    expect(response.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
    expect(
      await prisma.oAuthAccount.count({ where: { userId: existing.id } }),
    ).toBe(1);
  });

  it("verifies a previously unverified local account when Google vouches for the address", async () => {
    const email = uniqueEmail("google-link-unverified", GOOGLE_MAILBOX_DOMAIN);
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
      hostedDomain: null,
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
    const email = uniqueEmail("google-unverified", GOOGLE_MAILBOX_DOMAIN);
    const existing = await prisma.user.create({
      data: {
        email,
        passwordHash: "$argon2id$placeholder",
        emailVerifiedAt: new Date(),
      },
    });
    // Even a Gmail address Google itself operates is worthless while unverified.
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email,
      emailVerified: false,
      hostedDomain: null,
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

  it("lets exactly one of two concurrent first sign-ins create the account", async () => {
    const email = uniqueEmail("google-race", GOOGLE_MAILBOX_DOMAIN);
    const providerAccountId = `google-${randomUUID()}`;
    provider.identity = {
      providerAccountId,
      email,
      emailVerified: true,
      hostedDomain: null,
    };

    const first = await startAuthorization();
    const second = await startAuthorization();
    const responses = await Promise.all([
      completeCallback(first),
      completeCallback(second),
    ]);

    // The loser of the uniqueness race resolves again and finds the row the winner wrote, so
    // both browsers end up signed in to the one account PostgreSQL allowed to exist.
    for (const response of responses) {
      expect(response.status).toBe(302);
      expect(response.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
    }
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(
      await prisma.oAuthAccount.count({
        where: { provider: OAuthProvider.GOOGLE, providerAccountId },
      }),
    ).toBe(1);
  });

  it("refuses an identity with no usable email address", async () => {
    provider.identity = {
      providerAccountId: `google-${randomUUID()}`,
      email: null,
      emailVerified: true,
      hostedDomain: null,
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
      hostedDomain: null,
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
      hostedDomain: null,
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

  /**
   * AUTH-001: an attacker registers the victim's address with a password of their choosing and
   * never verifies it. When the real owner later signs in with Google, the account is adopted —
   * and nothing the attacker set may survive that adoption.
   */
  describe("adopting an account nobody has verified", () => {
    const attackerPassword = "Attacker-chosen-password-42";

    function register(email: string, password = attackerPassword) {
      return request(app.getHttpServer())
        .post("/auth/register")
        .send({ email, password });
    }

    function login(email: string, password = attackerPassword) {
      return request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password });
    }

    /** The real owner's "Continue with Google", start to finish. */
    async function signInWithGoogle(identity: GoogleIdentity) {
      provider.identity = identity;
      const started = await startAuthorization();
      return completeCallback(started).expect(302);
    }

    function googleIdentity(
      email: string,
      overrides: Partial<GoogleIdentity> = {},
    ): GoogleIdentity {
      return {
        providerAccountId: `google-${randomUUID()}`,
        email,
        emailVerified: true,
        hostedDomain: null,
        ...overrides,
      };
    }

    /** Reads the plaintext token back out of the link the mailbox owner would click. */
    function tokenFromLastEmail(
      path: "verify-email" | "reset-password",
    ): string {
      const match = new RegExp(`/${path}\\?token=([^\\s"<]+)`).exec(
        sender.lastMessage?.text ?? "",
      );
      expect(match?.[1]).toBeTruthy();
      return decodeURIComponent(match?.[1] ?? "");
    }

    async function identityState(userId: string) {
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        include: {
          oauthAccounts: true,
          verificationTokens: true,
          resetTokens: true,
        },
      });
      return {
        passwordHash: user.passwordHash,
        emailVerifiedAt: user.emailVerifiedAt,
        oauthAccounts: user.oauthAccounts.map((account) => ({
          provider: account.provider,
          providerAccountId: account.providerAccountId,
        })),
        verificationTokens: user.verificationTokens.length,
        passwordResetTokens: user.resetTokens.length,
      };
    }

    function expectNoSession(response: { headers: Record<string, unknown> }) {
      expect(setCookies(response).join(";")).not.toContain("test_auth=");
    }

    type TransactionCallback = (tx: unknown) => Promise<unknown>;

    /**
     * Runs the link's real database transaction but makes its verification update fail.
     *
     * Every statement before that one — clearing the password, dropping the reset token, creating
     * the Google link — still runs against PostgreSQL, so the test observes whether the
     * transaction actually rolls them back rather than leaving a half-adopted account.
     */
    function failVerificationInsideTheLink(): void {
      const runTransaction = prisma.$transaction.bind(prisma) as (
        callback: TransactionCallback,
      ) => Promise<unknown>;

      vi.spyOn(prisma, "$transaction").mockImplementation(((
        callback: TransactionCallback,
      ) =>
        runTransaction((tx) => {
          const real = tx as {
            user: { updateMany: (args: unknown) => Promise<unknown> };
            oAuthAccount: unknown;
            emailVerificationToken: unknown;
            passwordResetToken: unknown;
          };
          return callback({
            oAuthAccount: real.oAuthAccount,
            emailVerificationToken: real.emailVerificationToken,
            passwordResetToken: real.passwordResetToken,
            user: {
              updateMany: (args: unknown) => real.user.updateMany(args),
              update: () => Promise.reject(new Error("write failed")),
            },
          });
        })) as never);
    }

    it("removes the attacker's password when the real owner links Google", async () => {
      const email = uniqueEmail("takeover", GOOGLE_MAILBOX_DOMAIN);

      // 1. The attacker registers the victim's Gmail address and never verifies it.
      await register(email).expect(201);
      const registered = await prisma.user.findUniqueOrThrow({
        where: { email },
      });
      expect(registered.passwordHash).not.toBeNull();
      expect(registered.emailVerifiedAt).toBeNull();

      // The pre-condition: the password is correct but unusable, and it never yields a session,
      // so the attacker holds nothing a later link would need to revoke.
      const beforeLink = await login(email).expect(403);
      expect(beforeLink.body.code).toBe(EMAIL_NOT_VERIFIED_CODE);
      expectNoSession(beforeLink);

      // 2. The owner uses "Continue with Google".
      const identity = googleIdentity(email);
      const linked = await signInWithGoogle(identity);
      expect(linked.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);

      // 3. The attacker's password no longer opens anything, and fails exactly like an unknown
      // account does.
      const afterLink = await login(email).expect(401);
      expect(afterLink.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
      expectNoSession(afterLink);
      const unknown = await login(
        uniqueEmail("takeover-unknown", GOOGLE_MAILBOX_DOMAIN),
      ).expect(401);
      expect(afterLink.body).toEqual(unknown.body);

      // The row was adopted, not duplicated, and is now a verified Google-only account.
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      const state = await identityState(registered.id);
      expect(state.passwordHash).toBeNull();
      expect(state.emailVerifiedAt).not.toBeNull();
      expect(state.oauthAccounts).toEqual([
        {
          provider: OAuthProvider.GOOGLE,
          providerAccountId: identity.providerAccountId,
        },
      ]);
      expect(state.verificationTokens).toBe(0);
      expect(state.passwordResetTokens).toBe(0);

      // The owner's Google session is for that same account, and Google keeps working.
      const me = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", `test_auth=${cookieValue(linked, "test_auth")}`)
        .expect(200);
      expect(me.body).toMatchObject({ id: registered.id, email });

      const again = await signInWithGoogle(identity);
      expect(again.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
      expect(cookieValue(again, "test_auth")).toBeTruthy();
      expect(
        await prisma.oAuthAccount.count({ where: { userId: registered.id } }),
      ).toBe(1);
    });

    it("also drops a password-reset link that was outstanding on the unverified account", async () => {
      const email = uniqueEmail("takeover-reset", GOOGLE_MAILBOX_DOMAIN);
      await register(email).expect(201);
      await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email })
        .expect(202);
      const resetToken = tokenFromLastEmail("reset-password");
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect((await identityState(id)).passwordResetTokens).toBe(1);

      await signInWithGoogle(googleIdentity(email));

      const state = await identityState(id);
      expect(state.passwordHash).toBeNull();
      expect(state.passwordResetTokens).toBe(0);
      // The link that was mailed before the adoption no longer installs a password.
      await request(app.getHttpServer())
        .post("/auth/reset-password")
        .send({ token: resetToken, password: "Someone-else-entirely-42" })
        .expect(401);
      expect((await identityState(id)).passwordHash).toBeNull();
    });

    it("applies the same rule when a matching Workspace hd claim authorizes the link", async () => {
      const email = uniqueEmail("takeover-workspace", WORKSPACE_DOMAIN);
      await register(email).expect(201);
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });

      const linked = await signInWithGoogle(
        googleIdentity(email, { hostedDomain: WORKSPACE_DOMAIN }),
      );

      expect(linked.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
      const state = await identityState(id);
      expect(state.passwordHash).toBeNull();
      expect(state.emailVerifiedAt).not.toBeNull();
      expect(state.oauthAccounts).toHaveLength(1);
      await login(email).expect(401);
    });

    it("matches the registered address case-insensitively and still clears the password", async () => {
      const email = uniqueEmail("takeover-case", GOOGLE_MAILBOX_DOMAIN);
      // The attacker types the address in a different case than Google reports it.
      await register(email.toUpperCase()).expect(201);
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });

      await signInWithGoogle(googleIdentity(email));

      expect(await prisma.user.count({ where: { email } })).toBe(1);
      const state = await identityState(id);
      expect(state.passwordHash).toBeNull();
      expect(state.oauthAccounts).toHaveLength(1);
      await login(email.toUpperCase()).expect(401);
    });

    it("keeps the password of an account its owner verified before Google linked it", async () => {
      const email = uniqueEmail("verified-first", GOOGLE_MAILBOX_DOMAIN);
      await register(email, "Owner-chosen-password-42").expect(201);

      // The verification is redeemed first, so the password is proven to be the mailbox owner's
      // by the time the link happens — the ordering the link decides inside its own transaction.
      await request(app.getHttpServer())
        .post("/auth/verify-email")
        .send({ token: tokenFromLastEmail("verify-email") })
        .expect(200);
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
      const before = await identityState(id);

      await signInWithGoogle(googleIdentity(email));

      const state = await identityState(id);
      expect(state.passwordHash).toBe(before.passwordHash);
      expect(state.oauthAccounts).toHaveLength(1);
      await login(email, "Owner-chosen-password-42").expect(200);
    });

    it("leaves an unverified account untouched when the link is refused", async () => {
      const email = uniqueEmail("takeover-external", EXTERNAL_DOMAIN);
      await register(email).expect(201);
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
      const before = await identityState(id);

      const refused = await signInWithGoogle(googleIdentity(email));

      expect(refused.headers.location).toBe(
        `${WEB_BASE_URL}/login?error=oauth_link_not_allowed`,
      );
      expectNoSession(refused);
      expect(await identityState(id)).toEqual(before);
    });

    it("signs a subject already linked elsewhere into its own account and leaves the address holder alone", async () => {
      // The provider identity already belongs to another FactorSage user; the email claim names
      // an unverified account someone else registered. The subject decides, and nothing is
      // linked, verified or cleared on the account behind the address.
      const providerAccountId = `google-${randomUUID()}`;
      const owner = await prisma.user.create({
        data: {
          email: uniqueEmail("subject-owner", GOOGLE_MAILBOX_DOMAIN),
          emailVerifiedAt: new Date(),
          oauthAccounts: {
            create: { provider: OAuthProvider.GOOGLE, providerAccountId },
          },
        },
      });
      const email = uniqueEmail(
        "takeover-other-subject",
        GOOGLE_MAILBOX_DOMAIN,
      );
      await register(email).expect(201);
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
      const before = await identityState(id);

      const response = await signInWithGoogle(
        googleIdentity(email, { providerAccountId }),
      );

      expect(response.headers.location).toBe(`${WEB_BASE_URL}/dashboard`);
      const me = await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", `test_auth=${cookieValue(response, "test_auth")}`)
        .expect(200);
      expect(me.body.id).toBe(owner.id);
      expect(await identityState(id)).toEqual(before);
    });

    it("rolls the whole adoption back when any part of it fails", async () => {
      const email = uniqueEmail("takeover-atomic", GOOGLE_MAILBOX_DOMAIN);
      await register(email).expect(201);
      await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email })
        .expect(202);
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
      const before = await identityState(id);
      expect(before.passwordHash).not.toBeNull();
      expect(before.verificationTokens).toBe(1);
      expect(before.passwordResetTokens).toBe(1);

      failVerificationInsideTheLink();
      const identity = googleIdentity(email);
      const failed = await signInWithGoogle(identity);

      expect(failed.headers.location).toBe(
        `${WEB_BASE_URL}/login?error=oauth_provider`,
      );
      expectNoSession(failed);
      // Not half-adopted: no link, still unverified, and the credential and both tokens exactly
      // as they were.
      expect(await identityState(id)).toEqual(before);

      // Once the failure is gone the same sign-in adopts the account completely.
      vi.restoreAllMocks();
      await signInWithGoogle(identity);
      const adopted = await identityState(id);
      expect(adopted.passwordHash).toBeNull();
      expect(adopted.emailVerifiedAt).not.toBeNull();
      expect(adopted.oauthAccounts).toHaveLength(1);
      expect(adopted.verificationTokens).toBe(0);
      expect(adopted.passwordResetTokens).toBe(0);
    });
  });
});

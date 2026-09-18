import { randomUUID } from "node:crypto";
import { getApiConfig, getAuthConfig, loadRootEnv } from "@intrinsic/config";
import { RATE_LIMIT_HEADERS } from "@intrinsic/contracts";
import { UserRole } from "@intrinsic/database";
import { useIsolatedRateLimits, useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { INVALID_CREDENTIALS_MESSAGE } from "./auth.service";
import { PasswordService } from "./password.service";
import { seedInitialAdmin } from "./seed-admin";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();
// Compiling `AppModule` installs the real rate limiter. Loopback makes every request in this
// file one caller, so its counters get their own namespace and a burst-sized allowance;
// enforcement itself stays on.
useIsolatedRateLimits();

describe("authentication and role authorization", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const adminEmail = `admin-${suffix}@example.test`;
  const userEmail = `user-${suffix}@example.test`;
  const externalOnlyEmail = `external-${suffix}@example.test`;
  const unverifiedEmail = `unverified-${suffix}@example.test`;
  const seedEmail = `seed-${suffix}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let passwords: PasswordService;
  let jwt: JwtService;
  let passwordHash: string;
  /** Accounts created by individual session tests, removed with the fixed ones. */
  const sessionEmails: string[] = [];

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    const apiConfig = getApiConfig();
    app.enableCors({ origin: apiConfig.corsOrigins, credentials: true });
    await app.init();

    prisma = moduleRef.get(PrismaService);
    passwords = moduleRef.get(PasswordService);
    // The same signer the API uses, so a hand-made token differs from a real one only in its claims.
    jwt = moduleRef.get(JwtService, { strict: false });
    passwordHash = await passwords.hash(password);

    const emailVerifiedAt = new Date();
    await prisma.user.createMany({
      data: [
        { email: adminEmail, passwordHash, emailVerifiedAt, role: UserRole.ADMIN },
        { email: userEmail, passwordHash, emailVerifiedAt, role: UserRole.USER },
        // Google-only identity: verified address, no local password.
        {
          email: externalOnlyEmail,
          passwordHash: null,
          emailVerifiedAt,
          role: UserRole.USER,
        },
        // Registered but never confirmed the address.
        {
          email: unverifiedEmail,
          passwordHash,
          emailVerifiedAt: null,
          role: UserRole.USER,
        },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: {
          email: {
            in: [
              adminEmail,
              userEmail,
              externalOnlyEmail,
              unverifiedEmail,
              seedEmail,
              ...sessionEmails,
            ],
          },
        },
      });
    }
    if (app) {
      await app.close();
    }
  });

  it("uses secure cookies in production and non-secure cookies outside production", () => {
    const common = {
      AUTH_JWT_SECRET: "test-only-jwt-secret-that-is-at-least-32-characters",
    };

    expect(
      getAuthConfig({
        ...common,
        NODE_ENV: "production",
        WEB_BASE_URL: "https://app.example.test",
      }).cookieSecure,
    ).toBe(true);
    expect(
      getAuthConfig({ ...common, NODE_ENV: "development" }).cookieSecure,
    ).toBe(false);
  });

  it("rejects wildcard credentialed CORS and normalizes configured origins", () => {
    expect(() => getApiConfig({ CORS_ORIGINS: "*" })).toThrow(
      "CORS_ORIGINS cannot contain '*'",
    );
    expect(
      getApiConfig({
        CORS_ORIGINS: "http://localhost:3000/,https://app.example.test",
      }).corsOrigins,
    ).toEqual(["http://localhost:3000", "https://app.example.test"]);
  });

  it("allows the configured browser origin with credentials", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ email: adminEmail, password })
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("logs in an ADMIN with normalized credentials and returns only safe fields", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: `  ${adminEmail.toUpperCase()}  `, password })
      .expect(200);

    expect(response.body).toMatchObject({ email: adminEmail, role: "ADMIN" });
    expect(Object.keys(response.body).sort()).toEqual(["email", "id", "plan", "role"]);
    expect(response.headers["set-cookie"]?.[0]).toContain("test_auth=");
    expect(response.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]?.[0]).not.toContain("Secure");
  });

  it("logs in a USER with valid credentials", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: userEmail, password })
      .expect(200);

    expect(response.body).toMatchObject({ email: userEmail, role: "USER" });
  });

  it("uses equivalent generic failures for wrong and unknown credentials", async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: userEmail, password: "wrong" })
      .expect(401);
    const unknownEmail = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: `unknown-${suffix}@example.test`, password })
      .expect(401);

    expect(wrongPassword.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(unknownEmail.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it("does not allow password login for a user without a password hash", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: externalOnlyEmail, password })
      .expect(401);

    expect(response.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  it("refuses an unverified account with the generic failure even for its stored password (AUTH-003)", async () => {
    // The row carries a password hash, as a registration from before AUTH-003 left it. Nobody
    // proved that password belongs to the mailbox owner, so knowing it is not a credential, and
    // answering differently from an unknown address would reveal that a pending account exists.
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: unverifiedEmail, password })
      .expect(401);
    const unknown = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: `unknown-pending-${suffix}@example.test`, password })
      .expect(401);

    expect(response.body).toEqual(unknown.body);
    expect(response.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(response.body.code).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("still reports a generic failure for a wrong password on an unverified account", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: unverifiedEmail, password: "wrong" })
      .expect(401);

    expect(response.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  it("requires authentication for /auth/me", async () => {
    await request(app.getHttpServer()).get("/auth/me").expect(401);
  });

  it("returns the current safe user for a valid auth cookie", async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post("/auth/login")
      .send({ email: userEmail, password })
      .expect(200);

    const response = await agent.get("/auth/me").expect(200);
    expect(response.body).toMatchObject({ email: userEmail, role: "USER" });
    expect(Object.keys(response.body).sort()).toEqual(["email", "id", "plan", "role"]);
  });

  it("clears the cookie and leaves the browser session unauthenticated on logout", async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post("/auth/login")
      .send({ email: adminEmail, password })
      .expect(200);
    await agent.get("/auth/me").expect(200);

    const logout = await agent.post("/auth/logout").expect(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("test_auth=;");
    await agent.get("/auth/me").expect(401);
  });

  it("enforces anonymous, USER, and ADMIN access for /admin/health", async () => {
    await request(app.getHttpServer()).get("/admin/health").expect(401);

    const userAgent = request.agent(app.getHttpServer());
    await userAgent
      .post("/auth/login")
      .send({ email: userEmail, password })
      .expect(200);
    await userAgent.get("/admin/health").expect(403);

    const adminAgent = request.agent(app.getHttpServer());
    await adminAgent
      .post("/auth/login")
      .send({ email: adminEmail, password })
      .expect(200);
    const response = await adminAgent.get("/admin/health").expect(200);
    expect(response.body).toEqual({ status: "ok", role: "ADMIN" });
  });

  it("creates the bootstrap admin idempotently", async () => {
    const first = await seedInitialAdmin(prisma, passwords, {
      email: seedEmail.toUpperCase(),
      password,
    });
    const second = await seedInitialAdmin(prisma, passwords, {
      email: seedEmail,
      password,
    });
    const count = await prisma.user.count({ where: { email: seedEmail } });

    expect(second.id).toBe(first.id);
    expect(second.role).toBe("ADMIN");
    expect(count).toBe(1);
  });
  describe("revocable sessions", () => {
    const COOKIE = "test_auth";

    /** A verified local account of its own, so no test's revocation touches another's sessions. */
    async function sessionAccount(
      prefix: string,
      role: UserRole = UserRole.USER,
    ): Promise<{ id: string; email: string }> {
      const email = `${prefix}-${suffix}-${sessionEmails.length}@example.test`;
      sessionEmails.push(email);
      return prisma.user.create({
        data: { email, passwordHash, emailVerifiedAt: new Date(), role },
        select: { id: true, email: true },
      });
    }

    /** One browser: password sign-in, returning the raw token its cookie holds. */
    async function signIn(email: string): Promise<string> {
      const response = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password })
        .expect(200);
      const header = (response.headers["set-cookie"] as unknown as string[])
        .find((value) => value.startsWith(`${COOKIE}=`));
      const token = decodeURIComponent(
        header?.split(";", 1)[0]?.slice(COOKIE.length + 1) ?? "",
      );
      expect(token).toBeTruthy();
      return token;
    }

    /** The token's payload as issued, read without verifying — the tests only inspect claims. */
    function claimsOf(token: string): Record<string, unknown> {
      return JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
      ) as Record<string, unknown>;
    }

    function me(token: string) {
      return request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", `${COOKIE}=${token}`);
    }

    function logoutAll(token?: string) {
      const call = request(app.getHttpServer()).post("/auth/logout-all");
      return token === undefined ? call : call.set("Cookie", `${COOKIE}=${token}`);
    }

    async function storedVersion(userId: string): Promise<number> {
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { sessionVersion: true },
      });
      return row.sessionVersion;
    }

    function setVersion(userId: string, sessionVersion: number) {
      return prisma.user.update({
        where: { id: userId },
        data: { sessionVersion },
      });
    }

    /** A correctly signed token with exactly these claims — the API's own key, any payload. */
    function signed(payload: Record<string, unknown>): Promise<string> {
      return jwt.signAsync(payload);
    }

    describe("issuing and validating", () => {
      it("puts the account's current version into every password-login token, including 0", async () => {
        const account = await sessionAccount("sv-issue");

        const first = await signIn(account.email);
        expect(claimsOf(first)).toMatchObject({ sub: account.id, sv: 0 });

        await setVersion(account.id, 3);
        const later = await signIn(account.email);
        expect(claimsOf(later)).toMatchObject({ sub: account.id, sv: 3 });
        await me(later).expect(200);
      });

      it("accepts only a version equal to the stored one", async () => {
        const account = await sessionAccount("sv-equal");
        await setVersion(account.id, 3);

        await me(await signed({ sub: account.id, sv: 3 })).expect(200);
        // Lower: revoked. Higher: never issued by this server for this account. Both refused.
        await me(await signed({ sub: account.id, sv: 2 })).expect(401);
        await me(await signed({ sub: account.id, sv: 4 })).expect(401);
      });

      it("refuses a malformed, negative or non-integer version even at version 0", async () => {
        const account = await sessionAccount("sv-malformed");

        // Account at 0, so none of these can pass as the legacy claimless form either.
        for (const sv of ["0", 0.5, -1, null, true, [0], { v: 0 }, 2 ** 53]) {
          await me(await signed({ sub: account.id, sv })).expect(401);
        }
      });

      it("answers a revoked, expired, forged, malformed or orphaned token with one generic 401", async () => {
        const account = await sessionAccount("sv-generic");
        await setVersion(account.id, 1);

        const unauthenticated = await request(app.getHttpServer())
          .get("/auth/me")
          .expect(401);
        const rejected = [
          await me(await signed({ sub: account.id, sv: 0 })), // revoked
          await me(await signed({ sub: account.id })), // legacy, account past 0
          await me(await signed({ sub: account.id, sv: "1" })), // malformed
          await me(await signed({ sub: randomUUID(), sv: 0 })), // no such account
          await me(
            await jwt.signAsync({ sub: account.id, sv: 1 }, { expiresIn: -10 }),
          ), // expired
          await me(`${await signed({ sub: account.id, sv: 1 })}x`), // forged signature
        ];

        for (const response of rejected) {
          expect(response.status).toBe(401);
          expect(response.body).toEqual(unauthenticated.body);
        }
      });

      it("never exposes the session version in /auth/me", async () => {
        const account = await sessionAccount("sv-me-shape");
        const response = await me(await signIn(account.email)).expect(200);

        expect(Object.keys(response.body).sort()).toEqual([
          "email",
          "id",
          "plan",
          "role",
        ]);
      });
    });

    describe("tokens issued before the claim existed", () => {
      it("keeps a claimless token working while the account is at version 0", async () => {
        const account = await sessionAccount("sv-legacy");
        // Exactly what `issueToken` signed before SESSION-002: `{ sub }` and nothing else.
        const legacy = await signed({ sub: account.id });

        await me(legacy).expect(200);
      });

      it("revokes that claimless token with the account's first increment", async () => {
        const account = await sessionAccount("sv-legacy-revoked");
        const legacy = await signed({ sub: account.id });
        const current = await signIn(account.email);
        await me(legacy).expect(200);

        await logoutAll(current).expect(204);

        await me(legacy).expect(401);
      });

      it("never treats a missing claim as current once the account has moved past 0", async () => {
        const account = await sessionAccount("sv-legacy-past-zero");
        await setVersion(account.id, 5);

        await me(await signed({ sub: account.id })).expect(401);
      });
    });

    describe("sign out everywhere", () => {
      it("revokes every session of the account and clears the caller's cookie", async () => {
        const account = await sessionAccount("sv-logout-all");
        const browserA = await signIn(account.email);
        const browserB = await signIn(account.email);
        await me(browserA).expect(200);
        await me(browserB).expect(200);

        const response = await logoutAll(browserA).expect(204);

        expect(response.headers["set-cookie"]?.[0]).toContain(`${COOKIE}=;`);
        expect(response.headers[RATE_LIMIT_HEADERS.policy.toLowerCase()]).toBe(
          "mutation",
        );
        expect(await storedVersion(account.id)).toBe(1);
        // A copy of A's cookie kept past the clear, and the other browser, are both dead.
        await me(browserA).expect(401);
        await me(browserB).expect(401);

        const again = await signIn(account.email);
        expect(claimsOf(again)).toMatchObject({ sub: account.id, sv: 1 });
        await me(again).expect(200);
      });

      it("leaves another account's sessions alone", async () => {
        const caller = await sessionAccount("sv-logout-all-caller");
        const bystander = await sessionAccount("sv-logout-all-bystander");
        const callerToken = await signIn(caller.email);
        const bystanderToken = await signIn(bystander.email);

        await logoutAll(callerToken).expect(204);

        await me(bystanderToken).expect(200);
        expect(await storedVersion(bystander.id)).toBe(0);
      });

      it("requires a live session", async () => {
        const account = await sessionAccount("sv-logout-all-anonymous");
        const token = await signIn(account.email);
        await logoutAll(token).expect(204);

        await logoutAll().expect(401);
        // A revoked session cannot revoke again: the guard refuses it before anything is written.
        await logoutAll(token).expect(401);
        expect(await storedVersion(account.id)).toBe(1);
      });

      it("never revives an older session under concurrent calls", async () => {
        const account = await sessionAccount("sv-logout-all-concurrent");
        const tokens = [
          await signIn(account.email),
          await signIn(account.email),
          await signIn(account.email),
        ];

        const outcomes = await Promise.all(tokens.map((token) => logoutAll(token)));

        // Each call either passed the guard and incremented, or found its session already revoked.
        const succeeded = outcomes.filter((response) => response.status === 204);
        expect(succeeded.length).toBeGreaterThanOrEqual(1);
        for (const response of outcomes) {
          expect([204, 401]).toContain(response.status);
        }
        expect(await storedVersion(account.id)).toBe(succeeded.length);
        for (const token of tokens) {
          await me(token).expect(401);
        }
      });
    });

    describe("ordinary logout", () => {
      it("signs out only the calling browser and does not revoke", async () => {
        const account = await sessionAccount("sv-logout");
        const browserA = await signIn(account.email);
        const browserB = await signIn(account.email);

        const response = await request(app.getHttpServer())
          .post("/auth/logout")
          .set("Cookie", `${COOKIE}=${browserA}`)
          .expect(204);

        expect(response.headers["set-cookie"]?.[0]).toContain(`${COOKIE}=;`);
        await me(browserB).expect(200);
        // By design (R1): the token itself is not revoked, only this browser's copy is cleared.
        await me(browserA).expect(200);
        expect(await storedVersion(account.id)).toBe(0);
      });
    });

    describe("every guard enforces revocation", () => {
      it("refuses a revoked session on routes behind CookieAuthGuard", async () => {
        const admin = await sessionAccount("sv-guard-admin", UserRole.ADMIN);
        const revoked = await signIn(admin.email);
        const survivor = await signIn(admin.email);
        await request(app.getHttpServer())
          .get("/admin/health")
          .set("Cookie", `${COOKIE}=${revoked}`)
          .expect(200);

        await logoutAll(survivor).expect(204);

        // 401 rather than 403: the revoked token no longer identifies anyone, so no role applies.
        for (const path of ["/auth/me", "/admin/health", "/billing/status"]) {
          await request(app.getHttpServer())
            .get(path)
            .set("Cookie", `${COOKIE}=${revoked}`)
            .expect(401);
        }
        await request(app.getHttpServer())
          .post("/lists")
          .set("Cookie", `${COOKIE}=${revoked}`)
          .send({ name: "Never created" })
          .expect(401);
        expect(
          await prisma.stockList.count({ where: { userId: admin.id } }),
        ).toBe(0);
      });

      it("resolves a revoked session to Guest on routes behind OptionalCookieAuthGuard", async () => {
        const account = await sessionAccount("sv-guard-optional");
        const revoked = await signIn(account.email);

        const before = await request(app.getHttpServer())
          .get("/entitlements")
          .set("Cookie", `${COOKIE}=${revoked}`)
          .expect(200);
        expect(before.body.principal).toBe("AUTHENTICATED");

        await logoutAll(await signIn(account.email)).expect(204);

        const after = await request(app.getHttpServer())
          .get("/entitlements")
          .set("Cookie", `${COOKIE}=${revoked}`)
          .expect(200);
        expect(after.body.principal).toBe("GUEST");

        const current = await signIn(account.email);
        const signedIn = await request(app.getHttpServer())
          .get("/entitlements")
          .set("Cookie", `${COOKIE}=${current}`)
          .expect(200);
        expect(signedIn.body.principal).toBe("AUTHENTICATED");
      });
    });
  });
});

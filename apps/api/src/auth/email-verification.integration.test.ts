import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { useIsolatedRateLimits, useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { EMAIL_SENDER } from "../email/email-sender";
import { InMemoryEmailSender } from "../email/in-memory-email-sender";
import { AUTH_LOGGER } from "./auth.tokens";
import { BackgroundEmailDispatcher } from "./background-email-dispatcher";
import { INVALID_CREDENTIALS_MESSAGE } from "./auth.service";
import {
  EmailVerificationService,
  hashVerificationToken,
} from "./email-verification.service";
import { PasswordService } from "./password.service";
import { INVALID_VERIFICATION_TOKEN_MESSAGE } from "./registration.service";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();
// Compiling `AppModule` installs the real rate limiter. Loopback makes every request in this
// file one caller, so its counters get their own namespace and a burst-sized allowance;
// enforcement itself stays on.
useIsolatedRateLimits();

const WEB_BASE_URL = "http://web.example.test";

/** Reads the plaintext token back out of the link in the most recent email of that kind. */
function tokenFromLastEmail(
  sender: InMemoryEmailSender,
  path: "verify-email" | "reset-password" = "verify-email",
): string {
  const match = new RegExp(`/${path}\\?token=([^\\s"<]+)`).exec(
    sender.lastMessage?.text ?? "",
  );
  expect(match?.[1]).toBeTruthy();
  return decodeURIComponent(match?.[1] ?? "");
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

function sessionCookie(response: {
  headers: Record<string, unknown>;
}): string | undefined {
  const raw = response.headers["set-cookie"];
  const headers = Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === "string"
      ? [raw]
      : [];
  const header = headers.find((value) => value.startsWith("test_auth="));
  const value = header?.split(";", 1)[0]?.slice("test_auth=".length);
  return value ? decodeURIComponent(value) : undefined;
}

function sessionVersionClaim(sessionToken: string): unknown {
  const payload = JSON.parse(
    Buffer.from(sessionToken.split(".")[1] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  return payload.sv;
}

/**
 * AUTH-002: redeeming an email-verification link must never activate a password that was chosen
 * before anybody proved control of the mailbox.
 *
 * The attack: somebody registers the victim's address with a password of their own, the victim
 * receives an unsolicited verification email and clicks it, and — before this fix — the account
 * became verified while keeping the stranger's password. Verification now installs the password
 * the person redeeming the link chooses, in the same transaction that consumes the token.
 */
describe("email verification sets the mailbox owner's password (AUTH-002)", () => {
  const suffix = randomUUID();
  const attackerPassword = "Attacker-chosen-password-42";
  const ownerPassword = "Mailbox-owner-password-42";
  const emails: string[] = [];

  function uniqueEmail(prefix: string): string {
    const email = `${prefix}-${suffix}-${emails.length}@example.test`;
    emails.push(email);
    return email;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let passwords: PasswordService;
  let verification: EmailVerificationService;
  let dispatcher: BackgroundEmailDispatcher;
  const sender = new InMemoryEmailSender();
  const logs = capturingLogger();

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";
    process.env.AUTH_EMAIL_VERIFICATION_TTL_SECONDS = "3600";
    process.env.WEB_BASE_URL = WEB_BASE_URL;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The whole transport is replaced, so this suite can never reach a real mail server.
      .overrideProvider(EMAIL_SENDER)
      .useValue(sender)
      .overrideProvider(AUTH_LOGGER)
      .useValue(logs.logger)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    passwords = moduleRef.get(PasswordService);
    verification = moduleRef.get(EmailVerificationService);
    dispatcher = moduleRef.get(BackgroundEmailDispatcher);
    // The guard that makes "no real email" true for this file, asserted rather than assumed.
    expect(moduleRef.get(EMAIL_SENDER)).toBe(sender);
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

  /**
   * A pending account as registration left it **before AUTH-003**: somebody's chosen password stored
   * on the unverified row, and the link mailed to the address.
   *
   * Registration no longer takes a password, so the only way such a hash still exists is a row
   * created before the deploy. The request here is the real one — including a `password` field an
   * old client would send, which is ignored — and the inert hash is then written directly, which is
   * exactly the state AUTH-002 has to keep defusing.
   */
  async function register(email: string, password: string): Promise<string> {
    await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password })
      .expect(202);
    await dispatcher.drain();
    const token = tokenFromLastEmail(sender);
    const { passwordHash } = await prisma.user.findUniqueOrThrow({
      where: { email },
    });
    // AUTH-003: the password in the request was never stored.
    expect(passwordHash).toBeNull();
    await prisma.user.update({
      where: { email },
      data: { passwordHash: await passwords.hash(password) },
    });
    return token;
  }

  /** Moves the address's last registration email outside the cooldown, deterministically. */
  async function expireRegistrationCooldown(email: string): Promise<void> {
    await prisma.user.update({
      where: { email },
      data: { registrationEmailClaimedAt: new Date(0) },
    });
  }

  function verify(token: string, password: string) {
    return request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token, password });
  }

  function login(email: string, password: string) {
    return request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password });
  }

  async function signIn(email: string, password: string): Promise<string> {
    const response = await login(email, password).expect(200);
    const token = sessionCookie(response);
    expect(token).toBeTruthy();
    return token ?? "";
  }

  function me(sessionToken: string) {
    return request(app.getHttpServer())
      .get("/auth/me")
      .set("Cookie", `test_auth=${sessionToken}`);
  }

  /** Everything a redemption could change, read straight from PostgreSQL. */
  async function accountState(email: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { verificationTokens: true, resetTokens: true },
    });
    return {
      id: user.id,
      passwordHash: user.passwordHash,
      emailVerifiedAt: user.emailVerifiedAt,
      sessionVersion: user.sessionVersion,
      verificationTokenHashes: user.verificationTokens.map(
        (token) => token.tokenHash,
      ),
      resetTokenHashes: user.resetTokens.map((token) => token.tokenHash),
    };
  }

  async function storedPasswordIs(email: string, password: string) {
    const { passwordHash } = await prisma.user.findUniqueOrThrow({
      where: { email },
    });
    return passwords.verify(passwordHash, password);
  }

  /** An unverified account registered by someone else, with a reset link also outstanding. */
  async function pendingAccountWithResetLink(prefix: string) {
    const email = uniqueEmail(prefix);
    const token = await register(email, attackerPassword);
    await request(app.getHttpServer())
      .post("/auth/forgot-password")
      .send({ email })
      .expect(202);
    const before = await accountState(email);
    expect(before.emailVerifiedAt).toBeNull();
    expect(before.verificationTokenHashes).toEqual([
      hashVerificationToken(token),
    ]);
    expect(before.resetTokenHashes).toHaveLength(1);
    return { email, token, before };
  }

  it("does not let an attacker's registration password survive the victim's verification", async () => {
    const email = uniqueEmail("victim");

    // 1. The attacker registers the victim's address with a password of their own.
    const token = await register(email, attackerPassword);
    const registered = await accountState(email);
    expect(registered.emailVerifiedAt).toBeNull();
    expect(registered.sessionVersion).toBe(0);

    // 2. While unverified, that password yields no session — and, since AUTH-003, not even a
    //    hint that the account exists: the generic failure an unknown address gets.
    const beforeVerification = await login(email, attackerPassword).expect(401);
    expect(beforeVerification.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(sessionCookie(beforeVerification)).toBeUndefined();

    // 3. The mailbox owner opens the link and chooses their own password.
    const verified = await verify(token, ownerPassword).expect(200);
    expect(verified.body).toEqual({ status: "verified" });
    // Verification never signs anybody in.
    expect(verified.headers["set-cookie"]).toBeUndefined();

    // 4. One verified account, whose credential is the owner's and only the owner's.
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    const after = await accountState(email);
    expect(after.id).toBe(registered.id);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.passwordHash).toMatch(/^\$argon2id\$/);
    expect(after.passwordHash).not.toBe(registered.passwordHash);
    expect(await storedPasswordIs(email, ownerPassword)).toBe(true);
    expect(await storedPasswordIs(email, attackerPassword)).toBe(false);
    expect(after.sessionVersion).toBe(1);
    expect(after.verificationTokenHashes).toEqual([]);

    // The attacker's password fails exactly the way an unknown account does.
    const attacker = await login(email, attackerPassword).expect(401);
    expect(attacker.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(sessionCookie(attacker)).toBeUndefined();
    const unknown = await login(
      uniqueEmail("victim-unknown"),
      attackerPassword,
    ).expect(401);
    expect(attacker.body).toEqual(unknown.body);

    // The owner signs in with the password they chose while verifying.
    const session = await signIn(email, ownerPassword);
    expect(sessionVersionClaim(session)).toBe(1);
    const current = await me(session).expect(200);
    expect(current.body).toMatchObject({ id: registered.id, email });

    // The link is spent and cannot be used to choose yet another password.
    const replay = await verify(token, "Third-party-password-42").expect(401);
    expect(replay.body.message).toBe(INVALID_VERIFICATION_TOKEN_MESSAGE);
    expect(await storedPasswordIs(email, ownerPassword)).toBe(true);
    await me(session).expect(200);
  });

  describe("a verification that does not redeem a token changes nothing", () => {
    it("refuses an unknown token", async () => {
      const { email, token, before } =
        await pendingAccountWithResetLink("unknown-token");

      const response = await verify(
        "not-a-real-verification-token",
        ownerPassword,
      ).expect(401);

      expect(response.body.message).toBe(INVALID_VERIFICATION_TOKEN_MESSAGE);
      expect(sessionCookie(response)).toBeUndefined();
      expect(await accountState(email)).toEqual(before);
      // The real link is untouched and still works.
      await verify(token, ownerPassword).expect(200);
    });

    it("refuses malformed requests before looking at any token", async () => {
      const { email, token, before } =
        await pendingAccountWithResetLink("malformed");

      const cases: unknown[] = [
        { token: "", password: ownerPassword },
        { token: "x".repeat(513), password: ownerPassword },
        { token: 42, password: ownerPassword },
        // The pre-AUTH-002 request shape: a real token with no password must not verify anything.
        { token },
        { token, password: 42 },
        // The shared password policy applies to the password being set.
        { token, password: "too-short" },
        { token, password: "a".repeat(1025) },
      ];
      for (const body of cases) {
        const response = await request(app.getHttpServer())
          .post("/auth/verify-email")
          .send(body as object)
          .expect(400);
        expect(sessionCookie(response)).toBeUndefined();
      }

      expect(await accountState(email)).toEqual(before);
      await verify(token, ownerPassword).expect(200);
    });

    it("refuses an expired token", async () => {
      const { email, token, before } =
        await pendingAccountWithResetLink("expired-token");
      await prisma.emailVerificationToken.update({
        where: { userId: before.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await verify(token, ownerPassword).expect(401);

      expect(response.body.message).toBe(INVALID_VERIFICATION_TOKEN_MESSAGE);
      expect(sessionCookie(response)).toBeUndefined();
      const after = await accountState(email);
      // The expired row is cleared, as it always was; nothing else moves.
      expect(after).toEqual({ ...before, verificationTokenHashes: [] });
      await login(email, ownerPassword).expect(401);
    });

    it("refuses an already-used token without touching the owner's account", async () => {
      const email = uniqueEmail("used-token");
      const token = await register(email, attackerPassword);
      await verify(token, ownerPassword).expect(200);
      const session = await signIn(email, ownerPassword);
      const before = await accountState(email);

      const response = await verify(token, attackerPassword).expect(401);

      expect(response.body.message).toBe(INVALID_VERIFICATION_TOKEN_MESSAGE);
      expect(sessionCookie(response)).toBeUndefined();
      expect(await accountState(email)).toEqual(before);
      await me(session).expect(200);
      await login(email, attackerPassword).expect(401);
    });

    it("answers unknown, expired and used tokens identically", async () => {
      const unknownEmail = uniqueEmail("same-answer-unknown");
      await register(unknownEmail, attackerPassword);
      const unknown = await verify("no-such-token", ownerPassword).expect(401);

      const expiredEmail = uniqueEmail("same-answer-expired");
      const expiredToken = await register(expiredEmail, attackerPassword);
      await prisma.emailVerificationToken.updateMany({
        where: { user: { email: expiredEmail } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await verify(expiredToken, ownerPassword).expect(401);

      const usedEmail = uniqueEmail("same-answer-used");
      const usedToken = await register(usedEmail, attackerPassword);
      await verify(usedToken, ownerPassword).expect(200);
      const used = await verify(usedToken, ownerPassword).expect(401);

      expect(expired.body).toEqual(unknown.body);
      expect(used.body).toEqual(unknown.body);
    });

    it("does not pay for an Argon2id hash for a token that cannot be redeemed", async () => {
      const hashing = vi.spyOn(passwords, "hash");

      await verify("invented-token-1", ownerPassword).expect(401);
      await verify("invented-token-2", ownerPassword).expect(401);

      expect(hashing).not.toHaveBeenCalled();
    });
  });

  it("rolls every effect back together when the redemption fails part-way", async () => {
    const { email, token, before } =
      await pendingAccountWithResetLink("rollback");

    // The real PostgreSQL transaction runs; only its last statement — dropping the reset link,
    // after the token was consumed and the password, verification and session version were all
    // written — is made to fail.
    type TransactionCallback = (tx: unknown) => Promise<unknown>;
    const runTransaction = prisma.$transaction.bind(prisma) as (
      callback: TransactionCallback,
    ) => Promise<unknown>;
    const reached: string[] = [];
    vi.spyOn(prisma, "$transaction").mockImplementation(((
      callback: TransactionCallback,
    ) =>
      runTransaction((tx) =>
        callback(
          new Proxy(tx as object, {
            get(target, property) {
              const delegate = Reflect.get(target, property) as unknown;
              if (property === "passwordResetToken") {
                return {
                  deleteMany: () =>
                    Promise.reject(new Error("injected failure")),
                };
              }
              if (
                property === "user" ||
                property === "emailVerificationToken"
              ) {
                return new Proxy(delegate as object, {
                  get(inner, method) {
                    const fn = Reflect.get(inner, method) as unknown;
                    if (typeof fn !== "function") return fn;
                    return (...args: unknown[]) => {
                      reached.push(`${String(property)}.${String(method)}`);
                      return (fn as (...a: unknown[]) => unknown).apply(
                        inner,
                        args,
                      );
                    };
                  },
                });
              }
              return delegate;
            },
          }),
        ),
      )) as never);

    const failed = await verify(token, ownerPassword).expect(500);
    vi.restoreAllMocks();

    // The earlier writes really ran inside the transaction before the failure.
    expect(reached).toEqual(
      expect.arrayContaining([
        "emailVerificationToken.deleteMany",
        "user.update",
      ]),
    );
    expect(sessionCookie(failed)).toBeUndefined();
    // …and none of them survived it: the token is back, the account is unverified with its
    // original hash and version, and the reset link is still there.
    expect(await accountState(email)).toEqual(before);
    await login(email, ownerPassword).expect(401);
    await login(email, attackerPassword).expect(401);

    // A normal attempt afterwards completes every effect.
    await verify(token, ownerPassword).expect(200);
    const after = await accountState(email);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(after.verificationTokenHashes).toEqual([]);
    expect(after.resetTokenHashes).toEqual([]);
    expect(await storedPasswordIs(email, ownerPassword)).toBe(true);
  });

  it("lets exactly one of two concurrent redemptions choose the password", async () => {
    const email = uniqueEmail("concurrent");
    const token = await register(email, attackerPassword);
    const first = "Concurrent-first-password-42";
    const second = "Concurrent-second-password-42";

    const [a, b] = await Promise.all([
      verify(token, first),
      verify(token, second),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 401]);
    const winner = a.status === 200 ? first : second;
    const loser = winner === first ? second : first;

    const after = await accountState(email);
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(after.verificationTokenHashes).toEqual([]);
    // One redemption, one increment: the loser wrote nothing at all.
    expect(after.sessionVersion).toBe(1);
    expect(await storedPasswordIs(email, winner)).toBe(true);
    expect(await storedPasswordIs(email, loser)).toBe(false);

    await signIn(email, winner);
    await login(email, loser).expect(401);
    await login(email, attackerPassword).expect(401);
  });

  it("drops a password-reset link that was outstanding before verification", async () => {
    const { email, token } = await pendingAccountWithResetLink("reset-link");
    const resetToken = tokenFromLastEmail(sender, "reset-password");

    await verify(token, ownerPassword).expect(200);

    expect((await accountState(email)).resetTokenHashes).toEqual([]);
    await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token: resetToken, password: "Stale-reset-password-42" })
      .expect(401);
    expect(await storedPasswordIs(email, ownerPassword)).toBe(true);
  });

  it("uses the same flow for a resent link", async () => {
    const email = uniqueEmail("resend");
    const firstToken = await register(email, attackerPassword);
    await expireRegistrationCooldown(email);

    await request(app.getHttpServer())
      .post("/auth/resend-verification")
      .send({ email })
      .expect(202);
    await dispatcher.drain();
    const secondToken = tokenFromLastEmail(sender);
    expect(secondToken).not.toBe(firstToken);

    // The superseded link is dead; the new one installs the owner's password.
    await verify(firstToken, ownerPassword).expect(401);
    expect((await accountState(email)).emailVerifiedAt).toBeNull();
    await verify(secondToken, ownerPassword).expect(200);

    await signIn(email, ownerPassword);
    await login(email, attackerPassword).expect(401);
  });

  it("keeps the registrant's experience when they choose the same password again", async () => {
    const email = uniqueEmail("same-password");
    const token = await register(email, ownerPassword);

    await verify(token, ownerPassword).expect(200);

    await signIn(email, ownerPassword);
  });

  describe("sessions", () => {
    /**
     * A verified account can hold a live verification link: `POST /auth/resend-verification` decides
     * eligibility on a read taken before it issues, so a resend that races the redemption of the
     * previous link issues a fresh one for an account that is, by then, verified and signed in.
     * The race is reproduced by issuing the link directly once the account is in that state.
     */
    it("ends every existing session when a verification installs a password on a signed-in account", async () => {
      const email = uniqueEmail("signed-in");
      const token = await register(email, attackerPassword);
      await verify(token, ownerPassword).expect(200);
      const browserA = await signIn(email, ownerPassword);
      const browserB = await signIn(email, ownerPassword);
      const before = await accountState(email);
      expect(before.sessionVersion).toBe(1);
      expect(sessionVersionClaim(browserA)).toBe(1);

      const late = await verification.issueToken(before.id);
      const replacement = "Late-link-password-42";
      const response = await verify(late.token, replacement).expect(200);

      expect(sessionCookie(response)).toBeUndefined();
      const after = await accountState(email);
      expect(after.sessionVersion).toBe(2);
      // Not a second verification event: the original instant is kept.
      expect(after.emailVerifiedAt).toEqual(before.emailVerifiedAt);
      await me(browserA).expect(401);
      await me(browserB).expect(401);
      await login(email, ownerPassword).expect(401);
      const fresh = await signIn(email, replacement);
      expect(sessionVersionClaim(fresh)).toBe(2);
      await me(fresh).expect(200);
    });

    it("revokes nothing when the redemption is refused", async () => {
      const email = uniqueEmail("signed-in-refused");
      const token = await register(email, attackerPassword);
      await verify(token, ownerPassword).expect(200);
      const session = await signIn(email, ownerPassword);

      await verify(token, attackerPassword).expect(401);
      await verify("not-a-real-token", attackerPassword).expect(401);

      await me(session).expect(200);
      expect((await accountState(email)).sessionVersion).toBe(1);
    });
  });

  it("never writes a token, a token hash or a password to the logs", async () => {
    const email = uniqueEmail("logs");
    const token = await register(email, attackerPassword);
    await verify("invented-token", ownerPassword).expect(401);
    await verify(token, ownerPassword).expect(200);
    const { id } = await accountState(email);

    const output = logs.output();
    expect(output).toContain("auth.email.verification.completed");
    expect(output).toContain('"reason":"email_verification"');
    expect(output).not.toContain(token);
    expect(output).not.toContain(hashVerificationToken(token));
    expect(output).not.toContain(ownerPassword);
    expect(output).not.toContain(attackerPassword);
    // The internal user ID is the correlation key, never the address.
    expect(output).toContain(id);
    expect(output).not.toContain(email);
  });

  it("returns nothing but the status", async () => {
    const email = uniqueEmail("response-shape");
    const token = await register(email, attackerPassword);

    const response = await verify(token, ownerPassword).expect(200);

    expect(response.body).toEqual({ status: "verified" });
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("sessionVersion");
    expect(raw).not.toContain(token);
  });
});

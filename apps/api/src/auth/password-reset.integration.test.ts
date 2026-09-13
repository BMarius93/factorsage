import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { OAuthProvider } from "@intrinsic/database";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { EMAIL_SENDER } from "../email/email-sender";
import { InMemoryEmailSender } from "../email/in-memory-email-sender";
import { AUTH_LOGGER } from "./auth.tokens";
import { hashPasswordResetToken } from "./password-reset.service";
import { PasswordService } from "./password.service";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

const WEB_BASE_URL = "http://web.example.test";
const RESET_TTL_SECONDS = 3600;

/** Reads the plaintext token back out of the link the user would actually click. */
function tokenFromLastEmail(sender: InMemoryEmailSender): string {
  const message = sender.lastMessage;
  expect(message).toBeDefined();

  const match = /\/reset-password\?token=([^\s"<]+)/.exec(message?.text ?? "");
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

describe("password recovery", () => {
  const suffix = randomUUID();
  const oldPassword = "Original-test-password-42";
  const newPassword = "Replacement-test-password-42";
  const emails: string[] = [];

  function uniqueEmail(prefix: string): string {
    const email = `${prefix}-${suffix}-${emails.length}@example.test`;
    emails.push(email);
    return email;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let passwords: PasswordService;
  const sender = new InMemoryEmailSender();
  const logs = capturingLogger();

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";
    process.env.AUTH_PASSWORD_RESET_TTL_SECONDS = String(RESET_TTL_SECONDS);
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
  });

  afterEach(() => {
    sender.reset();
  });

  afterAll(async () => {
    if (prisma && emails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
    }
    if (app) {
      await app.close();
    }
  });

  /** A verified local account, created the way the product would leave one. */
  async function localUser(prefix: string): Promise<{
    id: string;
    email: string;
  }> {
    const email = uniqueEmail(prefix);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(oldPassword),
        emailVerifiedAt: new Date(),
      },
      select: { id: true, email: true },
    });
    return user;
  }

  function forgot(email: string) {
    return request(app.getHttpServer())
      .post("/auth/forgot-password")
      .send({ email });
  }

  function reset(token: string, password: string) {
    return request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token, password });
  }

  function login(email: string, password: string) {
    return request(app.getHttpServer()).post("/auth/login").send({ email, password });
  }

  it("answers identically for an unknown address, a Google-only account, and a real one", async () => {
    const unknown = `absent-${suffix}@example.test`;
    const googleOnly = uniqueEmail("reset-google-only");
    await prisma.user.create({
      data: {
        email: googleOnly,
        emailVerifiedAt: new Date(),
        oauthAccounts: {
          create: {
            provider: OAuthProvider.GOOGLE,
            providerAccountId: `google-${randomUUID()}`,
          },
        },
      },
    });
    const real = await localUser("reset-enumeration");

    const responses = [
      await forgot(unknown).expect(202),
      await forgot(googleOnly).expect(202),
      await forgot(real.email).expect(202),
    ];

    // Same status, same body: the public response says nothing about which addresses exist or
    // how their owners sign in.
    for (const response of responses) {
      expect(response.body).toEqual({ status: "accepted" });
    }
    // Only the account that actually has a local password was mailed anything, and the
    // Google-only account was not given a password it never asked for.
    expect(sender.messages).toHaveLength(1);
    expect(sender.lastMessage?.to).toBe(real.email);
    expect(
      await prisma.passwordResetToken.findFirst({
        where: { user: { email: { in: [googleOnly] } } },
      }),
    ).toBeNull();
  });

  it("persists only a hash of the reset token", async () => {
    const user = await localUser("reset-hash");

    await forgot(user.email).expect(202);
    const token = tokenFromLastEmail(sender);

    const stored = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(stored.tokenHash).toBe(hashPasswordResetToken(token));
    expect(stored.tokenHash).not.toBe(token);
    // The plaintext exists in the email and nowhere else.
    expect(
      await prisma.passwordResetToken.findFirst({ where: { tokenHash: token } }),
    ).toBeNull();
    expect(stored.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + RESET_TTL_SECONDS * 1000,
    );
  });

  it("resets the password, invalidates the old one, and keeps the token single-use", async () => {
    const user = await localUser("reset-happy");
    await forgot(user.email).expect(202);
    const token = tokenFromLastEmail(sender);

    const response = await reset(token, newPassword).expect(200);
    expect(response.body).toEqual({ status: "password_reset" });

    await login(user.email, newPassword).expect(200);
    await login(user.email, oldPassword).expect(401);

    // Redeeming consumed the row, so the same link cannot be replayed.
    expect(
      await prisma.passwordResetToken.findUnique({ where: { userId: user.id } }),
    ).toBeNull();
    await reset(token, "Third-test-password-42").expect(401);
    await login(user.email, newPassword).expect(200);
  });

  it("stores the new password as an Argon2id hash, never as plaintext", async () => {
    const user = await localUser("reset-hashing");
    await forgot(user.email).expect(202);
    await reset(tokenFromLastEmail(sender), newPassword).expect(200);

    const stored = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    expect(stored.passwordHash?.startsWith("$argon2id$")).toBe(true);
    expect(stored.passwordHash).not.toContain(newPassword);
  });

  it("invalidates the previous link when a new one is requested", async () => {
    const user = await localUser("reset-rotation");
    await forgot(user.email).expect(202);
    const first = tokenFromLastEmail(sender);
    sender.reset();
    await forgot(user.email).expect(202);
    const second = tokenFromLastEmail(sender);

    expect(second).not.toBe(first);
    await reset(first, newPassword).expect(401);
    await reset(second, newPassword).expect(200);
    // One outstanding token per user is a database rule, not a convention.
    expect(
      await prisma.passwordResetToken.count({ where: { userId: user.id } }),
    ).toBe(0);
  });

  it("rejects an unknown token", async () => {
    await reset("not-a-real-token", newPassword).expect(401);
  });

  it("rejects an expired token and clears it", async () => {
    const user = await localUser("reset-expired");
    await forgot(user.email).expect(202);
    const token = tokenFromLastEmail(sender);

    await prisma.passwordResetToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await reset(token, newPassword).expect(401);
    expect(
      await prisma.passwordResetToken.findUnique({ where: { userId: user.id } }),
    ).toBeNull();
    // The old password still works: an expired link changes nothing.
    await login(user.email, oldPassword).expect(200);
  });

  it("lets exactly one of two concurrent redemptions win", async () => {
    const user = await localUser("reset-concurrent");
    await forgot(user.email).expect(202);
    const token = tokenFromLastEmail(sender);

    const other = "Losing-test-password-42";
    const outcomes = await Promise.all([
      reset(token, newPassword),
      reset(token, other),
    ]);

    // Exactly one redemption wins; which one is a genuine race, so the assertion is that the
    // account ends up on one of the two passwords and never on both or neither.
    expect(outcomes.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    const accepted = await Promise.all([
      login(user.email, newPassword),
      login(user.email, other),
    ]);
    expect(accepted.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    await login(user.email, oldPassword).expect(401);
  });

  it("applies the registration password policy to the new password", async () => {
    const user = await localUser("reset-policy");
    await forgot(user.email).expect(202);
    const token = tokenFromLastEmail(sender);

    const response = await reset(token, "short").expect(400);
    expect(response.body.message).toContain("at least");
    // A rejected attempt must not burn the link.
    await reset(token, newPassword).expect(200);
  });

  it("rejects a malformed request without touching anything", async () => {
    await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ password: newPassword })
      .expect(400);
    await request(app.getHttpServer())
      .post("/auth/reset-password")
      .send({ token: "   ", password: newPassword })
      .expect(400);
    await request(app.getHttpServer())
      .post("/auth/forgot-password")
      .send({ email: "not-an-address" })
      .expect(400);
  });

  it("verifies an unverified account that proves control of its inbox", async () => {
    const email = uniqueEmail("reset-unverified");
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(oldPassword),
        emailVerifiedAt: null,
        verificationTokens: {
          create: {
            tokenHash: `hash-${randomUUID()}`,
            expiresAt: new Date(Date.now() + 60_000),
          },
        },
      },
    });

    await forgot(email).expect(202);
    await reset(tokenFromLastEmail(sender), newPassword).expect(200);

    // Holding the reset link proved exactly what a verification link proves, so the account is
    // usable rather than stuck behind a verification it can no longer complete.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerifiedAt).not.toBeNull();
    expect(
      await prisma.emailVerificationToken.findUnique({
        where: { userId: user.id },
      }),
    ).toBeNull();
    await login(email, newPassword).expect(200);
  });

  it("keeps the original verification instant for an already-verified account", async () => {
    const email = uniqueEmail("reset-keeps-verified");
    const verifiedAt = new Date(Date.now() - 86_400_000);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(oldPassword),
        emailVerifiedAt: verifiedAt,
      },
    });

    await forgot(email).expect(202);
    await reset(tokenFromLastEmail(sender), newPassword).expect(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.emailVerifiedAt?.getTime()).toBe(verifiedAt.getTime());
  });

  it("changes nothing but the password", async () => {
    const email = uniqueEmail("reset-scope");
    const before = await prisma.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(oldPassword),
        emailVerifiedAt: new Date(),
        role: "ADMIN",
        plan: "PRO",
        oauthAccounts: {
          create: {
            provider: OAuthProvider.GOOGLE,
            providerAccountId: `google-${randomUUID()}`,
          },
        },
      },
    });

    await forgot(email).expect(202);
    await reset(tokenFromLastEmail(sender), newPassword).expect(200);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: before.id },
      include: { oauthAccounts: true },
    });
    expect(after.role).toBe("ADMIN");
    expect(after.plan).toBe("PRO");
    expect(after.email).toBe(email);
    // A reset is not an identity change: the linked Google account stays linked.
    expect(after.oauthAccounts).toHaveLength(1);
  });

  it("still answers 202 when the mail transport is down", async () => {
    const user = await localUser("reset-smtp-down");
    sender.failWith = new Error("smtp unavailable");

    // Failing here would answer the one question this endpoint exists not to answer: only an
    // address with a local account ever reaches the transport.
    await forgot(user.email).expect(202);
    sender.failWith = null;
  });

  it("never writes a reset token or a password to the logs", async () => {
    const user = await localUser("reset-logs");
    await forgot(user.email).expect(202);
    const token = tokenFromLastEmail(sender);
    await reset(token, newPassword).expect(200);

    const output = logs.output();
    expect(output).toContain("auth.password.reset.completed");
    expect(output).not.toContain(token);
    expect(output).not.toContain(newPassword);
    expect(output).not.toContain(oldPassword);
    expect(output).not.toContain(hashPasswordResetToken(token));
    // The internal user ID is the correlation key, never the address.
    expect(output).toContain(user.id);
    expect(output).not.toContain(user.email);
  });
});

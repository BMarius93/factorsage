import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { EMAIL_NOT_VERIFIED_CODE } from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
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
import {
  EmailVerificationService,
  hashVerificationToken,
} from "./email-verification.service";
import {
  EMAIL_TAKEN_MESSAGE,
  INVALID_VERIFICATION_TOKEN_MESSAGE,
} from "./registration.service";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();

const WEB_BASE_URL = "http://web.example.test";

/** Reads the plaintext token back out of the link the user would actually click. */
function tokenFromLastEmail(sender: InMemoryEmailSender): string {
  const message = sender.lastMessage;
  expect(message).toBeDefined();

  const match = /\/verify-email\?token=([^\s"<]+)/.exec(message?.text ?? "");
  expect(match?.[1]).toBeTruthy();
  return decodeURIComponent(match?.[1] ?? "");
}

describe("registration and email verification", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const emails: string[] = [];

  function uniqueEmail(prefix: string): string {
    const email = `${prefix}-${suffix}-${emails.length}@example.test`;
    emails.push(email);
    return email;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let verification: EmailVerificationService;
  const sender = new InMemoryEmailSender();

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
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    verification = moduleRef.get(EmailVerificationService);
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

  type TransactionCallback = (tx: unknown) => Promise<unknown>;

  /**
   * Runs the service's real database transaction but makes the user update inside it fail.
   *
   * The token delete still happens against PostgreSQL, so the test observes whether the
   * transaction actually rolls it back. If consuming and verifying were separate statements the
   * link would already be burned and the account left permanently unverifiable.
   */
  function failUserUpdateInsideTheTransaction(): void {
    const runTransaction = prisma.$transaction.bind(prisma) as (
      callback: TransactionCallback,
    ) => Promise<unknown>;

    vi.spyOn(prisma, "$transaction").mockImplementation(((
      callback: TransactionCallback,
    ) =>
      runTransaction((tx) =>
        callback({
          emailVerificationToken: (
            tx as { emailVerificationToken: unknown }
          ).emailVerificationToken,
          user: { update: () => Promise.reject(new Error("write failed")) },
        }),
      )) as never);
  }

  async function register(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password })
      .expect(201);
    return tokenFromLastEmail(sender);
  }

  it("creates an unverified user with a normalized email and an Argon2id hash", async () => {
    const email = uniqueEmail("register");

    const response = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email: `  ${email.toUpperCase()}  `, password })
      .expect(201);

    expect(response.body).toEqual({ status: "verification_sent" });
    // Registration establishes an identity but never a session.
    expect(response.headers["set-cookie"]).toBeUndefined();

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.emailVerifiedAt).toBeNull();
    expect(user?.role).toBe("USER");
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user?.passwordHash).not.toContain(password);
  });

  it("requests the verification email through the email boundary", async () => {
    const email = uniqueEmail("boundary");
    await register(email);

    expect(sender.messages).toHaveLength(1);
    expect(sender.lastMessage?.to).toBe(email);
    expect(sender.lastMessage?.text).toContain(
      `${WEB_BASE_URL}/verify-email?token=`,
    );
  });

  it("persists only a hash of the verification token", async () => {
    const email = uniqueEmail("token-hash");
    const token = await register(email);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const stored = await prisma.emailVerificationToken.findUniqueOrThrow({
      where: { userId: user.id },
    });

    expect(stored.tokenHash).not.toBe(token);
    expect(stored.tokenHash).toBe(hashVerificationToken(token));
    // Nothing anywhere in the row carries the plaintext the user received.
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("rejects a password that is shorter than the policy minimum", async () => {
    const email = uniqueEmail("short-password");

    await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password: "short" })
      .expect(400);

    expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
  });

  it("rejects a duplicate registration for an existing local account", async () => {
    const email = uniqueEmail("duplicate");
    await register(email);
    sender.reset();

    const response = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password: "A-different-password-42" })
      .expect(409);

    expect(response.body.message).toBe(EMAIL_TAKEN_MESSAGE);
    expect(sender.messages).toHaveLength(0);
  });

  it("never attaches a password to an existing external-only account", async () => {
    const email = uniqueEmail("external-only");
    const created = await prisma.user.create({
      data: { email, passwordHash: null, emailVerifiedAt: new Date() },
    });

    const response = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password })
      .expect(409);

    // The response is identical to the local-duplicate case, so registration cannot be used to
    // discover which kind of account holds an address.
    expect(response.body.message).toBe(EMAIL_TAKEN_MESSAGE);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(after.passwordHash).toBeNull();

    await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(401);
  });

  it("verifies a valid token exactly once and then rejects it", async () => {
    const email = uniqueEmail("verify");
    const token = await register(email);

    const verified = await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token })
      .expect(200);
    expect(verified.body).toEqual({ status: "verified" });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(
      await prisma.emailVerificationToken.findUnique({
        where: { userId: user.id },
      }),
    ).toBeNull();

    const replay = await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token })
      .expect(401);
    expect(replay.body.message).toBe(INVALID_VERIFICATION_TOKEN_MESSAGE);
  });

  it("rejects an unknown token", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token: "not-a-real-verification-token" })
      .expect(401);

    expect(response.body.message).toBe(INVALID_VERIFICATION_TOKEN_MESSAGE);
  });

  it("rejects an expired token and clears it", async () => {
    const email = uniqueEmail("expired");
    const token = await register(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    await prisma.emailVerificationToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token })
      .expect(401);

    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ emailVerifiedAt: null });
    expect(
      await prisma.emailVerificationToken.findUnique({
        where: { userId: user.id },
      }),
    ).toBeNull();
  });

  it("consumes the token and verifies the user as one atomic step", async () => {
    const email = uniqueEmail("atomic-rollback");
    const token = await register(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    failUserUpdateInsideTheTransaction();
    await expect(verification.redeemToken(token)).rejects.toThrow("write failed");
    vi.restoreAllMocks();

    const stored = await prisma.emailVerificationToken.findUnique({
      where: { userId: user.id },
    });
    expect(stored).not.toBeNull();
    expect(stored?.tokenHash).toBe(hashVerificationToken(token));
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerifiedAt,
    ).toBeNull();

    // The rolled-back link is still usable, which is the point of the transaction.
    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token })
      .expect(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerifiedAt,
    ).not.toBeNull();
  });

  it("lets exactly one of two concurrent redemptions win", async () => {
    const email = uniqueEmail("concurrent");
    const token = await register(email);

    const responses = await Promise.all([
      request(app.getHttpServer()).post("/auth/verify-email").send({ token }),
      request(app.getHttpServer()).post("/auth/verify-email").send({ token }),
    ]);
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 401]);

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(
      await prisma.emailVerificationToken.findUnique({
        where: { userId: user.id },
      }),
    ).toBeNull();
  });

  it("rotates the token on resend and invalidates the previous link", async () => {
    const email = uniqueEmail("resend");
    const firstToken = await register(email);

    const response = await request(app.getHttpServer())
      .post("/auth/resend-verification")
      .send({ email })
      .expect(202);
    expect(response.body).toEqual({ status: "accepted" });

    const secondToken = tokenFromLastEmail(sender);
    expect(secondToken).not.toBe(firstToken);

    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token: firstToken })
      .expect(401);
    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token: secondToken })
      .expect(200);
  });

  it("accepts a resend for an unknown or already-verified address without sending mail", async () => {
    const email = uniqueEmail("resend-verified");
    const token = await register(email);
    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token })
      .expect(200);
    sender.reset();

    await request(app.getHttpServer())
      .post("/auth/resend-verification")
      .send({ email })
      .expect(202);
    await request(app.getHttpServer())
      .post("/auth/resend-verification")
      .send({ email: `unknown-${suffix}@example.test` })
      .expect(202);

    // Identical accepted responses, and nothing was actually sent in either case.
    expect(sender.messages).toHaveLength(0);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(
      await prisma.emailVerificationToken.findUnique({
        where: { userId: user.id },
      }),
    ).toBeNull();
  });

  it("blocks password login until the address is verified and allows it afterwards", async () => {
    const email = uniqueEmail("login-gate");
    const token = await register(email);

    const blocked = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(403);
    expect(blocked.body.code).toBe(EMAIL_NOT_VERIFIED_CODE);

    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token })
      .expect(200);

    const agent = request.agent(app.getHttpServer());
    const allowed = await agent
      .post("/auth/login")
      .send({ email, password })
      .expect(200);
    expect(allowed.headers["set-cookie"]?.[0]).toContain("test_auth=");

    const me = await agent.get("/auth/me").expect(200);
    expect(me.body).toMatchObject({ email, role: "USER" });
  });

  it("reports the account as unusable when the verification email cannot be sent", async () => {
    const email = uniqueEmail("send-failure");
    sender.failWith = new Error("smtp unavailable");

    await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password })
      .expect(503);

    // The account exists but stays unverified, so the user can ask for a new link later.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
  });
});

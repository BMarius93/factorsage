import { REQUIRED_TERMS_VERSION } from "@intrinsic/contracts";
import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
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
import {
  EmailVerificationService,
  hashVerificationToken,
} from "./email-verification.service";
import { PasswordService } from "./password.service";
import { INVALID_CREDENTIALS_MESSAGE } from "./auth.service";
import { BackgroundEmailDispatcher } from "./background-email-dispatcher";
import { INVALID_VERIFICATION_TOKEN_MESSAGE } from "./registration.service";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();
// Compiling `AppModule` installs the real rate limiter. Loopback makes every request in this
// file one caller, so its counters get their own namespace and a burst-sized allowance;
// enforcement itself stays on.
useIsolatedRateLimits();

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
  let passwords: PasswordService;
  let dispatcher: BackgroundEmailDispatcher;
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
    passwords = moduleRef.get(PasswordService);
    dispatcher = moduleRef.get(BackgroundEmailDispatcher);
    // The guard that makes "no real email" true for this file, asserted rather than assumed.
    expect(moduleRef.get(EMAIL_SENDER)).toBe(sender);
  });

  afterEach(async () => {
    await dispatcher.drain();
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

  /** Verification sets the account's password (AUTH-002); here the registrant keeps theirs. */
  function verify(token: string) {
    return request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION });
  }

  /**
   * Issues a fresh verification link the first time the redemption transaction reads the row.
   *
   * `issueToken` upserts by `userId`, so the resend **reuses the row being read**: same `id`, new
   * `tokenHash`, new `expiresAt`. That is the collision the redemption has to survive, and two
   * real requests cannot be made to collide on demand. The real transaction still runs against
   * PostgreSQL; only the gap between its read and its write is widened, and the resend commits on
   * the ordinary client because the transaction holds no lock on that row.
   */
  function resendOnStaleRead(userId: string): {
    token: () => string;
    restore: () => void;
  } {
    let issued: string | null = null;
    const runTransaction = prisma.$transaction.bind(prisma) as (
      callback: TransactionCallback,
    ) => Promise<unknown>;

    vi.spyOn(prisma, "$transaction").mockImplementation(((
      callback: TransactionCallback,
    ) =>
      runTransaction(async (tx) => {
        const scoped = tx as {
          emailVerificationToken: {
            findUnique: (args: unknown) => Promise<unknown>;
            deleteMany: (args: unknown) => Promise<unknown>;
          };
          user: unknown;
        };

        return callback({
          emailVerificationToken: {
            findUnique: async (args: unknown) => {
              const record =
                await scoped.emailVerificationToken.findUnique(args);
              if (record && issued === null) {
                issued = (await verification.issueToken(userId)).token;
              }
              return record;
            },
            deleteMany: (args: unknown) =>
              scoped.emailVerificationToken.deleteMany(args),
          },
          user: scoped.user,
        });
      })) as never);

    return {
      token: () => {
        expect(issued).toBeTruthy();
        return issued ?? "";
      },
      restore: () => {
        vi.restoreAllMocks();
      },
    };
  }

  /** Email-first registration (AUTH-003), returning the activation link it mailed. */
  async function register(email: string): Promise<string> {
    await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email })
      .expect(202);
    await dispatcher.drain();
    return tokenFromLastEmail(sender);
  }

  /** Moves the address's last registration email outside the cooldown, deterministically. */
  async function expireRegistrationCooldown(email: string): Promise<void> {
    await prisma.user.update({
      where: { email },
      data: { registrationEmailClaimedAt: new Date(0) },
    });
  }

  it("creates an unverified user with a normalized email and no password (AUTH-003)", async () => {
    const email = uniqueEmail("register");

    const response = await request(app.getHttpServer())
      .post("/auth/register")
      // A client built before AUTH-003 still sends a password; it is ignored, never stored.
      .send({ email: `  ${email.toUpperCase()}  `, password })
      .expect(202);

    expect(response.body).toEqual({ status: "accepted" });
    // Registration establishes an identity but never a session.
    expect(response.headers["set-cookie"]).toBeUndefined();

    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).not.toBeNull();
    expect(user?.emailVerifiedAt).toBeNull();
    expect(user?.role).toBe("USER");
    expect(user?.passwordHash).toBeNull();
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

  it("rejects a malformed address before touching the database", async () => {
    for (const email of ["", "not-an-address", "two@@example.test", 42]) {
      await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email })
        .expect(400);
    }
    await request(app.getHttpServer()).post("/auth/register").send({}).expect(400);
    await dispatcher.drain();
    expect(sender.messages).toHaveLength(0);
  });

  it("never attaches a password to an existing external-only account", async () => {
    const email = uniqueEmail("external-only");
    const created = await prisma.user.create({
      data: { email, passwordHash: null, emailVerifiedAt: new Date() },
    });

    await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, password })
      .expect(202);
    await dispatcher.drain();

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
      .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION })
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
      .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION })
      .expect(401);
    expect(replay.body.message).toBe(INVALID_VERIFICATION_TOKEN_MESSAGE);
  });

  it("rejects an unknown token", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({
        token: "not-a-real-verification-token",
        password,
        termsVersion: REQUIRED_TERMS_VERSION,
      })
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
      .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION })
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
    await expect(
      verification.redeemToken({
        token,
        passwordHash: await passwords.hash(password),
        acceptance: [],
      }),
    ).rejects.toThrow("write failed");
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
      .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION })
      .expect(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerifiedAt,
    ).not.toBeNull();
  });

  it("refuses a token the resend rotated away between the transactional read and the consume", async () => {
    const email = uniqueEmail("verify-consume-race");
    const stale = await register(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    // The link is valid throughout: this is the ordinary success path right up to the consuming
    // delete, by which point the row belongs to a link that was mailed afterwards.
    const resend = resendOnStaleRead(user.id);
    try {
      await verify(stale).expect(401);
    } finally {
      resend.restore();
    }

    // Consuming by row id alone would have reported a count of one for the *new* token and
    // verified the address on the strength of a link the resend was supposed to invalidate.
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerifiedAt,
    ).toBeNull();

    const survivor = await prisma.emailVerificationToken.findUnique({
      where: { userId: user.id },
    });
    expect(survivor).not.toBeNull();
    expect(survivor?.tokenHash).toBe(hashVerificationToken(resend.token()));

    // The link the resend actually mailed is untouched and still verifies.
    await verify(resend.token()).expect(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerifiedAt,
    ).not.toBeNull();
  });

  it("does not let the cheap expired-token cleanup delete a link the resend just issued", async () => {
    const email = uniqueEmail("verify-cleanup-race");
    const stale = await register(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.emailVerificationToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // An expired token is refused and cleared by the cheap pre-check, before any transaction. The
    // seam is the service's own reference to Prisma, swapped for a forwarder that issues a fresh
    // link the first time the expired row is read — the same row, since issuance upserts.
    let issued: string | null = null;
    const holder = verification as unknown as { prisma: PrismaService };
    const real = holder.prisma;
    const tokens = real.emailVerificationToken;
    holder.prisma = {
      $transaction: real.$transaction.bind(real),
      emailVerificationToken: {
        upsert: (args: never) => tokens.upsert(args),
        deleteMany: (args: never) => tokens.deleteMany(args),
        findUnique: async (args: never) => {
          const record = await tokens.findUnique(args);
          if (record && issued === null) {
            issued = (await verification.issueToken(user.id)).token;
          }
          return record;
        },
      },
    } as unknown as PrismaService;
    try {
      await verify(stale).expect(401);
    } finally {
      holder.prisma = real;
    }

    // Cleaning up by row id alone would have thrown away the link the user was just emailed,
    // leaving them with an address they could no longer verify.
    expect(issued).toBeTruthy();
    const survivor = await prisma.emailVerificationToken.findUnique({
      where: { userId: user.id },
    });
    expect(survivor?.tokenHash).toBe(hashVerificationToken(issued ?? ""));

    await verify(issued ?? "").expect(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerifiedAt,
    ).not.toBeNull();
  });

  it("does not let the transactional expired-token cleanup delete a link the resend just issued", async () => {
    const email = uniqueEmail("verify-cleanup-race-tx");
    const stale = await register(email);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    // Valid at the cheap check, expired during the hash: the only way the transaction's own
    // expired branch is ever reached.
    const argon2id = passwords.hash.bind(passwords);
    vi.spyOn(passwords, "hash").mockImplementation(async (value: string) => {
      await prisma.emailVerificationToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      return argon2id(value);
    });
    const resend = resendOnStaleRead(user.id);
    try {
      await verify(stale).expect(401);
    } finally {
      resend.restore();
    }

    // A transaction is not a lock: at READ COMMITTED the delete would have re-read the row and
    // removed the freshly issued link.
    const survivor = await prisma.emailVerificationToken.findUnique({
      where: { userId: user.id },
    });
    expect(survivor).not.toBeNull();
    expect(survivor?.tokenHash).toBe(hashVerificationToken(resend.token()));

    await verify(resend.token()).expect(200);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
        .emailVerifiedAt,
    ).not.toBeNull();
  });

  it("lets exactly one of two concurrent redemptions win", async () => {
    const email = uniqueEmail("concurrent");
    const token = await register(email);

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post("/auth/verify-email")
        .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION }),
      request(app.getHttpServer())
        .post("/auth/verify-email")
        .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION }),
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
    await expireRegistrationCooldown(email);

    const response = await request(app.getHttpServer())
      .post("/auth/resend-verification")
      .send({ email })
      .expect(202);
    expect(response.body).toEqual({ status: "accepted" });
    await dispatcher.drain();

    const secondToken = tokenFromLastEmail(sender);
    expect(secondToken).not.toBe(firstToken);

    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token: firstToken, password, termsVersion: REQUIRED_TERMS_VERSION })
      .expect(401);
    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token: secondToken, password, termsVersion: REQUIRED_TERMS_VERSION })
      .expect(200);
  });

  it("accepts a resend for an unknown or already-verified address without sending mail", async () => {
    const email = uniqueEmail("resend-verified");
    const token = await register(email);
    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION })
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
    await dispatcher.drain();

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

    // A pending account has no password at all, and gets the generic failure (AUTH-003).
    const blocked = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password })
      .expect(401);
    expect(blocked.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);

    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token, password, termsVersion: REQUIRED_TERMS_VERSION })
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

  it("answers the same when the activation email cannot be sent, and the retry succeeds", async () => {
    const email = uniqueEmail("send-failure");
    sender.failWith = new Error("simulated transport failure");

    const failed = await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email })
      .expect(202);
    expect(failed.body).toEqual({ status: "accepted" });
    await dispatcher.drain();

    // The account exists, unverified, and the failed send gave its claim back.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user.emailVerifiedAt).toBeNull();
    expect(user.registrationEmailClaimedAt).toBeNull();
    expect(sender.messages).toHaveLength(0);

    sender.failWith = null;
    const token = await register(email);
    await verify(token).expect(200);
  });
});

import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { OAuthProvider } from "@intrinsic/database";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
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
import { AUTH_LOGGER } from "./auth.tokens";
import {
  hashPasswordResetToken,
  PasswordResetService,
} from "./password-reset.service";
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
  let resets: PasswordResetService;
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
    resets = moduleRef.get(PasswordResetService);
  });

  afterEach(() => {
    sender.reset();
    vi.restoreAllMocks();
  });

  /**
   * Counts Argon2id hashes performed by the API while handling one request.
   *
   * The spy goes on the container's single `PasswordService`, which is the same instance the
   * recovery service holds, and is installed only after the fixture user has been built — the
   * helper that creates one hashes a password too.
   */
  function watchPasswordHashing() {
    return vi.spyOn(passwords, "hash");
  }

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

    const hashing = watchPasswordHashing();
    const response = await reset(token, newPassword).expect(200);
    expect(response.body).toEqual({ status: "password_reset" });
    // The guard is a filter, not a second hash: a real token still costs exactly one.
    expect(hashing).toHaveBeenCalledTimes(1);

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
    const hashing = watchPasswordHashing();
    await reset(first, newPassword).expect(401);
    // Rotation removed the first link's hash, so the superseded link is refused on the cheap path
    // like any other unknown token. Rotation itself is unchanged: the second link still works.
    expect(hashing).not.toHaveBeenCalled();
    await reset(second, newPassword).expect(200);
    expect(hashing).toHaveBeenCalledTimes(1);
    // One outstanding token per user is a database rule, not a convention.
    expect(
      await prisma.passwordResetToken.count({ where: { userId: user.id } }),
    ).toBe(0);
  });

  it("rejects an unknown token without paying for an Argon2id hash", async () => {
    const hashing = watchPasswordHashing();

    await reset("not-a-real-token", newPassword).expect(401);

    // The endpoint is unauthenticated and generic rate limiting is deliberately deferred, so a
    // string anybody can invent must not be able to buy a deliberately expensive computation.
    expect(hashing).not.toHaveBeenCalled();
  });

  it("costs no Argon2id hash however many invented tokens arrive", async () => {
    const hashing = watchPasswordHashing();

    await Promise.all(
      Array.from({ length: 5 }, (_unused, index) =>
        reset(`invented-token-${index}`, newPassword).expect(401),
      ),
    );

    expect(hashing).not.toHaveBeenCalled();
  });

  it("rejects an expired token and clears it", async () => {
    const user = await localUser("reset-expired");
    await forgot(user.email).expect(202);
    const token = tokenFromLastEmail(sender);

    await prisma.passwordResetToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const hashing = watchPasswordHashing();
    await reset(token, newPassword).expect(401);

    // A token that has expired is refused before the expensive hash, exactly like an unknown one.
    expect(hashing).not.toHaveBeenCalled();
    // Expiry is the one verdict that needs no transaction — an expired token can never become
    // valid again — so the row is still cleared on the way out.
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

  type RotationRace = {
    readonly token: () => string;
    readonly restore: () => void;
  };

  function rotationRace(issued: () => string | null, restore: () => void): RotationRace {
    return {
      token: () => {
        const value = issued();
        expect(value).toBeTruthy();
        return value ?? "";
      },
      restore,
    };
  }

  /**
   * Issues a fresh link for `userId` the first time the stale row is read, and reports its token.
   *
   * `issueToken` upserts by `userId`, so this reuses the very row the caller just read as
   * expired — same `id`, new `tokenHash`, new `expiresAt`. That is the collision the cleanup has
   * to survive, and it cannot be produced on demand by racing two real requests.
   *
   * The seam is the service's own reference to Prisma, swapped for a forwarder. Spying on a
   * Prisma delegate method would not work here: `findUnique` is resolved through the delegate's
   * proxy rather than being an own property, so `vi.spyOn` reads `undefined` as the original and
   * restoring writes that back, breaking the client for every later test in the file.
   */
  function rotateOnNextStaleRead(userId: string): RotationRace {
    let issued: string | null = null;
    const holder = resets as unknown as { prisma: PrismaService };
    const real = holder.prisma;
    const tokens = real.passwordResetToken;

    holder.prisma = {
      $transaction: real.$transaction.bind(real),
      passwordResetToken: {
        upsert: (args: never) => tokens.upsert(args),
        deleteMany: (args: never) => tokens.deleteMany(args),
        findUnique: async (args: never) => {
          const record = await tokens.findUnique(args);
          if (record && issued === null) {
            issued = (await resets.issueToken(userId)).token;
          }
          return record;
        },
      },
    } as unknown as PrismaService;

    return rotationRace(
      () => issued,
      () => {
        holder.prisma = real;
      },
    );
  }

  type TransactionCallback = (tx: unknown) => Promise<unknown>;

  /**
   * The same interleave, but inside the redemption transaction.
   *
   * The real transaction still runs against PostgreSQL; only the moment between its read of the
   * expired row and its cleanup is widened, by issuing a new link on the ordinary client — a
   * separate connection, which commits independently because the transaction holds no lock on
   * that row.
   */
  function rotateStaleReadInsideTheTransaction(userId: string): RotationRace {
    let issued: string | null = null;
    const runTransaction = prisma.$transaction.bind(prisma) as (
      callback: TransactionCallback,
    ) => Promise<unknown>;

    vi.spyOn(prisma, "$transaction").mockImplementation(((
      callback: TransactionCallback,
    ) =>
      runTransaction(async (tx) => {
        const scoped = tx as {
          passwordResetToken: {
            findUnique: (args: unknown) => Promise<unknown>;
            deleteMany: (args: unknown) => Promise<unknown>;
          };
          user: unknown;
          emailVerificationToken: unknown;
        };

        return callback({
          passwordResetToken: {
            findUnique: async (args: unknown) => {
              const record = await scoped.passwordResetToken.findUnique(args);
              if (record && issued === null) {
                issued = (await resets.issueToken(userId)).token;
              }
              return record;
            },
            deleteMany: (args: unknown) =>
              scoped.passwordResetToken.deleteMany(args),
          },
          user: scoped.user,
          emailVerificationToken: scoped.emailVerificationToken,
        });
      })) as never);

    return rotationRace(
      () => issued,
      () => {
        vi.restoreAllMocks();
      },
    );
  }

  it("does not delete a link issued between the stale read and the cheap cleanup", async () => {
    const user = await localUser("reset-cleanup-race");
    await forgot(user.email).expect(202);
    const stale = tokenFromLastEmail(sender);
    await prisma.passwordResetToken.update({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const rotation = rotateOnNextStaleRead(user.id);
    try {
      await reset(stale, newPassword).expect(401);
    } finally {
      rotation.restore();
    }

    // The cleanup acted on a row that had already become somebody else's: deleting by id alone
    // would have thrown away the link the user was just emailed.
    const survivor = await prisma.passwordResetToken.findUnique({
      where: { userId: user.id },
    });
    expect(survivor).not.toBeNull();
    expect(survivor?.tokenHash).toBe(hashPasswordResetToken(rotation.token()));

    // And the new link is not merely present, it still works.
    await reset(rotation.token(), newPassword).expect(200);
    await login(user.email, newPassword).expect(200);
    await login(user.email, oldPassword).expect(401);
  });

  it("does not delete a link issued between the stale read and the transactional cleanup", async () => {
    const user = await localUser("reset-cleanup-race-tx");
    await forgot(user.email).expect(202);
    const stale = tokenFromLastEmail(sender);

    // The token is still valid, so the cheap guard admits it; it expires during the hash, which
    // is the only way the transaction's own expired branch is ever reached.
    const argon2id = passwords.hash.bind(passwords);
    vi.spyOn(passwords, "hash").mockImplementation(async (password: string) => {
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      return argon2id(password);
    });
    const rotation = rotateStaleReadInsideTheTransaction(user.id);

    try {
      await reset(stale, newPassword).expect(401);
    } finally {
      rotation.restore();
    }

    // A transaction is not a lock: at READ COMMITTED the delete would have re-read the row and
    // removed the freshly issued link.
    const survivor = await prisma.passwordResetToken.findUnique({
      where: { userId: user.id },
    });
    expect(survivor).not.toBeNull();
    expect(survivor?.tokenHash).toBe(hashPasswordResetToken(rotation.token()));

    await reset(rotation.token(), newPassword).expect(200);
    await login(user.email, newPassword).expect(200);
  });

  it("defers to the transaction when the token is consumed while the hash is in flight", async () => {
    const user = await localUser("reset-advisory");
    await forgot(user.email).expect(202);
    const token = tokenFromLastEmail(sender);

    const argon2id = passwords.hash.bind(passwords);
    vi.spyOn(passwords, "hash").mockImplementation(async (password: string) => {
      // The window the cheap pre-check cannot close: between "a redeemable token exists" and the
      // transaction, a concurrent redemption takes it. Reproduced deterministically here, because
      // a real race cannot be asked to happen on demand.
      await prisma.passwordResetToken.deleteMany({ where: { userId: user.id } });
      return argon2id(password);
    });

    await reset(token, newPassword).expect(401);

    // The pre-check's "yes" never became an authorization: nothing was written.
    await login(user.email, oldPassword).expect(200);
    await login(user.email, newPassword).expect(401);
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

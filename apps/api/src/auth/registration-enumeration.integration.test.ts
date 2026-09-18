import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import { RATE_LIMIT_HEADERS } from "@intrinsic/contracts";
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
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { EMAIL_SENDER, type EmailMessage } from "../email/email-sender";
import { InMemoryEmailSender } from "../email/in-memory-email-sender";
import { INVALID_CREDENTIALS_MESSAGE } from "./auth.service";
import { AUTH_LOGGER } from "./auth.tokens";
import { BackgroundEmailDispatcher } from "./background-email-dispatcher";
import { hashVerificationToken } from "./email-verification.service";
import { PasswordService } from "./password.service";
import {
  isRegistrationEmailCoolingDown,
  REGISTRATION_EMAIL_COOLDOWN_SECONDS,
} from "./registration.service";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();
// Compiling `AppModule` installs the real rate limiter. Loopback makes every request in this
// file one caller, so its counters get their own namespace and a burst-sized allowance;
// enforcement itself stays on.
useIsolatedRateLimits();

const WEB_BASE_URL = "http://web.example.test";
const ACTIVATION_SUBJECT = "Finish creating your FactorSage account";
const NOTICE_SUBJECT = "You already have a FactorSage account";

/** Captures everything the auth component logs so leak assertions are possible. */
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

/** The plaintext token inside a captured activation link, parsed in memory and never printed. */
function activationToken(message: EmailMessage | undefined): string {
  const match = /\/verify-email\?token=([^\s"<]+)/.exec(message?.text ?? "");
  expect(match?.[1]).toBeTruthy();
  return decodeURIComponent(match?.[1] ?? "");
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers["set-cookie"];
  return Array.isArray(raw)
    ? (raw as string[])
    : typeof raw === "string"
      ? [raw]
      : [];
}

function sessionCookie(response: {
  headers: Record<string, unknown>;
}): string | undefined {
  const header = setCookies(response).find((value) =>
    value.startsWith("test_auth="),
  );
  const value = header?.split(";", 1)[0]?.slice("test_auth=".length);
  return value ? decodeURIComponent(value) : undefined;
}

/**
 * AUTH-003: registration must not reveal whether an account exists, must never establish a
 * password, and must not be an unlimited way to mail — or rotate the link of — somebody else's
 * address. Every message in this file is captured by `InMemoryEmailSender`; nothing is delivered.
 */
describe("email-first registration does not enumerate accounts (AUTH-003)", () => {
  const suffix = randomUUID();
  const ownerPassword = "Mailbox-owner-password-42";
  const emails: string[] = [];

  function uniqueEmail(prefix: string, domain = "example.test"): string {
    const email = `${prefix}-${suffix}-${emails.length}@${domain}`;
    emails.push(email);
    return email;
  }

  let app: INestApplication;
  let prisma: PrismaService;
  let passwords: PasswordService;
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
    // Bound to loopback explicitly. Left unlistened, supertest binds a wildcard ephemeral port per
    // request, and on macOS that port can coincide with one another process holds on 127.0.0.1 —
    // the request then reaches that process instead (seen: an editor helper answering 404, or
    // never answering). A specific loopback bind can never be handed an occupied port.
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);
    passwords = moduleRef.get(PasswordService);
    dispatcher = moduleRef.get(BackgroundEmailDispatcher);
    // The fake is what the application actually resolved, not merely what this file constructed.
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

  function register(email: unknown, extra: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post("/auth/register")
      .send({ email, ...extra });
  }

  function resend(email: string) {
    return request(app.getHttpServer())
      .post("/auth/resend-verification")
      .send({ email });
  }

  function verify(token: string, password = ownerPassword) {
    return request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token, password });
  }

  function login(email: string, password = ownerPassword) {
    return request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password });
  }

  function me(sessionToken: string) {
    return request(app.getHttpServer())
      .get("/auth/me")
      .set("Cookie", `test_auth=${sessionToken}`);
  }

  async function signIn(email: string, password = ownerPassword) {
    const token = sessionCookie(await login(email, password).expect(200));
    expect(token).toBeTruthy();
    return token ?? "";
  }

  /** Messages the request would have caused, once the out-of-band work has settled. */
  async function sent(): Promise<EmailMessage[]> {
    await dispatcher.drain();
    return [...sender.messages];
  }

  async function expireRegistrationCooldown(email: string): Promise<void> {
    await prisma.user.update({
      where: { email },
      data: {
        registrationEmailClaimedAt: new Date(
          Date.now() - (REGISTRATION_EMAIL_COOLDOWN_SECONDS + 1) * 1000,
        ),
      },
    });
  }

  async function verifiedPasswordAccount(prefix: string) {
    const email = uniqueEmail(prefix);
    return prisma.user.create({
      data: {
        email,
        passwordHash: await passwords.hash(ownerPassword),
        emailVerifiedAt: new Date(),
      },
    });
  }

  async function googleOnlyAccount(prefix: string) {
    return prisma.user.create({
      data: {
        email: uniqueEmail(prefix, "google.example.test"),
        emailVerifiedAt: new Date(),
        oauthAccounts: {
          create: {
            provider: OAuthProvider.GOOGLE,
            providerAccountId: `google-${randomUUID()}`,
          },
        },
      },
    });
  }

  async function linkedAccount(prefix: string) {
    return prisma.user.create({
      data: {
        email: uniqueEmail(prefix, "google.example.test"),
        passwordHash: await passwords.hash(ownerPassword),
        emailVerifiedAt: new Date(),
        oauthAccounts: {
          create: {
            provider: OAuthProvider.GOOGLE,
            providerAccountId: `google-${randomUUID()}`,
          },
        },
      },
    });
  }

  /** A pending account with a delivered, still-valid activation link, outside the cooldown. */
  async function pendingAccount(prefix: string) {
    const email = uniqueEmail(prefix);
    await register(email).expect(202);
    const [message] = await sent();
    sender.reset();
    await expireRegistrationCooldown(email);
    return { email, token: activationToken(message) };
  }

  /** Everything registration must never change on an existing account. */
  async function protectedState(email: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { oauthAccounts: true, resetTokens: true },
    });
    return {
      id: user.id,
      email: user.email,
      passwordHash: user.passwordHash,
      emailVerifiedAt: user.emailVerifiedAt,
      sessionVersion: user.sessionVersion,
      role: user.role,
      plan: user.plan,
      stripeCustomerId: user.stripeCustomerId,
      oauthAccounts: user.oauthAccounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        providerAccountId: account.providerAccountId,
      })),
      resetTokenHashes: user.resetTokens.map((token) => token.tokenHash),
    };
  }

  /** The parts of a response a caller could compare between two addresses. */
  function observable(response: {
    status: number;
    body: unknown;
    headers: Record<string, unknown>;
  }) {
    const headers = response.headers as Record<string, string | undefined>;
    return {
      status: response.status,
      body: response.body,
      contentType: headers["content-type"],
      cookies: setCookies(response),
      // Every header name, minus the ones that differ per request whatever the address.
      headerNames: Object.keys(headers)
        .filter(
          (name) =>
            ![
              "date",
              "etag",
              "content-length",
              RATE_LIMIT_HEADERS.remaining.toLowerCase(),
              RATE_LIMIT_HEADERS.reset.toLowerCase(),
            ].includes(name),
        )
        .sort(),
      rateLimitPolicy: headers[RATE_LIMIT_HEADERS.policy.toLowerCase()],
      rateLimitLimit: headers[RATE_LIMIT_HEADERS.limit.toLowerCase()],
    };
  }

  describe("the public response", () => {
    it("is identical for new, pending, verified, Google-only, linked and cooling-down addresses", async () => {
      const pending = await pendingAccount("matrix-pending");
      const verified = await verifiedPasswordAccount("matrix-verified");
      const google = await googleOnlyAccount("matrix-google");
      const linked = await linkedAccount("matrix-linked");
      const coolingDown = uniqueEmail("matrix-cooldown");
      await register(coolingDown).expect(202);
      await sent();
      sender.reset();

      const cases = {
        new: uniqueEmail("matrix-new"),
        pending: pending.email,
        verifiedPassword: verified.email,
        googleOnly: google.email,
        passwordAndGoogle: linked.email,
        coolingDown,
      };

      const responses: Record<string, ReturnType<typeof observable>> = {};
      for (const [name, email] of Object.entries(cases)) {
        responses[name] = observable(await register(email));
      }

      const reference = responses.new;
      expect(reference?.status).toBe(202);
      expect(reference?.body).toEqual({ status: "accepted" });
      expect(reference?.cookies).toEqual([]);
      expect(reference?.contentType).toMatch(/^application\/json/);
      for (const [name, response] of Object.entries(responses)) {
        expect({ name, ...response }).toEqual({ name, ...reference });
      }

      // What went out differs by state — and none of it is visible above.
      const messages = await sent();
      const byRecipient = (email: string) =>
        messages.filter((message) => message.to === email);
      expect(byRecipient(cases.new).map((m) => m.subject)).toEqual([
        ACTIVATION_SUBJECT,
      ]);
      expect(byRecipient(cases.pending).map((m) => m.subject)).toEqual([
        ACTIVATION_SUBJECT,
      ]);
      for (const email of [
        cases.verifiedPassword,
        cases.googleOnly,
        cases.passwordAndGoogle,
      ]) {
        expect(byRecipient(email).map((m) => m.subject)).toEqual([
          NOTICE_SUBJECT,
        ]);
      }
      expect(byRecipient(coolingDown)).toEqual([]);
      expect(messages).toHaveLength(5);
    });

    it("answers a request carrying a password, a role or a plan exactly like one that does not", async () => {
      const plain = observable(await register(uniqueEmail("extra-plain")));
      const withExtras = observable(
        await register(uniqueEmail("extra-fields"), {
          password: "Somebody-elses-password-42",
          role: "ADMIN",
          plan: "PRO",
        }),
      );

      expect(withExtras).toEqual(plain);
      const [created] = await prisma.user.findMany({
        where: { email: emails.at(-1) },
      });
      expect(created?.passwordHash).toBeNull();
      expect(created?.role).toBe("USER");
      expect(created?.plan).toBe("FREE");
    });

    it("still refuses a malformed address with 400 and writes nothing", async () => {
      const response = await register("not-an-address").expect(400);
      expect(setCookies(response)).toEqual([]);
      expect(await sent()).toEqual([]);
    });
  });

  describe("existing accounts are never modified", () => {
    it.each([
      ["a verified password account", verifiedPasswordAccount],
      ["a Google-only account", googleOnlyAccount],
      ["a password and Google account", linkedAccount],
    ])(
      "leaves %s, its sessions and its reset link untouched",
      async (_label, create) => {
        const account = await create("untouched");
        // A live session and an outstanding reset link, both of which must survive.
        const session = account.passwordHash
          ? await signIn(account.email)
          : null;
        if (account.passwordHash) {
          await request(app.getHttpServer())
            .post("/auth/forgot-password")
            .send({ email: account.email })
            .expect(202);
        }
        sender.reset();
        const usersBefore = await prisma.user.count();
        const before = await protectedState(account.email);

        await register(account.email, {
          password: "Takeover-attempt-42",
        }).expect(202);
        await register(account.email.toUpperCase()).expect(202);
        const messages = await sent();

        expect(await protectedState(account.email)).toEqual(before);
        expect(await prisma.user.count()).toBe(usersBefore);
        expect(
          await prisma.emailVerificationToken.count({
            where: { userId: account.id },
          }),
        ).toBe(0);
        if (session) {
          await me(session).expect(200);
        }
        await login(account.email, "Takeover-attempt-42").expect(401);

        // One neutral notice — no token, no link that changes anything — and the second request was
        // inside the cooldown.
        expect(messages).toHaveLength(1);
        const [notice] = messages;
        expect(notice?.to).toBe(account.email);
        expect(notice?.subject).toBe(NOTICE_SUBJECT);
        expect(notice?.text).not.toContain("token=");
        expect(notice?.html).not.toContain("token=");
        expect(notice?.text).toContain(`${WEB_BASE_URL}/login`);
        expect(notice?.text).not.toContain("Takeover-attempt-42");
        if (account.passwordHash) {
          expect(notice?.text).toContain(`${WEB_BASE_URL}/forgot-password`);
        } else {
          expect(notice?.text).not.toContain("forgot-password");
          expect(notice?.text).toContain("Google");
        }
      },
    );

    it("never converts a Google-only account into a password account", async () => {
      const account = await googleOnlyAccount("google-no-password");

      await register(account.email, { password: ownerPassword }).expect(202);
      await sent();

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: account.id },
      });
      expect(after.passwordHash).toBeNull();
      await login(account.email).expect(401);
      // Recovery still treats it as Google-only: no reset link is minted.
      sender.reset();
      await request(app.getHttpServer())
        .post("/auth/forgot-password")
        .send({ email: account.email })
        .expect(202);
      expect(await sent()).toEqual([]);
    });
  });

  describe("a new address", () => {
    it("creates one pending account without a password and mails one activation link", async () => {
      const email = uniqueEmail("new");

      const response = await register(`  ${email.toUpperCase()} `).expect(202);

      expect(sessionCookie(response)).toBeUndefined();
      const users = await prisma.user.findMany({ where: { email } });
      expect(users).toHaveLength(1);
      const [user] = users;
      expect(user?.passwordHash).toBeNull();
      expect(user?.emailVerifiedAt).toBeNull();
      expect(user?.sessionVersion).toBe(0);

      const messages = await sent();
      expect(messages).toHaveLength(1);
      const [message] = messages;
      expect(message?.to).toBe(email);
      expect(message?.subject).toBe(ACTIVATION_SUBJECT);

      // The link is on the web origin, on the verification page, and carries only the token.
      const link = /(\S+\/verify-email\?\S+)/.exec(message?.text ?? "")?.[1];
      const url = new URL(link ?? "");
      expect(url.origin).toBe(WEB_BASE_URL);
      expect(url.pathname).toBe("/verify-email");
      expect([...url.searchParams.keys()]).toEqual(["token"]);
      const token = activationToken(message);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = await prisma.emailVerificationToken.findUniqueOrThrow({
        where: { userId: user?.id },
      });
      expect(stored.tokenHash).toBe(hashVerificationToken(token));
      expect(message?.text).not.toMatch(/password=/i);

      // Nothing is usable until the link holder chooses a password.
      await login(email).expect(401);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { email } }))
          .emailVerifiedAt,
      ).toBeNull();

      await verify(token).expect(200);
      const session = await signIn(email);
      const current = await me(session).expect(200);
      expect(current.body).toMatchObject({ id: user?.id, email });
    });

    it("does not delay the response on the mail transport", async () => {
      const email = uniqueEmail("held-send");
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const send = vi
        .spyOn(sender, "send")
        .mockImplementation(async (message) => {
          await held;
          sender.messages.push(message);
        });

      // The transport has not answered, yet the request completes.
      await register(email).expect(202);
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      expect(sender.messages).toHaveLength(0);

      release();
      const messages = await sent();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.to).toBe(email);
    });
  });

  describe("a pending account", () => {
    it("lets the mailbox owner get a fresh link and never activates an old registration password", async () => {
      const email = uniqueEmail("legacy-pending");
      // A row exactly as registration left it before AUTH-003: somebody's password on it.
      const legacy = await prisma.user.create({
        data: {
          email,
          passwordHash: await passwords.hash("Stranger-password-42"),
        },
      });
      await login(email, "Stranger-password-42").expect(401);

      await register(email).expect(202);
      const messages = await sent();

      expect(await prisma.user.count({ where: { email } })).toBe(1);
      const after = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(after.id).toBe(legacy.id);
      // The inert hash is gone the moment the owner asked for a new link.
      expect(after.passwordHash).toBeNull();
      expect(after.emailVerifiedAt).toBeNull();
      expect(messages).toHaveLength(1);

      await verify(activationToken(messages[0])).expect(200);
      await login(email, "Stranger-password-42").expect(401);
      await signIn(email);
    });

    it("does not rotate or invalidate the delivered link inside the cooldown", async () => {
      const email = uniqueEmail("cooldown-keeps-link");
      await register(email).expect(202);
      const [first] = await sent();
      const token = activationToken(first);
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
      const tokenBefore = await prisma.emailVerificationToken.findUniqueOrThrow(
        { where: { userId: id } },
      );
      sender.reset();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await register(email).expect(202);
        await resend(email).expect(202);
      }

      expect(await sent()).toEqual([]);
      expect(
        await prisma.emailVerificationToken.findUniqueOrThrow({
          where: { userId: id },
        }),
      ).toEqual(tokenBefore);
      await verify(token).expect(200);
    });

    it("rotates the link once the cooldown has passed, and the new link is the one that works", async () => {
      const { email, token: first } = await pendingAccount("rotate-after");

      await register(email).expect(202);
      const messages = await sent();

      expect(messages).toHaveLength(1);
      const second = activationToken(messages[0]);
      expect(second).not.toBe(first);
      await verify(first).expect(401);
      await verify(second).expect(200);
    });
  });

  describe("the per-address cooldown", () => {
    it("applies to every account state alike", async () => {
      const { email: pending } = await pendingAccount("cooldown-pending");
      const verified = await verifiedPasswordAccount("cooldown-verified");
      const google = await googleOnlyAccount("cooldown-google");
      const fresh = uniqueEmail("cooldown-new");

      for (const email of [pending, verified.email, google.email, fresh]) {
        await register(email).expect(202);
      }
      expect(await sent()).toHaveLength(4);
      sender.reset();

      for (const email of [pending, verified.email, google.email, fresh]) {
        await register(email).expect(202);
      }
      expect(await sent()).toEqual([]);
    });

    it("cannot be bypassed by case or whitespace, and does not spill over to other addresses", async () => {
      const email = uniqueEmail("cooldown-normalized");
      const neighbour = uniqueEmail("cooldown-neighbour");
      await register(email).expect(202);
      expect(await sent()).toHaveLength(1);
      sender.reset();

      await register(email.toUpperCase()).expect(202);
      await register(`   ${email}\t`).expect(202);
      await resend(` ${email.toUpperCase()} `).expect(202);
      await register(neighbour).expect(202);

      const messages = await sent();
      expect(messages.map((message) => message.to)).toEqual([neighbour]);
    });

    it("opens again once the window has passed", async () => {
      const email = uniqueEmail("cooldown-reopens");
      await register(email).expect(202);
      await sent();
      sender.reset();
      await register(email).expect(202);
      expect(await sent()).toEqual([]);

      await expireRegistrationCooldown(email);
      await register(email).expect(202);
      expect(await sent()).toHaveLength(1);
    });

    it("is decided against the stored claim, not the wall clock of a later read", () => {
      const now = new Date("2026-09-18T12:00:00.000Z");
      const window = REGISTRATION_EMAIL_COOLDOWN_SECONDS * 1000;
      expect(isRegistrationEmailCoolingDown(null, now)).toBe(false);
      expect(
        isRegistrationEmailCoolingDown(new Date(now.getTime() - 1), now),
      ).toBe(true);
      expect(
        isRegistrationEmailCoolingDown(
          new Date(now.getTime() - window + 1),
          now,
        ),
      ).toBe(true);
      expect(
        isRegistrationEmailCoolingDown(new Date(now.getTime() - window), now),
      ).toBe(false);
    });

    it("is shared by resend, which never mails a verified or unknown address", async () => {
      const verified = await verifiedPasswordAccount("resend-verified");
      const unknown = uniqueEmail("resend-unknown");
      const { email: pending } = await pendingAccount("resend-pending");

      const responses = [
        await resend(verified.email),
        await resend(unknown),
        await resend(pending),
      ].map(observable);
      for (const response of responses) {
        expect(response).toEqual(responses[0]);
      }
      expect(responses[0]?.status).toBe(202);

      const messages = await sent();
      expect(messages.map((message) => message.to)).toEqual([pending]);
      expect(
        await prisma.user.findUnique({ where: { email: unknown } }),
      ).toBeNull();

      // The resend took the claim, so registering the same address now sends nothing.
      sender.reset();
      await register(pending).expect(202);
      expect(await sent()).toEqual([]);
    });
  });

  describe("simulated mail-provider failure", () => {
    it("answers identically, gives the claim back, and a retry after recovery delivers a working link", async () => {
      const email = uniqueEmail("provider-failure");
      const healthy = observable(await register(uniqueEmail("provider-ok")));
      await sent();
      sender.reset();

      sender.failWith = new Error("simulated provider outage");
      const failing = observable(await register(email));
      await dispatcher.drain();

      expect(failing).toEqual(healthy);
      expect(sender.messages).toEqual([]);
      const stranded = await prisma.user.findUniqueOrThrow({
        where: { email },
      });
      expect(stranded.emailVerifiedAt).toBeNull();
      expect(stranded.registrationEmailClaimedAt).toBeNull();

      // The provider recovers; the owner simply asks again, with no cooldown to wait out.
      sender.failWith = null;
      await register(email).expect(202);
      const messages = await sent();
      expect(messages).toHaveLength(1);
      expect(messages[0]?.to).toBe(email);

      await verify(activationToken(messages[0])).expect(200);
      await signIn(email);
    });

    it("gives a pending account's claim back too, so its owner can retry at once", async () => {
      const { email } = await pendingAccount("provider-failure-pending");
      const { registrationEmailClaimedAt: previous } =
        await prisma.user.findUniqueOrThrow({ where: { email } });

      sender.failWith = new Error("simulated provider outage");
      await register(email).expect(202);
      await dispatcher.drain();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { email } }))
          .registrationEmailClaimedAt,
      ).toEqual(previous);

      sender.failWith = null;
      await resend(email).expect(202);
      const messages = await sent();
      expect(messages).toHaveLength(1);
      await verify(activationToken(messages[0])).expect(200);
    });

    it("gives a verified account's notice claim back", async () => {
      const account = await verifiedPasswordAccount("provider-failure-notice");
      sender.failWith = new Error("simulated provider outage");
      await register(account.email).expect(202);
      await dispatcher.drain();
      const before = await protectedState(account.email);

      sender.failWith = null;
      await register(account.email).expect(202);
      const messages = await sent();
      expect(messages.map((message) => message.subject)).toEqual([
        NOTICE_SUBJECT,
      ]);
      expect(await protectedState(account.email)).toEqual(before);
    });
  });

  describe("concurrency", () => {
    it("creates exactly one account and sends exactly one link for simultaneous registrations", async () => {
      for (let round = 0; round < 5; round += 1) {
        const email = uniqueEmail(`race-new-${round}`);
        const variants = [
          email,
          email.toUpperCase(),
          `  ${email}  `,
          email,
          ` ${email.toUpperCase()}`,
          email,
        ];

        const responses = await Promise.all(variants.map((v) => register(v)));

        const shapes = responses.map(observable);
        for (const shape of shapes) {
          expect(shape).toEqual(shapes[0]);
        }
        expect(shapes[0]?.status).toBe(202);
        const users = await prisma.user.findMany({ where: { email } });
        expect(users).toHaveLength(1);
        expect(users[0]?.passwordHash).toBeNull();

        const messages = await sent();
        expect(messages).toHaveLength(1);
        const token = activationToken(messages[0]);
        const stored = await prisma.emailVerificationToken.findMany({
          where: { userId: users[0]?.id },
        });
        expect(stored.map((row) => row.tokenHash)).toEqual([
          hashVerificationToken(token),
        ]);
        sender.reset();
      }
    });

    it("sends one link for simultaneous requests on a pending account", async () => {
      for (let round = 0; round < 5; round += 1) {
        const { email, token: previous } = await pendingAccount(
          `race-pending-${round}`,
        );

        await Promise.all([
          register(email),
          resend(email),
          register(email.toUpperCase()),
          resend(email),
        ]);

        const messages = await sent();
        expect(messages).toHaveLength(1);
        await verify(previous).expect(401);
        await verify(activationToken(messages[0])).expect(200);
        sender.reset();
      }
    });

    it("never leaves a verified account with a live link, or the owner without a working one, when registration races verification", async () => {
      for (let round = 0; round < 6; round += 1) {
        const { email, token } = await pendingAccount(`race-verify-${round}`);

        const [registered, verified] = await Promise.all([
          register(email),
          verify(token),
        ]);
        const messages = await sent();

        expect(registered.status).toBe(202);
        expect([200, 401]).toContain(verified.status);
        const user = await prisma.user.findUniqueOrThrow({
          where: { email },
          include: { verificationTokens: true },
        });
        expect(await prisma.user.count({ where: { email } })).toBe(1);

        if (verified.status === 200) {
          // The owner's redemption won: their password is the account's, and no verification
          // token survives on the verified account (withdrawn, or never issued).
          expect(user.emailVerifiedAt).not.toBeNull();
          expect(user.sessionVersion).toBe(1);
          expect(user.verificationTokens).toEqual([]);
          expect(await passwords.verify(user.passwordHash, ownerPassword)).toBe(
            true,
          );
          await signIn(email);
        } else {
          // Registration rotated the link first: the account is still pending and the owner holds
          // the one live link, freshly mailed.
          expect(user.emailVerifiedAt).toBeNull();
          expect(messages).toHaveLength(1);
          const fresh = activationToken(messages[0]);
          expect(user.verificationTokens.map((row) => row.tokenHash)).toEqual([
            hashVerificationToken(fresh),
          ]);
          await verify(fresh).expect(200);
          await signIn(email);
        }
        sender.reset();
      }
    });
  });

  describe("login and recovery stay non-enumerating", () => {
    it("answers a pending account's login exactly like an unknown address", async () => {
      const { email } = await pendingAccount("login-pending");

      const pending = await login(email, "Any-password-at-all-42").expect(401);
      const unknown = await login(
        uniqueEmail("login-unknown"),
        "Any-password-at-all-42",
      ).expect(401);

      expect(pending.body).toEqual(unknown.body);
      expect(pending.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
      expect(sessionCookie(pending)).toBeUndefined();
    });

    it("answers forgot-password for a pending account like any other address, and mints nothing", async () => {
      const { email } = await pendingAccount("recovery-pending");
      const unknown = observable(
        await request(app.getHttpServer())
          .post("/auth/forgot-password")
          .send({ email: uniqueEmail("recovery-unknown") }),
      );
      const pending = observable(
        await request(app.getHttpServer())
          .post("/auth/forgot-password")
          .send({ email }),
      );

      expect(pending).toEqual(unknown);
      expect(await sent()).toEqual([]);
      expect(
        await prisma.passwordResetToken.count({
          where: { user: { email } },
        }),
      ).toBe(0);
    });
  });

  it("never logs an address, a token, a token hash or a password", async () => {
    const fresh = uniqueEmail("logs-new");
    const verified = await verifiedPasswordAccount("logs-verified");
    await register(fresh, { password: "Logged-password-attempt-42" }).expect(
      202,
    );
    await register(verified.email).expect(202);
    const messages = await sent();
    const token = activationToken(
      messages.find((message) => message.to === fresh),
    );
    sender.failWith = new Error("simulated provider outage");
    await expireRegistrationCooldown(fresh);
    await register(fresh).expect(202);
    await dispatcher.drain();
    const { id } = await prisma.user.findUniqueOrThrow({
      where: { email: fresh },
    });

    const output = logs.output();
    expect(output).toContain("auth.activation.requested");
    expect(output).toContain('"outcome":"account_created"');
    expect(output).toContain('"outcome":"notice_claimed"');
    expect(output).toContain("auth.email.verification.send.failed");
    // The internal id is the correlation key; the address never is.
    expect(output).toContain(id);
    for (const secret of [
      fresh,
      verified.email,
      token,
      hashVerificationToken(token),
      "Logged-password-attempt-42",
      ownerPassword,
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/\$argon2id\$/);
  });
});

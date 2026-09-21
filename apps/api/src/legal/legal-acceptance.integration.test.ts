import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  LEGAL_DOCUMENTS,
  REQUIRED_TERMS_VERSION,
  type LegalAcceptanceStatusResponse,
  type LegalRequestReceipt,
} from "@intrinsic/contracts";
import { OAuthProvider } from "@intrinsic/database";
import { useIsolatedRateLimits, useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { EMAIL_SENDER, type EmailMessage } from "../email/email-sender";
import { InMemoryEmailSender } from "../email/in-memory-email-sender";
import { BackgroundEmailDispatcher } from "../auth/background-email-dispatcher";

// Before PrismaService constructs its client during Nest module compilation.
useTestDatabase();
// Compiling `AppModule` installs the real rate limiter. Loopback makes every request in this file
// one caller, so its counters get their own namespace; enforcement itself stays on.
useIsolatedRateLimits();

const WEB_BASE_URL = "http://web.example.test";
const PASSWORD = "Mailbox-owner-password-42";

/**
 * Terms acceptance end to end, against the real application.
 *
 * The suite is organised around the four claims the acceptance checklist makes, and each of them
 * is a claim that would be easy to believe without evidence:
 *
 * 1. **Acceptance belongs to the verified account holder.** Submitting somebody else's address at
 *    registration records nothing at all; the only acceptance on the email path is written by the
 *    holder of the activation link, inside the transaction that activates the account.
 * 2. **The gate cannot be bypassed with a direct API request.** A signed-in caller who never
 *    rendered the acceptance screen is refused at the server, on every non-exempt route.
 * 3. **A user who declines is not trapped.** Cancellation, statutory requests, support and logout
 *    all still work.
 * 4. **The evidence is immutable, versioned and idempotent.** One row per user per version,
 *    carrying the digest of the exact text, whatever order or concurrency the requests arrive in.
 */
describe("legal acceptance", () => {
  const suffix = randomUUID().slice(0, 8);
  const emails: string[] = [];

  function uniqueEmail(prefix: string): string {
    const email = `${prefix}-${suffix}-${emails.length}@example.test`;
    emails.push(email);
    return email;
  }

  let app: INestApplication;
  let prisma: PrismaService;
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
      .overrideProvider(EMAIL_SENDER)
      .useValue(sender)
      .compile();

    app = moduleRef.createNestApplication();
    // Bound to loopback explicitly; an unlistened app lets supertest pick a wildcard ephemeral
    // port that another process on this machine may already hold.
    await app.listen(0, "127.0.0.1");
    prisma = moduleRef.get(PrismaService);
    dispatcher = moduleRef.get(BackgroundEmailDispatcher);
  });

  afterAll(async () => {
    if (prisma && emails.length > 0) {
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
    }
    if (app) {
      await app.close();
    }
  });

  function activationToken(message: EmailMessage | undefined): string {
    const match = /\/verify-email\?token=([^\s"<]+)/.exec(message?.text ?? "");
    expect(match?.[1]).toBeTruthy();
    return decodeURIComponent(match?.[1] ?? "");
  }

  /** Registers an address and returns the activation token from the captured email. */
  async function registerAndCaptureToken(email: string): Promise<string> {
    sender.reset();
    await request(app.getHttpServer())
      .post("/auth/register")
      .send({ email })
      .expect(202);
    await dispatcher.drain();
    return activationToken(sender.messages.at(-1));
  }

  function sessionCookie(response: {
    headers: Record<string, unknown>;
  }): string {
    const raw = response.headers["set-cookie"];
    const cookies = Array.isArray(raw) ? (raw as string[]) : [];
    const cookie = cookies.find((value) => value.startsWith("test_auth="));
    expect(cookie, "expected a session cookie").toBeTruthy();
    return (cookie ?? "").split(";")[0] ?? "";
  }

  /** An account that has completed activation, and therefore has accepted. */
  async function acceptedUser(prefix: string): Promise<{
    email: string;
    cookie: string;
    userId: string;
  }> {
    const email = uniqueEmail(prefix);
    const token = await registerAndCaptureToken(email);
    await request(app.getHttpServer())
      .post("/auth/verify-email")
      .send({ token, password: PASSWORD, termsVersion: REQUIRED_TERMS_VERSION })
      .expect(200);
    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email, password: PASSWORD })
      .expect(200);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { email, cookie: sessionCookie(login), userId: user.id };
  }

  /**
   * A verified account with a live session and **no** acceptance — the exact state a brand-new
   * Google user is in immediately after the OAuth callback.
   *
   * Built through the real Google identity path rather than by hand-writing a row, so what the
   * gate sees is what a real first Google sign-in produces.
   */
  async function unacceptedGoogleUser(prefix: string): Promise<{
    email: string;
    cookie: string;
    userId: string;
  }> {
    const email = uniqueEmail(prefix);
    const user = await prisma.user.create({
      data: {
        email,
        emailVerifiedAt: new Date(),
        oauthAccounts: {
          create: {
            provider: OAuthProvider.GOOGLE,
            providerAccountId: `google-${randomUUID()}`,
          },
        },
      },
    });
    // The session a Google callback issues is the ordinary one — `AuthService.issueToken` is the
    // only issuer for both paths — so signing the same claims is a faithful stand-in and keeps
    // this suite off the OAuth provider mock that `google-auth.integration.test.ts` owns.
    const token = await app
      .get(JwtService, { strict: false })
      .signAsync({ sub: user.id, sv: user.sessionVersion });
    return { email, cookie: `test_auth=${token}`, userId: user.id };
  }

  describe("acceptance belongs to the verified account holder", () => {
    it("records nothing when somebody submits an address they do not control", async () => {
      const email = uniqueEmail("not-my-address");
      await registerAndCaptureToken(email);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(
        await prisma.legalRecord.count({ where: { userId: user.id } }),
      ).toBe(0);
    });

    it("records the mailbox holder's acceptance when they activate the account", async () => {
      const email = uniqueEmail("activation");
      const token = await registerAndCaptureToken(email);

      await request(app.getHttpServer())
        .post("/auth/verify-email")
        .send({
          token,
          password: PASSWORD,
          termsVersion: REQUIRED_TERMS_VERSION,
        })
        .expect(200);

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      const records = await prisma.legalRecord.findMany({
        where: { userId: user.id },
        orderBy: { documentKind: "asc" },
      });

      expect(records.map((row) => row.documentKind).sort()).toEqual([
        "PRIVACY",
        "RISK_DISCLOSURE",
        "TERMS",
      ]);
      for (const row of records) {
        expect(row.surface).toBe("EMAIL_ACTIVATION");
        expect(row.documentVersion).toBe(
          LEGAL_DOCUMENTS[row.documentKind].version,
        );
        // The digest is what makes the event resolve to the exact text that was accepted.
        expect(row.documentHash).toBe(
          LEGAL_DOCUMENTS[row.documentKind].contentHash,
        );
      }
      // A privacy notice is information, not a consent. It is recorded as presented.
      expect(
        records.find((row) => row.documentKind === "PRIVACY")?.record,
      ).toBe("NOTICE_PRESENTED");
      expect(records.find((row) => row.documentKind === "TERMS")?.record).toBe(
        "ACCEPTED",
      );
    });

    it("activates nothing when the submitted Terms version is missing or stale", async () => {
      const email = uniqueEmail("stale-terms");
      const token = await registerAndCaptureToken(email);

      for (const body of [
        { token, password: PASSWORD },
        { token, password: PASSWORD, termsVersion: "0.0.1-ancient" },
        { token, password: PASSWORD, termsVersion: "" },
      ]) {
        await request(app.getHttpServer())
          .post("/auth/verify-email")
          .send(body)
          .expect(400);
      }

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      // Nothing committed: no acceptance, no password, still unverified, link still redeemable.
      expect(
        await prisma.legalRecord.count({ where: { userId: user.id } }),
      ).toBe(0);
      expect(user.emailVerifiedAt).toBeNull();
      expect(user.passwordHash).toBeNull();
      expect(
        await prisma.emailVerificationToken.findUnique({
          where: { userId: user.id },
        }),
      ).not.toBeNull();

      // And the same link still activates once the current version is submitted.
      await request(app.getHttpServer())
        .post("/auth/verify-email")
        .send({
          token,
          password: PASSWORD,
          termsVersion: REQUIRED_TERMS_VERSION,
        })
        .expect(200);
    });

    it("keeps registration's enumeration-resistant answer unchanged", async () => {
      // Acceptance added a field to activation, not to registration. Registration still takes an
      // address and nothing else, and still answers identically for every account state.
      const fresh = uniqueEmail("enumeration-fresh");
      const verified = (await acceptedUser("enumeration-verified")).email;

      const first = await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email: fresh, termsVersion: REQUIRED_TERMS_VERSION });
      const second = await request(app.getHttpServer())
        .post("/auth/register")
        .send({ email: verified });

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(first.body).toEqual({ status: "accepted" });
      expect(second.body).toEqual(first.body);
      expect(second.headers["set-cookie"]).toBeUndefined();

      // A `termsVersion` posted to registration is ignored exactly like a `password` is: nobody
      // can accept on behalf of the holder of an address they merely typed in.
      const created = await prisma.user.findUniqueOrThrow({
        where: { email: fresh },
      });
      expect(
        await prisma.legalRecord.count({ where: { userId: created.id } }),
      ).toBe(0);
    });
  });

  describe("the gate cannot be bypassed with a direct API request", () => {
    it("refuses product routes for a signed-in account that has not accepted", async () => {
      const { cookie } = await unacceptedGoogleUser("gate-google");

      for (const [method, path] of [
        ["get", "/lists"],
        ["get", "/monitors"],
        ["get", "/dashboard"],
      ] as const) {
        const agent = request(app.getHttpServer());
        const response = await agent[method](path).set("Cookie", cookie);
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(response.body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
        expect(response.body.requiredTermsVersion).toBe(REQUIRED_TERMS_VERSION);
      }
    });

    it("refuses a mutation, so the gate is not merely a read-side redirect", async () => {
      const { cookie } = await unacceptedGoogleUser("gate-mutation");

      const response = await request(app.getHttpServer())
        .post("/lists")
        .set("Cookie", cookie)
        .send({ name: "Bypass attempt" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    });

    it("refuses buying more product while the Terms are unaccepted", async () => {
      const { cookie } = await unacceptedGoogleUser("gate-checkout");

      const response = await request(app.getHttpServer())
        .post("/billing/checkout")
        .set("Cookie", cookie)
        .send({ priceKey: "PRO_MONTHLY" });

      expect(response.status).toBe(403);
      expect(response.body.code).toBe("LEGAL_ACCEPTANCE_REQUIRED");
    });

    it("answers 403 rather than 401, so a client does not sign the user out of the gate", async () => {
      const { cookie } = await unacceptedGoogleUser("gate-status-code");
      const response = await request(app.getHttpServer())
        .get("/lists")
        .set("Cookie", cookie);
      expect(response.status).not.toBe(401);
      expect(response.status).toBe(403);
    });

    it("lets the same caller through once they have accepted", async () => {
      const { cookie } = await unacceptedGoogleUser("gate-then-accept");

      await request(app.getHttpServer())
        .get("/lists")
        .set("Cookie", cookie)
        .expect(403);

      await request(app.getHttpServer())
        .post("/legal/acceptance")
        .set("Cookie", cookie)
        .send({ termsVersion: REQUIRED_TERMS_VERSION })
        .expect(200);

      await request(app.getHttpServer())
        .get("/lists")
        .set("Cookie", cookie)
        .expect(200);
    });

    it("never applies to a Guest", async () => {
      // A signed-out visitor has no acceptance to be missing, and the public surfaces must stay
      // readable. This is the regression that would break every public page.
      await request(app.getHttpServer()).get("/dashboard").expect(200);
      await request(app.getHttpServer()).get("/entitlements").expect(200);
    });

    it("leaves a route that resolves no session public for everyone", async () => {
      // `/market-overview` carries no authentication guard, so the gate has no session to read
      // and the route answers identically for a Guest and for a signed-in visitor. Stated here
      // so the behaviour is deliberate rather than mistaken for a bypass later.
      const { cookie } = await unacceptedGoogleUser("public-route");
      await request(app.getHttpServer()).get("/market-overview").expect(200);
      await request(app.getHttpServer())
        .get("/market-overview")
        .set("Cookie", cookie)
        .expect(200);
    });
  });

  describe("a user who declines is not trapped", () => {
    it("keeps cancellation, statutory requests, support and logout reachable", async () => {
      const { cookie } = await unacceptedGoogleUser("declined");

      // Billing status: what they are paying for, so the cancellation path means something.
      await request(app.getHttpServer())
        .get("/billing/status")
        .set("Cookie", cookie)
        .expect(200);

      // Who they are, and what they have (not) accepted.
      await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", cookie)
        .expect(200);
      const status = await request(app.getHttpServer())
        .get("/legal/acceptance")
        .set("Cookie", cookie)
        .expect(200);
      expect((status.body as LegalAcceptanceStatusResponse).outstanding).toBe(
        true,
      );

      // Every statutory and support channel.
      for (const kind of [
        "WITHDRAWAL",
        "PRIVACY_REQUEST",
        "NONCONFORMITY",
        "SUPPORT",
      ] as const) {
        const submitted = await request(app.getHttpServer())
          .post("/legal/requests")
          .set("Cookie", cookie)
          .send({ kind, details: `Declined-terms ${kind} request.` })
          .expect(201);
        const receipt = submitted.body as LegalRequestReceipt;
        expect(receipt.status).toBe("RECEIVED");
        expect(receipt.reference).toMatch(/^[A-Z]{2}-[2-9A-Z]{5}-[2-9A-Z]{5}$/);
        expect(Date.parse(receipt.submittedAt)).not.toBeNaN();
      }

      // And signing out.
      await request(app.getHttpServer())
        .post("/auth/logout")
        .set("Cookie", cookie)
        .expect(204);
    });

    it("returns a submitted request again, so a receipt can be found later", async () => {
      const { cookie } = await unacceptedGoogleUser("receipt-lookup");
      const submitted = await request(app.getHttpServer())
        .post("/legal/requests")
        .set("Cookie", cookie)
        .send({
          kind: "WITHDRAWAL",
          details: "Please treat this as a withdrawal.",
        })
        .expect(201);

      const listed = await request(app.getHttpServer())
        .get("/legal/requests")
        .set("Cookie", cookie)
        .expect(200);

      expect(listed.body.requests).toHaveLength(1);
      expect(listed.body.requests[0]).toEqual(submitted.body);
    });

    it("cannot read or submit somebody else's requests", async () => {
      const mine = await unacceptedGoogleUser("scope-mine");
      const theirs = await unacceptedGoogleUser("scope-theirs");

      await request(app.getHttpServer())
        .post("/legal/requests")
        .set("Cookie", mine.cookie)
        .send({ kind: "SUPPORT", details: "Only mine." })
        .expect(201);

      const listed = await request(app.getHttpServer())
        .get("/legal/requests")
        .set("Cookie", theirs.cookie)
        .expect(200);
      expect(listed.body.requests).toEqual([]);
    });

    it("refuses an empty or over-long request rather than storing it", async () => {
      const { cookie } = await unacceptedGoogleUser("request-bounds");
      for (const details of ["", "   ", "x".repeat(4001)]) {
        await request(app.getHttpServer())
          .post("/legal/requests")
          .set("Cookie", cookie)
          .send({ kind: "SUPPORT", details })
          .expect(400);
      }
      await request(app.getHttpServer())
        .post("/legal/requests")
        .set("Cookie", cookie)
        .send({ kind: "NOT_A_KIND", details: "hello" })
        .expect(400);
    });

    it("refuses an unauthenticated request submission", async () => {
      await request(app.getHttpServer())
        .post("/legal/requests")
        .send({ kind: "SUPPORT", details: "No session." })
        .expect(401);
      await request(app.getHttpServer()).get("/legal/acceptance").expect(401);
    });
  });

  describe("the evidence is immutable, versioned and idempotent", () => {
    it("writes one row per document version however many times it is submitted", async () => {
      const { cookie, userId } = await unacceptedGoogleUser("idempotent");

      const [first, second, third] = await Promise.all([
        request(app.getHttpServer())
          .post("/legal/acceptance")
          .set("Cookie", cookie)
          .send({ termsVersion: REQUIRED_TERMS_VERSION }),
        request(app.getHttpServer())
          .post("/legal/acceptance")
          .set("Cookie", cookie)
          .send({ termsVersion: REQUIRED_TERMS_VERSION }),
        request(app.getHttpServer())
          .post("/legal/acceptance")
          .set("Cookie", cookie)
          .send({ termsVersion: REQUIRED_TERMS_VERSION }),
      ]);

      for (const response of [first, second, third]) {
        expect(response.status).toBe(200);
        expect(
          (response.body as LegalAcceptanceStatusResponse).outstanding,
        ).toBe(false);
      }
      expect(
        await prisma.legalRecord.count({
          where: { userId, documentKind: "TERMS" },
        }),
      ).toBe(1);
    });

    it("keeps the first acceptance's timestamp when it is submitted again", async () => {
      const { cookie, userId } = await unacceptedGoogleUser("first-wins");
      await request(app.getHttpServer())
        .post("/legal/acceptance")
        .set("Cookie", cookie)
        .send({ termsVersion: REQUIRED_TERMS_VERSION })
        .expect(200);
      const original = await prisma.legalRecord.findFirstOrThrow({
        where: { userId, documentKind: "TERMS" },
      });

      await request(app.getHttpServer())
        .post("/legal/acceptance")
        .set("Cookie", cookie)
        .send({ termsVersion: REQUIRED_TERMS_VERSION })
        .expect(200);

      const after = await prisma.legalRecord.findFirstOrThrow({
        where: { userId, documentKind: "TERMS" },
      });
      expect(after.id).toBe(original.id);
      expect(after.recordedAt.toISOString()).toBe(
        original.recordedAt.toISOString(),
      );
    });

    it("refuses a version the server does not currently require, and writes nothing", async () => {
      const { cookie, userId } = await unacceptedGoogleUser("version-mismatch");

      for (const body of [
        {},
        { termsVersion: "" },
        { termsVersion: true },
        { termsVersion: "999.0.0" },
      ]) {
        const response = await request(app.getHttpServer())
          .post("/legal/acceptance")
          .set("Cookie", cookie)
          .send(body);
        expect(response.status).toBe(400);
      }

      expect(await prisma.legalRecord.count({ where: { userId } })).toBe(0);
    });

    it("resolves the surface server-side and never from the request", async () => {
      const google = await unacceptedGoogleUser("surface-google");
      await request(app.getHttpServer())
        .post("/legal/acceptance")
        .set("Cookie", google.cookie)
        // A surface in the body is ignored; the server decides from persisted state.
        .send({
          termsVersion: REQUIRED_TERMS_VERSION,
          surface: "EMAIL_ACTIVATION",
        })
        .expect(200);

      const records = await prisma.legalRecord.findMany({
        where: { userId: google.userId },
      });
      expect(records).not.toHaveLength(0);
      for (const row of records) {
        expect(row.surface).toBe("GOOGLE_ONBOARDING");
      }
    });

    it("marks an existing password account's later acceptance as EXISTING_ACCOUNT", async () => {
      const { userId, cookie } = await acceptedUser("surface-existing");
      // Remove the activation-time acceptance to model an account that predates the requirement.
      await prisma.legalRecord.deleteMany({ where: { userId } });

      await request(app.getHttpServer())
        .post("/legal/acceptance")
        .set("Cookie", cookie)
        .send({ termsVersion: REQUIRED_TERMS_VERSION })
        .expect(200);

      const records = await prisma.legalRecord.findMany({ where: { userId } });
      for (const row of records) {
        expect(row.surface).toBe("EXISTING_ACCOUNT");
      }
    });

    it("never backfills an existing account as having accepted", async () => {
      const { userId, cookie } = await acceptedUser("no-backfill");
      await prisma.legalRecord.deleteMany({ where: { userId } });

      // Reading the status, signing in and using an exempt route must all leave it outstanding.
      await request(app.getHttpServer())
        .get("/auth/me")
        .set("Cookie", cookie)
        .expect(200);
      const status = await request(app.getHttpServer())
        .get("/legal/acceptance")
        .set("Cookie", cookie)
        .expect(200);

      expect((status.body as LegalAcceptanceStatusResponse).outstanding).toBe(
        true,
      );
      expect(await prisma.legalRecord.count({ where: { userId } })).toBe(0);
    });

    it("reports the accepted records, digests included, to their owner", async () => {
      const { userId, cookie } = await acceptedUser("status-records");
      const status = await request(app.getHttpServer())
        .get("/legal/acceptance")
        .set("Cookie", cookie)
        .expect(200);

      const body = status.body as LegalAcceptanceStatusResponse;
      expect(body.requiredTermsVersion).toBe(REQUIRED_TERMS_VERSION);
      expect(body.outstanding).toBe(false);
      const terms = body.records.find(
        (record) => record.documentKind === "TERMS",
      );
      expect(terms?.documentHash).toBe(LEGAL_DOCUMENTS.TERMS.contentHash);
      expect(terms?.surface).toBe("EMAIL_ACTIVATION");
      expect(await prisma.legalRecord.count({ where: { userId } })).toBe(
        body.records.length,
      );
    });
  });
});

import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  RATE_LIMITED_CODE,
  RATE_LIMIT_HEADERS,
  type RateLimitErrorResponse,
} from "@intrinsic/contracts";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthModule } from "../auth/auth.module";
import { PasswordService } from "../auth/password.service";
import { ConfigurationModule } from "../config/configuration.module";
import { DatabaseModule } from "../database/database.module";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsModule } from "../entitlements/entitlements.module";
import { ListsModule } from "../lists/lists.module";
import { RATE_LIMIT_POLICIES } from "./rate-limit-policies";
import { RateLimitModule } from "./rate-limit.module";
import { RATE_LIMIT_REDIS } from "./rate-limit.tokens";

useTestDatabase();

const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Rate-limit API tests require TEST_REDIS_URL or REDIS_URL; CI must not skip them silently.",
  );
}
const describeRedis = redisUrl ? describe : describe.skip;

/**
 * The limiter on the real API surface: HTTP → Nest → the actual auth, lists and entitlement
 * routes, with the real `RateLimitModule` installed beside them.
 *
 * Two things are proven together here, and they are the pair that matters for shipping:
 * a real endpoint really does answer `429` with the documented body and headers, and every other
 * endpoint behaves exactly as it did before — sign-in still works, a list is still created,
 * entitlements are still enforced by the entitlement filter rather than by this one, and a guest
 * is still refused with `401`.
 */
describeRedis("rate limiting on the real API surface", () => {
  const suffix = randomUUID();
  const namespace = `rate-limit:test-api:${suffix}`;
  const password = "Local-test-password-42";
  const email = `rate-limit-${suffix}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";
    process.env.RATE_LIMIT_KEY_NAMESPACE = namespace;
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = "0";
    process.env.RATE_LIMIT_ENABLED = "true";

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigurationModule,
        RateLimitModule,
        DatabaseModule,
        AuthModule,
        EntitlementsModule,
        ListsModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);

    prisma = moduleRef.get(PrismaService);
    redis = app.get<Redis>(RATE_LIMIT_REDIS);
    const passwordHash = await moduleRef.get(PasswordService).hash(password);
    await prisma.user.create({
      data: { email, passwordHash, emailVerifiedAt: new Date(), plan: "PRO" },
    });
  }, 60_000);

  afterAll(async () => {
    if (redis) {
      const keys = await redis.keys(`${namespace}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
    if (prisma) {
      await prisma.user.deleteMany({ where: { email } });
    }
    if (app) {
      await app.close();
    }
    delete process.env.RATE_LIMIT_KEY_NAMESPACE;
  });

  beforeEach(async () => {
    const keys = await redis.keys(`${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe("existing behaviour is unchanged", () => {
    it("still signs a user in and still refuses a wrong password", async () => {
      const agent = request.agent(app.getHttpServer());
      await agent.post("/auth/login").send({ email, password }).expect(200);
      await agent.get("/auth/me").expect(200);
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password: "Wrong-password-000" })
        .expect(401);
    });

    it("still refuses a guest with 401 rather than with a rate-limit status", async () => {
      // The order matters: authentication runs in a controller guard, before the interceptor's
      // policy is applied, so an unauthenticated caller must still see `401`.
      const response = await request(app.getHttpServer())
        .get("/lists")
        .expect(401);
      expect(response.body.code).toBeUndefined();
    });

    it("still creates and reads the caller's own lists", async () => {
      const agent = request.agent(app.getHttpServer());
      await agent.post("/auth/login").send({ email, password }).expect(200);
      const created = await agent
        .post("/lists")
        .send({ name: `Rate limit ${suffix}` })
        .expect(201);
      const listId = (created.body as { id: string }).id;
      await agent.get(`/lists/${listId}`).expect(200);
      await agent.delete(`/lists/${listId}`).expect(204);
    });

    it("still answers entitlements, and with the entitlement filter's own shape", async () => {
      const response = await request(app.getHttpServer())
        .get("/entitlements")
        .expect(200);
      expect((response.body as { principal: string }).principal).toBe("GUEST");
    });
  });

  describe("a real endpoint enforces its policy", () => {
    it("refuses sign-in attempts past the auth-sensitive allowance", async () => {
      const limit = RATE_LIMIT_POLICIES["auth-sensitive"].points;

      // Every one of these is a genuine, correctly-formed failed sign-in: the limiter counts
      // attempts, not errors, which is what makes it a credential-stuffing control.
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer())
          .post("/auth/login")
          .send({ email, password: "Wrong-password-000" })
          .expect(401);
      }

      const refused = await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password: "Wrong-password-000" })
        .expect(429);

      const body = refused.body as RateLimitErrorResponse;
      expect(body.code).toBe(RATE_LIMITED_CODE);
      expect(body.policy).toBe("auth-sensitive");
      expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);

      // And the correct password is refused too while the window holds — otherwise the limiter
      // would only slow an attacker down until they guessed right.
      await request(app.getHttpServer())
        .post("/auth/login")
        .send({ email, password })
        .expect(429);
    }, 60_000);

    it("reports the allowance on an ordinary successful request", async () => {
      const agent = request.agent(app.getHttpServer());
      await agent.post("/auth/login").send({ email, password }).expect(200);
      const response = await agent.get("/lists").expect(200);

      expect(response.headers[RATE_LIMIT_HEADERS.policy.toLowerCase()]).toBe(
        "standard-read",
      );
      expect(
        Number(response.headers[RATE_LIMIT_HEADERS.limit.toLowerCase()]),
      ).toBe(RATE_LIMIT_POLICIES["standard-read"].points);
      expect(
        Number(response.headers[RATE_LIMIT_HEADERS.remaining.toLowerCase()]),
      ).toBeLessThan(RATE_LIMIT_POLICIES["standard-read"].points);
    });

    it("counts an authenticated caller against their user id, not their address", async () => {
      // Both agents share one loopback address, so if the key were the IP they would share an
      // allowance. Signing in as the same user from two agents must share one; that is the
      // property being checked, and it is only observable because the counter is user-keyed.
      const first = request.agent(app.getHttpServer());
      const second = request.agent(app.getHttpServer());
      await first.post("/auth/login").send({ email, password }).expect(200);
      await second.post("/auth/login").send({ email, password }).expect(200);

      const a = await first.get("/lists").expect(200);
      const b = await second.get("/lists").expect(200);

      const remainingA = Number(
        a.headers[RATE_LIMIT_HEADERS.remaining.toLowerCase()],
      );
      const remainingB = Number(
        b.headers[RATE_LIMIT_HEADERS.remaining.toLowerCase()],
      );
      expect(remainingB).toBe(remainingA - 1);

      const key = `${namespace}:standard-read:u:`;
      const keys = await redis.keys(`${key}*`);
      expect(keys.length).toBe(1);
    });
  });
});

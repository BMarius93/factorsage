import { randomUUID } from "node:crypto";
import { loadRootEnv } from "@intrinsic/config";
import {
  RATE_LIMITED_CODE,
  RATE_LIMIT_HEADERS,
  type RateLimitErrorResponse,
} from "@intrinsic/contracts";
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  UseGuards,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { RATE_LIMIT_POLICIES } from "./rate-limit-policies";
import { RateLimit } from "./rate-limit.decorator";
import { RateLimitModule } from "./rate-limit.module";
import { RATE_LIMIT_REDIS } from "./rate-limit.tokens";

loadRootEnv();

/**
 * Real Redis is what this suite is for, so it is resolved exactly like every other Redis-backed
 * suite in the repository: `TEST_REDIS_URL` then `REDIS_URL`, skipped locally when neither is set
 * so a developer without `pnpm infra:up` is not blocked, and a hard failure in CI where a silent
 * skip would mean the distributed guarantees are untested.
 */
const redisUrl =
  process.env.TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim();
if (!redisUrl && process.env.CI === "true") {
  throw new Error(
    "Rate-limit integration tests require TEST_REDIS_URL or REDIS_URL. CI must not skip them " +
      "silently: they hold the only coverage proving the limiter is atomic under concurrency and " +
      "shared across application instances.",
  );
}
const describeRedis = redisUrl ? describe : describe.skip;

/** A namespace per run, so concurrent runs and a developer's own Redis never collide. */
const namespace = `rate-limit:test:${randomUUID()}`;

/**
 * Stands in for `CookieAuthGuard`: a controller-level guard that populates `request.authUser`.
 *
 * Faithful in the one way that matters here — it runs as a controller guard, which is exactly
 * where the real one runs, so this suite exercises the same ordering the running API has rather
 * than a convenient shortcut.
 */
@Injectable()
class HeaderIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const id = req.headers["x-test-user"];
    if (typeof id === "string" && id.length > 0) {
      req.authUser = {
        id,
        email: `${id}@example.test`,
        role: "USER",
        plan: "FREE",
      };
    }
    return true;
  }
}

@Controller("probe")
@UseGuards(HeaderIdentityGuard)
class ProbeController {
  /** 10 points / 300 s, IP-keyed, fail-closed. The cheapest real policy to exhaust. */
  @RateLimit("auth-sensitive")
  @Get("sensitive")
  sensitive(): { ok: true } {
    return { ok: true };
  }

  /** 10 points / 3600 s, user-keyed. Used for the actor-isolation cases. */
  @RateLimit("admin-operation")
  @Get("admin")
  admin(): { ok: true } {
    return { ok: true };
  }

  /** 20 points / 3600 s plus a 60-point per-IP bucket. The combined-protection case. */
  @RateLimit("backtest-execution")
  @Get("backtest")
  backtest(): { ok: true } {
    return { ok: true };
  }

  /** 30 points / 60 s, user-keyed. A different counter from `admin`, same actor. */
  @RateLimit("monitor-mutation")
  @Get("monitor")
  monitor(): { ok: true } {
    return { ok: true };
  }
}

async function createInstance(
  env: Record<string, string> = {},
): Promise<INestApplication> {
  const previous = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: "test",
    REDIS_URL: redisUrl as string,
    RATE_LIMIT_KEY_NAMESPACE: namespace,
    RATE_LIMIT_TRUSTED_PROXY_HOPS: "0",
    RATE_LIMIT_ALLOWANCE_MULTIPLIER: "1",
    RATE_LIMIT_REDIS_TIMEOUT_MS: "1000",
    ...env,
  });
  try {
    const moduleRef = await Test.createTestingModule({
      imports: [RateLimitModule],
      controllers: [ProbeController],
    }).compile();
    const app = moduleRef.createNestApplication();
    // Bound to an ephemeral port rather than left un-listened: the concurrency case fires dozens
    // of requests at once, and supertest would otherwise race to `listen(0)` once per request.
    await app.listen(0);
    return app;
  } finally {
    // Configuration is read once, at module construction; restoring immediately keeps one
    // instance's settings from leaking into the next one this suite builds.
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previous);
  }
}

describeRedis("API rate limiting over real Redis", () => {
  let app: INestApplication;
  let redis: Redis;

  beforeAll(async () => {
    app = await createInstance();
    redis = app.get<Redis>(RATE_LIMIT_REDIS);
  }, 30_000);

  afterAll(async () => {
    if (redis) {
      const keys = await redis.keys(`${namespace}:*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Targeted cleanup by namespace; nothing resets or flushes developer infrastructure.
    const keys = await redis.keys(`${namespace}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  });

  describe("basic limiting", () => {
    const limit = RATE_LIMIT_POLICIES["auth-sensitive"].points;

    it("allows every request below the limit", async () => {
      for (let i = 0; i < limit - 1; i += 1) {
        await request(app.getHttpServer()).get("/probe/sensitive").expect(200);
      }
    });

    it("allows exactly the limit, reporting zero remaining on the last one", async () => {
      let last: request.Response | undefined;
      for (let i = 0; i < limit; i += 1) {
        last = await request(app.getHttpServer())
          .get("/probe/sensitive")
          .expect(200);
      }
      expect(last?.headers[RATE_LIMIT_HEADERS.limit.toLowerCase()]).toBe(
        String(limit),
      );
      expect(last?.headers[RATE_LIMIT_HEADERS.remaining.toLowerCase()]).toBe(
        "0",
      );
      expect(last?.headers[RATE_LIMIT_HEADERS.policy.toLowerCase()]).toBe(
        "auth-sensitive",
      );
    });

    it("refuses the next request with 429 and the machine-readable body", async () => {
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer()).get("/probe/sensitive").expect(200);
      }
      const response = await request(app.getHttpServer())
        .get("/probe/sensitive")
        .expect(429);

      const body = response.body as RateLimitErrorResponse;
      expect(body.code).toBe(RATE_LIMITED_CODE);
      expect(body.statusCode).toBe(429);
      expect(body.policy).toBe("auth-sensitive");
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(body.message).toContain("Retry in");
    });

    it("sends a Retry-After a client can actually wait out", async () => {
      const duration = RATE_LIMIT_POLICIES["auth-sensitive"].durationSeconds;
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer()).get("/probe/sensitive").expect(200);
      }
      const response = await request(app.getHttpServer())
        .get("/probe/sensitive")
        .expect(429);

      const retryAfter = Number(response.headers["retry-after"]);
      // Never zero (which invites an immediate retry), never longer than the window itself
      // (which would tell a client to wait for an allowance it already has), and equal to the
      // body's own number so the two cannot disagree.
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(duration);
      expect(retryAfter).toBeGreaterThan(duration - 5);
      expect(retryAfter).toBe(
        (response.body as RateLimitErrorResponse).retryAfterSeconds,
      );
    });

    it("refills when the window ends", async () => {
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer()).get("/probe/sensitive").expect(200);
      }
      await request(app.getHttpServer()).get("/probe/sensitive").expect(429);

      // The window *is* the counter key's TTL, so ending it early is a faithful simulation of
      // waiting five minutes — and asserting the TTL first proves the window really is the one
      // the catalog declares rather than a default.
      const [key] = await redis.keys(`${namespace}:auth-sensitive:*`);
      expect(key).toBeDefined();
      const ttl = await redis.ttl(key as string);
      expect(ttl).toBeGreaterThan(
        RATE_LIMIT_POLICIES["auth-sensitive"].durationSeconds - 10,
      );
      expect(ttl).toBeLessThanOrEqual(
        RATE_LIMIT_POLICIES["auth-sensitive"].durationSeconds,
      );

      await redis.pexpire(key as string, 1);
      await new Promise((resolve) => setTimeout(resolve, 60));

      const refilled = await request(app.getHttpServer())
        .get("/probe/sensitive")
        .expect(200);
      expect(refilled.headers[RATE_LIMIT_HEADERS.remaining.toLowerCase()]).toBe(
        String(limit - 1),
      );
    });
  });

  describe("isolation", () => {
    it("does not let one user consume another user's allowance", async () => {
      const limit = RATE_LIMIT_POLICIES["admin-operation"].points;
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/admin")
          .set("x-test-user", "user-a")
          .expect(200);
      }
      await request(app.getHttpServer())
        .get("/probe/admin")
        .set("x-test-user", "user-a")
        .expect(429);

      // B has spent nothing, and must see a full allowance rather than A's exhausted one.
      const b = await request(app.getHttpServer())
        .get("/probe/admin")
        .set("x-test-user", "user-b")
        .expect(200);
      expect(b.headers[RATE_LIMIT_HEADERS.remaining.toLowerCase()]).toBe(
        String(limit - 1),
      );
    });

    it("keeps different policies on different counters", async () => {
      const limit = RATE_LIMIT_POLICIES["admin-operation"].points;
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/admin")
          .set("x-test-user", "user-c")
          .expect(200);
      }
      await request(app.getHttpServer())
        .get("/probe/admin")
        .set("x-test-user", "user-c")
        .expect(429);

      // Same user, same actor kind, different policy: a fresh allowance.
      const other = await request(app.getHttpServer())
        .get("/probe/monitor")
        .set("x-test-user", "user-c")
        .expect(200);
      expect(other.headers[RATE_LIMIT_HEADERS.policy.toLowerCase()]).toBe(
        "monitor-mutation",
      );
      expect(other.headers[RATE_LIMIT_HEADERS.remaining.toLowerCase()]).toBe(
        String(RATE_LIMIT_POLICIES["monitor-mutation"].points - 1),
      );
    });

    it("separates unauthenticated identities by client IP", async () => {
      // Every request in this suite arrives over loopback, so distinct origins only exist when
      // the deployment declares a trusted proxy. This instance declares one, which is also what
      // proves the forwarded header is honoured *only* under that configuration.
      const proxied = await createInstance({
        RATE_LIMIT_TRUSTED_PROXY_HOPS: "1",
      });
      try {
        const limit = RATE_LIMIT_POLICIES["auth-sensitive"].points;
        for (let i = 0; i < limit; i += 1) {
          await request(proxied.getHttpServer())
            .get("/probe/sensitive")
            .set("x-forwarded-for", "203.0.113.10")
            .expect(200);
        }
        await request(proxied.getHttpServer())
          .get("/probe/sensitive")
          .set("x-forwarded-for", "203.0.113.10")
          .expect(429);

        await request(proxied.getHttpServer())
          .get("/probe/sensitive")
          .set("x-forwarded-for", "203.0.113.11")
          .expect(200);
      } finally {
        await proxied.close();
      }
    });

    it("ignores a forwarded header when no proxy is trusted", async () => {
      // The default deployment. A caller inventing a new `X-Forwarded-For` per request must not
      // mint a new bucket, or IP limiting would be decorative.
      const limit = RATE_LIMIT_POLICIES["auth-sensitive"].points;
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/sensitive")
          .set("x-forwarded-for", `198.51.100.${i}`)
          .expect(200);
      }
      await request(app.getHttpServer())
        .get("/probe/sensitive")
        .set("x-forwarded-for", "198.51.100.200")
        .expect(429);
    });

    it("refuses when either bucket of a combined policy is exhausted", async () => {
      const policy = RATE_LIMIT_POLICIES["backtest-execution"];
      const perUser = policy.points;
      const perIp = policy.secondary.points;

      // Spend the shared per-IP bucket across several users, each staying inside its own
      // allowance. Only the second bucket sees the aggregate.
      const users = Math.ceil(perIp / perUser);
      for (let user = 0; user < users; user += 1) {
        for (let i = 0; i < perUser; i += 1) {
          await request(app.getHttpServer())
            .get("/probe/backtest")
            .set("x-test-user", `spread-${user}`)
            .expect(200);
        }
      }

      const fresh = await request(app.getHttpServer())
        .get("/probe/backtest")
        .set("x-test-user", "spread-fresh")
        .expect(429);
      expect((fresh.body as RateLimitErrorResponse).policy).toBe(
        "backtest-execution",
      );
    });
  });

  describe("distributed correctness", () => {
    it("cannot be exceeded by concurrent requests", async () => {
      const limit = RATE_LIMIT_POLICIES["monitor-mutation"].points;
      const attempts = limit + 25;

      const responses = await Promise.all(
        Array.from({ length: attempts }, () =>
          request(app.getHttpServer())
            .get("/probe/monitor")
            .set("x-test-user", "race"),
        ),
      );

      const allowed = responses.filter((r) => r.status === 200).length;
      const refused = responses.filter((r) => r.status === 429).length;
      // Exactly the allowance, not "about" it: the counter is a single atomic Redis script, so a
      // read-modify-write race cannot let an extra request through.
      expect(allowed).toBe(limit);
      expect(refused).toBe(attempts - limit);
    }, 30_000);

    it("shares one allowance across independent application instances", async () => {
      const second = await createInstance();
      try {
        const limit = RATE_LIMIT_POLICIES["admin-operation"].points;
        // Alternate between two separately compiled applications, each with its own Redis
        // connection and its own limiter registry — the same shape as two API containers.
        for (let i = 0; i < limit; i += 1) {
          const target = i % 2 === 0 ? app : second;
          await request(target.getHttpServer())
            .get("/probe/admin")
            .set("x-test-user", "multi-instance")
            .expect(200);
        }

        await request(app.getHttpServer())
          .get("/probe/admin")
          .set("x-test-user", "multi-instance")
          .expect(429);
        await request(second.getHttpServer())
          .get("/probe/admin")
          .set("x-test-user", "multi-instance")
          .expect(429);
      } finally {
        await second.close();
      }
    }, 30_000);

    it("keys counters under the configured namespace and nothing else", async () => {
      await request(app.getHttpServer())
        .get("/probe/admin")
        .set("x-test-user", "namespaced")
        .expect(200);

      const keys = await redis.keys(`${namespace}:*`);
      expect(keys).toContain(`${namespace}:admin-operation:u:namespaced`);
      // No user-scoped key ever lands in the stock-data namespaces; the two are separate by
      // construction, which is what `AGENTS.md` invariant 16 requires.
      for (const key of keys) {
        expect(key.startsWith("stock-data:")).toBe(false);
        expect(key.startsWith("benchmark:")).toBe(false);
      }
    });
  });
});

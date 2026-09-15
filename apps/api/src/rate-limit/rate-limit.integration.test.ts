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
  /**
   * IP-keyed and fail-closed. Chosen for the basic-limiting cases because it is the narrowest
   * allowance in the catalog and so the cheapest to exhaust; every case below reads the number it
   * needs from `RATE_LIMIT_POLICIES` rather than assuming one.
   */
  @RateLimit("auth-sensitive")
  @Get("sensitive")
  sensitive(): { ok: true } {
    return { ok: true };
  }

  /** User-keyed, single bucket. Used for the actor-isolation and window-semantics cases. */
  @RateLimit("admin-operation")
  @Get("admin")
  admin(): { ok: true } {
    return { ok: true };
  }

  /** The combined-protection case: a per-user bucket plus a wider shared per-IP one. */
  @RateLimit("backtest-execution")
  @Get("backtest")
  backtest(): { ok: true } {
    return { ok: true };
  }

  /** User-keyed like `admin`, but a different policy — so a different counter. */
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

  describe("window semantics", () => {
    // What the chosen configuration actually implements, pinned rather than asserted in prose.
    // `RateLimiterRedis` with `points`/`duration` and no `execEvenly` or `blockDuration` is a
    // **fixed-window counter whose window is anchored to the first request**, not a sliding
    // window, not a rolling window and not a token bucket. `ai/architecture/rate-limiting.md`
    // documents it in those words; these are the observations behind them.

    it("starts the window at the first request and sizes its TTL from the policy", async () => {
      await request(app.getHttpServer())
        .get("/probe/admin")
        .set("x-test-user", "window-start")
        .expect(200);

      const key = `${namespace}:admin-operation:u:window-start`;
      const ttl = await redis.pttl(key);
      const duration = RATE_LIMIT_POLICIES["admin-operation"].durationSeconds;
      // Within a breath of the full duration: the window began now, not on a clock boundary.
      expect(ttl).toBeGreaterThan(duration * 1000 - 5_000);
      expect(ttl).toBeLessThanOrEqual(duration * 1000);
    });

    it("does not extend the window on later requests, including refused ones", async () => {
      // The property that makes it a fixed window rather than a sliding one: only the request
      // that creates the key sets its TTL. A caller cannot push their own reset further away by
      // continuing to hammer — which is also why `Retry-After` stays truthful under a retry loop.
      const limit = RATE_LIMIT_POLICIES["admin-operation"].points;
      const key = `${namespace}:admin-operation:u:no-extension`;

      await request(app.getHttpServer())
        .get("/probe/admin")
        .set("x-test-user", "no-extension")
        .expect(200);
      const first = await redis.pttl(key);

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      for (let i = 1; i < limit; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/admin")
          .set("x-test-user", "no-extension")
          .expect(200);
      }
      // Over the limit as well: an over-consumption must not restart the clock either.
      await request(app.getHttpServer())
        .get("/probe/admin")
        .set("x-test-user", "no-extension")
        .expect(429);

      const later = await redis.pttl(key);
      expect(later).toBeLessThan(first);
    }, 30_000);

    it("admits up to twice the allowance across a window boundary", async () => {
      // The accepted cost of a fixed window, demonstrated rather than hidden: a caller may spend
      // the whole allowance just before the window ends and the whole allowance again just after,
      // so a short interval spanning the boundary can carry 2 x points. For abuse and capacity
      // protection that is fine — the sustained rate is still bounded by the policy — and it is
      // documented instead of being papered over with a custom sliding window.
      const limit = RATE_LIMIT_POLICIES["admin-operation"].points;
      const actor = "boundary-burst";
      const key = `${namespace}:admin-operation:u:${actor}`;

      let admitted = 0;
      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/admin")
          .set("x-test-user", actor)
          .expect(200);
        admitted += 1;
      }
      await request(app.getHttpServer())
        .get("/probe/admin")
        .set("x-test-user", actor)
        .expect(429);

      // End the window the only way it ever ends: the key expires.
      await redis.pexpire(key, 1);
      await new Promise((resolve) => setTimeout(resolve, 60));

      for (let i = 0; i < limit; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/admin")
          .set("x-test-user", actor)
          .expect(200);
        admitted += 1;
      }
      expect(admitted).toBe(limit * 2);
    }, 30_000);
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

    it("never spends the shared bucket on a request the personal bucket already refused", async () => {
      // The harm this prevents: the shared bucket is only a few users' worth by design, so a
      // caller whose own allowance is gone could lock their whole office out of an endpoint they
      // never touched, just by retrying.
      const policy = RATE_LIMIT_POLICIES["backtest-execution"];
      const user = "drains-the-nat";

      for (let i = 0; i < policy.points; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/backtest")
          .set("x-test-user", user)
          .expect(200);
      }

      const [sharedKey] = await redis.keys(
        `${namespace}:backtest-execution:ip:*`,
      );
      expect(sharedKey).toBeDefined();
      const before = Number(await redis.get(sharedKey as string));
      expect(before).toBe(policy.points);

      for (let i = 0; i < 8; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/backtest")
          .set("x-test-user", user)
          .expect(429);
      }

      expect(
        Number(await redis.get(sharedKey as string)),
        "eight doomed retries must cost the shared bucket nothing",
      ).toBe(before);
    }, 30_000);

    it("never spends a caller's own bucket on a request the shared bucket refused", async () => {
      // The mirror case. A caller refused because of their neighbours must not also lose the
      // allowance they will need once the shared window clears — an automatic retry would
      // otherwise empty it for them.
      const policy = RATE_LIMIT_POLICIES["backtest-execution"];
      const sharedLimit = policy.secondary.points;

      let onShared = 0;
      for (let filler = 0; onShared < sharedLimit; filler += 1) {
        for (let i = 0; i < policy.points && onShared < sharedLimit; i += 1) {
          await request(app.getHttpServer())
            .get("/probe/backtest")
            .set("x-test-user", `filler-${filler}`)
            .expect(200);
          onShared += 1;
        }
      }

      const fresh = "innocent-neighbour";
      for (let i = 0; i < 5; i += 1) {
        await request(app.getHttpServer())
          .get("/probe/backtest")
          .set("x-test-user", fresh)
          .expect(429);
      }

      const own = await redis.get(`${namespace}:backtest-execution:u:${fresh}`);
      // Either untouched, or created and handed straight back. Never a spent point.
      expect(own === null || Number(own) === 0).toBe(true);
    }, 60_000);

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

    it("cannot exceed either bucket of a combined policy under concurrency", async () => {
      // The property compensation must not break: refunds move a counter *down*, so the question
      // is whether two requests can both be admitted against one remaining point. They cannot —
      // every consume is still a single atomic script, and a refund only ever follows a refusal.
      const policy = RATE_LIMIT_POLICIES["backtest-execution"];
      const perUser = policy.points;
      const sharedLimit = policy.secondary.points;
      const users = 6;
      const attemptsEach = perUser + 10;

      // Attribution comes from the call site rather than from the response, so a caller's
      // admitted count is never inferred from a parsed header.
      const attempts = Array.from({ length: users }, (_, user) =>
        Array.from({ length: attemptsEach }, async () => {
          const actor = `race-${user}`;
          const response = await request(app.getHttpServer())
            .get("/probe/backtest")
            .set("x-test-user", actor);
          return { actor, status: response.status };
        }),
      ).flat();
      const responses = await Promise.all(attempts);

      const admitted = responses.filter((r) => r.status === 200);
      expect(admitted.length).toBeLessThanOrEqual(sharedLimit);

      // And no single caller got more than their own allowance either.
      const perUserCounts = new Map<string, number>();
      for (const response of admitted) {
        perUserCounts.set(
          response.actor,
          (perUserCounts.get(response.actor) ?? 0) + 1,
        );
      }
      expect(perUserCounts.size).toBeGreaterThan(1);
      for (const [actor, count] of perUserCounts) {
        expect(
          count,
          `${actor} exceeded its own allowance`,
        ).toBeLessThanOrEqual(perUser);
      }

      // Every admitted request is accounted for in the shared counter; refunds must not have
      // driven it below what was actually served.
      const [sharedKey] = await redis.keys(
        `${namespace}:backtest-execution:ip:*`,
      );
      expect(
        Number(await redis.get(sharedKey as string)),
      ).toBeGreaterThanOrEqual(admitted.length);
    }, 60_000);

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

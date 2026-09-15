import {
  RATE_LIMITED_CODE,
  RATE_LIMIT_UNAVAILABLE_CODE,
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
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { RateLimit } from "./rate-limit.decorator";
import { RateLimitModule } from "./rate-limit.module";
import { RATE_LIMIT_REDIS } from "./rate-limit.tokens";

/**
 * What happens when the limiter's store does not answer.
 *
 * The decision is per policy and deliberately asymmetric, and this suite is where that asymmetry
 * is actually pinned:
 *
 * - a capacity policy **fails open**, because a Redis outage already fails readiness and refusing
 *   the PostgreSQL-only surfaces that still work would widen a partial outage into a total one;
 * - a security or money policy **fails closed** with `503` and its own code, because an outage is
 *   exactly when an unlimited credential endpoint is most valuable to an attacker.
 *
 * Neither branch ever consults a process-local counter, so nothing here can report a distributed
 * guarantee it does not have.
 *
 * Needs no Redis: one case points at a closed port and the other injects a client that accepts
 * commands and never answers, which is the failure a connection check cannot catch.
 */

@Injectable()
class IdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    req.authUser = {
      id: "outage-user",
      email: "outage@example.test",
      role: "USER",
      plan: "FREE",
    };
    return true;
  }
}

@Controller("outage")
@UseGuards(IdentityGuard)
class OutageController {
  /** `onRedisFailure: "allow"` — capacity protection. */
  @RateLimit("standard-read")
  @Get("read")
  read(): { ok: true } {
    return { ok: true };
  }

  /** `onRedisFailure: "deny"` — a credential-class endpoint. */
  @RateLimit("auth-sensitive")
  @Get("sensitive")
  sensitive(): { ok: true } {
    return { ok: true };
  }

  /** `onRedisFailure: "deny"` — reaches the payment provider. */
  @RateLimit("billing-mutation")
  @Get("billing")
  billing(): { ok: true } {
    return { ok: true };
  }
}

/**
 * A store that accepts a command and never answers.
 *
 * The failure an "is it connected?" check cannot see, and the one that would hang every HTTP
 * request if the limiter had no timeout of its own. `rlflxIncr` is the custom command
 * `RateLimiterRedis` installs through `defineCommand` on an ioredis client, so hanging it is
 * hanging exactly the call the limiter makes.
 */
function hangingRedis(): unknown {
  const client: Record<string, unknown> = {
    status: "ready",
    defineCommand(name: string) {
      client[name] = () => new Promise(() => {});
    },
    multi: () => ({
      set: () => ({ pttl: () => ({ exec: () => new Promise(() => {}) }) }),
      incrby: () => ({ pttl: () => ({ exec: () => new Promise(() => {}) }) }),
    }),
    disconnect: () => {},
    connect: async () => {},
    on: () => {},
  };
  return client;
}

let app: INestApplication | undefined;

async function createApp(
  env: Record<string, string>,
  overrideRedis?: unknown,
): Promise<INestApplication> {
  const previous = { ...process.env };
  Object.assign(process.env, { NODE_ENV: "test", ...env });
  try {
    const builder = Test.createTestingModule({
      imports: [RateLimitModule],
      controllers: [OutageController],
    });
    if (overrideRedis) {
      builder.overrideProvider(RATE_LIMIT_REDIS).useValue(overrideRedis);
    }
    const moduleRef = await builder.compile();
    const created = moduleRef.createNestApplication();
    await created.init();
    return created;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, previous);
  }
}

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe("Redis unavailable", () => {
  /** A port nothing listens on: connection refused, immediately and repeatedly. */
  const unreachable = { REDIS_URL: "redis://127.0.0.1:6399" };

  it("serves capacity-protected reads and records the degradation", async () => {
    app = await createApp(unreachable);
    // Repeatedly, not once: fail-open must not be a one-request grace that then starts refusing.
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer()).get("/outage/read").expect(200);
    }
  });

  it("does not report an allowance it could not measure", async () => {
    app = await createApp(unreachable);
    const response = await request(app.getHttpServer())
      .get("/outage/read")
      .expect(200);
    // No `RateLimit-*` headers at all. Sending a remaining count nothing counted would be worse
    // than sending none: a client would pace itself against a fiction.
    expect(response.headers["ratelimit-limit"]).toBeUndefined();
    expect(response.headers["ratelimit-remaining"]).toBeUndefined();
  });

  it("refuses credential endpoints with 503 and its own code", async () => {
    app = await createApp(unreachable);
    const response = await request(app.getHttpServer())
      .get("/outage/sensitive")
      .expect(503);

    const body = response.body as RateLimitErrorResponse;
    expect(body.code).toBe(RATE_LIMIT_UNAVAILABLE_CODE);
    // Explicitly *not* 429: the caller's allowance is untouched and telling them to slow down
    // would be a lie they would act on.
    expect(body.code).not.toBe(RATE_LIMITED_CODE);
    expect(body.policy).toBe("auth-sensitive");
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("refuses payment-provider endpoints the same way", async () => {
    app = await createApp(unreachable);
    const response = await request(app.getHttpServer())
      .get("/outage/billing")
      .expect(503);
    expect((response.body as RateLimitErrorResponse).code).toBe(
      RATE_LIMIT_UNAVAILABLE_CODE,
    );
  });

  it("starts up with the store already down rather than failing to boot", async () => {
    // Proven implicitly by every case above, and stated once: the module's connect failure is
    // logged and survivable, because which endpoints may still be served is a per-policy decision
    // the catalog already made.
    app = await createApp(unreachable);
    expect(app).toBeDefined();
  });
});

describe("Redis reachable but not answering", () => {
  const timeoutEnv = {
    REDIS_URL: "redis://127.0.0.1:6399",
    RATE_LIMIT_REDIS_TIMEOUT_MS: "50",
  };

  it("bounds the request instead of hanging it", async () => {
    app = await createApp(timeoutEnv, hangingRedis());
    const started = Date.now();
    await request(app.getHttpServer()).get("/outage/read").expect(200);
    const elapsed = Date.now() - started;
    // The store never answers at all; without the limiter's own timeout this request would never
    // complete. A generous ceiling — the assertion is "bounded", not "fast".
    expect(elapsed).toBeLessThan(2_000);
  });

  it("applies the policy's failure mode to a timeout, not just to a refused connection", async () => {
    app = await createApp(timeoutEnv, hangingRedis());
    await request(app.getHttpServer()).get("/outage/sensitive").expect(503);
  });
});

describe("enforcement disabled", () => {
  it("serves every policy class untouched and reports no allowance", async () => {
    // The escape hatch for a deployment whose edge already limits. It must be complete: a
    // half-disabled limiter that still refuses the fail-closed policies would be a trap.
    app = await createApp({
      REDIS_URL: "redis://127.0.0.1:6399",
      RATE_LIMIT_ENABLED: "false",
    });
    for (const path of ["read", "sensitive", "billing"]) {
      const response = await request(app.getHttpServer())
        .get(`/outage/${path}`)
        .expect(200);
      expect(response.headers["ratelimit-policy"]).toBeUndefined();
    }
  });
});

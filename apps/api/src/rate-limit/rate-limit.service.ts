import {
  RateLimitError,
  RATE_LIMITED_CODE,
  RATE_LIMIT_UNAVAILABLE_CODE,
} from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import type { AuthenticatedRequest } from "../auth/authenticated-request";
import { clientIp } from "./client-ip";
import {
  rateLimitPolicy,
  type RateLimitBucket,
  type RateLimitPolicyName,
} from "./rate-limit-policies";
import {
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_LOGGER,
  RATE_LIMIT_REDIS,
  type RateLimitRuntimeConfig,
} from "./rate-limit.tokens";

/**
 * What the caller is told about their allowance after a permitted request. Projected into the
 * `RateLimit-*` response headers by the interceptor, and taken from whichever of a policy's
 * buckets is closest to exhaustion — the one that will actually refuse next.
 */
export type RateLimitDecision = {
  readonly policy: RateLimitPolicyName;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
};

/** One bucket's resolved identity: the limiter to spend from and the key to spend on. */
type ResolvedBucket = {
  readonly bucket: RateLimitBucket;
  readonly limiter: RateLimiterRedis;
  readonly key: string;
};

type BucketOutcome =
  | { readonly kind: "allowed"; readonly result: RateLimiterRes }
  | { readonly kind: "limited"; readonly result: RateLimiterRes }
  | { readonly kind: "unavailable"; readonly error: unknown };

/**
 * All the mechanics of rate limiting, in one injectable service.
 *
 * Route handlers never reach this: `RateLimitInterceptor` reads the `@RateLimit` declaration and
 * calls `consume`. Nothing above this line knows that Redis exists, which is the point — the
 * declaration is at the endpoint, the mechanism is here, and changing a limit touches neither.
 *
 * ## Why `rate-limiter-flexible`, and what this file still owns
 *
 * The distributed counter itself is the library's: one Redis `EVAL` per bucket, `INCRBY` plus a
 * TTL set only on the first increment of a window, which is atomic across processes and is the
 * part that is genuinely hard to get right. FactorSage keeps what is FactorSage's: which policy
 * applies, who the actor is, how a refusal becomes HTTP, what is logged, and what happens when
 * Redis does not answer.
 *
 * ## Bounded, always
 *
 * Every consume races a timeout (`RATE_LIMIT_REDIS_TIMEOUT_MS`). A limiter that can hang is worse
 * than none at all — it turns a Redis stall into an API-wide stall — so a breach is treated as the
 * policy's Redis-failure behaviour and the request moves on. The Redis client is configured with
 * `enableOfflineQueue: false` and the limiters with `rejectIfRedisNotReady`, so an unreachable
 * Redis is refused in microseconds rather than queued until it returns.
 */
@Injectable()
export class RateLimitService {
  /** One limiter per (policy, bucket). Built lazily and reused; they are stateless over Redis. */
  private readonly limiters = new Map<string, RateLimiterRedis>();

  constructor(
    @Inject(RATE_LIMIT_REDIS) private readonly redis: Redis,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitRuntimeConfig,
    @Inject(RATE_LIMIT_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  /**
   * Spends one point of `policy` for this request.
   *
   * Returns the allowance to report on success, `null` when enforcement is off or was skipped
   * because Redis failed under a fail-open policy, and throws `RateLimitError` when the request
   * must be refused.
   */
  async consume(
    policy: RateLimitPolicyName,
    request: AuthenticatedRequest,
  ): Promise<RateLimitDecision | null> {
    if (!this.config.enabled) {
      return null;
    }

    const definition = rateLimitPolicy(policy);
    const buckets = [
      this.resolve(policy, "primary", definition, request),
      ...(definition.secondary
        ? [this.resolve(policy, "secondary", definition.secondary, request)]
        : []),
    ];

    const outcomes = await Promise.all(
      buckets.map((resolved) => this.spend(resolved)),
    );

    const limited = outcomes.flatMap((outcome, index) =>
      outcome.kind === "limited"
        ? [{ outcome, bucket: buckets[index] as ResolvedBucket }]
        : [],
    );
    if (limited.length > 0) {
      // The longest wait among the exhausted buckets: retrying before that one refills would be
      // refused again, so a shorter hint would be a lie the client acts on.
      const retryAfterSeconds = Math.max(
        ...limited.map(({ outcome }) => seconds(outcome.result.msBeforeNext)),
      );
      const worst = limited[0] as {
        outcome: BucketOutcome & { kind: "limited" };
        bucket: ResolvedBucket;
      };
      this.logger.warn({
        event: "rate-limit.request.refused",
        policy,
        actorUserId: request.authUser?.id ?? null,
        actorKind: worst.bucket.bucket.actor,
        operation: `${request.method} ${request.route?.path ?? request.path}`,
        limit: worst.bucket.bucket.points * this.config.allowanceMultiplier,
        consumedPoints: worst.outcome.result.consumedPoints,
        retryAfterSeconds,
      });
      throw new RateLimitError(
        `Too many requests. Retry in ${retryAfterSeconds} second${
          retryAfterSeconds === 1 ? "" : "s"
        }.`,
        {
          code: RATE_LIMITED_CODE,
          policy,
          retryAfterSeconds,
          limit: worst.bucket.bucket.points * this.config.allowanceMultiplier,
          remaining: 0,
        },
      );
    }

    const unavailable = outcomes.find(
      (outcome) => outcome.kind === "unavailable",
    );
    if (unavailable?.kind === "unavailable") {
      return this.handleUnavailable(policy, request, unavailable.error);
    }

    const allowed = outcomes.flatMap((outcome, index) =>
      outcome.kind === "allowed"
        ? [{ result: outcome.result, bucket: buckets[index] as ResolvedBucket }]
        : [],
    );
    if (allowed.length === 0) {
      return null;
    }
    // Report the bucket a client is closest to exhausting, so the headers describe the constraint
    // that will actually bite rather than the most generous one.
    const tightest = allowed.reduce((worst, candidate) =>
      candidate.result.remainingPoints < worst.result.remainingPoints
        ? candidate
        : worst,
    );
    return {
      policy,
      limit: tightest.bucket.bucket.points * this.config.allowanceMultiplier,
      remaining: tightest.result.remainingPoints,
      resetSeconds: seconds(tightest.result.msBeforeNext),
    };
  }

  /**
   * The explicit Redis-outage decision, per policy.
   *
   * There is no third option here on purpose. A process-local fallback limiter — the library's
   * `insuranceLimiter` — would let N instances each enforce the full allowance while reporting the
   * configured one, so the system would claim a distributed guarantee it does not have. Choosing
   * openly between "allow and say so in the log" and "refuse honestly" is the smaller lie.
   */
  private handleUnavailable(
    policy: RateLimitPolicyName,
    request: AuthenticatedRequest,
    error: unknown,
  ): RateLimitDecision | null {
    const definition = rateLimitPolicy(policy);
    const operation = `${request.method} ${request.route?.path ?? request.path}`;

    if (definition.onRedisFailure === "allow") {
      this.logger.warn({
        event: "rate-limit.store.unavailable",
        policy,
        operation,
        outcome: "allowed",
        actorUserId: request.authUser?.id ?? null,
        err: error,
      });
      return null;
    }

    this.logger.error({
      event: "rate-limit.store.unavailable",
      policy,
      operation,
      outcome: "refused",
      actorUserId: request.authUser?.id ?? null,
      err: error,
    });
    throw new RateLimitError(
      "Request throttling is temporarily unavailable. Please retry shortly.",
      {
        code: RATE_LIMIT_UNAVAILABLE_CODE,
        policy,
        retryAfterSeconds: UNAVAILABLE_RETRY_AFTER_SECONDS,
      },
    );
  }

  private async spend(resolved: ResolvedBucket): Promise<BucketOutcome> {
    try {
      const result = await this.withTimeout(
        resolved.limiter.consume(resolved.key, 1),
      );
      return { kind: "allowed", result };
    } catch (error) {
      if (error instanceof RateLimiterRes) {
        return { kind: "limited", result: error };
      }
      return { kind: "unavailable", error };
    }
  }

  /**
   * Bounds one limiter round trip.
   *
   * The losing promise is neutralized rather than abandoned: the point it spends is already gone,
   * and leaving its rejection unobserved would crash the process through the `unhandledRejection`
   * handler `main.ts` installs.
   */
  private withTimeout(promise: Promise<RateLimiterRes>): Promise<RateLimiterRes> {
    let timer: NodeJS.Timeout | undefined;
    const settled = promise.finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
    settled.catch(() => {});
    return Promise.race([
      settled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Rate-limit store did not answer within ${this.config.redisTimeoutMs}ms`,
              ),
            ),
          this.config.redisTimeoutMs,
        );
      }),
    ]);
  }

  private resolve(
    policy: RateLimitPolicyName,
    role: "primary" | "secondary",
    bucket: RateLimitBucket,
    request: AuthenticatedRequest,
  ): ResolvedBucket {
    return {
      bucket,
      limiter: this.limiterFor(policy, role, bucket),
      key: this.actorKey(bucket, request),
    };
  }

  /**
   * The actor half of the Redis key.
   *
   * `user` prefers the authenticated user id, which is the identity that survives a network
   * change and cannot be shared with a stranger behind the same NAT; it falls back to the client
   * IP for the routes that answer a guest too. The `u:` / `ip:` prefixes keep the two namespaces
   * from ever colliding on a value that looks like both.
   *
   * The subscription plan is deliberately absent. Request rate is not something a plan sells
   * (`docs/decisions/entitlements-v1.md` section 10), and putting the tier in the key would make
   * an upgrade silently reset an abuser's allowance.
   */
  private actorKey(
    bucket: RateLimitBucket,
    request: AuthenticatedRequest,
  ): string {
    if (bucket.actor === "user" && request.authUser) {
      return `u:${request.authUser.id}`;
    }
    return `ip:${clientIp(request, this.config.trustedProxyHops)}`;
  }

  private limiterFor(
    policy: RateLimitPolicyName,
    role: "primary" | "secondary",
    bucket: RateLimitBucket,
  ): RateLimiterRedis {
    const keyPrefix = `${this.config.keyNamespace}:${policy}${
      role === "secondary" ? ":ip" : ""
    }`;
    const existing = this.limiters.get(keyPrefix);
    if (existing) {
      return existing;
    }
    const limiter = new RateLimiterRedis({
      storeClient: this.redis,
      keyPrefix,
      points: bucket.points * this.config.allowanceMultiplier,
      duration: bucket.durationSeconds,
      // Fail immediately while the connection is not `ready` instead of waiting for a reconnect.
      // Which of the two branches that becomes is the policy's `onRedisFailure`, decided above.
      rejectIfRedisNotReady: true,
    });
    this.limiters.set(keyPrefix, limiter);
    return limiter;
  }
}

/**
 * How long a fail-closed refusal asks the caller to wait.
 *
 * Long enough that a client backs off rather than hammering an already-struggling deployment,
 * short enough that a recovered Redis is noticed promptly. It is a fixed hint, not a measurement:
 * nothing here knows when Redis will return.
 */
const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** Whole seconds, rounded up, never zero — a `Retry-After: 0` invites an immediate retry. */
function seconds(milliseconds: number): number {
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

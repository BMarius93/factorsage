import { getApiConfig, getRateLimitConfig } from "@intrinsic/config";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import type { Redis } from "ioredis";
import { createRateLimitRedisClient } from "./rate-limit-redis";
import { RateLimitExceptionFilter } from "./rate-limit-exception.filter";
import { RateLimitInterceptor } from "./rate-limit.interceptor";
import { RateLimitService } from "./rate-limit.service";
import {
  RATE_LIMIT_CONFIG,
  RATE_LIMIT_LOGGER,
  RATE_LIMIT_REDIS,
  type RateLimitRuntimeConfig,
} from "./rate-limit.tokens";

/**
 * Opens the limiter's connection at startup and closes it on shutdown.
 *
 * Connecting eagerly keeps the first real request off the handshake path, and a failure here is
 * deliberately **not** fatal: ioredis keeps retrying in the background, and until it succeeds each
 * policy's own `onRedisFailure` decides what happens — which is a decision the catalog already
 * made, per endpoint class, rather than one a boot sequence should pre-empt for the whole process.
 * Readiness reports the outage separately (`GET /health/ready`).
 */
@Injectable()
class RateLimitRedisLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(RATE_LIMIT_REDIS) private readonly redis: Redis,
    @Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitRuntimeConfig,
    @Inject(RATE_LIMIT_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.enabled) {
      this.logger.warn({ event: "rate-limit.disabled" });
      return;
    }
    try {
      await this.redis.connect();
      this.logger.info({
        event: "rate-limit.started",
        keyNamespace: this.config.keyNamespace,
        trustedProxyHops: this.config.trustedProxyHops,
        allowanceMultiplier: this.config.allowanceMultiplier,
      });
    } catch (err) {
      this.logger.error({ event: "rate-limit.store.connect-failed", err });
    }
  }

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

/**
 * API rate limiting, as one global module.
 *
 * Importing it installs everything: the interceptor that enforces `@RateLimit` on every route, the
 * filter that maps a refusal to HTTP, the limiter's own Redis connection and its lifecycle. There
 * is nothing to remember per controller — which is the property that makes "every applicable route
 * is protected" true by construction rather than by review.
 *
 * `@Global` so a feature module's own integration suite can compile this module beside it and get
 * the same behaviour the running API has.
 */
@Global()
@Module({
  providers: [
    {
      provide: RATE_LIMIT_CONFIG,
      useFactory: (): RateLimitRuntimeConfig => getRateLimitConfig(),
    },
    {
      provide: RATE_LIMIT_LOGGER,
      useFactory: (): StructuredLogger => {
        const config = getApiConfig();
        return createLogger({
          service: "api",
          level: config.logLevel,
          environment: config.environment,
          base: { component: "rate-limit" },
        });
      },
    },
    {
      provide: RATE_LIMIT_REDIS,
      inject: [RATE_LIMIT_CONFIG, RATE_LIMIT_LOGGER],
      useFactory: (
        config: RateLimitRuntimeConfig,
        logger: StructuredLogger,
      ): Redis =>
        createRateLimitRedisClient(
          config.redisUrl,
          config.redisTimeoutMs,
          (err) => {
            // Connection-level noise during an outage; the per-request decision is logged by the
            // service with the policy and actor that it affected.
            logger.debug({ event: "rate-limit.redis.error", err });
          },
        ),
    },
    RateLimitService,
    RateLimitRedisLifecycle,
    { provide: APP_INTERCEPTOR, useClass: RateLimitInterceptor },
    { provide: APP_FILTER, useClass: RateLimitExceptionFilter },
  ],
  exports: [RateLimitService, RATE_LIMIT_REDIS, RATE_LIMIT_CONFIG],
})
export class RateLimitModule {}

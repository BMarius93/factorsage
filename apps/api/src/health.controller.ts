import type { ReadinessCheck, ReadinessResponse } from "@intrinsic/contracts";
import type { createStockDataRedisClient } from "@intrinsic/stock-data";
import {
  Controller,
  Get,
  Inject,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrismaService } from "./database/prisma.service";
import { STOCK_DATA_REDIS } from "./stocks/stock-data.tokens";

/** The only capability the probe needs from the Redis client the stock slice exports. */
type RedisProbe = Pick<ReturnType<typeof createStockDataRedisClient>, "ping">;

/** How long one dependency probe may take before readiness reports it as failed. */
export const HEALTH_CHECK_TIMEOUT_MS = Symbol("HEALTH_CHECK_TIMEOUT_MS");
const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

/**
 * Liveness and readiness, kept deliberately apart.
 *
 * `GET /health` answers "is the process up" and nothing else, so an orchestrator restarts a hung
 * process and never a healthy one whose dependency is down.
 *
 * `GET /health/ready` answers "can this instance serve the product" by probing the two dependencies
 * every request path needs: PostgreSQL is the source of truth for all user-owned data, and Redis is
 * required at runtime for every stock-data read, the hydration lock and the provider gate — nothing
 * degrades to a PostgreSQL-only path when it is unreachable (`AGENTS.md` invariant 16). Either one
 * failing means the instance should stop receiving traffic, so the endpoint answers `503` with the
 * per-dependency detail. The market-data provider is deliberately **not** probed: a provider outage
 * or rate limit is absorbed by the shared gate and cooldown, and must never take an instance out of
 * rotation or restart it.
 *
 * Each probe is bounded by a timeout, so a hung dependency reports as failed rather than hanging
 * the probe itself — a readiness endpoint that can hang is one an orchestrator times out on.
 */
@Controller("health")
export class HealthController {
  private readonly timeoutMs: number;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(STOCK_DATA_REDIS) private readonly redis: RedisProbe,
    @Optional() @Inject(HEALTH_CHECK_TIMEOUT_MS) timeoutMs?: number,
  ) {
    this.timeoutMs = timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  }

  @Get()
  getHealth() {
    return {
      status: "ok",
      service: "api",
    };
  }

  @Get("ready")
  async getReadiness(): Promise<ReadinessResponse> {
    const [postgres, redis] = await Promise.all([
      this.probe(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      this.probe(async () => {
        await this.redis.ping();
      }),
    ]);
    const response: ReadinessResponse = {
      status:
        postgres.status === "ok" && redis.status === "ok"
          ? "ok"
          : "unavailable",
      checks: { postgres, redis },
    };
    if (response.status !== "ok") {
      // The body is the readiness document itself, so an operator reading the 503 sees which
      // dependency failed and how long the probe waited, not a generic message.
      throw new ServiceUnavailableException(response);
    }
    return response;
  }

  private async probe(check: () => Promise<void>): Promise<ReadinessCheck> {
    const started = performance.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`Probe timed out after ${this.timeoutMs}ms`)),
            this.timeoutMs,
          );
        }),
      ]);
      return {
        status: "ok",
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      return {
        status: "failed",
        latencyMs: Math.round(performance.now() - started),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}

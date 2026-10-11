import type { ReadinessResponse } from "@intrinsic/contracts";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "./database/prisma.service";
import { HEALTH_CHECK_TIMEOUT_MS, HealthController } from "./health.controller";
import {
  REDIS_ACCEPTED_EVICTION_POLICY,
  STOCK_DATA_REDIS,
} from "./stocks/stock-data.tokens";

/**
 * Readiness semantics, with both dependencies faked so each outcome is exact and fast. The real
 * wiring — PrismaService and the Redis client the stock slice exports — is exercised by every
 * AppModule-based integration suite, which boots the same controller.
 */
describe("health", () => {
  let app: INestApplication | undefined;

  async function boot(input: {
    query: () => Promise<unknown>;
    ping: () => Promise<unknown>;
    info?: (section: string) => Promise<string>;
    acceptedEvictionPolicy?: string | null;
  }): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: input.query } },
        {
          provide: STOCK_DATA_REDIS,
          useValue: {
            ping: input.ping,
            ...(input.info ? { info: input.info } : {}),
          },
        },
        { provide: HEALTH_CHECK_TIMEOUT_MS, useValue: 50 },
        ...(input.acceptedEvictionPolicy !== undefined
          ? [
              {
                provide: REDIS_ACCEPTED_EVICTION_POLICY,
                useValue: input.acceptedEvictionPolicy,
              },
            ]
          : []),
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    return app;
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reports liveness without touching any dependency", async () => {
    const query = vi.fn();
    const ping = vi.fn();
    const server = (await boot({ query, ping })).getHttpServer();

    const response = await request(server).get("/health").expect(200);

    expect(response.body).toEqual({ status: "ok", service: "api" });
    expect(query).not.toHaveBeenCalled();
    expect(ping).not.toHaveBeenCalled();
  });

  it("is ready when PostgreSQL and Redis both answer", async () => {
    const server = (
      await boot({
        query: async () => [{ "?column?": 1 }],
        ping: async () => "PONG",
      })
    ).getHttpServer();

    const response = await request(server).get("/health/ready").expect(200);
    const body = response.body as ReadinessResponse;

    expect(body.status).toBe("ok");
    expect(body.checks.postgres.status).toBe("ok");
    expect(body.checks.redis.status).toBe("ok");
    expect(body.checks.postgres.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is unavailable, with the failing dependency named, when Redis is down", async () => {
    const server = (
      await boot({
        query: async () => [{ "?column?": 1 }],
        ping: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      })
    ).getHttpServer();

    const response = await request(server).get("/health/ready").expect(503);
    const body = response.body as ReadinessResponse;

    expect(body.status).toBe("unavailable");
    expect(body.checks.postgres.status).toBe("ok");
    expect(body.checks.redis).toMatchObject({
      status: "failed",
      error: "connect ECONNREFUSED",
    });
  });

  it("is unavailable when PostgreSQL fails", async () => {
    const server = (
      await boot({
        query: async () => {
          throw new Error("the database system is starting up");
        },
        ping: async () => "PONG",
      })
    ).getHttpServer();

    const response = await request(server).get("/health/ready").expect(503);
    const body = response.body as ReadinessResponse;

    expect(body.checks.postgres).toMatchObject({
      status: "failed",
      error: "the database system is starting up",
    });
    expect(body.checks.redis.status).toBe("ok");
  });

  it("reports a hung dependency as failed instead of hanging the probe", async () => {
    const server = (
      await boot({
        query: async () => [{ "?column?": 1 }],
        ping: () => new Promise(() => undefined),
      })
    ).getHttpServer();

    const started = Date.now();
    const response = await request(server).get("/health/ready").expect(503);
    const body = response.body as ReadinessResponse;

    expect(body.checks.redis.status).toBe("failed");
    expect(body.checks.redis.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  describe("Redis eviction policy", () => {
    const healthy = {
      query: async () => [{ "?column?": 1 }],
      ping: async () => "PONG",
    };
    const memoryInfo = (policy: string, maxmemory: number) => async () =>
      `# Memory\r\nused_memory:1024\r\nmaxmemory:${maxmemory}\r\nmaxmemory_policy:${policy}\r\n`;

    it("is ready on noeviction and names the policy", async () => {
      const server = (
        await boot({ ...healthy, info: memoryInfo("noeviction", 1 << 30) })
      ).getHttpServer();

      const body = (await request(server).get("/health/ready").expect(200))
        .body as ReadinessResponse;

      expect(body.checks.redisEvictionPolicy).toMatchObject({
        status: "ok",
        verdict: "SAFE",
        policy: "noeviction",
      });
    });

    it("is unavailable on an allkeys policy nobody accepted, because it may evict the resident histories", async () => {
      const info = vi.fn(memoryInfo("allkeys-lru", 1 << 30));
      const server = (await boot({ ...healthy, info })).getHttpServer();

      const body = (await request(server).get("/health/ready").expect(503))
        .body as ReadinessResponse;

      expect(info).toHaveBeenCalledWith("memory");
      expect(body.status).toBe("unavailable");
      expect(body.checks.postgres.status).toBe("ok");
      expect(body.checks.redis.status).toBe("ok");
      expect(body.checks.redisEvictionPolicy).toMatchObject({
        status: "failed",
        verdict: "UNSAFE",
        policy: "allkeys-lru",
      });
      expect(body.checks.redisEvictionPolicy.error).toContain("allkeys-lru");
    });

    it("is ready on an allkeys policy the operator accepted explicitly", async () => {
      const server = (
        await boot({
          ...healthy,
          info: memoryInfo("allkeys-lru", 1 << 30),
          acceptedEvictionPolicy: "allkeys-lru",
        })
      ).getHttpServer();

      const body = (await request(server).get("/health/ready").expect(200))
        .body as ReadinessResponse;

      expect(body.checks.redisEvictionPolicy).toMatchObject({
        status: "ok",
        verdict: "ACCEPTED",
      });
    });

    it("does not let an acceptance for one policy cover another", async () => {
      const server = (
        await boot({
          ...healthy,
          info: memoryInfo("allkeys-random", 1 << 30),
          acceptedEvictionPolicy: "allkeys-lru",
        })
      ).getHttpServer();

      const body = (await request(server).get("/health/ready").expect(503))
        .body as ReadinessResponse;

      expect(body.checks.redisEvictionPolicy.verdict).toBe("UNSAFE");
    });

    it("tolerates a volatile policy and says why", async () => {
      const server = (
        await boot({ ...healthy, info: memoryInfo("volatile-lru", 1 << 30) })
      ).getHttpServer();

      const body = (await request(server).get("/health/ready").expect(200))
        .body as ReadinessResponse;

      expect(body.checks.redisEvictionPolicy).toMatchObject({
        status: "ok",
        verdict: "TOLERATED",
        policy: "volatile-lru",
      });
      expect(body.checks.redisEvictionPolicy.detail).toBeTruthy();
    });

    it("treats an allkeys policy without a memory limit as safe, since Redis then never evicts", async () => {
      const server = (
        await boot({ ...healthy, info: memoryInfo("allkeys-lru", 0) })
      ).getHttpServer();

      const body = (await request(server).get("/health/ready").expect(200))
        .body as ReadinessResponse;

      expect(body.checks.redisEvictionPolicy.verdict).toBe("SAFE");
    });

    it("reports a policy it cannot read as unknown, never as a failure", async () => {
      const server = (
        await boot({
          ...healthy,
          info: async () => {
            throw new Error("ERR unknown command 'INFO'");
          },
        })
      ).getHttpServer();

      const body = (await request(server).get("/health/ready").expect(200))
        .body as ReadinessResponse;

      expect(body.checks.redisEvictionPolicy).toMatchObject({
        status: "ok",
        verdict: "UNKNOWN",
      });
    });

    it("reports unknown for a client that cannot run INFO", async () => {
      const server = (await boot(healthy)).getHttpServer();

      const body = (await request(server).get("/health/ready").expect(200))
        .body as ReadinessResponse;

      expect(body.checks.redisEvictionPolicy.verdict).toBe("UNKNOWN");
    });

    it("bounds a hung INFO by the probe timeout", async () => {
      const server = (
        await boot({ ...healthy, info: () => new Promise(() => undefined) })
      ).getHttpServer();

      const started = Date.now();
      const body = (await request(server).get("/health/ready").expect(200))
        .body as ReadinessResponse;

      expect(body.checks.redisEvictionPolicy).toMatchObject({
        status: "ok",
        verdict: "UNKNOWN",
      });
      expect(body.checks.redisEvictionPolicy.detail).toContain("timed out");
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });
});

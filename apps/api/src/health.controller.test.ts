import type { ReadinessResponse } from "@intrinsic/contracts";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaService } from "./database/prisma.service";
import { HEALTH_CHECK_TIMEOUT_MS, HealthController } from "./health.controller";
import { STOCK_DATA_REDIS } from "./stocks/stock-data.tokens";

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
  }): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: input.query } },
        { provide: STOCK_DATA_REDIS, useValue: { ping: input.ping } },
        { provide: HEALTH_CHECK_TIMEOUT_MS, useValue: 50 },
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
});

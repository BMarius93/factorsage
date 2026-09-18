import type { RuntimeEnvironment } from "@intrinsic/config";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaService } from "./database/prisma.service";
import { HEALTH_CHECK_TIMEOUT_MS, HealthController } from "./health.controller";
import {
  API_SECURITY_HEADERS,
  API_STRICT_TRANSPORT_SECURITY,
  installSecurityHeaders,
} from "./security-headers";
import { STOCK_DATA_REDIS } from "./stocks/stock-data.tokens";

const WEB_ORIGIN = "https://app.example.test";

/**
 * SEC-001 on the API: the headers ride on success, on an error the controller produces, on a
 * route that does not exist and on a CORS preflight — and they leave CORS itself working.
 * Wired exactly as `main.ts` wires it; readiness is faked so the 503 is deterministic.
 */
describe("API security headers", () => {
  let app: INestApplication | undefined;

  async function boot(environment: RuntimeEnvironment) {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: async () => [] } },
        {
          provide: STOCK_DATA_REDIS,
          useValue: {
            ping: async () => {
              throw new Error("connect ECONNREFUSED");
            },
          },
        },
        { provide: HEALTH_CHECK_TIMEOUT_MS, useValue: 50 },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    installSecurityHeaders(app, environment);
    app.enableCors({ origin: [WEB_ORIGIN], credentials: true });
    await app.init();
    return app.getHttpServer();
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function expectBaseline(headers: Record<string, string>) {
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
      expect(headers[name.toLowerCase()], name).toBe(value);
    }
    expect(headers["x-powered-by"]).toBeUndefined();
  }

  it("sends the baseline on success, on an error and on an unknown route", async () => {
    const server = await boot("development");

    const ok = await request(server).get("/health").expect(200);
    const unavailable = await request(server).get("/health/ready").expect(503);
    const missing = await request(server).get("/no-such-route").expect(404);

    for (const response of [ok, unavailable, missing]) {
      expectBaseline(response.headers);
      expect(response.headers["strict-transport-security"]).toBeUndefined();
    }
  });

  it("leaves credentialed CORS working, preflight included", async () => {
    const server = await boot("development");

    const preflight = await request(server)
      .options("/health")
      .set("Origin", WEB_ORIGIN)
      .set("Access-Control-Request-Method", "GET")
      .expect(204);
    const actual = await request(server)
      .get("/health")
      .set("Origin", WEB_ORIGIN)
      .expect(200);

    for (const response of [preflight, actual]) {
      expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expectBaseline(response.headers);
    }
  });

  it("adds HSTS in production only", async () => {
    const server = await boot("production");

    const response = await request(server).get("/health").expect(200);

    expectBaseline(response.headers);
    expect(response.headers["strict-transport-security"]).toBe(
      API_STRICT_TRANSPORT_SECURITY,
    );
  });
});

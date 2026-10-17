import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NON_JSON_REQUEST_MESSAGE,
  installJsonOnlyRequests,
  isJsonMediaType,
} from "./json-only-requests";

const WEB_ORIGIN = "https://app.example.test";

@Controller("probe")
class ProbeController {
  @Post()
  @HttpCode(200)
  echo(@Body() body: unknown): unknown {
    return { received: body ?? null };
  }

  @Delete()
  @HttpCode(204)
  remove(): void {}

  @Get()
  read(): { ok: true } {
    return { ok: true };
  }
}

/**
 * SEC-01: only JSON reaches a state-changing route. Wired exactly as `main.ts` wires it — CORS
 * first, then the policy — so the refusal is checked together with the preflight and the JSON
 * request the web app really sends.
 */
describe("JSON-only state-changing requests", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableCors({ origin: [WEB_ORIGIN], credentials: true });
    installJsonOnlyRequests(app);
    // Bound to loopback, never left unlistened (`ai/workflows/validation.md`).
    await app.listen(0, "127.0.0.1");
  });

  afterAll(async () => {
    await app.close();
  });

  it("accepts JSON, with or without a charset", async () => {
    for (const contentType of [
      "application/json",
      "application/json; charset=utf-8",
      "Application/JSON",
    ]) {
      const response = await request(app.getHttpServer())
        .post("/probe")
        .set("content-type", contentType)
        .send(JSON.stringify({ email: "a@example.test" }))
        .expect(200);
      expect(response.body).toEqual({ received: { email: "a@example.test" } });
    }
  });

  it.each([
    [
      "a form",
      "application/x-www-form-urlencoded",
      "email=a%40example.test&password=x",
    ],
    ["a multipart form", "multipart/form-data; boundary=x", "--x\r\n\r\n--x--"],
    ["a text/plain form", "text/plain", '{"email":"a@example.test","x":"="}'],
    ["JSON under another media type", "application/vnd.api+json", "{}"],
  ])(
    "refuses %s with 415 before reading it",
    async (_label, contentType, body) => {
      const response = await request(app.getHttpServer())
        .post("/probe")
        .set("origin", "https://attacker.example")
        .set("content-type", contentType)
        .send(body)
        .expect(415);
      expect(response.body).toEqual({
        statusCode: 415,
        message: NON_JSON_REQUEST_MESSAGE,
        error: "Unsupported Media Type",
      });
    },
  );

  it("lets a bodyless request without a Content-Type through, as the web client sends a DELETE", async () => {
    await request(app.getHttpServer()).delete("/probe").expect(204);
    await request(app.getHttpServer()).post("/probe").expect(200);
  });

  it("leaves reads and CORS preflights alone", async () => {
    await request(app.getHttpServer())
      .get("/probe")
      .set("content-type", "application/x-www-form-urlencoded")
      .expect(200);
    const preflight = await request(app.getHttpServer())
      .options("/probe")
      .set("origin", WEB_ORIGIN)
      .set("access-control-request-method", "POST")
      .set("access-control-request-headers", "content-type")
      .expect(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
  });

  it("still answers the web origin with CORS headers when it refuses", async () => {
    const response = await request(app.getHttpServer())
      .post("/probe")
      .set("origin", WEB_ORIGIN)
      .set("content-type", "text/plain")
      .send("hello")
      .expect(415);
    expect(response.headers["access-control-allow-origin"]).toBe(WEB_ORIGIN);
  });

  it("recognises exactly the JSON media type", () => {
    expect(isJsonMediaType("application/json")).toBe(true);
    expect(isJsonMediaType(" application/json ;charset=UTF-8")).toBe(true);
    expect(isJsonMediaType("application/jsonp")).toBe(false);
    expect(isJsonMediaType("text/json")).toBe(false);
    expect(isJsonMediaType("")).toBe(false);
  });
});

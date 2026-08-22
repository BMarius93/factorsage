import { randomUUID } from "node:crypto";
import { getApiConfig, getAuthConfig, loadRootEnv } from "@intrinsic/config";
import { UserRole } from "@intrinsic/database";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { INVALID_CREDENTIALS_MESSAGE } from "./auth.service";
import { PasswordService } from "./password.service";
import { seedInitialAdmin } from "./seed-admin";

describe("authentication and role authorization", () => {
  const suffix = randomUUID();
  const password = "Local-test-password-42";
  const adminEmail = `admin-${suffix}@example.test`;
  const userEmail = `user-${suffix}@example.test`;
  const externalOnlyEmail = `external-${suffix}@example.test`;
  const seedEmail = `seed-${suffix}@example.test`;

  let app: INestApplication;
  let prisma: PrismaService;
  let passwords: PasswordService;

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";
    process.env.AUTH_TOKEN_TTL_SECONDS = "3600";
    process.env.AUTH_COOKIE_NAME = "test_auth";

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    const apiConfig = getApiConfig();
    app.enableCors({ origin: apiConfig.corsOrigins, credentials: true });
    await app.init();

    prisma = moduleRef.get(PrismaService);
    passwords = moduleRef.get(PasswordService);
    const passwordHash = await passwords.hash(password);

    await prisma.user.createMany({
      data: [
        { email: adminEmail, passwordHash, role: UserRole.ADMIN },
        { email: userEmail, passwordHash, role: UserRole.USER },
        { email: externalOnlyEmail, passwordHash: null, role: UserRole.USER },
      ],
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: {
          email: { in: [adminEmail, userEmail, externalOnlyEmail, seedEmail] },
        },
      });
    }
    if (app) {
      await app.close();
    }
  });

  it("uses secure cookies in production and non-secure cookies outside production", () => {
    const common = {
      AUTH_JWT_SECRET: "test-only-jwt-secret-that-is-at-least-32-characters",
    };

    expect(
      getAuthConfig({ ...common, NODE_ENV: "production" }).cookieSecure,
    ).toBe(true);
    expect(
      getAuthConfig({ ...common, NODE_ENV: "development" }).cookieSecure,
    ).toBe(false);
  });

  it("rejects wildcard credentialed CORS and normalizes configured origins", () => {
    expect(() => getApiConfig({ CORS_ORIGINS: "*" })).toThrow(
      "CORS_ORIGINS cannot contain '*'",
    );
    expect(
      getApiConfig({
        CORS_ORIGINS: "http://localhost:3000/,https://app.example.test",
      }).corsOrigins,
    ).toEqual(["http://localhost:3000", "https://app.example.test"]);
  });

  it("allows the configured browser origin with credentials", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ email: adminEmail, password })
      .expect(200);

    expect(response.headers["access-control-allow-origin"]).toBe(
      "http://localhost:3000",
    );
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("logs in an ADMIN with normalized credentials and returns only safe fields", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: `  ${adminEmail.toUpperCase()}  `, password })
      .expect(200);

    expect(response.body).toMatchObject({ email: adminEmail, role: "ADMIN" });
    expect(Object.keys(response.body).sort()).toEqual(["email", "id", "role"]);
    expect(response.headers["set-cookie"]?.[0]).toContain("test_auth=");
    expect(response.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]?.[0]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]?.[0]).not.toContain("Secure");
  });

  it("logs in a USER with valid credentials", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: userEmail, password })
      .expect(200);

    expect(response.body).toMatchObject({ email: userEmail, role: "USER" });
  });

  it("uses equivalent generic failures for wrong and unknown credentials", async () => {
    const wrongPassword = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: userEmail, password: "wrong" })
      .expect(401);
    const unknownEmail = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: `unknown-${suffix}@example.test`, password })
      .expect(401);

    expect(wrongPassword.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(unknownEmail.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it("does not allow password login for a user without a password hash", async () => {
    const response = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: externalOnlyEmail, password })
      .expect(401);

    expect(response.body.message).toBe(INVALID_CREDENTIALS_MESSAGE);
  });

  it("requires authentication for /auth/me", async () => {
    await request(app.getHttpServer()).get("/auth/me").expect(401);
  });

  it("returns the current safe user for a valid auth cookie", async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post("/auth/login")
      .send({ email: userEmail, password })
      .expect(200);

    const response = await agent.get("/auth/me").expect(200);
    expect(response.body).toMatchObject({ email: userEmail, role: "USER" });
    expect(Object.keys(response.body).sort()).toEqual(["email", "id", "role"]);
  });

  it("clears the cookie and leaves the browser session unauthenticated on logout", async () => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post("/auth/login")
      .send({ email: adminEmail, password })
      .expect(200);
    await agent.get("/auth/me").expect(200);

    const logout = await agent.post("/auth/logout").expect(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("test_auth=;");
    await agent.get("/auth/me").expect(401);
  });

  it("enforces anonymous, USER, and ADMIN access for /admin/health", async () => {
    await request(app.getHttpServer()).get("/admin/health").expect(401);

    const userAgent = request.agent(app.getHttpServer());
    await userAgent
      .post("/auth/login")
      .send({ email: userEmail, password })
      .expect(200);
    await userAgent.get("/admin/health").expect(403);

    const adminAgent = request.agent(app.getHttpServer());
    await adminAgent
      .post("/auth/login")
      .send({ email: adminEmail, password })
      .expect(200);
    const response = await adminAgent.get("/admin/health").expect(200);
    expect(response.body).toEqual({ status: "ok", role: "ADMIN" });
  });

  it("creates the bootstrap admin idempotently", async () => {
    const first = await seedInitialAdmin(prisma, passwords, {
      email: seedEmail.toUpperCase(),
      password,
    });
    const second = await seedInitialAdmin(prisma, passwords, {
      email: seedEmail,
      password,
    });
    const count = await prisma.user.count({ where: { email: seedEmail } });

    expect(second.id).toBe(first.id);
    expect(second.role).toBe("ADMIN");
    expect(count).toBe(1);
  });
});

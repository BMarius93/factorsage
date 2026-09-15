import { loadRootEnv } from "@intrinsic/config";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import {
  routeInventory,
  routeKey,
  type RouteDescriptor,
} from "../route-inventory";
import {
  RATE_LIMIT_POLICIES,
  UNDECLARED_ROUTE_POLICY,
} from "./rate-limit-policies";

// Compiling `AppModule` constructs `PrismaService`, so the test database must be selected first.
useTestDatabase();

/**
 * Rate-limit coverage — the suite that makes "every applicable route is protected" a fact rather
 * than a claim in a document.
 *
 * It compiles the **real** `AppModule`, enumerates every operation Nest actually mounts, and
 * requires each one to carry either a policy or a written exemption. A new controller added
 * without a `@RateLimit` declaration fails here on the day it is written, which is the only
 * mechanism that survives the author of this feature moving on.
 */
describe("rate-limit coverage", () => {
  let app: INestApplication;
  let routes: RouteDescriptor[];

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";

    const moduleRef = await Test.createTestingModule({
      // `DiscoveryModule` is the tooling dependency `routeInventory` needs; the running API does
      // not carry it.
      imports: [AppModule, DiscoveryModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    routes = routeInventory(app);
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it("mounts the routes this suite is meant to be checking", () => {
    // A guard against the inventory silently returning nothing — which would make every
    // assertion below vacuously true.
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.map(routeKey)).toContain("GET /stocks/search");
    expect(routes.map(routeKey)).toContain("POST /backtests");
  });

  it("declares a policy or a written exemption on every route", () => {
    const undeclared = routes
      .filter((route) => !route.policy && !route.exemptReason)
      .map(routeKey);

    expect(
      undeclared,
      "every route must carry @RateLimit(...) or @RateLimitExempt(reason)",
    ).toEqual([]);
  });

  it("never declares both a policy and an exemption on one route", () => {
    const conflicting = routes
      .filter((route) => route.policy && route.exemptReason)
      .map(routeKey);
    expect(conflicting).toEqual([]);
  });

  it("names only catalog policies", () => {
    const known = new Set(Object.keys(RATE_LIMIT_POLICIES));
    for (const route of routes) {
      if (route.policy) {
        expect(
          known.has(route.policy),
          `${routeKey(route)} -> ${route.policy}`,
        ).toBe(true);
      }
      expect(route.policy).not.toBe(UNDECLARED_ROUTE_POLICY);
    }
  });

  it("exempts only the two classes of non-user caller, with a reason", () => {
    const exempt = Object.fromEntries(
      routes
        .filter((route) => route.exemptReason)
        .map((route) => [routeKey(route), route.exemptReason as string]),
    );

    // Locked down exactly: an exemption is a decision, so adding one has to be deliberate enough
    // to edit this list. Orchestrator probes and the signature-authenticated Stripe webhook are
    // the only callers here that are not a person.
    expect(Object.keys(exempt).sort()).toEqual([
      "GET /health",
      "GET /health/ready",
      "POST /webhooks/stripe",
    ]);
    for (const [route, reason] of Object.entries(exempt)) {
      expect(reason.length, `${route} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("protects every credential and account-recovery route with the security policy", () => {
    // Named explicitly rather than derived from a path pattern: this is the list whose members
    // must never quietly become an ordinary read, and a pattern would silently accept a new
    // `/auth/*` route that should have been on it.
    const authSensitive = [
      "POST /auth/login",
      "POST /auth/register",
      "POST /auth/verify-email",
      "POST /auth/resend-verification",
      "POST /auth/forgot-password",
      "POST /auth/reset-password",
      "GET /auth/google",
      "GET /auth/google/callback",
    ];
    for (const key of authSensitive) {
      const route = routes.find((candidate) => routeKey(candidate) === key);
      expect(route, `${key} is not mounted`).toBeDefined();
      expect(route?.policy, key).toBe("auth-sensitive");
    }
  });

  it("keys unauthenticated-reachable routes by IP rather than by an absent user", () => {
    // A route with no cookie guard may be called by a guest, so its policy must not be one that
    // would silently share a single "no user" bucket between every anonymous caller.
    const guestReachable = routes.filter(
      (route) =>
        !route.exemptReason &&
        !route.guards.includes("CookieAuthGuard") &&
        !route.guards.includes("RolesGuard"),
    );
    expect(guestReachable.length).toBeGreaterThan(0);

    for (const route of guestReachable) {
      const policy =
        RATE_LIMIT_POLICIES[route.policy as keyof typeof RATE_LIMIT_POLICIES];
      // `user` falls back to the client IP when there is no session, so both actor kinds are
      // safe here; what would not be safe is a fixed key, and the type system has none.
      expect(["user", "ip"], routeKey(route)).toContain(policy.actor);
    }
  });

  it("gives every expensive or security-sensitive class its own policy", () => {
    const byPolicy = new Map<string, string[]>();
    for (const route of routes) {
      if (!route.policy) continue;
      byPolicy.set(route.policy, [
        ...(byPolicy.get(route.policy) ?? []),
        routeKey(route),
      ]);
    }

    // The point of a catalog is that classes with different costs do not share one number.
    expect(byPolicy.get("backtest-execution")).toEqual(["POST /backtests"]);
    expect(byPolicy.get("admin-operation")).toEqual([
      "POST /admin/securities/sync",
    ]);
    expect(byPolicy.get("progress-poll")).toEqual([
      "GET /backtests/:runId/progress",
    ]);
    expect(byPolicy.get("billing-mutation")?.sort()).toEqual([
      "POST /billing/change",
      "POST /billing/checkout",
      "POST /billing/portal",
    ]);
    // Split out on purpose: the client polls this one, its siblings are clicked.
    expect(byPolicy.get("billing-refresh")).toEqual(["POST /billing/refresh"]);
    expect(byPolicy.get("stock-read")?.length).toBe(5);
  });
});

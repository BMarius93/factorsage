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

// Compiling `AppModule` constructs `PrismaService`, so the test database must be selected first.
useTestDatabase();

/**
 * The Terms-acceptance allowlist, pinned.
 *
 * Two different failures are both dangerous and this suite catches each of them.
 *
 * A route added to the allowlist by accident is a hole in the gate. A route *removed* from it by
 * accident is worse in a different way: it traps a user who has declined, with no way to cancel
 * their subscription, exercise a statutory right, reach support or sign out. The specification is
 * explicit that the second must not happen, so the set is asserted exactly rather than as an
 * upper bound.
 *
 * Every entry is a deliberate decision, and the `@LegalAcceptanceExempt` reason on the route says
 * why in the place the next reader will look.
 */
const EXPECTED_EXEMPT_ROUTES: readonly string[] = [
  // Authentication: accepting needs a session, and signing out must never need an acceptance.
  "GET /auth/google",
  "GET /auth/google/callback",
  "GET /auth/me",
  "GET /auth/providers",
  "POST /auth/forgot-password",
  "POST /auth/login",
  "POST /auth/logout",
  "POST /auth/logout-all",
  "POST /auth/register",
  "POST /auth/resend-verification",
  "POST /auth/reset-password",
  "POST /auth/verify-email",

  // The advisory capability probe the shell issues on every navigation, including on the
  // acceptance screen itself. It grants nothing.
  "GET /entitlements",

  // Accepting, and the rights a declining user keeps.
  "GET /legal/acceptance",
  "POST /legal/acceptance",
  "GET /legal/requests",
  "POST /legal/requests",

  // Cancelling a renewal, and the honest status the cancellation page is rendered from.
  "GET /billing/status",
  "POST /billing/refresh",
  "POST /billing/portal",

  // Callers that are not a user at all.
  "GET /health",
  "GET /health/ready",
  "POST /webhooks/stripe",
];

/**
 * Routes that must be gated even though they look adjacent to an exempt one.
 *
 * Buying more product while refusing the Terms is exactly the thing the gate exists for, and a
 * future refactor that exempted the whole `BillingController` would silently allow it.
 */
const MUST_STAY_GATED: readonly string[] = [
  "POST /billing/checkout",
  "POST /billing/change",
  "GET /dashboard",
  "GET /monitors",
  "POST /monitors",
  "GET /lists",
  "POST /lists",
  "POST /backtests",
  "POST /strategies",
];

/**
 * Routes with no authentication guard at all.
 *
 * The gate reads the session the route's own guard resolved, so a route that resolves none is
 * public for everybody and cannot be gated — `/market-overview` serves the same index cards to a
 * Guest and to a signed-in visitor. Listing them here makes that a stated property rather than a
 * gap somebody later mistakes for a bypass.
 */
const UNAUTHENTICATED_ROUTES: readonly string[] = ["GET /market-overview"];

describe("legal acceptance coverage", () => {
  let app: INestApplication;
  let routes: RouteDescriptor[];

  beforeAll(async () => {
    loadRootEnv();
    process.env.NODE_ENV = "test";
    process.env.AUTH_JWT_SECRET =
      "test-only-jwt-secret-that-is-at-least-32-characters";

    const moduleRef = await Test.createTestingModule({
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
    // Guards against the inventory returning nothing, which would make everything below
    // vacuously true.
    expect(routes.length).toBeGreaterThan(40);
    expect(routes.map(routeKey)).toContain("POST /legal/acceptance");
  });

  it("exempts exactly the routes a declining user must still reach", () => {
    const exempt = routes
      .filter((route) => route.legalExemptReason)
      .map(routeKey)
      .sort();

    expect(exempt).toEqual([...EXPECTED_EXEMPT_ROUTES].sort());
  });

  it("gates every other mounted route by default", () => {
    const gated = routes
      .filter((route) => !route.legalExemptReason)
      .map(routeKey);

    for (const key of MUST_STAY_GATED) {
      expect(gated, `${key} must stay behind the acceptance gate`).toContain(
        key,
      );
    }
  });

  it("leaves genuinely public routes ungated, because they resolve no session", () => {
    for (const key of UNAUTHENTICATED_ROUTES) {
      const route = routes.find((candidate) => routeKey(candidate) === key);
      expect(route, `${key} must be mounted`).toBeDefined();
      expect(
        route?.guards ?? [],
        `${key} is listed as unauthenticated; if it gains a session guard it must be gated`,
      ).toEqual([]);
    }
  });

  it("gives every exemption a written reason", () => {
    const unexplained = routes
      .filter(
        (route) =>
          route.legalExemptReason !== undefined &&
          route.legalExemptReason.trim().length < 20,
      )
      .map(routeKey);

    expect(
      unexplained,
      "@LegalAcceptanceExempt(reason) must say why, not just that",
    ).toEqual([]);
  });
});

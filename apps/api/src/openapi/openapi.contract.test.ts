import { loadRootEnv } from "@intrinsic/config";
import { useTestDatabase } from "@intrinsic/testing";
import type { INestApplication } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { Validator } from "@seriousme/openapi-schema-validator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../app.module";
import {
  RATE_LIMIT_POLICIES,
  type RateLimitPolicyName,
} from "../rate-limit/rate-limit-policies";
import {
  routeInventory,
  routeKey,
  type RouteDescriptor,
} from "../route-inventory";
import {
  documentedOperations,
  loadOpenApiDocument,
  readOpenApiSource,
  toOpenApiPath,
  type OpenApiDocument,
  type OpenApiOperation,
} from "./openapi-document";

useTestDatabase();

/**
 * The suite that keeps `docs/openapi.yaml` honest.
 *
 * A checked-in specification rots the moment somebody adds a route and forgets it, and nothing
 * about a hand-written YAML file makes that visible in review. So the document is not trusted: this
 * compiles the **real** application, enumerates what Nest actually mounts, and requires the two to
 * agree — operation for operation, policy for policy, guard for guard.
 *
 * That is also the answer to keeping rate limiting and its documentation in step. The
 * `@RateLimit("…")` declaration a route carries is route metadata, so it can be read here and
 * compared with the operation's `x-rate-limit`; a policy renamed in code and not in the document,
 * or a `429` the document forgot, fails the build. It needs no code generation and no framework —
 * one declaration, read twice.
 */
describe("OpenAPI document describes the API that exists", () => {
  let app: INestApplication;
  let routes: RouteDescriptor[];
  let document: OpenApiDocument;
  let operations: Map<string, OpenApiOperation>;

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
    document = loadOpenApiDocument();
    operations = documentedOperations(document);
  }, 60_000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  describe("the document itself", () => {
    it("is a valid OpenAPI 3.1 document with every reference resolvable", async () => {
      // The same check `pnpm openapi:validate` runs, inside the gate so a broken document cannot
      // land through a route that skips the script.
      const validator = new Validator();
      const result = await validator.validate(readOpenApiSource());
      expect(result.errors ?? [], JSON.stringify(result.errors)).toEqual([]);
      expect(result.valid).toBe(true);
      expect(validator.version).toBe("3.1");
      // Throws on a `$ref` that names a component nobody wrote — a document can be schema-valid
      // and still break every consumer that way.
      expect(() => validator.resolveRefs()).not.toThrow();
    });
  });

  describe("coverage", () => {
    it("documents every mounted operation", () => {
      const missing = routes
        .map(routeKey)
        .filter((key) => !operations.has(key))
        .sort();
      expect(missing, "routes that exist but are not documented").toEqual([]);
    });

    it("invents no operation the API does not serve", () => {
      const mounted = new Set(routes.map(routeKey));
      const invented = [...operations.keys()]
        .filter((key) => !mounted.has(key))
        .sort();
      expect(
        invented,
        "documented operations with no route behind them",
      ).toEqual([]);
    });

    it("gives every operation a unique operationId and a summary", () => {
      const ids = new Set<string>();
      for (const [key, operation] of operations) {
        expect(
          operation.operationId,
          `${key} needs an operationId`,
        ).toBeTruthy();
        expect(
          ids.has(operation.operationId as string),
          `duplicate operationId on ${key}`,
        ).toBe(false);
        ids.add(operation.operationId as string);
        expect(operation.summary, `${key} needs a summary`).toBeTruthy();
      }
    });
  });

  describe("success responses", () => {
    /**
     * Two handlers take over the response object and redirect, so Nest's declared status is `200`
     * while the wire carries `302`. Listed explicitly rather than pattern-matched: an exemption
     * from a correctness check should cost somebody an edit.
     */
    const REDIRECTS = new Set([
      "GET /auth/google",
      "GET /auth/google/callback",
    ]);

    it("documents the status the handler will actually answer with", () => {
      // The cheapest high-value check available here, and one a hand-written document gets wrong
      // easily: `POST` defaults to `201`, `@HttpCode(202)` on submission, `204` on deletes. Reading
      // it from the same metadata Nest routes with means the document cannot claim `200` for a
      // route that answers `202`.
      const wrong: string[] = [];
      for (const route of routes) {
        const key = routeKey(route);
        if (REDIRECTS.has(key)) {
          continue;
        }
        const documented = Object.keys(
          operations.get(key)?.responses ?? {},
        ).filter((status) => status.startsWith("2"));
        if (!documented.includes(String(route.successStatus))) {
          wrong.push(
            `${key}: answers ${route.successStatus}, documents ${documented.join(", ") || "no 2xx"}`,
          );
        }
      }
      expect(wrong).toEqual([]);
    });

    it("documents exactly one success status per operation", () => {
      // More than one 2xx on a route that can only answer one is a copy-paste, and it makes the
      // document unusable for generating a client.
      for (const route of routes) {
        if (REDIRECTS.has(routeKey(route))) {
          continue;
        }
        const documented = Object.keys(
          operations.get(routeKey(route))?.responses ?? {},
        ).filter((status) => status.startsWith("2"));
        expect(documented.length, routeKey(route)).toBe(1);
      }
    });

    it("gives every documented error response a machine-readable body", () => {
      // A 4xx or 5xx documented as bare prose leaves a client with nothing to branch on, which is
      // the whole point of the shared error shape.
      const bare: string[] = [];
      for (const [key, operation] of operations) {
        for (const [status, response] of Object.entries(
          operation.responses ?? {},
        )) {
          if (!/^[45]/.test(status)) {
            continue;
          }
          const body = response as {
            $ref?: string;
            content?: Record<string, { schema?: unknown }>;
          };
          if (body.$ref) {
            continue; // A shared component; its own body is defined once.
          }
          if (!body.content?.["application/json"]?.schema) {
            bare.push(`${key} -> ${status}`);
          }
        }
      }
      expect(bare).toEqual([]);
    });
  });

  describe("rate limiting is documented from the same declaration it is enforced from", () => {
    it("names the policy each route actually declares", () => {
      for (const route of routes) {
        const operation = operations.get(routeKey(route));
        expect(operation, routeKey(route)).toBeDefined();
        const documented = operation?.["x-rate-limit"];
        expect(
          documented,
          `${routeKey(route)} has no x-rate-limit`,
        ).toBeDefined();

        if (route.policy) {
          expect(documented?.policy, routeKey(route)).toBe(route.policy);
          expect(documented?.exempt).toBeUndefined();
        } else {
          // An exempt route documents the exemption and its reason, never a policy.
          expect(documented?.exempt, routeKey(route)).toBe(true);
          expect(documented?.policy).toBeUndefined();
          expect((documented?.reason ?? "").length).toBeGreaterThan(40);
        }
      }
    });

    it("documents 429 on every rate-limited operation and on no exempt one", () => {
      for (const route of routes) {
        const responses = operations.get(routeKey(route))?.responses ?? {};
        if (route.policy) {
          expect(
            Object.keys(responses),
            `${routeKey(route)} is rate limited and must document 429`,
          ).toContain("429");
        } else {
          expect(
            Object.keys(responses),
            `${routeKey(route)} is exempt and must not document 429`,
          ).not.toContain("429");
        }
      }
    });

    it("documents 503 exactly where a policy fails closed", () => {
      for (const route of routes) {
        if (!route.policy) {
          continue;
        }
        const policy = RATE_LIMIT_POLICIES[route.policy];
        if (policy.onRedisFailure !== "deny") {
          continue;
        }
        const responses = operations.get(routeKey(route))?.responses ?? {};
        expect(
          Object.keys(responses),
          `${routeKey(route)} fails closed and must document 503`,
        ).toContain("503");
      }
    });

    it("mirrors the policy catalog number for number", () => {
      const documented = document.info["x-rate-limit-policies"] ?? {};
      // Every declarable policy is documented; the internal fallback is not part of the API.
      const declarable = Object.keys(RATE_LIMIT_POLICIES).filter(
        (name) => name !== "undeclared",
      );
      expect(Object.keys(documented).sort()).toEqual(declarable.sort());

      for (const name of declarable) {
        const policy = RATE_LIMIT_POLICIES[name as RateLimitPolicyName];
        const entry = documented[name];
        expect(entry, name).toBeDefined();
        expect(entry?.actor, `${name}.actor`).toBe(policy.actor);
        expect(entry?.points, `${name}.points`).toBe(policy.points);
        expect(entry?.durationSeconds, `${name}.durationSeconds`).toBe(
          policy.durationSeconds,
        );
        expect(entry?.onRedisFailure, `${name}.onRedisFailure`).toBe(
          policy.onRedisFailure,
        );
        expect(entry?.description, `${name}.description`).toBe(
          policy.description,
        );
        const secondary = "secondary" in policy ? policy.secondary : undefined;
        expect(entry?.secondary, `${name}.secondary`).toEqual(
          secondary
            ? {
                actor: secondary.actor,
                points: secondary.points,
                durationSeconds: secondary.durationSeconds,
              }
            : undefined,
        );
      }
    });

    it("never restates an allowance in prose", () => {
      // The drift this prevents actually happened: the catalog moved from ten attempts per five
      // minutes to twenty, the machine-checked `x-rate-limit-policies` block moved with it, and a
      // tag description a few lines above kept saying ten. Nothing read that sentence.
      //
      // So the numbers live in exactly two verified places — the catalog, and the block below it
      // that this suite compares with the catalog — and prose says what a policy is *for*. This
      // scans every human-readable string in the document for "some quantity per some time" and
      // fails on it.
      const offenders: string[] = [];
      const claim =
        /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty|forty|fifty|sixty|ninety|hundred|\d{1,6})\b[^.]{0,40}?\b(?:per|an|each|a)\s+(?:(?:\d+|two|three|four|five|ten|fifteen|twenty|thirty|sixty)\s+)?(?:seconds?|minutes?|hours?|days?)\b/i;

      const walk = (node: unknown, path: string): void => {
        if (typeof node === "string") {
          if (
            (path.endsWith(".description") || path.endsWith(".summary")) &&
            claim.test(node)
          ) {
            offenders.push(`${path}: ${claim.exec(node)?.[0] ?? node}`);
          }
          return;
        }
        if (Array.isArray(node)) {
          node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
          return;
        }
        if (node && typeof node === "object") {
          for (const [key, value] of Object.entries(node)) {
            walk(value, `${path}.${key}`);
          }
        }
      };
      walk(document, "$");

      expect(
        offenders,
        "state allowances only in info.x-rate-limit-policies, which is checked against the catalog",
      ).toEqual([]);
    });

    it("lists every catalog policy in the error schema clients branch on", () => {
      const schemas = (document.components?.schemas ?? {}) as Record<
        string,
        { allOf?: Array<{ properties?: { policy?: { enum?: string[] } } }> }
      >;
      const enumerated =
        schemas.RateLimitError?.allOf?.[1]?.properties?.policy?.enum ?? [];
      expect(enumerated.sort()).toEqual(
        Object.keys(RATE_LIMIT_POLICIES)
          .filter((name) => name !== "undeclared")
          .sort(),
      );
    });
  });

  describe("authentication and authorization are documented from the guards", () => {
    it("declares cookie authentication exactly where a session is required", () => {
      for (const route of routes) {
        const operation = operations.get(routeKey(route));
        const schemes = (operation?.security ?? []).flatMap((entry) =>
          Object.keys(entry),
        );
        const requiresSession = route.guards.includes("CookieAuthGuard");
        expect(
          schemes.includes("cookieAuth"),
          `${routeKey(route)}: guard says ${requiresSession}, document says ${schemes.join(",") || "none"}`,
        ).toBe(requiresSession);
      }
    });

    it("documents 401 on every session-required operation", () => {
      for (const route of routes) {
        if (!route.guards.includes("CookieAuthGuard")) {
          continue;
        }
        expect(
          Object.keys(operations.get(routeKey(route))?.responses ?? {}),
          `${routeKey(route)} requires a session and must document 401`,
        ).toContain("401");
      }
    });

    it("documents 403 on every role-guarded operation", () => {
      const roleGuarded = routes.filter((route) =>
        route.guards.includes("RolesGuard"),
      );
      expect(roleGuarded.length).toBeGreaterThan(0);
      for (const route of roleGuarded) {
        expect(
          Object.keys(operations.get(routeKey(route))?.responses ?? {}),
          `${routeKey(route)} is role-guarded and must document 403`,
        ).toContain("403");
      }
    });

    it("documents 403 on every operation the Terms-acceptance gate can refuse", () => {
      // The gate reads the session a route's own guard resolved, so any route with either cookie
      // guard can answer `403 LEGAL_ACCEPTANCE_REQUIRED` for a signed-in caller who has not
      // accepted — including the read-only ones a Guest may also call. A route that documents no
      // `403` would be telling an integrator that status is impossible.
      const gated = routes.filter(
        (route) =>
          !route.legalExemptReason &&
          (route.guards.includes("CookieAuthGuard") ||
            route.guards.includes("OptionalCookieAuthGuard")),
      );
      expect(gated.length).toBeGreaterThan(0);
      for (const route of gated) {
        expect(
          Object.keys(operations.get(routeKey(route))?.responses ?? {}),
          `${routeKey(route)} is behind the acceptance gate and must document 403`,
        ).toContain("403");
      }
    });

    it("declares no session on a route a guest may call", () => {
      // The inverse of the first case, stated separately because the failure mode is different:
      // documenting authentication on a public route sends integrators looking for a cookie they
      // do not need, and hides that the route is reachable by anyone.
      const guestReachable = routes.filter(
        (route) => !route.guards.includes("CookieAuthGuard"),
      );
      for (const route of guestReachable) {
        const schemes = (
          operations.get(routeKey(route))?.security ?? []
        ).flatMap((entry) => Object.keys(entry));
        expect(schemes.includes("cookieAuth"), routeKey(route)).toBe(false);
      }
    });
  });

  describe("path parameters", () => {
    it("declares every path parameter the route template contains", () => {
      for (const route of routes) {
        const expected = [...route.path.matchAll(/:([A-Za-z0-9_]+)/g)].flatMap(
          (match) => (match[1] ? [match[1]] : []),
        );
        if (expected.length === 0) {
          continue;
        }
        const openApiPath = toOpenApiPath(route.path);
        const item = document.paths[openApiPath] as
          Record<string, unknown> | undefined;
        expect(
          item,
          `${openApiPath} is missing from the document`,
        ).toBeDefined();

        // Parameters may sit on the path item or on the operation; both count.
        const serialized = JSON.stringify([
          item?.parameters ?? [],
          (item?.[route.method.toLowerCase()] as { parameters?: unknown })
            ?.parameters ?? [],
        ]);
        for (const name of expected) {
          // Either declared inline by name, or referenced as a shared component whose name is the
          // capitalised parameter (`#/components/parameters/ListId`).
          const component = `/${name.charAt(0).toUpperCase()}${name.slice(1)}"`;
          expect(
            serialized.includes(`"${name}"`) || serialized.includes(component),
            `${routeKey(route)} does not declare path parameter \`${name}\``,
          ).toBe(true);
        }
      }
    });
  });
});

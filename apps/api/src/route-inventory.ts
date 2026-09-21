import type { INestApplication, Type } from "@nestjs/common";
import { RequestMethod } from "@nestjs/common";
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { LEGAL_ACCEPTANCE_EXEMPT_KEY } from "./legal/legal-acceptance.decorator";
import {
  UNDECLARED_ROUTE_POLICY,
  type RateLimitPolicyName,
} from "./rate-limit/rate-limit-policies";
import {
  RATE_LIMIT_EXEMPT_KEY,
  RATE_LIMIT_POLICY_KEY,
} from "./rate-limit/rate-limit.decorator";

/**
 * One HTTP operation this API actually serves, with the declarations attached to it.
 *
 * Built by walking the compiled Nest application rather than by reading source, so it describes
 * what is **mounted** — a controller left out of a module, or a route shadowed by another, is
 * absent here exactly as it is absent at runtime.
 *
 * Three suites consume it, and between them they are what keep four things from drifting apart:
 * `rate-limit-coverage.test.ts` proves every operation declares a policy or an exemption,
 * `legal-acceptance-coverage.test.ts` proves the Terms-acceptance allowlist is exactly the set of
 * routes a declining user must keep, and `openapi.contract.test.ts` proves `docs/openapi.yaml`
 * documents these operations and no others, with the `429` and authentication semantics these
 * declarations imply.
 */
export type RouteDescriptor = {
  /** Uppercase HTTP method. */
  readonly method: string;
  /** Mounted path with Nest's `:param` segments, always leading-slashed. */
  readonly path: string;
  readonly controller: string;
  readonly handler: string;
  /** The declared policy, or `undefined` when the route declares none. */
  readonly policy?: RateLimitPolicyName;
  /** The reason text from `@RateLimitExempt`, when the route is exempt. */
  readonly exemptReason?: string;
  /**
   * The reason text from `@LegalAcceptanceExempt`, when the route stays reachable for a signed-in
   * user who has not accepted the required Terms version. Absent means the route is gated, which
   * is the default for every route.
   */
  readonly legalExemptReason?: string;
  /** Names of the guards applied at controller or method level, in Nest's order. */
  readonly guards: readonly string[];
  /**
   * The status a successful call answers with: the explicit `@HttpCode(...)`, or Nest's default of
   * `201` for `POST` and `200` for everything else.
   *
   * Carried so the OpenAPI document's success status can be compared with the one the application
   * will actually send, rather than with the one whoever wrote the document assumed. A handler that
   * takes over the response object — the OAuth redirects — is the one case this cannot see.
   */
  readonly successStatus: number;
};

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.ALL]: "ALL",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
};

/**
 * Every operation the given application mounts, sorted by path then method.
 *
 * Nest's own `DiscoveryService` provides the controllers and `Reflector` reads the same metadata
 * the interceptor reads at runtime, so a route's inventory entry and its enforcement can never
 * disagree about which policy applies.
 *
 * The application must have `DiscoveryModule` in its graph. It is deliberately not imported by
 * `AppModule`: discovery exists for tooling, and the running API has no use for it, so the two
 * callers add it to their own testing module instead of the production graph carrying a dependency
 * only they need. `MetadataScanner` and `Reflector` are plain classes and are constructed here.
 */
export function routeInventory(app: INestApplication): RouteDescriptor[] {
  const discovery = app.get(DiscoveryService, { strict: false });
  const scanner = new MetadataScanner();
  const reflector = new Reflector();

  const routes: RouteDescriptor[] = [];

  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as Type<object> | undefined;
    if (!controller?.prototype) {
      continue;
    }
    const basePath = normalize(
      (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ??
        "",
    );

    for (const handlerName of scanner.getAllMethodNames(controller.prototype)) {
      const handler = (
        controller.prototype as Record<string, (...args: unknown[]) => unknown>
      )[handlerName];
      if (typeof handler !== "function") {
        continue;
      }
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
        number | undefined;
      const routePath = Reflect.getMetadata(PATH_METADATA, handler) as
        string | undefined;
      if (verb === undefined || routePath === undefined) {
        continue;
      }

      const policy = reflector.getAllAndOverride<RateLimitPolicyName>(
        RATE_LIMIT_POLICY_KEY,
        [handler, controller],
      );
      const exemptReason = reflector.getAllAndOverride<string>(
        RATE_LIMIT_EXEMPT_KEY,
        [handler, controller],
      );
      const legalExemptReason = reflector.getAllAndOverride<string>(
        LEGAL_ACCEPTANCE_EXEMPT_KEY,
        [handler, controller],
      );

      const method = METHOD_NAMES[verb] ?? String(verb);
      const explicitStatus = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handler,
      ) as number | undefined;

      routes.push({
        method,
        path: join(basePath, normalize(routePath)),
        controller: controller.name,
        handler: handlerName,
        ...(policy && policy !== UNDECLARED_ROUTE_POLICY ? { policy } : {}),
        ...(exemptReason ? { exemptReason } : {}),
        ...(legalExemptReason ? { legalExemptReason } : {}),
        guards: guardNames(controller, handler),
        successStatus: explicitStatus ?? (method === "POST" ? 201 : 200),
      });
    }
  }

  return routes.sort((a, b) =>
    a.path === b.path
      ? a.method.localeCompare(b.method)
      : a.path.localeCompare(b.path),
  );
}

/** `GET /stocks/search` — the stable identity a document or a report refers to a route by. */
export function routeKey(
  route: Pick<RouteDescriptor, "method" | "path">,
): string {
  return `${route.method} ${route.path}`;
}

function guardNames(controller: Type<object>, handler: unknown): string[] {
  const collected = [
    ...((Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[]) ?? []),
    ...((Reflect.getMetadata(
      GUARDS_METADATA,
      handler as object,
    ) as unknown[]) ?? []),
  ];
  return collected.map((guard) =>
    typeof guard === "function"
      ? guard.name
      : ((guard as { constructor?: { name?: string } })?.constructor?.name ??
        String(guard)),
  );
}

function normalize(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `/${trimmed}`;
}

function join(base: string, path: string): string {
  const joined = `${base}${path}`;
  return joined === "" ? "/" : joined;
}

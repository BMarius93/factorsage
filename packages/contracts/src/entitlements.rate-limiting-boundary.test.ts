import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLAN_ENTITLEMENTS,
  resolveEntitlements,
  USER_PLANS,
} from "./entitlements.js";

/**
 * Entitlements and rate limiting are separate mechanisms, and this suite is what keeps them that
 * way.
 *
 * `docs/decisions/entitlements-v1.md` section 10 draws the line: entitlements answer whether an
 * identity may perform a class of operation and within what product limits; rate limiting answers
 * whether an already-permitted caller is calling too often. Modelling request rate as a commercial
 * entitlement is the specific mistake it forbids — it would make "requests per minute" a thing a
 * plan sells, and would put an abuse control on the same code path as a billing decision.
 *
 * **This repository has no HTTP rate limiting to point at.** Discovery found only the outbound FMP
 * provider gate, which throttles *this system's* calls to a vendor and has nothing to do with
 * callers. The decision document is explicit that exact request-rate numbers are operational
 * configuration rather than part of the commercial matrix, so none are invented here. What is
 * testable today, and what actually protects the boundary, is that the entitlement surface carries
 * no request-rate concept at all — so whenever a rate limiter is introduced it cannot be wired
 * into a plan by accident.
 */

const RATE_VOCABULARY = [
  "ratelimit",
  "rate_limit",
  "requestsper",
  "perminute",
  "persecond",
  "perhour",
  "throttle",
  "burst",
  "quota",
  "cooldown",
  "windowms",
];

/** Every leaf key path of the resolved entitlement structure. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, nested]) =>
    keyPaths(nested, prefix ? `${prefix}.${key}` : key),
  );
}

describe("entitlements do not model request rate", () => {
  it("exposes no rate, throttle, quota or window field on any tier", () => {
    for (const entitlements of [
      resolveEntitlements({ kind: "GUEST" }),
      ...USER_PLANS.map((plan) => PLAN_ENTITLEMENTS[plan]),
    ]) {
      for (const path of keyPaths(entitlements)) {
        const normalized = path.toLowerCase().replace(/[^a-z]/g, "");
        for (const term of RATE_VOCABULARY) {
          expect(
            normalized.includes(term),
            `entitlement field \`${path}\` looks like a rate-limit concept`,
          ).toBe(false);
        }
      }
    }
  });

  it("differs between plans only in product capacity, never in call frequency", () => {
    const free = PLAN_ENTITLEMENTS.FREE;
    const pro = PLAN_ENTITLEMENTS.PRO;
    const differing = keyPaths(free).filter((path) => {
      const read = (source: unknown) =>
        path
          .split(".")
          .reduce<unknown>(
            (value, key) => (value as Record<string, unknown>)?.[key],
            source,
          );
      return read(free) !== read(pro);
    });

    // Exactly the capacity bounds, and nothing resembling a request budget.
    expect(differing.sort()).toEqual([
      "backtests.maxConcurrentRuns",
      "backtests.maxHistoricalYears",
      "backtests.maxSymbols",
      "lists.maxSymbols",
      "monitors.maxActive",
      "tier",
    ]);
  });

  it("keeps the entitlement module free of any rate-limiting dependency", () => {
    const source = readFileSync(
      join(__dirname, "entitlements.ts"),
      "utf8",
    ).toLowerCase();

    // Prose explaining the separation is expected; an import or an identifier is not.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    for (const term of RATE_VOCABULARY) {
      expect(
        code.replace(/[^a-z]/g, "").includes(term),
        `entitlements.ts references \`${term}\` outside a comment`,
      ).toBe(false);
    }
    // And the module's only dependency is a type. There is nothing here that could reach a
    // request, a clock, a store or a counter — the three things a rate limiter needs.
    const imports = code
      .split("\n")
      .filter((line) => line.trimStart().startsWith("import"));
    expect(imports).toEqual(['import type { userrole } from "./index.js";']);
  });

  it("resolves entitlements with no caller, IP, device or request in scope", () => {
    // The resolver's whole input is a principal. A rate limiter's input — who is calling, from
    // where, how often — is structurally absent, so the two cannot be conflated by a later edit
    // without changing this signature.
    const entitlements = resolveEntitlements({
      kind: "AUTHENTICATED",
      userId: "user-1",
      plan: "FREE",
      role: "USER",
    });
    expect(entitlements.tier).toBe("FREE");
    expect(resolveEntitlements.length).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { isReachableWhileTermsOutstanding } from "./LegalAcceptanceGate";

/**
 * The routes a user who has not accepted the Terms must still be able to open.
 *
 * Asserted as a list rather than by reading the regexes back, because the failure this protects
 * against is not "the pattern is wrong" but "somebody narrowed the allowlist and trapped a paying
 * customer with no way to cancel". The server's own allowlist is pinned the same way, in
 * `apps/api/src/legal/legal-acceptance-coverage.test.ts`, and the two are deliberately about the
 * same set.
 */
describe("routes reachable while an acceptance is outstanding", () => {
  it("keeps every legal document readable", () => {
    for (const path of [
      "/terms",
      "/privacy",
      "/cookies",
      "/risk-disclosure",
      "/cancellation-and-refunds",
      "/contact",
    ]) {
      expect(isReachableWhileTermsOutstanding(path), path).toBe(true);
    }
  });

  it("keeps cancellation, statutory requests and support reachable", () => {
    // Billing is where a renewal is cancelled, and `/legal/*` holds the acceptance screen and the
    // request channels. A gate that blocked these would be worse than no gate.
    expect(isReachableWhileTermsOutstanding("/billing")).toBe(true);
    expect(isReachableWhileTermsOutstanding("/legal/requests")).toBe(true);
    expect(isReachableWhileTermsOutstanding("/legal/accept")).toBe(true);
  });

  it("gates the product itself", () => {
    for (const path of [
      // The Dashboard, at the product's canonical home, and at the address it still answers
      // through the redirect.
      "/",
      "/dashboard",
      "/lists",
      "/lists/42",
      "/strategies",
      "/strategies/new",
      "/monitors",
      "/backtests",
      "/backtests/new",
      "/stocks",
      "/stocks/AAPL",
      "/pricing",
      "/admin",
    ]) {
      expect(isReachableWhileTermsOutstanding(path), path).toBe(false);
    }
  });

  it("matches on the path alone, ignoring a query string, hash or trailing slash", () => {
    expect(isReachableWhileTermsOutstanding("/cookies#storage-settings")).toBe(
      true,
    );
    expect(isReachableWhileTermsOutstanding("/terms/")).toBe(true);
    expect(isReachableWhileTermsOutstanding("/billing?checkout=success")).toBe(
      true,
    );
    // And a lookalike path is not the real one.
    expect(isReachableWhileTermsOutstanding("/terms-and-conditions")).toBe(
      false,
    );
    expect(isReachableWhileTermsOutstanding("/billing-history")).toBe(false);
  });
});

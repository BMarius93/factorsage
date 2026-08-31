import type { Security } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SECURITY_SEARCH_LIMIT,
  MAX_SECURITY_SEARCH_LIMIT,
  normalizeSearchTerm,
  rankSecurityMatches,
  resolveSecuritySearchLimit,
} from "./security-search.js";

function security(
  symbol: string,
  name: string,
  overrides: Partial<Security> = {},
): Security {
  return {
    id: `id-${symbol}`,
    symbol,
    name,
    exchangeCode: "NASDAQ",
    currency: "USD",
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
    ...overrides,
  };
}

function symbolsOf(results: readonly Security[]): string[] {
  return results.map((result) => result.symbol);
}

describe("normalizeSearchTerm", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeSearchTerm("  apple   inc  ")).toBe("apple inc");
  });

  it("reduces whitespace-only input to an empty term", () => {
    expect(normalizeSearchTerm("   \t ")).toBe("");
  });
});

describe("resolveSecuritySearchLimit", () => {
  it("defaults to the dropdown-sized limit", () => {
    expect(resolveSecuritySearchLimit()).toBe(DEFAULT_SECURITY_SEARCH_LIMIT);
    expect(resolveSecuritySearchLimit(Number.NaN)).toBe(
      DEFAULT_SECURITY_SEARCH_LIMIT,
    );
  });

  it("clamps to the supported range", () => {
    expect(resolveSecuritySearchLimit(0)).toBe(1);
    expect(resolveSecuritySearchLimit(500)).toBe(MAX_SECURITY_SEARCH_LIMIT);
  });
});

describe("rankSecurityMatches", () => {
  it("matches case-insensitively on symbol and name", () => {
    const results = rankSecurityMatches(
      "AAP",
      [security("AAPL", "Apple Inc."), security("MSFT", "Microsoft Corp.")],
      8,
    );

    expect(symbolsOf(results)).toEqual(["AAPL"]);
  });

  it("ranks an exact symbol above other symbol prefixes", () => {
    const results = rankSecurityMatches(
      "aap",
      [security("AAPD", "Apple Bear ETF"), security("AAP", "Advance Auto")],
      8,
    );

    expect(symbolsOf(results)).toEqual(["AAP", "AAPD"]);
  });

  it("ranks symbol-prefix matches above name matches", () => {
    const results = rankSecurityMatches(
      "app",
      [
        security("GOOG", "Alphabet, an app company"),
        security("APPF", "AppFolio"),
      ],
      8,
    );

    expect(symbolsOf(results)).toEqual(["APPF", "GOOG"]);
  });

  it("ranks a name prefix above a mid-name word match", () => {
    const results = rankSecurityMatches(
      "micro",
      [
        security("AMD", "Advanced Micro Devices"),
        security("MSFT", "Microsoft Corporation"),
      ],
      8,
    );

    expect(symbolsOf(results)).toEqual(["MSFT", "AMD"]);
  });

  it("keeps inactive listings reachable but below tradable ones", () => {
    const results = rankSecurityMatches(
      "ap",
      [
        security("APX", "Apex Old", { isActivelyTrading: false }),
        security("APY", "Apex New"),
      ],
      8,
    );

    expect(symbolsOf(results)).toEqual(["APY", "APX"]);
  });

  it("truncates to the requested limit", () => {
    const candidates = Array.from({ length: 25 }, (_, index) =>
      security(`AA${index}`, `Alpha ${index}`),
    );

    expect(rankSecurityMatches("aa", candidates, 8)).toHaveLength(8);
  });

  it("drops candidates that do not actually match the term", () => {
    const results = rankSecurityMatches(
      "aapl",
      [security("MSFT", "Microsoft Corporation")],
      8,
    );

    expect(results).toEqual([]);
  });

  it("returns nothing for a whitespace-only term", () => {
    expect(
      rankSecurityMatches("   ", [security("AAPL", "Apple Inc.")], 8),
    ).toEqual([]);
  });
});

import type { Security } from "@intrinsic/domain";
import { FmpSecurityScope, type MappedFmpProfile } from "@intrinsic/fmp";
import { StockDataNotFoundError } from "@intrinsic/stock-data";
import { describe, expect, it, vi } from "vitest";
import {
  ApprovedSecurityListings,
  resolveLiveFmpSecurities,
  type LiveFmpAdmissionOutcome,
} from "./fmp-live-identity";

/**
 * Symbols to catalog securities: what is asked of the provider to learn an identity (at most one
 * profile per symbol the catalog lacks), and how the scope ends up bound to securities rather than
 * to strings. The catalog here is a map; the integration suite runs the same path on PostgreSQL.
 */

function security(symbol: string, overrides: Partial<Security> = {}): Security {
  return {
    id: `security-${symbol}`,
    symbol,
    name: `${symbol} Inc.`,
    exchangeCode: "NASDAQ",
    currency: "USD",
    type: "STOCK",
    isAdr: false,
    isActivelyTrading: true,
    ...overrides,
  };
}

function profile(
  symbol: string,
  overrides: Partial<MappedFmpProfile["security"]> = {},
): MappedFmpProfile {
  return {
    providerSymbol: symbol,
    security: {
      symbol,
      name: `${symbol} Inc.`,
      exchangeCode: "NASDAQ",
      exchangeName: "NASDAQ Global Select",
      currency: "USD",
      country: "US",
      sector: "Technology",
      industry: "Software",
      type: "STOCK",
      isAdr: false,
      isActivelyTrading: true,
      ...overrides,
    },
    profile: {},
  } as MappedFmpProfile;
}

/** A catalog lookup with the canonical service's contract: a security, or not-found. */
function catalog(initial: Security[] = []) {
  const rows = new Map(initial.map((row) => [row.symbol, row]));
  return {
    rows,
    getSecurity: vi.fn(async (symbol: string) => {
      const row = rows.get(symbol);
      if (!row) {
        throw new StockDataNotFoundError(symbol);
      }
      return row;
    }),
  };
}

const scopeOf = (symbols: string[]) =>
  new FmpSecurityScope(symbols, { maxSecurities: 3 });

describe("approved security listings", () => {
  it("asks for one profile per approved symbol, once, however many exchanges are read", async () => {
    const getProfile = vi.fn(async (symbol: string) => profile(symbol));
    const listings = new ApprovedSecurityListings({ getProfile }, [
      "AAPL",
      "MSFT",
    ]);

    const nasdaq = await listings.getStockUniverse("NASDAQ");
    const nyse = await listings.getStockUniverse("nyse");
    const amex = await listings.getStockUniverse("AMEX");

    expect(getProfile.mock.calls).toEqual([["AAPL"], ["MSFT"]]);
    expect(nasdaq.map((entry) => entry.providerSymbol)).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(nyse).toEqual([]);
    expect(amex).toEqual([]);
    // The same shape the exchange-wide screener yields, for the catalog's own classifier.
    expect(nasdaq[0]).toEqual({
      providerSymbol: "AAPL",
      listing: {
        symbol: "AAPL",
        name: "AAPL Inc.",
        exchangeCode: "NASDAQ",
        exchangeName: "NASDAQ Global Select",
        country: "US",
        sector: "Technology",
        industry: "Software",
        isEtf: false,
        isFund: false,
        isActivelyTrading: true,
      },
    });
  });

  it("never lists a symbol nobody approved, even when the provider answers with one", async () => {
    const getProfile = vi.fn(async (symbol: string) =>
      symbol === "FB" ? profile("META") : profile(symbol),
    );
    const listings = new ApprovedSecurityListings({ getProfile }, [
      "FB",
      "AAPL",
    ]);

    const listed = await listings.getStockUniverse("NASDAQ");
    expect(listed.map((entry) => entry.providerSymbol)).toEqual(["AAPL"]);
    expect(await listings.outcomes()).toEqual([
      { symbol: "FB", outcome: "ANSWERED_AS_ANOTHER_SYMBOL", answered: "META" },
      { symbol: "AAPL", outcome: "LISTED" },
    ]);
  });

  it("explains a symbol the provider does not know or the product does not support", async () => {
    const getProfile = vi.fn(async (symbol: string) => {
      switch (symbol) {
        case "NOPE":
          return null;
        case "SPY":
          return profile("SPY", { type: "ETF", exchangeCode: "AMEX" });
        case "SHEL.L":
          return profile("SHEL.L", { exchangeCode: "LSE" });
        default:
          return profile(symbol);
      }
    });
    const listings = new ApprovedSecurityListings({ getProfile }, [
      "NOPE",
      "SPY",
      "SHEL.L",
    ]);
    await listings.getStockUniverse("NASDAQ");
    expect(await listings.outcomes()).toEqual([
      { symbol: "NOPE", outcome: "UNKNOWN_TO_PROVIDER" },
      { symbol: "SPY", outcome: "UNSUPPORTED", reason: "NON_EQUITY" },
      {
        symbol: "SHEL.L",
        outcome: "UNSUPPORTED",
        reason: "UNSUPPORTED_EXCHANGE",
      },
    ]);
  });
});

describe("resolving approved symbols", () => {
  it("resolves from the catalog without asking the provider anything", async () => {
    const { getSecurity } = catalog([security("AAPL"), security("MSFT")]);
    const admit = vi.fn();
    const scope = scopeOf(["AAPL", "MSFT"]);

    const resolution = await resolveLiveFmpSecurities({
      symbols: ["AAPL", "MSFT"],
      scope,
      getSecurity,
      admit,
    });

    expect(admit).not.toHaveBeenCalled();
    expect(resolution.unresolved).toEqual([]);
    expect(
      resolution.resolved.map((entry) => [entry.symbol, entry.origin]),
    ).toEqual([
      ["AAPL", "CATALOG"],
      ["MSFT", "CATALOG"],
    ]);
    // The scope now names securities, not strings.
    expect(scope.securities).toEqual([
      { securityId: "security-AAPL", providerSymbol: "AAPL" },
      { securityId: "security-MSFT", providerSymbol: "MSFT" },
    ]);
  });

  it("admits only the symbols the catalog lacks, then resolves them from the catalog", async () => {
    const { getSecurity, rows } = catalog([security("AAPL")]);
    const admit = vi.fn(async (symbols: readonly string[]) => {
      for (const symbol of symbols) {
        rows.set(symbol, security(symbol));
      }
      return symbols.map((symbol): LiveFmpAdmissionOutcome => ({
        symbol,
        outcome: "LISTED",
      }));
    });
    const scope = scopeOf(["AAPL", "MSFT", "NVDA"]);

    const resolution = await resolveLiveFmpSecurities({
      symbols: ["AAPL", "MSFT", "NVDA"],
      scope,
      getSecurity,
      admit,
    });

    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit).toHaveBeenCalledWith(["MSFT", "NVDA"]);
    expect(
      resolution.resolved.map((entry) => [entry.symbol, entry.origin]),
    ).toEqual([
      ["AAPL", "CATALOG"],
      ["MSFT", "ADMITTED"],
      ["NVDA", "ADMITTED"],
    ]);
    expect(scope.securities).toHaveLength(3);
  });

  it("leaves a symbol unresolved, and unbound, when it names no supported security", async () => {
    const { getSecurity, rows } = catalog();
    const admit = vi.fn(async (): Promise<LiveFmpAdmissionOutcome[]> => {
      rows.set("AAPL", security("AAPL"));
      return [
        { symbol: "AAPL", outcome: "LISTED" },
        { symbol: "NOPE", outcome: "UNKNOWN_TO_PROVIDER" },
        { symbol: "SPY", outcome: "UNSUPPORTED", reason: "NON_EQUITY" },
      ];
    });
    const scope = scopeOf(["AAPL", "NOPE", "SPY"]);

    const resolution = await resolveLiveFmpSecurities({
      symbols: ["AAPL", "NOPE", "SPY"],
      scope,
      getSecurity,
      admit,
    });

    expect(resolution.resolved.map((entry) => entry.symbol)).toEqual(["AAPL"]);
    expect(resolution.unresolved).toEqual([
      {
        symbol: "NOPE",
        reason: "the provider has no security under this symbol",
      },
      {
        symbol: "SPY",
        reason: "it is a fund or ETF; only common stocks are supported",
      },
    ]);
    // Unresolved symbols stay candidates: nothing but their identity can ever be asked for them.
    expect(scope.securities).toEqual([
      { securityId: "security-AAPL", providerSymbol: "AAPL" },
    ]);
    expect(() =>
      scope.authorize({
        path: "historical-price-eod/full",
        query: { symbol: "SPY" },
      }),
    ).toThrowError(/has not been resolved/);
  });

  it("asks nobody when it is only planning", async () => {
    const { getSecurity } = catalog([security("AAPL")]);
    const scope = scopeOf(["AAPL", "MSFT"]);

    const resolution = await resolveLiveFmpSecurities({
      symbols: ["AAPL", "MSFT"],
      scope,
      getSecurity,
    });

    expect(resolution.resolved.map((entry) => entry.symbol)).toEqual(["AAPL"]);
    expect(resolution.unresolved).toEqual([
      { symbol: "MSFT", reason: "it is not in the security catalog" },
    ]);
  });

  it("refuses a catalog row the loader would ask for under another symbol", async () => {
    // What the loader sends the provider is the row's `symbol`. If that is not the approved
    // symbol, hydrating it would ask about something nobody approved.
    const { getSecurity } = catalog();
    const lookup = vi.fn(async () => security("META", { id: "security-fb" }));
    const scope = scopeOf(["FB"]);

    const resolution = await resolveLiveFmpSecurities({
      symbols: ["FB"],
      scope,
      getSecurity: lookup,
    });

    expect(getSecurity).not.toHaveBeenCalled();
    expect(resolution.resolved).toEqual([]);
    expect(resolution.unresolved[0]?.reason).toMatch(/holds it as META/);
    expect(scope.securities).toEqual([]);
  });

  it("does not swallow a failure that is not 'not found'", async () => {
    const scope = scopeOf(["AAPL"]);
    await expect(
      resolveLiveFmpSecurities({
        symbols: ["AAPL"],
        scope,
        getSecurity: async () => {
          throw new Error("connection refused");
        },
      }),
    ).rejects.toThrowError("connection refused");
  });
});

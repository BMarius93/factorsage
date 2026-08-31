import { describe, expect, it } from "vitest";
import {
  classifySecurityListing,
  securityCatalogFieldsChanged,
  SUPPORTED_EXCHANGE_CODES,
  SUPPORTED_EXCHANGE_CURRENCIES,
  type SecurityListingCandidate,
} from "./security-universe.js";
import type { Security } from "./stock-data.js";

function candidate(
  overrides: Partial<SecurityListingCandidate> = {},
): SecurityListingCandidate {
  return {
    symbol: "AAPL",
    name: "Apple Inc.",
    exchangeCode: "NASDAQ",
    exchangeName: "NASDAQ Global Select",
    country: "US",
    sector: "Technology",
    industry: "Consumer Electronics",
    isEtf: false,
    isFund: false,
    isActivelyTrading: true,
    ...overrides,
  };
}

const persistedSecurity: Security = {
  id: "security-1",
  symbol: "AAPL",
  name: "Apple Inc.",
  exchangeCode: "NASDAQ",
  exchangeName: "NASDAQ Global Select",
  currency: "USD",
  cik: "0000320193",
  isin: "US0378331005",
  ipoDate: "1980-12-12",
  country: "US",
  sector: "Technology",
  industry: "Consumer Electronics",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

describe("supported exchange table", () => {
  it("gives every supported exchange a quoting currency", () => {
    expect(SUPPORTED_EXCHANGE_CODES.length).toBeGreaterThan(0);
    for (const code of SUPPORTED_EXCHANGE_CODES) {
      expect(SUPPORTED_EXCHANGE_CURRENCIES[code]).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe("classifySecurityListing", () => {
  it("admits an equity on a supported exchange with the exchange's currency", () => {
    const decision = classifySecurityListing(candidate());

    expect(decision).toEqual({
      supported: true,
      security: {
        symbol: "AAPL",
        name: "Apple Inc.",
        exchangeCode: "NASDAQ",
        exchangeName: "NASDAQ Global Select",
        currency: "USD",
        country: "US",
        sector: "Technology",
        industry: "Consumer Electronics",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: true,
      },
    });
  });

  it("normalizes symbol and exchange casing", () => {
    const decision = classifySecurityListing(
      candidate({ symbol: " aapl ", exchangeCode: " nasdaq " }),
    );

    expect(decision).toMatchObject({
      supported: true,
      security: { symbol: "AAPL", exchangeCode: "NASDAQ" },
    });
  });

  it("rejects ETFs and funds as non-equity", () => {
    expect(classifySecurityListing(candidate({ isEtf: true }))).toEqual({
      supported: false,
      reason: "NON_EQUITY",
    });
    expect(classifySecurityListing(candidate({ isFund: true }))).toEqual({
      supported: false,
      reason: "NON_EQUITY",
    });
  });

  it("rejects a listing on an exchange this product does not support", () => {
    expect(classifySecurityListing(candidate({ exchangeCode: "LSE" }))).toEqual(
      {
        supported: false,
        reason: "UNSUPPORTED_EXCHANGE",
      },
    );
  });

  it("rejects a listing missing a required identity field", () => {
    for (const broken of [
      { symbol: "  " },
      { name: "" },
      { exchangeCode: "" },
    ]) {
      expect(classifySecurityListing(candidate(broken))).toEqual({
        supported: false,
        reason: "INCOMPLETE",
      });
    }
  });

  it("carries the upstream trading status through", () => {
    expect(
      classifySecurityListing(candidate({ isActivelyTrading: false })),
    ).toMatchObject({
      supported: true,
      security: { isActivelyTrading: false },
    });
  });

  it("omits optional descriptive fields the universe did not provide", () => {
    const decision = classifySecurityListing(
      candidate({
        exchangeName: undefined,
        country: undefined,
        sector: undefined,
        industry: undefined,
      }),
    );

    expect(decision).toMatchObject({ supported: true });
    if (decision.supported) {
      expect(Object.keys(decision.security).sort()).toEqual([
        "currency",
        "exchangeCode",
        "isActivelyTrading",
        "isAdr",
        "name",
        "symbol",
        "type",
      ]);
    }
  });
});

/** The catalog-owned view of the persisted fixture: what a universe sync would produce for it. */
function incomingCatalog(
  overrides: Partial<Omit<Security, "id">> = {},
): Omit<Security, "id"> {
  return {
    symbol: persistedSecurity.symbol,
    name: persistedSecurity.name,
    exchangeCode: persistedSecurity.exchangeCode,
    exchangeName: persistedSecurity.exchangeName,
    currency: persistedSecurity.currency,
    country: persistedSecurity.country,
    sector: persistedSecurity.sector,
    industry: persistedSecurity.industry,
    type: persistedSecurity.type,
    isAdr: persistedSecurity.isAdr,
    isActivelyTrading: persistedSecurity.isActivelyTrading,
    ...overrides,
  };
}

describe("securityCatalogFieldsChanged", () => {
  it("is false when only profile-owned fields are absent from the sync", () => {
    // A universe row never carries CIK, ISIN or the IPO date, and that must not read as a change.
    expect(
      securityCatalogFieldsChanged(persistedSecurity, incomingCatalog()),
    ).toBe(false);
  });

  it("is true when a catalog-owned field differs", () => {
    expect(
      securityCatalogFieldsChanged(
        persistedSecurity,
        incomingCatalog({ name: "Apple Incorporated" }),
      ),
    ).toBe(true);
    expect(
      securityCatalogFieldsChanged(
        persistedSecurity,
        incomingCatalog({ isActivelyTrading: false }),
      ),
    ).toBe(true);
  });
});

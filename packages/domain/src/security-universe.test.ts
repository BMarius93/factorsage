import { describe, expect, it } from "vitest";
import {
  classifySecurityListing,
  securityCatalogFieldsChanged,
  SUPPORTED_EXCHANGE_CODES,
  SUPPORTED_EXCHANGE_CURRENCIES,
  SUPPORTED_EXCHANGE_TIMEZONE,
  tradingSessionCloseInstant,
  tradingSessionDate,
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

/**
 * The drift guard behind {@link SUPPORTED_EXCHANGE_TIMEZONE}.
 *
 * Naming a trading session from one timezone is exact only while every supported venue is on that
 * clock. Admitting a venue elsewhere must fail here, so the author has to decide what a session
 * date means for it rather than discovering later that its observations were mis-dated.
 */
describe("supported exchanges share one trading clock", () => {
  it("admits exactly the US venues the timezone claim covers", () => {
    expect([...SUPPORTED_EXCHANGE_CODES].sort()).toEqual([
      "AMEX",
      "NASDAQ",
      "NYSE",
    ]);
    expect(SUPPORTED_EXCHANGE_TIMEZONE).toBe("America/New_York");
  });
});

describe("tradingSessionDate", () => {
  it("names the session an instant belongs to, not its UTC day", () => {
    // 19:30 New York on a Monday in January is already Tuesday in UTC. Deriving the day in UTC
    // would name a session that has not started; the exchange clock names the one being traded.
    const mondayAfterHours = new Date("2026-01-06T00:30:00.000Z");
    expect(mondayAfterHours.toISOString().slice(0, 10)).toBe("2026-01-06");
    expect(tradingSessionDate(mondayAfterHours)).toBe("2026-01-05");
  });

  it("keeps a Friday evening on Friday rather than rolling into Saturday", () => {
    // The same rollover on the last session of the week would otherwise name a weekend date.
    const fridayAfterHours = new Date("2026-01-10T00:30:00.000Z");
    expect(fridayAfterHours.toISOString().slice(0, 10)).toBe("2026-01-10");
    expect(tradingSessionDate(fridayAfterHours)).toBe("2026-01-09");
  });

  it("agrees with UTC during the regular session, in both DST offsets", () => {
    // Winter (EST, UTC-5): 09:30-16:00 local is 14:30-21:00 UTC, the same calendar day.
    expect(tradingSessionDate(new Date("2026-01-05T14:30:00.000Z"))).toBe(
      "2026-01-05",
    );
    expect(tradingSessionDate(new Date("2026-01-05T21:00:00.000Z"))).toBe(
      "2026-01-05",
    );
    // Summer (EDT, UTC-4): 13:30-20:00 UTC, likewise.
    expect(tradingSessionDate(new Date("2026-07-06T13:30:00.000Z"))).toBe(
      "2026-07-06",
    );
    expect(tradingSessionDate(new Date("2026-07-06T20:00:00.000Z"))).toBe(
      "2026-07-06",
    );
  });

  it("reads the instant it is given and no clock", () => {
    const instant = new Date("2026-03-02T18:00:00.000Z");
    expect(tradingSessionDate(instant)).toBe(tradingSessionDate(instant));
    expect(instant.toISOString()).toBe("2026-03-02T18:00:00.000Z");
  });
});

describe("tradingSessionCloseInstant", () => {
  it("closes at 16:00 New York in both offsets", () => {
    // Summer (EDT, UTC-4) and winter (EST, UTC-5). The instant is what a "2 days ago" label needs;
    // the date alone cannot produce one.
    expect(tradingSessionCloseInstant("2026-09-15").toISOString()).toBe(
      "2026-09-15T20:00:00.000Z",
    );
    expect(tradingSessionCloseInstant("2026-01-15").toISOString()).toBe(
      "2026-01-15T21:00:00.000Z",
    );
  });

  it("is exact on the daylight-saving transition days", () => {
    // Both transitions happen at 02:00 local, long before the close, so the close is on the new
    // offset on both days: EDT from 2026-03-08, EST from 2026-11-01.
    expect(tradingSessionCloseInstant("2026-03-08").toISOString()).toBe(
      "2026-03-08T20:00:00.000Z",
    );
    expect(tradingSessionCloseInstant("2026-03-07").toISOString()).toBe(
      "2026-03-07T21:00:00.000Z",
    );
    expect(tradingSessionCloseInstant("2026-11-01").toISOString()).toBe(
      "2026-11-01T21:00:00.000Z",
    );
    expect(tradingSessionCloseInstant("2026-10-31").toISOString()).toBe(
      "2026-10-31T20:00:00.000Z",
    );
  });

  it("round-trips through tradingSessionDate for a decade of dates", () => {
    // The two functions are inverses at the close, which is what makes a stored observation date
    // and a rendered instant describe the same session.
    for (
      let day = new Date("2016-01-01T00:00:00.000Z");
      day < new Date("2026-01-01T00:00:00.000Z");
      day = new Date(day.valueOf() + 86_400_000)
    ) {
      const date = day.toISOString().slice(0, 10);
      expect(tradingSessionDate(tradingSessionCloseInstant(date))).toBe(date);
    }
  });

  it("refuses a value that is not a product date", () => {
    expect(() => tradingSessionCloseInstant("2026-13-45" as never)).toThrow(
      /canonical YYYY-MM-DD/,
    );
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

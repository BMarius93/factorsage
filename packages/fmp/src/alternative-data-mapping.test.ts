import { describe, expect, it } from "vitest";
import { mapFmpCongressTrades, mapFmpInsiderTrades } from "./mapping.js";

/**
 * Mapping the alternative-data provider payloads.
 *
 * Every fixture below is a **verbatim row captured from the live API on 2026-09-25**, so this suite is
 * what proves the field names are the provider's own rather than guessed. V1 maps only the two domains
 * this subscription provides; Form 13F is absent because it could not be verified the same way.
 */

// Captured live: `insider-trading/search?symbol=AAPL&limit=5`, first two rows.
const INSIDER_SALE = {
  symbol: "AAPL",
  filingDate: "2026-09-24",
  transactionDate: "2026-09-22",
  reportingCik: "0001780525",
  companyCik: "0000320193",
  transactionType: "S-Sale",
  securitiesOwned: 44391,
  reportingName: "Newstead Jennifer",
  typeOfOwner: "officer: SVP, GC and Government Affairs",
  acquisitionOrDisposition: "D",
  directOrIndirect: "D",
  formType: "4",
  securitiesTransacted: 2399,
  price: 340.06,
  securityName: "Common Stock",
  url: "https://www.sec.gov/Archives/edgar/data/320193/000114036126037584/0001140361-26-037584-index.htm",
};

const INSIDER_EXERCISE = {
  ...INSIDER_SALE,
  filingDate: "2026-09-17",
  transactionDate: "2026-09-15",
  transactionType: "M-Exempt",
  securitiesOwned: 180624,
  securitiesTransacted: 30104,
  price: 0,
  securityName: "Restricted Stock Unit",
};

// Captured live: `senate-trades?symbol=AAPL`, first row.
const SENATE_SALE = {
  symbol: "AAPL",
  senateID: "T000278",
  disclosureDate: "2026-08-05",
  transactionDate: "2024-08-26",
  firstName: "Thomas Hawley",
  lastName: "Tuberville",
  office: "Tommy Tuberville",
  district: "AL",
  owner: "Self",
  assetDescription: "Apple Inc",
  assetType: "Stock",
  type: "Sale",
  amount: "$15,001 - $50,000",
  capitalGainsOver200USD: "False",
  comment: "",
  link: "https://efdsearch.senate.gov/search/view/ptr/2758f09a-fda9-4fb4-a465-270173a8125d/",
};

// Captured live: `house-trades?symbol=AAPL`, first row.
const HOUSE_SALE = {
  symbol: "AAPL",
  senateID: "S000250",
  disclosureDate: "2026-09-23",
  transactionDate: "2026-09-22",
  firstName: "Pete",
  lastName: "Sessions",
  office: "Pete Sessions",
  district: "TX17",
  owner: "Spouse",
  assetDescription: "Apple Inc",
  assetType: "Stock",
  type: "Sale",
  amount: "$100,001 - $250,000",
  capitalGainsOver200USD: "False",
  comment: "",
  link: "https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/2026/20035499.pdf",
};

// Captured live: `house-latest`, a corporate-bond row — the asset types V1 must not count.
const HOUSE_BOND = {
  ...HOUSE_SALE,
  symbol: "BNS",
  senateID: "B001325",
  assetDescription: "The Bank of Nova Scotia",
  assetType: "Corporate Bond",
  amount: "$500,001 - $1,000,000",
};

describe("mapFmpInsiderTrades", () => {
  it("maps a live open-market sale, keeping both dates apart", () => {
    const [mapped] = mapFmpInsiderTrades([INSIDER_SALE]);
    expect(mapped).toMatchObject({
      providerSymbol: "AAPL",
      transactionDate: "2026-09-22",
      filingDate: "2026-09-24",
      // The day after the filing, never the filing date and never the transaction date.
      availableFromDate: "2026-09-25",
      reportingCik: "0001780525",
      reportingName: "Newstead Jennifer",
      transactionCode: "S",
      transactionTypeRaw: "S-Sale",
      category: "OPEN_MARKET_SALE",
      roles: ["OFFICER"],
      securitiesTransacted: 2399,
      price: 340.06,
    });
    expect(mapped?.transactionValue).toBeCloseTo(2399 * 340.06, 6);
  });

  it("classifies an exercise as an exercise and gives it no value", () => {
    const [mapped] = mapFmpInsiderTrades([INSIDER_EXERCISE]);
    expect(mapped?.category).toBe("OPTION_EXERCISE");
    expect(mapped?.transactionValue).toBeUndefined();
    expect(mapped?.price).toBe(0);
  });

  it("keeps the provider's own row for audit", () => {
    const [mapped] = mapFmpInsiderTrades([INSIDER_SALE]);
    expect(mapped?.raw).toEqual(INSIDER_SALE);
    // A copy, so a later mutation of the payload cannot change what was persisted.
    expect(mapped?.raw).not.toBe(INSIDER_SALE);
  });

  it("skips only the rows it cannot place in time or attribute", () => {
    expect(
      mapFmpInsiderTrades([
        { ...INSIDER_SALE, filingDate: undefined },
        { ...INSIDER_SALE, transactionDate: null },
        { ...INSIDER_SALE, reportingCik: "" },
        { ...INSIDER_SALE, transactionType: undefined },
        { ...INSIDER_SALE, symbol: undefined },
      ]),
    ).toEqual([]);
    // An unknown transaction type is kept: the raw row is the audit trail.
    const [mapped] = mapFmpInsiderTrades([
      { ...INSIDER_SALE, transactionType: "Z-Whatever" },
    ]);
    expect(mapped?.category).toBe("OTHER");
  });

  it("tolerates a timestamped date", () => {
    const [mapped] = mapFmpInsiderTrades([
      { ...INSIDER_SALE, filingDate: "2026-09-24 00:00:00" },
    ]);
    expect(mapped?.filingDate).toBe("2026-09-24");
    expect(mapped?.availableFromDate).toBe("2026-09-25");
  });
});

describe("mapFmpCongressTrades", () => {
  it("maps a live Senate disclosure, keeping the transaction and disclosure dates apart", () => {
    const [mapped] = mapFmpCongressTrades("SENATE", [SENATE_SALE]);
    expect(mapped).toMatchObject({
      providerSymbol: "AAPL",
      chamber: "SENATE",
      actorExternalId: "T000278",
      actorDisplayName: "Tommy Tuberville",
      actorState: "AL",
      // More than eleven months apart in real data: this is why the window is on availability.
      transactionDate: "2024-08-26",
      disclosureDate: "2026-08-05",
      availableFromDate: "2026-08-06",
      kind: "SALE",
      transactionTypeRaw: "Sale",
      owner: "SELF",
      assetClass: "STOCK",
      amountRangeRaw: "$15,001 - $50,000",
      amountLowerBound: 15_001,
      amountUpperBound: 50_000,
      capitalGainsOver200Usd: false,
    });
    expect(mapped?.actorDistrict).toBeUndefined();
  });

  it("splits a House district into state and district", () => {
    const [mapped] = mapFmpCongressTrades("HOUSE", [HOUSE_SALE]);
    expect(mapped).toMatchObject({
      chamber: "HOUSE",
      actorExternalId: "S000250",
      actorState: "TX",
      actorDistrict: "TX17",
      owner: "SPOUSE",
    });
  });

  it("takes the chamber from the endpoint, because the payload never states it", () => {
    // Both endpoints return the bioguide id in a field called `senateID`.
    expect(mapFmpCongressTrades("HOUSE", [SENATE_SALE])[0]?.chamber).toBe(
      "HOUSE",
    );
  });

  it("keeps a non-stock asset and classifies it out of the stock metrics", () => {
    const [mapped] = mapFmpCongressTrades("HOUSE", [HOUSE_BOND]);
    expect(mapped?.assetClass).toBe("BOND");
    expect(mapped?.assetTypeRaw).toBe("Corporate Bond");
    expect(mapped?.amountLowerBound).toBe(500_001);
  });

  it("never turns a band into an exact amount", () => {
    const [mapped] = mapFmpCongressTrades("SENATE", [
      { ...SENATE_SALE, amount: "Over $50,000,000" },
    ]);
    expect(mapped?.amountLowerBound).toBe(50_000_000);
    expect(mapped?.amountUpperBound).toBeUndefined();
  });

  it("skips only the rows it cannot place in time or attribute", () => {
    expect(
      mapFmpCongressTrades("SENATE", [
        { ...SENATE_SALE, disclosureDate: "" },
        { ...SENATE_SALE, transactionDate: undefined },
        { ...SENATE_SALE, senateID: null },
        { ...SENATE_SALE, type: undefined },
      ]),
    ).toEqual([]);
  });

  it("falls back to the identifier when the provider reports no readable name", () => {
    const [mapped] = mapFmpCongressTrades("SENATE", [
      { ...SENATE_SALE, office: "", firstName: "", lastName: "" },
    ]);
    expect(mapped?.actorDisplayName).toBe("T000278");
  });
});

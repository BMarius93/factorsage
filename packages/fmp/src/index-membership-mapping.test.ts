import { describe, expect, it } from "vitest";
import {
  mapFmpDelistedCompanies,
  mapFmpIndexChanges,
  mapFmpIndexConstituents,
  mapFmpMarketCapitalizations,
  mapFmpSymbolChanges,
} from "./index-membership-mapping.js";

describe("index membership mapping", () => {
  it("keeps a constituent's identity fields and pads its CIK", () => {
    const { rows, dropped } = mapFmpIndexConstituents([
      {
        symbol: " brk.b ",
        name: "Berkshire Hathaway",
        sector: "Financial Services",
        subSector: "Insurance",
        cik: "1067983",
        dateFirstAdded: "2010-02-16",
      },
      { symbol: "", name: "No ticker" },
      { symbol: "XOM", name: "ExxonMobil", dateFirstAdded: "not a date" },
    ]);
    expect(dropped).toBe(1);
    expect(rows).toEqual([
      {
        symbol: "BRK.B",
        name: "Berkshire Hathaway",
        sector: "Financial Services",
        subSector: "Insurance",
        cik: "0001067983",
        dateFirstAdded: "2010-02-16",
      },
      {
        symbol: "XOM",
        name: "ExxonMobil",
        sector: null,
        subSector: null,
        cik: null,
        dateFirstAdded: null,
      },
    ]);
  });

  it("maps additions, removals and replacements by their effective date", () => {
    const { rows, dropped } = mapFmpIndexChanges([
      {
        dateAdded: "October 06, 2026",
        addedSecurity: "Twilio Inc.",
        removedTicker: "WBD",
        removedSecurity: "Warner Bros. Discovery",
        date: "2026-10-06",
        symbol: "TWLO",
        reason: "Acquired",
        changeType: "replacement",
        addedTicker: "TWLO",
      },
      {
        dateAdded: "October 06, 2026",
        addedSecurity: null,
        removedTicker: "CTVA",
        removedSecurity: "Corteva Inc.",
        date: "2026-10-06",
        symbol: "CTVA",
        reason: "Market capitalization changes.",
        changeType: "removal",
        addedTicker: "",
      },
      {
        dateAdded: "March 04, 1957",
        addedSecurity: "W. R. Grace & Co",
        removedTicker: "",
        removedSecurity: "",
        date: "1957-03-04",
        symbol: "GRA",
        reason: "",
        changeType: "addition",
        addedTicker: "GRA",
      },
      // No date: cannot be placed in history.
      { addedTicker: "AAA", changeType: "addition" },
      // No ticker on either side.
      { date: "2000-01-01", changeType: "replacement" },
      // An impossible calendar date is not a date.
      { date: "2001-02-30", addedTicker: "BBB", changeType: "addition" },
    ]);
    expect(dropped).toBe(3);
    expect(rows).toEqual([
      {
        effectiveDate: "2026-10-06",
        changeType: "replacement",
        addedTicker: "TWLO",
        addedName: "Twilio Inc.",
        removedTicker: "WBD",
        removedName: "Warner Bros. Discovery",
        reason: "Acquired",
        providerDateText: "October 06, 2026",
      },
      {
        effectiveDate: "2026-10-06",
        changeType: "removal",
        addedTicker: null,
        addedName: null,
        removedTicker: "CTVA",
        removedName: "Corteva Inc.",
        reason: "Market capitalization changes.",
        providerDateText: "October 06, 2026",
      },
      {
        effectiveDate: "1957-03-04",
        changeType: "addition",
        addedTicker: "GRA",
        addedName: "W. R. Grace & Co",
        removedTicker: null,
        removedName: null,
        reason: null,
        providerDateText: "March 04, 1957",
      },
    ]);
  });

  it("drops a rename to the same ticker and rows without a date", () => {
    const { rows, dropped } = mapFmpSymbolChanges([
      { date: "2022-06-09", companyName: "Meta", oldSymbol: "FB", newSymbol: "META" },
      { date: "1969-12-31", companyName: "X", oldSymbol: "GOAI", newSymbol: "GOAI" },
      { companyName: "Y", oldSymbol: "A", newSymbol: "B" },
    ]);
    expect(dropped).toBe(2);
    expect(rows).toEqual([
      { date: "2022-06-09", oldSymbol: "FB", newSymbol: "META", companyName: "Meta" },
    ]);
  });

  it("maps delisted listings and market capitalizations, ascending", () => {
    expect(
      mapFmpDelistedCompanies([
        {
          symbol: "TWTR",
          companyName: "Twitter, Inc.",
          exchange: "nyse",
          ipoDate: "2013-11-07",
          delistedDate: "2022-10-27",
        },
      ]).rows,
    ).toEqual([
      {
        symbol: "TWTR",
        companyName: "Twitter, Inc.",
        exchange: "NYSE",
        ipoDate: "2013-11-07",
        delistedDate: "2022-10-27",
      },
    ]);
    const caps = mapFmpMarketCapitalizations([
      { symbol: "PAR", date: "1997-04-30", marketCap: 76284485 },
      { symbol: "PAR", date: "1997-04-29", marketCap: "75000000" },
      { symbol: "PAR", date: "1997-04-28", marketCap: -1 },
    ]);
    expect(caps.dropped).toBe(1);
    expect(caps.rows).toEqual([
      { date: "1997-04-29", marketCap: 75_000_000 },
      { date: "1997-04-30", marketCap: 76_284_485 },
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  listingDateContradicted,
  listingFloor,
  startsAtListing,
  statementsWithEvidencedAvailability,
} from "./listing-evidence.js";

describe("listing evidence (DATA-02)", () => {
  it("is the provider's IPO date when the stored bars agree with it", () => {
    // A genuine IPO: the first bar is the listing day, or a session after it.
    expect(
      listingFloor({ ipoDate: "2018-12-07", earliestPriceDate: "2018-12-07" }),
    ).toBe("2018-12-07");
    expect(
      listingFloor({ ipoDate: "2018-12-06", earliestPriceDate: "2018-12-07" }),
    ).toBe("2018-12-06");
    // Nothing stored yet: the IPO date is all there is.
    expect(listingFloor({ ipoDate: "2018-12-07" })).toBe("2018-12-07");
    expect(
      listingFloor({ ipoDate: "2018-12-07", earliestPriceDate: null }),
    ).toBe("2018-12-07");
  });

  it("is the first stored bar when the IPO date is later than a bar the stock traded", () => {
    // NEE: FMP dates the IPO 2014-06-19; its stored bars start 1992-10-15.
    const nee = { ipoDate: "2014-06-19", earliestPriceDate: "1992-10-15" };
    expect(listingFloor(nee)).toBe("1992-10-15");
    expect(listingDateContradicted(nee)).toBe(true);
    expect(
      listingDateContradicted({
        ipoDate: "2018-12-07",
        earliestPriceDate: "2018-12-07",
      }),
    ).toBe(false);
  });

  it("reads an IPO date a session after the first bar as the same listing, not a contradiction", () => {
    // CAVA: first stored session Thursday 2023-06-15, IPO date Friday 2023-06-16.
    const cava = { ipoDate: "2023-06-16", earliestPriceDate: "2023-06-15" };
    expect(listingDateContradicted(cava)).toBe(false);
    // The floor still never hides the stored session before it.
    expect(listingFloor(cava)).toBe("2023-06-15");
    expect(
      startsAtListing({ ipoDate: "2023-06-16", historyStart: "2023-06-15" }),
    ).toBe(true);
    // A week later is another week: no longer the listing week.
    expect(
      listingDateContradicted({
        ipoDate: "2023-06-19",
        earliestPriceDate: "2023-06-15",
      }),
    ).toBe(true);
    expect(
      startsAtListing({ ipoDate: "2023-06-19", historyStart: "2023-06-15" }),
    ).toBe(false);
  });

  it("has no floor without an IPO date, exactly as before", () => {
    expect(listingFloor({ earliestPriceDate: "1992-10-15" })).toBeUndefined();
    expect(listingDateContradicted({ earliestPriceDate: "1992-10-15" })).toBe(
      false,
    );
  });

  it("calls a first week a listing week only on an IPO date the bars do not contradict", () => {
    // PLD: the IPO date is its first bar.
    expect(
      startsAtListing({ ipoDate: "1997-11-21", historyStart: "1997-11-21" }),
    ).toBe(true);
    // An older listing: the history was cut by the horizon.
    expect(
      startsAtListing({ ipoDate: "1980-12-12", historyStart: "1992-10-15" }),
    ).toBe(false);
    // NEE: the history starts fifteen years before the IPO date, so it is no listing week.
    expect(
      startsAtListing({ ipoDate: "2014-06-19", historyStart: "1992-10-15" }),
    ).toBe(false);
    expect(startsAtListing({ historyStart: "1992-10-15" })).toBe(false);
  });
});

describe("pre-listing statements (DATA-03, option C)", () => {
  const revision = (fiscalDate: string, filingDate: string) => ({
    id: `${fiscalDate}:${filingDate}`,
    fiscalDate,
    filingDate,
  });
  // V: listed 2008-03-19. FY2003 carries the period end as its "filing" date (a placeholder the
  // statutory-deadline rule would make public on 2003-12-30, four years before the prospectus);
  // FY2007 carries a real filing date.
  const placeholder = revision("2003-09-30", "2003-09-30");
  const filed = revision("2007-09-30", "2008-11-21");
  const afterListing = revision("2008-06-30", "2008-06-30");
  const statements = [placeholder, filed, afterListing];

  it("reads a pre-listing revision only on a real filing date", () => {
    expect(
      statementsWithEvidencedAvailability(statements, "2008-03-19"),
    ).toEqual([filed, afterListing]);
  });

  it("reads every revision from the floor on, placeholders included, as before", () => {
    // A listed company's period-end placeholder still counts at its statutory deadline (AUD-03).
    expect(
      statementsWithEvidencedAvailability([afterListing], "2008-03-19"),
    ).toEqual([afterListing]);
  });

  it("reads everything when there is no listing evidence", () => {
    expect(statementsWithEvidencedAvailability(statements, undefined)).toEqual(
      statements,
    );
  });

  it("counts a revision dated on the floor itself as listed", () => {
    const onTheDay = revision("2008-03-19", "2008-03-19");
    expect(
      statementsWithEvidencedAvailability([onTheDay], "2008-03-19"),
    ).toEqual([onTheDay]);
  });
});

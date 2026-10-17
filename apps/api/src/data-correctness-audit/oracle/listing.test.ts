import { describe, expect, it } from "vitest";
import { evidencedBeforeListing, listedFrom } from "./listing";

describe("the oracle's listing rules (DATA-02, DATA-03)", () => {
  it("takes the IPO date unless a stored bar precedes it", () => {
    expect(listedFrom("2018-12-07", "2018-12-07")).toBe("2018-12-07");
    expect(listedFrom("2014-06-19", "1992-10-15")).toBe("1992-10-15");
    expect(listedFrom("2023-06-16", "2023-06-15")).toBe("2023-06-15");
    expect(listedFrom(null, "1992-10-15")).toBeNull();
    expect(listedFrom("2018-12-07", null)).toBe("2018-12-07");
  });

  it("reads a pre-listing statement only on a real filing date", () => {
    const listing = "2008-03-19";
    expect(
      evidencedBeforeListing(
        { fiscalDate: "2003-09-30", filingDate: "2003-09-30" },
        listing,
      ),
    ).toBe(false);
    expect(
      evidencedBeforeListing(
        { fiscalDate: "2007-09-30", filingDate: "2008-11-21" },
        listing,
      ),
    ).toBe(true);
    expect(
      evidencedBeforeListing(
        { fiscalDate: "2008-06-30", filingDate: "2008-06-30" },
        listing,
      ),
    ).toBe(true);
    expect(
      evidencedBeforeListing(
        { fiscalDate: "2003-09-30", filingDate: "2003-09-30" },
        null,
      ),
    ).toBe(true);
  });
});

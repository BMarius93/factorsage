import { describe, expect, it } from "vitest";
import {
  BuyWindowValidationError,
  isBuyWindowEligible,
  normalizeBuyWindowConfiguration,
  normalizeBuyWindowRanges,
  type BuyWindowRange,
} from "./stock-lists.js";

function range(startDate: string, endDate: string | null): BuyWindowRange {
  return { startDate, endDate };
}

describe("normalizeBuyWindowRanges", () => {
  it("keeps an already canonical set unchanged", () => {
    const input = [
      range("2018-01-01", "2020-12-31"),
      range("2023-01-01", null),
    ];

    expect(normalizeBuyWindowRanges(input)).toEqual(input);
  });

  it("returns an empty set for empty input", () => {
    expect(normalizeBuyWindowRanges([])).toEqual([]);
  });

  it("sorts unordered ranges chronologically", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2023-01-01", "2023-06-30"),
        range("2018-01-01", "2018-12-31"),
        range("2020-05-01", "2020-08-31"),
      ]),
    ).toEqual([
      range("2018-01-01", "2018-12-31"),
      range("2020-05-01", "2020-08-31"),
      range("2023-01-01", "2023-06-30"),
    ]);
  });

  it("merges overlapping ranges into one period", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2020-01-01", "2020-06-30"),
        range("2020-05-01", "2020-12-31"),
      ]),
    ).toEqual([range("2020-01-01", "2020-12-31")]);
  });

  it("merges directly adjacent ranges because they are one continuous period", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2020-01-01", "2020-12-31"),
        range("2021-01-01", "2021-12-31"),
      ]),
    ).toEqual([range("2020-01-01", "2021-12-31")]);
  });

  it("merges adjacency across a month boundary but preserves a one-day gap", () => {
    // 2020-06-30 -> 2020-07-01 is adjacent; 2020-08-31 -> 2020-09-02 leaves 2020-09-01 out.
    expect(
      normalizeBuyWindowRanges([
        range("2020-01-01", "2020-06-30"),
        range("2020-07-01", "2020-08-31"),
        range("2020-09-02", "2020-12-31"),
      ]),
    ).toEqual([
      range("2020-01-01", "2020-08-31"),
      range("2020-09-02", "2020-12-31"),
    ]);
  });

  it("collapses a range nested inside another", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2020-01-01", "2020-12-31"),
        range("2020-03-01", "2020-06-30"),
      ]),
    ).toEqual([range("2020-01-01", "2020-12-31")]);
  });

  it("collapses exact duplicate ranges", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2020-01-01", "2020-12-31"),
        range("2020-01-01", "2020-12-31"),
      ]),
    ).toEqual([range("2020-01-01", "2020-12-31")]);

    expect(
      normalizeBuyWindowRanges([
        range("2023-01-01", null),
        range("2023-01-01", null),
      ]),
    ).toEqual([range("2023-01-01", null)]);
  });

  it("keeps disjoint periods separate without inventing eligibility in the gap", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2023-01-01", null),
        range("2018-01-01", "2020-12-31"),
      ]),
    ).toEqual([range("2018-01-01", "2020-12-31"), range("2023-01-01", null)]);
  });

  it("lets an open-ended range absorb every later range so only one survives", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2021-01-01", null),
        range("2022-05-01", "2022-08-31"),
        range("2025-01-01", null),
      ]),
    ).toEqual([range("2021-01-01", null)]);
  });

  it("extends a bounded range that an open-ended range overlaps", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2020-01-01", "2020-12-31"),
        range("2020-06-01", null),
      ]),
    ).toEqual([range("2020-01-01", null)]);
  });

  it("merges an open-ended range adjacent to a bounded one", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2020-01-01", "2020-12-31"),
        range("2021-01-01", null),
      ]),
    ).toEqual([range("2020-01-01", null)]);
  });

  it("treats an open-ended and a bounded range with the same start as one open-ended period", () => {
    expect(
      normalizeBuyWindowRanges([
        range("2020-01-01", "2020-06-30"),
        range("2020-01-01", null),
      ]),
    ).toEqual([range("2020-01-01", null)]);
  });

  it("normalizes a shuffled mixture of overlap, nesting, adjacency, and duplicates deterministically", () => {
    const canonical = [
      range("2018-01-01", "2019-12-31"),
      range("2021-06-01", null),
    ];
    const shuffled = [
      range("2019-01-01", "2019-12-31"),
      range("2021-06-01", "2021-09-30"),
      range("2018-01-01", "2018-12-31"),
      range("2021-08-01", null),
      range("2018-03-01", "2018-05-31"),
      range("2019-01-01", "2019-12-31"),
    ];

    expect(normalizeBuyWindowRanges(shuffled)).toEqual(canonical);
    // Same dates, different submission order: identical canonical output.
    expect(normalizeBuyWindowRanges([...shuffled].reverse())).toEqual(
      canonical,
    );
  });

  it("rejects an inverted range", () => {
    expect(() =>
      normalizeBuyWindowRanges([range("2021-01-01", "2020-12-31")]),
    ).toThrow(BuyWindowValidationError);
  });

  it("accepts a single-day range", () => {
    expect(
      normalizeBuyWindowRanges([range("2020-06-15", "2020-06-15")]),
    ).toEqual([range("2020-06-15", "2020-06-15")]);
  });

  it("rejects malformed and impossible calendar dates", () => {
    expect(() =>
      normalizeBuyWindowRanges([range("2020-13-01", "2020-12-31")]),
    ).toThrow(BuyWindowValidationError);
    expect(() =>
      normalizeBuyWindowRanges([range("2020-01-01", "2023-02-31")]),
    ).toThrow(BuyWindowValidationError);
    expect(() =>
      normalizeBuyWindowRanges([range("01/01/2020", "2020-12-31")]),
    ).toThrow(BuyWindowValidationError);
    expect(() => normalizeBuyWindowRanges([range("", null)])).toThrow(
      BuyWindowValidationError,
    );
  });
});

describe("normalizeBuyWindowConfiguration", () => {
  it("canonicalizes FULL to zero ranges", () => {
    expect(
      normalizeBuyWindowConfiguration({ mode: "FULL", ranges: [] }),
    ).toEqual({ mode: "FULL", ranges: [] });
  });

  it("rejects FULL submitted with ranges instead of silently discarding them", () => {
    expect(() =>
      normalizeBuyWindowConfiguration({
        mode: "FULL",
        ranges: [range("2020-01-01", null)],
      }),
    ).toThrow(BuyWindowValidationError);
  });

  it("normalizes CUSTOM ranges", () => {
    expect(
      normalizeBuyWindowConfiguration({
        mode: "CUSTOM",
        ranges: [
          range("2021-01-01", "2021-12-31"),
          range("2020-01-01", "2020-12-31"),
        ],
      }),
    ).toEqual({ mode: "CUSTOM", ranges: [range("2020-01-01", "2021-12-31")] });
  });

  it("rejects CUSTOM with no ranges", () => {
    expect(() =>
      normalizeBuyWindowConfiguration({ mode: "CUSTOM", ranges: [] }),
    ).toThrow(BuyWindowValidationError);
  });

  it("rejects invalid ranges inside a CUSTOM configuration", () => {
    expect(() =>
      normalizeBuyWindowConfiguration({
        mode: "CUSTOM",
        ranges: [range("2021-01-01", "2020-01-01")],
      }),
    ).toThrow(BuyWindowValidationError);
  });
});

describe("buy eligibility", () => {
  it("admits every date under FULL", () => {
    const configuration = { mode: "FULL" as const, ranges: [] };
    expect(isBuyWindowEligible(configuration, "1999-01-01")).toBe(true);
    expect(isBuyWindowEligible(configuration, "2030-12-31")).toBe(true);
  });

  it("admits only dates inside a CUSTOM range, inclusive on both ends", () => {
    const configuration = {
      mode: "CUSTOM" as const,
      ranges: [range("2020-03-01", "2020-03-31")],
    };
    expect(isBuyWindowEligible(configuration, "2020-02-29")).toBe(false);
    expect(isBuyWindowEligible(configuration, "2020-03-01")).toBe(true);
    expect(isBuyWindowEligible(configuration, "2020-03-31")).toBe(true);
    expect(isBuyWindowEligible(configuration, "2020-04-01")).toBe(false);
  });

  it("treats a null end date as open-ended", () => {
    const configuration = {
      mode: "CUSTOM" as const,
      ranges: [range("2020-03-01", null)],
    };
    expect(isBuyWindowEligible(configuration, "2020-02-29")).toBe(false);
    expect(isBuyWindowEligible(configuration, "2099-01-01")).toBe(true);
  });

  it("admits a date inside any one of several ranges", () => {
    const configuration = {
      mode: "CUSTOM" as const,
      ranges: [
        range("2020-01-01", "2020-01-31"),
        range("2021-01-01", "2021-01-31"),
      ],
    };
    expect(isBuyWindowEligible(configuration, "2020-01-15")).toBe(true);
    expect(isBuyWindowEligible(configuration, "2020-06-15")).toBe(false);
    expect(isBuyWindowEligible(configuration, "2021-01-15")).toBe(true);
  });
});

/**
 * Point-in-time index membership, the use case buy windows exist for.
 *
 * The worked example throughout is a company that was in an index from 2001-03-10 to 2008-07-15,
 * left it, and rejoined on 2012-05-01 with no end yet. A backtest sitting in 2005 must see it as
 * buyable, one in 2010 must not, and one in 2020 must again — from the *same* stored member.
 */
describe("point-in-time membership", () => {
  const MEMBERSHIP = {
    mode: "CUSTOM" as const,
    ranges: [range("2001-03-10", "2008-07-15"), range("2012-05-01", null)],
  };

  it("is canonical as stored: two periods, sorted, the open-ended one last", () => {
    expect(normalizeBuyWindowConfiguration(MEMBERSHIP)).toEqual(MEMBERSHIP);
  });

  it("refuses every date before the first membership begins", () => {
    expect(isBuyWindowEligible(MEMBERSHIP, "1998-01-01")).toBe(false);
    expect(isBuyWindowEligible(MEMBERSHIP, "2001-03-09")).toBe(false);
  });

  it("admits the exact start boundary", () => {
    expect(isBuyWindowEligible(MEMBERSHIP, "2001-03-10")).toBe(true);
  });

  it("admits a date inside the first period", () => {
    expect(isBuyWindowEligible(MEMBERSHIP, "2005-06-30")).toBe(true);
  });

  it("admits the exact end boundary", () => {
    expect(isBuyWindowEligible(MEMBERSHIP, "2008-07-15")).toBe(true);
  });

  it("refuses the day after the end boundary", () => {
    expect(isBuyWindowEligible(MEMBERSHIP, "2008-07-16")).toBe(false);
  });

  it("refuses every date in the gap between the two periods", () => {
    expect(isBuyWindowEligible(MEMBERSHIP, "2010-01-01")).toBe(false);
    expect(isBuyWindowEligible(MEMBERSHIP, "2012-04-30")).toBe(false);
  });

  it("admits re-entry from the second period's exact start onwards", () => {
    expect(isBuyWindowEligible(MEMBERSHIP, "2012-05-01")).toBe(true);
    expect(isBuyWindowEligible(MEMBERSHIP, "2020-11-03")).toBe(true);
  });

  it("stays eligible indefinitely because the final period is open-ended", () => {
    expect(isBuyWindowEligible(MEMBERSHIP, "2199-12-31")).toBe(true);
  });

  it("is a fixed point: normalizing canonical output again changes nothing", () => {
    const once = normalizeBuyWindowConfiguration(MEMBERSHIP);
    expect(normalizeBuyWindowConfiguration(once)).toEqual(once);
  });

  it("survives a JSON serialization round-trip without losing a period", () => {
    const canonical = normalizeBuyWindowConfiguration(MEMBERSHIP);
    const revived = JSON.parse(JSON.stringify(canonical)) as typeof canonical;

    expect(revived).toEqual(canonical);
    // `endDate: null` is the open-ended marker and must not become `undefined` or disappear.
    expect(Object.keys(revived.ranges[1] ?? {})).toContain("endDate");
    expect(revived.ranges[1]?.endDate).toBeNull();
    expect(normalizeBuyWindowConfiguration(revived)).toEqual(canonical);
  });

  it("orders deterministically however the periods arrive", () => {
    const shuffled = normalizeBuyWindowConfiguration({
      mode: "CUSTOM",
      ranges: [range("2012-05-01", null), range("2001-03-10", "2008-07-15")],
    });
    expect(shuffled).toEqual(MEMBERSHIP);
  });

  it("rejects an end date before its start rather than reordering it", () => {
    expect(() =>
      normalizeBuyWindowConfiguration({
        mode: "CUSTOM",
        ranges: [range("2020-01-01", "2019-01-01")],
      }),
    ).toThrow(BuyWindowValidationError);
  });

  it("merges two overlapping membership periods into the one span they cover", () => {
    // Overlap is accepted input, not an error: the canonical form is what disambiguates it. The
    // union is exactly the eligible dates, so no date becomes eligible that was not submitted.
    expect(
      normalizeBuyWindowConfiguration({
        mode: "CUSTOM",
        ranges: [
          range("2001-03-10", "2005-12-31"),
          range("2004-01-01", "2008-07-15"),
        ],
      }),
    ).toEqual({
      mode: "CUSTOM",
      ranges: [range("2001-03-10", "2008-07-15")],
    });
  });

  it("keeps a one-day gap open rather than closing it into one period", () => {
    const configuration = normalizeBuyWindowConfiguration({
      mode: "CUSTOM",
      ranges: [range("2001-03-10", "2008-07-15"), range("2008-07-17", null)],
    });
    expect(configuration.ranges).toHaveLength(2);
    expect(isBuyWindowEligible(configuration, "2008-07-16")).toBe(false);
  });

  it("is one open-ended period when the stock simply joined and never left", () => {
    const configuration = {
      mode: "CUSTOM" as const,
      ranges: [range("1982-11-30", null)],
    };
    expect(normalizeBuyWindowConfiguration(configuration)).toEqual(
      configuration,
    );
    expect(isBuyWindowEligible(configuration, "1982-11-29")).toBe(false);
    expect(isBuyWindowEligible(configuration, "1982-11-30")).toBe(true);
    expect(isBuyWindowEligible(configuration, "2026-09-16")).toBe(true);
  });
});

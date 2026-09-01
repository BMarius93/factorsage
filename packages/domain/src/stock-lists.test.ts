import { describe, expect, it } from "vitest";
import {
  BuyWindowValidationError,
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
    ).toEqual([
      range("2018-01-01", "2020-12-31"),
      range("2023-01-01", null),
    ]);
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
    expect(normalizeBuyWindowRanges([...shuffled].reverse())).toEqual(canonical);
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
    expect(() =>
      normalizeBuyWindowRanges([range("", null)]),
    ).toThrow(BuyWindowValidationError);
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

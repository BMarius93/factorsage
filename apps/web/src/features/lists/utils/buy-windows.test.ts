import { describe, expect, it } from "vitest";
import {
  buyWindowLabel,
  editableRangeError,
  editableRangesTouch,
  formatBuyWindowRange,
  toEditableRanges,
} from "./buy-windows";

describe("buyWindowLabel", () => {
  it("labels FULL and pluralizes CUSTOM window counts", () => {
    expect(buyWindowLabel({ buyWindowMode: "FULL", buyWindows: [] })).toBe(
      "Full history",
    );
    expect(
      buyWindowLabel({
        buyWindowMode: "CUSTOM",
        buyWindows: [{ startDate: "2020-01-01", endDate: null }],
      }),
    ).toBe("Custom · 1 window");
    expect(
      buyWindowLabel({
        buyWindowMode: "CUSTOM",
        buyWindows: [
          { startDate: "2020-01-01", endDate: "2020-12-31" },
          { startDate: "2023-01-01", endDate: null },
        ],
      }),
    ).toBe("Custom · 2 windows");
  });
});

describe("formatBuyWindowRange", () => {
  it("formats bounded and open-ended ranges", () => {
    expect(
      formatBuyWindowRange({ startDate: "2020-01-01", endDate: "2020-12-31" }),
    ).toBe("2020-01-01 → 2020-12-31");
    expect(formatBuyWindowRange({ startDate: "2023-01-01", endDate: null })).toBe(
      "2023-01-01 → no end date",
    );
  });
});

describe("toEditableRanges", () => {
  it("maps open-ended API ranges to an empty end input", () => {
    expect(
      toEditableRanges([
        { startDate: "2020-01-01", endDate: "2020-12-31" },
        { startDate: "2023-01-01", endDate: null },
      ]),
    ).toEqual([
      { startDate: "2020-01-01", endDate: "2020-12-31" },
      { startDate: "2023-01-01", endDate: "" },
    ]);
  });
});

describe("editableRangeError", () => {
  it("requires a start date", () => {
    expect(editableRangeError({ startDate: "", endDate: "" })).toBe(
      "Pick a start date",
    );
  });

  it("rejects an end before the start", () => {
    expect(
      editableRangeError({ startDate: "2021-01-01", endDate: "2020-01-01" }),
    ).toBe("The end date is before the start date");
  });

  it("accepts bounded, single-day, and open-ended rows", () => {
    expect(
      editableRangeError({ startDate: "2020-01-01", endDate: "2020-12-31" }),
    ).toBeNull();
    expect(
      editableRangeError({ startDate: "2020-01-01", endDate: "2020-01-01" }),
    ).toBeNull();
    expect(editableRangeError({ startDate: "2020-01-01", endDate: "" })).toBeNull();
  });
});

describe("editableRangesTouch", () => {
  it("flags overlap, adjacency, and an open-ended range followed by another", () => {
    expect(
      editableRangesTouch([
        { startDate: "2020-01-01", endDate: "2020-06-30" },
        { startDate: "2020-05-01", endDate: "2020-12-31" },
      ]),
    ).toBe(true);
    expect(
      editableRangesTouch([
        { startDate: "2020-01-01", endDate: "2020-12-31" },
        { startDate: "2021-01-01", endDate: "" },
      ]),
    ).toBe(true);
    expect(
      editableRangesTouch([
        { startDate: "2020-01-01", endDate: "" },
        { startDate: "2023-01-01", endDate: "2023-12-31" },
      ]),
    ).toBe(true);
  });

  it("stays quiet for disjoint ranges and invalid rows", () => {
    expect(
      editableRangesTouch([
        { startDate: "2020-01-01", endDate: "2020-12-31" },
        { startDate: "2023-01-01", endDate: "" },
      ]),
    ).toBe(false);
    expect(
      editableRangesTouch([
        { startDate: "", endDate: "" },
        { startDate: "2023-01-01", endDate: "" },
      ]),
    ).toBe(false);
  });
});

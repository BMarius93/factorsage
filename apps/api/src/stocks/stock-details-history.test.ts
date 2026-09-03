import { STOCK_DETAILS_MAX_HISTORY_YEARS } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  clampStockDetailsRange,
  stockDetailsHistoryBounds,
  stockDetailsHistoryYears,
  subtractYears,
} from "./stock-details-history";

const TODAY = "2026-09-03";

describe("stockDetailsHistoryYears", () => {
  it("is the product limit when the deployment retains at least that much", () => {
    expect(stockDetailsHistoryYears(30)).toBe(STOCK_DETAILS_MAX_HISTORY_YEARS);
    expect(stockDetailsHistoryYears(50)).toBe(STOCK_DETAILS_MAX_HISTORY_YEARS);
  });

  it("cannot promise more history than the deployment retains", () => {
    expect(stockDetailsHistoryYears(12)).toBe(12);
  });
});

describe("stockDetailsHistoryBounds", () => {
  it("reaches thirty years back for a long-listed security", () => {
    expect(
      stockDetailsHistoryBounds({
        today: TODAY,
        retentionYears: 30,
        ipoDate: "1980-12-12",
      }),
    ).toEqual({
      start: "1996-09-03",
      end: TODAY,
      startOrigin: "HORIZON",
    });
  });

  it("stops at the listing date when the security is younger than the horizon", () => {
    expect(
      stockDetailsHistoryBounds({
        today: TODAY,
        retentionYears: 30,
        ipoDate: "2018-12-07",
      }),
    ).toEqual({
      start: "2018-12-07",
      end: TODAY,
      startOrigin: "LISTING",
    });
  });

  it("falls back to the horizon when no listing date is known", () => {
    expect(
      stockDetailsHistoryBounds({ today: TODAY, retentionYears: 30 }),
    ).toEqual({ start: "1996-09-03", end: TODAY, startOrigin: "HORIZON" });
  });

  it("never exceeds what the deployment retains", () => {
    expect(
      stockDetailsHistoryBounds({ today: TODAY, retentionYears: 5 }).start,
    ).toBe("2021-09-03");
  });
});

describe("subtractYears", () => {
  it("clamps 29 February rather than rolling into March", () => {
    expect(subtractYears("2024-02-29", 1)).toBe("2023-02-28");
    expect(subtractYears("2024-02-29", 4)).toBe("2020-02-29");
  });

  it("rejects a value that is not a calendar date", () => {
    expect(() => subtractYears("not-a-date", 1)).toThrow();
  });
});

describe("clampStockDetailsRange", () => {
  const bounds = { start: "1996-09-03" };

  it("pulls an out-of-bound start up to the boundary instead of rejecting it", () => {
    expect(
      clampStockDetailsRange({ from: "1900-01-01", to: TODAY }, bounds),
    ).toEqual({ from: "1996-09-03", to: TODAY });
  });

  it("leaves a range that already sits inside the bound untouched", () => {
    expect(
      clampStockDetailsRange({ from: "2025-09-03", to: TODAY }, bounds),
    ).toEqual({ from: "2025-09-03", to: TODAY });
  });

  it("collapses a window entirely before the bound onto its edge", () => {
    // Reads as empty rather than as a request for history the surface does not serve.
    expect(
      clampStockDetailsRange({ from: "1950-01-01", to: "1960-01-01" }, bounds),
    ).toEqual({ from: "1996-09-03", to: "1996-09-03" });
  });

  it("keeps an open-ended query open", () => {
    expect(clampStockDetailsRange({}, bounds)).toEqual({});
    expect(clampStockDetailsRange({ to: TODAY }, bounds)).toEqual({ to: TODAY });
  });
});

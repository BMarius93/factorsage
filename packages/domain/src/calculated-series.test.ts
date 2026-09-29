import { describe, expect, it } from "vitest";
import {
  CALCULATED_SERIES_DECIMAL,
  CALCULATED_SERIES_MAGNITUDE_LIMIT,
  isRepresentableCalculatedSeriesValue,
} from "./calculated-series.js";

describe("calculated-series storage range", () => {
  it("is DECIMAL(20,8): twelve integer digits", () => {
    expect(CALCULATED_SERIES_DECIMAL).toEqual({ precision: 20, scale: 8 });
    expect(CALCULATED_SERIES_MAGNITUDE_LIMIT).toBe(1e12);
  });

  it("accepts every finite value strictly inside the range, at both signs", () => {
    // The largest double below 10^12 is 10^12 - 2^-13; it rounds to 999,999,999,999.99990000.
    const largestBelow = 1e12 - 2 ** -13;
    expect(largestBelow).toBeLessThan(1e12);
    for (const value of [
      0,
      -0,
      1e-12,
      -1e-12,
      15.42,
      -7.5,
      999_999_999_999.9999,
      -999_999_999_999.9999,
      largestBelow,
      -largestBelow,
    ]) {
      expect(isRepresentableCalculatedSeriesValue(value), String(value)).toBe(
        true,
      );
    }
  });

  it("refuses a value needing a thirteenth integer digit, and every non-finite value", () => {
    for (const value of [
      1e12,
      -1e12,
      1e12 + 1,
      5.4e13,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
    ]) {
      expect(isRepresentableCalculatedSeriesValue(value), String(value)).toBe(
        false,
      );
    }
  });
});

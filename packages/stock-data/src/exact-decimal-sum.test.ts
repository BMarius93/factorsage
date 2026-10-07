import { describe, expect, it } from "vitest";
import { exactDecimalSum, exactlyWithinFraction } from "./exact-decimal-sum.js";
import { shuffled } from "./fundamental-metrics.test-helper.js";

describe("exact sum of reported decimals", () => {
  it("sums reported decimals exactly where binary addition leaves residue", () => {
    // Naively 0.1 + 0.2 + -0.3 is 5.551115123125783e-17 and 0.1 + 0.2 is 0.30000000000000004.
    expect(exactDecimalSum([0.1, 0.2, -0.3])).toBe(0);
    expect(exactDecimalSum([0.1, 0.2])).toBe(0.3);
    expect(exactDecimalSum([0.6, 0.65, 0.7, 0.85])).toBe(2.8);
  });

  it("decides the sign of a four-quarter EPS sum exactly", () => {
    expect(exactDecimalSum([0.1, 0.2, -0.3, 0])).toBe(0);
    expect(exactDecimalSum([0.01, 0.02, -0.03, 0.01]) > 0).toBe(true);
    expect(exactDecimalSum([-0.01, 0.02, -0.03, 0.01]) < 0).toBe(true);
  });

  it("handles exponent notation at both ends of the range", () => {
    expect(exactDecimalSum([1e-7, 2e-7])).toBe(3e-7);
    expect(exactDecimalSum([1.5e21, 1])).toBe(1.5e21);
    expect(exactDecimalSum([123_456_789_012, 0.5, -0.25])).toBe(
      123_456_789_012.25,
    );
  });

  it("is independent of summation order to the last bit", () => {
    const values = [0.1, 0.7, -0.35, 1234.567, -0.002, 88.8, 0.03, -12.5];
    const expected = exactDecimalSum(values);

    for (const seed of [1, 2, 3, 4, 5]) {
      expect(exactDecimalSum(shuffled(values, seed))).toBe(expected);
    }
  });

  it("returns plain zero for an empty sum or signed zeros", () => {
    expect(exactDecimalSum([])).toBe(0);
    expect(Object.is(exactDecimalSum([-0, -0]), 0)).toBe(true);
  });

  it("refuses a non-finite addend", () => {
    expect(() => exactDecimalSum([1, Number.NaN])).toThrow("non-finite");
    expect(() => exactDecimalSum([Number.POSITIVE_INFINITY])).toThrow(
      "non-finite",
    );
  });
});

describe("a relative threshold judged on reported decimals", () => {
  it("holds a boundary its doubles would cross", () => {
    // 102 / 100 - 1 is 0.020000000000000018 and 98 / 100 - 1 is -0.020000000000000018.
    expect(Math.abs(102 / 100 - 1) > 0.02).toBe(true);
    expect(exactlyWithinFraction(102, [100], 0.02)).toBe(true);
    expect(exactlyWithinFraction(98, [100], 0.02)).toBe(true);
    expect(exactlyWithinFraction(1_020_000_000, [1_000_000_000], 0.02)).toBe(
      true,
    );
    // 0.825 / 1.1 - 1 is -0.2500000000000001.
    expect(exactlyWithinFraction(0.825, [1.1], 0.25)).toBe(true);
    expect(exactlyWithinFraction(1.375, [1.1], 0.25)).toBe(true);
  });

  it("refuses anything beyond the boundary, however close", () => {
    expect(exactlyWithinFraction(102.0001, [100], 0.02)).toBe(false);
    expect(exactlyWithinFraction(97.9999, [100], 0.02)).toBe(false);
    expect(exactlyWithinFraction(0.8249999, [1.1], 0.25)).toBe(false);
  });

  it("takes the reference as a product of factors", () => {
    // |204 − 2 × 100| = 4 = 2 % of 200; |204.01 − 200| is beyond it.
    expect(exactlyWithinFraction(204, [2, 100], 0.02)).toBe(true);
    expect(exactlyWithinFraction(196, [2, 100], 0.02)).toBe(true);
    expect(exactlyWithinFraction(204.01, [2, 100], 0.02)).toBe(false);
    expect(exactlyWithinFraction(12.5, [1.25, 10], 0)).toBe(true);
    expect(exactlyWithinFraction(12.5, [1.25, 10.000001], 0)).toBe(false);
  });

  it("reads exponent notation exactly", () => {
    expect(exactlyWithinFraction(1.02e21, [1e21], 0.02)).toBe(true);
    expect(exactlyWithinFraction(1.0200001e21, [1e21], 0.02)).toBe(false);
    expect(exactlyWithinFraction(1.25e-7, [1e-7], 0.25)).toBe(true);
  });
});

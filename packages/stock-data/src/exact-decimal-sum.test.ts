import { describe, expect, it } from "vitest";
import { exactDecimalSum } from "./exact-decimal-sum.js";
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

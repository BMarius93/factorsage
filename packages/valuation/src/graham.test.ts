import { describe, expect, it } from "vitest";
import { calculateGraham } from "./graham.js";

describe("GRAHAM", () => {
  it("reproduces the locked golden vector", () => {
    const result = calculateGraham({ epsTtm: 8, growthUsed: 0.05 });

    expect(result.status).toBe("CALCULATED");
    if (result.status !== "CALCULATED") {
      return;
    }
    expect(result.value.gPercent).toBeCloseTo(5, 10);
    expect(result.value.multiplier).toBeCloseTo(18.5, 10);
    expect(result.value.valuePerShare).toBeCloseTo(148, 10);
  });

  it("is not applicable without positive trailing EPS", () => {
    expect(calculateGraham({ epsTtm: 0, growthUsed: 0.05 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_EPS",
    });
    expect(calculateGraham({ epsTtm: -3, growthUsed: 0.05 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_EPS",
    });
  });

  it("is not applicable when the growth multiplier collapses to zero or below", () => {
    // 8.5 + 2 * (-4.25 * 100 / 100) = 0 exactly at growthUsed = -0.0425.
    expect(calculateGraham({ epsTtm: 8, growthUsed: -0.0425 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_MULTIPLIER",
    });
    expect(calculateGraham({ epsTtm: 8, growthUsed: -0.2 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_MULTIPLIER",
    });
  });

  it("never calculates from a non-finite input", () => {
    expect(calculateGraham({ epsTtm: Number.NaN, growthUsed: 0.05 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_FINITE_INPUT",
    });
    expect(calculateGraham({ epsTtm: 8, growthUsed: Number.NaN })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_FINITE_INPUT",
    });
  });
});

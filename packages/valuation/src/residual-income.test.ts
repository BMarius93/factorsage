import { describe, expect, it } from "vitest";
import {
  calculateResidualIncome,
  type ResidualIncomeInput,
} from "./residual-income.js";

const GOLDEN: ResidualIncomeInput = {
  netIncomeTtm: 80,
  bookValue: 500,
  shares: 10,
  growthUsed: 0.05,
};

describe("RESIDUAL_INCOME", () => {
  it("reproduces the locked golden vector", () => {
    const result = calculateResidualIncome(GOLDEN);

    expect(result.status).toBe("CALCULATED");
    if (result.status !== "CALCULATED") {
      return;
    }
    // 80 - 500 * 10%, charged against the latest (ending) book value.
    expect(result.value.residualIncome0).toBeCloseTo(30, 10);
    expect(result.value.pvForecast).toBeCloseTo(234.3540826986, 9);
    expect(result.value.pvTerminal).toBeCloseTo(257.4838509422, 9);
    expect(result.value.equityValue).toBeCloseTo(991.8379336408, 9);
    expect(result.value.valuePerShare).toBeCloseTo(99.1837933641, 9);
  });

  it("still calculates when the base residual income is negative", () => {
    // Earning below the equity charge is a valid outcome, not an inapplicable model.
    const result = calculateResidualIncome({ ...GOLDEN, netIncomeTtm: 20 });

    expect(result.status).toBe("CALCULATED");
    if (result.status !== "CALCULATED") {
      return;
    }
    expect(result.value.residualIncome0).toBeCloseTo(-30, 10);
    expect(result.value.equityValue).toBeGreaterThan(0);
    expect(result.value.valuePerShare).toBeGreaterThan(0);
  });

  it("is not applicable without a positive book value or positive shares", () => {
    expect(calculateResidualIncome({ ...GOLDEN, bookValue: 0 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_BOOK_VALUE",
    });
    expect(calculateResidualIncome({ ...GOLDEN, bookValue: -100 }).status).toBe(
      "NOT_APPLICABLE",
    );
    expect(calculateResidualIncome({ ...GOLDEN, shares: 0 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_SHARES",
    });
  });

  it("is not applicable when residual losses exhaust the book value", () => {
    expect(
      calculateResidualIncome({ ...GOLDEN, netIncomeTtm: -200 }),
    ).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_EQUITY_VALUE",
    });
  });

  it("never calculates from a non-finite input", () => {
    for (const override of [
      { netIncomeTtm: Number.NaN },
      { bookValue: Number.POSITIVE_INFINITY },
      { shares: Number.NaN },
      { growthUsed: Number.NaN },
    ]) {
      expect(calculateResidualIncome({ ...GOLDEN, ...override })).toEqual({
        status: "NOT_APPLICABLE",
        reason: "NON_FINITE_INPUT",
      });
    }
  });
});

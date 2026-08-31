import { describe, expect, it } from "vitest";
import { calculateDcfFcff, type DcfFcffInput } from "./dcf-fcff.js";

const GOLDEN: DcfFcffInput = {
  operatingCashFlowTtm: 120,
  capitalExpenditureTtm: -20,
  interestExpenseTtm: 10,
  growthUsed: 0.05,
  cash: 50,
  debt: 30,
  shares: 10,
};

describe("DCF_FCFF", () => {
  it("reproduces the locked golden vector", () => {
    const result = calculateDcfFcff(GOLDEN);

    expect(result.status).toBe("CALCULATED");
    if (result.status !== "CALCULATED") {
      return;
    }
    // Signed negative capex is added, never subtracted: 120 - 20 + 10 * 0.79.
    expect(result.value.fcff0).toBeCloseTo(107.9, 10);
    expect(result.value.pvForecast).toBeCloseTo(842.8935174394, 9);
    expect(result.value.pvTerminal).toBeCloseTo(926.0835838887, 9);
    expect(result.value.enterpriseValue).toBeCloseTo(1768.977101328, 9);
    expect(result.value.equityValue).toBeCloseTo(1788.977101328, 9);
    expect(result.value.valuePerShare).toBeCloseTo(178.8977101328, 9);
  });

  it("treats an explicit zero interest expense as a valid input", () => {
    const result = calculateDcfFcff({ ...GOLDEN, interestExpenseTtm: 0 });

    expect(result.status).toBe("CALCULATED");
    if (result.status !== "CALCULATED") {
      return;
    }
    expect(result.value.fcff0).toBeCloseTo(100, 10);
  });

  it("is not applicable when FCFF_0 is not positive", () => {
    // Capex outweighs operating cash flow.
    expect(
      calculateDcfFcff({
        ...GOLDEN,
        operatingCashFlowTtm: 15,
        capitalExpenditureTtm: -20,
        interestExpenseTtm: 0,
      }),
    ).toEqual({ status: "NOT_APPLICABLE", reason: "NON_POSITIVE_FCFF" });
  });

  it("is not applicable without positive shares", () => {
    expect(calculateDcfFcff({ ...GOLDEN, shares: 0 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_SHARES",
    });
    expect(calculateDcfFcff({ ...GOLDEN, shares: -5 }).status).toBe(
      "NOT_APPLICABLE",
    );
  });

  it("is not applicable when the equity bridge leaves no equity value", () => {
    expect(calculateDcfFcff({ ...GOLDEN, debt: 10_000 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_EQUITY_VALUE",
    });
  });

  it("never calculates from a non-finite input", () => {
    for (const override of [
      { operatingCashFlowTtm: Number.NaN },
      { capitalExpenditureTtm: Number.NEGATIVE_INFINITY },
      { interestExpenseTtm: Number.NaN },
      { growthUsed: Number.POSITIVE_INFINITY },
      { cash: Number.NaN },
      { debt: Number.NaN },
      { shares: Number.NaN },
    ]) {
      expect(calculateDcfFcff({ ...GOLDEN, ...override })).toEqual({
        status: "NOT_APPLICABLE",
        reason: "NON_FINITE_INPUT",
      });
    }
  });
});

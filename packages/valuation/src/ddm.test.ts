import { describe, expect, it } from "vitest";
import { calculateDdm } from "./ddm.js";

describe("DDM", () => {
  it("reproduces the locked golden vector", () => {
    const result = calculateDdm({ dpsTtm: 2 });

    expect(result.status).toBe("CALCULATED");
    if (result.status !== "CALCULATED") {
      return;
    }
    expect(result.value.dpsTtm).toBe(2);
    expect(result.value.d1).toBeCloseTo(2.05, 10);
    expect(result.value.valuePerShare).toBeCloseTo(27.3333333333, 9);
  });

  it("is not applicable for a non-paying or non-finite dividend", () => {
    expect(calculateDdm({ dpsTtm: 0 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_DIVIDEND",
    });
    expect(calculateDdm({ dpsTtm: -1 })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_POSITIVE_DIVIDEND",
    });
    expect(calculateDdm({ dpsTtm: Number.NaN })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_FINITE_INPUT",
    });
    expect(calculateDdm({ dpsTtm: Number.POSITIVE_INFINITY })).toEqual({
      status: "NOT_APPLICABLE",
      reason: "NON_FINITE_INPUT",
    });
  });
});

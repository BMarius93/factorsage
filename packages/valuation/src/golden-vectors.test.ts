import { describe, expect, it } from "vitest";
import { calculateBlend } from "./blends.js";
import { calculateDcfFcff } from "./dcf-fcff.js";
import { calculateDdm } from "./ddm.js";
import { calculateGraham } from "./graham.js";
import { calculateResidualIncome } from "./residual-income.js";

/**
 * End-to-end reproduction of the golden vectors in `docs/decisions/intrinsic-value-engine.md`,
 * including the blends fed by the models' own full-precision outputs.
 */
describe("locked golden vectors", () => {
  const dcf = calculateDcfFcff({
    operatingCashFlowTtm: 120,
    capitalExpenditureTtm: -20,
    interestExpenseTtm: 10,
    growthUsed: 0.05,
    cash: 50,
    debt: 30,
    shares: 10,
  });
  const residualIncome = calculateResidualIncome({
    netIncomeTtm: 80,
    bookValue: 500,
    shares: 10,
    growthUsed: 0.05,
  });
  const graham = calculateGraham({ epsTtm: 8, growthUsed: 0.05 });
  const ddm = calculateDdm({ dpsTtm: 2 });

  if (
    dcf.status !== "CALCULATED" ||
    residualIncome.status !== "CALCULATED" ||
    graham.status !== "CALCULATED" ||
    ddm.status !== "CALCULATED"
  ) {
    throw new Error("Golden vector inputs must all be calculable");
  }

  const components = {
    DCF_FCFF: dcf.value.valuePerShare,
    RESIDUAL_INCOME: residualIncome.value.valuePerShare,
    GRAHAM: graham.value.valuePerShare,
    DDM: ddm.value.valuePerShare,
  };

  it("produces the documented per-model values", () => {
    expect(components.DCF_FCFF).toBeCloseTo(178.8977101328, 9);
    expect(components.RESIDUAL_INCOME).toBeCloseTo(99.1837933641, 9);
    expect(components.GRAHAM).toBeCloseTo(148, 10);
    expect(components.DDM).toBeCloseTo(27.3333333333, 9);
  });

  it.each([
    ["BALANCED", 148.8039930756],
    ["CONSERVATIVE", 145.7142220623],
    ["DIVIDEND", 102.3291760593],
  ] as const)("produces the documented %s blend", (blendId, expected) => {
    const blend = calculateBlend(blendId, components);

    expect(blend.status).toBe("CALCULATED");
    if (blend.status !== "CALCULATED") {
      return;
    }
    expect(blend.value.valuePerShare).toBeCloseTo(expected, 9);
  });
});

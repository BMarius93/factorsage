import { describe, expect, it } from "vitest";
import { calculateBlend, type BlendDefinition } from "./blends.js";
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

  /**
   * The canonical definitions live in `INTRINSIC_VALUE_BLENDS` in `@intrinsic/domain`; the pure
   * calculator never owns them. These are the structural equivalents the orchestration layer will
   * pass in, restated here only as test input. The cross-package test proving the real domain
   * definitions produce these same results belongs to the orchestration slice.
   */
  type GoldenModel = keyof typeof components;
  const definitions: readonly (readonly [
    string,
    BlendDefinition<GoldenModel>,
    number,
  ])[] = [
    [
      "BALANCED",
      {
        components: [
          { model: "DCF_FCFF", weight: 0.5 },
          { model: "RESIDUAL_INCOME", weight: 0.3 },
          { model: "GRAHAM", weight: 0.2 },
        ],
      },
      148.8039930756,
    ],
    [
      "CONSERVATIVE",
      {
        components: [
          { model: "DCF_FCFF", weight: 0.4 },
          { model: "RESIDUAL_INCOME", weight: 0.3 },
          { model: "GRAHAM", weight: 0.3 },
        ],
      },
      145.7142220623,
    ],
    [
      "DIVIDEND",
      {
        components: [
          { model: "DCF_FCFF", weight: 0.4 },
          { model: "DDM", weight: 0.4 },
          { model: "RESIDUAL_INCOME", weight: 0.2 },
        ],
      },
      102.3291760593,
    ],
  ];

  it.each(definitions)("produces the documented %s blend", (_name, definition, expected) => {
    const blend = calculateBlend(definition, components);

    expect(blend.status).toBe("CALCULATED");
    if (blend.status !== "CALCULATED") {
      return;
    }
    expect(blend.value.valuePerShare).toBeCloseTo(expected, 9);
  });
});

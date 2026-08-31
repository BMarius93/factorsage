import { describe, expect, it } from "vitest";
import { calculateBlend, type BlendDefinition } from "./blends.js";

/**
 * Test-local structural definitions. The canonical product blends live in `@intrinsic/domain`;
 * this package must not know or store them, so the tests supply their own shapes.
 */
const THREE_COMPONENT: BlendDefinition<"A" | "B" | "C"> = {
  components: [
    { model: "A", weight: 0.5 },
    { model: "B", weight: 0.3 },
    { model: "C", weight: 0.2 },
  ],
};

describe("blends", () => {
  it("weights each component of the supplied definition", () => {
    expect(calculateBlend(THREE_COMPONENT, { A: 200, B: 100, C: 50 })).toEqual({
      status: "CALCULATED",
      value: { valuePerShare: 200 * 0.5 + 100 * 0.3 + 50 * 0.2 },
    });
  });

  it("consumes any structurally compatible definition without knowing its product identity", () => {
    // An arbitrary caller-defined model vocabulary: the calculator only sees the structure.
    const definition: BlendDefinition<"EARNINGS_POWER" | "ASSET_BASED"> = {
      components: [
        { model: "EARNINGS_POWER", weight: 0.75 },
        { model: "ASSET_BASED", weight: 0.25 },
      ],
    };

    expect(
      calculateBlend(definition, { EARNINGS_POWER: 120, ASSET_BASED: 40 }),
    ).toEqual({ status: "CALCULATED", value: { valuePerShare: 100 } });
  });

  it("requires every component the definition names", () => {
    for (const missing of ["A", "B", "C"] as const) {
      const values: Record<string, number> = { A: 200, B: 100, C: 50 };
      delete values[missing];
      expect(calculateBlend(THREE_COMPONENT, values)).toEqual({
        status: "NOT_APPLICABLE",
        reason: "MISSING_COMPONENT",
      });
    }
    expect(calculateBlend(THREE_COMPONENT, {})).toEqual({
      status: "NOT_APPLICABLE",
      reason: "MISSING_COMPONENT",
    });
  });

  it("does not renormalize weights around a zero-valued component", () => {
    // Renormalizing over the non-zero components would yield 100; the definition's weights
    // yield 80.
    expect(calculateBlend(THREE_COMPONENT, { A: 100, B: 100, C: 0 })).toEqual({
      status: "CALCULATED",
      value: { valuePerShare: 80 },
    });
  });

  it("ignores values the definition does not reference", () => {
    const referenced = calculateBlend(THREE_COMPONENT, { A: 100, B: 100, C: 100 });
    const withExtra = calculateBlend(
      THREE_COMPONENT as BlendDefinition<string>,
      { A: 100, B: 100, C: 100, UNRELATED: 9_999 },
    );

    expect(withExtra).toEqual(referenced);
    expect(withExtra).toEqual({
      status: "CALCULATED",
      value: { valuePerShare: 100 },
    });
  });

  it("never calculates from a non-finite component", () => {
    expect(
      calculateBlend(THREE_COMPONENT, { A: 100, B: Number.NaN, C: 100 }),
    ).toEqual({ status: "NOT_APPLICABLE", reason: "NON_FINITE_INPUT" });
    expect(
      calculateBlend(THREE_COMPONENT, {
        A: Number.POSITIVE_INFINITY,
        B: 100,
        C: 100,
      }),
    ).toEqual({ status: "NOT_APPLICABLE", reason: "NON_FINITE_INPUT" });
  });

  it("throws on a malformed definition rather than reporting inapplicability", () => {
    const values = { A: 100, B: 100, C: 100 };

    expect(() =>
      calculateBlend({ components: [] } as BlendDefinition<"A">, values),
    ).toThrow("at least one component");
    expect(() =>
      calculateBlend(
        {
          components: [
            { model: "A", weight: 0.5 },
            { model: "B", weight: 0.3 },
          ],
        },
        values,
      ),
    ).toThrow("must sum to 1");
    expect(() =>
      calculateBlend(
        {
          components: [
            { model: "A", weight: 1.2 },
            { model: "B", weight: -0.2 },
          ],
        },
        values,
      ),
    ).toThrow("positive finite weight");
    expect(() =>
      calculateBlend(
        {
          components: [
            { model: "A", weight: Number.NaN },
            { model: "B", weight: 1 },
          ],
        },
        values,
      ),
    ).toThrow("positive finite weight");
  });
});

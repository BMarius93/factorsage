import { describe, expect, it } from "vitest";
import {
  INDEX_SCALE,
  PERCENT_SCALE,
  ratioAtScale,
  ratioAtScaleOrNull,
} from "./ratio-binding.js";

/**
 * Values the audit measured in the matrix database: the float, what the old two-step binding stored
 * for it (Prisma's 16 significant digits, then PostgreSQL's rounding at the column scale), and what
 * one rounding of the float itself gives. The two-step model is pinned independently by the audit
 * oracle's own test.
 */
const AUDITED_RETURN_INDICES = [
  // From the matrix database, where the stored value was 1.0009891329.
  { value: 1.0009891328499996, twoStep: "1.0009891329", once: "1.0009891328" },
  // Constructed on the same mechanism: a float just below the midpoint whose 16-digit form sits on
  // it. 254 of 289,728 sampled ratios were of this shape.
  { value: 8.62669758625, twoStep: "8.6266975863", once: "8.6266975862" },
] as const;

describe("ratioAtScale", () => {
  it("rounds once where the two-step binding rounded twice (AUD-01)", () => {
    // The 16-digit form crosses the scale's midpoint upwards while the float itself is below it,
    // so the old path stored one unit in the last place too much.
    for (const audited of AUDITED_RETURN_INDICES) {
      expect(ratioAtScale(audited.value, INDEX_SCALE)).toBe(audited.once);
      expect(audited.once).not.toBe(audited.twoStep);
    }
  });

  it("renders at exactly the column's scale", () => {
    expect(ratioAtScale(1, INDEX_SCALE)).toBe("1.0000000000");
    expect(ratioAtScale(-12.5, PERCENT_SCALE)).toBe("-12.50000000");
    expect(ratioAtScale(0, PERCENT_SCALE)).toBe("0.00000000");
  });

  it("agrees with the float's own value, not with a shortened form", () => {
    // 15,533.333333333334 % — a return that needs more than 16 significant digits at scale 8.
    const value = 46600 / 3;
    expect(ratioAtScale(value, PERCENT_SCALE)).toBe("15533.33333333");
    expect(Number(ratioAtScale(value, PERCENT_SCALE))).toBeCloseTo(value, 8);
  });

  it("keeps a null null", () => {
    expect(ratioAtScaleOrNull(null, PERCENT_SCALE)).toBeNull();
    expect(ratioAtScaleOrNull(0.5, PERCENT_SCALE)).toBe("0.50000000");
  });

  it("refuses a value it cannot store honestly", () => {
    expect(() => ratioAtScale(Number.NaN, INDEX_SCALE)).toThrow(/finite/);
    expect(() => ratioAtScale(Number.POSITIVE_INFINITY, INDEX_SCALE)).toThrow(
      /finite/,
    );
    expect(() => ratioAtScale(1e21, PERCENT_SCALE)).toThrow(/storable range/);
  });
});

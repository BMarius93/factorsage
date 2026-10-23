import { describe, expect, it } from "vitest";
import { annualReturnShade } from "./annual-heatmap";

describe("annualReturnShade", () => {
  it("shades by direction, in four fixed steps of magnitude", () => {
    expect(
      [0.01, 4.99, 5, 14.99, 15, 29.99, 30, 139.83].map(annualReturnShade),
    ).toEqual([
      { tone: "positive", intensity: 1 },
      { tone: "positive", intensity: 1 },
      { tone: "positive", intensity: 2 },
      { tone: "positive", intensity: 2 },
      { tone: "positive", intensity: 3 },
      { tone: "positive", intensity: 3 },
      { tone: "positive", intensity: 4 },
      { tone: "positive", intensity: 4 },
    ]);
  });

  it("uses the same steps for losses", () => {
    expect([-0.5, -7.5, -20, -48].map(annualReturnShade)).toEqual([
      { tone: "negative", intensity: 1 },
      { tone: "negative", intensity: 2 },
      { tone: "negative", intensity: 3 },
      { tone: "negative", intensity: 4 },
    ]);
  });

  it("leaves a flat year unshaded", () => {
    expect(annualReturnShade(0)).toEqual({ tone: "neutral", intensity: 0 });
  });

  it("marks a missing figure as unavailable rather than as zero", () => {
    expect(annualReturnShade(null)).toEqual({
      tone: "unavailable",
      intensity: 0,
    });
    expect(annualReturnShade(Number.NaN)).toEqual({
      tone: "unavailable",
      intensity: 0,
    });
  });
});

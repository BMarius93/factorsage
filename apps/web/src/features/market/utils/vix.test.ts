import { describe, expect, it } from "vitest";
import {
  classifyVix,
  VIX_GAUGE_MAX,
  VIX_STATUS_LABELS,
  VIX_ZONES,
  vixGaugeFraction,
  vixZoneSpan,
} from "./vix";

describe("classifyVix", () => {
  it.each([
    [0, "VERY_LOW"],
    [11.99, "VERY_LOW"],
    [12, "NORMAL"],
    [15.43, "NORMAL"],
    [19.99, "NORMAL"],
    [20, "ELEVATED"],
    [29.99, "ELEVATED"],
    [30, "HIGH"],
    [39.99, "HIGH"],
    [40, "EXTREME"],
    [80, "EXTREME"],
    [82.69, "EXTREME"],
    [150, "EXTREME"],
  ] as const)("classifies %d as %s", (value, status) => {
    expect(classifyVix(value)).toBe(status);
  });

  it("says nothing rather than guessing when there is no valid level", () => {
    // An unavailable VIX must never read as "Very low", which is what treating it as 0 would do.
    expect(classifyVix(undefined)).toBeNull();
    expect(classifyVix(Number.NaN)).toBeNull();
    expect(classifyVix(Number.POSITIVE_INFINITY)).toBeNull();
    expect(classifyVix(-0.01)).toBeNull();
  });

  it("labels each zone in the product's words, and never as sentiment", () => {
    expect(VIX_STATUS_LABELS).toEqual({
      VERY_LOW: "Very low",
      NORMAL: "Normal",
      ELEVATED: "Elevated",
      HIGH: "High",
      EXTREME: "Extreme",
    });
    for (const label of Object.values(VIX_STATUS_LABELS)) {
      expect(label).not.toMatch(/fear|greed|sentiment/i);
    }
  });

  it("keeps its boundaries contiguous, in one table", () => {
    for (let index = 1; index < VIX_ZONES.length; index += 1) {
      expect(VIX_ZONES[index]?.from).toBe(VIX_ZONES[index - 1]?.to);
    }
    expect(VIX_ZONES[0]?.from).toBe(0);
    expect(VIX_ZONES.at(-1)?.to).toBeNull();
  });
});

describe("vixGaugeFraction", () => {
  it("is linear over the clamped 0–80 display range", () => {
    expect(vixGaugeFraction(0)).toBe(0);
    expect(vixGaugeFraction(20)).toBe(0.25);
    expect(vixGaugeFraction(15.43)).toBeCloseTo(15.43 / 80, 10);
    expect(vixGaugeFraction(40)).toBe(0.5);
  });

  it("pins the marker to the end of the arc at and beyond 80", () => {
    expect(VIX_GAUGE_MAX).toBe(80);
    expect(vixGaugeFraction(80)).toBe(1);
    expect(vixGaugeFraction(82.69)).toBe(1);
    expect(vixGaugeFraction(500)).toBe(1);
  });

  it("draws no marker for a level it cannot classify", () => {
    expect(vixGaugeFraction(undefined)).toBeNull();
    expect(vixGaugeFraction(Number.NaN)).toBeNull();
    expect(vixGaugeFraction(-1)).toBeNull();
  });
});

describe("vixZoneSpan", () => {
  it("gives each zone its share of the display range, with Extreme ending at 80+", () => {
    expect(VIX_ZONES.map(vixZoneSpan)).toEqual([
      { start: 0, end: 0.15 },
      { start: 0.15, end: 0.25 },
      { start: 0.25, end: 0.375 },
      { start: 0.375, end: 0.5 },
      { start: 0.5, end: 1 },
    ]);
  });
});

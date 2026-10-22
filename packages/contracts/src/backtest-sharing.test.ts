import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BACKTEST_SHARE_TOKEN_BYTES,
  backtestSharePath,
  backtestSharePreviewImagePath,
  isBacktestShareToken,
  sampleSharedBacktestPreview,
  SHARED_BACKTEST_PREVIEW_MAX_POINTS,
  strategyRuleCount,
} from "./backtest-sharing.js";
import type { StrategyDefinition } from "./strategies.js";

describe("share tokens", () => {
  it("accepts exactly what the API issues: 32 random bytes in base64url", () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const token = randomBytes(BACKTEST_SHARE_TOKEN_BYTES).toString(
        "base64url",
      );
      expect(isBacktestShareToken(token)).toBe(true);
    }
  });

  it("refuses anything else before a lookup could be made", () => {
    const valid = randomBytes(BACKTEST_SHARE_TOKEN_BYTES).toString("base64url");
    for (const candidate of [
      "",
      valid.slice(1),
      `${valid}A`,
      `${valid.slice(0, 42)}=`,
      `${valid.slice(0, 42)}/`,
      "00000000-0000-4000-8000-000000000000",
      `../${valid.slice(3)}`,
      42,
      null,
      undefined,
    ]) {
      expect(isBacktestShareToken(candidate)).toBe(false);
    }
  });

  it("builds the public page and image paths from the token alone", () => {
    expect(backtestSharePath("abc")).toBe("/share/abc");
    expect(backtestSharePreviewImagePath("abc")).toBe("/share/abc/preview.png");
  });
});

/** Structural stand-ins: the count reads only how many Conditions and Triggers a Signal holds. */
function signal(conditions: number, trigger: boolean) {
  return {
    conditions: Array.from({ length: conditions }, (_, index) => ({
      id: `c${index}`,
    })),
    ...(trigger ? { trigger: { id: "t" } } : {}),
  };
}

describe("strategyRuleCount", () => {
  it("counts every Condition and Trigger across BUY, SELL and every Exit Rule", () => {
    const definition = {
      schemaVersion: 2,
      buyLevels: [
        { id: "b1", percentage: 50, signal: signal(2, true) },
        { id: "b2", percentage: 50, signal: signal(1, false) },
      ],
      sellLevels: [{ id: "s1", percentage: 50, signal: signal(0, true) }],
      finalExit: {
        id: "f",
        rules: [
          { id: "r1", signal: signal(2, false) },
          { id: "r2", signal: signal(1, true) },
        ],
      },
    } as unknown as StrategyDefinition;
    // BUY 3 + 1, SELL 1, FINAL EXIT 2 + 2.
    expect(strategyRuleCount(definition)).toBe(9);
  });

  it("counts a definition with no SELL levels and no FINAL EXIT", () => {
    const definition = {
      schemaVersion: 2,
      buyLevels: [{ id: "b1", percentage: 100, signal: signal(1, false) }],
      sellLevels: [],
    } as unknown as StrategyDefinition;
    expect(strategyRuleCount(definition)).toBe(1);
  });
});

type Point = {
  date: string;
  strategyValue: number;
  benchmarkValue: number | null;
};

function series(length: number, value: (index: number) => number): Point[] {
  return Array.from({ length }, (_, index) => ({
    date: new Date(Date.UTC(1996, 0, 1) + index * 86_400_000)
      .toISOString()
      .slice(0, 10),
    strategyValue: value(index),
    benchmarkValue: 100_000 + index,
  }));
}

describe("sampleSharedBacktestPreview", () => {
  it("returns a short series untouched", () => {
    const points = series(120, (index) => index);
    expect(sampleSharedBacktestPreview(points)).toEqual(points);
  });

  it("bounds a thirty-year series and keeps both endpoints", () => {
    const points = series(7_560, (index) => 100_000 + Math.sin(index) * 5_000);
    const sampled = sampleSharedBacktestPreview(points);
    expect(sampled.length).toBeLessThanOrEqual(
      SHARED_BACKTEST_PREVIEW_MAX_POINTS,
    );
    expect(sampled.length).toBeGreaterThan(400);
    expect(sampled[0]).toBe(points[0]);
    expect(sampled.at(-1)).toBe(points.at(-1));
  });

  it("keeps a one-day crash that even striding would step over", () => {
    // A flat run with one sharp trough and one spike, on days a stride of ~12 skips.
    const points = series(7_560, () => 100_000);
    (points[3_001] as Point).strategyValue = 40_000;
    (points[5_003] as Point).strategyValue = 180_000;
    const sampled = sampleSharedBacktestPreview(points);
    expect(sampled.map((point) => point.strategyValue)).toContain(40_000);
    expect(sampled.map((point) => point.strategyValue)).toContain(180_000);
  });

  it("keeps the benchmark's own extremes as well as the strategy's", () => {
    const points = series(5_000, () => 100_000);
    (points[2_222] as Point).benchmarkValue = 1;
    const sampled = sampleSharedBacktestPreview(points);
    expect(sampled.map((point) => point.benchmarkValue)).toContain(1);
  });

  it("stays in date order and is deterministic", () => {
    const points = series(6_000, (index) => (index * 7_919) % 10_007);
    const first = sampleSharedBacktestPreview(points);
    const second = sampleSharedBacktestPreview(points);
    expect(second).toEqual(first);
    const dates = first.map((point) => point.date);
    expect([...dates].sort()).toEqual(dates);
    expect(new Set(dates).size).toBe(dates.length);
  });

  it("tolerates a series with no benchmark value at all", () => {
    const points = series(3_000, (index) => index).map((point) => ({
      ...point,
      benchmarkValue: null,
    }));
    const sampled = sampleSharedBacktestPreview(points);
    expect(sampled.length).toBeLessThanOrEqual(
      SHARED_BACKTEST_PREVIEW_MAX_POINTS,
    );
    expect(sampled.every((point) => point.benchmarkValue === null)).toBe(true);
  });
});

import type { DailyTechnicalResponse } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { blendSeries, technicalSeries } from "./chart-series";
import { priceVersusAverage, selectLatestTechnicals } from "./technicals";

describe("selectLatestTechnicals", () => {
  it("projects only the indicators present on the newest row", () => {
    const snapshot = selectLatestTechnicals([
      { date: "2026-08-27", sma20d: 100, sma50d: 90 },
      { date: "2026-08-28", sma20d: 101, ema200d: 80 },
    ]);

    expect(snapshot?.date).toBe("2026-08-28");
    expect(snapshot?.readings).toEqual([
      { key: "sma20d", label: "SMA 20", value: 101 },
      { key: "ema200d", label: "EMA 200", value: 80 },
    ]);
  });

  it("returns undefined when there are no rows or no warmed-up indicators", () => {
    expect(selectLatestTechnicals([])).toBeUndefined();
    expect(selectLatestTechnicals([{ date: "2026-08-28" }])).toBeUndefined();
  });
});

describe("priceVersusAverage", () => {
  it("positions the close relative to the average", () => {
    expect(priceVersusAverage(102, 100)).toBeCloseTo(0.02, 10);
    expect(priceVersusAverage(98, 100)).toBeCloseTo(-0.02, 10);
  });

  it("cannot be computed against a non-positive average", () => {
    expect(priceVersusAverage(100, 0)).toBeUndefined();
  });
});

describe("technicalSeries", () => {
  it("omits warm-up days instead of interpolating them", () => {
    const rows: DailyTechnicalResponse[] = [
      { date: "2026-08-26" },
      { date: "2026-08-27", sma50d: 90 },
      { date: "2026-08-28", sma50d: 91 },
    ];

    expect(technicalSeries(rows, "sma50d")).toEqual([
      { date: "2026-08-27", value: 90 },
      { date: "2026-08-28", value: 91 },
    ]);
  });
});

describe("blendSeries", () => {
  it("keeps only the requested blend, keyed by valuation date", () => {
    const rows = [
      {
        valuationDate: "2026-08-27",
        sourceDataAsOf: "2026-08-27T00:00:00.000Z",
        blendId: "BALANCED" as const,
        valuePerShare: 240,
        currency: "USD",
      },
      {
        valuationDate: "2026-08-27",
        sourceDataAsOf: "2026-08-27T00:00:00.000Z",
        blendId: "DIVIDEND" as const,
        valuePerShare: 220,
        currency: "USD",
      },
    ];

    expect(blendSeries(rows, "BALANCED")).toEqual([
      { date: "2026-08-27", value: 240 },
    ]);
  });
});

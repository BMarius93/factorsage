import {
  MOVING_AVERAGE_SERIES,
  type DailyTechnicalResponse,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { blendSeries, technicalSeries } from "./chart-series";
import {
  priceVersusAverage,
  selectLatestTechnicals,
  TECHNICAL_INDICATORS,
} from "./technicals";

describe("selectLatestTechnicals", () => {
  it("projects only the indicators present on the newest row, with catalog labels", () => {
    const snapshot = selectLatestTechnicals([
      { date: "2026-08-27", sma20d: 100, sma50d: 90 },
      { date: "2026-08-28", sma20d: 101, ema200d: 80, sma50w: 95 },
    ]);

    expect(snapshot?.date).toBe("2026-08-28");
    // Ordered by the canonical catalog: daily entries first, then weekly.
    expect(snapshot?.readings).toEqual([
      { key: "sma20d", label: "SMA 20D", value: 101 },
      { key: "ema200d", label: "EMA 200D", value: 80 },
      { key: "sma50w", label: "SMA 50W", value: 95 },
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

describe("technical summary rows", () => {
  it("comes from the canonical catalog rather than a second local list", () => {
    expect(TECHNICAL_INDICATORS).toHaveLength(MOVING_AVERAGE_SERIES.length);
    expect(TECHNICAL_INDICATORS.map((row) => row.label)).toEqual(
      MOVING_AVERAGE_SERIES.map((series) => series.label),
    );
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

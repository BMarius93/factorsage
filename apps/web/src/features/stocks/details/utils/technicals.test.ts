import {
  findSelectableSeries,
  STOCK_SUMMARY_TECHNICAL_IDS,
  type DailyTechnicalResponse,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { blendSeries, technicalSeries } from "./chart-series";
import {
  priceVersusAverage,
  TECHNICAL_SUMMARY_SERIES,
  technicalRows,
} from "./technicals";

describe("technicalRows", () => {
  it("states exactly EMA 50D, EMA 200D and RSI 14D, each with its own reading and session", () => {
    expect(
      technicalRows([
        { id: "RSI_14D", date: "2026-08-27", value: 58.4 },
        { id: "EMA_50D", date: "2026-08-28", value: 220 },
      ]),
    ).toEqual([
      {
        id: "EMA_50D",
        label: "EMA 50D",
        kind: "average",
        date: "2026-08-28",
        value: 220,
      },
      // No reading in the window: a row that says so, never a zero.
      { id: "EMA_200D", label: "EMA 200D", kind: "average" },
      {
        id: "RSI_14D",
        label: "RSI 14D",
        kind: "oscillator",
        date: "2026-08-27",
        value: 58.4,
      },
    ]);
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
  it("take their identities from the contract and their labels from the canonical catalog", () => {
    expect(TECHNICAL_SUMMARY_SERIES.map((row) => row.id)).toEqual([
      ...STOCK_SUMMARY_TECHNICAL_IDS,
    ]);
    expect(TECHNICAL_SUMMARY_SERIES.map((row) => row.label)).toEqual(
      STOCK_SUMMARY_TECHNICAL_IDS.map((id) => findSelectableSeries(id)?.label),
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

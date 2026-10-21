import type { DailyPriceResponse } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { summarizePrices, summarizeQuote } from "./price-summary";

function bar(
  date: string,
  close: number,
  overrides: Partial<DailyPriceResponse> = {},
): DailyPriceResponse {
  return {
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
    ...overrides,
  };
}

describe("summarizePrices", () => {
  it("derives the latest close and the change against the previous trading day", () => {
    const summary = summarizePrices([
      bar("2026-08-26", 100),
      bar("2026-08-27", 200),
      bar("2026-08-28", 205, { volume: 41_237_500 }),
    ]);

    expect(summary).toMatchObject({
      latestClose: 205,
      latestDate: "2026-08-28",
      latestVolume: 41_237_500,
      dayHigh: 206,
      dayLow: 204,
    });
    expect(summary?.change).toEqual({
      absolute: 5,
      fraction: 0.025,
      previousClose: 200,
      previousDate: "2026-08-27",
    });
  });

  it("tracks the window high and low across all supplied rows", () => {
    const summary = summarizePrices([
      bar("2026-01-05", 90, { high: 120, low: 80 }),
      bar("2026-08-28", 100),
    ]);

    expect(summary?.windowHigh).toBe(120);
    expect(summary?.windowLow).toBe(80);
  });

  it("omits the change when only one trading day is available", () => {
    const summary = summarizePrices([bar("2026-08-28", 100)]);

    expect(summary?.latestClose).toBe(100);
    expect(summary?.change).toBeUndefined();
  });

  it("returns undefined for an empty window", () => {
    expect(summarizePrices([])).toBeUndefined();
  });
});

describe("summarizeQuote", () => {
  it("states the summary's quote exactly as the window's rows would", () => {
    const rows = [bar("2026-08-27", 100), bar("2026-08-28", 102)];
    const fromRows = summarizePrices(rows);
    expect(
      summarizeQuote({
        date: "2026-08-28",
        open: rows[1]!.open,
        high: rows[1]!.high,
        low: rows[1]!.low,
        close: 102,
        volume: rows[1]!.volume,
        previousDate: "2026-08-27",
        previousClose: 100,
        rangeHigh: fromRows!.windowHigh,
        rangeLow: fromRows!.windowLow,
      }),
    ).toEqual(fromRows);
  });

  it("omits the change when the window holds no previous session", () => {
    expect(
      summarizeQuote({
        date: "2026-08-28",
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 1,
        rangeHigh: 1,
        rangeLow: 1,
      }).change,
    ).toBeUndefined();
  });
});

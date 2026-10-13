import type { BenchmarkDailyPrice, LocalDate } from "@intrinsic/domain";
import { createEvaluationFrame, readOperand } from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import {
  benchmarkSessionFinalizedAt,
  buildBenchmarkTechnicalContext,
  type BenchmarkTechnicalSnapshot,
} from "./benchmark-technicals.js";
import { addDays } from "./dates.js";
import { withEtfOperandColumns } from "./etf-frame-columns.js";

function weekdaySessions(from: LocalDate, count: number): LocalDate[] {
  const result: LocalDate[] = [];
  let date = from;
  while (result.length < count) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day !== 0 && day !== 6) {
      result.push(date);
    }
    date = addDays(date, 1) as LocalDate;
  }
  return result;
}

function snapshotOf(dates: readonly LocalDate[]): BenchmarkTechnicalSnapshot {
  const bars: BenchmarkDailyPrice[] = dates.map((date, index) => ({
    seriesId: "series-xlk",
    date,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1_000_000,
  }));
  const last = dates[dates.length - 1]!;
  const finalized = benchmarkSessionFinalizedAt(last, 0).getTime();
  const context = buildBenchmarkTechnicalContext({
    seriesId: "series-xlk",
    history: {
      seriesId: "series-xlk",
      basisGeneration: 1,
      rows: bars,
      missing: [],
      source: "REDIS",
    },
    refreshState: { lastTailSyncAt: new Date(finalized + 1000).toISOString() },
    missingFromFloor: [],
    now: new Date(finalized + 2000),
    publicationDelayMs: 0,
  });
  if (context.status !== "READY") {
    throw new Error(`fixture not ready: ${context.status}`);
  }
  return context.snapshot;
}

describe("withEtfOperandColumns", () => {
  const etfDates = weekdaySessions("2026-01-05", 40);
  const snapshot = snapshotOf(etfDates);
  // The stock trades on a session the ETF does not (an ETF-only holiday gap) and vice versa.
  const stockDates = [
    ...etfDates.slice(21, 30).filter((date) => date !== etfDates[25]),
    addDays(etfDates[29]!, 1) as LocalDate, // a Saturday or next day the ETF has no bar for
  ].sort();
  const frame = createEvaluationFrame({
    securityId: "security-1",
    symbol: "ALFA",
    name: "Alfa Corp",
    dates: stockDates,
    closes: Float64Array.from(stockDates.map((_, index) => 50 + index)),
    columns: new Map([["series:RSI_14D", Float64Array.from(stockDates.map(() => 55))]]),
    periodStartIndex: 0,
  });

  it("joins by exact session date, NaN where the ETF has no finalized bar", () => {
    const joined = withEtfOperandColumns(
      frame,
      ["etf:ETF_XLK:price", "etf:ETF_XLK:relative-volume:20", "etf:ETF_XLK:series:SMA_20D"],
      new Map([["ETF_XLK", snapshot]]),
    );
    stockDates.forEach((date, index) => {
      const etfIndex = snapshot.index.get(date);
      const price = readOperand(joined, "etf:ETF_XLK:price", index);
      if (etfIndex === undefined) {
        expect(Number.isNaN(price)).toBe(true);
      } else {
        expect(price).toBe(snapshot.closes[etfIndex]);
      }
    });
    // The frame's own columns and identity are untouched.
    expect(readOperand(joined, "series:RSI_14D", 0)).toBe(55);
    expect(joined.securityId).toBe("security-1");
    expect(joined.dates).toEqual(frame.dates);
    // RVOL of a flat-volume series is exactly 1 wherever its window is complete.
    const firstJoint = stockDates.findIndex(
      (date) => snapshot.index.get(date) !== undefined,
    );
    expect(
      readOperand(joined, "etf:ETF_XLK:relative-volume:20", firstJoint),
    ).toBe(1);
  });

  it("joins all-NaN columns for an ETF with no snapshot, degrading only those conditions", () => {
    const joined = withEtfOperandColumns(
      frame,
      ["etf:ETF_GLD:price"],
      new Map([["ETF_XLK", snapshot]]),
    );
    for (let index = 0; index < stockDates.length; index += 1) {
      expect(Number.isNaN(readOperand(joined, "etf:ETF_GLD:price", index))).toBe(
        true,
      );
    }
  });

  it("refuses a key it cannot decode to a snapshot field, and returns the frame unchanged for none", () => {
    expect(() =>
      withEtfOperandColumns(frame, ["series:RSI_14D"], new Map()),
    ).toThrow(/Unsupported ETF evaluation operand/);
    expect(() =>
      withEtfOperandColumns(frame, ["etf:ETF_XLK:fundamental:ROIC_TTM"], new Map()),
    ).toThrow(/Unsupported ETF evaluation operand/);
    expect(withEtfOperandColumns(frame, [], new Map())).toBe(frame);
  });
});

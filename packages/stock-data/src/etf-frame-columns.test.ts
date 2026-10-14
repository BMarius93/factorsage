import {
  MOVING_AVERAGE_SERIES,
  OSCILLATOR_SERIES,
  type StrategyEtfSourceCode,
} from "@intrinsic/contracts";
import {
  DAILY_RELATIVE_VOLUMES,
  type BenchmarkDailyPrice,
  type LocalDate,
} from "@intrinsic/domain";
import {
  createEvaluationFrame,
  readOperand,
  type EvaluationFrame,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import {
  benchmarkSessionFinalizedAt,
  buildBenchmarkTechnicalContext,
  type BenchmarkTechnicalSnapshot,
} from "./benchmark-technicals.js";
import { addDays } from "./dates.js";
import { withEtfOperandColumns } from "./etf-frame-columns.js";
import { referenceMovingAverage } from "./moving-average-oracle.test-helper.js";
import { referenceWilderRsi } from "./wilder-rsi-oracle.test-helper.js";

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
  return snapshotOfBars(
    dates.map((date, index) => ({
      seriesId: "series-xlk",
      date,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 1_000_000,
    })),
  );
}

function snapshotOfBars(
  bars: readonly BenchmarkDailyPrice[],
): BenchmarkTechnicalSnapshot {
  const last = bars[bars.length - 1]!.date;
  const finalized = benchmarkSessionFinalizedAt(last, 0).getTime();
  const context = buildBenchmarkTechnicalContext({
    seriesId: bars[0]!.seriesId,
    history: {
      seriesId: bars[0]!.seriesId,
      basisGeneration: 1,
      rows: [...bars],
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

/** Deterministic pseudorandom OHLCV, so every run sees the same two funds. */
function randomBars(
  seriesId: string,
  dates: readonly LocalDate[],
  seed: number,
): BenchmarkDailyPrice[] {
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xffffffff;
  };
  let close = 100;
  return dates.map((date) => {
    close = Math.max(5, close * (1 + (random() - 0.5) * 0.04));
    const open = close * (1 + (random() - 0.5) * 0.01);
    return {
      seriesId,
      date,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: Math.round(1_000_000 + random() * 9_000_000),
    };
  });
}

/**
 * The 21 metrics' expected values for one fund on every one of its own sessions, computed from its
 * bars alone by deliberately naive oracles — never through the snapshot, the derived-state kernel
 * or the weekly aggregation the join reads.
 */
function oracleByDate(
  bars: readonly BenchmarkDailyPrice[],
): Map<LocalDate, Map<string, number | undefined>> {
  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume);
  // Weeks: Monday-start calendar weeks, written out here; the week holding the newest bar is still
  // in progress and excluded; a week's close is its last bar's, usable from that bar's own date.
  const mondayOf = (date: LocalDate): string => {
    const day = new Date(`${date}T00:00:00.000Z`);
    const back = (day.getUTCDay() + 6) % 7;
    return new Date(day.getTime() - back * 86_400_000).toISOString().slice(0, 10);
  };
  const currentWeek = mondayOf(bars[bars.length - 1]!.date);
  const weeks: { lastDate: LocalDate; close: number }[] = [];
  for (const bar of bars) {
    const monday = mondayOf(bar.date);
    if (monday === currentWeek) {
      continue;
    }
    const previous = weeks[weeks.length - 1];
    if (previous && mondayOf(previous.lastDate) === monday) {
      previous.lastDate = bar.date;
      previous.close = bar.close;
    } else {
      weeks.push({ lastDate: bar.date, close: bar.close });
    }
  }
  const weeklyCloses = weeks.map((week) => week.close);

  const byKey = new Map<string, (index: number, date: LocalDate) => number | undefined>();
  byKey.set("sector:price", (index) => closes[index]);
  for (const series of MOVING_AVERAGE_SERIES) {
    if (series.source.kind !== "MOVING_AVERAGE") {
      continue;
    }
    const { type, period, timeframe } = series.source;
    if (timeframe === "1D") {
      const reference = referenceMovingAverage(closes, type, period);
      byKey.set(`sector:series:${series.id}`, (index) => reference[index]);
    } else {
      const reference = referenceMovingAverage(weeklyCloses, type, period);
      byKey.set(`sector:series:${series.id}`, (_index, date) => {
        let latest = -1;
        weeks.forEach((week, position) => {
          if (week.lastDate <= date) {
            latest = position;
          }
        });
        return latest < 0 ? undefined : reference[latest];
      });
    }
  }
  for (const series of OSCILLATOR_SERIES) {
    if (series.source.kind !== "OSCILLATOR") {
      continue;
    }
    const reference = referenceWilderRsi(closes, series.source.period);
    byKey.set(`sector:series:${series.id}`, (index) => reference[index]);
  }
  for (const { period } of DAILY_RELATIVE_VOLUMES) {
    byKey.set(`sector:relative-volume:${period}`, (index) => {
      if (index < period) {
        return undefined;
      }
      let sum = 0;
      for (let back = 1; back <= period; back += 1) {
        sum += volumes[index - back]!;
      }
      return volumes[index]! / (sum / period);
    });
  }
  return new Map(
    bars.map((bar, index) => [
      bar.date,
      new Map(
        [...byKey.entries()].map(([key, value]) => [key, value(index, bar.date)]),
      ),
    ]),
  );
}

describe("withEtfOperandColumns — Stock's Sector", () => {
  // Enough weeks for the 200-week averages to be defined over the tail.
  const sessions = weekdaySessions("2019-01-07", 1_100);
  // XLK misses one session the stocks traded (a provider gap); XLF lists 60 sessions after the
  // stocks' history begins (the listing boundary).
  const gap = sessions[700]!;
  const xlkBars = randomBars(
    "series-xlk",
    sessions.filter((date) => date !== gap),
    23,
  );
  const xlfBars = randomBars("series-xlf", sessions.slice(60), 41);
  const snapshots = new Map<StrategyEtfSourceCode, BenchmarkTechnicalSnapshot>([
    ["ETF_XLK", snapshotOfBars(xlkBars)],
    ["ETF_XLF", snapshotOfBars(xlfBars)],
  ]);
  const oracles = new Map<StrategyEtfSourceCode, ReturnType<typeof oracleByDate>>([
    ["ETF_XLK", oracleByDate(xlkBars)],
    ["ETF_XLF", oracleByDate(xlfBars)],
  ]);

  const SECTOR_KEYS = [
    "sector:price",
    ...MOVING_AVERAGE_SERIES.map((series) => `sector:series:${series.id}`),
    ...OSCILLATOR_SERIES.map((series) => `sector:series:${series.id}`),
    ...DAILY_RELATIVE_VOLUMES.map(({ period }) => `sector:relative-volume:${period}`),
  ];

  function stockFrame(symbol: string): EvaluationFrame {
    return createEvaluationFrame({
      securityId: `security-${symbol}`,
      symbol,
      name: symbol,
      dates: sessions,
      closes: Float64Array.from(sessions.map((_, index) => 10 + index)),
      columns: new Map([
        ["series:RSI_14D", Float64Array.from(sessions.map(() => 33))],
      ]),
      periodStartIndex: 0,
    });
  }

  it("covers exactly the 21 technical metrics", () => {
    expect(SECTOR_KEYS).toHaveLength(21);
  });

  it("joins all 21 metrics from each security's own sector fund, matching independent oracles", () => {
    let compared = 0;
    let defined = 0;
    for (const [symbol, code] of [
      ["AAPL", "ETF_XLK"],
      ["MSFT", "ETF_XLK"],
      ["JPM", "ETF_XLF"],
    ] as const) {
      const joined = withEtfOperandColumns(
        stockFrame(symbol),
        SECTOR_KEYS,
        snapshots,
        code,
      );
      const oracle = oracles.get(code)!;
      sessions.forEach((date, index) => {
        const expected = oracle.get(date);
        for (const key of SECTOR_KEYS) {
          const read = readOperand(joined, key, index);
          const value = expected?.get(key);
          compared += 1;
          if (value === undefined) {
            // Before the fund lists, on its missing session, or inside a warm-up: absent.
            expect(Number.isNaN(read), `${symbol} ${key} ${date}`).toBe(true);
          } else {
            defined += 1;
            expect(read, `${symbol} ${key} ${date}`).toBeCloseTo(value, 8);
          }
        }
      });
      // The stock's own column is never touched by the join.
      expect(readOperand(joined, "series:RSI_14D", 500)).toBe(33);
    }
    expect(compared).toBe(3 * 1_100 * 21);
    // Every metric is defined over most of the history, the 200-week averages included.
    expect(defined).toBeGreaterThan(3 * 21 * 100);
  });

  it("reads NaN on the sessions the fund does not have, never a neighbour's value", () => {
    const aapl = withEtfOperandColumns(stockFrame("AAPL"), SECTOR_KEYS, snapshots, "ETF_XLK");
    const jpm = withEtfOperandColumns(stockFrame("JPM"), SECTOR_KEYS, snapshots, "ETF_XLF");
    expect(Number.isNaN(readOperand(jpm, "sector:price", 700))).toBe(false);
    for (const key of SECTOR_KEYS) {
      expect(Number.isNaN(readOperand(aapl, key, 700))).toBe(true);
      // XLF has that session, so JPM's reading on the same date is XLF's own, wherever XLF's
      // warm-up has passed (the 200-week averages have not, 640 sessions after its listing).
      const xlf = oracles.get("ETF_XLF")!.get(sessions[700]!)!.get(key);
      if (xlf === undefined) {
        expect(Number.isNaN(readOperand(jpm, key, 700))).toBe(true);
      } else {
        expect(readOperand(jpm, key, 700)).toBeCloseTo(xlf, 8);
      }
      for (let index = 0; index < 60; index += 1) {
        expect(Number.isNaN(readOperand(jpm, key, index))).toBe(true);
      }
    }
  });

  it("joins all-NaN columns for a security whose sector resolved to no fund", () => {
    const joined = withEtfOperandColumns(stockFrame("NONE"), SECTOR_KEYS, snapshots, null);
    for (const key of SECTOR_KEYS) {
      for (let index = 0; index < sessions.length; index += 1) {
        expect(Number.isNaN(readOperand(joined, key, index))).toBe(true);
      }
    }
  });

  it("joins all-NaN columns when the resolved fund has no snapshot this run, never another fund", () => {
    const joined = withEtfOperandColumns(stockFrame("XOM"), SECTOR_KEYS, snapshots, "ETF_XLE");
    for (const key of SECTOR_KEYS) {
      expect(Number.isNaN(readOperand(joined, key, 900))).toBe(true);
    }
  });

  it("keeps named-ETF keys on their own fund beside sector keys on the security's fund", () => {
    const joined = withEtfOperandColumns(
      stockFrame("JPM"),
      ["etf:ETF_XLK:price", "sector:price"],
      snapshots,
      "ETF_XLF",
    );
    const date = sessions[900]!;
    expect(readOperand(joined, "etf:ETF_XLK:price", 900)).toBe(
      oracles.get("ETF_XLK")!.get(date)!.get("sector:price"),
    );
    expect(readOperand(joined, "sector:price", 900)).toBe(
      oracles.get("ETF_XLF")!.get(date)!.get("sector:price"),
    );
    expect(readOperand(joined, "sector:price", 900)).not.toBe(
      readOperand(joined, "etf:ETF_XLK:price", 900),
    );
  });

  it("refuses a sector key that decodes to no ETF field", () => {
    expect(() =>
      withEtfOperandColumns(stockFrame("AAPL"), ["sector:fundamental:ROIC_TTM"], snapshots, "ETF_XLK"),
    ).toThrow(/Unsupported ETF evaluation operand/);
    expect(() =>
      withEtfOperandColumns(stockFrame("AAPL"), ["sector:series:BALANCED"], snapshots, "ETF_XLK"),
    ).toThrow(/Unsupported ETF evaluation operand/);
  });
});

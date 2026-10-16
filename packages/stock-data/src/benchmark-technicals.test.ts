import {
  DAILY_OSCILLATORS,
  DAILY_RELATIVE_VOLUMES,
  MATERIALIZED_MOVING_AVERAGES,
  type BenchmarkDailyPrice,
  type DailyPrice,
  type LocalDate,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_TECHNICAL_FIELDS,
  benchmarkSessionFinalizedAt,
  benchmarkTechnicalValueOn,
  buildBenchmarkTechnicalContext,
  finalizedBenchmarkBars,
  latestFinalizedBenchmarkSession,
  type BenchmarkTechnicalContext,
  type BenchmarkTechnicalSnapshot,
} from "./benchmark-technicals.js";
import { buildDailyDerivedState } from "./derived-state.js";
import { addDays } from "./dates.js";
import { referenceMovingAverage } from "./moving-average-oracle.test-helper.js";
import { quantizeToStoredDecimal } from "./stored-decimal.js";
import { referenceWilderRsi } from "./wilder-rsi-oracle.test-helper.js";
import {
  aggregateCompletedWeeks,
  resolveWeekSessionEnds,
  startOfIsoWeek,
} from "./weekly.js";

const SERIES_ID = "series-etf-xlk";
const DELAY_MS = 30 * 60 * 1000;

/** Deterministic pseudorandom source, so every run sees the same history. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0xffffffff;
  };
}

function weekday(date: LocalDate): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** `count` consecutive weekday sessions from `from`, optionally skipping listed holidays. */
function sessions(
  from: LocalDate,
  count: number,
  holidays: readonly LocalDate[] = [],
): LocalDate[] {
  const result: LocalDate[] = [];
  let date = from;
  while (result.length < count) {
    const day = weekday(date);
    if (day !== 0 && day !== 6 && !holidays.includes(date)) {
      result.push(date);
    }
    date = addDays(date, 1) as LocalDate;
  }
  return result;
}

function barsOn(
  dates: readonly LocalDate[],
  seed = 7,
): BenchmarkDailyPrice[] {
  const random = seeded(seed);
  let close = 100;
  return dates.map((date) => {
    close = Math.max(5, close * (1 + (random() - 0.5) * 0.04));
    const open = close * (1 + (random() - 0.5) * 0.01);
    return {
      seriesId: SERIES_ID,
      date,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: Math.round(1_000_000 + random() * 9_000_000),
    };
  });
}

/** A moment after the newest bar's session finalized, with the watermark synced after it. */
function syncedAfter(bars: readonly BenchmarkDailyPrice[]): {
  now: Date;
  lastTailSyncAt: string;
} {
  const last = bars[bars.length - 1]!;
  const finalized = benchmarkSessionFinalizedAt(last.date, DELAY_MS).getTime();
  return {
    now: new Date(finalized + 60 * 60 * 1000),
    lastTailSyncAt: new Date(finalized + 30 * 60 * 1000).toISOString(),
  };
}

function readyContext(
  bars: readonly BenchmarkDailyPrice[],
  overrides: Partial<Parameters<typeof buildBenchmarkTechnicalContext>[0]> = {},
): BenchmarkTechnicalContext {
  const { now, lastTailSyncAt } = syncedAfter(bars);
  return buildBenchmarkTechnicalContext({
    seriesId: SERIES_ID,
    history: { seriesId: SERIES_ID, basisGeneration: 3, rows: [...bars], missing: [], source: "REDIS" },
    refreshState: { lastTailSyncAt },
    missingFromFloor: [],
    now,
    publicationDelayMs: DELAY_MS,
    ...overrides,
  });
}

function snapshotOf(context: BenchmarkTechnicalContext): BenchmarkTechnicalSnapshot {
  if (context.status !== "READY") {
    throw new Error(`Expected READY, got ${context.status}`);
  }
  return context.snapshot;
}

describe("stock/ETF methodology parity", () => {
  it("produces bit-identical values to the stock calculation path on identical bars", () => {
    const bars = barsOn(sessions("2021-01-04", 700), 11);
    const snapshot = snapshotOf(readyContext(bars));

    // The stock path, fed the very same OHLCV under a stock identity, with the same completed-week
    // anchor the adapter derives (the last bar's own date).
    const stockPrices: DailyPrice[] = bars.map((bar) => ({
      securityId: "stock-1",
      date: bar.date,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
    }));
    const lastDate = stockPrices[stockPrices.length - 1]!.date;
    const stockRows = buildDailyDerivedState({
      prices: stockPrices,
      weeklyBars: aggregateCompletedWeeks(stockPrices, lastDate, {
        historyStart: stockPrices[0]!.date,
        historyStartOrigin: "LISTING",
      }),
    });

    expect(snapshot.dates).toEqual(stockRows.map((row) => row.date));
    for (const field of BENCHMARK_TECHNICAL_FIELDS) {
      const column = snapshot.columns.get(field)!;
      stockRows.forEach((row, index) => {
        const stockValue = row[field];
        if (typeof stockValue === "number") {
          // Exact equality with what a stock *reads*: the same kernel, then the same storage-scale
          // rounding the stock's `numeric(20, 8)` column applies (FIN-12) — bit-for-bit.
          expect(column[index]).toBe(quantizeToStoredDecimal(stockValue));
        } else {
          expect(Number.isNaN(column[index])).toBe(true);
        }
      });
    }
  });
});

describe("stock and ETF weekly values on holiday calendars, evening by evening", () => {
  // Good Friday, Independence Day (a Friday in 2025, observed on Friday 3 July 2026), Juneteenth
  // (a Friday in 2026), Thanksgiving and Christmas: weeks that end on a Thursday or a Wednesday.
  const holidays: LocalDate[] = [
    "2025-04-18",
    "2025-07-04",
    "2025-11-27",
    "2025-12-25",
    "2026-01-01",
    "2026-04-03",
    "2026-06-19",
    "2026-07-03",
  ];
  const isScheduledSession = async (date: LocalDate) =>
    weekday(date) !== 0 && weekday(date) !== 6 && !holidays.includes(date);

  it.each([3, 5, 8, 13, 21])(
    "seed %i: every session's weekly value is the same on every later evening, for the fund and for a stock",
    async (seed) => {
      const all = barsOn(sessions("2025-01-06", 420, holidays), seed);
      const sessionEnds = await resolveWeekSessionEnds({
        dates: all.map((bar) => bar.date),
        isScheduledSession,
      });
      const final = snapshotOf(readyContext(all, { sessionEnds }));
      const stockPrices: DailyPrice[] = all.map((bar) => ({
        securityId: "stock-1",
        date: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume,
      }));
      const stockRows = buildDailyDerivedState({
        prices: stockPrices,
        weeklyBars: aggregateCompletedWeeks(
          stockPrices,
          stockPrices[stockPrices.length - 1]!.date,
          { historyStart: stockPrices[0]!.date, historyStartOrigin: "LISTING" },
          sessionEnds,
        ),
      });
      const weekly = BENCHMARK_TECHNICAL_FIELDS.filter((field) => field.endsWith("w"));
      // The stock path and the fund path: one value, bit for bit, at the stock's storage scale.
      for (const field of weekly) {
        const column = final.columns.get(field)!;
        stockRows.forEach((row, index) => {
          const value = row[field];
          if (typeof value === "number") {
            expect(column[index]).toBe(quantizeToStoredDecimal(value));
          } else {
            expect(Number.isNaN(column[index])).toBe(true);
          }
        });
      }
      // Every evening of the last sixty sessions: the snapshot then answers each of its sessions
      // exactly as the finished history does.
      for (let end = all.length - 60; end <= all.length; end += 1) {
        const prefix = all.slice(0, end);
        const evening = snapshotOf(
          readyContext(prefix, {
            sessionEnds: await resolveWeekSessionEnds({
              dates: prefix.map((bar) => bar.date),
              isScheduledSession,
            }),
          }),
        );
        for (const field of weekly) {
          const now = evening.columns.get(field)!;
          const later = final.columns.get(field)!;
          for (let index = 0; index < prefix.length; index += 1) {
            if (Number.isNaN(now[index]!)) {
              expect(Number.isNaN(later[index]!), `${field} ${prefix[index]!.date}`).toBe(true);
            } else {
              expect(now[index], `${field} ${prefix[index]!.date}`).toBe(later[index]);
            }
          }
        }
      }
    },
    60_000,
  );
});

describe("independent numerical oracles", () => {
  const bars = barsOn(sessions("2022-03-01", 320), 23);
  const snapshot = snapshotOf(readyContext(bars));
  const closes = bars.map((bar) => bar.close);

  it("matches the independent moving-average oracle for every daily average", () => {
    for (const average of MATERIALIZED_MOVING_AVERAGES.filter(
      (entry) => entry.timeframe === "1D",
    )) {
      const expected = referenceMovingAverage(
        closes,
        average.type,
        average.period,
      );
      const column = snapshot.columns.get(average.field)!;
      expected.forEach((value, index) => {
        if (value === undefined) {
          expect(Number.isNaN(column[index])).toBe(true);
        } else {
          expect(column[index]).toBeCloseTo(value, 8);
        }
      });
    }
  });

  it("matches the independent Wilder RSI oracle for every period", () => {
    for (const oscillator of DAILY_OSCILLATORS) {
      const expected = referenceWilderRsi(closes, oscillator.period);
      const column = snapshot.columns.get(oscillator.field)!;
      expected.forEach((value, index) => {
        if (value === undefined) {
          expect(Number.isNaN(column[index])).toBe(true);
        } else {
          expect(column[index]).toBeCloseTo(value, 8);
        }
      });
    }
  });

  it("matches an independent prior-session-mean RVOL for every period", () => {
    const volumes = bars.map((bar) => bar.volume);
    for (const { period, field } of DAILY_RELATIVE_VOLUMES) {
      const column = snapshot.columns.get(field)!;
      volumes.forEach((volume, index) => {
        if (index < period) {
          expect(Number.isNaN(column[index])).toBe(true);
          return;
        }
        let sum = 0;
        for (let back = 1; back <= period; back += 1) {
          sum += volumes[index - back]!;
        }
        // Read at the stock's storage scale (eight places), so within its rounding.
        expect(column[index]).toBeCloseTo(volume / (sum / period), 7);
      });
    }
  });

  it("matches the independent oracle for weekly averages over completed weekly closes", () => {
    const longBars = barsOn(sessions("2018-01-01", 650), 5);
    const longSnapshot = snapshotOf(readyContext(longBars));
    const prices: DailyPrice[] = longBars.map((bar) => ({ ...bar, securityId: "s" }));
    const weeks = aggregateCompletedWeeks(
      prices,
      longBars[longBars.length - 1]!.date,
      { historyStart: longBars[0]!.date, historyStartOrigin: "LISTING" },
    ).sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));
    const weeklyCloses = weeks.map((week) => week.close);
    const sma20w = referenceMovingAverage(weeklyCloses, "SMA", 20);
    // Check the carried-forward value on each week's eligible date.
    weeks.forEach((week, weekIndex) => {
      const expected = sma20w[weekIndex];
      const read = benchmarkTechnicalValueOn(
        longSnapshot,
        week.eligibleDate,
        "sma20w",
      );
      if (expected === undefined) {
        expect(Number.isNaN(read)).toBe(true);
      } else {
        expect(read).toBeCloseTo(expected, 8);
      }
    });
  });
});

describe("finalized-session synchronization (owner decision 1)", () => {
  const dates = sessions("2026-10-05", 5); // Mon..Fri one week
  const bars = barsOn(dates);

  it("counts a bar only once its close plus the delay has passed", () => {
    const friday = dates[4]!;
    const fridayFinalized = benchmarkSessionFinalizedAt(friday, DELAY_MS);
    const beforeFinal = new Date(fridayFinalized.getTime() - 60 * 1000);
    const kept = finalizedBenchmarkBars({
      rows: bars,
      refreshState: { lastTailSyncAt: new Date(fridayFinalized.getTime() + 1).toISOString() },
      now: beforeFinal,
      publicationDelayMs: DELAY_MS,
    });
    expect(kept.map((bar) => bar.date)).toEqual(dates.slice(0, 4));
  });

  it("refuses a bar the watermark has not confirmed, however late the clock is", () => {
    const thursdayFinalized = benchmarkSessionFinalizedAt(dates[3]!, DELAY_MS);
    const kept = finalizedBenchmarkBars({
      rows: bars,
      // The tail was last read after Thursday finalized but before Friday did: Friday's stored bar
      // may still be the provisional mid-session reading, so the clock alone is not evidence.
      refreshState: {
        lastTailSyncAt: new Date(thursdayFinalized.getTime() + 1000).toISOString(),
      },
      now: new Date(
        benchmarkSessionFinalizedAt(dates[4]!, DELAY_MS).getTime() +
          24 * 60 * 60 * 1000,
      ),
      publicationDelayMs: DELAY_MS,
    });
    expect(kept.map((bar) => bar.date)).toEqual(dates.slice(0, 4));
  });

  it("keeps exactly the bars the per-session rule keeps, at every instant and delay", () => {
    // The rule, stated per bar: the session's close plus the delay has passed, and the watermark
    // is at or after that instant. The implementation finds one cut-off session instead of
    // converting every bar's date; this holds it to the rule across both daylight-saving changes,
    // a delay of zero, an ordinary one, and ones longer than a day.
    const hour = 60 * 60 * 1000;
    const rule = (
      rows: readonly BenchmarkDailyPrice[],
      now: Date,
      syncedAt: Date,
      delayMs: number,
    ) =>
      rows.filter((row) => {
        const finalizedAt = benchmarkSessionFinalizedAt(row.date, delayMs).getTime();
        return finalizedAt <= now.getTime() && finalizedAt <= syncedAt.getTime();
      });
    for (const start of ["2026-03-02", "2026-10-26", "2026-07-06"]) {
      const window = barsOn(sessions(start, 15));
      const reversed = [...window].reverse();
      const first = Date.parse(`${start}T00:00:00.000Z`) - 2 * 24 * hour;
      for (const delayMs of [0, DELAY_MS, 5 * hour, 30 * hour, 72 * hour]) {
        for (let step = 0; step < 24 * 26; step += 7) {
          const now = new Date(first + step * hour + 17 * 60 * 1000);
          for (const lag of [0, 7, 100]) {
            const syncedAt = new Date(now.getTime() - lag * hour);
            const input = {
              refreshState: { lastTailSyncAt: syncedAt.toISOString() },
              now,
              publicationDelayMs: delayMs,
            };
            expect(
              finalizedBenchmarkBars({ rows: window, ...input }),
              `${start} +${step}h delay ${delayMs} lag ${lag}h`,
            ).toEqual(rule(window, now, syncedAt, delayMs));
            // Order is the caller's: nothing here assumes ascending rows.
            expect(finalizedBenchmarkBars({ rows: reversed, ...input })).toEqual(
              rule(reversed, now, syncedAt, delayMs),
            );
          }
        }
      }
    }
    // A watermark ahead of the clock proves nothing the clock has not reached.
    const friday = dates[4]!;
    const beforeFridayFinal = new Date(
      benchmarkSessionFinalizedAt(friday, DELAY_MS).getTime() - 1,
    );
    expect(
      latestFinalizedBenchmarkSession({
        refreshState: { lastTailSyncAt: "2030-01-01T00:00:00.000Z" },
        now: beforeFridayFinal,
        publicationDelayMs: DELAY_MS,
      }),
    ).toBe(dates[3]);
    expect(
      latestFinalizedBenchmarkSession({
        refreshState: { lastTailSyncAt: "2030-01-01T00:00:00.000Z" },
        now: new Date(beforeFridayFinal.getTime() + 1),
        publicationDelayMs: DELAY_MS,
      }),
    ).toBe(friday);
    expect(
      latestFinalizedBenchmarkSession({
        refreshState: {},
        now: new Date("2030-01-01T00:00:00.000Z"),
        publicationDelayMs: DELAY_MS,
      }),
    ).toBeUndefined();
  });

  it("is NOT_SYNCHRONIZED before any tail read has completed", () => {
    const context = buildBenchmarkTechnicalContext({
      seriesId: SERIES_ID,
      history: { seriesId: SERIES_ID, basisGeneration: 0, rows: bars, missing: [], source: "POSTGRESQL" },
      refreshState: {},
      missingFromFloor: [],
      now: new Date("2026-10-12T00:00:00.000Z"),
      publicationDelayMs: DELAY_MS,
    });
    expect(context.status).toBe("NOT_SYNCHRONIZED");
  });

  it("is EMPTY when no finalized session holds a bar yet", () => {
    const monday = dates[0]!;
    const context = buildBenchmarkTechnicalContext({
      seriesId: SERIES_ID,
      history: {
        seriesId: SERIES_ID,
        basisGeneration: 2,
        rows: bars.slice(0, 1),
        missing: [],
        source: "REDIS",
      },
      refreshState: { lastTailSyncAt: "2026-10-05T12:00:00.000Z" },
      missingFromFloor: [],
      // Mid-session on Monday: the only stored bar is provisional.
      now: new Date(
        benchmarkSessionFinalizedAt(monday, DELAY_MS).getTime() - 60_000,
      ),
      publicationDelayMs: DELAY_MS,
    });
    expect(context).toEqual({ status: "EMPTY", basisGeneration: 2 });
  });
});

describe("the floor-anchored coverage gate (owner decision 7)", () => {
  it("refuses to compute from a history whose coverage does not reach the floor", () => {
    const bars = barsOn(sessions("2020-01-06", 300));
    const context = readyContext(bars, {
      missingFromFloor: [{ from: "1993-01-01", to: "2019-12-31" }],
    });
    expect(context).toEqual({
      status: "NOT_ANCHORED",
      missing: [{ from: "1993-01-01", to: "2019-12-31" }],
    });
  });
});

describe("listing boundaries and exact-session alignment", () => {
  it("keeps a genuine mid-week listing week, like a stock's IPO week", () => {
    // XLC-style: the first bar is a Wednesday. The listing week (Wed-Fri) is a genuine, complete
    // trading week and participates in weekly aggregation.
    const firstBar = "2018-06-20"; // a Wednesday
    expect(weekday(firstBar)).toBe(3);
    const bars = barsOn(sessions(firstBar, 160));
    const snapshot = snapshotOf(readyContext(bars));
    const prices: DailyPrice[] = bars.map((bar) => ({ ...bar, securityId: "s" }));
    const weeks = aggregateCompletedWeeks(
      prices,
      bars[bars.length - 1]!.date,
      { historyStart: firstBar, historyStartOrigin: "LISTING" },
    ).sort((a, b) => a.weekStartDate.localeCompare(b.weekStartDate));
    expect(weeks[0]?.weekStartDate).toBe(startOfIsoWeek(firstBar));
    // sma20w first appears on the 20th completed week's own final trading day — counting the
    // listing week — and is carried onto later sessions until the next week completes.
    const twentieth = weeks[19]!;
    expect(
      Number.isNaN(
        benchmarkTechnicalValueOn(
          snapshot,
          addDays(twentieth.eligibleDate, -1) as LocalDate,
          "sma20w",
        ),
      ),
    ).toBe(true);
    expect(
      benchmarkTechnicalValueOn(snapshot, twentieth.eligibleDate, "sma20w"),
    ).not.toBeNaN();
  });

  it("closes a holiday-shortened week on its own last session, counted by hand", async () => {
    // Twenty-three weeks from Monday 2026-01-05, a session's close being 100 plus its position.
    // Two holidays: a Monday (week 3 opens on a Tuesday) and the Friday of week 21, so that week's
    // last session — its weekly close, and the day it becomes eligible — is a Thursday.
    const mondayHoliday = "2026-01-19" as LocalDate;
    const fridayHoliday = "2026-05-29" as LocalDate;
    const dates = sessions("2026-01-05", 23 * 5 - 2, [mondayHoliday, fridayHoliday]);
    expect(dates[dates.length - 1]).toBe("2026-06-12");
    const bars: BenchmarkDailyPrice[] = dates.map((date, position) => ({
      seriesId: SERIES_ID,
      date,
      open: 100 + position,
      high: 101 + position,
      low: 99 + position,
      close: 100 + position,
      volume: 1_000_000,
    }));
    // The venue schedule that closed those two days, as the production composition reads it.
    const sessionEnds = await resolveWeekSessionEnds({
      dates,
      isScheduledSession: async (date) =>
        weekday(date) !== 0 &&
        weekday(date) !== 6 &&
        date !== mondayHoliday &&
        date !== fridayHoliday,
    });
    const snapshot = snapshotOf(readyContext(bars, { sessionEnds }));

    // The weeks, grouped here by plain calendar arithmetic rather than by the production
    // aggregation: week N holds the sessions of days 7(N-1) .. 7(N-1)+4 after the first Monday.
    const firstMonday = Date.parse("2026-01-05T00:00:00.000Z");
    const weekOf = (date: LocalDate) =>
      Math.floor(
        (Date.parse(`${date}T00:00:00.000Z`) - firstMonday) / (7 * 86_400_000),
      ) + 1;
    const lastSession = new Map<number, LocalDate>();
    const weeklyClose = new Map<number, number>();
    bars.forEach((bar) => {
      lastSession.set(weekOf(bar.date), bar.date);
      weeklyClose.set(weekOf(bar.date), bar.close);
    });
    expect(lastSession.get(21)).toBe("2026-05-28"); // the Thursday
    expect(weekday(lastSession.get(21)!)).toBe(4);
    const meanOfWeeks = (from: number, to: number) => {
      let sum = 0;
      for (let week = from; week <= to; week += 1) {
        sum += weeklyClose.get(week)!;
      }
      return sum / (to - from + 1);
    };
    const sma20wOn = (date: LocalDate) =>
      benchmarkTechnicalValueOn(snapshot, date, "sma20w");

    // No 20-week average before twenty weeks have completed: not on week 20's Thursday …
    expect(Number.isNaN(sma20wOn("2026-05-21" as LocalDate))).toBe(true);
    // … and from week 20's own last session it is the mean of weeks 1..20.
    expect(lastSession.get(20)).toBe("2026-05-22");
    expect(sma20wOn("2026-05-22" as LocalDate)).toBeCloseTo(meanOfWeeks(1, 20), 10);
    // It is carried, unchanged, through the sessions of week 21 that precede its last one …
    expect(sma20wOn("2026-05-27" as LocalDate)).toBeCloseTo(meanOfWeeks(1, 20), 10);
    // … and moves on the Thursday the shortened week ends, using that Thursday's close — not on
    // the Friday that never traded, and not a session early.
    expect(sma20wOn("2026-05-28" as LocalDate)).toBeCloseTo(meanOfWeeks(2, 21), 10);
    expect(Number.isNaN(sma20wOn(fridayHoliday))).toBe(true);
    expect(sma20wOn("2026-06-01" as LocalDate)).toBeCloseTo(meanOfWeeks(2, 21), 10);
    // Week 3, opened by a holiday, is still one week: twenty weeks were counted, not nineteen.
    expect(weeklyClose.size).toBe(23);
    // The last week completes on its own Friday's finalized close: that Friday reads it, exactly
    // as a backtest run later over that Friday reads it.
    expect(sma20wOn("2026-06-11" as LocalDate)).toBeCloseTo(meanOfWeeks(3, 22), 10);
    expect(sma20wOn("2026-06-12" as LocalDate)).toBeCloseTo(meanOfWeeks(4, 23), 10);
  });

  it("answers by exact session only: a missing session reads NaN, never a neighbour", () => {
    const holiday = "2026-09-07" as LocalDate; // Labor Day Monday
    const dates = sessions("2026-08-31", 10, [holiday]);
    const bars = barsOn(dates);
    const snapshot = snapshotOf(readyContext(bars));
    expect(Number.isNaN(benchmarkTechnicalValueOn(snapshot, holiday, "close"))).toBe(
      true,
    );
    expect(Number.isNaN(benchmarkTechnicalValueOn(snapshot, holiday, "rvol10"))).toBe(
      true,
    );
    expect(
      Number.isNaN(
        benchmarkTechnicalValueOn(snapshot, "2026-09-05" as LocalDate, "close"),
      ),
    ).toBe(true); // a Saturday
    expect(
      benchmarkTechnicalValueOn(snapshot, dates[3]!, "close"),
    ).toBeCloseTo(bars[3]!.close, 12);
  });

  it("never fabricates a weekly close from the week the watermark cannot prove is over", () => {
    // The last finalized bar is a Wednesday; Thursday and Friday may exist unseen, so the week is
    // not aggregated and no weekly value moves on it.
    const dates = sessions("2024-01-01", 103); // ends 2024-05-22, a Wednesday
    const bars = barsOn(dates);
    const lastDate = dates[dates.length - 1]!;
    expect(weekday(lastDate)).toBe(3);
    const snapshot = snapshotOf(readyContext(bars));
    const lastWeekStart = startOfIsoWeek(lastDate);
    // The stalled week contributes no weekly bar: the newest weekly source week is an earlier one.
    const mondayOfLastWeek = lastWeekStart;
    const previousFriday = addDays(mondayOfLastWeek, -3) as LocalDate;
    expect(
      benchmarkTechnicalValueOn(snapshot, lastDate, "sma20w"),
    ).toBe(benchmarkTechnicalValueOn(snapshot, previousFriday, "sma20w"));
  });
});

describe("warm-up and no-look-ahead", () => {
  const dates = sessions("2023-01-02", 120);
  const bars = barsOn(dates, 3);
  const snapshot = snapshotOf(readyContext(bars));

  it("produces each series' first value exactly where the stock methodology does", () => {
    const column = (field: Parameters<typeof benchmarkTechnicalValueOn>[2]) =>
      dates.map((date) => benchmarkTechnicalValueOn(snapshot, date, field));
    const firstIndex = (values: number[]) =>
      values.findIndex((value) => !Number.isNaN(value));
    expect(firstIndex(column("sma20d"))).toBe(19);
    expect(firstIndex(column("ema50d"))).toBe(49);
    expect(firstIndex(column("rsi14d"))).toBe(14);
    expect(firstIndex(column("rvol20"))).toBe(20);
    expect(firstIndex(column("close"))).toBe(0);
  });

  it("gives identical values for its own sessions when future history is removed", () => {
    // A prefix of the history, cut at a Friday so both builds anchor their completed weeks the
    // same way a shorter real history would.
    const cut = dates.findIndex((date) => weekday(date) === 5 && date > "2023-04-01");
    const truncated = snapshotOf(readyContext(bars.slice(0, cut + 1)));
    for (const date of dates.slice(0, cut + 1)) {
      for (const field of ["close", "sma20d", "ema20d", "rsi14d", "rvol10"] as const) {
        const full = benchmarkTechnicalValueOn(snapshot, date, field);
        const prefix = benchmarkTechnicalValueOn(truncated, date, field);
        if (Number.isNaN(full)) {
          expect(Number.isNaN(prefix)).toBe(true);
        } else {
          expect(prefix).toBe(full);
        }
      }
    }
  });

  it("treats a zero-volume session as a real reading and a zero baseline as absence", () => {
    const quiet = barsOn(dates.slice(0, 30), 9).map((bar, index) => ({
      ...bar,
      volume: index < 10 ? 0 : bar.volume,
    }));
    const quietSnapshot = snapshotOf(readyContext(quiet));
    // Inside the zero-volume stretch the baseline is zero, so the ratio is undefined: absent.
    expect(
      Number.isNaN(
        benchmarkTechnicalValueOn(quietSnapshot, dates[10]!, "rvol10"),
      ),
    ).toBe(true);
    // Once the full baseline is positive, a session that traded nothing would read exactly 0 —
    // and an ordinary session reads its genuine multiple.
    const later = benchmarkTechnicalValueOn(quietSnapshot, dates[25]!, "rvol10");
    expect(Number.isFinite(later)).toBe(true);
  });
});

/**
 * Pre-release audit 2026-10-16, finding FIN-12 (`docs/audits/pre-release-audit-2026-10-16.md`).
 *
 * A close that equals its exact 20-session mean must read as a tie, so `Price is below SMA 20D` is
 * FALSE on that session. A stock does: its averages are persisted as `DECIMAL(20,8)`, which rounds
 * the running window sum's float residue away (81 of 81 exact daily ties in the QA-matrix data
 * read as ties). An ETF's are the kernel's raw doubles (owner decision 6), and the running sum in
 * `movingAverage` leaves a residue that decides the tie: 45 of the 47 exact ties across the twenty
 * funds and SPY read as strictly above or below — `XLK` 2012-12-20, close 14.69 against a computed
 * SMA 200D of 14.690000000000033, exited ten positions at once in the matrix.
 *
 * These 25 closes are the smallest such history found: the last close, 14.68, is the exact mean of
 * the last twenty (their sum is 293.60), and the running sum reads 14.680000000000001. Failed on
 * `bc11cfed`; the ETF technicals are now read at the stock's storage scale.
 */
describe("exact ties against a moving average (FIN-12)", () => {
  const CLOSES = [
    14.68, 15.02, 15.49, 14.43, 14.45, 14.86, 15.17, 14.55, 14.15, 14.14, 14.75, 14.22, 15.45,
    14.3, 14.37, 14.66, 15.21, 14.6, 14.51, 14.79, 14.23, 15.39, 14.8, 14.77, 14.68,
  ];
  const tieDates = sessions("2024-01-02", CLOSES.length);
  const tieBars: BenchmarkDailyPrice[] = CLOSES.map((close, index) => ({
    seriesId: SERIES_ID,
    date: tieDates[index]!,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000_000,
  }));
  const last = tieDates[tieDates.length - 1]!;

  it("is an exact tie in decimal arithmetic", () => {
    const cents = CLOSES.slice(-20).map((close) => Math.round(close * 100));
    const sum = cents.reduce((total, value) => total + value, 0);
    expect(sum).toBe(29_360);
    expect(sum / 20).toBe(Math.round(CLOSES[CLOSES.length - 1]! * 100));
  });

  it("FIN-12: an ETF reads an exact SMA tie as a tie, as a stock does", () => {
    const snapshot = snapshotOf(readyContext(tieBars));
    expect(benchmarkTechnicalValueOn(snapshot, last, "sma20d")).toBe(
      benchmarkTechnicalValueOn(snapshot, last, "close"),
    );
  });

  it("reads every exact daily SMA tie of a tie-dense history as a tie, neither above nor below", () => {
    // Closes on a handful of cent levels, so a close often equals its exact window mean. The ties
    // are found in integer cents, independently of the kernel.
    const random = seeded(1_216);
    const dates = sessions("2014-01-02", 2_500);
    const cents = dates.map(() => 1_467 + Math.floor(random() * 3));
    const bars: BenchmarkDailyPrice[] = dates.map((date, index) => {
      const close = cents[index]! / 100;
      return { seriesId: SERIES_ID, date, open: close, high: close, low: close, close, volume: 1_000_000 };
    });
    const snapshot = snapshotOf(readyContext(bars));
    const raw = buildDailyDerivedState({
      prices: bars.map((bar) => ({ ...bar, securityId: "stock-1" })),
    });

    const ties: Array<{ date: LocalDate; field: string }> = [];
    let rawMisses = 0;
    for (const period of [20, 50, 100, 200] as const) {
      const field = `sma${period}d` as const;
      let windowSum = 0;
      cents.forEach((close, index) => {
        windowSum += close;
        if (index >= period) {
          windowSum -= cents[index - period]!;
        }
        if (index + 1 < period || windowSum !== close * period) {
          return;
        }
        const date = dates[index]!;
        const average = benchmarkTechnicalValueOn(snapshot, date, field);
        const price = benchmarkTechnicalValueOn(snapshot, date, "close");
        ties.push({ date, field });
        // `is above` and `is below` are strict: both FALSE on a tie.
        expect({ date, field, above: price > average, below: price < average }).toEqual({
          date,
          field,
          above: false,
          below: false,
        });
        expect(raw[index]!.date).toBe(date);
        if (raw[index]![field] !== price) {
          rawMisses += 1;
        }
      });
    }
    // Enough ties at every period to mean something, and the unrounded kernel does decide some of
    // them on float noise — which is what this test would catch coming back.
    for (const period of [20, 50, 100, 200]) {
      expect(ties.filter((tie) => tie.field === `sma${period}d`).length).toBeGreaterThan(30);
    }
    expect(rawMisses).toBeGreaterThan(0);
  });
});


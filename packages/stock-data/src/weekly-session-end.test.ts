import type {
  DailyDerivedState,
  DailyPrice,
  LocalDate,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import { buildDailyDerivedState } from "./derived-state.js";
import { EodFinalityPolicy } from "./eod-finality.js";
import {
  aggregateCompletedWeeks,
  fridayOfIsoWeek,
  resolveWeekSessionEnds,
  startOfIsoWeek,
  type ScheduledSessionCheck,
} from "./weekly.js";

/**
 * A week completes at the finalized close of its last **scheduled** session
 * (`docs/decisions/monitor-eod-v2.md` §9), and a session's row is the same whenever it is
 * materialized. These cases hold the rule to the calendar situations it has to survive, and the
 * property at the end holds it to the invariant that makes a Monitor and a backtest agree: a row,
 * once it exists, never changes because it was calculated on a later evening.
 */

const SECURITY = "weekly-session-end";
const DELAY_MS = 30 * 60_000;
const policy = new EodFinalityPolicy({ publicationDelayMs: DELAY_MS });

function weekday(date: LocalDate): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** A venue schedule: every weekday except `closed`. */
function scheduleClosing(closed: Iterable<LocalDate>): ScheduledSessionCheck {
  const holidays = new Set(closed);
  return async (date) =>
    weekday(date) !== 0 && weekday(date) !== 6 && !holidays.has(date);
}

/** A schedule that cannot answer for anything. */
const unanswerable: ScheduledSessionCheck = async () => undefined;

function bar(date: LocalDate, close: number): DailyPrice {
  return {
    securityId: SECURITY,
    date,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1_000,
  };
}

/** One bar per weekday in `[from, to]`, skipping `missing`, closing on a gentle trend. */
function barsBetween(
  from: LocalDate,
  to: LocalDate,
  missing: Iterable<LocalDate> = [],
): DailyPrice[] {
  const skip = new Set(missing);
  const rows: DailyPrice[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    if (weekday(date) !== 0 && weekday(date) !== 6 && !skip.has(date)) {
      rows.push(bar(date, 100 + rows.length));
    }
  }
  return rows;
}

/**
 * The rows the loader materializes at the EOD cutoff `asOf`: the bars stored by then, the weeks
 * complete by then, the venue's answers for the weeks whose last bar is not their Friday.
 */
async function rowsAt(
  prices: readonly DailyPrice[],
  asOf: LocalDate,
  schedule: ScheduledSessionCheck,
): Promise<DailyDerivedState[]> {
  const stored = prices.filter((price) => price.date <= asOf);
  const sessionEnds = await resolveWeekSessionEnds({
    dates: stored.map((price) => price.date),
    isScheduledSession: schedule,
  });
  return buildDailyDerivedState({
    prices: stored,
    weeklyBars: aggregateCompletedWeeks(stored, asOf, undefined, sessionEnds),
  });
}

function sourceOn(
  rows: readonly DailyDerivedState[],
  date: LocalDate,
): LocalDate | undefined {
  return rows.find((row) => row.date === date)?.weeklySourceWeekStart;
}

describe("a week completes at its last scheduled session's finalized close", () => {
  // Monday 2026-03-02 .. Friday 2026-03-13: two ordinary weeks.
  const twoWeeks = barsBetween("2026-03-02", "2026-03-13");
  const weekdaysOnly = scheduleClosing([]);

  it("shows Monday through Thursday the previous week, and Friday its own, each evening", async () => {
    for (const evening of [
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ]) {
      const rows = await rowsAt(twoWeeks, evening, weekdaysOnly);
      expect(sourceOn(rows, evening), evening).toBe("2026-03-02");
    }
    const friday = await rowsAt(twoWeeks, "2026-03-13", weekdaysOnly);
    expect(sourceOn(friday, "2026-03-13")).toBe("2026-03-09");
    // The same week's earlier rows still never see it.
    expect(sourceOn(friday, "2026-03-12")).toBe("2026-03-02");
  });

  it("waits for Friday's finalized close: before it the week is invisible, after it Friday reads it", async () => {
    // Friday 2026-03-13 is in daylight time: the close is 20:00 UTC, final at 20:30 UTC.
    const beforeClose = policy.cutoffDate(new Date("2026-03-13T19:00:00.000Z"));
    const beforeFinal = policy.cutoffDate(new Date("2026-03-13T20:15:00.000Z"));
    const afterFinal = policy.cutoffDate(new Date("2026-03-13T20:31:00.000Z"));
    expect([beforeClose, beforeFinal, afterFinal]).toEqual([
      "2026-03-12",
      "2026-03-12",
      "2026-03-13",
    ]);
    const thursday = await rowsAt(twoWeeks, beforeFinal, weekdaysOnly);
    expect(thursday.map((row) => row.weeklySourceWeekStart)).not.toContain(
      "2026-03-09",
    );
    const friday = await rowsAt(twoWeeks, afterFinal, weekdaysOnly);
    expect(sourceOn(friday, "2026-03-13")).toBe("2026-03-09");
  });

  it("gives Friday the same row on Monday morning, before a new session is final, as on Friday evening", async () => {
    // The cutoff is a calendar date: Sunday, a day no session falls on.
    const mondayMorning = policy.cutoffDate(
      new Date("2026-03-16T14:00:00.000Z"),
    );
    expect(mondayMorning).toBe("2026-03-15");
    const fridayEvening = await rowsAt(twoWeeks, "2026-03-13", weekdaysOnly);
    const later = await rowsAt(twoWeeks, mondayMorning, weekdaysOnly);
    expect(later).toEqual(fridayEvening);
  });

  it("follows the close across both daylight-saving changes", async () => {
    // Standard time: 16:00 New York is 21:00 UTC, final at 21:30 UTC.
    expect(policy.cutoffDate(new Date("2026-03-06T21:15:00.000Z"))).toBe(
      "2026-03-05",
    );
    expect(policy.cutoffDate(new Date("2026-03-06T21:31:00.000Z"))).toBe(
      "2026-03-06",
    );
    // The week after the March change (8 March): daylight time, final at 20:30 UTC.
    expect(policy.cutoffDate(new Date("2026-03-13T20:31:00.000Z"))).toBe(
      "2026-03-13",
    );
    // The week of the November change (1 November): standard time again.
    expect(policy.cutoffDate(new Date("2026-11-06T20:45:00.000Z"))).toBe(
      "2026-11-05",
    );
    expect(policy.cutoffDate(new Date("2026-11-06T21:31:00.000Z"))).toBe(
      "2026-11-06",
    );
    const autumn = barsBetween("2026-10-26", "2026-11-06");
    const friday = await rowsAt(autumn, "2026-11-06", weekdaysOnly);
    expect(sourceOn(friday, "2026-11-06")).toBe("2026-11-02");
    expect(sourceOn(friday, "2026-11-05")).toBe("2026-10-26");
  });

  it("ends a Good Friday week at Thursday's finalized close", async () => {
    const goodFriday = "2026-04-03";
    const prices = barsBetween("2026-03-23", "2026-04-07", [goodFriday]);
    const schedule = scheduleClosing([goodFriday]);
    const thursday = await rowsAt(prices, "2026-04-02", schedule);
    expect(sourceOn(thursday, "2026-04-02")).toBe("2026-03-30");
    expect(sourceOn(thursday, "2026-04-01")).toBe("2026-03-23");
    // The rest of the history agrees on Thursday's row whenever it is calculated.
    const later = await rowsAt(prices, "2026-04-07", schedule);
    expect(sourceOn(later, "2026-04-02")).toBe("2026-03-30");
    expect(sourceOn(later, "2026-04-06")).toBe("2026-03-30");
  });

  it("ends a week opened by a Monday holiday on its Friday", async () => {
    const mlk = "2026-01-19";
    const prices = barsBetween("2026-01-12", "2026-01-23", [mlk]);
    const schedule = scheduleClosing([mlk]);
    const thursday = await rowsAt(prices, "2026-01-22", schedule);
    expect(sourceOn(thursday, "2026-01-22")).toBe("2026-01-12");
    const friday = await rowsAt(prices, "2026-01-23", schedule);
    expect(sourceOn(friday, "2026-01-23")).toBe("2026-01-19");
  });

  it("ends Thanksgiving week on its early-close Friday, an ordinary session", async () => {
    const thanksgiving = "2026-11-26";
    const prices = barsBetween("2026-11-16", "2026-11-27", [thanksgiving]);
    const schedule = scheduleClosing([thanksgiving]);
    const wednesday = await rowsAt(prices, "2026-11-25", schedule);
    expect(sourceOn(wednesday, "2026-11-25")).toBe("2026-11-16");
    const friday = await rowsAt(prices, "2026-11-27", schedule);
    expect(sourceOn(friday, "2026-11-27")).toBe("2026-11-23");
  });

  it("does not take a missing last-session bar for the end of the week (a halt)", async () => {
    // Friday 2026-05-15 was scheduled, and the security printed nothing.
    const halted = "2026-05-15";
    const prices = barsBetween("2026-05-04", "2026-05-18", [halted]);
    const schedule = scheduleClosing([]);
    const friday = await rowsAt(prices, halted, schedule);
    // Thursday never learns the week is over: that was not knowable at its close.
    expect(sourceOn(friday, "2026-05-14")).toBe("2026-05-04");
    const monday = await rowsAt(prices, "2026-05-18", schedule);
    expect(sourceOn(monday, "2026-05-14")).toBe("2026-05-04");
    // The next printed session reads the week the halt ended.
    expect(sourceOn(monday, "2026-05-18")).toBe("2026-05-11");
    const halfWeek = aggregateCompletedWeeks(
      prices,
      "2026-05-18",
      undefined,
      await resolveWeekSessionEnds({
        dates: prices.map((price) => price.date),
        isScheduledSession: schedule,
      }),
    ).find((week) => week.weekStartDate === "2026-05-11");
    expect(halfWeek).toMatchObject({
      weekEndDate: "2026-05-14",
      eligibleDate: "2026-05-15",
    });
  });

  it("publishes a late Friday bar's week on Friday's own row, leaving Thursday as it was", async () => {
    const prices = barsBetween("2026-06-01", "2026-06-12");
    const schedule = scheduleClosing([]);
    const late = prices.filter((price) => price.date !== "2026-06-12");
    // Friday evening, the provider has not published Friday: no row reads the week.
    const evening = await rowsAt(late, "2026-06-12", schedule);
    expect(evening.map((row) => row.date)).not.toContain("2026-06-12");
    expect(sourceOn(evening, "2026-06-11")).toBe("2026-06-01");
    // Published on Saturday: Friday's row reads the completed week, Thursday's is unchanged.
    const published = await rowsAt(prices, "2026-06-12", schedule);
    expect(sourceOn(published, "2026-06-12")).toBe("2026-06-08");
    expect(published.find((row) => row.date === "2026-06-11")).toEqual(
      evening.find((row) => row.date === "2026-06-11"),
    );
  });

  it("delays a week, never reveals it early, when the schedule cannot answer", async () => {
    const goodFriday = "2026-04-03";
    const prices = barsBetween("2026-03-23", "2026-04-07", [goodFriday]);
    const unknown = await rowsAt(prices, "2026-04-07", unanswerable);
    expect(sourceOn(unknown, "2026-04-02")).toBe("2026-03-23");
    expect(sourceOn(unknown, "2026-04-06")).toBe("2026-03-30");
  });
});

/** A deterministic value in [0, 1): a fixture's own noise, never `Math.random`. */
function noise(seed: number, index: number): number {
  const value = Math.sin(seed * 7919 + index * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * A generated history: weekdays from `from` for `weeks` weeks, about one in twenty-five weekdays a
 * venue holiday and one in forty a day the security did not print, with a random walk of closes.
 */
function generatedHistory(
  seed: number,
  from: LocalDate,
  weeks: number,
): { prices: DailyPrice[]; holidays: LocalDate[] } {
  const prices: DailyPrice[] = [];
  const holidays: LocalDate[] = [];
  let close = 100;
  for (let day = 0; day < weeks * 7; day += 1) {
    const date = addDays(from, day);
    if (weekday(date) === 0 || weekday(date) === 6) {
      continue;
    }
    const draw = noise(seed, day);
    if (draw < 0.04) {
      holidays.push(date);
      continue;
    }
    close = Math.max(1, close * (1 + (noise(seed + 1, day) - 0.5) * 0.04));
    if (draw > 0.975) {
      continue; // a halt: a scheduled session the security did not print
    }
    prices.push(bar(date, Math.round(close * 100) / 100));
  }
  return { prices, holidays };
}

describe("a session's row is a function of the stored bars and the schedule, never of the evening", () => {
  it("never changes a row once it exists, and never shows a week before its last session, on 40 generated histories", async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const { prices, holidays } = generatedHistory(seed, "2025-01-06", 26);
      const schedule = scheduleClosing(holidays);
      const holidaySet = new Set(holidays);
      const last = prices[prices.length - 1]!.date;
      const final = new Map(
        (await rowsAt(prices, last, schedule)).map((row) => [row.date, row]),
      );
      // Every evening the loader could have materialized on.
      for (
        let evening = prices[0]!.date;
        evening <= last;
        evening = addDays(evening, 1)
      ) {
        const rows = await rowsAt(prices, evening, schedule);
        for (const row of rows) {
          expect(row, `seed ${seed}, ${row.date} on ${evening}`).toEqual(
            final.get(row.date),
          );
        }
      }
      // No look-ahead: a row only reads a week whose last scheduled session is on or before it.
      for (const row of final.values()) {
        const week = row.weeklySourceWeekStart;
        if (week === undefined) {
          continue;
        }
        let lastSession = fridayOfIsoWeek(week);
        while (holidaySet.has(lastSession)) {
          lastSession = addDays(lastSession, -1);
        }
        expect(lastSession <= row.date, `seed ${seed}, ${row.date}`).toBe(true);
        // And it is the newest such week the security printed in.
        expect(startOfIsoWeek(row.date) >= week).toBe(true);
      }
    }
  });

  it("only ever delays a week when the schedule cannot answer, on the same histories", async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const { prices, holidays } = generatedHistory(seed, "2025-01-06", 26);
      const last = prices[prices.length - 1]!.date;
      const known = await rowsAt(prices, last, scheduleClosing(holidays));
      const unknown = await rowsAt(prices, last, unanswerable);
      unknown.forEach((row, index) => {
        const knownWeek = known[index]!.weeklySourceWeekStart;
        if (row.weeklySourceWeekStart !== undefined) {
          expect(knownWeek).toBeDefined();
          expect(row.weeklySourceWeekStart <= knownWeek!).toBe(true);
        }
      });
    }
  });
});

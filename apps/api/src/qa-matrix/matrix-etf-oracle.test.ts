import {
  BENCHMARK_TECHNICAL_FIELDS,
  benchmarkTechnicalValueOn,
  buildBenchmarkTechnicalContext,
  resolveWeekSessionEnds,
  type BenchmarkTechnicalSnapshot,
} from "@intrinsic/stock-data";
import { describe, expect, it } from "vitest";
import {
  AMBIGUITY,
  buildOracleColumns,
  isoWeekStart,
  oracleConditionTruth,
  weekVisibleFrom,
  type OracleBar,
  type OracleVenueSchedule,
} from "./matrix-etf-oracle";

/**
 * The matrix's independent ETF oracle, held to the production ETF technical context.
 *
 * Two implementations written apart must agree on every value — that agreement is what lets the
 * oracle refuse a trade in a sweep. Random histories with reproducible seeds carry the cases a
 * hand-written fixture forgets: holiday-shortened weeks, a halted Friday, a mid-week listing,
 * zero-volume sessions and a year the venue schedule cannot answer.
 */

/** Deterministic pseudorandom source (seeded LCG), so a failing seed is a reproduction. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const DAY = 86_400_000;
const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
const weekdayOf = (date: string): number =>
  new Date(`${date}T00:00:00.000Z`).getUTCDay();

type History = {
  readonly bars: OracleBar[];
  /** Full closures by year, or `null` for an unanswerable year. */
  readonly closures: Map<string, Set<string> | null>;
};

/**
 * A random daily history from a mid-week listing: venue holidays (some on Fridays, so weeks end on
 * Thursday), a few halted sessions the venue held (the fund printed no bar), occasional zero
 * volume, and one year the schedule cannot answer.
 */
function randomHistory(seed: number, sessions = 1_400): History {
  const random = seeded(seed);
  const closures = new Map<string, Set<string> | null>();
  const bars: OracleBar[] = [];
  let date = "2009-03-04"; // a Wednesday
  let close = 50 + random() * 50;
  const unanswerable = String(2010 + Math.floor(random() * 4));
  while (bars.length < sessions) {
    const weekday = weekdayOf(date);
    const year = date.slice(0, 4);
    if (!closures.has(year)) {
      closures.set(year, year === unanswerable ? null : new Set<string>());
    }
    if (weekday !== 0 && weekday !== 6) {
      const holiday = random() < 0.04;
      if (holiday) {
        closures.get(year)?.add(date);
      } else if (random() < 0.02) {
        // Halted: the venue was open, the fund printed nothing.
      } else {
        close = Math.max(1, close * (1 + (random() - 0.5) * 0.06));
        const volume = random() < 0.015 ? 0 : Math.round(1e5 + random() * 9e6);
        bars.push({
          date,
          open: close,
          high: close * 1.01,
          low: close * 0.99,
          close,
          volume,
        });
      }
    }
    date = addDays(date, 1);
  }
  return { bars, closures };
}

const scheduleOf =
  (closures: Map<string, Set<string> | null>): OracleVenueSchedule =>
  (year) =>
    closures.get(year) ?? null;

/** The production context over the same bars, with the venue schedule answered the same way. */
async function productionSnapshot(
  history: History,
): Promise<BenchmarkTechnicalSnapshot> {
  const last = history.bars.at(-1)!.date;
  const sessionEnds = await resolveWeekSessionEnds({
    dates: history.bars.map((bar) => bar.date),
    isScheduledSession: async (day) => {
      const closures = history.closures.get(day.slice(0, 4));
      if (closures === null || closures === undefined) {
        return undefined;
      }
      return weekdayOf(day) !== 0 && weekdayOf(day) !== 6 && !closures.has(day);
    },
  });
  const context = buildBenchmarkTechnicalContext({
    seriesId: "series-oracle",
    history: {
      seriesId: "series-oracle",
      basisGeneration: 0,
      rows: history.bars.map((bar) => ({ seriesId: "series-oracle", ...bar })),
      missing: [],
      source: "POSTGRESQL",
    },
    refreshState: {
      coverageEnd: last,
      latestBar: last,
      lastTailSyncAt: `${addDays(last, 2)}T00:00:00.000Z`,
    },
    missingFromFloor: [],
    now: new Date(`${addDays(last, 3)}T00:00:00.000Z`),
    publicationDelayMs: 30 * 60_000,
    sessionEnds,
  });
  if (context.status !== "READY") {
    throw new Error(`the production context is ${context.status}`);
  }
  return context.snapshot;
}

/** Catalog field name → oracle column key. */
function oracleKeyOf(field: string): string {
  const daily = /^(sma|ema)(\d+)d$/.exec(field);
  if (daily) {
    return `${daily[1]!.toUpperCase()}_${daily[2]}D`;
  }
  const weekly = /^(sma|ema)(\d+)w$/.exec(field);
  if (weekly) {
    return `${weekly[1]!.toUpperCase()}_${weekly[2]}W`;
  }
  const rsi = /^rsi(\d+)d$/.exec(field);
  if (rsi) {
    return `RSI_${rsi[1]}D`;
  }
  const rvol =
    /^rvol(\d+)d?$/.exec(field) ?? /^relativeVolume(\d+)$/.exec(field);
  if (rvol) {
    return `RVOL_${rvol[1]}`;
  }
  throw new Error(`no oracle key for production field \`${field}\``);
}

describe("the independent ETF oracle", () => {
  it("knows every technical field the production context computes", () => {
    for (const field of BENCHMARK_TECHNICAL_FIELDS) {
      const columns = buildOracleColumns(
        randomHistory(1, 300).bars,
        () => new Set(),
      );
      expect(() => columns.column(oracleKeyOf(field)), field).not.toThrow();
    }
    expect(BENCHMARK_TECHNICAL_FIELDS).toHaveLength(20);
  });

  it("agrees with the production context on every field, session and NaN, across 12 random histories", async () => {
    let compared = 0;
    for (let seed = 1; seed <= 12; seed += 1) {
      const history = randomHistory(seed);
      const production = await productionSnapshot(history);
      const oracle = buildOracleColumns(
        history.bars,
        scheduleOf(history.closures),
      );
      expect(production.dates, `seed ${seed}: sessions`).toEqual(oracle.dates);
      for (const date of oracle.dates) {
        const position = oracle.index.get(date)!;
        expect(benchmarkTechnicalValueOn(production, date, "close")).toBe(
          oracle.close[position],
        );
        for (const field of BENCHMARK_TECHNICAL_FIELDS) {
          const expected = oracle.column(oracleKeyOf(field))[position]!;
          const actual = benchmarkTechnicalValueOn(production, date, field);
          if (Number.isNaN(expected) || Number.isNaN(actual)) {
            expect(
              Number.isNaN(actual),
              `seed ${seed} ${field} ${date}: oracle ${expected}, production ${actual}`,
            ).toBe(Number.isNaN(expected));
            continue;
          }
          const scale = Math.max(Math.abs(expected), 1);
          expect(
            Math.abs(actual - expected) <= AMBIGUITY * scale,
            `seed ${seed} ${field} ${date}: oracle ${expected}, production ${actual}`,
          ).toBe(true);
          compared += 1;
        }
      }
    }
    // Twelve histories of 1,400 sessions and twenty fields, warm-up excluded.
    expect(compared).toBeGreaterThan(200_000);
  });

  it("reads nothing on a session the fund printed no bar for: no carry-forward", () => {
    const history = randomHistory(7, 400);
    const oracle = buildOracleColumns(
      history.bars,
      scheduleOf(history.closures),
    );
    const printed = new Set(history.bars.map((bar) => bar.date));
    let gap = history.bars[300]!.date;
    while (printed.has(gap) || weekdayOf(gap) === 0 || weekdayOf(gap) === 6) {
      gap = addDays(gap, 1);
    }
    expect(
      oracleConditionTruth(oracle, gap, { kind: "CLOSE" }, "IS_ABOVE", {
        kind: "CONSTANT",
        value: 0,
      }),
    ).toBe("NOT_EVALUABLE");
  });

  it("is NOT_EVALUABLE before a series has warmed up, and decides after", () => {
    const history = randomHistory(3, 400);
    const oracle = buildOracleColumns(
      history.bars,
      scheduleOf(history.closures),
    );
    const sma200 = { kind: "COLUMN", field: "SMA_200D" } as const;
    expect(
      oracleConditionTruth(
        oracle,
        history.bars[198]!.date,
        { kind: "CLOSE" },
        "IS_ABOVE",
        sma200,
      ),
    ).toBe("NOT_EVALUABLE");
    expect(["TRUE", "FALSE"]).toContain(
      oracleConditionTruth(
        oracle,
        history.bars[199]!.date,
        { kind: "CLOSE" },
        "IS_ABOVE",
        sma200,
      ),
    );
  });

  it("reports a comparison inside floating-point ambiguity as ambiguous, never as a verdict", () => {
    const bars: OracleBar[] = [
      { date: "2026-01-05", open: 10, high: 10, low: 10, close: 10, volume: 1 },
    ];
    const oracle = buildOracleColumns(bars, () => new Set());
    const value = (v: number) => ({ kind: "CONSTANT", value: v }) as const;
    expect(
      oracleConditionTruth(
        oracle,
        "2026-01-05",
        { kind: "CLOSE" },
        "IS_ABOVE",
        value(10),
      ),
    ).toBe("AMBIGUOUS");
    expect(
      oracleConditionTruth(
        oracle,
        "2026-01-05",
        { kind: "CLOSE" },
        "IS_ABOVE",
        value(9.99),
      ),
    ).toBe("TRUE");
    expect(
      oracleConditionTruth(
        oracle,
        "2026-01-05",
        { kind: "CLOSE" },
        "IS_CLOSE_TO",
        value(10 / 1.02),
      ),
    ).toBe("AMBIGUOUS");
    expect(
      oracleConditionTruth(
        oracle,
        "2026-01-05",
        { kind: "CLOSE" },
        "IS_CLOSE_TO",
        value(0),
      ),
    ).toBe("NOT_EVALUABLE");
  });
});

describe("the week-completion rule, stated independently", () => {
  const none: OracleVenueSchedule = () => new Set();
  it("ends an ordinary week on its Friday bar", () => {
    expect(
      weekVisibleFrom(isoWeekStart("2026-04-10"), "2026-04-10", none),
    ).toBe("2026-04-10");
  });
  it("ends a Good Friday week on Thursday", () => {
    const goodFriday: OracleVenueSchedule = () => new Set(["2026-04-03"]);
    expect(
      weekVisibleFrom(isoWeekStart("2026-04-02"), "2026-04-02", goodFriday),
    ).toBe("2026-04-02");
  });
  it("keeps a week whose Friday the venue held but the fund did not print open until that Friday", () => {
    expect(
      weekVisibleFrom(isoWeekStart("2026-04-09"), "2026-04-09", none),
    ).toBe("2026-04-10");
  });
  it("takes the Friday for a year the schedule cannot answer, which can only delay a week", () => {
    expect(
      weekVisibleFrom(isoWeekStart("2026-04-02"), "2026-04-02", () => null),
    ).toBe("2026-04-03");
  });
  it("ends 2001's September 11 week on Monday when the schedule lists the closures", () => {
    const closed: OracleVenueSchedule = () =>
      new Set(["2001-09-11", "2001-09-12", "2001-09-13", "2001-09-14"]);
    // The documented behaviour (and the finding FIN-07 records): a closure decided after the fact
    // marks the week complete at Monday's close.
    expect(
      weekVisibleFrom(isoWeekStart("2001-09-10"), "2001-09-10", closed),
    ).toBe("2001-09-10");
  });
});

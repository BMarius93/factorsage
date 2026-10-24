import type { LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import type { DividendRow } from "../dividends.js";
import { addCalendarDays } from "./engine.js";
import {
  baseMetricsFor,
  metricOn,
  nominalClose,
  sessionCalendar,
  type SecuritySeries,
} from "./metrics.js";

const d = (value: string) => value as LocalDate;

function weekdays(from: string, count: number): LocalDate[] {
  const sessions: LocalDate[] = [];
  for (
    let day = d(from);
    sessions.length < count;
    day = addCalendarDays(day, 1)
  ) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) sessions.push(day);
  }
  return sessions;
}

const SESSIONS = weekdays("2020-01-01", 400);
const CALENDAR = sessionCalendar(SESSIONS);
const LAST = SESSIONS[SESSIONS.length - 1] as LocalDate;

function series(
  closes: (index: number) => number,
  overrides: Partial<SecuritySeries> & { sessions?: readonly LocalDate[] } = {},
): SecuritySeries {
  const dates = overrides.sessions ?? SESSIONS;
  return {
    securityId: "s",
    dates,
    closes: Float64Array.from(dates, (_date, index) => closes(index)),
    volumes: Float64Array.from(dates, () => 1_000),
    ...overrides,
  };
}

describe("historical universe metrics: price metrics", () => {
  it("reads 12-1 momentum from the closes 252 and 21 sessions back", () => {
    const value = metricOn(
      "MOMENTUM_12_1",
      series((index) => 100 + index),
      CALENDAR,
      LAST,
    );
    const at = SESSIONS.length - 1;
    expect(value).toEqual({ value: (100 + at - 21) / (100 + at - 252) - 1 });
  });

  it("is unavailable without a close on the date, never read from an earlier day", () => {
    const missing = SESSIONS.filter((session) => session !== LAST);
    expect(
      metricOn(
        "MOMENTUM_12_1",
        series(() => 10, { sessions: missing }),
        CALENDAR,
        LAST,
      ),
    ).toEqual({ value: null, reason: "NO_PRICE_ON_DATE" });
  });

  it("is unavailable when the history does not reach back a year", () => {
    const recent = SESSIONS.slice(-200);
    expect(
      metricOn(
        "MOMENTUM_12_1",
        series(() => 10, { sessions: recent }),
        CALENDAR,
        LAST,
      ),
    ).toEqual({
      value: null,
      reason: "INSUFFICIENT_HISTORY",
    });
    expect(
      metricOn(
        "RETURN_6M",
        series(() => 10, { sessions: recent }),
        CALENDAR,
        LAST,
      ),
    ).toEqual({
      value: 0,
    });
  });

  it("tolerates a lagged session missing for up to five sessions, and no more", () => {
    const at = SESSIONS.length - 1;
    const lagged = at - 252;
    const gap = (width: number) =>
      SESSIONS.filter(
        (_session, index) => index > lagged || index <= lagged - width,
      );
    expect(
      metricOn(
        "RETURN_12M",
        series(() => 10, { sessions: gap(5) }),
        CALENDAR,
        LAST,
      ).value,
    ).toBe(0);
    expect(
      metricOn(
        "RETURN_12M",
        series(() => 10, { sessions: gap(6) }),
        CALENDAR,
        LAST,
      ),
    ).toEqual({
      value: null,
      reason: "INSUFFICIENT_HISTORY",
    });
  });

  it("annualizes 252-session volatility and needs 240 returns", () => {
    const alternating = series((index) => (index % 2 === 0 ? 100 : 101));
    const value = metricOn("VOLATILITY_252D", alternating, CALENDAR, LAST)
      .value as number;
    const step = Math.log(101 / 100);
    // 252 returns alternating ±step: mean ≈ 0, sample deviation ≈ step.
    expect(value).toBeCloseTo(step * Math.sqrt(252) * Math.sqrt(252 / 251), 6);
    const short = series(() => 10, { sessions: SESSIONS.slice(-230) });
    expect(metricOn("VOLATILITY_252D", short, CALENDAR, LAST)).toEqual({
      value: null,
      reason: "INSUFFICIENT_HISTORY",
    });
  });

  it("averages 63 sessions of dollar volume and needs 50 bars", () => {
    const value = metricOn(
      "DOLLAR_VOLUME_63D",
      series(() => 20),
      CALENDAR,
      LAST,
    );
    expect(value).toEqual({ value: 20_000 });
    const sparse = SESSIONS.filter(
      (_session, index) => index < SESSIONS.length - 63 || index % 2 === 0,
    );
    expect(
      metricOn(
        "DOLLAR_VOLUME_63D",
        series(() => 20, {
          sessions: [...sparse, LAST].filter((v, i, a) => a.indexOf(v) === i),
        }),
        CALENDAR,
        LAST,
      ),
    ).toEqual({ value: null, reason: "INSUFFICIENT_HISTORY" });
  });

  it("undoes later splits for the nominal price, never earlier ones", () => {
    const split = (date: string, numerator: number) => ({
      securityId: "s",
      date: d(date),
      numerator,
      denominator: 1,
      label: "stock-split",
    });
    const priced = series(() => 25, {
      splits: [split("2019-06-01", 2), split("2021-01-04", 4)],
    });
    const before = SESSIONS.indexOf(d("2020-12-31"));
    const after = SESSIONS.indexOf(d("2021-01-04"));
    expect(nominalClose(priced, before)).toBe(100);
    expect(nominalClose(priced, after)).toBe(25);
    expect(
      metricOn("NOMINAL_PRICE", priced, CALENDAR, d("2020-12-31")),
    ).toEqual({ value: 100 });
  });
});

describe("historical universe metrics: stored columns", () => {
  it("reads market capitalization and inverts positive valuation ratios only", () => {
    const at = SESSIONS.length - 1;
    const column = (value: number) =>
      Float64Array.from(SESSIONS, (_session, index) =>
        index === at ? value : Number.NaN,
      );
    const stored = series(() => 10, {
      marketCaps: column(5e9),
      ratios: { priceToEarnings: column(20), priceToBook: column(-3) },
    });
    expect(metricOn("MARKET_CAP", stored, CALENDAR, LAST)).toEqual({
      value: 5e9,
    });
    expect(metricOn("EARNINGS_YIELD_TTM", stored, CALENDAR, LAST)).toEqual({
      value: 0.05,
    });
    expect(metricOn("BOOK_TO_PRICE", stored, CALENDAR, LAST)).toEqual({
      value: null,
      reason: "NO_RATIO",
    });
    expect(
      metricOn("MARKET_CAP", stored, CALENDAR, SESSIONS[at - 1] as LocalDate),
    ).toEqual({
      value: null,
      reason: "NO_MARKET_CAP",
    });
  });

  it("reads the derived state's point-in-time fundamentals on the date", () => {
    const stored = series(() => 10, {
      fundamentals: new Map([
        [LAST, { roicTtm: 0.18, revenueGrowthTtmYoy: null }],
      ]),
    });
    expect(metricOn("ROIC_TTM", stored, CALENDAR, LAST)).toEqual({
      value: 0.18,
    });
    expect(metricOn("REVENUE_GROWTH_TTM_YOY", stored, CALENDAR, LAST)).toEqual({
      value: null,
      reason: "NO_FUNDAMENTAL",
    });
  });

  it("distinguishes dividends never ingested from a security that pays none", () => {
    const dividend = (exDate: string, amount: number): DividendRow => ({
      exDate: d(exDate),
      recordDate: null,
      paymentDate: null,
      declarationDate: null,
      amount,
      adjustedAmount: amount,
      frequency: "Quarterly",
    });
    expect(
      metricOn(
        "INDICATED_DIVIDEND_YIELD",
        series(() => 40),
        CALENDAR,
        LAST,
      ),
    ).toEqual({
      value: null,
      reason: "DIVIDENDS_NOT_INGESTED",
    });
    expect(
      metricOn(
        "INDICATED_DIVIDEND_YIELD",
        series(() => 40, { dividends: [] }),
        CALENDAR,
        LAST,
      ),
    ).toEqual({ value: null, reason: "NO_REGULAR_DIVIDEND" });
    expect(
      metricOn(
        "INDICATED_DIVIDEND_YIELD",
        series(() => 40, { dividends: [dividend("2021-05-03", 0.5)] }),
        CALENDAR,
        LAST,
      ),
    ).toEqual({ value: 0.05 });
  });

  it("always computes market capitalization for the tie-break, and a composite's components", () => {
    expect([...baseMetricsFor(["GROWTH_SCORE"])].sort()).toEqual([
      "EPS_GROWTH_TTM_YOY",
      "MARKET_CAP",
      "RETURN_12M",
      "REVENUE_GROWTH_TTM_YOY",
    ]);
  });
});

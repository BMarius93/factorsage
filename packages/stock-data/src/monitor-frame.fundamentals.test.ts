import type { StrategyCondition } from "@intrinsic/contracts";
import type {
  DailyDerivedState,
  DailyPrice,
  Security,
} from "@intrinsic/domain";
import {
  Evaluability,
  evaluateMarketCondition,
  fundamentalMetricOperand,
  PRICE_OPERAND,
  readOperand,
  seriesOperand,
  type EvaluationFrame,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import { projectEvaluationFrame } from "./evaluation-frame.js";
import {
  monitorWindowObservations,
  projectMonitorEvaluationFrame,
  requiredDailySeries,
} from "./monitor-frame.js";

/**
 * Backtest / Monitor parity for Fundamental Metrics.
 *
 * A Monitor has no Fundamentals evaluator of its own: its frame is produced by the same canonical
 * `projectEvaluationFrame`, from the same persisted `DailyDerivedState` rows, and the Condition is
 * decided by the same evaluator. The one framing difference is the Monitor's by design — its last
 * row is a provisional observation for a session that has not closed, which carries the newest
 * completed session's derived state forward exactly as it carries intrinsic values: a statement
 * becomes eligible on the canonical axis only when the materializer applies it, so no fundamental
 * value is ever invented or recalculated for a provisional row.
 */

const SECURITY: Security = {
  id: "sec-fundamentals",
  symbol: "FUND",
  name: "Fundamentals Corp",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

const ROIC = fundamentalMetricOperand("ROIC_TTM");
const DEBT_TO_EQUITY = fundamentalMetricOperand("DEBT_TO_EQUITY");

const ROIC_ABOVE_15: StrategyCondition = {
  id: "roic-above-15",
  metric: { kind: "FUNDAMENTAL", metricId: "ROIC_TTM" },
  operator: "IS_ABOVE",
  value: { kind: "PERCENT", value: 15 },
};

/** Weekday sessions from Monday 2026-01-05, the canonical axis both projections read. */
function weekdays(count: number, from = "2026-01-05"): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  while (dates.length < count) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function price(date: string, close: number): DailyPrice {
  return {
    securityId: SECURITY.id,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

/**
 * Six closed sessions: ROIC unavailable, then 12, then 18 from the fourth session — a statement
 * event — and Debt / Equity 1.2 until the fifth, then 0.8.
 */
const CLOSED_DATES = weekdays(6);
const ROIC_READINGS = [undefined, 12, 12, 18, 18, 18] as const;
const DEBT_TO_EQUITY_READINGS = [undefined, 1.2, 1.2, 1.2, 0.8, 0.8] as const;
const PRICES = CLOSED_DATES.map((date, index) => price(date, 100 + index));
const DERIVED: DailyDerivedState[] = CLOSED_DATES.map((date, index) => ({
  securityId: SECURITY.id,
  date,
  ...(ROIC_READINGS[index] === undefined
    ? {}
    : { roicTtm: ROIC_READINGS[index] }),
  ...(DEBT_TO_EQUITY_READINGS[index] === undefined
    ? {}
    : { debtToEquity: DEBT_TO_EQUITY_READINGS[index] }),
}));
const OPERANDS = [DEBT_TO_EQUITY, PRICE_OPERAND, ROIC];
/** The session after the last closed one: where a provisional observation lives. */
const NEXT_SESSION = weekdays(7)[6]!;

function backtestFrame(): EvaluationFrame {
  return projectEvaluationFrame({
    security: SECURITY,
    prices: PRICES,
    derived: DERIVED,
    operands: OPERANDS,
    periodStart: CLOSED_DATES[0]!,
  }).frame;
}

function monitorFrame(observationDate: string, observationPrice = 110) {
  const projected = projectMonitorEvaluationFrame({
    security: SECURITY,
    prices: PRICES,
    derived: DERIVED,
    operands: OPERANDS,
    observation: { price: observationPrice },
    observationDate,
  });
  if (!projected) {
    throw new Error("the fixture always has a usable observation");
  }
  return projected;
}

function indexOf(frame: EvaluationFrame, date: string): number {
  const index = frame.dates.indexOf(date);
  if (index < 0) {
    throw new Error(`${date} is not on the frame`);
  }
  return index;
}

describe("Fundamental Metrics in a Monitor frame", () => {
  it("read the same persisted value as the backtest on every closed session", () => {
    const backtest = backtestFrame();
    const { frame: monitor } = monitorFrame(NEXT_SESSION);
    for (const date of CLOSED_DATES) {
      for (const key of [ROIC, DEBT_TO_EQUITY]) {
        const inBacktest = readOperand(backtest, key, indexOf(backtest, date));
        const inMonitor = readOperand(monitor, key, indexOf(monitor, date));
        expect(Object.is(inMonitor, inBacktest), `${key} ${date}`).toBe(true);
      }
    }
  });

  it("carry the newest completed session's value onto the provisional observation", () => {
    const { frame, observationIndex, observationDate } =
      monitorFrame(NEXT_SESSION);
    expect(observationDate).toBe(NEXT_SESSION);
    expect(readOperand(frame, ROIC, observationIndex)).toBe(18);
    expect(readOperand(frame, DEBT_TO_EQUITY, observationIndex)).toBe(0.8);
    // Only the live price is new on the provisional row.
    expect(readOperand(frame, PRICE_OPERAND, observationIndex)).toBe(110);
  });

  it("read a repriced closed session's own persisted value", () => {
    // The provider repriced the newest persisted session: the observation supersedes that row.
    const newest = CLOSED_DATES[CLOSED_DATES.length - 1]!;
    const { frame, observationIndex, observationDate } = monitorFrame(newest);
    expect(observationDate).toBe(newest);
    expect(readOperand(frame, ROIC, observationIndex)).toBe(18);
    expect(frame.dates).toEqual(CLOSED_DATES);
  });

  it("decide a Fundamental Condition exactly as the backtest does, on the same session", () => {
    const backtest = backtestFrame();
    // The Monitor as it stood on each closed session in turn: the history persisted through that
    // session, with the provider repricing it as the observation. Every session of the event
    // history is then decided on both sides.
    const pairs = CLOSED_DATES.map((date, index) => {
      const projected = projectMonitorEvaluationFrame({
        security: SECURITY,
        prices: PRICES.slice(0, index + 1),
        derived: DERIVED.slice(0, index + 1),
        operands: OPERANDS,
        observation: { price: 100 + index },
        observationDate: date,
      });
      if (!projected) {
        throw new Error(`no observation on ${date}`);
      }
      return [
        evaluateMarketCondition(
          ROIC_ABOVE_15,
          projected.frame,
          projected.observationIndex,
        ),
        evaluateMarketCondition(
          ROIC_ABOVE_15,
          backtest,
          indexOf(backtest, date),
        ),
      ];
    });
    expect(pairs.map(([monitor]) => monitor)).toEqual(
      pairs.map(([, backtestResult]) => backtestResult),
    );
    // Unavailable, 12, 12, then the statement event: 18 from the fourth session on both sides.
    expect(pairs.map(([monitor]) => monitor)).toEqual([
      Evaluability.NOT_EVALUABLE,
      Evaluability.FALSE,
      Evaluability.FALSE,
      Evaluability.TRUE,
      Evaluability.TRUE,
      Evaluability.TRUE,
    ]);
  });

  it("lag a statement event by the one session it takes to materialize, then agree", () => {
    // The canonical history: ROIC 12 through the third session, 18 from the fourth, the first
    // session on or after the new statement's availability.
    const dates = weekdays(6);
    const eventDay = dates[3]!;
    const canonical: DailyDerivedState[] = dates.map((date, index) => ({
      securityId: SECURITY.id,
      date,
      roicTtm: index < 3 ? 12 : 18,
    }));
    const prices = dates.map((date, index) => price(date, 100 + index));
    const backtest = projectEvaluationFrame({
      security: SECURITY,
      prices,
      derived: canonical,
      operands: OPERANDS,
      periodStart: dates[0]!,
    }).frame;
    const monitorOn = (observationDate: string, closedThrough: number) =>
      projectMonitorEvaluationFrame({
        security: SECURITY,
        prices: prices.slice(0, closedThrough + 1),
        derived: canonical.slice(0, closedThrough + 1),
        operands: OPERANDS,
        observation: { price: 110 },
        observationDate,
      })!;
    const decide = (frame: EvaluationFrame, index: number) =>
      evaluateMarketCondition(ROIC_ABOVE_15, frame, index);

    // Intraday on the event's first session: that session has not closed, so nothing has
    // materialized it, and the provisional row carries the previous completed session's 12.
    const intraday = monitorOn(eventDay, 2);
    expect(intraday.observationDate).toBe(eventDay);
    expect(readOperand(intraday.frame, ROIC, intraday.observationIndex)).toBe(
      12,
    );
    expect(decide(intraday.frame, intraday.observationIndex)).toBe(
      Evaluability.FALSE,
    );
    // The backtest's row for that session already carries the new statement.
    expect(decide(backtest, indexOf(backtest, eventDay))).toBe(
      Evaluability.TRUE,
    );

    // Once the session closes and is materialized, the Monitor agrees: re-observing it, and on the
    // next session's provisional observation.
    const afterClose = monitorOn(eventDay, 3);
    expect(decide(afterClose.frame, afterClose.observationIndex)).toBe(
      Evaluability.TRUE,
    );
    const nextSession = monitorOn(dates[4]!, 3);
    expect(
      readOperand(nextSession.frame, ROIC, nextSession.observationIndex),
    ).toBe(18);
    expect(decide(nextSession.frame, nextSession.observationIndex)).toBe(
      decide(backtest, indexOf(backtest, dates[4]!)),
    );
  });

  it("keep an unavailable metric unavailable on the provisional observation", () => {
    const { frame, observationIndex } = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices: PRICES.slice(0, 1),
      derived: DERIVED.slice(0, 1),
      operands: OPERANDS,
      observation: { price: 101 },
      observationDate: CLOSED_DATES[1]!,
    })!;
    expect(readOperand(frame, ROIC, observationIndex)).toBeNaN();
    expect(
      evaluateMarketCondition(ROIC_ABOVE_15, frame, observationIndex),
    ).toBe(Evaluability.NOT_EVALUABLE);
  });

  it("neither widen the Monitor's window nor join the daily series it recomputes", () => {
    const required = requiredDailySeries([ROIC, DEBT_TO_EQUITY]);
    expect(required).toEqual({
      movingAverages: [],
      oscillators: [],
      relativeVolumes: [],
    });
    // The same window a strategy naming no daily series at all asks for: the previous row only.
    expect(monitorWindowObservations(required)).toBe(
      monitorWindowObservations(requiredDailySeries([])),
    );
  });

  it("survive the recomputation of a daily family beside them untouched", () => {
    // SMA 20D is recomputed over the window for every row; the fundamental fields ride along.
    const dates = weekdays(25);
    const prices = dates.map((date, index) => price(date, 100 + index));
    const derived: DailyDerivedState[] = dates.map((date, index) => ({
      securityId: SECURITY.id,
      date,
      roicTtm: index < 22 ? 12 : 18,
      // A stale persisted SMA the Monitor must not keep beside its recomputed one.
      sma20d: 1,
    }));
    const projected = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived,
      operands: [PRICE_OPERAND, ROIC, seriesOperand("SMA_20D")],
      observation: { price: 130 },
      observationDate: weekdays(26)[25]!,
    })!;
    const { frame, observationIndex } = projected;
    expect(readOperand(frame, ROIC, observationIndex)).toBe(18);
    expect(readOperand(frame, ROIC, 0)).toBe(12);
    expect(
      readOperand(frame, seriesOperand("SMA_20D"), observationIndex),
    ).not.toBe(1);
  });
});

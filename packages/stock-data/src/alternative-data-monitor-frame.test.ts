import type { AlternativeDataMetric } from "@intrinsic/contracts";
import type { DailyPrice, Security } from "@intrinsic/domain";
import {
  alternativeDataOperand,
  readOperand,
  requiredAlternativeDataLeadingSessions,
  type AlternativeDataFacts,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import { projectEvaluationFrame } from "./evaluation-frame.js";
import {
  monitorWindowObservations,
  projectMonitorEvaluationFrame,
  requiredDailySeries,
} from "./monitor-frame.js";

/**
 * Monitor compatibility for the alternative-data metrics.
 *
 * `docs/alternative-data-signals.md` requires **one** definition of each signal for a historical
 * backtest and a live Monitor — "avoid separate historical and live definitions of the same signal".
 * This is what makes that checkable: the same facts and the same configured metric must produce the
 * same reading whether the last row of the frame is a closed session or the provisional observation a
 * Monitor evaluates.
 *
 * Everything here is pure. The Monitor's *loading* is covered by the ingestion suite; what is proved
 * here is that the two frames agree.
 */

const SECURITY: Security = {
  id: "sec-1",
  symbol: "TEST",
  name: "Test Security",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

/** Consecutive weekdays from a Monday, so the axis is a real trading calendar. */
function closedHistory(closes: readonly number[]): DailyPrice[] {
  const prices: DailyPrice[] = [];
  const cursor = new Date("2026-01-05T00:00:00.000Z");
  for (const close of closes) {
    prices.push({
      securityId: SECURITY.id,
      date: cursor.toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1_000,
    });
    do {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  }
  return prices;
}

const INSIDER_BUYERS_5: AlternativeDataMetric = {
  kind: "INSIDER_ACTIVITY",
  measure: "BUYERS",
  lookback: 5,
};

const KEY = alternativeDataOperand(INSIDER_BUYERS_5);

/** Two insiders whose filings became readable on the 8th and the 13th of January. */
function facts(): AlternativeDataFacts {
  return {
    coverage: { from: "2026-01-05", to: "2026-01-30" },
    observations: [
      { observableFrom: "2026-01-08", actorKey: "cik-1" },
      { observableFrom: "2026-01-13", actorKey: "cik-2" },
    ],
  };
}

describe("a Monitor's provisional session reads the same signal a backtest would", () => {
  const prices = closedHistory([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

  it("agrees with the backtest frame on every closed session", () => {
    const backtest = projectEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [KEY],
      periodStart: prices[0]?.date ?? "",
      alternativeData: new Map([[KEY, facts()]]),
    }).frame;

    // The Monitor frame supersedes the newest closed row with the live observation on the same date,
    // so its earlier rows are the backtest's earlier rows.
    const monitor = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [KEY],
      observation: { price: 19.5 },
      observationDate: prices[prices.length - 1]?.date ?? "",
      alternativeData: new Map([[KEY, facts()]]),
    });
    expect(monitor).not.toBeNull();

    for (let index = 0; index < prices.length - 1; index += 1) {
      expect(
        readOperand(monitor?.frame as never, KEY, index),
        prices[index]?.date,
      ).toBe(readOperand(backtest, KEY, index));
    }
  });

  it("reads the provisional session exactly as the closed one it replaces", () => {
    const observationDate = prices[prices.length - 1]?.date ?? "";
    const monitor = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [KEY],
      observation: { price: 19.5 },
      observationDate,
      alternativeData: new Map([[KEY, facts()]]),
    });
    const backtest = projectEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [KEY],
      periodStart: observationDate,
      alternativeData: new Map([[KEY, facts()]]),
    }).frame;

    const index = monitor?.observationIndex ?? -1;
    expect(monitor?.observationDate).toBe(observationDate);
    // The live price moved; the disclosure count did not, because it is not a price-derived series.
    expect(monitor?.observationPrice).toBe(19.5);
    expect(readOperand(monitor?.frame as never, KEY, index)).toBe(
      readOperand(backtest, KEY, backtest.dates.length - 1),
    );
  });

  it("carries the reading onto a genuinely new session the provider has opened", () => {
    // The quote belongs to the next session, so the frame gains a row rather than replacing one.
    const next = "2026-01-19"; // the Monday after the last closed Friday
    const monitor = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [KEY],
      observation: { price: 20 },
      observationDate: next,
      alternativeData: new Map([[KEY, facts()]]),
    });
    expect(monitor?.observationDate).toBe(next);
    expect(monitor?.closedObservations).toBe(prices.length);
    // The five sessions ending on the 19th open on the 13th, so the earlier filing has fallen out of
    // the window and the later one has not: the window slides with the new session, as it must.
    expect(
      readOperand(monitor?.frame as never, KEY, monitor?.observationIndex ?? -1),
    ).toBe(1);
  });

  it("is NOT_EVALUABLE on the provisional session when the domain has no coverage", () => {
    const monitor = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [KEY],
      observation: { price: 19.5 },
      observationDate: prices[prices.length - 1]?.date ?? "",
      alternativeData: new Map([
        [KEY, { coverage: null, observations: [] }],
      ]),
    });
    expect(
      readOperand(monitor?.frame as never, KEY, monitor?.observationIndex ?? -1),
    ).toBeNaN();
  });

  it("widens the loaded window so the lookback fits behind the observation", () => {
    // Without this a Monitor would load two closed rows and report NOT_EVALUABLE for a metric whose
    // data is entirely present — the same failure a recursive moving average's warm-up prevents.
    const operands = [alternativeDataOperand({ ...INSIDER_BUYERS_5, lookback: 120 })];
    expect(requiredAlternativeDataLeadingSessions(operands)).toBe(120);
    expect(
      monitorWindowObservations(
        requiredDailySeries(operands),
        requiredAlternativeDataLeadingSessions(operands),
      ),
    ).toBe(121);
    // A frame naming no alternative-data operand is unaffected.
    expect(monitorWindowObservations(requiredDailySeries([]), 0)).toBe(2);
  });

  it("refuses to project an alternative-data operand with no loaded facts", () => {
    // A composition that forgot to wire the loader must fail loudly rather than make every rule that
    // references insider activity silently never fire.
    expect(() =>
      projectMonitorEvaluationFrame({
        security: SECURITY,
        prices,
        derived: [],
        operands: [KEY],
        observation: { price: 19.5 },
        observationDate: prices[prices.length - 1]?.date ?? "",
      }),
    ).toThrow(/without loaded facts/);
  });
});

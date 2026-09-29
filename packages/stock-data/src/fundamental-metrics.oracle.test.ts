import {
  FUNDAMENTAL_METRICS,
  type FundamentalMetricSnapshot,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { evaluateFundamentalMetrics } from "./fundamental-metrics.js";
import {
  materializeDailyFundamentals,
  planFundamentalEvaluationDates,
} from "./fundamental-metrics-materializer.js";
import {
  generateHistory,
  holidays,
  referenceFundamentals,
  type HistoryScenario,
} from "./fundamental-metrics-oracle.test-helper.js";
import { weekdays } from "./fundamental-metrics.test-helper.js";

/**
 * Production against a structurally independent oracle over large, deliberately messy histories.
 *
 * Each fixture is generated from a seed: several fiscal calendars, losses and near-zero sums,
 * decimal EPS, missing fields and missing quarters, families filed on different days, weekend and
 * holiday availability, restatements that invalidate and restore metrics, annual rows that must
 * never be read, a change of reporting currency with statements in other or no currencies, and a
 * JPY-scale reporter whose ratios can exceed what the calculated-series column stores. The oracle
 * (`fundamental-metrics-oracle.test-helper.ts`) recomputes every metric for every trading day from
 * scratch in exact rational arithmetic; it shares no code with production. Agreement on every day
 * therefore proves the formulas, the point-in-time selection, the window assembly, the event plan
 * and the carry-forward at once.
 */

const SECURITY_ID = "security-oracle";

function expectAgreement(
  actual: FundamentalMetricSnapshot,
  expected: Record<string, number | undefined>,
  context: string,
): void {
  for (const metric of FUNDAMENTAL_METRICS) {
    const production = actual[metric.field];
    const reference = expected[metric.field];
    if (reference === undefined) {
      expect(production, `${context} ${metric.field} must be absent`).toBe(
        undefined,
      );
      continue;
    }
    expect(production, `${context} ${metric.field}`).toBeTypeOf("number");
    const tolerance = 1e-12 * Math.max(1, Math.abs(reference));
    expect(
      Math.abs((production as number) - reference),
      `${context} ${metric.field}: ${production} vs ${reference}`,
    ).toBeLessThanOrEqual(tolerance);
  }
}

const SCENARIOS: HistoryScenario[] = [
  { seed: 1, fiscalYearEndMonth: 12, firstFiscalYear: 2008, fiscalYears: 11 },
  { seed: 7, fiscalYearEndMonth: 9, firstFiscalYear: 2010, fiscalYears: 10 },
  { seed: 23, fiscalYearEndMonth: 1, firstFiscalYear: 2012, fiscalYears: 10 },
  { seed: 101, fiscalYearEndMonth: 6, firstFiscalYear: 2005, fiscalYears: 12 },
  // A change of reporting currency mid-history, plus statements in another currency or none.
  {
    seed: 202,
    fiscalYearEndMonth: 12,
    firstFiscalYear: 2006,
    fiscalYears: 12,
    currency: {
      base: "USD",
      switchAtFiscalYear: 2012,
      switchTo: "JPY",
      noise: 0.03,
    },
  },
  // A JPY-scale reporter whose single-unit denominators give ratios DECIMAL(20,8) cannot store.
  {
    seed: 303,
    fiscalYearEndMonth: 3,
    firstFiscalYear: 2008,
    fiscalYears: 11,
    currency: { base: "JPY" },
    magnitude: 1e9,
    tinyDenominators: 0.2,
  },
];

describe.each(SCENARIOS)(
  "independent oracle, seed $seed, fiscal year ending in month $fiscalYearEndMonth",
  (scenario) => {
    const statements = generateHistory(scenario, SECURITY_ID);
    const firstYear = scenario.firstFiscalYear;
    const lastYear = scenario.firstFiscalYear + scenario.fiscalYears;
    const axis = weekdays(
      `${firstYear}-01-01`,
      `${lastYear}-12-31`,
      holidays(firstYear, lastYear),
    );

    it("agrees on every metric at every statement event and the session before it", () => {
      const events = planFundamentalEvaluationDates({
        securityId: SECURITY_ID,
        tradingDates: axis,
        statements,
      });
      expect(events.length).toBeGreaterThan(40);

      for (const event of events) {
        const index = axis.indexOf(event);
        for (const date of [axis[index - 1], event]) {
          if (date === undefined) {
            continue;
          }
          expectAgreement(
            evaluateFundamentalMetrics({
              securityId: SECURITY_ID,
              date,
              statements,
            }),
            referenceFundamentals(statements, SECURITY_ID, date),
            date,
          );
        }
      }
    });

    it("applies the currency and storable-range rules exactly where the history calls for them", () => {
      const removedBy = { currency: 0, range: 0 };
      for (const date of axis) {
        const strict = referenceFundamentals(statements, SECURITY_ID, date);
        const anyCurrency = referenceFundamentals(
          statements,
          SECURITY_ID,
          date,
          { ignoreCurrency: true },
        );
        const anyRange = referenceFundamentals(statements, SECURITY_ID, date, {
          ignoreStorableRange: true,
        });
        for (const metric of FUNDAMENTAL_METRICS) {
          if (strict[metric.field] === undefined) {
            if (anyCurrency[metric.field] !== undefined) {
              removedBy.currency += 1;
            }
            if (anyRange[metric.field] !== undefined) {
              removedBy.range += 1;
            }
          }
        }
      }

      if (scenario.currency?.switchTo || scenario.currency?.noise) {
        expect(removedBy.currency).toBeGreaterThan(100);
      } else {
        expect(removedBy.currency).toBe(0);
      }
      if (scenario.tinyDenominators) {
        expect(removedBy.range).toBeGreaterThan(100);
      } else {
        expect(removedBy.range).toBe(0);
      }
    });

    it("materializes exactly the oracle's from-scratch value on every trading day", () => {
      const states = materializeDailyFundamentals({
        securityId: SECURITY_ID,
        tradingDates: axis,
        statements,
      });

      expect(states.map((state) => state.date)).toEqual(axis);
      const available = new Map<string, number>();
      const unavailable = new Map<string, number>();
      for (const state of states) {
        const reference = referenceFundamentals(
          statements,
          SECURITY_ID,
          state.date,
        );
        expectAgreement(state, reference, state.date);
        for (const metric of FUNDAMENTAL_METRICS) {
          const counts =
            reference[metric.field] === undefined ? unavailable : available;
          counts.set(metric.field, (counts.get(metric.field) ?? 0) + 1);
        }
      }

      // Both sides of every metric are exercised: an always-absent (or never-absent) column
      // cannot pass this suite by agreeing on nothing.
      for (const metric of FUNDAMENTAL_METRICS) {
        expect(
          available.get(metric.field) ?? 0,
          `${metric.id} available days`,
        ).toBeGreaterThan(100);
        expect(
          unavailable.get(metric.field) ?? 0,
          `${metric.id} unavailable days`,
        ).toBeGreaterThan(0);
      }
    });
  },
);

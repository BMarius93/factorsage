import {
  FUNDAMENTAL_METRICS,
  type FinancialStatement,
  type FinancialStatementType,
  type FundamentalMetricSnapshot,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { evaluateFundamentalMetrics } from "./fundamental-metrics.js";
import {
  materializeDailyFundamentals,
  planFundamentalEvaluationDates,
} from "./fundamental-metrics-materializer.js";
import { referenceFundamentals } from "./fundamental-metrics-oracle.test-helper.js";
import { weekdays } from "./fundamental-metrics.test-helper.js";

/**
 * Production against a structurally independent oracle over large, deliberately messy histories.
 *
 * Each fixture is generated from a seed: several fiscal calendars, losses and near-zero sums,
 * decimal EPS, missing fields and missing quarters, families filed on different days, weekend and
 * holiday availability, restatements that invalidate and restore metrics, and annual rows that
 * must never be read. The oracle (`fundamental-metrics-oracle.test-helper.ts`) recomputes every
 * metric for every trading day from scratch in exact rational arithmetic; it shares no code with
 * production. Agreement on every day therefore proves the formulas, the point-in-time selection,
 * the window assembly, the event plan and the carry-forward at once.
 */

const SECURITY_ID = "security-oracle";

/** mulberry32: a small deterministic PRNG, so every failure reproduces from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Last day of `month` (1-12) in `year`, as a fiscal period end. */
function monthEnd(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

type Scenario = {
  seed: number;
  /** Calendar month (1-12) the fiscal year ends in. */
  fiscalYearEndMonth: number;
  firstFiscalYear: number;
  fiscalYears: number;
};

function generateHistory(scenario: Scenario): FinancialStatement[] {
  const next = random(scenario.seed);
  const pick = (probability: number) => next() < probability;
  const integer = (low: number, high: number) =>
    Math.round(low + next() * (high - low));
  const rows: FinancialStatement[] = [];
  let hashes = 0;

  const emit = (
    statementType: FinancialStatementType,
    fiscalYear: number,
    period: FinancialStatement["period"],
    fiscalDate: string,
    availableFromDate: string,
    values: Record<string, number>,
  ) => {
    // A field the provider did not report is an absent key, never a zero.
    const reported = Object.fromEntries(
      Object.entries(values).filter(() => !pick(0.015)),
    );
    hashes += 1;
    rows.push({
      securityId: SECURITY_ID,
      statementType,
      fiscalDate,
      fiscalYear,
      period,
      reportedCurrency: "USD",
      filingDate: addDays(availableFromDate, -1),
      availableFromDate,
      observedAt: `${availableFromDate}T12:00:00.000Z`,
      contentHash: `hash-${String(hashes).padStart(6, "0")}`,
      values: reported,
    });
  };

  let scale = 1_000;
  for (
    let fiscalYear = scenario.firstFiscalYear;
    fiscalYear < scenario.firstFiscalYear + scenario.fiscalYears;
    fiscalYear += 1
  ) {
    for (let index = 0; index < 4; index += 1) {
      const period = (["Q1", "Q2", "Q3", "Q4"] as const)[index]!;
      // Q4 ends in the fiscal year-end month of the label year; each earlier quarter three months
      // before, so a September or January year-end puts early quarters in the prior calendar year.
      const monthsBeforeYearEnd = (3 - index) * 3;
      const endMonthIndex =
        fiscalYear * 12 +
        (scenario.fiscalYearEndMonth - 1) -
        monthsBeforeYearEnd;
      const fiscalDate = monthEnd(
        Math.floor(endMonthIndex / 12),
        (endMonthIndex % 12) + 1,
      );
      const filed = addDays(fiscalDate, integer(25, 55));
      scale *= 0.97 + next() * 0.09;
      const loss = pick(0.15);
      const revenue = pick(0.04) ? 0 : integer(scale * 0.8, scale * 1.2);
      const netIncome = loss
        ? -integer(1, scale * 0.2)
        : integer(0, scale * 0.15);
      const shares = integer(90, 110);
      const income = {
        revenue: pick(0.01) ? -integer(1, 50) : revenue,
        grossProfit: integer(-scale * 0.1, scale * 0.6),
        operatingIncome: integer(-scale * 0.2, scale * 0.3),
        netIncome,
        // Two-decimal EPS, so sums of reported decimals are exercised, including exact zeros.
        epsDiluted: Math.round((netIncome / shares) * 100) / 100,
        weightedAverageShsOutDil: shares,
        ebitda: integer(-scale * 0.1, scale * 0.4),
        ebit: integer(-scale * 0.2, scale * 0.3),
        interestExpense: pick(0.1) ? 0 : integer(1, scale * 0.05),
        incomeTaxExpense: integer(0, scale * 0.1),
      };
      const cashFlow = {
        operatingCashFlow: integer(-scale * 0.05, scale * 0.4),
        capitalExpenditure: pick(0.1) ? 0 : -integer(1, scale * 0.15),
        freeCashFlow: integer(-scale, scale),
      };
      const balanceSheet = {
        totalDebt: pick(0.1) ? 0 : integer(0, scale * 2),
        totalStockholdersEquity: pick(0.08)
          ? -integer(1, scale)
          : integer(1, scale * 3),
        totalEquity: integer(1, scale * 3),
        cashAndShortTermInvestments: integer(0, scale * 1.5),
        cashAndCashEquivalents: integer(0, scale),
        totalAssets: integer(scale, scale * 6),
        totalCurrentAssets: integer(0, scale * 2),
        totalCurrentLiabilities: pick(0.05) ? 0 : integer(1, scale * 1.5),
        netDebt: integer(-scale, scale * 2),
      };

      // Families are usually filed together; sometimes one lags by a week or more, and very
      // occasionally a quarter of one family is never reported at all.
      const lag = () => (pick(0.15) ? integer(1, 20) : 0);
      const families: [FinancialStatementType, Record<string, number>][] = [
        ["INCOME", income],
        ["CASH_FLOW", cashFlow],
        ["BALANCE_SHEET", balanceSheet],
      ];
      for (const [type, values] of families) {
        if (pick(0.02)) {
          continue;
        }
        const available = addDays(filed, 1 + lag());
        emit(type, fiscalYear, period, fiscalDate, available, values);
        if (pick(0.12)) {
          // A later restatement of the same fiscal identity: perturbed values, sometimes with a
          // field removed or a sign flipped, eligible only from its own availability date.
          const restated = Object.fromEntries(
            Object.entries(values).map(([name, value]) => [
              name,
              pick(0.3) ? -value : Math.round(value * (0.8 + next() * 0.4)),
            ]),
          );
          emit(
            type,
            fiscalYear,
            period,
            fiscalDate,
            addDays(available, integer(30, 500)),
            restated,
          );
        }
      }
    }
    // Annual rows exist and carry large, different values: no metric may read them.
    const yearEnd = monthEnd(fiscalYear, scenario.fiscalYearEndMonth);
    const annualAvailable = addDays(yearEnd, integer(40, 80));
    for (const type of ["INCOME", "CASH_FLOW", "BALANCE_SHEET"] as const) {
      emit(type, fiscalYear, "FY", yearEnd, annualAvailable, {
        revenue: 9e9,
        grossProfit: 9e9,
        operatingIncome: 9e9,
        netIncome: 9e9,
        epsDiluted: 999,
        ebitda: 9e9,
        ebit: 9e9,
        interestExpense: 1,
        operatingCashFlow: 9e9,
        capitalExpenditure: -1,
        totalDebt: 1,
        totalStockholdersEquity: 1,
        totalAssets: 1,
        totalCurrentAssets: 9e9,
        totalCurrentLiabilities: 1,
        netDebt: 9e9,
      });
    }
  }
  return rows;
}

/** A few fixed exchange holidays each year, so availability also lands on closed weekdays. */
function holidays(firstYear: number, lastYear: number): string[] {
  const dates: string[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    dates.push(`${year}-01-01`, `${year}-07-04`, `${year}-12-25`);
  }
  return dates;
}

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

const SCENARIOS: Scenario[] = [
  { seed: 1, fiscalYearEndMonth: 12, firstFiscalYear: 2008, fiscalYears: 11 },
  { seed: 7, fiscalYearEndMonth: 9, firstFiscalYear: 2010, fiscalYears: 10 },
  { seed: 23, fiscalYearEndMonth: 1, firstFiscalYear: 2012, fiscalYears: 10 },
  { seed: 101, fiscalYearEndMonth: 6, firstFiscalYear: 2005, fiscalYears: 12 },
];

describe.each(SCENARIOS)(
  "independent oracle, seed $seed, fiscal year ending in month $fiscalYearEndMonth",
  (scenario) => {
    const statements = generateHistory(scenario);
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

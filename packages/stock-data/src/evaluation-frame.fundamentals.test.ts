import {
  FUNDAMENTAL_METRIC_IDS,
  type FundamentalMetricId,
} from "@intrinsic/contracts";
import type {
  DailyDerivedState,
  DailyPrice,
  Security,
} from "@intrinsic/domain";
import {
  fundamentalMetricOperand,
  PRICE_OPERAND,
  readOperand,
  relativeVolumeOperand,
  seriesOperand,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import { projectEvaluationFrame } from "./evaluation-frame.js";

/**
 * Fundamental Metrics in the evaluation frame: read from the materialized daily derived state,
 * never calculated.
 *
 * Every expectation here is a literal written by hand, keyed by identity, and never derived from the
 * registry the projector uses — so a projector that read ROE for ROIC, EPS growth for revenue growth,
 * a misspelt field, a percentage as a fraction or an absence as zero reads a wrong, recognizable
 * number here rather than agreeing with itself.
 */

const security: Security = {
  id: "security-fundamentals",
  symbol: "FUND",
  name: "Fundamentals Corp",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

const DATE = "2024-03-01";

function price(date: string, close = 100): DailyPrice {
  return {
    securityId: security.id,
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  };
}

/** One distinct reading per stored field, by field name — the persisted row as PostgreSQL holds it. */
const STORED_FIELDS = {
  revenueGrowthTtmYoy: 101.01,
  epsGrowthTtmYoy: 102.02,
  fcfGrowthTtmYoy: 103.03,
  grossMarginTtm: 104.04,
  operatingMarginTtm: 105.05,
  netMarginTtm: 106.06,
  fcfMarginTtm: 107.07,
  roicTtm: 108.08,
  roeTtm: 109.09,
  roaTtm: 110.1,
  debtToEquity: 1.11,
  currentRatio: 1.12,
  netDebtToEbitdaTtm: 1.13,
  interestCoverageTtm: 1.14,
  assetTurnoverTtm: 1.15,
} as const;

/** The same readings, written again by identity: what each metric's column must hold. */
const EXPECTED_BY_ID: Record<FundamentalMetricId, number> = {
  REVENUE_GROWTH_TTM_YOY: 101.01,
  EPS_GROWTH_TTM_YOY: 102.02,
  FCF_GROWTH_TTM_YOY: 103.03,
  GROSS_MARGIN_TTM: 104.04,
  OPERATING_MARGIN_TTM: 105.05,
  NET_MARGIN_TTM: 106.06,
  FCF_MARGIN_TTM: 107.07,
  ROIC_TTM: 108.08,
  ROE_TTM: 109.09,
  ROA_TTM: 110.1,
  DEBT_TO_EQUITY: 1.11,
  CURRENT_RATIO: 1.12,
  NET_DEBT_TO_EBITDA_TTM: 1.13,
  INTEREST_COVERAGE_TTM: 1.14,
  ASSET_TURNOVER_TTM: 1.15,
};

/** Which stored field each identity reads, written out rather than looked up. */
const FIELD_BY_ID: Record<FundamentalMetricId, keyof typeof STORED_FIELDS> = {
  REVENUE_GROWTH_TTM_YOY: "revenueGrowthTtmYoy",
  EPS_GROWTH_TTM_YOY: "epsGrowthTtmYoy",
  FCF_GROWTH_TTM_YOY: "fcfGrowthTtmYoy",
  GROSS_MARGIN_TTM: "grossMarginTtm",
  OPERATING_MARGIN_TTM: "operatingMarginTtm",
  NET_MARGIN_TTM: "netMarginTtm",
  FCF_MARGIN_TTM: "fcfMarginTtm",
  ROIC_TTM: "roicTtm",
  ROE_TTM: "roeTtm",
  ROA_TTM: "roaTtm",
  DEBT_TO_EQUITY: "debtToEquity",
  CURRENT_RATIO: "currentRatio",
  NET_DEBT_TO_EBITDA_TTM: "netDebtToEbitdaTtm",
  INTEREST_COVERAGE_TTM: "interestCoverageTtm",
  ASSET_TURNOVER_TTM: "assetTurnoverTtm",
};

const IDS = Object.keys(EXPECTED_BY_ID) as FundamentalMetricId[];

function row(
  values: Partial<DailyDerivedState> = STORED_FIELDS,
): DailyDerivedState {
  return { securityId: security.id, date: DATE, ...values };
}

function project(
  operands: readonly string[],
  derived: readonly DailyDerivedState[] = [row()],
  prices: readonly DailyPrice[] = [price(DATE)],
) {
  return projectEvaluationFrame({
    security,
    prices,
    derived,
    operands,
    periodStart: prices[0]?.date ?? DATE,
  }).frame;
}

describe("Fundamental Metrics in the evaluation frame", () => {
  it("covers exactly the fifteen metrics of the catalog", () => {
    // The literal tables above are complete: a metric added to the catalog without a row here fails
    // this rather than going untested.
    expect([...IDS].sort()).toEqual([...FUNDAMENTAL_METRIC_IDS].sort());
    expect(new Set(Object.values(FIELD_BY_ID)).size).toBe(15);
  });

  it("reads each metric from exactly its own field, one column per requested metric", () => {
    for (const id of IDS) {
      const key = fundamentalMetricOperand(id);
      const frame = project([PRICE_OPERAND, key]);
      expect(readOperand(frame, key, 0), id).toBe(EXPECTED_BY_ID[id]);
      // Price rides on the closes; the metric is the one and only column.
      expect([...frame.columns.keys()], id).toEqual([key]);
    }
  });

  it("projects all fifteen side by side without crossing a single column", () => {
    const keys = IDS.map(fundamentalMetricOperand);
    const frame = project(keys);
    expect(frame.columns.size).toBe(15);
    for (const id of IDS) {
      expect(readOperand(frame, fundamentalMetricOperand(id), 0), id).toBe(
        EXPECTED_BY_ID[id],
      );
    }
  });

  it("leaves each metric absent on its own, as NaN and never zero", () => {
    const keys = IDS.map(fundamentalMetricOperand);
    for (const missing of IDS) {
      const values: Partial<DailyDerivedState> = { ...STORED_FIELDS };
      delete values[FIELD_BY_ID[missing]];
      const frame = project(keys, [row(values)]);
      for (const id of IDS) {
        const value = readOperand(frame, fundamentalMetricOperand(id), 0);
        if (id === missing) {
          expect(value, `${missing} absent`).toBeNaN();
        } else {
          expect(value, `${id} beside absent ${missing}`).toBe(
            EXPECTED_BY_ID[id],
          );
        }
      }
    }
  });

  it("keeps a real zero as zero and a negative reading as negative", () => {
    const keys = IDS.map(fundamentalMetricOperand);
    const zeros = Object.fromEntries(
      Object.keys(STORED_FIELDS).map((field) => [field, 0]),
    ) as Partial<DailyDerivedState>;
    const negatives = Object.fromEntries(
      Object.entries(STORED_FIELDS).map(([field, value]) => [field, -value]),
    ) as Partial<DailyDerivedState>;

    const zeroFrame = project(keys, [row(zeros)]);
    const negativeFrame = project(keys, [row(negatives)]);
    for (const id of IDS) {
      const key = fundamentalMetricOperand(id);
      expect(Object.is(readOperand(zeroFrame, key, 0), 0), id).toBe(true);
      expect(readOperand(negativeFrame, key, 0), id).toBe(-EXPECTED_BY_ID[id]);
    }
  });

  it("keeps percentage points as percentage points and multiples as raw multiples", () => {
    const frame = project(
      [
        fundamentalMetricOperand("ROIC_TTM"),
        fundamentalMetricOperand("DEBT_TO_EQUITY"),
      ],
      [row({ roicTtm: 15.42, debtToEquity: 0.75 })],
    );
    // 15.42% is 15.42 — not 0.1542, and not 1542.
    expect(readOperand(frame, fundamentalMetricOperand("ROIC_TTM"), 0)).toBe(
      15.42,
    );
    expect(
      readOperand(frame, fundamentalMetricOperand("DEBT_TO_EQUITY"), 0),
    ).toBe(0.75);
  });

  it("follows the stored value from day to day, absence included, with no carry of its own", () => {
    const dates = ["2026-01-02", "2026-01-05", "2026-02-10", "2026-02-11"];
    const key = fundamentalMetricOperand("ROIC_TTM");
    const frame = project(
      [key],
      [
        // 2026-01-02: unavailable. 2026-01-05: 12. 2026-02-10: 18. 2026-02-11: no derived row.
        { securityId: security.id, date: "2026-01-02" },
        { securityId: security.id, date: "2026-01-05", roicTtm: 12 },
        { securityId: security.id, date: "2026-02-10", roicTtm: 18 },
      ],
      dates.map((date) => price(date)),
    );
    expect(frame.dates).toEqual(dates);
    expect(readOperand(frame, key, 0)).toBeNaN();
    expect(readOperand(frame, key, 1)).toBe(12);
    expect(readOperand(frame, key, 2)).toBe(18);
    // Carry-forward is the materializer's job, done before persistence. A day with no derived row is
    // a data-integrity gap the projector reports, never one it fills from the day before.
    expect(readOperand(frame, key, 3)).toBeNaN();
  });

  it("treats a non-finite in-memory value as absent", () => {
    const key = fundamentalMetricOperand("INTEREST_COVERAGE_TTM");
    for (const value of [Number.NaN, Infinity, -Infinity]) {
      const frame = project([key], [row({ interestCoverageTtm: value })]);
      expect(readOperand(frame, key, 0), String(value)).toBeNaN();
    }
  });

  it("projects only the metrics requested, never the whole family", () => {
    const one = project([fundamentalMetricOperand("ROE_TTM")]);
    expect([...one.columns.keys()]).toEqual([
      fundamentalMetricOperand("ROE_TTM"),
    ]);

    const two = project([
      fundamentalMetricOperand("ROIC_TTM"),
      fundamentalMetricOperand("DEBT_TO_EQUITY"),
    ]);
    expect([...two.columns.keys()].sort()).toEqual(
      [
        fundamentalMetricOperand("DEBT_TO_EQUITY"),
        fundamentalMetricOperand("ROIC_TTM"),
      ].sort(),
    );

    const none = project([PRICE_OPERAND, seriesOperand("SMA_200D")]);
    expect(
      [...none.columns.keys()].filter((key) => key.startsWith("fundamental:")),
    ).toEqual([]);
    // An unrequested metric simply has no column, and reading one is absence.
    expect(readOperand(one, fundamentalMetricOperand("ROIC_TTM"), 0)).toBeNaN();
  });

  it("sits beside the other families without disturbing them", () => {
    const frame = project(
      [
        PRICE_OPERAND,
        seriesOperand("SMA_200D"),
        relativeVolumeOperand(20),
        fundamentalMetricOperand("ROIC_TTM"),
      ],
      [row({ ...STORED_FIELDS, sma200d: 95.5, rvol20: 1.7 })],
      [price(DATE, 101.25)],
    );
    expect(readOperand(frame, PRICE_OPERAND, 0)).toBe(101.25);
    expect(readOperand(frame, seriesOperand("SMA_200D"), 0)).toBe(95.5);
    expect(readOperand(frame, relativeVolumeOperand(20), 0)).toBe(1.7);
    expect(readOperand(frame, fundamentalMetricOperand("ROIC_TTM"), 0)).toBe(
      108.08,
    );
  });

  it("refuses a key of the family that names no metric, rather than projecting it as absent", () => {
    for (const key of [
      "fundamental:PE_TTM",
      "fundamental:roic_ttm",
      "fundamental:roicTtm",
      "fundamental:ROIC TTM",
      "fundamental:",
    ]) {
      expect(() => project([key]), key).toThrow(
        `Unsupported evaluation operand '${key}'`,
      );
    }
  });
});

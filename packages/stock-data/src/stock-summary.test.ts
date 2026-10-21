import {
  FUNDAMENTAL_METRIC_IDS,
  STOCK_SUMMARY_TECHNICAL_IDS,
  VALUATION_RATIO_IDS,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import type {
  DailyDerivedState,
  DailyPrice,
  IntrinsicValueBlendPoint,
  IntrinsicValuePoint,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { latestPublicQuarter, summarizeStockWindow } from "./stock-summary.js";

const SECURITY = "security-1";

function bar(
  date: string,
  close: number,
  high = close,
  low = close,
): DailyPrice {
  return {
    securityId: SECURITY,
    date,
    open: close,
    high,
    low,
    close,
    volume: 1_000,
  };
}

function row(
  date: string,
  values: Partial<DailyDerivedState> = {},
): DailyDerivedState {
  return { securityId: SECURITY, date, ...values };
}

const PRICES = [
  bar("2026-08-17", 100, 104, 96),
  bar("2026-08-18", 101, 130, 99),
  bar("2026-08-19", 102, 103, 80),
  bar("2026-08-20", 103),
];

function ratioColumns(
  values: Partial<Record<ValuationRatioId, number[]>>,
): Map<ValuationRatioId, Float64Array> {
  return new Map(
    VALUATION_RATIO_IDS.map((id) => [
      id,
      Float64Array.from(values[id] ?? PRICES.map(() => Number.NaN)),
    ]),
  );
}

function summarize(
  overrides: Partial<Parameters<typeof summarizeStockWindow>[0]> = {},
) {
  return summarizeStockWindow({
    prices: PRICES,
    derived: PRICES.map((price) => row(price.date)),
    intrinsicValues: [],
    intrinsicValueBlends: [],
    ratioColumns: ratioColumns({}),
    statements: [],
    ...overrides,
  });
}

describe("summarizeStockWindow", () => {
  it("states the newest bar, the session before it and the window's range", () => {
    expect(summarize().quote).toEqual({
      date: "2026-08-20",
      open: 103,
      high: 103,
      low: 103,
      close: 103,
      volume: 1_000,
      previous: { date: "2026-08-19", close: 102 },
      rangeHigh: 130,
      rangeLow: 80,
    });
  });

  it("has no quote, and no reporting period, for a window without a bar", () => {
    const summary = summarize({
      prices: [],
      derived: [],
      statements: [
        {
          fiscalYear: 2026,
          period: "Q1",
          fiscalDate: "2026-03-31",
          availableFromDate: "2026-05-01",
        },
      ],
    });
    expect(summary.quote).toBeUndefined();
    expect(summary.latestQuarter).toBeUndefined();
  });

  it("keeps the newest valued session of each ratio, a zero and a negative included, and never invents one", () => {
    const summary = summarize({
      ratioColumns: ratioColumns({
        // Available through 2026-08-18, then unavailable: the reading keeps its own date.
        PRICE_TO_EARNINGS_TTM: [20, 21, Number.NaN, Number.NaN],
        PRICE_TO_BOOK: [1, 2, 3, 0],
        EV_TO_EBITDA_TTM: [-1, -2, -3, -1.25],
      }),
    });
    expect(summary.valuationRatios).toEqual({
      status: "AVAILABLE",
      readings: [
        { id: "PRICE_TO_EARNINGS_TTM", date: "2026-08-18", value: 21 },
        { id: "PRICE_TO_SALES_TTM" },
        { id: "PRICE_TO_BOOK", date: "2026-08-20", value: 0 },
        { id: "PRICE_TO_FCF_TTM" },
        { id: "EV_TO_EBITDA_TTM", date: "2026-08-20", value: -1.25 },
      ],
    });
  });

  it("passes a ratio failure through with its cause and computes nothing for it", () => {
    const cause = new Error("split list unavailable");
    expect(
      summarize({ ratioColumns: { failure: cause } }).valuationRatios,
    ).toEqual({ status: "FAILED", cause });
  });

  it("reads every Fundamental Metric and the three technicals from the derived rows, absence as no reading", () => {
    const summary = summarize({
      derived: [
        row("2026-08-17", { roicTtm: 12, ema50d: 99, rsi14d: 55 }),
        row("2026-08-18", { roicTtm: 13, debtToEquity: -0.5, ema50d: 100 }),
        row("2026-08-19", { roicTtm: 0, ema200d: 90 }),
        row("2026-08-20", { ema50d: 101 }),
      ],
    });
    expect(summary.fundamentals.map((reading) => reading.id)).toEqual([
      ...FUNDAMENTAL_METRIC_IDS,
    ]);
    const metric = (id: string) =>
      summary.fundamentals.find((reading) => reading.id === id);
    // Zero is a reading; the newest session without one does not erase it, and keeps its date.
    expect(metric("ROIC_TTM")).toEqual({
      id: "ROIC_TTM",
      date: "2026-08-19",
      value: 0,
    });
    expect(metric("DEBT_TO_EQUITY")).toEqual({
      id: "DEBT_TO_EQUITY",
      date: "2026-08-18",
      value: -0.5,
    });
    expect(metric("CURRENT_RATIO")).toEqual({ id: "CURRENT_RATIO" });

    expect(summary.technicals.map((reading) => reading.id)).toEqual([
      ...STOCK_SUMMARY_TECHNICAL_IDS,
    ]);
    expect(summary.technicals).toEqual([
      { id: "EMA_50D", date: "2026-08-20", value: 101 },
      { id: "EMA_200D", date: "2026-08-19", value: 90 },
      { id: "RSI_14D", date: "2026-08-17", value: 55 },
    ]);
  });

  it("keeps the newest point of each model and blend with its own date, in catalog order", () => {
    const model = (
      date: string,
      name: IntrinsicValuePoint["model"],
      value: number,
    ): IntrinsicValuePoint => ({
      securityId: SECURITY,
      valuationDate: date,
      sourceDataAsOf: "2026-05-01T00:00:00.000Z",
      model: name,
      valuePerShare: value,
      currency: "USD",
    });
    const blend: IntrinsicValueBlendPoint = {
      securityId: SECURITY,
      valuationDate: "2026-08-18",
      sourceDataAsOf: "2026-05-01T00:00:00.000Z",
      blendId: "BALANCED",
      valuePerShare: 140,
      currency: "USD",
    };
    const summary = summarize({
      intrinsicValues: [
        model("2026-08-17", "GRAHAM", 90),
        model("2026-08-19", "DCF_FCFF", 150),
        model("2026-08-20", "DCF_FCFF", 151),
        model("2026-08-18", "GRAHAM", 91),
      ],
      intrinsicValueBlends: [blend],
    });
    expect(summary.intrinsicValues).toEqual([
      model("2026-08-20", "DCF_FCFF", 151),
      model("2026-08-18", "GRAHAM", 91),
    ]);
    expect(summary.intrinsicValueBlends).toEqual([blend]);
  });
});

describe("latestPublicQuarter", () => {
  const statement = (
    fiscalYear: number,
    period: "Q1" | "Q2" | "Q3" | "Q4" | "FY",
    fiscalDate: string,
    availableFromDate: string,
  ) => ({ fiscalYear, period, fiscalDate, availableFromDate });

  it("names the newest period public by the session, from its first public revision", () => {
    expect(
      latestPublicQuarter(
        [
          statement(2026, "Q1", "2026-03-31", "2026-05-01"),
          // A later amendment of the same period: the period was public from its first revision.
          statement(2026, "Q2", "2026-06-30", "2026-08-15"),
          statement(2026, "Q2", "2026-06-30", "2026-08-05"),
          // Public only after the session: never read.
          statement(2026, "Q3", "2026-09-30", "2026-11-01"),
        ],
        "2026-08-20",
      ),
    ).toEqual({
      fiscalYear: 2026,
      period: "Q2",
      fiscalDate: "2026-06-30",
      availableFromDate: "2026-08-05",
    });
  });

  it("ignores annual rows and answers nothing before the first public quarter", () => {
    expect(
      latestPublicQuarter(
        [
          statement(2025, "FY", "2025-12-31", "2026-02-01"),
          statement(2026, "Q1", "2026-03-31", "2026-05-01"),
        ],
        "2026-04-30",
      ),
    ).toBeUndefined();
  });
});

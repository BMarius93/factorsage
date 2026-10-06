import type { ValuationRatioId } from "@intrinsic/contracts";
import type { FinancialStatement, StockSplit } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import type { PriceBasisEvent } from "./price-basis.js";
import {
  buildValuationTimeline,
  valuationRatioColumns,
  type ValuationInputs,
} from "./valuation-ratios.js";

const SECURITY = "security-1";
const OBSERVED = "2025-01-15T00:00:00.000Z";
const ALL: readonly ValuationRatioId[] = [
  "PRICE_TO_EARNINGS_TTM",
  "PRICE_TO_SALES_TTM",
  "PRICE_TO_BOOK",
  "PRICE_TO_FCF_TTM",
  "EV_TO_EBITDA_TTM",
];

type Quarter = {
  fiscalDate: string;
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4";
  availableFromDate: string;
  observedAt?: string;
  currency?: string;
};

function statement(
  type: FinancialStatement["statementType"],
  quarter: Quarter,
  values: Record<string, number>,
): FinancialStatement {
  return {
    securityId: SECURITY,
    statementType: type,
    fiscalDate: quarter.fiscalDate,
    fiscalYear: quarter.fiscalYear,
    period: quarter.period,
    reportedCurrency: quarter.currency ?? "USD",
    filingDate: quarter.availableFromDate,
    availableFromDate: quarter.availableFromDate,
    observedAt: quarter.observedAt ?? OBSERVED,
    contentHash: `${type}:${quarter.fiscalDate}:${quarter.observedAt ?? OBSERVED}:${JSON.stringify(values)}`,
    values,
  } as FinancialStatement;
}

/** The four quarters of fiscal 2024, each public 40 days after it ended. */
const QUARTERS: readonly Quarter[] = [
  {
    fiscalDate: "2024-03-31",
    fiscalYear: 2024,
    period: "Q1",
    availableFromDate: "2024-05-10",
  },
  {
    fiscalDate: "2024-06-30",
    fiscalYear: 2024,
    period: "Q2",
    availableFromDate: "2024-08-09",
  },
  {
    fiscalDate: "2024-09-30",
    fiscalYear: 2024,
    period: "Q3",
    availableFromDate: "2024-11-09",
  },
  {
    fiscalDate: "2024-12-31",
    fiscalYear: 2024,
    period: "Q4",
    availableFromDate: "2025-02-09",
  },
];

/**
 * A company with 100 diluted shares, quarterly net income 5, revenue 50, EBITDA 10, operating cash
 * flow 8 and capital expenditure -2, equity 400 and net debt 60.
 */
function company(
  overrides: {
    shares?: (index: number) => number;
    netIncome?: number;
    quarters?: readonly Quarter[];
  } = {},
): FinancialStatement[] {
  const quarters = overrides.quarters ?? QUARTERS;
  return quarters.flatMap((quarter, index) => [
    statement("INCOME", quarter, {
      weightedAverageShsOutDil: overrides.shares?.(index) ?? 100,
      netIncome: overrides.netIncome ?? 5,
      revenue: 50,
      ebitda: 10,
    }),
    statement("BALANCE_SHEET", quarter, {
      totalStockholdersEquity: 400,
      netDebt: 60,
    }),
    statement("CASH_FLOW", quarter, {
      operatingCashFlow: 8,
      capitalExpenditure: -2,
    }),
  ]);
}

function inputs(overrides: Partial<ValuationInputs> = {}): ValuationInputs {
  return {
    securityId: SECURITY,
    currency: "USD",
    statements: company(),
    verifiedAt: "2025-01-01T00:00:00.000Z",
    events: [],
    splits: [],
    ...overrides,
  };
}

/** The ratios on each date at one close, as plain numbers (NaN where unavailable). */
function ratiosOn(
  valuation: ValuationInputs,
  dates: readonly string[],
  close: number | ((date: string) => number) = 10,
  ratios: readonly ValuationRatioId[] = ALL,
): Record<ValuationRatioId, number[]> {
  const columns = valuationRatioColumns({
    timeline: buildValuationTimeline(valuation),
    dates,
    closes: dates.map((date) =>
      typeof close === "number" ? close : close(date),
    ),
    ratios,
  });
  return Object.fromEntries(
    ratios.map((ratio) => [ratio, [...(columns.get(ratio) as Float64Array)]]),
  ) as Record<ValuationRatioId, number[]>;
}

const evidence = {
  runs: [],
  comparedSessions: 0,
  changedSessions: 0,
  unfittedSessions: 0,
};

function measured(fields: Partial<PriceBasisEvent>): PriceBasisEvent {
  return {
    securityId: SECURITY,
    generation: 1,
    kind: "MEASURED",
    detectedAt: "2025-06-02T12:00:00.000Z",
    evidence,
    ...fields,
  };
}

function split(fields: Partial<StockSplit>): StockSplit {
  return {
    securityId: SECURITY,
    date: "2025-01-01",
    numerator: 2,
    denominator: 1,
    label: "stock-split",
    ...fields,
  };
}

describe("valuation ratios: the definitions", () => {
  it("reads market capitalisation against each denominator", () => {
    // Close 10 × 100 diluted shares = 1,000.
    const result = ratiosOn(inputs(), ["2025-02-10"]);
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeCloseTo(1000 / 20, 12);
    expect(result.PRICE_TO_SALES_TTM[0]).toBeCloseTo(1000 / 200, 12);
    expect(result.PRICE_TO_BOOK[0]).toBeCloseTo(1000 / 400, 12);
    expect(result.PRICE_TO_FCF_TTM[0]).toBeCloseTo(1000 / 24, 12);
    // Enterprise value is the market capitalisation plus net debt, never net debt scaled by price.
    expect(result.EV_TO_EBITDA_TTM[0]).toBeCloseTo((1000 + 60) / 40, 12);
  });

  it("moves with the close and nothing else between statement events", () => {
    const result = ratiosOn(inputs(), ["2025-02-10", "2025-02-11"], (date) =>
      date === "2025-02-10" ? 10 : 12,
    );
    expect(
      result.PRICE_TO_EARNINGS_TTM[1]! / result.PRICE_TO_EARNINGS_TTM[0]!,
    ).toBeCloseTo(1.2, 12);
    // Net debt does not scale with the price.
    expect(result.EV_TO_EBITDA_TTM[1]).toBeCloseTo((1200 + 60) / 40, 12);
  });

  it("is unavailable before four quarters are public, except where a balance sheet suffices", () => {
    const result = ratiosOn(inputs(), ["2024-11-11"]);
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeNaN();
    expect(result.PRICE_TO_FCF_TTM[0]).toBeNaN();
    expect(result.EV_TO_EBITDA_TTM[0]).toBeNaN();
    // P/B reads the latest count and balance sheet only.
    expect(result.PRICE_TO_BOOK[0]).toBeCloseTo(1000 / 400, 12);
  });

  it("is unavailable on a loss, never negative or infinite", () => {
    const result = ratiosOn(
      inputs({ statements: company({ netIncome: -5 }) }),
      ["2025-02-10"],
    );
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeNaN();
    expect(result.PRICE_TO_SALES_TTM[0]).toBeCloseTo(5, 12);
  });

  it("is unavailable when a statement reports another currency than the trading one", () => {
    const quarters = QUARTERS.map((quarter) => ({
      ...quarter,
      currency: "TWD",
    }));
    const result = ratiosOn(inputs({ statements: company({ quarters }) }), [
      "2025-02-10",
    ]);
    for (const ratio of ALL) {
      expect(result[ratio][0]).toBeNaN();
    }
  });

  it("reads a ratio only when every statement it reads reports the trading currency, the count's too", () => {
    const reportedIn = (type: FinancialStatement["statementType"]) =>
      ratiosOn(
        inputs({
          statements: company().map((row) =>
            row.statementType === type
              ? { ...row, reportedCurrency: "TWD" }
              : row,
          ),
        }),
        ["2025-02-10"],
      );
    // The Income statement carries the share count every ratio reads.
    const income = reportedIn("INCOME");
    for (const ratio of ALL) {
      expect(income[ratio][0], ratio).toBeNaN();
    }
    const balanceSheet = reportedIn("BALANCE_SHEET");
    expect(balanceSheet.PRICE_TO_BOOK[0]).toBeNaN();
    expect(balanceSheet.EV_TO_EBITDA_TTM[0]).toBeNaN();
    expect(balanceSheet.PRICE_TO_EARNINGS_TTM[0]).toBeCloseTo(50, 12);
    expect(balanceSheet.PRICE_TO_FCF_TTM[0]).toBeCloseTo(1000 / 24, 12);
    const cashFlow = reportedIn("CASH_FLOW");
    expect(cashFlow.PRICE_TO_FCF_TTM[0]).toBeNaN();
    expect(cashFlow.PRICE_TO_BOOK[0]).toBeCloseTo(1000 / 400, 12);
  });

  it("is unavailable for a security whose price history the loader has not verified", () => {
    const result = ratiosOn(inputs({ verifiedAt: null }), ["2025-02-10"]);
    for (const ratio of ALL) {
      expect(result[ratio][0]).toBeNaN();
    }
  });

  it("reads the newest closed session's statements on a provisional row", () => {
    const timeline = buildValuationTimeline(inputs());
    const dates = ["2025-02-07", "2025-02-10"];
    // 2025-02-10 is the first session the fourth quarter is public. Read on its own statements it
    // has a P/E; as a Monitor's provisional row it carries 2025-02-07's, three quarters, and has none.
    const own = valuationRatioColumns({
      timeline,
      dates,
      closes: [10, 10],
      ratios: ["PRICE_TO_EARNINGS_TTM"],
    });
    const carried = valuationRatioColumns({
      timeline,
      dates,
      closes: [10, 10],
      ratios: ["PRICE_TO_EARNINGS_TTM"],
      statementDateOf: (index) => (index === 1 ? "2025-02-07" : dates[index]!),
    });
    expect([...(own.get("PRICE_TO_EARNINGS_TTM") as Float64Array)]).toEqual([
      Number.NaN,
      50,
    ]);
    expect([...(carried.get("PRICE_TO_EARNINGS_TTM") as Float64Array)]).toEqual(
      [Number.NaN, Number.NaN],
    );
  });
});

describe("valuation ratios: the share count (rules 2 and 3)", () => {
  const eight = [
    ...QUARTERS.map((quarter) => ({
      ...quarter,
      fiscalYear: 2023,
      fiscalDate: quarter.fiscalDate.replace("2024", "2023"),
      availableFromDate: quarter.availableFromDate
        .replace(/^2024/, "2023")
        .replace(/^2025/, "2024"),
    })),
    ...QUARTERS,
  ];

  it("withholds a one-quarter artefact and accepts a new level on its third agreeing quarter", () => {
    // 100, 100, 100, 100, 203 (artefact), 100 ... and then a merger: 150 from Q2 2024 on.
    const artefact = ratiosOn(
      inputs({
        statements: company({
          quarters: eight,
          shares: (index) => (index === 7 ? 203 : 100),
        }),
      }),
      ["2025-02-10"],
    );
    expect(artefact.PRICE_TO_BOOK[0]).toBeNaN();

    const merger = (session: string) =>
      ratiosOn(
        inputs({
          statements: company({
            quarters: eight,
            shares: (index) => (index >= 5 ? 150 : 100),
          }),
        }),
        [session],
      ).PRICE_TO_BOOK[0];
    // Q2 and Q3 2024 at the new level are withheld; Q4 is the third, and the level holds.
    expect(merger("2024-08-09")).toBeNaN();
    expect(merger("2024-11-11")).toBeNaN();
    expect(merger("2025-02-10")).toBeCloseTo((10 * 150) / 400, 12);
  });

  it("withholds a restated count no measured re-base explains", () => {
    const original = company();
    // Every quarter restated four-fold, observed more than thirty days after the split so rule 5
    // does not apply.
    const restated = QUARTERS.map((quarter) =>
      statement(
        "INCOME",
        {
          ...quarter,
          availableFromDate: "2025-03-27",
          observedAt: "2025-03-27T00:00:00.000Z",
        },
        {
          weightedAverageShsOutDil: 400,
          netIncome: 5,
          revenue: 50,
          ebitda: 10,
        },
      ),
    );
    const unexplained = ratiosOn(
      inputs({ statements: [...original, ...restated] }),
      ["2025-03-27"],
    );
    expect(unexplained.PRICE_TO_EARNINGS_TTM[0]).toBeNaN();

    // A 4:1 split measured before the restatement was observed explains it.
    const explained = ratiosOn(
      inputs({
        statements: [...original, ...restated],
        events: [
          measured({
            effectiveDate: "2025-02-24",
            priceRatio: 4,
            detectedAt: "2025-02-25T12:00:00.000Z",
          }),
        ],
      }),
      ["2025-04-07"],
    );
    expect(explained.PRICE_TO_EARNINGS_TTM[0]).toBeCloseTo((10 * 400) / 20, 12);
  });
});

describe("valuation ratios: the provider's history entries (rule 4)", () => {
  it("masks every session before a listed distribution, and after it until statements cover it", () => {
    const quarters: Quarter[] = [
      ...QUARTERS,
      {
        fiscalDate: "2025-03-31",
        fiscalYear: 2025,
        period: "Q1",
        availableFromDate: "2025-05-09",
        observedAt: "2025-05-09T00:00:00.000Z",
      },
    ];
    const valuation = inputs({
      statements: company({ quarters }),
      verifiedAt: "2025-06-01T00:00:00.000Z",
      // IBM's Kyndryl entry, labelled a split at 523:500.
      splits: [split({ date: "2025-02-24", numerator: 523, denominator: 500 })],
    });
    const result = ratiosOn(valuation, [
      "2025-02-21",
      "2025-03-03",
      "2025-05-09",
    ]);
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeNaN();
    // After the event, the latest quarter still ended before it.
    expect(result.PRICE_TO_EARNINGS_TTM[1]).toBeNaN();
    // Q1 2025 ended after the event: available again.
    expect(result.PRICE_TO_EARNINGS_TTM[2]).toBeCloseTo(1000 / 20, 12);
  });

  it("masks nothing around a plain split in the history", () => {
    const result = ratiosOn(
      inputs({
        verifiedAt: "2025-06-01T00:00:00.000Z",
        splits: [split({ date: "2024-11-01", numerator: 4, denominator: 1 })],
      }),
      ["2025-02-10"],
    );
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeCloseTo(50, 12);
  });

  it("reads a stock dividend or another label as a possible distribution", () => {
    const quarters: Quarter[] = [
      ...QUARTERS,
      {
        fiscalDate: "2025-03-31",
        fiscalYear: 2025,
        period: "Q1",
        availableFromDate: "2025-05-09",
      },
    ];
    for (const entry of [
      split({
        date: "2025-02-24",
        numerator: 51,
        denominator: 50,
        label: "stock-dividend",
      }),
      split({
        date: "2025-02-24",
        numerator: 2,
        denominator: 1,
        label: "spin-off",
      }),
    ]) {
      const result = ratiosOn(
        inputs({
          statements: company({ quarters }),
          verifiedAt: "2025-06-01T00:00:00.000Z",
          splits: [entry],
        }),
        ["2025-03-03"],
      );
      expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeNaN();
    }
  });

  it("withholds a count observed before a listed event the history folded in unmeasured", () => {
    const result = ratiosOn(
      inputs({
        verifiedAt: "2025-06-01T00:00:00.000Z",
        // Observed 2025-01-15, before a split dated 2025-03-03 that nothing measured.
        splits: [split({ date: "2025-03-03", numerator: 2, denominator: 1 })],
      }),
      ["2025-02-10"],
    );
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeNaN();
  });

  it("leaves an entry the loader measured to the basis factor", () => {
    // The same split, measured: before it, the close is restored; after it, withheld until a count
    // observed after its detection.
    const result = ratiosOn(
      inputs({
        verifiedAt: "2025-06-01T00:00:00.000Z",
        splits: [split({ date: "2025-03-03", numerator: 2, denominator: 1 })],
        events: [
          measured({
            effectiveDate: "2025-03-03",
            priceRatio: 2,
            detectedAt: "2025-03-04T12:00:00.000Z",
          }),
        ],
      }),
      ["2025-02-28", "2025-03-03"],
      (date) => (date < "2025-03-03" ? 5 : 5),
    );
    // The stored close 5 before the split was 10 when the count was observed.
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeCloseTo((5 * 2 * 100) / 20, 12);
    expect(result.PRICE_TO_EARNINGS_TTM[1]).toBeNaN();
  });
});

describe("valuation ratios: counts and sessions around events (rules 5–8)", () => {
  it("withholds a count observed in the month after an event for a quarter that ended before it", () => {
    const quarters = QUARTERS.map((quarter) => ({
      ...quarter,
      observedAt: "2025-03-10T00:00:00.000Z",
    }));
    const valuation = (observed: string) =>
      inputs({
        statements: company({
          quarters: quarters.map((quarter) => ({
            ...quarter,
            observedAt: observed,
          })),
        }),
        verifiedAt: "2025-01-01T00:00:00.000Z",
        events: [
          measured({
            effectiveDate: "2025-03-03",
            priceRatio: 2,
            detectedAt: "2025-03-03T12:00:00.000Z",
          }),
        ],
      });
    expect(
      ratiosOn(valuation("2025-03-10T00:00:00.000Z"), ["2025-03-11"])
        .PRICE_TO_EARNINGS_TTM[0],
    ).toBeNaN();
    expect(
      ratiosOn(valuation("2025-04-03T00:00:00.000Z"), ["2025-04-04"])
        .PRICE_TO_EARNINGS_TTM[0],
    ).toBeCloseTo(50, 12);
  });

  it("withholds sessions after a measured possible distribution until statements cover it", () => {
    const quarters: Quarter[] = [
      ...QUARTERS,
      {
        fiscalDate: "2025-03-31",
        fiscalYear: 2025,
        period: "Q1",
        availableFromDate: "2025-05-09",
        observedAt: "2025-05-09T00:00:00.000Z",
      },
    ];
    const valuation = inputs({
      statements: company({ quarters }),
      events: [
        measured({
          effectiveDate: "2025-02-24",
          priceRatio: 1.046,
          detectedAt: "2025-02-25T12:00:00.000Z",
        }),
      ],
    });
    const result = ratiosOn(valuation, [
      "2025-02-21",
      "2025-03-03",
      "2025-05-09",
    ]);
    // Before it: observed before the event, the close is restored by the measured factor.
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeCloseTo(
      (10 * 1.046 * 100) / 20,
      12,
    );
    expect(result.PRICE_TO_EARNINGS_TTM[1]).toBeNaN();
    expect(result.PRICE_TO_EARNINGS_TTM[2]).toBeCloseTo(1000 / 20, 12);
  });

  it("withholds the month after a listed upcoming event the provider has not re-based", () => {
    const valuation = inputs({
      verifiedAt: "2025-02-01T00:00:00.000Z",
      splits: [split({ date: "2025-03-03", numerator: 1, denominator: 10 })],
    });
    const result = ratiosOn(valuation, [
      "2025-02-28",
      "2025-03-03",
      "2025-04-02",
      "2025-04-03",
    ]);
    expect(result.PRICE_TO_EARNINGS_TTM[0]).toBeCloseTo(50, 12);
    expect(result.PRICE_TO_EARNINGS_TTM[1]).toBeNaN();
    expect(result.PRICE_TO_EARNINGS_TTM[2]).toBeNaN();
    // An entry the provider never folds stops holding after thirty days.
    expect(result.PRICE_TO_EARNINGS_TTM[3]).toBeCloseTo(50, 12);
  });
});

/**
 * Each masking rule on its own. The statements are observed on 2026-09-01, long after every event,
 * as in the development store, so rules 4.2, 5 and 6 cannot be what withholds a session.
 */
describe("valuation ratios: each masking rule in isolation", () => {
  const LATE = "2026-09-01T00:00:00.000Z";
  const firstOf2025: Quarter = {
    fiscalDate: "2025-03-31",
    fiscalYear: 2025,
    period: "Q1",
    availableFromDate: "2025-05-09",
  };
  const quarters: Quarter[] = [...QUARTERS, firstOf2025].map((quarter) => ({
    ...quarter,
    observedAt: LATE,
  }));
  const isolated = (overrides: Partial<ValuationInputs>) =>
    inputs({
      statements: company({ quarters }),
      verifiedAt: "2026-10-05T00:00:00.000Z",
      ...overrides,
    });
  // Before the event, after it with the latest quarter ending before it, after a covering quarter.
  const SESSIONS = ["2025-02-21", "2025-03-03", "2025-05-12"];
  const pe = (valuation: ValuationInputs) =>
    ratiosOn(valuation, SESSIONS, 10, ["PRICE_TO_EARNINGS_TTM"])
      .PRICE_TO_EARNINGS_TTM;

  it("rule 4.1: a listed distribution masks every session before it, and after it until covered", () => {
    const masked = pe(
      isolated({
        splits: [
          split({ date: "2025-02-24", numerator: 523, denominator: 500 }),
        ],
      }),
    );
    expect(masked[0]).toBeNaN();
    expect(masked[1]).toBeNaN();
    expect(masked[2]).toBeCloseTo(50, 12);
  });

  it("rule 4.1: a listed plain split masks nothing, before or after it", () => {
    expect(
      pe(
        isolated({
          splits: [split({ date: "2025-02-24", numerator: 2, denominator: 1 })],
        }),
      ),
    ).toEqual([50, 50, 50]);
  });

  it("reads a provider entry's ratio exactly: 999:500 is not a 2:1 split", () => {
    // GOOGL's 2014 class C entry is within 0.1 % of 2:1; only an exact ratio is plain.
    expect(
      pe(
        isolated({
          splits: [
            split({ date: "2025-02-24", numerator: 999, denominator: 500 }),
          ],
        }),
      )[0],
    ).toBeNaN();
  });

  it("reads a plain ratio under any other label as a possible distribution", () => {
    for (const label of ["spin-off", "stock-dividend", null]) {
      expect(
        pe(
          isolated({
            splits: [
              split({
                date: "2025-02-24",
                numerator: 2,
                denominator: 1,
                label,
              }),
            ],
          }),
        )[0],
        String(label),
      ).toBeNaN();
    }
  });

  it("leaves an entry measured within seven days to the measured re-base, and only within seven", () => {
    const entry = split({
      date: "2025-02-24",
      numerator: 523,
      denominator: 500,
    });
    // A plain re-base the loader measured, detected long before the statements were observed.
    const measuredOn = (date: string) =>
      measured({
        effectiveDate: date,
        priceRatio: 2,
        detectedAt: "2025-03-20T12:00:00.000Z",
      });
    expect(
      pe(isolated({ splits: [entry], events: [measuredOn("2025-03-03")] }))[0],
    ).toBeCloseTo(50, 12);
    expect(
      pe(isolated({ splits: [entry], events: [measuredOn("2025-03-04")] }))[0],
    ).toBeNaN();
  });

  it("matches an undated re-base to an entry by the days it may lie on, never its interval's exclusive start", () => {
    const entry = split({
      date: "2025-02-24",
      numerator: 523,
      denominator: 500,
    });
    // A plain re-base measured between two reads lies after `effectiveFrom`, the last session
    // certainly before it, and no later than `effectiveTo`.
    const between = (from: string, to: string) =>
      measured({
        effectiveFrom: from,
        effectiveTo: to,
        priceRatio: 2,
        detectedAt: "2025-03-20T12:00:00.000Z",
      });
    // Starting six days after the entry, its first possible day is the seventh: it is the entry's.
    expect(
      pe(
        isolated({
          splits: [entry],
          events: [between("2025-03-02", "2025-03-05")],
        }),
      )[0],
    ).toBeCloseTo(50, 12);
    // Starting seven days after it, it lies eight or more days away: the entry still masks.
    expect(
      pe(
        isolated({
          splits: [entry],
          events: [between("2025-03-03", "2025-03-05")],
        }),
      )[0],
    ).toBeNaN();
    // And a listed upcoming event keeps its month.
    expect(
      pe(
        isolated({
          splits: [entry],
          verifiedAt: "2025-02-23T09:00:00.000Z",
          events: [between("2025-03-03", "2025-03-05")],
        }),
      )[1],
    ).toBeNaN();
  });

  it("rule 5: a count observed on an undated re-base's exclusive start was observed before it", () => {
    // Measured between 2025-03-03, the last session certainly before it, and 2025-03-05; every
    // quarter first observed on 2025-03-03. The count predates the event: K = 2 restores the close
    // it was observed against, and rule 5, for a count observed on or after an event, does not
    // reach it.
    const observedOnStart = quarters.map((quarter) => ({
      ...quarter,
      observedAt: "2025-03-03T15:00:00.000Z",
    }));
    const value = ratiosOn(
      isolated({
        statements: company({ quarters: observedOnStart }),
        events: [
          measured({
            effectiveFrom: "2025-03-03",
            effectiveTo: "2025-03-05",
            priceRatio: 2,
            detectedAt: "2025-03-20T12:00:00.000Z",
          }),
        ],
      }),
      ["2025-03-03", "2025-03-04"],
      10,
      ["PRICE_TO_EARNINGS_TTM"],
    ).PRICE_TO_EARNINGS_TTM;
    // 10 × 2 × 100 / 20 on the interval's start; inside the interval, withheld.
    expect(value[0]).toBeCloseTo(100, 12);
    expect(value[1]).toBeNaN();
  });

  it("splits history from forward entries at the verification date", () => {
    const entry = split({
      date: "2025-02-24",
      numerator: 523,
      denominator: 500,
    });
    // Listed on or before the verification: history, masking every session before it.
    expect(
      pe(
        isolated({ splits: [entry], verifiedAt: "2025-02-24T09:00:00.000Z" }),
      )[0],
    ).toBeNaN();
    // Listed after it: a forward event, which masks only the month from its date.
    const forward = pe(
      isolated({ splits: [entry], verifiedAt: "2025-02-23T09:00:00.000Z" }),
    );
    expect(forward[0]).toBeCloseTo(50, 12);
    expect(forward[1]).toBeNaN();
    expect(forward[2]).toBeCloseTo(50, 12);
  });

  it("rule 7: after a measured possible distribution, a count observed later waits for a covering quarter", () => {
    const value = pe(
      isolated({
        events: [
          measured({
            effectiveDate: "2025-02-24",
            priceRatio: 1.046,
            detectedAt: "2025-02-25T12:00:00.000Z",
          }),
        ],
      }),
    );
    // Before it: the close carries a factor this count does not follow (rule 6).
    expect(value[0]).toBeNaN();
    // After it, until a quarter ending after it: rule 7 alone.
    expect(value[1]).toBeNaN();
    expect(value[2]).toBeCloseTo(50, 12);
  });

  it("rule 5: applies only to a quarter that ended before the event", () => {
    // Observed nine days after a plain split; the Q1 2025 count is in the company's own new units.
    const soon = quarters.map((quarter) => ({
      ...quarter,
      observedAt: "2025-05-09T00:00:00.000Z",
    }));
    const value = ratiosOn(
      inputs({
        statements: company({ quarters: soon }),
        verifiedAt: "2026-10-05T00:00:00.000Z",
        splits: [split({ date: "2025-04-30", numerator: 2, denominator: 1 })],
      }),
      ["2025-04-29", "2025-05-12"],
      10,
      ["PRICE_TO_BOOK"],
    ).PRICE_TO_BOOK;
    // The Q4 2024 count was observed in the month after the split, for a quarter before it.
    expect(value[0]).toBeNaN();
    // The Q1 2025 count ended before the split as well: still withheld.
    expect(value[1]).toBeNaN();
    // Observed in the month after a split, for a quarter that ended after it: the company reported it
    // in the new units, so rule 5 leaves it.
    const reported: Quarter = {
      fiscalDate: "2025-03-31",
      fiscalYear: 2025,
      period: "Q1",
      availableFromDate: "2025-04-08",
      observedAt: "2025-04-08T00:00:00.000Z",
    };
    expect(
      ratiosOn(
        inputs({
          statements: company({
            quarters: [
              ...QUARTERS.map((quarter) => ({ ...quarter, observedAt: LATE })),
              reported,
            ],
          }),
          verifiedAt: "2026-10-05T00:00:00.000Z",
          splits: [split({ date: "2025-03-20", numerator: 2, denominator: 1 })],
        }),
        ["2025-04-09"],
        10,
        ["PRICE_TO_BOOK"],
      ).PRICE_TO_BOOK[0],
    ).toBeCloseTo(2.5, 12);
  });

  describe("rule 3: a restated count", () => {
    const PREVIOUS = "2025-05-09T00:00:00.000Z";
    /**
     * P/B on 2025-06-23 with every quarter first observed at `previousObservedAt` holding 100 shares,
     * then restated to `shares`, observed 2025-06-20: more than thirty days after every event these
     * cases date before it, so rule 5 is not what withholds it.
     */
    const pb = (
      shares: number,
      events: readonly PriceBasisEvent[],
      previousObservedAt = PREVIOUS,
    ) => {
      const restated = quarters.map((quarter) =>
        statement(
          "INCOME",
          {
            ...quarter,
            availableFromDate: "2025-06-20",
            observedAt: "2025-06-20T00:00:00.000Z",
          },
          {
            weightedAverageShsOutDil: shares,
            netIncome: 5,
            revenue: 50,
            ebitda: 10,
          },
        ),
      );
      const previous = quarters.map((quarter) => ({
        ...quarter,
        observedAt: previousObservedAt,
      }));
      return ratiosOn(
        inputs({
          statements: [...company({ quarters: previous }), ...restated],
          verifiedAt: "2024-01-02T00:00:00.000Z",
          events,
        }),
        ["2025-06-23"],
        10,
        ["PRICE_TO_BOOK"],
      ).PRICE_TO_BOOK[0];
    };
    const twoForOne = (fields: Partial<PriceBasisEvent>) =>
      measured({ priceRatio: 2, ...fields });

    it("is explained only by a re-base new to the previous revision and known by its own", () => {
      // An earlier 2:1 re-base, already behind the previous revision.
      expect(
        pb(200, [
          twoForOne({
            effectiveDate: "2024-03-01",
            detectedAt: "2024-03-02T12:00:00.000Z",
          }),
        ]),
      ).toBeNaN();
      // Dated and detected before the previous revision was observed, if within the month: the
      // provider had re-based the prices already, so that revision may be in the new units.
      expect(
        pb(200, [
          twoForOne({
            effectiveDate: "2025-05-05",
            detectedAt: "2025-05-06T12:00:00.000Z",
          }),
        ]),
      ).toBeNaN();
      // Detected after the restated count was observed: not yet known when it was.
      expect(
        pb(200, [
          twoForOne({
            effectiveDate: "2025-06-24",
            detectedAt: "2025-06-24T12:00:00.000Z",
          }),
        ]),
      ).toBeNaN();
      // New to the previous revision and known by the time of the restated one: explained.
      expect(
        pb(200, [
          twoForOne({
            effectiveDate: "2025-05-12",
            detectedAt: "2025-05-13T12:00:00.000Z",
          }),
        ]),
      ).toBeCloseTo((10 * 200) / 400, 12);
    });

    it("is not explained by an old re-base the first verification measures after the previous revision", () => {
      // A 2:1 split of 2023 that a history mixed before PR 1 still carried, measured by the first
      // verification on 2025-06-01: detected after the previous revision was observed, yet that
      // revision was observed two years after the split, in its new units already.
      expect(
        pb(200, [
          twoForOne({
            effectiveDate: "2023-06-12",
            detectedAt: "2025-06-01T03:00:00.000Z",
          }),
        ]),
      ).toBeNaN();
    });

    it("is new to a revision observed before the session the provider re-based ahead of", () => {
      // The provider re-based the history ahead of the event's first session: PR 1 measures it
      // undated, through the session after the newest stored one — the day after its detection.
      // The previous revision was observed after the detection but before that session.
      expect(
        pb(
          200,
          [
            twoForOne({
              effectiveFrom: "2025-05-12",
              effectiveTo: "2025-05-13",
              detectedAt: "2025-05-12T21:00:00.000Z",
            }),
          ],
          "2025-05-12T22:00:00.000Z",
        ),
      ).toBeCloseTo((10 * 200) / 400, 12);
    });

    it("counts a re-base only while the previous revision may predate its settling", () => {
      // Detected the day after the previous revision was observed, and dated 29 or 30 days before
      // it: a month after a re-base, a revision is taken to be in its new units (rule 5's month).
      const detectedLate = (effectiveDate: string) =>
        pb(200, [
          twoForOne({ effectiveDate, detectedAt: "2025-05-10T12:00:00.000Z" }),
        ]);
      expect(detectedLate("2025-04-10")).toBeCloseTo((10 * 200) / 400, 12);
      expect(detectedLate("2025-04-09")).toBeNaN();
    });

    it("is not explained by a re-base of another ratio", () => {
      expect(
        pb(200, [
          measured({
            effectiveDate: "2025-05-12",
            priceRatio: 3,
            detectedAt: "2025-05-13T12:00:00.000Z",
          }),
        ]),
      ).toBeNaN();
    });

    it("is a restatement only beyond 2 %, judged on the reported figures, not their doubles", () => {
      // 100 restated to exactly 102 or 98 differs by 2 %, not by more: nothing needs explaining,
      // although 102 / 100 - 1 is 0.020000000000000018 in doubles.
      expect(pb(102, [])).toBeCloseTo((10 * 102) / 400, 12);
      expect(pb(98, [])).toBeCloseTo((10 * 98) / 400, 12);
      expect(pb(102.0001, [])).toBeNaN();
      expect(pb(97.9999, [])).toBeNaN();
      // 204 and 196 are exactly 2 % from a measured 2:1 re-base, which explains them; 204.01 is not.
      const split = [
        twoForOne({
          effectiveDate: "2025-05-12",
          detectedAt: "2025-05-13T12:00:00.000Z",
        }),
      ];
      expect(pb(204, split)).toBeCloseTo((10 * 204) / 400, 12);
      expect(pb(196, split)).toBeCloseTo((10 * 196) / 400, 12);
      expect(pb(204.01, split)).toBeNaN();
    });

    describe("its anchor, the latest revision observed before it that rule 3 accepted (owner, 2026-10-06)", () => {
      const previous = quarters.map((quarter) => ({
        ...quarter,
        observedAt: PREVIOUS,
      }));
      /** A revision of `quarter`'s Income, public and observed on `on`. */
      const income = (
        quarter: Quarter,
        on: string,
        values: Record<string, number>,
      ) =>
        statement(
          "INCOME",
          {
            ...quarter,
            availableFromDate: on,
            observedAt: `${on}T00:00:00.000Z`,
          },
          { netIncome: 5, revenue: 50, ebitda: 10, ...values },
        );
      const latestQuarter = quarters.at(-1) as Quarter;
      const pbOn = (
        statements: readonly FinancialStatement[],
        sessions: readonly string[],
        events: readonly PriceBasisEvent[] = [],
      ) =>
        ratiosOn(
          inputs({
            statements,
            verifiedAt: "2024-01-02T00:00:00.000Z",
            events,
          }),
          sessions,
          10,
          ["PRICE_TO_BOOK"],
        ).PRICE_TO_BOOK;

      it("keeps a restatement withheld through a later revision repeating it, until a re-base explains one", () => {
        // Every quarter restated two-fold on 2025-06-20, unexplained; 2025Q1 revised again on
        // 2025-06-25 with the same 200 and another figure. Its anchor is still the original 100.
        const statements = [
          ...company({ quarters: previous }),
          ...quarters.map((quarter) =>
            income(quarter, "2025-06-20", { weightedAverageShsOutDil: 200 }),
          ),
          income(latestQuarter, "2025-06-25", {
            weightedAverageShsOutDil: 200,
            netIncome: 6,
          }),
        ];
        expect(pbOn(statements, ["2025-06-23", "2025-06-26"])).toEqual([
          Number.NaN,
          Number.NaN,
        ]);
        // A 2:1 re-base dated 2025-06-30, detected the next day: both revisions were observed
        // before it was known, so it explains neither; a revision observed after it and after rule
        // 5's month is explained, and read at K = 1 on a session after the event.
        const rebase = [
          twoForOne({
            effectiveDate: "2025-06-30",
            detectedAt: "2025-07-01T12:00:00.000Z",
          }),
        ];
        const later = [
          ...statements,
          income(latestQuarter, "2025-08-04", {
            weightedAverageShsOutDil: 200,
            netIncome: 7,
          }),
        ];
        const read = pbOn(
          later,
          ["2025-06-26", "2025-08-01", "2025-08-04"],
          rebase,
        );
        expect(read[0]).toBeNaN();
        expect(read[1]).toBeNaN();
        expect(read[2]).toBeCloseTo((10 * 200) / 400, 12);
      });

      it("compares a restatement after a revision with no count with the last count", () => {
        const statements = [
          ...company({ quarters: previous }),
          income(latestQuarter, "2025-06-18", {}),
          ...quarters.map((quarter) =>
            income(quarter, "2025-06-20", { weightedAverageShsOutDil: 200 }),
          ),
        ];
        expect(pbOn(statements, ["2025-06-23"])[0]).toBeNaN();
      });

      it("never takes as its anchor a revision observed after it, however early that one is dated", () => {
        // Every quarter restated two-fold on 2025-06-20, before the 2:1 re-base dated 2025-06-30 was
        // detected (2025-07-01). An amendment of 2025Q1 filed earlier — public from 2025-06-18 — was
        // first observed on 2025-07-03, after the detection, with 200: the re-base explains it, but
        // it was observed after the restatement, so it is not the restatement's anchor.
        const statements = [
          ...company({ quarters: previous }),
          ...quarters.map((quarter) =>
            income(quarter, "2025-06-20", { weightedAverageShsOutDil: 200 }),
          ),
          statement(
            "INCOME",
            {
              ...latestQuarter,
              availableFromDate: "2025-06-18",
              observedAt: "2025-07-03T00:00:00.000Z",
            },
            {
              weightedAverageShsOutDil: 200,
              netIncome: 6,
              revenue: 50,
              ebitda: 10,
            },
          ),
        ];
        const rebase = [
          twoForOne({
            effectiveDate: "2025-06-30",
            detectedAt: "2025-07-01T12:00:00.000Z",
          }),
        ];
        expect(pbOn(statements, ["2025-06-23"], rebase)[0]).toBeNaN();
      });

      it("judges a re-base new to the anchor, not to a withheld revision observed in between", () => {
        // A 2:1 re-base dated 2025-05-12, detected 2025-05-13. 2025Q1 revised on 2025-06-20 to 130:
        // unexplained, so withheld and no anchor. Every quarter restated to 200 on 2025-07-01: the
        // re-base is new to the anchor (the original 100, observed 2025-05-09), though not to the
        // 130, and explains it. Observed after the detection, on a session after the event: K = 1.
        const statements = [
          ...company({ quarters: previous }),
          income(latestQuarter, "2025-06-20", {
            weightedAverageShsOutDil: 130,
          }),
          ...quarters.map((quarter) =>
            income(quarter, "2025-07-01", { weightedAverageShsOutDil: 200 }),
          ),
        ];
        const rebase = [
          twoForOne({
            effectiveDate: "2025-05-12",
            detectedAt: "2025-05-13T12:00:00.000Z",
          }),
        ];
        expect(pbOn(statements, ["2025-07-02"], rebase)[0]).toBeCloseTo(
          (10 * 200) / 400,
          12,
        );
      });

      it("reads a restatement the provider took back against the anchor", () => {
        // 2025Q1 alone restated to 200 on 2025-06-20, then back to 100 on 2025-06-25: the 200 was
        // never accepted, so the 100 is compared with the original 100.
        const statements = [
          ...company({ quarters: previous }),
          income(latestQuarter, "2025-06-20", {
            weightedAverageShsOutDil: 200,
          }),
          income(latestQuarter, "2025-06-25", {
            weightedAverageShsOutDil: 100,
            netIncome: 6,
          }),
        ];
        const read = pbOn(statements, ["2025-06-23", "2025-06-26"]);
        expect(read[0]).toBeNaN();
        expect(read[1]).toBeCloseTo((10 * 100) / 400, 12);
      });
    });

    it("needs a re-base even when it is too small for the share level to notice", () => {
      // An 11:10 stock dividend restated with no re-base behind it: within rule 2's 25 %.
      expect(pb(110, [])).toBeNaN();
      // A 5:4 split the loader measured: explained.
      expect(
        pb(125, [
          measured({
            effectiveDate: "2025-05-12",
            priceRatio: 1.25,
            detectedAt: "2025-05-13T12:00:00.000Z",
          }),
        ]),
      ).toBeCloseTo((10 * 125) / 400, 12);
    });
  });

  it("rule 7: an undated possible distribution counts from the latest date it may have", () => {
    const after = (event: PriceBasisEvent) =>
      ratiosOn(isolated({ events: [event] }), ["2025-05-12"], 10, [
        "PRICE_TO_EARNINGS_TTM",
      ]).PRICE_TO_EARNINGS_TTM[0];
    // Dated 2025-03-20: the Q1 2025 quarter, ending 2025-03-31, covers it.
    expect(
      after(
        measured({
          effectiveDate: "2025-03-20",
          priceRatio: 1.046,
          detectedAt: "2025-04-11T12:00:00.000Z",
        }),
      ),
    ).toBeCloseTo(50, 12);
    // Somewhere after 2025-03-20 and no later than 2025-04-10: Q1 2025 may end before it.
    expect(
      after(
        measured({
          effectiveFrom: "2025-03-20",
          effectiveTo: "2025-04-10",
          priceRatio: 1.046,
          detectedAt: "2025-04-11T12:00:00.000Z",
        }),
      ),
    ).toBeNaN();
  });

  it("rules 4.1 and 7: a quarter ending on the event's own date covers it", () => {
    const quarterEnd = "2025-03-31";
    const listed = pe(
      isolated({
        splits: [split({ date: quarterEnd, numerator: 523, denominator: 500 })],
      }),
    );
    expect(listed[1]).toBeNaN();
    expect(listed[2]).toBeCloseTo(50, 12);
    const measuredThere = pe(
      isolated({
        events: [
          measured({
            effectiveDate: quarterEnd,
            priceRatio: 1.046,
            detectedAt: "2025-04-01T12:00:00.000Z",
          }),
        ],
      }),
    );
    expect(measuredThere[2]).toBeCloseTo(50, 12);
  });

  it("rules 4.2 and 5: a count observed on an event's own date is rule 5's", () => {
    // A plain split listed in the history and never measured, on 2025-03-03.
    const splits = [
      split({ date: "2025-03-03", numerator: 2, denominator: 1 }),
    ];
    const observedOn = (date: string, quarterList: readonly Quarter[]) =>
      quarterList.map((quarter) => ({
        ...quarter,
        observedAt: `${date}T20:00:00.000Z`,
      }));
    // Observed on the split's date for a quarter that ended before it: rule 5 withholds it, from
    // that very date.
    expect(
      ratiosOn(
        isolated({
          statements: company({ quarters: observedOn("2025-03-03", quarters) }),
          splits,
        }),
        ["2025-03-04"],
        10,
        ["PRICE_TO_EARNINGS_TTM"],
      ).PRICE_TO_EARNINGS_TTM[0],
    ).toBeNaN();
    // Observed on the split's date for a quarter that ended on it: no rule withholds it. Rule 4.2
    // reaches only a count observed before the date.
    const onTheDate: Quarter[] = observedOn("2025-03-31", [
      ...QUARTERS,
      { ...firstOf2025, availableFromDate: "2025-03-31" },
    ]);
    expect(
      ratiosOn(
        isolated({
          statements: company({ quarters: onTheDate }),
          splits: [split({ date: "2025-03-31", numerator: 2, denominator: 1 })],
        }),
        ["2025-04-01"],
        10,
        ["PRICE_TO_EARNINGS_TTM"],
      ).PRICE_TO_EARNINGS_TTM[0],
    ).toBeCloseTo(50, 12);
  });

  it("rule 2: a count needs three consecutive agreeing quarters, each with a count", () => {
    const eight: Quarter[] = [
      ...QUARTERS.map((quarter) => ({
        ...quarter,
        fiscalYear: 2023,
        fiscalDate: quarter.fiscalDate.replace("2024", "2023"),
        availableFromDate: quarter.availableFromDate
          .replace(/^2024/, "2023")
          .replace(/^2025/, "2024"),
      })),
      ...QUARTERS,
    ].map((quarter) => ({ ...quarter, observedAt: LATE }));
    const pb = (
      shares: (index: number) => number,
      dropped: readonly number[] = [],
    ) =>
      ratiosOn(
        inputs({
          statements: company({ quarters: eight, shares }).filter(
            (row) =>
              row.statementType !== "INCOME" ||
              !dropped.includes(
                eight.findIndex(
                  (quarter) => quarter.fiscalDate === row.fiscalDate,
                ),
              ),
          ),
          verifiedAt: "2026-10-05T00:00:00.000Z",
        }),
        ["2025-02-10"],
        10,
        ["PRICE_TO_BOOK"],
      ).PRICE_TO_BOOK[0];
    // 100 ×5, then 200, 300, 400: each outside the one before, so none is a level.
    expect(
      pb((index) => [100, 100, 100, 100, 100, 200, 300, 400][index]!),
    ).toBeNaN();
    // 100 ×4, then 200, a quarter with no usable count, 200, 200: the agreement starts again.
    expect(
      pb((index) => [100, 100, 100, 100, 200, 0, 200, 200][index]!),
    ).toBeNaN();
    // 100 ×4, then 200, a missing quarter, 200, 200: likewise.
    expect(pb((index) => (index < 4 ? 100 : 200), [5])).toBeNaN();
    // 100 ×4, then 200 ×4: accepted on the third.
    expect(pb((index) => (index < 4 ? 100 : 200))).toBeCloseTo(
      (10 * 200) / 400,
      12,
    );
    // 100 ×4, then 20 % more each quarter: each count within 25 % of the one before, so the level
    // follows every accepted count, although the last is more than twice the first.
    expect(
      pb((index) => (index < 4 ? 100 : 100 * 1.2 ** (index - 3))),
    ).toBeCloseTo((10 * 100 * 1.2 ** 4) / 400, 12);
  });

  it("rule 2: confirms the walk's first count like any new level (owner, 2026-10-06)", () => {
    // Quarters public 2024-05-10, 2024-08-09, 2024-11-09, 2025-02-09 and 2025-05-09.
    const sessions = ["2024-05-10", "2024-08-09", "2024-11-11", "2025-02-10"];
    const pb = (shares?: (index: number) => number) =>
      ratiosOn(
        inputs({
          statements: company({ quarters, shares }),
          verifiedAt: "2026-10-05T00:00:00.000Z",
        }),
        sessions,
        10,
        ["PRICE_TO_BOOK"],
      ).PRICE_TO_BOOK;
    // A steady first count: the first two quarters wait, the third sets the level.
    const steady = pb();
    expect(steady[0]).toBeNaN();
    expect(steady[1]).toBeNaN();
    expect(steady[2]).toBeCloseTo((10 * 100) / 400, 12);
    // A listing quarter's 60 the next quarter contradicts is never read; 100 is the level from the
    // third quarter agreeing with it.
    const listing = pb((index) => (index === 0 ? 60 : 100));
    expect(listing.slice(0, 3).every(Number.isNaN)).toBe(true);
    expect(listing[3]).toBeCloseTo((10 * 100) / 400, 12);
  });

  it("rule 2: judges the 25 % band on the reported counts, not their doubles", () => {
    const eight: Quarter[] = [
      ...QUARTERS.map((quarter) => ({
        ...quarter,
        fiscalYear: 2023,
        fiscalDate: quarter.fiscalDate.replace("2024", "2023"),
        availableFromDate: quarter.availableFromDate
          .replace(/^2024/, "2023")
          .replace(/^2025/, "2024"),
      })),
      ...QUARTERS,
    ].map((quarter) => ({ ...quarter, observedAt: LATE }));
    // 1.1 for six quarters, 0.825 in 2024Q3 — exactly 25 % below, although 0.825 / 1.1 - 1 is
    // -0.2500000000000001 in doubles — then 1.1 again in 2024Q4, a third above the new level.
    const counts = [1.1, 1.1, 1.1, 1.1, 1.1, 1.1, 0.825, 1.1];
    const pb = ratiosOn(
      inputs({
        statements: company({
          quarters: eight,
          shares: (index) => counts[index]!,
        }),
        verifiedAt: "2026-10-05T00:00:00.000Z",
      }),
      ["2024-11-11", "2025-02-10"],
      10,
      ["PRICE_TO_BOOK"],
    ).PRICE_TO_BOOK;
    // 0.825 is inside the band: accepted, and the new level.
    expect(pb[0]).toBeCloseTo((10 * 0.825) / 400, 12);
    // 1.1 is outside the band of 0.825: withheld, never read against the level the walk left.
    expect(pb[1]).toBeNaN();
  });
});

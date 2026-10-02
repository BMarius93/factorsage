/**
 * The Valuation Ratios V1 audit's backtest anchor: one invented security whose stored rows put
 * every valuation rule on a known stretch of five years, so a backtest's trades can be held, session
 * by session, to the independent reference (`docs/valuation-ratios-audit/REPORT.md`, Backtest).
 *
 * Deliberately free of workspace imports, like `./fundamental-audit`: the API audit (which computes
 * the reference trades from these rows with its clean-room oracle) and the worker (which runs the
 * real `BacktestProcessor` over the same rows in PostgreSQL) both read it, and neither may import
 * the other. The expected trades below are the reference's, checked by the API audit against the
 * oracle and by the worker against the product.
 *
 * The rows are the **stored** rows — availability and observation instants included — so both
 * sides read exactly the same inputs, with no loader rule between them.
 *
 * The stretches, in session order:
 *
 * - **2021-01-04 to 2021-08-10: masked by a listed distribution.** A 131:125 `stock-split` entry on
 *   2021-06-03 (an Organon-like factor), in the history the loader verified: every ratio waits for
 *   statements whose period ends on or after it — 2021Q2's, public on 2021-08-11 (rule 4.1).
 * - **2022-08-11 to 2023-08-10: no P/E.** 2022Q2 reports a loss of 3,000, so net income over the
 *   trailing year is negative while it is in the window; P/S, P/B and the rest read on.
 * - **2023-11-13 to 2024-03-01: negative EV/EBITDA.** 2023Q3's balance sheet (public from
 *   Saturday 2023-11-11) holds net cash of 40,000, more than the market capitalisation, until
 *   2023Q4's (public from Saturday 2024-03-02).
 * - **2024-09-16: a measured 2:1 split.** The stored closes are the re-based ones, and counts
 *   observed before the detection read them through the basis factor 2 before the event. The
 *   provider restated the last eight quarters' counts to the new units on 2024-09-20, explained by
 *   the re-base; the count observed then is still within 30 days after the event for a quarter that
 *   ended before it (rule 5), so every ratio is withheld from 2024-09-16 until 2024Q3's statements,
 *   public on 2024-11-11.
 * - **2025-05-12 to 2025-08-08: a one-quarter share artefact.** 2025Q1 reports 2.5 times the count;
 *   it is withheld until 2025Q2, back at the level, is public on 2025-08-11 (rule 2).
 * - **2025-11-03 to the end: a listed upcoming reverse split.** A 1:2 entry dated after the
 *   verification (2025-10-15), never measured: the month from its date is withheld (rule 8), and
 *   2025Q3's count, first observed on 2025-11-11 — eight days after the event, for a quarter that
 *   ended before it — is withheld from then on (rule 5).
 */

export type ValuationAuditStatement = {
  statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
  fiscalDate: string;
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4";
  reportedCurrency: string;
  filingDate: string;
  availableFromDate: string;
  observedAt: string;
  contentHash: string;
  values: Readonly<Record<string, number>>;
};

export type ValuationAuditSession = {
  date: string;
  /** The stored (re-based) close, as `DECIMAL(20,8)` text. */
  close: string;
  volume: number;
};

export const VALUATION_AUDIT_CURRENCY = "USD";
export const VALUATION_AUDIT_FIRST_SESSION = "2021-01-04";
export const VALUATION_AUDIT_LAST_SESSION = "2025-12-31";
export const VALUATION_AUDIT_VERIFIED_AT = "2025-10-15T00:00:00.000Z";

export const VALUATION_AUDIT_SPLITS = [
  {
    date: "2021-06-03",
    numerator: 131,
    denominator: 125,
    label: "stock-split",
  },
  { date: "2025-11-03", numerator: 1, denominator: 2, label: "stock-split" },
] as const;

export const VALUATION_AUDIT_EVENTS = [
  {
    kind: "MEASURED",
    effectiveDate: "2024-09-16",
    priceRatio: 2,
    detectedAt: "2024-09-17T06:00:00.000Z",
  },
] as const;

/** NYSE closures 2021-2025. */
export const VALUATION_AUDIT_HOLIDAYS: readonly string[] = [
  "2021-01-01",
  "2021-01-18",
  "2021-02-15",
  "2021-04-02",
  "2021-05-31",
  "2021-07-05",
  "2021-09-06",
  "2021-11-25",
  "2021-12-24",
  "2022-01-17",
  "2022-02-21",
  "2022-04-15",
  "2022-05-30",
  "2022-06-20",
  "2022-07-04",
  "2022-09-05",
  "2022-11-24",
  "2022-12-26",
  "2023-01-02",
  "2023-01-16",
  "2023-02-20",
  "2023-04-07",
  "2023-05-29",
  "2023-06-19",
  "2023-07-04",
  "2023-09-04",
  "2023-11-23",
  "2023-12-25",
  "2024-01-01",
  "2024-01-15",
  "2024-02-19",
  "2024-03-29",
  "2024-05-27",
  "2024-06-19",
  "2024-07-04",
  "2024-09-02",
  "2024-11-28",
  "2024-12-25",
  "2025-01-01",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
];

const DAY = 86_400_000;

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY)
    .toISOString()
    .slice(0, 10);
}

/** Every session of the anchor: weekdays from the first to the last session, closures removed. */
export function valuationAuditSessions(): ValuationAuditSession[] {
  const holidays = new Set(VALUATION_AUDIT_HOLIDAYS);
  const sessions: ValuationAuditSession[] = [];
  for (
    let date = VALUATION_AUDIT_FIRST_SESSION;
    date <= VALUATION_AUDIT_LAST_SESSION;
    date = addDays(date, 1)
  ) {
    const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (day === 0 || day === 6 || holidays.has(date)) {
      continue;
    }
    const index = sessions.length;
    // Two waves and a slow drift, so every threshold below is crossed many times, in both
    // directions, on and off the withheld stretches.
    const close =
      40 + 12 * Math.sin(index / 37) + 6 * Math.sin(index / 11) + index * 0.004;
    sessions.push({
      date,
      close: close.toFixed(2),
      // A volume spike every 23rd session, for Relative Volume.
      volume: index % 23 === 0 ? 3_000_000 : 1_000_000,
    });
  }
  return sessions;
}

type QuarterPlan = {
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4";
  fiscalDate: string;
  filingDate: string;
  availableFromDate: string;
};

/** Calendar quarters 2019Q1 to 2025Q3, each filed 41 days after it ends (Q4: 61). */
function quarterPlans(): QuarterPlan[] {
  const plans: QuarterPlan[] = [];
  const ends = ["03-31", "06-30", "09-30", "12-31"] as const;
  for (let year = 2019; year <= 2025; year += 1) {
    for (let quarter = 0; quarter < 4; quarter += 1) {
      if (year === 2025 && quarter === 3) {
        break;
      }
      const fiscalDate = `${year}-${ends[quarter]}`;
      const filingDate = addDays(fiscalDate, quarter === 3 ? 61 : 41);
      plans.push({
        fiscalYear: year,
        period: `Q${quarter + 1}` as QuarterPlan["period"],
        fiscalDate,
        filingDate,
        availableFromDate: addDays(filingDate, 1),
      });
    }
  }
  return plans;
}

/** Quarters first observed by the initial load (2021-01-02), and later ones observed when filed. */
const INITIAL_LOAD = "2021-01-02T12:00:00.000Z";
const RESTATED_AT = "2024-09-20T13:00:00.000Z";

/** Every stored statement revision of the anchor, originals and the post-split restatements. */
export function valuationAuditStatements(): ValuationAuditStatement[] {
  const statements: ValuationAuditStatement[] = [];
  const plans = quarterPlans();
  plans.forEach((plan, index) => {
    const key = `${plan.fiscalYear}${plan.period}`;
    const observedAt =
      plan.availableFromDate <= "2021-01-02"
        ? INITIAL_LOAD
        : `${plan.availableFromDate}T12:00:00.000Z`;
    const afterSplit = plan.fiscalDate >= "2024-09-30";
    const shares = key === "2025Q1" ? 500 : afterSplit ? 200 : 100;
    const revenue = Math.round(2_000 * 1.01 ** index);
    const income = {
      revenue,
      netIncome: key === "2022Q2" ? -3_000 : Math.round(revenue * 0.1),
      ebitda: Math.round(revenue * 0.2),
      weightedAverageShsOutDil: shares,
      weightedAverageShsOut: shares,
    };
    const balance = {
      totalStockholdersEquity: 10_000 + 100 * index,
      netDebt: key === "2023Q3" ? -40_000 : 3_000,
    };
    const cash = {
      operatingCashFlow: Math.round(revenue * 0.15),
      capitalExpenditure: -Math.round(revenue * 0.05),
    };
    for (const [statementType, values] of [
      ["INCOME", income],
      ["BALANCE_SHEET", balance],
      ["CASH_FLOW", cash],
    ] as const) {
      statements.push({
        statementType,
        fiscalDate: plan.fiscalDate,
        fiscalYear: plan.fiscalYear,
        period: plan.period,
        reportedCurrency: VALUATION_AUDIT_CURRENCY,
        filingDate: plan.filingDate,
        availableFromDate: plan.availableFromDate,
        observedAt,
        contentHash: `valuation-audit:${statementType}:${key}:original`,
        values,
      });
    }
    // The provider restated the eight quarters before the split to its new units, after it
    // re-based the prices and after the loader detected it.
    if (plan.fiscalDate >= "2022-09-30" && plan.fiscalDate <= "2024-06-30") {
      statements.push({
        statementType: "INCOME",
        fiscalDate: plan.fiscalDate,
        fiscalYear: plan.fiscalYear,
        period: plan.period,
        reportedCurrency: VALUATION_AUDIT_CURRENCY,
        filingDate: plan.filingDate,
        availableFromDate: RESTATED_AT.slice(0, 10),
        observedAt: RESTATED_AT,
        contentHash: `valuation-audit:INCOME:${key}:restated`,
        values: {
          ...income,
          weightedAverageShsOutDil: shares * 2,
          weightedAverageShsOut: shares * 2,
        },
      });
    }
  });
  return statements;
}

/** One backtest of the anchor: a Strategy definition (schema version 2) and its run inputs. */
export type ValuationAuditBacktest = {
  id: string;
  title: string;
  definition: Record<string, unknown>;
  /** CUSTOM BUY windows, or none for FULL. */
  buyWindows: readonly { startDate: string; endDate: string | null }[];
};

const valuation = (ratioId: string) => ({ kind: "VALUATION_RATIO", ratioId });
const multiple = (value: number) => ({ kind: "MULTIPLE", value });
const condition = (
  id: string,
  metric: Record<string, unknown>,
  operator: "IS_ABOVE" | "IS_BELOW",
  value: Record<string, unknown>,
) => ({ id, metric, operator, value });
const signal = (...conditions: Record<string, unknown>[]) => ({ conditions });
const buyOnly = (buy: Record<string, unknown>) => ({
  schemaVersion: 2,
  buyLevels: [{ id: "b1", percentage: 100, signal: buy }],
  sellLevels: [],
  finalExit: null,
});
const roundTrip = (
  buy: Record<string, unknown>,
  exit: Record<string, unknown>,
) => ({
  schemaVersion: 2,
  buyLevels: [{ id: "b1", percentage: 100, signal: buy }],
  sellLevels: [],
  finalExit: { id: "x1", rules: [{ id: "r1", signal: exit }] },
});

export const VALUATION_AUDIT_BACKTESTS: readonly ValuationAuditBacktest[] = [
  {
    id: "V01",
    title:
      "P/E below 9 buys, P/E above 12 exits (valuation in BUY and FINAL EXIT)",
    definition: roundTrip(
      signal(
        condition(
          "c1",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_BELOW",
          multiple(9),
        ),
      ),
      signal(
        condition(
          "c2",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_ABOVE",
          multiple(12),
        ),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V02",
    title: "P/S below 0.9 buys, above 1.2 exits",
    definition: roundTrip(
      signal(
        condition(
          "c1",
          valuation("PRICE_TO_SALES_TTM"),
          "IS_BELOW",
          multiple(0.9),
        ),
      ),
      signal(
        condition(
          "c2",
          valuation("PRICE_TO_SALES_TTM"),
          "IS_ABOVE",
          multiple(1.2),
        ),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V03",
    title: "P/B below 0.55 buys, above 0.8 exits",
    definition: roundTrip(
      signal(
        condition("c1", valuation("PRICE_TO_BOOK"), "IS_BELOW", multiple(0.55)),
      ),
      signal(
        condition("c2", valuation("PRICE_TO_BOOK"), "IS_ABOVE", multiple(0.8)),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V04",
    title: "P/FCF below 7 buys, above 10 exits",
    definition: roundTrip(
      signal(
        condition("c1", valuation("PRICE_TO_FCF_TTM"), "IS_BELOW", multiple(7)),
      ),
      signal(
        condition(
          "c2",
          valuation("PRICE_TO_FCF_TTM"),
          "IS_ABOVE",
          multiple(10),
        ),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V05",
    title: "EV/EBITDA below 0 buys (only on net cash), above 4 exits",
    definition: roundTrip(
      signal(
        condition("c1", valuation("EV_TO_EBITDA_TTM"), "IS_BELOW", multiple(0)),
      ),
      signal(
        condition("c2", valuation("EV_TO_EBITDA_TTM"), "IS_ABOVE", multiple(4)),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V06",
    title:
      "P/E below 1,000,000: true whenever available, so it buys on the first available session",
    definition: buyOnly(
      signal(
        condition(
          "c1",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_BELOW",
          multiple(1_000_000),
        ),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V07",
    title: "P/E below 10 AND P/B below 0.7 buys; P/E above 12 exits",
    definition: roundTrip(
      signal(
        condition(
          "c1",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_BELOW",
          multiple(10),
        ),
        condition("c2", valuation("PRICE_TO_BOOK"), "IS_BELOW", multiple(0.7)),
      ),
      signal(
        condition(
          "c3",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_ABOVE",
          multiple(12),
        ),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V08",
    title: "P/S below 1 AND Net Margin TTM above 5 % (valuation + Fundamental)",
    definition: roundTrip(
      signal(
        condition(
          "c1",
          valuation("PRICE_TO_SALES_TTM"),
          "IS_BELOW",
          multiple(1),
        ),
        condition(
          "c2",
          { kind: "FUNDAMENTAL", metricId: "NET_MARGIN_TTM" },
          "IS_ABOVE",
          {
            kind: "PERCENT",
            value: 5,
          },
        ),
      ),
      signal(
        condition(
          "c3",
          valuation("PRICE_TO_SALES_TTM"),
          "IS_ABOVE",
          multiple(1.2),
        ),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V09",
    title: "P/E below 11 AND price above SMA 50D (valuation + moving average)",
    definition: roundTrip(
      signal(
        condition(
          "c1",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_BELOW",
          multiple(11),
        ),
        condition("c2", { kind: "PRICE" }, "IS_ABOVE", {
          kind: "SERIES",
          seriesId: "SMA_50D",
        }),
      ),
      signal(
        condition(
          "c3",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_ABOVE",
          multiple(12),
        ),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V10",
    title: "P/B below 0.75 AND RVOL 20 above 2 (valuation + Relative Volume)",
    definition: roundTrip(
      signal(
        condition("c1", valuation("PRICE_TO_BOOK"), "IS_BELOW", multiple(0.75)),
        condition(
          "c2",
          { kind: "RELATIVE_VOLUME", period: 20 },
          "IS_ABOVE",
          multiple(2),
        ),
      ),
      signal(
        condition("c3", valuation("PRICE_TO_BOOK"), "IS_ABOVE", multiple(0.85)),
      ),
    ),
    buyWindows: [],
  },
  {
    id: "V11",
    title:
      "P/E below 9 inside a CUSTOM membership 2023-01-01 to 2024-06-30 (valuation + buy window)",
    definition: roundTrip(
      signal(
        condition(
          "c1",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_BELOW",
          multiple(9),
        ),
      ),
      signal(
        condition(
          "c2",
          valuation("PRICE_TO_EARNINGS_TTM"),
          "IS_ABOVE",
          multiple(12),
        ),
      ),
    ),
    buyWindows: [{ startDate: "2023-01-01", endDate: "2024-06-30" }],
  },
  {
    id: "V12",
    title:
      "P/S below 0.95 buys 50 %, P/S above 1.1 sells 50 % (valuation in SELL), P/S above 1.3 exits",
    definition: {
      schemaVersion: 2,
      buyLevels: [
        {
          id: "b1",
          percentage: 50,
          signal: signal(
            condition(
              "c1",
              valuation("PRICE_TO_SALES_TTM"),
              "IS_BELOW",
              multiple(0.95),
            ),
          ),
        },
      ],
      sellLevels: [
        {
          id: "s1",
          percentage: 50,
          signal: signal(
            condition(
              "c2",
              valuation("PRICE_TO_SALES_TTM"),
              "IS_ABOVE",
              multiple(1.1),
            ),
          ),
        },
      ],
      finalExit: {
        id: "x1",
        rules: [
          {
            id: "r1",
            signal: signal(
              condition(
                "c3",
                valuation("PRICE_TO_SALES_TTM"),
                "IS_ABOVE",
                multiple(1.3),
              ),
            ),
          },
        ],
      },
    },
    buyWindows: [],
  },
];

/**
 * The reference's trades for each anchor backtest: `[date, action, levelId]`, in order, Strategy
 * trades only. Computed by the API audit from the rows above with the clean-room valuation oracle
 * and the reference backtester (`valuation-backtest-reference.test.ts` pins them), and asserted
 * against the real `BacktestProcessor` by the worker's audit suite.
 */
export const VALUATION_AUDIT_EXPECTED_TRADES: Readonly<
  Record<string, readonly (readonly [string, string, string])[]>
> = {
  V01: [
    ["2021-08-11", "BUY", "b1"],
    ["2022-02-08", "FINAL_EXIT", "x1"],
    ["2022-06-23", "BUY", "b1"],
    ["2024-01-18", "FINAL_EXIT", "x1"],
    ["2024-03-14", "BUY", "b1"],
    ["2024-11-19", "FINAL_EXIT", "x1"],
    ["2025-03-26", "BUY", "b1"],
  ],
  V02: [
    ["2021-08-11", "BUY", "b1"],
    ["2022-02-08", "FINAL_EXIT", "x1"],
    ["2022-06-23", "BUY", "b1"],
    ["2022-12-16", "FINAL_EXIT", "x1"],
    ["2023-05-04", "BUY", "b1"],
    ["2024-01-18", "FINAL_EXIT", "x1"],
    ["2024-03-14", "BUY", "b1"],
    ["2024-11-18", "FINAL_EXIT", "x1"],
    ["2025-03-26", "BUY", "b1"],
  ],
  V03: [
    ["2021-09-08", "BUY", "b1"],
    ["2021-11-22", "FINAL_EXIT", "x1"],
    ["2022-07-13", "BUY", "b1"],
    ["2022-12-01", "FINAL_EXIT", "x1"],
    ["2023-05-22", "BUY", "b1"],
    ["2023-10-13", "FINAL_EXIT", "x1"],
    ["2024-06-07", "BUY", "b1"],
    ["2024-11-11", "FINAL_EXIT", "x1"],
    ["2025-04-16", "BUY", "b1"],
    ["2025-09-11", "FINAL_EXIT", "x1"],
  ],
  V04: [
    ["2021-09-08", "BUY", "b1"],
    ["2021-11-19", "FINAL_EXIT", "x1"],
    ["2022-07-13", "BUY", "b1"],
    ["2022-11-30", "FINAL_EXIT", "x1"],
    ["2023-05-19", "BUY", "b1"],
    ["2023-10-13", "FINAL_EXIT", "x1"],
    ["2024-06-06", "BUY", "b1"],
    ["2024-11-11", "FINAL_EXIT", "x1"],
    ["2025-04-14", "BUY", "b1"],
    ["2025-09-12", "FINAL_EXIT", "x1"],
  ],
  V05: [
    ["2023-11-13", "BUY", "b1"],
    ["2024-03-04", "FINAL_EXIT", "x1"],
  ],
  V06: [["2021-08-11", "BUY", "b1"]],
  V07: [
    ["2021-08-11", "BUY", "b1"],
    ["2022-02-08", "FINAL_EXIT", "x1"],
    ["2022-06-24", "BUY", "b1"],
    ["2024-01-18", "FINAL_EXIT", "x1"],
    ["2024-03-18", "BUY", "b1"],
    ["2024-11-19", "FINAL_EXIT", "x1"],
    ["2025-03-31", "BUY", "b1"],
  ],
  V08: [
    ["2021-08-11", "BUY", "b1"],
    ["2022-02-08", "FINAL_EXIT", "x1"],
    ["2022-04-14", "BUY", "b1"],
    ["2022-12-16", "FINAL_EXIT", "x1"],
    ["2023-08-11", "BUY", "b1"],
    ["2024-01-18", "FINAL_EXIT", "x1"],
    ["2024-03-06", "BUY", "b1"],
    ["2024-11-18", "FINAL_EXIT", "x1"],
    ["2025-01-14", "BUY", "b1"],
  ],
  V09: [
    ["2021-08-11", "BUY", "b1"],
    ["2022-02-08", "FINAL_EXIT", "x1"],
    ["2022-06-08", "BUY", "b1"],
    ["2024-01-18", "FINAL_EXIT", "x1"],
    ["2024-05-09", "BUY", "b1"],
    ["2024-11-19", "FINAL_EXIT", "x1"],
    ["2025-03-07", "BUY", "b1"],
  ],
  V10: [
    ["2021-08-24", "BUY", "b1"],
    ["2022-01-27", "FINAL_EXIT", "x1"],
    ["2022-06-21", "BUY", "b1"],
    ["2022-12-06", "FINAL_EXIT", "x1"],
    ["2023-05-19", "BUY", "b1"],
    ["2023-10-19", "FINAL_EXIT", "x1"],
    ["2024-03-18", "BUY", "b1"],
    ["2024-11-11", "FINAL_EXIT", "x1"],
    ["2025-03-21", "BUY", "b1"],
    ["2025-09-17", "FINAL_EXIT", "x1"],
  ],
  V11: [
    ["2023-08-11", "BUY", "b1"],
    ["2024-01-18", "FINAL_EXIT", "x1"],
    ["2024-03-14", "BUY", "b1"],
    ["2024-11-19", "FINAL_EXIT", "x1"],
  ],
  V12: [
    ["2021-08-11", "BUY", "b1"],
    ["2022-01-28", "SELL", "s1"],
    ["2022-02-17", "FINAL_EXIT", "x1"],
    ["2022-04-22", "BUY", "b1"],
    ["2022-12-08", "SELL", "s1"],
  ],
};

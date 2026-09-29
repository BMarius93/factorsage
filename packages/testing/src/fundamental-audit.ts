/**
 * The Fundamental Metrics V1 audit's own statement of what the fifteen metrics are.
 *
 * Copied by hand from the Scope table of `docs/decisions/fundamental-metrics-v1.md` (identity,
 * storage field and unit, in the table's order) and from the identity list of
 * `docs/decisions/fundamental-metrics-storage-and-evaluation.md`. It is deliberately **not** read
 * from `FUNDAMENTAL_METRICS` (`@intrinsic/domain`) or `FUNDAMENTAL_METRIC_CATALOG`
 * (`@intrinsic/contracts`): the audit checks those registries, and an expectation derived from them
 * would agree with every mapping defect it exists to find — ROIC reading ROE's column, a storage
 * field used as an identity, a sixteenth metric that one layer never heard of.
 *
 * Every surface that knows the metrics is held to this list, in order, by the audit's identity
 * parity suite; a metric added anywhere without being added here fails there by name.
 *
 * Deliberately free of workspace imports, like `./qa-fundamentals`, so the Playwright harness and
 * the web app's tests can read it without the domain or database layers.
 */

export type FundamentalAuditUnit = "PERCENT" | "MULTIPLE";

export type FundamentalAuditMetric = {
  readonly id: string;
  readonly field: string;
  readonly unit: FundamentalAuditUnit;
};

export const FUNDAMENTAL_AUDIT_METRICS = [
  {
    id: "REVENUE_GROWTH_TTM_YOY",
    field: "revenueGrowthTtmYoy",
    unit: "PERCENT",
  },
  { id: "EPS_GROWTH_TTM_YOY", field: "epsGrowthTtmYoy", unit: "PERCENT" },
  { id: "FCF_GROWTH_TTM_YOY", field: "fcfGrowthTtmYoy", unit: "PERCENT" },
  { id: "GROSS_MARGIN_TTM", field: "grossMarginTtm", unit: "PERCENT" },
  { id: "OPERATING_MARGIN_TTM", field: "operatingMarginTtm", unit: "PERCENT" },
  { id: "NET_MARGIN_TTM", field: "netMarginTtm", unit: "PERCENT" },
  { id: "FCF_MARGIN_TTM", field: "fcfMarginTtm", unit: "PERCENT" },
  { id: "ROIC_TTM", field: "roicTtm", unit: "PERCENT" },
  { id: "ROE_TTM", field: "roeTtm", unit: "PERCENT" },
  { id: "ROA_TTM", field: "roaTtm", unit: "PERCENT" },
  { id: "DEBT_TO_EQUITY", field: "debtToEquity", unit: "MULTIPLE" },
  { id: "CURRENT_RATIO", field: "currentRatio", unit: "MULTIPLE" },
  {
    id: "NET_DEBT_TO_EBITDA_TTM",
    field: "netDebtToEbitdaTtm",
    unit: "MULTIPLE",
  },
  {
    id: "INTEREST_COVERAGE_TTM",
    field: "interestCoverageTtm",
    unit: "MULTIPLE",
  },
  { id: "ASSET_TURNOVER_TTM", field: "assetTurnoverTtm", unit: "MULTIPLE" },
] as const satisfies readonly FundamentalAuditMetric[];

export type FundamentalAuditMetricId =
  (typeof FUNDAMENTAL_AUDIT_METRICS)[number]["id"];

export type FundamentalAuditField =
  (typeof FUNDAMENTAL_AUDIT_METRICS)[number]["field"];

/** The identities, in the ADR's order. */
export const FUNDAMENTAL_AUDIT_METRIC_IDS: readonly FundamentalAuditMetricId[] =
  FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.id);

/**
 * The message every structural guard fails with when a surface knows a metric this list does not,
 * so the failure names the cause rather than showing an unexplained array difference.
 */
export const FUNDAMENTAL_AUDIT_DRIFT_MESSAGE =
  "new Fundamental metric is not covered by audit tooling: add it to FUNDAMENTAL_AUDIT_METRICS " +
  "(packages/testing/src/fundamental-audit.ts), the independent oracle " +
  "(apps/api/src/data-correctness-audit/oracle/fundamentals.ts) and the QA-matrix Fundamentals " +
  "dimension, after its methodology is locked";

// ---------------------------------------------------------------------------
// The single-source-of-truth anchor
// ---------------------------------------------------------------------------

/**
 * One statement revision of the anchor history, as a provider sync delivers it. The seeding test
 * attaches the security id and hands a sync's rows to the real `PrismaStockDataStore`, which
 * assigns every `availableFromDate` itself.
 */
export type FundamentalAuditDraft = {
  readonly statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
  readonly fiscalDate: string;
  readonly fiscalYear: number;
  readonly period: "FY" | "Q1" | "Q2" | "Q3" | "Q4";
  readonly reportedCurrency: string;
  readonly filingDate: string;
  readonly values: Readonly<Record<string, number>>;
};

export type FundamentalAuditSync = {
  /** When this sync observed the rows: the loader's `observedAt`. */
  readonly observedAt: string;
  readonly statements: readonly FundamentalAuditDraft[];
};

/** Base quarterly figures. Every ratio below was chosen to be hand-checkable. */
const INCOME_BASE = {
  revenue: 250,
  costOfRevenue: 150,
  grossProfit: 100,
  operatingIncome: 30,
  netIncome: 20,
  epsDiluted: 0.5,
  ebitda: 45,
  ebit: 32,
  interestExpense: 4,
} as const;
/** Invested capital 720 + 600 - 530 = 790 on every balance sheet except the negative-equity one. */
const BALANCE_BASE = {
  totalDebt: 720,
  totalStockholdersEquity: 600,
  totalEquity: 650,
  cashAndShortTermInvestments: 530,
  cashAndCashEquivalents: 500,
  totalAssets: 2_000,
  totalCurrentAssets: 900,
  totalCurrentLiabilities: 600,
  netDebt: 90,
} as const;
/** Operating cash flow + capital expenditure = 25; the provider's own `freeCashFlow` is wrong. */
const CASH_FLOW_BASE = {
  operatingCashFlow: 40,
  capitalExpenditure: -15,
  freeCashFlow: 99,
} as const;
/** 480 + 600 - 290 = 790. */
const BALANCE_DELEVERED = {
  ...BALANCE_BASE,
  totalDebt: 480,
  cashAndShortTermInvestments: 290,
  totalCurrentAssets: 1_200,
  netDebt: -60,
} as const;
/** 360 + 600 - 170 = 790. */
const BALANCE_MOVED = {
  ...BALANCE_BASE,
  totalDebt: 360,
  cashAndShortTermInvestments: 170,
  totalCurrentAssets: 1_200,
  totalCurrentLiabilities: 400,
  netDebt: 0,
} as const;
const BALANCE_LATE = { ...BALANCE_MOVED, netDebt: -24 } as const;

const QUARTER_END = {
  Q1: "03-31",
  Q2: "06-30",
  Q3: "09-30",
  Q4: "12-31",
} as const;
/** Filing dates of the ordinary quarters: Q4 is filed in the following February. */
const ROUTINE_FILING = {
  Q1: "05-05",
  Q2: "08-05",
  Q3: "11-04",
  Q4: "02-10",
} as const;

function quarter(
  statementType: FundamentalAuditDraft["statementType"],
  fiscalYear: number,
  period: keyof typeof QUARTER_END,
  filingDate: string,
  values: Readonly<Record<string, number>>,
  overrides: Partial<FundamentalAuditDraft> = {},
): FundamentalAuditDraft {
  return {
    statementType,
    fiscalDate: `${fiscalYear}-${QUARTER_END[period]}`,
    fiscalYear,
    period,
    reportedCurrency: "USD",
    filingDate,
    values,
    ...overrides,
  };
}

function wholeQuarter(
  fiscalYear: number,
  period: keyof typeof QUARTER_END,
  filingDate: string,
  income: Readonly<Record<string, number>> = INCOME_BASE,
  balance: Readonly<Record<string, number>> = BALANCE_BASE,
  cashFlow: Readonly<Record<string, number>> = CASH_FLOW_BASE,
): FundamentalAuditDraft[] {
  return [
    quarter("INCOME", fiscalYear, period, filingDate, income),
    quarter("BALANCE_SHEET", fiscalYear, period, filingDate, balance),
    quarter("CASH_FLOW", fiscalYear, period, filingDate, cashFlow),
  ];
}

function backfill(): FundamentalAuditDraft[] {
  const rows: FundamentalAuditDraft[] = [];
  for (let fiscalYear = 2020; fiscalYear <= 2022; fiscalYear += 1) {
    for (const period of ["Q1", "Q2", "Q3", "Q4"] as const) {
      if (fiscalYear === 2022 && period === "Q4") {
        continue;
      }
      const filingYear = period === "Q4" ? fiscalYear + 1 : fiscalYear;
      rows.push(
        ...wholeQuarter(
          fiscalYear,
          period,
          `${filingYear}-${ROUTINE_FILING[period]}`,
        ),
      );
    }
  }
  return rows;
}

/**
 * The anchor security's statement history: sixteen syncs, each observed when the product would
 * have seen it. The events they create on the trading axis, with the rule each exercises:
 *
 * | Effective session | Cause |
 * | --- | --- |
 * | 2023-01-03 | opening state: FY2020 Q1 … FY2022 Q3, every metric available, growth exactly 0 |
 * | 2023-02-13 | FY2022 Q4 filed Friday 02-10, public Saturday: revenue 350 (weekend -> Monday) |
 * | 2023-05-05 | FY2023 Q1: nothing moves (an event that changes no value) |
 * | 2023-07-05 | FY2023 Q2 filed 07-03, public on the 07-04 holiday: delevered balance sheet |
 * | 2023-11-03 | FY2023 Q3: free cash flow -5 in the quarter (negative FCF growth) |
 * | 2024-02-09 | FY2023 Q4: the 350 quarter leaves the current year (negative revenue growth) |
 * | 2024-05-03 | FY2024 Q1: nothing moves |
 * | 2024-08-02 | FY2024 Q2: operating income 90, EBITDA 105, EBIT 92 |
 * | 2024-08-20 | FY2024 Q2 income refiled in EUR: every metric reading that income is unavailable |
 * | 2024-09-16 | FY2024 Q2 income refiled in USD, operating income 70, public Saturday: restored |
 * | 2024-10-15 | FY2024 Q2 balance sheet with its period end moved to 06-29, same filing date: dated from its observation; net debt exactly 0 |
 * | 2024-11-08 | FY2024 Q3 |
 * | 2024-12-16 | FY2024 Q3 balance sheet refiled with negative equity: Debt / Equity unavailable |
 * | 2025-01-02 | FY2024 Q4 filed on the 01-01 holiday, public on the year's first session: restored |
 * | 2025-05-09 | FY2025 Q1: a Current Ratio of 1.5e12, beyond `DECIMAL(20,8)`: that metric alone unavailable |
 * | 2025-08-15 | FY2025 Q2 whose filing date is the period-end placeholder: public at the 45-day deadline + 1 |
 *
 * An `FY2022` annual row with nonsense values is delivered with FY2022 Q4 and must never be read.
 */
export const FUNDAMENTAL_AUDIT_ANCHOR_SYNCS: readonly FundamentalAuditSync[] = [
  { observedAt: "2023-01-01T06:00:00.000Z", statements: backfill() },
  {
    observedAt: "2023-02-11T06:00:00.000Z",
    statements: [
      ...wholeQuarter(2022, "Q4", "2023-02-10", {
        ...INCOME_BASE,
        revenue: 350,
      }),
      ...(["INCOME", "BALANCE_SHEET", "CASH_FLOW"] as const).map(
        (statementType) => ({
          statementType,
          fiscalDate: "2022-12-31",
          fiscalYear: 2022,
          period: "FY" as const,
          reportedCurrency: "USD",
          filingDate: "2023-02-10",
          values: {
            revenue: 1,
            grossProfit: 999_999,
            operatingIncome: -777,
            netIncome: 5,
            epsDiluted: 42,
            ebitda: -1,
            ebit: 3,
            interestExpense: 0,
            totalDebt: 1,
            totalStockholdersEquity: 1,
            totalCurrentLiabilities: 1,
            totalCurrentAssets: 1,
            operatingCashFlow: 1,
            capitalExpenditure: 1,
          },
        }),
      ),
    ],
  },
  {
    observedAt: "2023-05-05T20:00:00.000Z",
    statements: wholeQuarter(2023, "Q1", "2023-05-04"),
  },
  {
    observedAt: "2023-07-05T20:00:00.000Z",
    statements: wholeQuarter(
      2023,
      "Q2",
      "2023-07-03",
      INCOME_BASE,
      BALANCE_DELEVERED,
    ),
  },
  {
    observedAt: "2023-11-03T20:00:00.000Z",
    statements: wholeQuarter(
      2023,
      "Q3",
      "2023-11-02",
      INCOME_BASE,
      BALANCE_DELEVERED,
      {
        ...CASH_FLOW_BASE,
        operatingCashFlow: 10,
      },
    ),
  },
  {
    observedAt: "2024-02-09T20:00:00.000Z",
    statements: wholeQuarter(
      2023,
      "Q4",
      "2024-02-08",
      INCOME_BASE,
      BALANCE_DELEVERED,
    ),
  },
  {
    observedAt: "2024-05-03T20:00:00.000Z",
    statements: wholeQuarter(
      2024,
      "Q1",
      "2024-05-02",
      INCOME_BASE,
      BALANCE_DELEVERED,
    ),
  },
  {
    observedAt: "2024-08-02T20:00:00.000Z",
    statements: wholeQuarter(
      2024,
      "Q2",
      "2024-08-01",
      { ...INCOME_BASE, operatingIncome: 90, ebitda: 105, ebit: 92 },
      BALANCE_DELEVERED,
    ),
  },
  {
    observedAt: "2024-08-20T20:00:00.000Z",
    statements: [
      quarter(
        "INCOME",
        2024,
        "Q2",
        "2024-08-19",
        { ...INCOME_BASE, operatingIncome: 90, ebitda: 105, ebit: 92 },
        { reportedCurrency: "EUR" },
      ),
    ],
  },
  {
    observedAt: "2024-09-16T12:00:00.000Z",
    statements: [
      quarter("INCOME", 2024, "Q2", "2024-09-13", {
        ...INCOME_BASE,
        operatingIncome: 70,
        ebitda: 105,
        ebit: 92,
      }),
    ],
  },
  {
    observedAt: "2024-10-15T12:00:00.000Z",
    statements: [
      quarter("BALANCE_SHEET", 2024, "Q2", "2024-08-01", BALANCE_MOVED, {
        fiscalDate: "2024-06-29",
      }),
    ],
  },
  {
    observedAt: "2024-11-08T20:00:00.000Z",
    statements: wholeQuarter(
      2024,
      "Q3",
      "2024-11-07",
      INCOME_BASE,
      BALANCE_LATE,
    ),
  },
  {
    observedAt: "2024-12-16T12:00:00.000Z",
    statements: [
      quarter("BALANCE_SHEET", 2024, "Q3", "2024-12-13", {
        ...BALANCE_LATE,
        totalStockholdersEquity: -50,
      }),
    ],
  },
  {
    observedAt: "2025-01-02T12:00:00.000Z",
    statements: wholeQuarter(
      2024,
      "Q4",
      "2025-01-01",
      INCOME_BASE,
      BALANCE_LATE,
    ),
  },
  {
    observedAt: "2025-05-09T20:00:00.000Z",
    statements: wholeQuarter(2025, "Q1", "2025-05-08", INCOME_BASE, {
      ...BALANCE_LATE,
      totalCurrentAssets: 3_000_000_000_000,
      totalCurrentLiabilities: 2,
    }),
  },
  {
    // Observed before its statutory deadline: stored, but not public until 2025-08-15.
    observedAt: "2025-07-01T20:00:00.000Z",
    statements: wholeQuarter(
      2025,
      "Q2",
      "2025-06-30",
      INCOME_BASE,
      BALANCE_LATE,
    ),
  },
];

/** NYSE full closures on the anchor's trading axis. */
export const FUNDAMENTAL_AUDIT_ANCHOR_HOLIDAYS: readonly string[] = [
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

export const FUNDAMENTAL_AUDIT_ANCHOR_FIRST_SESSION = "2023-01-03";
export const FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION = "2025-12-31";

/** Every trading session of the anchor axis: weekdays that are not holidays. */
export function fundamentalAuditAnchorSessions(): string[] {
  const holidays = new Set(FUNDAMENTAL_AUDIT_ANCHOR_HOLIDAYS);
  const sessions: string[] = [];
  const cursor = new Date(
    `${FUNDAMENTAL_AUDIT_ANCHOR_FIRST_SESSION}T00:00:00.000Z`,
  );
  const end = new Date(
    `${FUNDAMENTAL_AUDIT_ANCHOR_LAST_SESSION}T00:00:00.000Z`,
  );
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(date)) {
      sessions.push(date);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return sessions;
}

/**
 * The stored reading of every metric, as stretches: from `from` (a session) onward the persisted
 * `DECIMAL(20,8)` text is `value` until the next stretch; `null` is unavailable.
 *
 * Every value was derived by hand from the syncs above and `docs/decisions/fundamental-metrics-v1.md`
 * — the arithmetic is in the comments — and the independent oracle
 * (`apps/api/src/data-correctness-audit/oracle/fundamentals.ts`) reproduces every stretch in
 * `anchor-oracle.test.ts`. Every layer the audit compares — PostgreSQL, Redis, the Strategy
 * evaluation frame, the Monitor frame, the Stock Details API and the chart — is held to this one
 * table, so they are equal to each other because each is equal to it.
 */
export const FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED: Readonly<
  Record<
    FundamentalAuditMetricId,
    readonly (readonly [string, string | null])[]
  >
> = {
  // Revenue TTM against the four quarters before: 1000/1000; 1100/1000; 1000/1100 = -9.0909…%.
  // Every income metric is unavailable while the FY2024 Q2 income is reported in EUR.
  REVENUE_GROWTH_TTM_YOY: [
    ["2023-01-03", "0.00000000"],
    ["2023-02-13", "10.00000000"],
    ["2024-02-09", "-9.09090909"],
    ["2024-08-20", null],
    ["2024-09-16", "-9.09090909"],
    ["2025-01-02", "0.00000000"],
  ],
  // Diluted EPS is 0.5 in every quarter: 2.0 / 2.0.
  EPS_GROWTH_TTM_YOY: [
    ["2023-01-03", "0.00000000"],
    ["2024-08-20", null],
    ["2024-09-16", "0.00000000"],
  ],
  // FCF TTM: 100/100; 70/100 (FY2023 Q3 FCF -5); 100/70 = 42.857142857…%. Cash Flow only, so the
  // EUR income never touches it.
  FCF_GROWTH_TTM_YOY: [
    ["2023-01-03", "0.00000000"],
    ["2023-11-03", "-30.00000000"],
    ["2024-11-08", "42.85714286"],
  ],
  // 400/1000; 400/1100 = 36.3636…%.
  GROSS_MARGIN_TTM: [
    ["2023-01-03", "40.00000000"],
    ["2023-02-13", "36.36363636"],
    ["2024-02-09", "40.00000000"],
    ["2024-08-20", null],
    ["2024-09-16", "40.00000000"],
  ],
  // 120/1000; 120/1100; 180/1000 (Q2 90); 160/1000 (Q2 refiled at 70); 120/1000 once Q2 leaves.
  OPERATING_MARGIN_TTM: [
    ["2023-01-03", "12.00000000"],
    ["2023-02-13", "10.90909091"],
    ["2024-02-09", "12.00000000"],
    ["2024-08-02", "18.00000000"],
    ["2024-08-20", null],
    ["2024-09-16", "16.00000000"],
    ["2025-08-15", "12.00000000"],
  ],
  // 80/1000; 80/1100 = 7.2727…%.
  NET_MARGIN_TTM: [
    ["2023-01-03", "8.00000000"],
    ["2023-02-13", "7.27272727"],
    ["2024-02-09", "8.00000000"],
    ["2024-08-20", null],
    ["2024-09-16", "8.00000000"],
  ],
  // FCF over revenue on one aligned window: 100/1000; 100/1100; 70/1100; 70/1000; 100/1000.
  FCF_MARGIN_TTM: [
    ["2023-01-03", "10.00000000"],
    ["2023-02-13", "9.09090909"],
    ["2023-11-03", "6.36363636"],
    ["2024-02-09", "7.00000000"],
    ["2024-08-20", null],
    ["2024-09-16", "7.00000000"],
    ["2024-11-08", "10.00000000"],
  ],
  // Operating income TTM x 0.79 / 790 x 100: 120 -> 12; 180 -> 18; 160 -> 16. With the negative-
  // equity ending state the average invested capital is (790 + 140) / 2 = 465, so
  // 126.4 / 465 x 100 = 27.1827956989…%. Back to 12 when the 70 quarter leaves the window.
  ROIC_TTM: [
    ["2023-01-03", "12.00000000"],
    ["2024-08-02", "18.00000000"],
    ["2024-08-20", null],
    ["2024-09-16", "16.00000000"],
    ["2024-12-16", "27.18279570"],
    ["2025-01-02", "16.00000000"],
    ["2025-08-15", "12.00000000"],
  ],
  // 80 / 600 = 13.3333…%; with equity (600 - 50) / 2 = 275: 29.0909…%.
  ROE_TTM: [
    ["2023-01-03", "13.33333333"],
    ["2024-08-20", null],
    ["2024-09-16", "13.33333333"],
    ["2024-12-16", "29.09090909"],
    ["2025-01-02", "13.33333333"],
  ],
  // 80 / 2000.
  ROA_TTM: [
    ["2023-01-03", "4.00000000"],
    ["2024-08-20", null],
    ["2024-09-16", "4.00000000"],
  ],
  // 720/600; 480/600; 360/600 (moved period end); negative equity; 360/600 again in 2025.
  DEBT_TO_EQUITY: [
    ["2023-01-03", "1.20000000"],
    ["2023-07-05", "0.80000000"],
    ["2024-10-15", "0.60000000"],
    ["2024-12-16", null],
    ["2025-01-02", "0.60000000"],
  ],
  // 900/600; 1200/600; 1200/400; 3e12/2 is beyond the column; 1200/400 again.
  CURRENT_RATIO: [
    ["2023-01-03", "1.50000000"],
    ["2023-07-05", "2.00000000"],
    ["2024-10-15", "3.00000000"],
    ["2025-05-09", null],
    ["2025-08-15", "3.00000000"],
  ],
  // Latest net debt over EBITDA TTM: 90/180; -60/180; -60/240; 0/240; -24/240; -24/180.
  NET_DEBT_TO_EBITDA_TTM: [
    ["2023-01-03", "0.50000000"],
    ["2023-07-05", "-0.33333333"],
    ["2024-08-02", "-0.25000000"],
    ["2024-08-20", null],
    ["2024-09-16", "-0.25000000"],
    ["2024-10-15", "0.00000000"],
    ["2024-11-08", "-0.10000000"],
    ["2025-08-15", "-0.13333333"],
  ],
  // EBIT 128/16; 188/16 while the Q2 EBIT of 92 is in the window.
  INTEREST_COVERAGE_TTM: [
    ["2023-01-03", "8.00000000"],
    ["2024-08-02", "11.75000000"],
    ["2024-08-20", null],
    ["2024-09-16", "11.75000000"],
    ["2025-08-15", "8.00000000"],
  ],
  // Revenue TTM over average assets of 2000: 1000; 1100; 1000.
  ASSET_TURNOVER_TTM: [
    ["2023-01-03", "0.50000000"],
    ["2023-02-13", "0.55000000"],
    ["2024-02-09", "0.50000000"],
    ["2024-08-20", null],
    ["2024-09-16", "0.50000000"],
  ],
};

/** The stored text of one metric on one session, or `null` where it is unavailable. */
export function fundamentalAuditAnchorExpected(
  metricId: FundamentalAuditMetricId,
  session: string,
): string | null {
  let value: string | null = null;
  for (const [from, stored] of FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED[metricId]) {
    if (from > session) {
      break;
    }
    value = stored;
  }
  return value;
}

/**
 * The sessions the cross-layer table reports: the first and last session, and for every event the
 * session before it and the session it takes effect on. Every layer is compared on every session;
 * these are the ones printed.
 */
export const FUNDAMENTAL_AUDIT_ANCHOR_BOUNDARIES: readonly string[] = [
  "2023-01-03",
  "2023-02-10",
  "2023-02-13",
  "2023-07-03",
  "2023-07-05",
  "2023-11-02",
  "2023-11-03",
  "2024-02-08",
  "2024-02-09",
  "2024-08-01",
  "2024-08-02",
  "2024-08-19",
  "2024-08-20",
  "2024-09-13",
  "2024-09-16",
  "2024-10-14",
  "2024-10-15",
  "2024-11-07",
  "2024-11-08",
  "2024-12-13",
  "2024-12-16",
  "2024-12-31",
  "2025-01-02",
  "2025-05-08",
  "2025-05-09",
  "2025-08-14",
  "2025-08-15",
  "2025-12-31",
];

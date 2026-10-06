/**
 * The hand-computed anchor matrix of the Valuation Ratios V1 audit.
 *
 * Every expected reading below is worked out by hand from `docs/decisions/valuation-ratios-v1.md`
 * and written as a literal: a fraction where the ratio is available, the rule that withholds it
 * where it is not. None is produced by code — neither by the product nor by the oracle — and the
 * oracle (`valuation-ratios.ts`) must reproduce every one exactly before its full-scale comparison
 * is trusted. The same literals are then held against the product
 * (`valuation/valuation-hand-matrix.test.ts`), where a reason is not compared: the product reports
 * absence only.
 *
 * ## The base company
 *
 * Calendar fiscal quarters, USD, every statement observed on 2026-08-31 (a first load long after
 * every event), the price history verified on 2026-10-02. One filing per quarter carries all three
 * statements. `FCF = OCF + CapEx`.
 *
 * | quarter | period end | available  | NI | Rev | EBITDA | shares | equity | net debt | OCF | CapEx | FCF |
 * | ------- | ---------- | ---------- | -- | --- | ------ | ------ | ------ | -------- | --- | ----- | --- |
 * | 2023Q1  | 2023-03-31 | 2023-05-16 |  4 |  90 |     20 |     10 |    200 |       90 |  18 |    -7 |  11 |
 * | 2023Q2  | 2023-06-30 | 2023-08-15 |  5 |  92 |     21 |     10 |    205 |       85 |  18 |    -7 |  11 |
 * | 2023Q3  | 2023-09-30 | 2023-11-15 |  6 |  94 |     22 |     10 |    210 |       80 |  18 |    -7 |  11 |
 * | 2023Q4  | 2023-12-31 | 2024-03-01 |  7 |  96 |     23 |     10 |    215 |       75 |  18 |    -7 |  11 |
 * | 2024Q1  | 2024-03-31 | 2024-05-16 |  8 |  95 |     24 |     10 |    220 |       70 |  20 |    -8 |  12 |
 * | 2024Q2  | 2024-06-30 | 2024-08-15 |  9 | 100 |     25 |     10 |    225 |       65 |  21 |    -9 |  12 |
 * | 2024Q3  | 2024-09-30 | 2024-11-15 | 11 | 102 |     25 |     10 |    230 |       60 |  22 |    -9 |  13 |
 * | 2024Q4  | 2024-12-31 | 2025-03-03 | 12 | 103 |     26 |     10 |    240 |       50 |  23 |   -10 |  13 |
 * | 2025Q1  | 2025-03-31 | 2025-05-15 | 13 | 105 |     27 |     10 |    250 |       40 |  24 |   -10 |  14 |
 * | 2025Q2  | 2025-06-30 | 2025-08-14 | 14 | 108 |     28 |     10 |    260 |       30 |  25 |   -11 |  14 |
 *
 * With the close at 12 and 10 diluted shares the market capitalisation is 120. The trailing sums
 * and readings, by the latest quarter in force:
 *
 * | as of  | NI TTM | Rev TTM | EBITDA TTM | FCF TTM | equity | net debt | P/E   | P/S    | P/B   | P/FCF | EV/EBITDA        |
 * | ------ | ------ | ------- | ---------- | ------- | ------ | -------- | ----- | ------ | ----- | ----- | ---------------- |
 * | 2023Q3 | —      | —       | —          | —       | 210    | 80       | —     | —      | 4/7   | —     | —                |
 * | 2023Q4 | 22     | 372     | 86         | 44      | 215    | 75       | 60/11 | 10/31  | 24/43 | 30/11 | 195/86           |
 * | 2024Q1 | 26     | 377     | 90         | 45      | 220    | 70       | 60/13 | 120/377| 6/11  | 8/3   | 190/90 = 19/9    |
 * | 2024Q2 | 30     | 385     | 94         | 46      | 225    | 65       | 4     | 24/77  | 8/15  | 60/23 | 185/94           |
 * | 2024Q3 | 35     | 393     | 97         | 48      | 230    | 60       | 24/7  | 40/131 | 12/23 | 5/2   | 180/97           |
 * | 2024Q4 | 40     | 400     | 100        | 50      | 240    | 50       | 3     | 3/10   | 1/2   | 12/5  | 170/100 = 17/10  |
 * | 2025Q1 | 45     | 410     | 103        | 52      | 250    | 40       | 8/3   | 12/41  | 12/25 | 30/13 | 160/103          |
 * | 2025Q2 | 50     | 418     | 106        | 54      | 260    | 30       | 12/5  | 60/209 | 6/13  | 20/9  | 150/106 = 75/53  |
 *
 * (2023Q4: NI 4+5+6+7, Rev 90+92+94+96, EBITDA 20+21+22+23, FCF 4·11. 2024Q1: NI 5+6+7+8, Rev
 * 92+94+96+95, EBITDA 21+22+23+24, FCF 11+11+11+12. 2024Q2: 6+7+8+9, 94+96+95+100, 22+23+24+25,
 * 11+11+12+12. 2024Q3: 7+8+9+11, 96+95+100+102, 23+24+25+25, 11+12+12+13. 2024Q4: 8+9+11+12,
 * 95+100+102+103, 24+25+25+26, 12+12+13+13. 2025Q1: 9+11+12+13, 100+102+103+105, 25+25+26+27,
 * 12+13+13+14. 2025Q2: 11+12+13+14, 102+103+105+108, 25+26+27+28, 13+13+14+14. Before 2024-03-01 an
 * Income or Cash Flow window has three quarters at most.)
 *
 * The cases `G1a`–`G3b` at the end hold the owner's rulings of 2026-10-06 on the three shapes the
 * clean-room review found the rules as first written to read wrong (`docs/valuation-ratios-audit/
 * REPORT.md`, §31): rule 3 compares `R` with its anchor, the latest earlier revision of the quarter
 * that rule 3 accepted and that has a usable count, and rule 2 confirms the walk's first count like
 * any new level. Each comment records the reading before the ruling.
 */

import type {
  OracleSplitEntry,
  OracleValuationEvent,
  OracleValuationReason,
  OracleValuationSecurity,
  OracleValuationStatement,
} from "./valuation-ratios";

export type HandRatio = "PE" | "PS" | "PB" | "PFCF" | "EV";

export const HAND_RATIO_IDS = {
  PE: "PRICE_TO_EARNINGS_TTM",
  PS: "PRICE_TO_SALES_TTM",
  PB: "PRICE_TO_BOOK",
  PFCF: "PRICE_TO_FCF_TTM",
  EV: "EV_TO_EBITDA_TTM",
} as const satisfies Record<HandRatio, string>;

/** A fraction `"n/d"` or an integer, or the rule that withholds the reading. */
export type HandExpectation =
  | string
  | {
      unavailable: OracleValuationReason;
      alsoFailing?: OracleValuationReason[];
    };

export type HandObservation = {
  session: string;
  close: string;
  /** The Monitor's provisional row reads the newest closed session's statements. */
  statementDate?: string;
  expect: Record<HandRatio, HandExpectation>;
};

export type HandCase = {
  id: string;
  /** The brief's anchor-case number(s) this case covers. */
  covers: readonly number[];
  title: string;
  security: OracleValuationSecurity;
  observations: readonly HandObservation[];
};

// ---------------------------------------------------------------------------------------------
// Literal readings (see the table above)
// ---------------------------------------------------------------------------------------------

type Readings = Record<HandRatio, HandExpectation>;

const AS_OF_2023Q4: Readings = {
  PE: "60/11",
  PS: "10/31",
  PB: "24/43",
  PFCF: "30/11",
  EV: "195/86",
};
const AS_OF_2024Q1: Readings = {
  PE: "60/13",
  PS: "120/377",
  PB: "6/11",
  PFCF: "8/3",
  EV: "19/9",
};
const AS_OF_2024Q2: Readings = {
  PE: "4",
  PS: "24/77",
  PB: "8/15",
  PFCF: "60/23",
  EV: "185/94",
};
const AS_OF_2024Q3: Readings = {
  PE: "24/7",
  PS: "40/131",
  PB: "12/23",
  PFCF: "5/2",
  EV: "180/97",
};
const AS_OF_2024Q4: Readings = {
  PE: "3",
  PS: "3/10",
  PB: "1/2",
  PFCF: "12/5",
  EV: "17/10",
};
const AS_OF_2025Q1: Readings = {
  PE: "8/3",
  PS: "12/41",
  PB: "12/25",
  PFCF: "30/13",
  EV: "160/103",
};
const AS_OF_2025Q2: Readings = {
  PE: "12/5",
  PS: "60/209",
  PB: "6/13",
  PFCF: "20/9",
  EV: "75/53",
};

function all(
  reason: OracleValuationReason,
  alsoFailing?: OracleValuationReason[],
): Readings {
  const expectation: HandExpectation = alsoFailing
    ? { unavailable: reason, alsoFailing }
    : { unavailable: reason };
  return {
    PE: expectation,
    PS: expectation,
    PB: expectation,
    PFCF: expectation,
    EV: expectation,
  };
}

function off(reason: OracleValuationReason): HandExpectation {
  return { unavailable: reason };
}

// ---------------------------------------------------------------------------------------------
// The base company
// ---------------------------------------------------------------------------------------------

type BaseRow = readonly [
  quarter: string,
  fiscalDate: string,
  available: string,
  netIncome: number,
  revenue: number,
  ebitda: number,
  shares: number,
  equity: number,
  netDebt: number,
  operatingCashFlow: number,
  capitalExpenditure: number,
];

const BASE_ROWS: readonly BaseRow[] = [
  ["2023Q1", "2023-03-31", "2023-05-16", 4, 90, 20, 10, 200, 90, 18, -7],
  ["2023Q2", "2023-06-30", "2023-08-15", 5, 92, 21, 10, 205, 85, 18, -7],
  ["2023Q3", "2023-09-30", "2023-11-15", 6, 94, 22, 10, 210, 80, 18, -7],
  ["2023Q4", "2023-12-31", "2024-03-01", 7, 96, 23, 10, 215, 75, 18, -7],
  ["2024Q1", "2024-03-31", "2024-05-16", 8, 95, 24, 10, 220, 70, 20, -8],
  ["2024Q2", "2024-06-30", "2024-08-15", 9, 100, 25, 10, 225, 65, 21, -9],
  ["2024Q3", "2024-09-30", "2024-11-15", 11, 102, 25, 10, 230, 60, 22, -9],
  ["2024Q4", "2024-12-31", "2025-03-03", 12, 103, 26, 10, 240, 50, 23, -10],
  ["2025Q1", "2025-03-31", "2025-05-15", 13, 105, 27, 10, 250, 40, 24, -10],
  ["2025Q2", "2025-06-30", "2025-08-14", 14, 108, 28, 10, 260, 30, 25, -11],
];

const OBSERVED = "2026-08-31T12:00:00.000Z";
const VERIFIED = "2026-10-02T05:00:00.000Z";
const CLOSE = "12";

type Family = OracleValuationStatement["statementType"];

/** The three statements of one base quarter. */
function quarterStatements(
  row: BaseRow,
  observedAt: string,
): OracleValuationStatement[] {
  const [
    quarter,
    fiscalDate,
    available,
    ni,
    rev,
    ebitda,
    shares,
    equity,
    netDebt,
    ocf,
    capex,
  ] = row;
  const fiscalYear = Number(quarter.slice(0, 4));
  const period = quarter.slice(4) as "Q1" | "Q2" | "Q3" | "Q4";
  const common = {
    fiscalDate,
    fiscalYear,
    period,
    reportedCurrency: "USD",
    availableFromDate: available,
    observedAt,
  };
  return [
    {
      ...common,
      statementType: "INCOME",
      contentHash: `INCOME-${quarter}-a`,
      values: {
        netIncome: ni,
        revenue: rev,
        ebitda,
        weightedAverageShsOutDil: shares,
        weightedAverageShsOut: shares,
        epsDiluted: ni / shares,
      },
    },
    {
      ...common,
      statementType: "BALANCE_SHEET",
      contentHash: `BALANCE_SHEET-${quarter}-a`,
      values: {
        totalStockholdersEquity: equity,
        totalEquity: equity + 1000,
        netDebt,
        totalDebt: netDebt + 1000,
      },
    },
    {
      ...common,
      statementType: "CASH_FLOW",
      contentHash: `CASH_FLOW-${quarter}-a`,
      values: {
        operatingCashFlow: ocf,
        capitalExpenditure: capex,
        freeCashFlow: ocf + capex + 1000,
      },
    },
  ];
}

/**
 * The base company's statements, each observed `observedAt(row)` (default 2026-08-31, long after
 * every event). `freeCashFlow`, `totalEquity`, `totalDebt` and basic shares carry deliberately
 * wrong values: a reading that used one of them would differ from every literal below.
 */
function baseStatements(
  observedAt: (row: BaseRow) => string = () => OBSERVED,
): OracleValuationStatement[] {
  return BASE_ROWS.flatMap((row) => quarterStatements(row, observedAt(row)));
}

/** Real-time observation: each filing observed at noon on the day it became available. */
function observedWhenAvailable(row: BaseRow): string {
  return `${row[2]}T12:00:00.000Z`;
}

function company(
  overrides: Partial<OracleValuationSecurity> = {},
): OracleValuationSecurity {
  return {
    currency: "USD",
    statements: baseStatements(),
    verifiedAt: VERIFIED,
    events: [],
    splits: [],
    ...overrides,
  };
}

function edit(
  statements: readonly OracleValuationStatement[],
  family: Family,
  quarter: string,
  change: (
    statement: OracleValuationStatement,
  ) => OracleValuationStatement | undefined,
): OracleValuationStatement[] {
  const fiscalYear = Number(quarter.slice(0, 4));
  const period = quarter.slice(4);
  return statements.flatMap((statement) => {
    if (
      statement.statementType === family &&
      statement.fiscalYear === fiscalYear &&
      statement.period === period
    ) {
      const changed = change(statement);
      return changed === undefined ? [] : [changed];
    }
    return [statement];
  });
}

function setValue(
  statements: readonly OracleValuationStatement[],
  family: Family,
  quarter: string,
  name: string,
  value: unknown,
): OracleValuationStatement[] {
  return edit(statements, family, quarter, (statement) => {
    const values: Record<string, unknown> = { ...statement.values };
    if (value === undefined) {
      delete values[name];
    } else {
      values[name] = value;
    }
    return { ...statement, values };
  });
}

function setShares(
  statements: readonly OracleValuationStatement[],
  counts: Readonly<Record<string, number | undefined>>,
): OracleValuationStatement[] {
  let result = [...statements];
  for (const [quarter, count] of Object.entries(counts)) {
    result = setValue(
      result,
      "INCOME",
      quarter,
      "weightedAverageShsOutDil",
      count,
    );
  }
  return result;
}

function drop(
  statements: readonly OracleValuationStatement[],
  family: Family,
  quarter: string,
): OracleValuationStatement[] {
  return edit(statements, family, quarter, () => undefined);
}

/** A later revision of one statement, with changed values. */
function revision(
  statements: readonly OracleValuationStatement[],
  family: Family,
  quarter: string,
  change: Partial<OracleValuationStatement> & {
    values?: Record<string, unknown>;
  },
  hashSuffix: string,
): OracleValuationStatement[] {
  const original = statements.find(
    (statement) =>
      statement.statementType === family &&
      `${statement.fiscalYear}${statement.period}` === quarter,
  );
  if (original === undefined) {
    throw new Error(`no ${family} ${quarter}`);
  }
  return [
    ...statements,
    {
      ...original,
      ...change,
      values: { ...original.values, ...(change.values ?? {}) },
      contentHash: `${family}-${quarter}-${hashSuffix}`,
    },
  ];
}

function split(
  date: string,
  numerator: string,
  denominator: string,
  label: string | null = "stock-split",
): OracleSplitEntry {
  return { date, numerator, denominator, label };
}

function measured(
  dates:
    | { effectiveDate: string }
    | { effectiveFrom: string; effectiveTo: string | null },
  priceRatio: string,
  detectedAt: string,
): OracleValuationEvent {
  return { kind: "MEASURED", ...dates, priceRatio, detectedAt };
}

function observeAll(
  statements: readonly OracleValuationStatement[],
  observedAt: string,
): OracleValuationStatement[] {
  return statements.map((statement) => ({ ...statement, observedAt }));
}

const ALL_QUARTERS = BASE_ROWS.map(([quarter]) => quarter);

/**
 * A revision of every listed Income quarter with its diluted (and basic) count set to `count`, as
 * the provider restates a whole history at once: available and observed on `at`.
 */
function restateCounts(
  statements: readonly OracleValuationStatement[],
  quarters: readonly string[],
  count: number,
  at: string,
  hashSuffix: string,
): OracleValuationStatement[] {
  let result = [...statements];
  for (const quarter of quarters) {
    result = revision(
      result,
      "INCOME",
      quarter,
      {
        availableFromDate: at,
        observedAt: `${at}T12:00:00.000Z`,
        values: {
          weightedAverageShsOutDil: count,
          weightedAverageShsOut: count,
        },
      },
      hashSuffix,
    );
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------------------------

const DELTA_MEASURED = measured(
  { effectiveDate: "2025-06-02" },
  "1.046",
  "2025-06-05T12:00:00.000Z",
);

export const VALUATION_HAND_MATRIX: readonly HandCase[] = [
  {
    id: "C01",
    covers: [1, 2, 3, 4, 5, 13],
    title:
      "ordinary readings of all five ratios at every statement state; no synthetic start before the first complete window",
    security: company(),
    observations: [
      // Before any statement: no Income quarter, so no share count.
      {
        session: "2023-05-15",
        close: CLOSE,
        expect: all("MISSING_SHARE_COUNT"),
      },
      // As of 2023Q3: three quarters only. P/B needs no window: 120 / 210 = 4/7.
      {
        session: "2024-01-02",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: "4/7",
          PFCF: off("INCOMPLETE_WINDOW"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      { session: "2024-03-01", close: CLOSE, expect: AS_OF_2023Q4 },
      { session: "2024-06-07", close: CLOSE, expect: AS_OF_2024Q1 },
      { session: "2024-08-15", close: CLOSE, expect: AS_OF_2024Q2 },
      { session: "2025-02-28", close: CLOSE, expect: AS_OF_2024Q3 },
      { session: "2025-03-03", close: CLOSE, expect: AS_OF_2024Q4 },
      { session: "2025-05-15", close: CLOSE, expect: AS_OF_2025Q1 },
      { session: "2025-08-14", close: CLOSE, expect: AS_OF_2025Q2 },
      // The close moves the reading every session: at 15, MC = 150. P/E 150/40 = 15/4,
      // P/S 150/400 = 3/8, P/B 150/240 = 5/8, P/FCF 150/50 = 3, EV/EBITDA (150 + 50)/100 = 2.
      {
        session: "2025-03-04",
        close: "15",
        expect: { PE: "15/4", PS: "3/8", PB: "5/8", PFCF: "3", EV: "2" },
      },
      // A close with eight decimals: 12.34567891 · 10 = 123.4567891.
      // P/E 123.4567891 / 40 = 1234567891/400000000.
      // P/S / 400 = 1234567891/4000000000. P/B / 240 = 1234567891/2400000000.
      // P/FCF / 50 = 1234567891/500000000. EV (123.4567891 + 50) / 100 = 1734567891/1000000000.
      {
        session: "2025-03-05",
        close: "12.34567891",
        expect: {
          PE: "1234567891/400000000",
          PS: "1234567891/4000000000",
          PB: "1234567891/2400000000",
          PFCF: "1234567891/500000000",
          EV: "1734567891/1000000000",
        },
      },
    ],
  },
  {
    id: "C06",
    covers: [6],
    title: "negative EV/EBITDA: net cash larger than the market capitalisation",
    // 2024Q4 net debt -200: (120 - 200) / 100 = -4/5.
    security: company({
      statements: setValue(
        baseStatements(),
        "BALANCE_SHEET",
        "2024Q4",
        "netDebt",
        -200,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, EV: "-4/5" },
      },
    ],
  },
  {
    id: "C06b",
    covers: [6],
    title: "EV exactly zero is a real reading of zero",
    // net debt -120: (120 - 120) / 100 = 0. Net debt -120.000001: -0.000001 / 100 = -1/100000000.
    security: company({
      statements: setValue(
        baseStatements(),
        "BALANCE_SHEET",
        "2024Q4",
        "netDebt",
        -120,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, EV: "0" },
      },
    ],
  },
  {
    id: "C06c",
    covers: [6],
    title: "a negative enterprise value close to zero",
    security: company({
      statements: setValue(
        baseStatements(),
        "BALANCE_SHEET",
        "2024Q4",
        "netDebt",
        -120.000001,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, EV: "-1/100000000" },
      },
    ],
  },
  {
    id: "C07",
    covers: [7],
    title: "a denominator of exactly zero",
    // 2024Q4 net income -28: 8 + 9 + 11 - 28 = 0.
    security: company({
      statements: setValue(
        baseStatements(),
        "INCOME",
        "2024Q4",
        "netIncome",
        -28,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, PE: off("NON_POSITIVE_DENOMINATOR") },
      },
    ],
  },
  {
    id: "C08",
    covers: [8],
    title: "negative denominators: EBITDA, equity and free cash flow",
    // EBITDA 2024Q4 -100: 24 + 25 + 25 - 100 = -26. Equity 2024Q4 -5. OCF 2024Q4 -100:
    // FCF 12 + 12 + 13 + (-100 - 10) = -73.
    security: company({
      statements: setValue(
        setValue(
          setValue(baseStatements(), "INCOME", "2024Q4", "ebitda", -100),
          "BALANCE_SHEET",
          "2024Q4",
          "totalStockholdersEquity",
          -5,
        ),
        "CASH_FLOW",
        "2024Q4",
        "operatingCashFlow",
        -100,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: {
          PE: "3",
          PS: "3/10",
          PB: off("NON_POSITIVE_DENOMINATOR"),
          PFCF: off("NON_POSITIVE_DENOMINATOR"),
          EV: off("NON_POSITIVE_DENOMINATOR"),
        },
      },
    ],
  },
  {
    id: "C09",
    covers: [9],
    title:
      "a missing denominator field withholds only while its quarter is in the window; no freeCashFlow fallback",
    security: company({
      statements: setValue(
        setValue(
          setValue(
            setValue(
              baseStatements(),
              "INCOME",
              "2024Q2",
              "revenue",
              undefined,
            ),
            "BALANCE_SHEET",
            "2024Q4",
            "netDebt",
            undefined,
          ),
          "BALANCE_SHEET",
          "2024Q4",
          "totalStockholdersEquity",
          undefined,
        ),
        "CASH_FLOW",
        "2024Q4",
        "capitalExpenditure",
        undefined,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: {
          PE: "3",
          PS: off("MISSING_INPUT"),
          PB: off("MISSING_INPUT"),
          PFCF: off("MISSING_INPUT"),
          EV: off("MISSING_INPUT"),
        },
      },
      // As of 2025Q2 the Income window 2024Q3..2025Q2 no longer holds 2024Q2's missing revenue,
      // and the balance sheet is 2025Q2's (complete). The Cash Flow window 2024Q3..2025Q2 still
      // holds 2024Q4's missing CapEx: P/FCF stays withheld until 2024Q4 leaves the window.
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: { ...AS_OF_2025Q2, PFCF: off("MISSING_INPUT") },
      },
    ],
  },
  {
    id: "C10",
    covers: [10],
    title:
      "missing diluted shares: no fallback to basic shares or an older quarter",
    security: company({
      statements: setShares(baseStatements(), { "2024Q4": undefined }),
    }),
    observations: [
      { session: "2025-02-28", close: CLOSE, expect: AS_OF_2024Q3 },
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: all("MISSING_SHARE_COUNT"),
      },
      { session: "2025-05-15", close: CLOSE, expect: AS_OF_2025Q1 },
    ],
  },
  {
    id: "C11",
    covers: [11],
    title: "zero diluted shares",
    security: company({
      statements: setShares(baseStatements(), { "2024Q4": 0 }),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: all("NON_POSITIVE_SHARE_COUNT"),
      },
    ],
  },
  {
    id: "C12",
    covers: [12],
    title: "negative diluted shares",
    security: company({
      statements: setShares(baseStatements(), { "2024Q4": -10 }),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: all("NON_POSITIVE_SHARE_COUNT"),
      },
    ],
  },
  {
    id: "C14",
    covers: [13, 14],
    title:
      "a missing quarter inside the window: no fallback to the older complete window 2023Q1..2023Q4",
    // Income 2024Q1 dropped. As of 2024Q4 the Income window 2024Q1..2024Q4 lacks Q1. P/B reads the
    // share count and the balance sheet; P/FCF the share count and the intact Cash Flow window.
    security: company({
      statements: drop(baseStatements(), "INCOME", "2024Q1"),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: "1/2",
          PFCF: "12/5",
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      // As of 2025Q1 the window 2024Q2..2025Q1 is complete again.
      { session: "2025-05-15", close: CLOSE, expect: AS_OF_2025Q1 },
    ],
  },
  {
    id: "C15",
    covers: [15],
    title: "an FY row never fills a missing quarter",
    // Income 2024Q3 dropped; an FY 2024 row holding the year's sums is available with 2024Q4.
    security: company({
      statements: [
        ...drop(baseStatements(), "INCOME", "2024Q3"),
        {
          statementType: "INCOME",
          fiscalDate: "2024-12-31",
          fiscalYear: 2024,
          period: "FY",
          reportedCurrency: "USD",
          availableFromDate: "2025-03-03",
          observedAt: OBSERVED,
          contentHash: "INCOME-2024FY-a",
          values: {
            netIncome: 40,
            revenue: 400,
            ebitda: 100,
            weightedAverageShsOutDil: 10,
          },
        },
      ],
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: "1/2",
          PFCF: "12/5",
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
    ],
  },
  {
    id: "C15b",
    covers: [15],
    title:
      "an FY row is never the share count, even when it is the newest Income row",
    // An FY 2025 row with 999 shares, available before 2025Q1's quarter.
    security: company({
      statements: [
        ...baseStatements(),
        {
          statementType: "INCOME",
          fiscalDate: "2025-12-31",
          fiscalYear: 2025,
          period: "FY",
          reportedCurrency: "USD",
          availableFromDate: "2025-03-04",
          observedAt: OBSERVED,
          contentHash: "INCOME-2025FY-a",
          values: {
            netIncome: 1,
            revenue: 1,
            ebitda: 1,
            weightedAverageShsOutDil: 999,
          },
        },
      ],
    }),
    observations: [
      { session: "2025-03-04", close: CLOSE, expect: AS_OF_2024Q4 },
    ],
  },
  {
    id: "C16",
    covers: [16],
    title: "a filing available on a Saturday first reads on the Monday",
    // All three 2024Q4 statements available 2025-02-22 (Saturday).
    security: company({
      statements: baseStatements().map((statement) =>
        statement.fiscalDate === "2024-12-31"
          ? { ...statement, availableFromDate: "2025-02-22" }
          : statement,
      ),
    }),
    observations: [
      { session: "2025-02-21", close: CLOSE, expect: AS_OF_2024Q3 },
      { session: "2025-02-24", close: CLOSE, expect: AS_OF_2024Q4 },
    ],
  },
  {
    id: "C17",
    covers: [17],
    title:
      "a restatement available on a holiday (2024-12-25) first reads on the next session",
    // 2024Q3 net income restated 11 -> 13: TTM 7 + 8 + 9 + 13 = 37, P/E 120/37. Nothing else moves.
    security: company({
      statements: revision(
        baseStatements(),
        "INCOME",
        "2024Q3",
        {
          availableFromDate: "2024-12-25",
          observedAt: "2024-12-25T12:00:00.000Z",
          values: { netIncome: 13 },
        },
        "b",
      ),
    }),
    observations: [
      { session: "2024-12-24", close: CLOSE, expect: AS_OF_2024Q3 },
      {
        session: "2024-12-26",
        close: CLOSE,
        expect: { ...AS_OF_2024Q3, PE: "120/37" },
      },
      // The original revision is never read again, and 2024Q4 moves on from the restated quarter:
      // NI 8 + 9 + 13 + 12 = 42, P/E 120/42 = 20/7.
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, PE: "20/7" },
      },
    ],
  },
  {
    id: "C18",
    covers: [18],
    title:
      "a restatement available on a trading day reads from that very session",
    security: company({
      statements: revision(
        baseStatements(),
        "INCOME",
        "2024Q3",
        {
          availableFromDate: "2024-12-17",
          observedAt: "2024-12-17T12:00:00.000Z",
          values: { netIncome: 13 },
        },
        "b",
      ),
    }),
    observations: [
      { session: "2024-12-16", close: CLOSE, expect: AS_OF_2024Q3 },
      {
        session: "2024-12-17",
        close: CLOSE,
        expect: { ...AS_OF_2024Q3, PE: "120/37" },
      },
    ],
  },
  {
    id: "C18b",
    covers: [18],
    title:
      "revision order: same availability, the later observation wins; same observation, the later period end wins",
    // Two 2024Q4 Income revisions available 2025-03-03. "b" observed later with NI 16:
    // 8 + 9 + 11 + 16 = 44, P/E 120/44 = 30/11. A third, "c", delivered by the same observation as
    // "b" with a moved period end 2025-01-03 and NI 20: 8 + 9 + 11 + 20 = 48, P/E 120/48 = 5/2.
    security: company({
      statements: revision(
        revision(
          baseStatements(),
          "INCOME",
          "2024Q4",
          { observedAt: "2026-09-01T12:00:00.000Z", values: { netIncome: 16 } },
          "b",
        ),
        "INCOME",
        "2024Q4",
        {
          observedAt: "2026-09-01T12:00:00.000Z",
          fiscalDate: "2025-01-03",
          values: { netIncome: 20 },
        },
        "c",
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, PE: "5/2" },
      },
    ],
  },
  {
    id: "C18c",
    covers: [18],
    title:
      "a moved period end is the same quarter: the window is still four quarters",
    // A 2024Q3 revision with period end 2024-09-28 and NI 10, available 2025-01-10: the window as
    // of 2024Q3 is 7 + 8 + 9 + 10 = 34, P/E 120/34 = 60/17 — never five quarters.
    security: company({
      statements: revision(
        baseStatements(),
        "INCOME",
        "2024Q3",
        {
          fiscalDate: "2024-09-28",
          availableFromDate: "2025-01-10",
          observedAt: "2025-01-10T12:00:00.000Z",
          values: { netIncome: 10 },
        },
        "b",
      ),
    }),
    observations: [
      { session: "2025-01-09", close: CLOSE, expect: AS_OF_2024Q3 },
      {
        session: "2025-01-10",
        close: CLOSE,
        expect: { ...AS_OF_2024Q3, PE: "60/17" },
      },
    ],
  },
  {
    id: "C18d",
    covers: [18],
    title:
      "revision order: a later observation wins over a later period end at the same availability",
    // Two 2024Q4 Income revisions available 2025-03-03, like the original: "x" observed 2026-09-01
    // with a moved period end 2025-01-03 and NI 20, "y" observed a day later with the original
    // period end and NI 16. The order is availability, then observation, and the period end only
    // between rows of one observation: y represents the quarter. NI 8 + 9 + 11 + 16 = 44, P/E
    // 120/44 = 30/11 (x would give 120/48 = 5/2); the other ratios as of 2024Q4.
    security: company({
      statements: revision(
        revision(
          baseStatements(),
          "INCOME",
          "2024Q4",
          {
            observedAt: "2026-09-01T12:00:00.000Z",
            fiscalDate: "2025-01-03",
            values: { netIncome: 20 },
          },
          "x",
        ),
        "INCOME",
        "2024Q4",
        {
          observedAt: "2026-09-02T12:00:00.000Z",
          values: { netIncome: 16 },
        },
        "y",
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, PE: "30/11" },
      },
    ],
  },
  {
    id: "C19",
    covers: [19],
    title: "every statement in another currency than the listing",
    security: company({
      statements: baseStatements().map((statement) => ({
        ...statement,
        reportedCurrency: "EUR",
      })),
    }),
    observations: [
      { session: "2025-03-03", close: CLOSE, expect: all("CURRENCY_MISMATCH") },
    ],
  },
  {
    id: "C20",
    covers: [20],
    title:
      "one statement family in another currency withholds only the ratios that read it",
    security: company({
      statements: baseStatements().map((statement) =>
        statement.statementType === "BALANCE_SHEET"
          ? { ...statement, reportedCurrency: "EUR" }
          : statement,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: {
          ...AS_OF_2024Q4,
          PB: off("CURRENCY_MISMATCH"),
          EV: off("CURRENCY_MISMATCH"),
        },
      },
    ],
  },
  {
    id: "C20b",
    covers: [20],
    title:
      "the share count's own currency is read by every ratio; an older Cash Flow quarter's only while in the window",
    // Income 2024Q4 (R) in EUR: every ratio reads R. Cash Flow 2024Q1 has no currency: P/FCF as of
    // 2024Q4 reads it; as of 2025Q2 (window 2024Q3..2025Q2) it does not.
    security: company({
      statements: edit(
        edit(baseStatements(), "INCOME", "2024Q4", (statement) => ({
          ...statement,
          reportedCurrency: "EUR",
        })),
        "CASH_FLOW",
        "2024Q1",
        (statement) => ({ ...statement, reportedCurrency: "" }),
      ),
    }),
    observations: [
      { session: "2025-03-03", close: CLOSE, expect: all("CURRENCY_MISMATCH") },
      // As of 2025Q1, R is 2025Q1 (USD) but the Income window still holds 2024Q4 (EUR): P/E, P/S
      // and EV/EBITDA are withheld; P/B reads R and the balance sheet only: 12/25. Cash Flow window
      // 2024Q2..2025Q1 no longer holds 2024Q1: 30/13.
      {
        session: "2025-05-15",
        close: CLOSE,
        expect: {
          PE: off("CURRENCY_MISMATCH"),
          PS: off("CURRENCY_MISMATCH"),
          PB: "12/25",
          PFCF: "30/13",
          EV: off("CURRENCY_MISMATCH"),
        },
      },
      // As of 2025Q2 the Income window 2024Q3..2025Q2 still holds 2024Q4 (EUR). P/B: 6/13;
      // P/FCF (Cash Flow 2024Q3..2025Q2, all USD): 20/9.
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: {
          PE: off("CURRENCY_MISMATCH"),
          PS: off("CURRENCY_MISMATCH"),
          PB: "6/13",
          PFCF: "20/9",
          EV: off("CURRENCY_MISMATCH"),
        },
      },
    ],
  },
  {
    id: "C21",
    covers: [21],
    title:
      "a one-quarter share-count anomaly is withheld, and the level resumes after it",
    // 2024Q4 diluted shares 20.3 (x2.03, NKE-like): outside 25 % of the level 10.
    // 2025Q1 is back at 10: inside the level, accepted.
    security: company({
      statements: setShares(baseStatements(), { "2024Q4": 20.3 }),
    }),
    observations: [
      { session: "2025-02-28", close: CLOSE, expect: AS_OF_2024Q3 },
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: all("SHARE_LEVEL_UNSAFE"),
      },
      { session: "2025-05-15", close: CLOSE, expect: AS_OF_2025Q1 },
    ],
  },
  {
    id: "C22",
    covers: [22],
    title:
      "a new share level is accepted only on its third consecutive quarter",
    // Shares 10 through 2024Q1, 20 from 2024Q2. 2024Q2 is the first quarter at 20, 2024Q3 the
    // second, 2024Q4 the third: accepted. MC = 12 · 20 = 240.
    // As of 2024Q4: P/E 240/40 = 6, P/S 240/400 = 3/5, P/B 240/240 = 1, P/FCF 240/50 = 24/5,
    // EV (240 + 50)/100 = 29/10.
    // As of 2025Q1 (20 inside the new level): 240/45 = 16/3, 240/410 = 24/41, 240/250 = 24/25,
    // 240/52 = 60/13, (240 + 40)/103 = 280/103.
    security: company({
      statements: setShares(baseStatements(), {
        "2024Q2": 20,
        "2024Q3": 20,
        "2024Q4": 20,
        "2025Q1": 20,
        "2025Q2": 20,
      }),
    }),
    observations: [
      {
        session: "2024-08-15",
        close: CLOSE,
        expect: all("SHARE_LEVEL_UNSAFE"),
      },
      {
        session: "2024-11-15",
        close: CLOSE,
        expect: all("SHARE_LEVEL_UNSAFE"),
      },
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { PE: "6", PS: "3/5", PB: "1", PFCF: "24/5", EV: "29/10" },
      },
      {
        session: "2025-05-15",
        close: CLOSE,
        expect: {
          PE: "16/3",
          PS: "24/41",
          PB: "24/25",
          PFCF: "60/13",
          EV: "280/103",
        },
      },
    ],
  },
  {
    id: "C23",
    covers: [23],
    title: "a missing count starts the confirmation again",
    // 2024Q2 = 20 (first), 2024Q3 count missing (restarts), 2024Q4 = 20 (first again),
    // 2025Q1 = 20 (second), 2025Q2 = 20 (third: accepted). Without the restart 2025Q1 would be the
    // third. As of 2025Q2, MC 240: 240/50 = 24/5, 240/418 = 120/209, 240/260 = 12/13,
    // 240/54 = 40/9, (240 + 30)/106 = 135/53.
    security: company({
      statements: setShares(baseStatements(), {
        "2024Q2": 20,
        "2024Q3": undefined,
        "2024Q4": 20,
        "2025Q1": 20,
        "2025Q2": 20,
      }),
    }),
    observations: [
      {
        session: "2024-11-15",
        close: CLOSE,
        expect: all("MISSING_SHARE_COUNT"),
      },
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: all("SHARE_LEVEL_UNSAFE"),
      },
      {
        session: "2025-05-15",
        close: CLOSE,
        expect: all("SHARE_LEVEL_UNSAFE"),
      },
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: {
          PE: "24/5",
          PS: "120/209",
          PB: "12/13",
          PFCF: "40/9",
          EV: "135/53",
        },
      },
    ],
  },
  {
    id: "C23b",
    covers: [23],
    title: "a missing quarter starts the confirmation again",
    // Income 2024Q3 dropped; shares 20 from 2024Q2. 2024Q4 follows a gap: first again; 2025Q1
    // second; 2025Q2 third, accepted. Windows through 2024Q3 are incomplete for P/E, P/S and
    // EV/EBITDA; P/B and P/FCF read the count. As of 2025Q2: P/B 240/260 = 12/13,
    // P/FCF 240/54 = 40/9.
    security: company({
      statements: setShares(drop(baseStatements(), "INCOME", "2024Q3"), {
        "2024Q2": 20,
        "2024Q4": 20,
        "2025Q1": 20,
        "2025Q2": 20,
      }),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: off("SHARE_LEVEL_UNSAFE"),
          PFCF: off("SHARE_LEVEL_UNSAFE"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      {
        session: "2025-05-15",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: off("SHARE_LEVEL_UNSAFE"),
          PFCF: off("SHARE_LEVEL_UNSAFE"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: "12/13",
          PFCF: "40/9",
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
    ],
  },
  {
    id: "C24",
    covers: [24],
    title: "an unexplained share restatement withholds the restated revision",
    // 2024Q4 Income observed 2025-03-03 with 10 shares; restated 2025-04-01 to 11 (+10 %, more than
    // 2 %, inside the 25 % level). No measured re-base explains it.
    security: company({
      statements: revision(
        edit(baseStatements(), "INCOME", "2024Q4", (statement) => ({
          ...statement,
          observedAt: "2025-03-03T12:00:00.000Z",
        })),
        "INCOME",
        "2024Q4",
        {
          availableFromDate: "2025-04-01",
          observedAt: "2025-04-01T12:00:00.000Z",
          values: { weightedAverageShsOutDil: 11 },
        },
        "b",
      ),
    }),
    observations: [
      { session: "2025-03-31", close: CLOSE, expect: AS_OF_2024Q4 },
      {
        session: "2025-04-01",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED"),
      },
    ],
  },
  {
    id: "C25",
    covers: [25, 35, 36, 39],
    title:
      "an explained 5:4 restatement; the basis factor before the event, withheld on and after it",
    // P: 2024Q4 Income observed 2025-03-03 (10 shares). Re-base dated 2025-03-10, ratio 1.25
    // (5:4, plain), detected 2025-03-11. R: restated 2025-04-15 to 12.5 shares (+25 %: inside the
    // level; 12.5/10 = 1.25 = the ratio). The re-base is new to P (detected after it), dated less
    // than 30 days before P's observation, known by R's: explained. R is observed 36 days after the
    // event (no settling) and after the detection: K = 1 (plain).
    // MC with R: 12 · 12.5 = 150 -> P/E 15/4, P/S 3/8, P/B 5/8, P/FCF 3, EV/EBITDA 2.
    // P was observed before the event and its detection: before 2025-03-10 K = 1.25 would make
    // MC = 12 · 1.25 · 10 = 150 again, but P's count was first observed on 2025-03-03, within 30 days
    // before the event (from 2025-02-08), for a quarter that ended before it: rule 5 before the event
    // (owner, 2026-10-06) withholds it there. From 2025-03-10 on it is withheld (rule 6).
    security: company({
      statements: revision(
        edit(baseStatements(), "INCOME", "2024Q4", (statement) => ({
          ...statement,
          observedAt: "2025-03-03T12:00:00.000Z",
        })),
        "INCOME",
        "2024Q4",
        {
          availableFromDate: "2025-04-15",
          observedAt: "2025-04-15T12:00:00.000Z",
          values: { weightedAverageShsOutDil: 12.5 },
        },
        "b",
      ),
      events: [
        measured(
          { effectiveDate: "2025-03-10" },
          "1.25",
          "2025-03-11T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-03-07",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      { session: "2025-03-10", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2025-04-14", close: CLOSE, expect: all("BASIS_WITHHELD") },
      {
        session: "2025-04-15",
        close: CLOSE,
        expect: { PE: "15/4", PS: "3/8", PB: "5/8", PFCF: "3", EV: "2" },
      },
    ],
  },
  {
    id: "C25b",
    covers: [24],
    title: "a re-base of another ratio explains nothing",
    // C25 with the re-base measured at 3:2 (1.5, plain) instead of 5:4. Before it P would take
    // K = 1.5, but rule 5 before the event withholds it, as in C25. R restates 10 to 12.5 (x1.25), which is not
    // within 2 % of 1.5 (|1.25 - 1.5| = 0.25 > 0.03): unexplained, although it holds rule 2's level
    // (exactly +25 %) and is observed after the detection and outside rule 5's month.
    security: company({
      statements: revision(
        edit(baseStatements(), "INCOME", "2024Q4", (statement) => ({
          ...statement,
          observedAt: "2025-03-03T12:00:00.000Z",
        })),
        "INCOME",
        "2024Q4",
        {
          availableFromDate: "2025-04-15",
          observedAt: "2025-04-15T12:00:00.000Z",
          values: { weightedAverageShsOutDil: 12.5 },
        },
        "b",
      ),
      events: [
        measured(
          { effectiveDate: "2025-03-10" },
          "1.5",
          "2025-03-11T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-03-07",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      { session: "2025-03-10", close: CLOSE, expect: all("BASIS_WITHHELD") },
      {
        session: "2025-04-15",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED"),
      },
    ],
  },
  {
    id: "C26",
    covers: [26],
    title:
      "a re-base dated 30 or more days before the previous revision was observed explains nothing",
    // As C25, but the re-base is dated 2024-12-01 (92 days before P's observation) and detected
    // 2025-03-11. P was observed after the event and before its detection: withheld on every
    // session. R is unexplained.
    security: company({
      statements: revision(
        edit(baseStatements(), "INCOME", "2024Q4", (statement) => ({
          ...statement,
          observedAt: "2025-03-03T12:00:00.000Z",
        })),
        "INCOME",
        "2024Q4",
        {
          availableFromDate: "2025-04-15",
          observedAt: "2025-04-15T12:00:00.000Z",
          values: { weightedAverageShsOutDil: 12.5 },
        },
        "b",
      ),
      events: [
        measured(
          { effectiveDate: "2024-12-01" },
          "1.25",
          "2025-03-11T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-03-07", close: CLOSE, expect: all("BASIS_WITHHELD") },
      {
        session: "2025-04-15",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED"),
      },
    ],
  },
  {
    id: "C27",
    covers: [27],
    title:
      "an old re-base of the same ratio, known before the previous revision, explains nothing",
    // Re-base dated 2024-06-03, ratio 1.25, detected 2025-02-01 — before P's observation, and dated
    // before it. P (observed after the detection) reads K = 1 (plain): the 2024Q4 readings. R is
    // unexplained.
    security: company({
      statements: revision(
        edit(baseStatements(), "INCOME", "2024Q4", (statement) => ({
          ...statement,
          observedAt: "2025-03-03T12:00:00.000Z",
        })),
        "INCOME",
        "2024Q4",
        {
          availableFromDate: "2025-04-15",
          observedAt: "2025-04-15T12:00:00.000Z",
          values: { weightedAverageShsOutDil: 12.5 },
        },
        "b",
      ),
      events: [
        measured(
          { effectiveDate: "2024-06-03" },
          "1.25",
          "2025-02-01T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-03-07", close: CLOSE, expect: AS_OF_2024Q4 },
      {
        session: "2025-04-15",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED"),
      },
    ],
  },
  {
    id: "C27b",
    covers: [26, 27],
    title:
      "an old re-base measured only after the previous revision (a first verification) explains nothing",
    // Re-base dated 2024-06-03 detected 2025-03-05 (after P's observation: "new" by detection), but
    // dated 273 days before P's observation. P: observed after the event, before the detection —
    // withheld. R is unexplained.
    security: company({
      statements: revision(
        edit(baseStatements(), "INCOME", "2024Q4", (statement) => ({
          ...statement,
          observedAt: "2025-03-03T12:00:00.000Z",
        })),
        "INCOME",
        "2024Q4",
        {
          availableFromDate: "2025-04-15",
          observedAt: "2025-04-15T12:00:00.000Z",
          values: { weightedAverageShsOutDil: 12.5 },
        },
        "b",
      ),
      events: [
        measured(
          { effectiveDate: "2024-06-03" },
          "1.25",
          "2025-03-05T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-03-07", close: CLOSE, expect: all("BASIS_WITHHELD") },
      {
        session: "2025-04-15",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED"),
      },
    ],
  },
  {
    id: "C28",
    covers: [28],
    title:
      "a historical non-plain provider entry (WDC-like 1323:1000) withholds every session until each family covers it",
    // Entry 2025-02-24, before verifiedAt: history. Income and Cash Flow 2025Q1 (period end
    // 2025-03-31) arrive 2025-05-15; the balance sheet's 2025Q1 only on 2025-06-02.
    security: company({
      statements: baseStatements().map((statement) =>
        statement.statementType === "BALANCE_SHEET" &&
        statement.fiscalDate === "2025-03-31"
          ? { ...statement, availableFromDate: "2025-06-02" }
          : statement,
      ),
      splits: [split("2025-02-24", "1323", "1000")],
    }),
    observations: [
      {
        session: "2024-06-03",
        close: CLOSE,
        expect: all("HISTORICAL_DISTRIBUTION_ENTRY"),
      },
      {
        session: "2025-02-21",
        close: CLOSE,
        expect: all("HISTORICAL_DISTRIBUTION_ENTRY"),
      },
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: all("HISTORICAL_DISTRIBUTION_ENTRY"),
      },
      {
        session: "2025-05-15",
        close: CLOSE,
        expect: {
          PE: "8/3",
          PS: "12/41",
          PB: off("HISTORICAL_DISTRIBUTION_ENTRY"),
          PFCF: "30/13",
          EV: off("HISTORICAL_DISTRIBUTION_ENTRY"),
        },
      },
      { session: "2025-06-02", close: CLOSE, expect: AS_OF_2025Q1 },
    ],
  },
  {
    id: "C29",
    covers: [29],
    title: "an ordinary historical split masks nothing",
    security: company({ splits: [split("2024-06-10", "2", "1")] }),
    observations: [
      { session: "2024-06-07", close: CLOSE, expect: AS_OF_2024Q1 },
      { session: "2024-06-10", close: CLOSE, expect: AS_OF_2024Q1 },
      { session: "2025-03-03", close: CLOSE, expect: AS_OF_2024Q4 },
    ],
  },
  {
    id: "C30",
    covers: [30],
    title:
      "a historical reverse split, and the other plain ratios, mask nothing",
    security: company({
      splits: [
        split("2023-06-01", "1", "10"),
        split("2023-09-01", "3", "2"),
        split("2023-10-02", "6", "4"),
        split("2023-11-01", "5", "4"),
        split("2023-12-01", "4", "3"),
        split("2024-01-02", "5", "2"),
        split("2024-02-01", "5", "3"),
        split("2024-04-01", "2", "5"),
        split("2024-06-10", "20", "1"),
        split("2024-07-01", "1", "32"),
      ],
    }),
    observations: [
      { session: "2024-06-07", close: CLOSE, expect: AS_OF_2024Q1 },
      { session: "2025-03-03", close: CLOSE, expect: AS_OF_2024Q4 },
    ],
  },
  {
    id: "C30b",
    covers: [28, 30],
    title:
      "a plain ratio with another label, an unreadable 0:1 entry, a stock dividend and a rare split are possible distributions",
    // Each entry is dated 2024-06-10: until every family's latest quarter ends on or after it
    // (2024Q2, period end 2024-06-30, available 2024-08-15), every ratio is withheld.
    security: company({
      splits: [
        split("2024-06-10", "2", "1", "stock-dividend"),
        split("2024-06-10", "0", "1"),
        split("2024-06-10", "51", "50"),
        split("2024-06-10", "9", "5"),
        split("2024-06-10", "2", "1", null),
      ],
    }),
    observations: [
      {
        session: "2024-06-07",
        close: CLOSE,
        expect: all("HISTORICAL_DISTRIBUTION_ENTRY"),
      },
      {
        session: "2024-08-14",
        close: CLOSE,
        expect: all("HISTORICAL_DISTRIBUTION_ENTRY"),
      },
      { session: "2024-08-15", close: CLOSE, expect: AS_OF_2024Q2 },
    ],
  },
  {
    id: "C31",
    covers: [31, 39],
    title:
      "a forward listed event not yet re-based holds its date through the next 30 calendar days",
    // A 1:10 entry dated 2026-10-06, after verifiedAt 2026-10-02. As of 2025Q2 otherwise.
    security: company({ splits: [split("2026-10-06", "1", "10")] }),
    observations: [
      { session: "2026-10-05", close: CLOSE, expect: AS_OF_2025Q2 },
      {
        session: "2026-10-06",
        close: CLOSE,
        expect: all("FORWARD_EVENT_UNMEASURED"),
      },
      {
        session: "2026-11-05",
        close: CLOSE,
        expect: all("FORWARD_EVENT_UNMEASURED"),
      },
      { session: "2026-11-06", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "C31b",
    covers: [31, 35, 36],
    title:
      "a forward entry measured within seven days stops holding; the basis factor takes over",
    // Measured 1:10 re-base dated 2026-10-13 (seven days after the entry), ratio 0.1, detected
    // 2026-10-14. R (2025Q2, observed 2026-08-31) predates both: before 2026-10-13 K = 0.1,
    // MC = 12 · 0.1 · 10 = 12 -> P/E 12/50 = 6/25, P/S 12/418 = 6/209, P/B 12/260 = 3/65,
    // P/FCF 12/54 = 2/9, EV (12 + 30)/106 = 21/53; from 2026-10-13, withheld.
    security: company({
      splits: [split("2026-10-06", "1", "10")],
      events: [
        measured(
          { effectiveDate: "2026-10-13" },
          "0.1",
          "2026-10-14T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2026-10-06",
        close: CLOSE,
        expect: {
          PE: "6/25",
          PS: "6/209",
          PB: "3/65",
          PFCF: "2/9",
          EV: "21/53",
        },
      },
      { session: "2026-10-13", close: CLOSE, expect: all("BASIS_WITHHELD") },
    ],
  },
  {
    id: "C31c",
    covers: [31],
    title:
      "a measured re-base eight days after a forward entry does not match it",
    // Measured dated 2026-10-14 (eight days after): the entry still holds 2026-10-06..2026-11-05.
    // R predates the re-base: K = 0.1 before 2026-10-14 (MC 12, as C31b), withheld from it.
    security: company({
      splits: [split("2026-10-06", "1", "10")],
      events: [
        measured(
          { effectiveDate: "2026-10-14" },
          "0.1",
          "2026-10-15T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2026-10-05",
        close: CLOSE,
        expect: {
          PE: "6/25",
          PS: "6/209",
          PB: "3/65",
          PFCF: "2/9",
          EV: "21/53",
        },
      },
      {
        session: "2026-10-06",
        close: CLOSE,
        expect: all("FORWARD_EVENT_UNMEASURED"),
      },
      {
        session: "2026-10-14",
        close: CLOSE,
        expect: all("BASIS_WITHHELD", ["FORWARD_EVENT_UNMEASURED"]),
      },
    ],
  },
  {
    id: "C31d",
    covers: [31, 39],
    title: "an entry on the verification day is history, not forward",
    // The base company (every statement observed 2026-08-31), verified 2026-10-02 05:00, and a
    // plain 2:1 entry on 2026-10-02 itself. An entry dated on or before the verification day is
    // history: no forward hold, but every count observed before it (all of them, on 2026-08-31) is
    // withheld by rule 4.2, on every session.
    security: company({ splits: [split("2026-10-02", "2", "1")] }),
    observations: [
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: all("COUNT_PREDATES_HISTORICAL_ENTRY"),
      },
      {
        session: "2026-10-02",
        close: CLOSE,
        expect: all("COUNT_PREDATES_HISTORICAL_ENTRY"),
      },
    ],
  },
  {
    id: "C32",
    covers: [32, 33, 34],
    title:
      "a measured possible distribution: withheld before it, then until statements cover it",
    // Measured 2025-06-02, ratio 1.046 (not plain), detected 2025-06-05. Every statement observed
    // 2026-08-31, after the detection: K is withheld before the event; on and after it K = 1 but
    // rule 7 needs every family's latest quarter to end on or after 2025-06-02 — 2025Q2's
    // statements, available 2025-08-14.
    security: company({ events: [DELTA_MEASURED] }),
    observations: [
      { session: "2025-05-30", close: CLOSE, expect: all("BASIS_WITHHELD") },
      {
        session: "2025-06-02",
        close: CLOSE,
        expect: all("POST_DISTRIBUTION_STATEMENTS_STALE"),
      },
      {
        session: "2025-08-13",
        close: CLOSE,
        expect: all("POST_DISTRIBUTION_STATEMENTS_STALE"),
      },
      { session: "2025-08-14", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "C32b",
    covers: [33, 34],
    title:
      "a lagging balance sheet keeps P/B and EV/EBITDA withheld after a distribution",
    // As C32 with the 2025Q2 balance sheet available only on 2025-09-02.
    security: company({
      statements: baseStatements().map((statement) =>
        statement.statementType === "BALANCE_SHEET" &&
        statement.fiscalDate === "2025-06-30"
          ? { ...statement, availableFromDate: "2025-09-02" }
          : statement,
      ),
      events: [DELTA_MEASURED],
    }),
    observations: [
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: {
          PE: "12/5",
          PS: "60/209",
          PB: off("POST_DISTRIBUTION_STATEMENTS_STALE"),
          PFCF: "20/9",
          EV: off("POST_DISTRIBUTION_STATEMENTS_STALE"),
        },
      },
      { session: "2025-09-02", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "C35",
    covers: [35, 36, 39],
    title:
      "a measured 2:1 split: K before it for a count observed before it, withheld on its date, nothing after the detection",
    // Statements observed the day they became available. Measured 2025-06-02, ratio 2, detected
    // 2025-06-05. R as of 2024Q4 was observed 2025-03-03, before the event and its detection and more
    // than 30 days before it: on 2025-05-14, K = 2, MC = 240 -> 240/40 = 6, 240/400 = 3/5,
    // 240/240 = 1, 240/50 = 24/5, (240 + 50)/100 = 29/10. R as of 2025Q1 was first observed
    // 2025-05-15, within 30 days before the event (from 2025-05-03): rule 5 before the event (owner,
    // 2026-10-06) withholds it before 2025-06-02. From 2025-06-02: withheld (rule 6). As of 2025Q2, R was
    // observed 2025-08-14, after the detection and 73 days after the event: K = 1.
    security: company({
      statements: baseStatements(observedWhenAvailable),
      events: [
        measured(
          { effectiveDate: "2025-06-02" },
          "2",
          "2025-06-05T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-05-14",
        close: CLOSE,
        expect: { PE: "6", PS: "3/5", PB: "1", PFCF: "24/5", EV: "29/10" },
      },
      {
        session: "2025-05-30",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      { session: "2025-06-02", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2025-08-13", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2025-08-14", close: CLOSE, expect: AS_OF_2025Q2 },
      // The Monitor's provisional row on the event date reads 2025-05-30's statements, but the
      // basis factor on its own session: withheld.
      {
        session: "2025-06-02",
        close: CLOSE,
        statementDate: "2025-05-30",
        expect: all("BASIS_WITHHELD"),
      },
    ],
  },
  {
    id: "C35b",
    covers: [35],
    title:
      "a count observed between an event and its detection is withheld on every session, before the event too",
    // As C35, with 2025Q1's Income observed 2025-06-03 (after the event, before its detection).
    // Rule 5 also holds it: observed one day after the event, for a quarter that ended before it.
    security: company({
      statements: edit(
        baseStatements(observedWhenAvailable),
        "INCOME",
        "2025Q1",
        (statement) => ({
          ...statement,
          observedAt: "2025-06-03T12:00:00.000Z",
        }),
      ),
      events: [
        measured(
          { effectiveDate: "2025-06-02" },
          "2",
          "2025-06-05T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-05-30",
        close: CLOSE,
        expect: all("EVENT_SETTLING", ["BASIS_WITHHELD"]),
      },
    ],
  },
  {
    id: "C37",
    covers: [37],
    title: "a security whose price history was never verified has no ratio",
    security: company({ verifiedAt: null }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: all("UNVERIFIED_PRICE_BASIS"),
      },
    ],
  },
  {
    id: "C38a",
    covers: [38],
    title:
      "generation N of a store (no re-base yet): the 2024Q4 readings — one side of a re-base during a read",
    security: company(),
    observations: [
      { session: "2025-03-07", close: CLOSE, expect: AS_OF_2024Q4 },
    ],
  },
  {
    id: "C38b",
    covers: [38],
    title:
      "generation N+1 of the same store (a re-base measured 2026-10-02): the other side; a reader must never combine them",
    // Measured 2025-02-24, ratio 2, detected 2026-10-02T06:00Z; R (observed 2026-08-31) was
    // observed after the event and before its detection: withheld on every session.
    security: company({
      events: [
        measured(
          { effectiveDate: "2025-02-24" },
          "2",
          "2026-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-03-07", close: CLOSE, expect: all("BASIS_WITHHELD") },
    ],
  },
  {
    id: "C39",
    covers: [39],
    title: "rule 4.2 and rule 5 at their day boundaries",
    // A plain 2:1 history entry dated 2026-09-01 (before verifiedAt). As of 2025Q2.
    // Observed 2026-08-31T23:59:59.999Z: before the entry -> 4.2.
    security: company({
      statements: observeAll(baseStatements(), "2026-08-31T23:59:59.999Z"),
      splits: [split("2026-09-01", "2", "1")],
    }),
    observations: [
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: all("COUNT_PREDATES_HISTORICAL_ENTRY"),
      },
    ],
  },
  {
    id: "C39b",
    covers: [39],
    title:
      "observed on the entry's date: no longer before it, but settling for 30 days",
    security: company({
      statements: observeAll(baseStatements(), "2026-09-01T00:00:00.000Z"),
      splits: [split("2026-09-01", "2", "1")],
    }),
    observations: [
      { session: "2025-08-14", close: CLOSE, expect: all("EVENT_SETTLING") },
    ],
  },
  {
    id: "C39c",
    covers: [39],
    title: "observed on the 30th day after the entry: still settling",
    security: company({
      statements: observeAll(baseStatements(), "2026-09-30T23:59:59.999Z"),
      splits: [split("2026-09-01", "2", "1")],
    }),
    observations: [
      { session: "2025-08-14", close: CLOSE, expect: all("EVENT_SETTLING") },
    ],
  },
  {
    id: "C39d",
    covers: [39],
    title: "observed 30 days after the entry: settled",
    security: company({
      statements: observeAll(baseStatements(), "2026-10-01T00:00:00.000Z"),
      splits: [split("2026-09-01", "2", "1")],
    }),
    observations: [
      { session: "2025-08-14", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "C39e",
    covers: [39],
    title:
      "a count for a quarter that ends after the event is the company's own: observed within the month, it is not settling",
    // Filings observed when available, 2025Q2's (period end 2025-06-30) moved to Monday 2025-07-21.
    // A plain 2:1 entry on 2025-06-27, history. Before 2025-07-21 R is 2025Q1, observed 2025-05-15,
    // before the entry: rule 4.2. On 2025-07-21 R is 2025Q2, observed 24 days after the entry, but
    // its quarter ended after it, so rule 5 does not hold it: the readings as of 2025Q2.
    security: company({
      statements: baseStatements(observedWhenAvailable).map((statement) =>
        statement.fiscalDate === "2025-06-30"
          ? {
              ...statement,
              availableFromDate: "2025-07-21",
              observedAt: "2025-07-21T12:00:00.000Z",
            }
          : statement,
      ),
      splits: [split("2025-06-27", "2", "1")],
    }),
    observations: [
      {
        session: "2025-07-18",
        close: CLOSE,
        expect: all("COUNT_PREDATES_HISTORICAL_ENTRY"),
      },
      { session: "2025-07-21", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "C39f",
    covers: [39],
    title:
      "a count observed on an entry's own date is not before it (rule 4.2), and its quarter ending on that date is not settling",
    // A plain 2:1 entry on Monday 2025-06-30, history. 2025Q2 (period end 2025-06-30) filed, and
    // observed, that same day — the boundary, however early such a filing would be. Before it R is
    // 2025Q1, observed 2025-05-15, before the entry: rule 4.2. On 2025-06-30 R is observed on the
    // entry's date (not before it) for a quarter that did not end before it (not settling): read.
    security: company({
      statements: baseStatements(observedWhenAvailable).map((statement) =>
        statement.fiscalDate === "2025-06-30"
          ? {
              ...statement,
              availableFromDate: "2025-06-30",
              observedAt: "2025-06-30T12:00:00.000Z",
            }
          : statement,
      ),
      splits: [split("2025-06-30", "2", "1")],
    }),
    observations: [
      {
        session: "2025-06-27",
        close: CLOSE,
        expect: all("COUNT_PREDATES_HISTORICAL_ENTRY"),
      },
      { session: "2025-06-30", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "C40",
    covers: [40],
    title:
      "an undated re-base: K up to its interval's start, withheld inside it and on its last session",
    // Measured in (2025-06-02, 2025-06-06], ratio 2, detected 2025-06-07. R as of 2024Q4 (observed
    // 2025-03-03) reads at K = 2 on 2025-05-14, as in C35. R as of 2025Q1 was first observed
    // 2025-05-15: within 30 days before the interval's first possible day (2025-06-03, so from
    // 2025-05-04), for a quarter that ended before it, so rule 5 before the event withholds it on
    // every session before the interval's last day — 2025-06-02, and 2025-06-03 inside the interval,
    // where rule 6 withholds it too. 2025-06-06 is the interval's last session, on the new basis:
    // withheld by rule 6 only.
    security: company({
      statements: baseStatements(observedWhenAvailable),
      events: [
        measured(
          { effectiveFrom: "2025-06-02", effectiveTo: "2025-06-06" },
          "2",
          "2025-06-07T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-05-14",
        close: CLOSE,
        expect: { PE: "6", PS: "3/5", PB: "1", PFCF: "24/5", EV: "29/10" },
      },
      {
        session: "2025-06-02",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      {
        session: "2025-06-03",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", ["BASIS_WITHHELD"]),
      },
      { session: "2025-06-06", close: CLOSE, expect: all("BASIS_WITHHELD") },
    ],
  },
  {
    id: "C40b",
    covers: [40],
    title:
      "an undated possible distribution, for counts observed after its detection: withheld up to its last session, then rule 7",
    // Measured in (2025-06-02, 2025-06-06], ratio 1.046, detected 2025-06-07; statements observed
    // 2026-08-31. Before the interval and inside it: withheld (not plain). On 2025-06-06 K = 1, and
    // rule 7 needs statements covering 2025-06-06: 2025Q2's, from 2025-08-14.
    security: company({
      events: [
        measured(
          { effectiveFrom: "2025-06-02", effectiveTo: "2025-06-06" },
          "1.046",
          "2025-06-07T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-06-02", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2025-06-05", close: CLOSE, expect: all("BASIS_WITHHELD") },
      {
        session: "2025-06-06",
        close: CLOSE,
        expect: all("POST_DISTRIBUTION_STATEMENTS_STALE"),
      },
      { session: "2025-08-14", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "C40c",
    covers: [40],
    title:
      "an undated possible distribution's last session is on the new basis: read once the statements cover it",
    // Measured in (2025-06-24, 2025-06-30], ratio 1.046, detected 2025-06-30 06:00; 2025Q2 (period
    // end 2025-06-30) filed and observed that day at noon, after the detection — early, to put the
    // boundary within reach. Before the interval and inside it every count (observed after the
    // detection) is withheld: the event is not plain. On 2025-06-30, the interval's last session,
    // the event has happened: K = 1, and 2025Q2 covers it (rule 7), so the readings as of 2025Q2.
    security: company({
      statements: baseStatements().map((statement) =>
        statement.fiscalDate === "2025-06-30"
          ? {
              ...statement,
              availableFromDate: "2025-06-30",
              observedAt: "2025-06-30T12:00:00.000Z",
            }
          : statement,
      ),
      events: [
        measured(
          { effectiveFrom: "2025-06-24", effectiveTo: "2025-06-30" },
          "1.046",
          "2025-06-30T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-06-24", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2025-06-27", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2025-06-30", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "C41",
    covers: [],
    title:
      "a bounded unexplained change withholds exactly the sessions it changed, for a count observed before its detection",
    // Changed 2024-12-02..2024-12-31, detected 2025-01-15. Real-time observation: as of 2024Q3, R
    // was observed 2024-11-15, before the detection. Outside the block it reads as usual. On
    // 2025-03-03 R (2024Q4) was observed after the detection: nothing is withheld for it.
    security: company({
      statements: baseStatements(observedWhenAvailable),
      events: [
        {
          kind: "UNEXPLAINED",
          effectiveFrom: "2024-12-02",
          effectiveTo: "2024-12-31",
          detectedAt: "2025-01-15T12:00:00.000Z",
        },
      ],
    }),
    observations: [
      { session: "2024-11-29", close: CLOSE, expect: AS_OF_2024Q3 },
      { session: "2024-12-02", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2024-12-31", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2025-01-02", close: CLOSE, expect: AS_OF_2024Q3 },
      { session: "2025-03-03", close: CLOSE, expect: AS_OF_2024Q4 },
    ],
  },
  {
    id: "C41b",
    covers: [],
    title:
      "an unexplained change reaching the earliest compared session withholds everything for a count observed before its detection",
    // Up to 2024-12-31, detected 2025-01-15. Real-time observation: on 2025-01-02 R (2024Q3) was
    // observed 2024-11-15, before the detection — withheld though the session is after the change.
    // On 2025-03-03 R (2024Q4) was observed after it: nothing is withheld.
    security: company({
      statements: baseStatements(observedWhenAvailable),
      events: [
        {
          kind: "UNEXPLAINED",
          effectiveFrom: null,
          effectiveTo: "2024-12-31",
          detectedAt: "2025-01-15T12:00:00.000Z",
        },
      ],
    }),
    observations: [
      { session: "2025-01-02", close: CLOSE, expect: all("BASIS_WITHHELD") },
      { session: "2025-03-03", close: CLOSE, expect: AS_OF_2024Q4 },
    ],
  },
  {
    id: "C41c",
    covers: [],
    title:
      "an unexplained change withholds nothing for a count observed after its detection, inside its sessions too",
    // The C41 block and an unbounded change, with every statement observed 2026-08-31, after both
    // detections: the replaced history is the basis those counts were observed on.
    security: company({
      events: [
        {
          kind: "UNEXPLAINED",
          effectiveFrom: "2024-12-02",
          effectiveTo: "2024-12-31",
          detectedAt: "2025-01-15T12:00:00.000Z",
        },
        {
          kind: "UNEXPLAINED",
          effectiveFrom: null,
          effectiveTo: "2024-12-31",
          detectedAt: "2025-01-15T12:00:00.000Z",
        },
      ],
    }),
    observations: [
      { session: "2024-12-02", close: CLOSE, expect: AS_OF_2024Q3 },
      { session: "2024-12-31", close: CLOSE, expect: AS_OF_2024Q3 },
    ],
  },
  {
    id: "C42",
    covers: [],
    title:
      "the Monitor's provisional row reads the newest closed session's statements at the live close",
    // On 2025-03-03 2024Q4 becomes eligible; the provisional row reads 2025-02-28's inputs (as of
    // 2024Q3) at the quote 12. The listed upcoming event is read on the provisional session itself.
    security: company({ splits: [split("2026-10-06", "1", "10")] }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        statementDate: "2025-02-28",
        expect: AS_OF_2024Q3,
      },
      {
        session: "2026-10-06",
        close: CLOSE,
        statementDate: "2026-10-05",
        expect: all("FORWARD_EVENT_UNMEASURED"),
      },
    ],
  },
  {
    id: "C43",
    covers: [],
    title:
      "numeric edges: a tiny positive denominator, the representability limit, a non-positive close",
    // 2024Q4 net income -27.99999999988: TTM 8 + 9 + 11 - 27.99999999988 = 0.00000000012, and
    // P/E = 120 / 1.2e-10 = 10^12 exactly: not representable.
    security: company({
      statements: setValue(
        baseStatements(),
        "INCOME",
        "2024Q4",
        "netIncome",
        -27.99999999988,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, PE: off("UNREPRESENTABLE_RESULT") },
      },
      // A close of 0, and of -1, is no market price.
      { session: "2025-03-04", close: "0", expect: all("INVALID_CLOSE") },
      { session: "2025-03-05", close: "-1", expect: all("INVALID_CLOSE") },
    ],
  },
  {
    id: "C43b",
    covers: [],
    title: "just inside the representability limit",
    // 2024Q4 net income -27.99999999987: TTM 1.3e-10, P/E = 120 / 1.3e-10 = 12000000000000/13
    // (about 923,076,923,076.92 < 10^12).
    security: company({
      statements: setValue(
        baseStatements(),
        "INCOME",
        "2024Q4",
        "netIncome",
        -27.99999999987,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: { ...AS_OF_2024Q4, PE: "12000000000000/13" },
      },
    ],
  },
  {
    id: "C43c",
    covers: [],
    title: "a huge share count and a tiny positive denominator",
    // Shares 1e10 in every quarter (no level change): MC = 12 · 1e10 = 1.2e11.
    // P/E 1.2e11/40 = 3e9, P/S 1.2e11/400 = 3e8, P/B 1.2e11/240 = 5e8, P/FCF 1.2e11/50 = 2.4e9,
    // EV (1.2e11 + 50)/100 = 120000000050/100 = 1200000000.5 = 2400000001/2.
    security: company({
      statements: baseStatements().map((statement) =>
        statement.statementType === "INCOME"
          ? {
              ...statement,
              values: { ...statement.values, weightedAverageShsOutDil: 1e10 },
            }
          : statement,
      ),
    }),
    observations: [
      {
        session: "2025-03-03",
        close: CLOSE,
        expect: {
          PE: "3000000000",
          PS: "300000000",
          PB: "500000000",
          PFCF: "2400000000",
          EV: "2400000001/2",
        },
      },
    ],
  },

  // -------------------------------------------------------------------------------------------
  // The owner's rulings of 2026-10-06 on the clean-room review's gaps (REPORT.md §31, G1–G3):
  // rule 3 compares `R` with its anchor, the latest earlier revision of the quarter that rule 3
  // accepted and that has a usable count; rule 2 confirms the walk's first count like any new
  // level. Before the rulings these cases read the doubled or the listing-quarter values the
  // review found wrong; each comment says what changed.
  // -------------------------------------------------------------------------------------------
  {
    id: "G1a",
    covers: [],
    title:
      "rule 3 anchor: a restated count stays withheld through a later revision of the same quarter",
    // Filings observed when available; a 2:1 entry listed for 2025-10-01, after the 2025-06-01
    // verification (forward). On 2025-09-02 the provider restates every Income quarter's count to 20
    // (new units, ahead of the ex-date): 2025Q2's revision "r" is 20 against its anchor, the
    // original "a" (10), with no measured re-base: unexplained, and not accepted. On 2025-09-10 it
    // revises 2025Q2 again ("s": another field, the count still 20). Its anchor is still "a" — "r"
    // was not accepted — so 20 against 10 is unexplained again: withheld. (Before the ruling rule 3
    // compared "s" with "r" only and read MC 12 x 20 = 240 against the old-basis close: P/E 24/5,
    // twice the coherent 12/5.) Rule 2 is no obstacle: every quarter reads 20, so 20 is the level
    // from 2023Q3 on. From 2025-10-01 the forward entry holds too (rule 8, through 2025-10-31); on
    // 2025-11-03 nothing has been measured and the restatement is still unexplained.
    // Rule 5 before the event (owner, 2026-10-06): "r" and "s", first observed on 2025-09-02 and 2025-09-10 — within 30 days
    // before the 2025-10-01 event, for a quarter that ended before it — is withheld by that rule
    // too on the sessions before the event.
    security: company({
      statements: revision(
        restateCounts(
          baseStatements(observedWhenAvailable),
          ALL_QUARTERS,
          20,
          "2025-09-02",
          "r",
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-09-10",
          observedAt: "2025-09-10T12:00:00.000Z",
          values: {
            weightedAverageShsOutDil: 20,
            weightedAverageShsOut: 20,
            grossProfit: 1,
          },
        },
        "s",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-10-01", "2", "1")],
    }),
    observations: [
      { session: "2025-08-29", close: CLOSE, expect: AS_OF_2025Q2 },
      {
        session: "2025-09-02",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-09-09",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-09-10",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-09-30",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-10-01",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", [
          "FORWARD_EVENT_UNMEASURED",
        ]),
      },
      {
        session: "2025-11-03",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", []),
      },
    ],
  },
  {
    id: "G1b",
    covers: [],
    title:
      "rule 3 anchor: a re-base measured after the later revision was observed explains nothing for it",
    // G1a after PR 1 measured the 2:1 re-base (dated 2025-10-01, detected 2025-10-02 06:00): the
    // stored closes before it are 6 and the entry is superseded by the measurement. The original
    // count, observed before the detection, takes K = 2 before the event: 6 x 2 x 10 = 120, as of
    // 2025Q2. Revisions "r" (2025-09-02) and "s" (2025-09-10) are both 20 against the anchor "a"
    // (10), and the re-base was detected after either was observed, so it explains neither: both
    // withheld. (Before the ruling "s" passed against "r" and read 6 x 2 x 20 = 240 — the doubled
    // readings, kept in history by K.) On and after the event a count observed before the detection
    // is withheld by rule 6 as well.
    // Rule 5 before the event (owner, 2026-10-06): "r" and "s", first observed on 2025-09-02 and 2025-09-10 — within 30 days
    // before the 2025-10-01 event, for a quarter that ended before it — is withheld by that rule
    // too on the sessions before the event.
    security: company({
      statements: revision(
        restateCounts(
          baseStatements(observedWhenAvailable),
          ALL_QUARTERS,
          20,
          "2025-09-02",
          "r",
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-09-10",
          observedAt: "2025-09-10T12:00:00.000Z",
          values: {
            weightedAverageShsOutDil: 20,
            weightedAverageShsOut: 20,
            grossProfit: 1,
          },
        },
        "s",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-10-01", "2", "1")],
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "2",
          "2025-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-08-29", close: "6", expect: AS_OF_2025Q2 },
      {
        session: "2025-09-02",
        close: "6",
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-09-10",
        close: "6",
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-09-30",
        close: "6",
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-10-01",
        close: "6",
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["BASIS_WITHHELD"]),
      },
      {
        session: "2025-11-20",
        close: "6",
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["BASIS_WITHHELD"]),
      },
    ],
  },
  {
    id: "G1c",
    covers: [],
    title:
      "rule 3 anchor: a revision observed after the re-base's detection is explained, and anchors the next",
    // G1b with two more 2025Q2 Income revisions. "t", observed 2025-11-03, still 20: against the
    // anchor "a" (10) it is a restatement, now explained — the 2:1 re-base is new to "a" (detected
    // 2025-10-02 06:00, after "a" was observed on 2025-08-14), dated 2025-10-01, after that
    // observation (so not 30 days or more before it), detected before "t" was observed, and
    // |20 - 2 x 10| = 0 <= 2 % of 20. "t" is accepted. Observed after the detection, on a session
    // on or after the event, K = 1; rule 5's month after 2025-10-01 ends on 2025-10-30, before "t"
    // was observed. MC = 6 x 20 = 120: the coherent readings as of 2025Q2.
    // "u", observed 2025-12-01 with 20.3 shares, is compared with its anchor "t" (20):
    // |20.3 - 20| = 0.3 <= 0.4, no explanation needed. MC = 6 x 20.3 = 121.8: P/E 121.8/50 =
    // 609/250, P/S 121.8/418 = 609/2090, P/B 121.8/260 = 609/1300, P/FCF 121.8/54 = 203/90,
    // EV/EBITDA (121.8 + 30)/106 = 759/530. On 2025-10-31 "s" is still in force: withheld.
    security: company({
      statements: revision(
        revision(
          revision(
            restateCounts(
              baseStatements(observedWhenAvailable),
              ALL_QUARTERS,
              20,
              "2025-09-02",
              "r",
            ),
            "INCOME",
            "2025Q2",
            {
              availableFromDate: "2025-09-10",
              observedAt: "2025-09-10T12:00:00.000Z",
              values: {
                weightedAverageShsOutDil: 20,
                weightedAverageShsOut: 20,
                grossProfit: 1,
              },
            },
            "s",
          ),
          "INCOME",
          "2025Q2",
          {
            availableFromDate: "2025-11-03",
            observedAt: "2025-11-03T12:00:00.000Z",
            values: {
              weightedAverageShsOutDil: 20,
              weightedAverageShsOut: 20,
              grossProfit: 2,
            },
          },
          "t",
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-12-01",
          observedAt: "2025-12-01T12:00:00.000Z",
          values: {
            weightedAverageShsOutDil: 20.3,
            weightedAverageShsOut: 20.3,
            grossProfit: 3,
          },
        },
        "u",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-10-01", "2", "1")],
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "2",
          "2025-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-10-31",
        close: "6",
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["BASIS_WITHHELD"]),
      },
      { session: "2025-11-03", close: "6", expect: AS_OF_2025Q2 },
      {
        session: "2025-12-01",
        close: "6",
        expect: {
          PE: "609/250",
          PS: "609/2090",
          PB: "609/1300",
          PFCF: "203/90",
          EV: "759/530",
        },
      },
    ],
  },
  {
    id: "G1d",
    covers: [],
    title:
      "rule 3 anchor: a restatement the provider takes back is read again against the anchor",
    // Filings observed when available. 2025Q2's Income is revised on 2025-09-02 to 20 shares ("r",
    // that quarter only), then on 2025-09-10 back to 10 ("s", another field changed). On
    // 2025-09-02 "r" is 20 against its anchor "a" (10), unexplained, and 20 is outside the level
    // 10 (rule 2's first disagreeing quarter): withheld by both. On 2025-09-10 "s"'s anchor is still
    // "a" — "r" was not accepted — and 10 against 10 is no restatement: the readings as of 2025Q2.
    // (Before the ruling rule 3 compared "s" with "r", 10 against 20, and withheld it.)
    security: company({
      statements: revision(
        revision(
          baseStatements(observedWhenAvailable),
          "INCOME",
          "2025Q2",
          {
            availableFromDate: "2025-09-02",
            observedAt: "2025-09-02T12:00:00.000Z",
            values: {
              weightedAverageShsOutDil: 20,
              weightedAverageShsOut: 20,
            },
          },
          "r",
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-09-10",
          observedAt: "2025-09-10T12:00:00.000Z",
          values: {
            weightedAverageShsOutDil: 10,
            weightedAverageShsOut: 10,
            grossProfit: 1,
          },
        },
        "s",
      ),
    }),
    observations: [
      {
        session: "2025-09-02",
        close: CLOSE,
        expect: all("SHARE_LEVEL_UNSAFE", ["SHARE_RESTATEMENT_UNEXPLAINED"]),
      },
      { session: "2025-09-10", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "G1e",
    covers: [],
    title:
      "rule 3 anchor: a late-observed amendment dated earlier is never the anchor of a revision observed before it",
    // G1b's restatement ("r", every quarter to 20, public and observed 2025-09-10) and 2:1 re-base
    // (dated 2025-10-01, detected 2025-10-02 06:00), plus a 2025Q2 amendment "m" filed 2025-09-05
    // and first observed 2025-10-05, with 20 shares: the loader dates it from its filing, public from
    // 2025-09-06. On 2025-09-08 "m" represents 2025Q2. Its anchor is "a" (10), the only revision
    // observed before it and public then; the re-base explains it (detected before "m" was observed,
    // after "a" was, dated after "a" was observed, |20 - 2 x 10| = 0), but 20 is outside the level
    // 10 the other quarters still hold (rule 2), and it was observed in rule 5's month after the
    // event for a quarter that ended before it: withheld. From 2025-09-10 "r" represents 2025Q2 (it
    // is public later). Its anchor is "a" again — "m" was observed after "r", so "r" is judged
    // against what was known on 2025-09-10 — and the re-base, detected after "r" was observed,
    // explains nothing: withheld. (Ordered by availability alone, "m" anchored "r", which then agreed
    // with it and read 6 x 2 x 20 = 240 at K = 2: P/E 24/5, twice the coherent 12/5.)
    // Rule 5 before the event (owner, 2026-10-06): "r", first observed on 2025-09-10 — within 30 days
    // before the 2025-10-01 event, for a quarter that ended before it — is withheld by that rule
    // too on the sessions before the event.
    security: company({
      statements: revision(
        restateCounts(
          baseStatements(observedWhenAvailable),
          ALL_QUARTERS,
          20,
          "2025-09-10",
          "r",
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-09-06",
          observedAt: "2025-10-05T12:00:00.000Z",
          values: {
            weightedAverageShsOutDil: 20,
            weightedAverageShsOut: 20,
            grossProfit: 1,
          },
        },
        "m",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-10-01", "2", "1")],
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "2",
          "2025-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-09-08",
        close: "6",
        expect: all("SHARE_LEVEL_UNSAFE", ["EVENT_SETTLING"]),
      },
      {
        session: "2025-09-15",
        close: "6",
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-09-30",
        close: "6",
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
    ],
  },
  {
    id: "G1f",
    covers: [],
    title:
      "rule 3 anchor: a re-base new to the anchor explains R, though a withheld revision between them was observed after it",
    // Filings observed when available, verified 2025-06-01, a 2:1 re-base dated 2025-10-01 and
    // detected 2025-10-02 06:00 (no provider entry). 2025Q2 is revised on 2025-11-05 to 13 shares
    // ("b"): 30 % from its anchor "a" (10), which the 2:1 re-base does not explain (|13 - 20| > 0.4):
    // withheld, and 13 is outside the level 10 as well. On 2025-11-20 every quarter is restated to
    // 20 ("r"). 2025Q2's "r" is judged against its anchor "a", not against "b": the re-base is new to
    // "a" (detected after it was observed, dated after it), known when "r" was observed, and
    // |20 - 2 x 10| = 0 — explained, although it is not new to "b" (observed after the detection and
    // after the event). Observed after the detection, on a session after the event, K = 1: MC =
    // 6 x 20 = 120, the coherent readings as of 2025Q2.
    security: company({
      statements: restateCounts(
        revision(
          baseStatements(observedWhenAvailable),
          "INCOME",
          "2025Q2",
          {
            availableFromDate: "2025-11-05",
            observedAt: "2025-11-05T12:00:00.000Z",
            values: {
              weightedAverageShsOutDil: 13,
              weightedAverageShsOut: 13,
            },
          },
          "b",
        ),
        ALL_QUARTERS,
        20,
        "2025-11-20",
        "r",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "2",
          "2025-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-11-05",
        close: "6",
        expect: all("SHARE_LEVEL_UNSAFE", ["SHARE_RESTATEMENT_UNEXPLAINED"]),
      },
      { session: "2025-11-20", close: "6", expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "G1g",
    covers: [],
    title:
      "rule 3 anchor: only the revisions public on the session are walked, in the order they were observed",
    // Filings observed when available: 2025Q2's "a" (10) on 2025-08-14. "x" (10.2) is observed on
    // 2025-09-09 but public only from 2025-09-11; "y" (10.4) is observed and public on 2025-09-10.
    // On 2025-09-10 "y" represents the quarter and "x" is not public, so "y"'s anchor is "a":
    // |10.4 - 10| = 0.4 > 0.2, unexplained. On 2025-09-11 "x" represents it (the later
    // availability); "y" was observed after "x" and is not in its walk, so "x"'s anchor is "a":
    // |10.2 - 10| = 0.2, exactly 2 %, accepted. MC = 12 x 10.2 = 122.4: P/E 122.4/50 = 306/125,
    // P/S 122.4/418 = 306/1045, P/B 122.4/260 = 153/325, P/FCF 122.4/54 = 34/15, EV/EBITDA
    // (122.4 + 30)/106 = 381/265.
    security: company({
      statements: revision(
        revision(
          baseStatements(observedWhenAvailable),
          "INCOME",
          "2025Q2",
          {
            availableFromDate: "2025-09-11",
            observedAt: "2025-09-09T12:00:00.000Z",
            values: {
              weightedAverageShsOutDil: 10.2,
              weightedAverageShsOut: 10.2,
            },
          },
          "x",
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-09-10",
          observedAt: "2025-09-10T12:00:00.000Z",
          values: {
            weightedAverageShsOutDil: 10.4,
            weightedAverageShsOut: 10.4,
          },
        },
        "y",
      ),
    }),
    observations: [
      {
        session: "2025-09-10",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", []),
      },
      {
        session: "2025-09-11",
        close: CLOSE,
        expect: {
          PE: "306/125",
          PS: "306/1045",
          PB: "153/325",
          PFCF: "34/15",
          EV: "381/265",
        },
      },
    ],
  },
  {
    id: "G1h",
    covers: [],
    title:
      "rule 3 anchor: revisions one observation delivers are ordered as the representing revision is picked",
    // A first load: every statement observed on 2026-08-31 at noon, among them a 2025Q2 Income
    // amendment public from 2025-09-06 with 11 shares, whose content hash sorts before the original's.
    // By one observation the order is the representing one — the earlier availability first — so
    // the original (10) is the amendment's anchor: 10 % with no re-base, unexplained. Rule 2 holds
    // (11 is inside 10's 25 %). On 2025-09-05 the amendment is not yet public: as of 2025Q2.
    security: company({
      statements: revision(
        baseStatements(),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-09-06",
          values: {
            weightedAverageShsOutDil: 11,
            weightedAverageShsOut: 11,
          },
        },
        "0",
      ),
    }),
    observations: [
      { session: "2025-09-05", close: CLOSE, expect: AS_OF_2025Q2 },
      {
        session: "2025-09-08",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", []),
      },
    ],
  },
  {
    id: "G2",
    covers: [],
    title:
      "rule 3 anchor: a count-less revision anchors nothing, so the restatement after it is compared with the last count",
    // 2025Q2's Income is revised on 2025-09-02 without a diluted count ("q": no count, no reading),
    // then on 2025-09-10 every Income quarter is restated to 20 ("r"). 2025Q2's "r" has two earlier
    // revisions: "q", which has no usable count, and "a" (10), its anchor. 20 against 10 with no
    // measured re-base is unexplained: withheld. (Before the ruling rule 3 compared "r" with "q"
    // only, found nothing to compare and read the doubled values.) From 2025-10-01 the forward
    // entry holds as well.
    // Rule 5 before the event (owner, 2026-10-06): "r", first observed on 2025-09-10 — within 30 days
    // before the 2025-10-01 event, for a quarter that ended before it — is withheld by that rule
    // too on the sessions before the event.
    security: company({
      statements: restateCounts(
        revision(
          baseStatements(observedWhenAvailable),
          "INCOME",
          "2025Q2",
          {
            availableFromDate: "2025-09-02",
            observedAt: "2025-09-02T12:00:00.000Z",
            values: { weightedAverageShsOutDil: undefined, grossProfit: 1 },
          },
          "q",
        ),
        ALL_QUARTERS,
        20,
        "2025-09-10",
        "r",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-10-01", "2", "1")],
    }),
    observations: [
      { session: "2025-08-29", close: CLOSE, expect: AS_OF_2025Q2 },
      {
        session: "2025-09-02",
        close: CLOSE,
        expect: all("MISSING_SHARE_COUNT"),
      },
      {
        session: "2025-09-10",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", ["COUNT_BEFORE_EVENT"]),
      },
      {
        session: "2025-10-01",
        close: CLOSE,
        expect: all("SHARE_RESTATEMENT_UNEXPLAINED", [
          "FORWARD_EVENT_UNMEASURED",
        ]),
      },
    ],
  },
  {
    id: "G3",
    covers: [],
    title:
      "rule 2 first level: a listing quarter's count the next quarter contradicts is never read",
    // 2023Q1 reports 6 shares, every later quarter 10 — the shape of a listing quarter's weighted
    // average, which the next quarter contradicts. The walk's first count is confirmed like any new
    // level: 6 is the first quarter of a run (withheld); 2023Q2's 10 is 4 from 6, beyond 25 % of 6
    // (1.5), and starts a new run (first); 2023Q3's 10 agrees (second); 2023Q4's 10 is the third and
    // becomes the level on 2024-03-01. P/B is withheld until then — the other ratios have no
    // trailing window before 2024-03-01 anyway. (Before the ruling rule 2 accepted the first count:
    // P/B 12 x 6 / 200 = 9/25 against the coherent 3/5.)
    security: company({
      statements: setShares(baseStatements(), { "2023Q1": 6 }),
    }),
    observations: [
      {
        session: "2023-05-16",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: off("SHARE_LEVEL_UNSAFE"),
          PFCF: off("INCOMPLETE_WINDOW"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      {
        session: "2023-08-14",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: off("SHARE_LEVEL_UNSAFE"),
          PFCF: off("INCOMPLETE_WINDOW"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      {
        session: "2023-08-15",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: off("SHARE_LEVEL_UNSAFE"),
          PFCF: off("INCOMPLETE_WINDOW"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      {
        session: "2024-02-29",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: off("SHARE_LEVEL_UNSAFE"),
          PFCF: off("INCOMPLETE_WINDOW"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      { session: "2024-03-01", close: CLOSE, expect: AS_OF_2023Q4 },
    ],
  },
  {
    id: "G3b",
    covers: [],
    title:
      "rule 2 first level: even a steady first count waits for its third quarter",
    // The base company: 10 shares in every quarter. 2023Q1 starts the first run (first), 2023Q2
    // agrees (second), 2023Q3 is the third and 10 becomes the level on 2023-11-15. P/B is withheld
    // on 2023Q1's and 2023Q2's sessions and reads 120/210 = 4/7 from 2023-11-15; the other ratios
    // have no trailing window yet. (Before the ruling P/B read 120/200 = 3/5 from 2023-05-16 and
    // 120/205 = 24/41 from 2023-08-15.)
    security: company(),
    observations: [
      {
        session: "2023-05-16",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: off("SHARE_LEVEL_UNSAFE"),
          PFCF: off("INCOMPLETE_WINDOW"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      {
        session: "2023-11-14",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: off("SHARE_LEVEL_UNSAFE"),
          PFCF: off("INCOMPLETE_WINDOW"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
      {
        session: "2023-11-15",
        close: CLOSE,
        expect: {
          PE: off("INCOMPLETE_WINDOW"),
          PS: off("INCOMPLETE_WINDOW"),
          PB: "4/7",
          PFCF: off("INCOMPLETE_WINDOW"),
          EV: off("INCOMPLETE_WINDOW"),
        },
      },
    ],
  },
  // -------------------------------------------------------------------------------------------
  // The owner's rulings on the second clean-room review (2026-10-06). M1: across a share-changing
  // event, a count that still agrees with an anchor observed before it is not accepted (rule 6's
  // basis assumption, checked in rule 3). M3: a count first observed in the 30 days before an event
  // is withheld on the sessions before it (rule 5, before the event).
  // -------------------------------------------------------------------------------------------
  {
    id: "M1a",
    covers: [],
    title:
      "rule 3 across a measured split: a count that still agrees with an anchor observed before it is not accepted",
    // Filings observed when available, verified 2025-06-01; a 2:1 re-base dated 2025-10-01 and
    // detected 2025-10-02 06:00 (the stored closes before it are 6). 2025Q2 is revised on 2025-11-03
    // ("s", another field) still at 10. Its anchor "a" was observed on 2025-08-14, before the
    // detection; "s" after it; 2025Q2 ended before the event: the split separates them, and 10 is
    // not 2 x 10 — "s" is not accepted. (Before the ruling "s" agreed with "a" and read at K = 1:
    // MC 6 x 10 = 60, half the coherent 120: P/E 6/5 against 12/5.) On 2025-08-29 "a" reads at
    // K = 2: 6 x 2 x 10 = 120, as of 2025Q2; on 2025-10-31, after the event, "a" observed before
    // the detection is withheld by rule 6.
    security: company({
      statements: revision(
        baseStatements(observedWhenAvailable),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-11-03",
          observedAt: "2025-11-03T12:00:00.000Z",
          values: { grossProfit: 1 },
        },
        "s",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "2",
          "2025-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-08-29", close: "6", expect: AS_OF_2025Q2 },
      {
        session: "2025-10-31",
        close: "6",
        expect: all("BASIS_WITHHELD", []),
      },
      {
        session: "2025-11-03",
        close: "6",
        expect: all("SHARE_BASIS_UNCONFIRMED", []),
      },
    ],
  },
  {
    id: "M1b",
    covers: [],
    title:
      "rule 3 across a listed plain entry in the history: agreement is not acceptance, and an entry explains nothing",
    // Filings observed when available; a 2:1 provider entry dated 2025-09-15 in the history verified
    // on 2026-10-02, nothing measured. On 2025-08-29 "a" (observed 2025-08-14) predates the entry
    // (rule 4.2). 2025Q2 is revised on 2025-11-03 ("s") still at 10: the entry separates it from "a"
    // (the quarter ended before it, "a" was observed before it and "s" after), so it is not accepted;
    // rule 5's month after the entry ended on 2025-10-14.
    security: company({
      statements: revision(
        baseStatements(observedWhenAvailable),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-11-03",
          observedAt: "2025-11-03T12:00:00.000Z",
          values: { grossProfit: 1 },
        },
        "s",
      ),
      splits: [split("2025-09-15", "2", "1")],
    }),
    observations: [
      {
        session: "2025-08-29",
        close: CLOSE,
        expect: all("COUNT_PREDATES_HISTORICAL_ENTRY", []),
      },
      {
        session: "2025-11-03",
        close: CLOSE,
        expect: all("SHARE_BASIS_UNCONFIRMED", []),
      },
    ],
  },
  {
    id: "M1c",
    covers: [],
    title:
      "rule 3 across a measured split: a restatement explained against the anchor before it, past a revision that agreed",
    // M1a's re-base (2:1, dated 2025-10-01, detected 2025-10-02 06:00, closes 6). 2025Q2 is revised on
    // 2025-10-20 ("t") still at 10: separated from "a", not accepted — and within rule 5's month. On
    // 2025-11-03 every quarter is restated to 20 ("r"). 2025Q2's "r" walks "a", "t", "r": its anchor
    // is "a" ("t" was not accepted), the split separates them, and the re-base explains 20 against
    // 10 (new to "a", detected before "r" was observed, |20 - 2 x 10| = 0): accepted. Observed after
    // the detection, on a session after the event: K = 1, MC = 6 x 20 = 120, as of 2025Q2. (Before the
    // ruling "t" agreed with "a" and anchored "r", which the re-base — detected before "t" was
    // observed — could not explain: withheld.)
    security: company({
      statements: restateCounts(
        revision(
          baseStatements(observedWhenAvailable),
          "INCOME",
          "2025Q2",
          {
            availableFromDate: "2025-10-20",
            observedAt: "2025-10-20T12:00:00.000Z",
            values: { grossProfit: 1 },
          },
          "t",
        ),
        ALL_QUARTERS,
        20,
        "2025-11-03",
        "r",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "2",
          "2025-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-10-20",
        close: "6",
        expect: all("SHARE_BASIS_UNCONFIRMED", ["EVENT_SETTLING"]),
      },
      { session: "2025-11-03", close: "6", expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "M1d",
    covers: [],
    title:
      "rule 3 across a measured split: an anchor observed between the event and its detection is before it",
    // A 2:1 re-base dated 2025-10-01, detected only on 2025-10-20 06:00. 2025Q2 is revised on
    // 2025-10-10 ("b", still 10) — between the event and the detection, so not separated from "a":
    // accepted by rule 3, but rule 6 withholds a count observed then, and rule 5's month holds it. On
    // 2025-11-20 ("c", still 10) the anchor is "b", observed before the detection: separated, and 10
    // is not 2 x 10 — not accepted. (Reading "before the event" as before its date would have let
    // "c" agree with "b" and read 6 x 10 = 60.)
    security: company({
      statements: revision(
        revision(
          baseStatements(observedWhenAvailable),
          "INCOME",
          "2025Q2",
          {
            availableFromDate: "2025-10-10",
            observedAt: "2025-10-10T12:00:00.000Z",
            values: { grossProfit: 1 },
          },
          "b",
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-11-20",
          observedAt: "2025-11-20T12:00:00.000Z",
          values: { grossProfit: 2 },
        },
        "c",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "2",
          "2025-10-20T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-10-10",
        close: "6",
        expect: all("EVENT_SETTLING", ["BASIS_WITHHELD"]),
      },
      {
        session: "2025-11-20",
        close: "6",
        expect: all("SHARE_BASIS_UNCONFIRMED", []),
      },
    ],
  },
  {
    id: "M1e",
    covers: [],
    title:
      "rule 3 across a forward plain entry never measured: agreement after it is not acceptance",
    // Filings observed when available, verified 2025-06-01; a 2:1 entry listed for 2025-09-15,
    // never measured. Before it "a" reads as of 2025Q2; from its date through 2025-10-15 rule 8
    // holds; on 2025-11-03 the revision "s", still 10, is separated from "a" by the entry and not
    // accepted.
    security: company({
      statements: revision(
        baseStatements(observedWhenAvailable),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-11-03",
          observedAt: "2025-11-03T12:00:00.000Z",
          values: { grossProfit: 1 },
        },
        "s",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-09-15", "2", "1")],
    }),
    observations: [
      { session: "2025-09-12", close: CLOSE, expect: AS_OF_2025Q2 },
      {
        session: "2025-09-15",
        close: CLOSE,
        expect: all("FORWARD_EVENT_UNMEASURED", []),
      },
      {
        session: "2025-11-03",
        close: CLOSE,
        expect: all("SHARE_BASIS_UNCONFIRMED", []),
      },
    ],
  },
  {
    id: "M1f",
    covers: [],
    title:
      "rule 3 across a measured non-plain re-base: no share change, so agreement is accepted — rule 7 holds it",
    // A re-base of 1.046 (a possible distribution) dated 2025-10-01, detected 2025-10-02 06:00. It is
    // no share change, so the revision "s" of 2025-11-03, still 10, agrees with "a" and is accepted;
    // on 2025-11-03 the statements still end before the event (2025Q2), so rule 7 withholds every
    // ratio.
    security: company({
      statements: revision(
        baseStatements(observedWhenAvailable),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-11-03",
          observedAt: "2025-11-03T12:00:00.000Z",
          values: { grossProfit: 1 },
        },
        "s",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "1.046",
          "2025-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-11-03",
        close: CLOSE,
        expect: all("POST_DISTRIBUTION_STATEMENTS_STALE", []),
      },
    ],
  },
  {
    id: "M1g",
    covers: [],
    title:
      "rule 3 across a measured split: a count within 2 % of the anchor is not accepted, whatever re-base could explain it",
    // 2025Q2 ("a") filed fast: available and observed 2025-07-25. A re-base at 1.01 (a possible
    // distribution, not a plain share change, so it separates nothing) dated 2025-06-27 — inside
    // 2025Q2, so every family covers it (rule 7) — and detected 2025-09-03, after "a" was observed
    // and dated less than 30 days before it: new to "a". A 2:1 re-base dated 2025-09-15, detected
    // 2025-09-16 06:00. 2025Q2 is revised on 2025-11-03 ("s", another field) still at 10: the split
    // separates "s" from "a" (2025Q2 ended before it, "a" was observed before the detection, "s"
    // after), so a count within 2 % of "a" is not accepted. The 1.01 re-base would "explain" 10
    // against 10 (|10 - 1.01 x 10| = 0.1 <= 2 % of 10.1), but explaining is for a count that
    // differs. Read at K = 1 it would be MC 6 x 10 = 60, half the coherent 6 x 20.
    security: company({
      statements: revision(
        baseStatements(observedWhenAvailable).map((statement) =>
          statement.fiscalDate === "2025-06-30"
            ? {
                ...statement,
                availableFromDate: "2025-07-25",
                observedAt: "2025-07-25T12:00:00.000Z",
              }
            : statement,
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-11-03",
          observedAt: "2025-11-03T12:00:00.000Z",
          values: { grossProfit: 1 },
        },
        "s",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      events: [
        measured(
          { effectiveDate: "2025-06-27" },
          "1.01",
          "2025-09-03T12:00:00.000Z",
        ),
        measured(
          { effectiveDate: "2025-09-15" },
          "2",
          "2025-09-16T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-11-03",
        close: "6",
        expect: all("SHARE_BASIS_UNCONFIRMED", []),
      },
    ],
  },
  {
    id: "M1h",
    covers: [],
    title:
      "M1g without the split: the same revision agrees with its anchor and is read",
    // As M1g with only the 1.01 re-base: nothing separates "s" from "a", 10 is within 2 % of 10, so
    // "s" is accepted. Observed after the re-base's detection, K = 1: MC 12 x 10 = 120, as of 2025Q2.
    security: company({
      statements: revision(
        baseStatements(observedWhenAvailable).map((statement) =>
          statement.fiscalDate === "2025-06-30"
            ? {
                ...statement,
                availableFromDate: "2025-07-25",
                observedAt: "2025-07-25T12:00:00.000Z",
              }
            : statement,
        ),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-11-03",
          observedAt: "2025-11-03T12:00:00.000Z",
          values: { grossProfit: 1 },
        },
        "s",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      events: [
        measured(
          { effectiveDate: "2025-06-27" },
          "1.01",
          "2025-09-03T12:00:00.000Z",
        ),
      ],
    }),
    observations: [
      { session: "2025-11-03", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "M3a",
    covers: [],
    title:
      "rule 5 before the event: a first load in the month before a split, already restated, is withheld before it",
    // Every statement first observed on 2025-09-15 (a first load, history verified an hour later),
    // with 20 shares — the provider had restated ahead of the 2:1 re-base dated 2025-10-01 (detected
    // 2025-10-02 06:00; the stored closes before it are 6). 2025Q2's count was first observed on
    // 2025-09-15, within 30 days before the event (from 2025-09-01), and the quarter ended before
    // it: withheld on every session before 2025-10-01. (Before the ruling it read at K = 2:
    // 6 x 2 x 20 = 240, P/E 24/5 against the coherent 12/5.) On the event's date a count observed
    // before the detection is withheld by rule 6.
    security: company({
      statements: observeAll(
        setShares(
          baseStatements(),
          Object.fromEntries(ALL_QUARTERS.map((quarter) => [quarter, 20])),
        ),
        "2025-09-15T12:00:00.000Z",
      ),
      verifiedAt: "2025-09-15T13:00:00.000Z",
      events: [
        measured(
          { effectiveDate: "2025-10-01" },
          "2",
          "2025-10-02T06:00:00.000Z",
        ),
      ],
    }),
    observations: [
      {
        session: "2025-09-16",
        close: "6",
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      {
        session: "2025-09-30",
        close: "6",
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      {
        session: "2025-10-01",
        close: "6",
        expect: all("BASIS_WITHHELD", []),
      },
    ],
  },
  {
    id: "M3b",
    covers: [],
    title:
      "rule 5 before the event: a quarter filed in the month before a listed split waits for it",
    // Filings observed when available, verified 2025-06-01; a 2:1 entry listed for 2025-09-08. 2025Q2
    // was filed and first observed on 2025-08-14, within 30 days before it (from 2025-08-09), and
    // ended before it: withheld on the sessions before 2025-09-08. 2025Q1's count (2025-05-15) is
    // outside the window: as of 2025Q1 on 2025-08-13. From the entry's date rule 8 holds through
    // 2025-10-08; after it nothing withholds "a" — the provider has not re-based the prices, so its
    // units are the closes'.
    security: company({
      statements: baseStatements(observedWhenAvailable),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-09-08", "2", "1")],
    }),
    observations: [
      { session: "2025-08-13", close: CLOSE, expect: AS_OF_2025Q1 },
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      {
        session: "2025-09-05",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      {
        session: "2025-09-08",
        close: CLOSE,
        expect: all("FORWARD_EVENT_UNMEASURED", []),
      },
      { session: "2025-10-09", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "M3c",
    covers: [],
    title:
      "rule 5 before the event: a count first observed exactly 30 days before is in the window",
    // M3b with the entry on 2025-09-13: 2025-09-13 - 30 days = 2025-08-14, the day 2025Q2 was first
    // observed — inside the window (inclusive): withheld on 2025-08-14 and 2025-09-12.
    security: company({
      statements: baseStatements(observedWhenAvailable),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-09-13", "2", "1")],
    }),
    observations: [
      {
        session: "2025-08-14",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", []),
      },
      {
        session: "2025-09-12",
        close: CLOSE,
        expect: all("COUNT_BEFORE_EVENT", []),
      },
    ],
  },
  {
    id: "M3d",
    covers: [],
    title:
      "rule 5 before the event: a count first observed 31 days before is outside the window",
    // M3b with the entry on 2025-09-14: the window starts on 2025-08-15, the day after 2025Q2 was
    // first observed — as of 2025Q2 until the entry.
    security: company({
      statements: baseStatements(observedWhenAvailable),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-09-14", "2", "1")],
    }),
    observations: [
      { session: "2025-08-14", close: CLOSE, expect: AS_OF_2025Q2 },
      { session: "2025-09-12", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
  {
    id: "M3e",
    covers: [],
    title:
      "rule 5 before the event: a count only repeated in the month before was first observed earlier",
    // Filings observed when available, verified 2025-06-01; a 2:1 entry listed for 2025-10-01. 2025Q2
    // is revised on 2025-09-10 ("s", another field) at the same 10, inside the window (from
    // 2025-09-01): it agrees with "a", so the count was first observed with "a" on 2025-08-14,
    // outside it — as of 2025Q2 on 2025-09-10.
    security: company({
      statements: revision(
        baseStatements(observedWhenAvailable),
        "INCOME",
        "2025Q2",
        {
          availableFromDate: "2025-09-10",
          observedAt: "2025-09-10T12:00:00.000Z",
          values: { grossProfit: 1 },
        },
        "s",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [split("2025-10-01", "2", "1")],
    }),
    observations: [
      { session: "2025-09-10", close: CLOSE, expect: AS_OF_2025Q2 },
    ],
  },
];

/**
 * The share-level walk (rule 2), one count per quarter from 2023Q1, read through P/B on the
 * session each quarter becomes available (its balance sheet and every other input are the base
 * company's). `true` = available, `false` = withheld by rule 2, `null` = no usable count.
 *
 * Every row is worked out by hand from the rule's text and the reading stated in the oracle. Since
 * the owner's ruling of 2026-10-06 the walk's first count is confirmed like any new level, so every
 * walk below withholds its first two quarters and reads its third: the first count and the two
 * agreeing with it are its first run.
 */
export const SHARE_LEVEL_WALKS: readonly {
  title: string;
  counts: readonly (number | null)[];
  accepted: readonly (boolean | null)[];
}[] = [
  {
    title: "steady level",
    counts: [10, 10, 10, 10, 10, 10, 10, 10],
    accepted: [false, false, true, true, true, true, true, true],
  },
  {
    title: "exactly +25 % is inside the level, and the level follows it",
    // 10 -> 12.5 (|2.5| <= 2.5) -> 15.625 (|3.125| <= 3.125) -> 19.53125 (inside 15.625's 25 %)
    counts: [10, 10, 10, 10, 12.5, 15.625, 19.53125, 19.53125],
    accepted: [false, false, true, true, true, true, true, true],
  },
  {
    title: "just above +25 % is outside",
    // 12.50001 - 10 = 2.50001 > 2.5: first outside; back to 10 next quarter.
    counts: [10, 10, 10, 10, 12.50001, 10, 10, 10],
    accepted: [false, false, true, true, false, true, true, true],
  },
  {
    title: "exactly -25 % is inside; just below is outside",
    counts: [10, 10, 10, 10, 7.5, 7.5, 5.62499, 7.5],
    // 7.5 inside 10's band; level 7.5; 5.62499 is 1.87501 below 7.5 > 1.875: outside; 7.5 back.
    accepted: [false, false, true, true, true, true, false, true],
  },
  {
    title:
      "exactly -25 % of a non-integer count is inside: the figures are judged, not their doubles",
    // |0.825 - 1.1| = 0.275 = 0.25 x 1.1: inside, and 0.825 becomes the level (as doubles,
    // 0.825 / 1.1 - 1 is -0.2500000000000001). |1.1 - 0.825| = 0.275 > 0.25 x 0.825 = 0.20625: the
    // return to 1.1 leaves the level, first and second disagreeing quarters.
    counts: [1.1, 1.1, 1.1, 1.1, 0.825, 0.825, 1.1, 1.1],
    accepted: [false, false, true, true, true, true, false, false],
  },
  {
    title:
      "a persistent change is accepted on the third quarter (merger/offering)",
    counts: [10, 10, 10, 10, 15, 15, 15, 15],
    accepted: [false, false, true, true, false, false, true, true],
  },
  {
    title:
      "two-quarter blocks alternating by 40 % are never accepted (Visa 2010-2012)",
    counts: [10, 10, 10, 10, 14, 14, 10, 10, 14, 14],
    accepted: [
      false,
      false,
      true,
      true,
      false,
      false,
      true,
      true,
      false,
      false,
    ],
  },
  {
    title: "a two-quarter artefact is never accepted (MSTR Q3 1999 kind)",
    counts: [10, 10, 10, 10, 20.18, 20.18, 10, 10],
    accepted: [false, false, true, true, false, false, true, true],
  },
  {
    title: "the agreement is with the count that left the level",
    // 14 leaves 10's band (first). 17 agrees with 14 (|3| <= 3.5): second. 17.6 is 3.6 from 14 >
    // 3.5: it starts again (first). 17.6, 17.6: second, third -> accepted.
    counts: [10, 10, 10, 10, 14, 17, 17.6, 17.6, 17.6],
    accepted: [false, false, true, true, false, false, false, false, true],
  },
  {
    title: "a missing count starts the agreement again",
    counts: [10, 10, 10, 10, 15, 15, null, 15, 15, 15],
    accepted: [
      false,
      false,
      true,
      true,
      false,
      false,
      null,
      false,
      false,
      true,
    ],
  },
  {
    title: "a zero count is no usable count and starts the agreement again",
    counts: [10, 10, 10, 10, 15, 15, 0, 15, 15, 15],
    accepted: [
      false,
      false,
      true,
      true,
      false,
      false,
      null,
      false,
      false,
      true,
    ],
  },
  {
    title: "an accepted quarter inside the level ends a disagreement run",
    // 13 is outside 10 (first); 10.5 is inside the level (accepted, level 10.5) and ends the run;
    // 13.2 is outside 10.5's band (2.7 > 2.625): first again; 13.2: second; 13.2: third.
    counts: [10, 10, 10, 10, 13, 10.5, 13.2, 13.2, 13.2],
    accepted: [false, false, true, true, false, true, false, false, true],
  },
  {
    title:
      "the first count is confirmed like any new level: a listing quarter's weighted average",
    // 6 starts the first run; 10 is 4 from 6 (> 1.5) and starts another; 10, 10 agree: the third
    // quarter of that run, 2023Q4, sets the level.
    counts: [6, 10, 10, 10, 10, 10, 10, 10],
    accepted: [false, false, false, true, true, true, true, true],
  },
  {
    title: "a missing count restarts the first level's agreement too",
    counts: [10, 10, null, 10, 10, 10, 10, 10],
    accepted: [false, false, null, false, false, true, true, true],
  },
];

/**
 * The restatement threshold (rule 3) at its boundary: 2024Q4's Income restated from 10 shares.
 * `true` = still available (within 2 %, no explanation needed), `false` = an unexplained
 * restatement.
 */
export const RESTATEMENT_THRESHOLDS: readonly {
  restated: number;
  available: boolean;
}[] = [
  { restated: 10.19999, available: true },
  { restated: 10.2, available: true },
  { restated: 10.20001, available: false },
  { restated: 9.8, available: true },
  { restated: 9.79999, available: false },
];

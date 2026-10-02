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
    // P was observed before the event and its detection: before 2025-03-10 K = 1.25, so
    // MC = 12 · 1.25 · 10 = 150 again; from 2025-03-10 on it is withheld.
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
        expect: { PE: "15/4", PS: "3/8", PB: "5/8", PFCF: "3", EV: "2" },
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
    // 2025-06-05. R as of 2025Q1 was observed 2025-05-15: before the event and its detection.
    // Before 2025-06-02: K = 2, MC = 240 -> 240/45 = 16/3, 240/410 = 24/41, 240/250 = 24/25,
    // 240/52 = 60/13, (240 + 40)/103 = 280/103. From 2025-06-02: withheld. As of 2025Q2, R was
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
        session: "2025-05-30",
        close: CLOSE,
        expect: {
          PE: "16/3",
          PS: "24/41",
          PB: "24/25",
          PFCF: "60/13",
          EV: "280/103",
        },
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
    id: "C40",
    covers: [40],
    title:
      "an undated re-base: K up to its interval's start, withheld inside it and on its last session",
    // Measured in (2025-06-02, 2025-06-06], ratio 2, detected 2025-06-07. R as of 2025Q1 observed
    // 2025-05-15, before the interval: 2025-06-02 is before the event (K = 2, MC 240, the C35
    // readings); 2025-06-03 is inside; 2025-06-06 is the interval's last session, on the new basis.
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
        session: "2025-06-02",
        close: CLOSE,
        expect: {
          PE: "16/3",
          PS: "24/41",
          PB: "24/25",
          PFCF: "60/13",
          EV: "280/103",
        },
      },
      { session: "2025-06-03", close: CLOSE, expect: all("BASIS_WITHHELD") },
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
];

/**
 * The share-level walk (rule 2), one count per quarter from 2023Q1, read through P/B on the
 * session each quarter becomes available (its balance sheet and every other input are the base
 * company's). `true` = available, `false` = withheld by rule 2, `null` = no usable count.
 *
 * Every row is worked out by hand from the rule's text and the reading stated in the oracle.
 */
export const SHARE_LEVEL_WALKS: readonly {
  title: string;
  counts: readonly (number | null)[];
  accepted: readonly (boolean | null)[];
}[] = [
  {
    title: "steady level",
    counts: [10, 10, 10, 10, 10, 10, 10, 10],
    accepted: [true, true, true, true, true, true, true, true],
  },
  {
    title: "exactly +25 % is inside the level, and the level follows it",
    // 10 -> 12.5 (|2.5| <= 2.5) -> 15.625 (|3.125| <= 3.125) -> 19.53125 (inside 15.625's 25 %)
    counts: [10, 10, 10, 10, 12.5, 15.625, 19.53125, 19.53125],
    accepted: [true, true, true, true, true, true, true, true],
  },
  {
    title: "just above +25 % is outside",
    // 12.50001 - 10 = 2.50001 > 2.5: first outside; back to 10 next quarter.
    counts: [10, 10, 10, 10, 12.50001, 10, 10, 10],
    accepted: [true, true, true, true, false, true, true, true],
  },
  {
    title: "exactly -25 % is inside; just below is outside",
    counts: [10, 10, 10, 10, 7.5, 7.5, 5.62499, 7.5],
    // 7.5 inside 10's band; level 7.5; 5.62499 is 1.87501 below 7.5 > 1.875: outside; 7.5 back.
    accepted: [true, true, true, true, true, true, false, true],
  },
  {
    title:
      "a persistent change is accepted on the third quarter (merger/offering)",
    counts: [10, 10, 10, 10, 15, 15, 15, 15],
    accepted: [true, true, true, true, false, false, true, true],
  },
  {
    title:
      "two-quarter blocks alternating by 40 % are never accepted (Visa 2010-2012)",
    counts: [10, 10, 10, 10, 14, 14, 10, 10, 14, 14],
    accepted: [true, true, true, true, false, false, true, true, false, false],
  },
  {
    title: "a two-quarter artefact is never accepted (MSTR Q3 1999 kind)",
    counts: [10, 10, 10, 10, 20.18, 20.18, 10, 10],
    accepted: [true, true, true, true, false, false, true, true],
  },
  {
    title: "the agreement is with the count that left the level",
    // 14 leaves 10's band (first). 17 agrees with 14 (|3| <= 3.5): second. 17.6 is 3.6 from 14 >
    // 3.5: it starts again (first). 17.6, 17.6: second, third -> accepted.
    counts: [10, 10, 10, 10, 14, 17, 17.6, 17.6, 17.6],
    accepted: [true, true, true, true, false, false, false, false, true],
  },
  {
    title: "a missing count starts the agreement again",
    counts: [10, 10, 10, 10, 15, 15, null, 15, 15, 15],
    accepted: [true, true, true, true, false, false, null, false, false, true],
  },
  {
    title: "a zero count is no usable count and starts the agreement again",
    counts: [10, 10, 10, 10, 15, 15, 0, 15, 15, 15],
    accepted: [true, true, true, true, false, false, null, false, false, true],
  },
  {
    title: "an accepted quarter inside the level ends a disagreement run",
    // 13 is outside 10 (first); 10.5 is inside the level (accepted, level 10.5) and ends the run;
    // 13.2 is outside 10.5's band (2.7 > 2.625): first again; 13.2: second; 13.2: third.
    counts: [10, 10, 10, 10, 13, 10.5, 13.2, 13.2, 13.2],
    accepted: [true, true, true, true, false, true, false, false, true],
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

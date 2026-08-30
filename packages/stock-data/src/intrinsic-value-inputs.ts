import type {
  FinancialPeriod,
  FinancialStatement,
  FinancialStatementType,
  Instant,
  IntrinsicValueModel,
  LocalDate,
  SecurityId,
} from "@intrinsic/domain";
import { selectFinancialStatements } from "@intrinsic/domain";
import {
  estimateGrowth,
  type DcfFcffInput,
  type DdmInput,
  type GrahamInput,
  type ResidualIncomeInput,
} from "@intrinsic/valuation";

/**
 * Why a model's inputs could not be assembled.
 *
 * These describe statement selection and point-in-time availability, never the financial verdict
 * of a formula: the pure valuation package owns rules such as a non-positive FCFF or EPS. Ordinary
 * missing financial data is reported here, never thrown.
 */
export const INTRINSIC_VALUE_ASSEMBLY_REASONS = [
  /** The required four consecutive fiscal quarters could not be formed. */
  "MISSING_TTM_WINDOW",
  /** No point-in-time eligible quarterly statement exists for a required latest-state family. */
  "MISSING_LATEST_STATE",
  /** A required numeric field is absent on a statement the model must use. */
  "MISSING_REQUIRED_FIELD",
  /** A per-quarter diluted share count that assembly must divide by is not positive. */
  "INVALID_DILUTED_SHARES",
  /** The statements supplying this model do not share one non-empty reported currency. */
  "CURRENCY_MISMATCH",
] as const;
export type IntrinsicValueAssemblyReason =
  (typeof INTRINSIC_VALUE_ASSEMBLY_REASONS)[number];

export type AssembledModelInput<T> =
  | {
      status: "READY";
      input: T;
      /**
       * Maximum availability instant across the statements actually used by this model, encoded
       * at UTC midnight of `availableFromDate`.
       */
      sourceDataAsOf: Instant;
      currency: string;
    }
  | { status: "NOT_APPLICABLE"; reason: IntrinsicValueAssemblyReason };

/** Per-model assembly results. Each model is assembled and validated independently. */
export type IntrinsicValueInputs = {
  DCF_FCFF: AssembledModelInput<DcfFcffInput>;
  RESIDUAL_INCOME: AssembledModelInput<ResidualIncomeInput>;
  DDM: AssembledModelInput<DdmInput>;
  GRAHAM: AssembledModelInput<GrahamInput>;
};

export type IntrinsicValueInputRequest = {
  securityId: SecurityId;
  /** Trading day the valuation is effective on; the only point-in-time cutoff used. */
  valuationDate: LocalDate;
  statements: readonly FinancialStatement[];
};

const QUARTERLY_PERIODS = ["Q1", "Q2", "Q3", "Q4"] as const;
type QuarterlyPeriod = (typeof QUARTERLY_PERIODS)[number];

/** Fiscal quarter identity. Never inferred from calendar dates or `fiscalDate` arithmetic. */
type QuarterIdentity = {
  fiscalYear: number;
  period: QuarterlyPeriod;
};

const TTM_QUARTERS = 4;
const GROWTH_CAGR_YEARS = 5;

function isQuarterlyPeriod(period: FinancialPeriod): period is QuarterlyPeriod {
  return period !== "FY";
}

/**
 * Monotonic rank over fiscal quarters, so `rank - 1` is always the previous quarter identity and
 * Q4 -> next fiscal year's Q1 needs no special case.
 */
function quarterRank(identity: QuarterIdentity): number {
  return identity.fiscalYear * 4 + QUARTERLY_PERIODS.indexOf(identity.period);
}

type QuarterlyIndex = Map<number, FinancialStatement>;

/** Latest four consecutive quarter ranks ending at `anchorRank`, oldest first. */
function trailingWindow(anchorRank: number): number[] {
  return Array.from(
    { length: TTM_QUARTERS },
    (_unused, offset) => anchorRank - (TTM_QUARTERS - 1 - offset),
  );
}

function indexQuarterly(
  statements: readonly FinancialStatement[],
  statementType: FinancialStatementType,
): QuarterlyIndex {
  const index: QuarterlyIndex = new Map();
  for (const statement of statements) {
    if (
      statement.statementType !== statementType ||
      !isQuarterlyPeriod(statement.period)
    ) {
      continue;
    }
    index.set(
      quarterRank({
        fiscalYear: statement.fiscalYear,
        period: statement.period,
      }),
      statement,
    );
  }
  return index;
}

function indexAnnualIncome(
  statements: readonly FinancialStatement[],
): Map<number, FinancialStatement> {
  const index = new Map<number, FinancialStatement>();
  for (const statement of statements) {
    if (statement.statementType === "INCOME" && statement.period === "FY") {
      index.set(statement.fiscalYear, statement);
    }
  }
  return index;
}

function latestRank(index: QuarterlyIndex): number | undefined {
  let latest: number | undefined;
  for (const rank of index.keys()) {
    if (latest === undefined || rank > latest) {
      latest = rank;
    }
  }
  return latest;
}

/**
 * Latest quarter identity for which every required statement family is point-in-time eligible.
 *
 * Field presence deliberately plays no part in choosing the anchor: a newer quarter that is
 * eligible for every required family becomes authoritative even if one of its fields is missing,
 * which then makes the model unavailable rather than silently reusing an older window.
 */
function latestCommonRank(indexes: readonly QuarterlyIndex[]): number | undefined {
  const [first, ...rest] = indexes;
  if (!first) {
    return undefined;
  }
  let latest: number | undefined;
  for (const rank of first.keys()) {
    if (!rest.every((index) => index.has(rank))) {
      continue;
    }
    if (latest === undefined || rank > latest) {
      latest = rank;
    }
  }
  return latest;
}

/** The four statements of a window for one family, or `undefined` when any quarter is missing. */
function windowStatements(
  index: QuarterlyIndex,
  window: readonly number[],
): FinancialStatement[] | undefined {
  const rows: FinancialStatement[] = [];
  for (const rank of window) {
    const statement = index.get(rank);
    if (!statement) {
      return undefined;
    }
    rows.push(statement);
  }
  return rows;
}

function numericValue(
  statement: FinancialStatement,
  field: string,
): number | undefined {
  const value = (statement.values as Record<string, number | undefined>)[field];
  return typeof value === "number" ? value : undefined;
}

/** Day-granularity provenance: the canonical instant of an `availableFromDate`. */
export function availabilityInstant(availableFromDate: LocalDate): Instant {
  return `${availableFromDate}T00:00:00.000Z`;
}

/**
 * Maximum availability instant over the statements actually used.
 *
 * `observedAt` is deliberately not used: a historical statement may be backfilled and observed
 * years after it became public, and using that would push look-ahead unavailability into
 * historical valuations. A later revision is already accounted for because its own
 * `availableFromDate` reflects when that revision became eligible.
 */
function maxAvailabilityInstant(used: readonly FinancialStatement[]): Instant {
  let latest = used[0]?.availableFromDate;
  if (latest === undefined) {
    throw new Error("Model provenance requires at least one source statement");
  }
  for (const statement of used) {
    if (statement.availableFromDate > latest) {
      latest = statement.availableFromDate;
    }
  }
  return availabilityInstant(latest);
}

/** The one currency shared by every supplied statement, or `undefined` when they disagree. */
function commonCurrency(
  used: readonly FinancialStatement[],
): string | undefined {
  const currency = used[0]?.reportedCurrency;
  if (!currency) {
    return undefined;
  }
  return used.every((statement) => statement.reportedCurrency === currency)
    ? currency
    : undefined;
}

function notApplicable<T>(
  reason: IntrinsicValueAssemblyReason,
): AssembledModelInput<T> {
  return { status: "NOT_APPLICABLE", reason };
}

/** Finalizes a model: currency validation and provenance over the statements actually used. */
function ready<T>(
  input: T,
  used: readonly FinancialStatement[],
): AssembledModelInput<T> {
  const currency = commonCurrency(used);
  if (!currency) {
    return notApplicable("CURRENCY_MISMATCH");
  }
  return {
    status: "READY",
    input,
    sourceDataAsOf: maxAvailabilityInstant(used),
    currency,
  };
}

type GrowthAssembly = {
  growthUsed: number;
  /** Only the endpoint statements actually consumed; `DEFAULT` growth uses none. */
  statements: readonly FinancialStatement[];
};

/**
 * Growth from the two exact annual endpoints `N` and `N - 5`.
 *
 * `N` is the latest point-in-time eligible `FY` income fiscal year; an older `N` is never chosen
 * merely because it has a usable counterpart, and neighbouring years are never substituted. The
 * numeric rules (positive endpoints, revenue first, net-income fallback, default, upside cap) stay
 * in the pure valuation package.
 */
function assembleGrowth(
  annualIncome: Map<number, FinancialStatement>,
): GrowthAssembly {
  let latestFiscalYear: number | undefined;
  for (const fiscalYear of annualIncome.keys()) {
    if (latestFiscalYear === undefined || fiscalYear > latestFiscalYear) {
      latestFiscalYear = fiscalYear;
    }
  }
  const latest =
    latestFiscalYear === undefined
      ? undefined
      : annualIncome.get(latestFiscalYear);
  const earlier =
    latestFiscalYear === undefined
      ? undefined
      : annualIncome.get(latestFiscalYear - GROWTH_CAGR_YEARS);
  if (!latest || !earlier) {
    return { growthUsed: estimateGrowth({}).growthUsed, statements: [] };
  }

  const endpoints = (field: "revenue" | "netIncome") => {
    const latestValue = numericValue(latest, field);
    const earlierValue = numericValue(earlier, field);
    return latestValue === undefined || earlierValue === undefined
      ? undefined
      : { latest: latestValue, fiveYearsEarlier: earlierValue };
  };

  const revenue = endpoints("revenue");
  const netIncome = endpoints("netIncome");
  const estimate = estimateGrowth({
    ...(revenue ? { revenue } : {}),
    ...(netIncome ? { netIncome } : {}),
  });

  return {
    growthUsed: estimate.growthUsed,
    // Default growth consumes no statement, so it must not inflate provenance.
    statements: estimate.source === "DEFAULT" ? [] : [latest, earlier],
  };
}

function assembleDcfFcff(
  cashFlow: QuarterlyIndex,
  income: QuarterlyIndex,
  balanceSheet: QuarterlyIndex,
  growth: GrowthAssembly,
): AssembledModelInput<DcfFcffInput> {
  const anchor = latestCommonRank([cashFlow, income]);
  if (anchor === undefined) {
    return notApplicable("MISSING_TTM_WINDOW");
  }
  const window = trailingWindow(anchor);
  const cashFlowRows = windowStatements(cashFlow, window);
  const incomeRows = windowStatements(income, window);
  if (!cashFlowRows || !incomeRows) {
    return notApplicable("MISSING_TTM_WINDOW");
  }

  let operatingCashFlowTtm = 0;
  let capitalExpenditureTtm = 0;
  for (const row of cashFlowRows) {
    const operatingCashFlow = numericValue(row, "operatingCashFlow");
    // Provider sign is preserved: capital expenditure arrives already negative.
    const capitalExpenditure = numericValue(row, "capitalExpenditure");
    if (operatingCashFlow === undefined || capitalExpenditure === undefined) {
      return notApplicable("MISSING_REQUIRED_FIELD");
    }
    operatingCashFlowTtm += operatingCashFlow;
    capitalExpenditureTtm += capitalExpenditure;
  }

  let interestExpenseTtm = 0;
  for (const row of incomeRows) {
    // An explicit reported zero is valid; a missing field is never treated as zero and has no
    // fallback field in V1.
    const interestExpense = numericValue(row, "interestExpense");
    if (interestExpense === undefined) {
      return notApplicable("MISSING_REQUIRED_FIELD");
    }
    interestExpenseTtm += interestExpense;
  }

  // Latest-state inputs are independent of the flow window and may be newer than it.
  const latestBalanceSheetRank = latestRank(balanceSheet);
  const latestIncomeRank = latestRank(income);
  if (latestBalanceSheetRank === undefined || latestIncomeRank === undefined) {
    return notApplicable("MISSING_LATEST_STATE");
  }
  const latestBalanceSheet = balanceSheet.get(latestBalanceSheetRank);
  const latestIncome = income.get(latestIncomeRank);
  if (!latestBalanceSheet || !latestIncome) {
    return notApplicable("MISSING_LATEST_STATE");
  }

  // The cash fallback is between two fields on that same latest row, never an older row.
  const cash =
    numericValue(latestBalanceSheet, "cashAndShortTermInvestments") ??
    numericValue(latestBalanceSheet, "cashAndCashEquivalents");
  const debt = numericValue(latestBalanceSheet, "totalDebt");
  const shares = numericValue(latestIncome, "weightedAverageShsOutDil");
  if (cash === undefined || debt === undefined || shares === undefined) {
    return notApplicable("MISSING_REQUIRED_FIELD");
  }

  return ready(
    {
      operatingCashFlowTtm,
      capitalExpenditureTtm,
      interestExpenseTtm,
      growthUsed: growth.growthUsed,
      cash,
      debt,
      shares,
    },
    [
      ...cashFlowRows,
      ...incomeRows,
      latestBalanceSheet,
      latestIncome,
      ...growth.statements,
    ],
  );
}

function assembleResidualIncome(
  income: QuarterlyIndex,
  balanceSheet: QuarterlyIndex,
  growth: GrowthAssembly,
): AssembledModelInput<ResidualIncomeInput> {
  const anchor = latestRank(income);
  if (anchor === undefined) {
    return notApplicable("MISSING_TTM_WINDOW");
  }
  const incomeRows = windowStatements(income, trailingWindow(anchor));
  if (!incomeRows) {
    return notApplicable("MISSING_TTM_WINDOW");
  }

  let netIncomeTtm = 0;
  for (const row of incomeRows) {
    const netIncome = numericValue(row, "netIncome");
    if (netIncome === undefined) {
      return notApplicable("MISSING_REQUIRED_FIELD");
    }
    netIncomeTtm += netIncome;
  }

  const latestBalanceSheetRank = latestRank(balanceSheet);
  if (latestBalanceSheetRank === undefined) {
    return notApplicable("MISSING_LATEST_STATE");
  }
  const latestBalanceSheet = balanceSheet.get(latestBalanceSheetRank);
  const latestIncome = income.get(anchor);
  if (!latestBalanceSheet || !latestIncome) {
    return notApplicable("MISSING_LATEST_STATE");
  }

  const bookValue = numericValue(
    latestBalanceSheet,
    "totalStockholdersEquity",
  );
  const shares = numericValue(latestIncome, "weightedAverageShsOutDil");
  if (bookValue === undefined || shares === undefined) {
    return notApplicable("MISSING_REQUIRED_FIELD");
  }

  return ready(
    {
      netIncomeTtm,
      bookValue,
      shares,
      growthUsed: growth.growthUsed,
    },
    [...incomeRows, latestBalanceSheet, latestIncome, ...growth.statements],
  );
}

function assembleDdm(
  cashFlow: QuarterlyIndex,
  income: QuarterlyIndex,
): AssembledModelInput<DdmInput> {
  const anchor = latestCommonRank([cashFlow, income]);
  if (anchor === undefined) {
    return notApplicable("MISSING_TTM_WINDOW");
  }
  const window = trailingWindow(anchor);
  const cashFlowRows = windowStatements(cashFlow, window);
  const incomeRows = windowStatements(income, window);
  if (!cashFlowRows || !incomeRows) {
    return notApplicable("MISSING_TTM_WINDOW");
  }

  let dpsTtm = 0;
  for (const [index, cashFlowRow] of cashFlowRows.entries()) {
    const incomeRow = incomeRows[index];
    if (!incomeRow) {
      return notApplicable("MISSING_TTM_WINDOW");
    }
    // Common dividends only; a missing field is never a zero dividend.
    const commonDividendsPaid = numericValue(cashFlowRow, "commonDividendsPaid");
    const shares = numericValue(incomeRow, "weightedAverageShsOutDil");
    if (commonDividendsPaid === undefined || shares === undefined) {
      return notApplicable("MISSING_REQUIRED_FIELD");
    }
    if (shares <= 0) {
      return notApplicable("INVALID_DILUTED_SHARES");
    }
    // Dividends paid are signed outflows; each quarter is divided by its own share count.
    dpsTtm += Math.abs(commonDividendsPaid) / shares;
  }

  return ready({ dpsTtm }, [...cashFlowRows, ...incomeRows]);
}

function assembleGraham(
  income: QuarterlyIndex,
  growth: GrowthAssembly,
): AssembledModelInput<GrahamInput> {
  const anchor = latestRank(income);
  if (anchor === undefined) {
    return notApplicable("MISSING_TTM_WINDOW");
  }
  const incomeRows = windowStatements(income, trailingWindow(anchor));
  if (!incomeRows) {
    return notApplicable("MISSING_TTM_WINDOW");
  }

  let epsTtm = 0;
  for (const row of incomeRows) {
    const epsDiluted = numericValue(row, "epsDiluted");
    if (epsDiluted === undefined) {
      return notApplicable("MISSING_REQUIRED_FIELD");
    }
    epsTtm += epsDiluted;
  }

  return ready({ epsTtm, growthUsed: growth.growthUsed }, [
    ...incomeRows,
    ...growth.statements,
  ]);
}

/**
 * Assembles model-ready numeric inputs for one security on one trading day.
 *
 * The only point-in-time cutoff is `valuationDate`: statements are filtered to
 * `availableFromDate <= valuationDate` and reduced to the latest eligible revision per fiscal
 * identity by the canonical domain selector, so no future revision can leak in. There is no clock,
 * no provider call and no current-profile data, which makes the same statements and valuation date
 * always produce the same result.
 *
 * Each model is assembled and currency-validated independently; one model may be READY in one
 * currency while another is READY in a different one. Row-level cross-model currency consistency
 * belongs to the daily materializer, not here. No valuation formula is evaluated.
 */
export function assembleIntrinsicValueInputs(
  request: IntrinsicValueInputRequest,
): IntrinsicValueInputs {
  const eligible = selectFinancialStatements(
    request.statements.filter(
      (statement) => statement.securityId === request.securityId,
    ),
    { asOf: request.valuationDate },
  );

  const quarterlyIncome = indexQuarterly(eligible, "INCOME");
  const quarterlyCashFlow = indexQuarterly(eligible, "CASH_FLOW");
  const quarterlyBalanceSheet = indexQuarterly(eligible, "BALANCE_SHEET");
  const growth = assembleGrowth(indexAnnualIncome(eligible));

  return {
    DCF_FCFF: assembleDcfFcff(
      quarterlyCashFlow,
      quarterlyIncome,
      quarterlyBalanceSheet,
      growth,
    ),
    RESIDUAL_INCOME: assembleResidualIncome(
      quarterlyIncome,
      quarterlyBalanceSheet,
      growth,
    ),
    DDM: assembleDdm(quarterlyCashFlow, quarterlyIncome),
    GRAHAM: assembleGraham(quarterlyIncome, growth),
  } satisfies Record<IntrinsicValueModel, AssembledModelInput<unknown>>;
}

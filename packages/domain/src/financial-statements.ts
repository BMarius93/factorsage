import type { DateRange, Instant, LocalDate, SecurityId } from "./stock-data.js";

export const FINANCIAL_STATEMENT_TYPES = [
  "INCOME",
  "BALANCE_SHEET",
  "CASH_FLOW",
] as const;
export type FinancialStatementType =
  (typeof FINANCIAL_STATEMENT_TYPES)[number];

export const FINANCIAL_STATEMENT_CADENCES = ["QUARTERLY", "ANNUAL"] as const;
export type FinancialStatementCadence =
  (typeof FINANCIAL_STATEMENT_CADENCES)[number];

/**
 * `Q1`-`Q4` are standalone provider quarters, not cumulative YTD periods: the four quarters sum to
 * the `FY` row. The application never converts between the two cadences.
 */
export const FINANCIAL_PERIODS = ["FY", "Q1", "Q2", "Q3", "Q4"] as const;
export type FinancialPeriod = (typeof FINANCIAL_PERIODS)[number];

/**
 * Provider values are canonical exactly as FMP supplies them; nothing normalizes a sign.
 *
 * `interestExpense` is a positive expense magnitude when reported separately, so an after-tax
 * add-back multiplies it rather than negating it. See `docs/decisions/fundamentals-loader.md`.
 */
export const INCOME_STATEMENT_FIELDS = [
  "revenue",
  "costOfRevenue",
  "grossProfit",
  "researchAndDevelopmentExpenses",
  "generalAndAdministrativeExpenses",
  "sellingAndMarketingExpenses",
  "sellingGeneralAndAdministrativeExpenses",
  "otherExpenses",
  "operatingExpenses",
  "costAndExpenses",
  "netInterestIncome",
  "interestIncome",
  "interestExpense",
  "depreciationAndAmortization",
  "ebitda",
  "ebit",
  "nonOperatingIncomeExcludingInterest",
  "operatingIncome",
  "totalOtherIncomeExpensesNet",
  "incomeBeforeTax",
  "incomeTaxExpense",
  "netIncomeFromContinuingOperations",
  "netIncomeFromDiscontinuedOperations",
  "otherAdjustmentsToNetIncome",
  "netIncome",
  "netIncomeDeductions",
  "bottomLineNetIncome",
  "eps",
  "epsDiluted",
  "weightedAverageShsOut",
  "weightedAverageShsOutDil",
] as const;
export type IncomeStatementField = (typeof INCOME_STATEMENT_FIELDS)[number];

export const BALANCE_SHEET_FIELDS = [
  "cashAndCashEquivalents",
  "shortTermInvestments",
  "cashAndShortTermInvestments",
  "netReceivables",
  "accountsReceivables",
  "otherReceivables",
  "inventory",
  "prepaids",
  "otherCurrentAssets",
  "totalCurrentAssets",
  "propertyPlantEquipmentNet",
  "goodwill",
  "intangibleAssets",
  "goodwillAndIntangibleAssets",
  "longTermInvestments",
  "taxAssets",
  "otherNonCurrentAssets",
  "totalNonCurrentAssets",
  "otherAssets",
  "totalAssets",
  "totalPayables",
  "accountPayables",
  "otherPayables",
  "accruedExpenses",
  "shortTermDebt",
  "capitalLeaseObligationsCurrent",
  "taxPayables",
  "deferredRevenue",
  "otherCurrentLiabilities",
  "totalCurrentLiabilities",
  "longTermDebt",
  "capitalLeaseObligationsNonCurrent",
  "deferredRevenueNonCurrent",
  "deferredTaxLiabilitiesNonCurrent",
  "otherNonCurrentLiabilities",
  "totalNonCurrentLiabilities",
  "otherLiabilities",
  "capitalLeaseObligations",
  "totalLiabilities",
  "treasuryStock",
  "preferredStock",
  "commonStock",
  "retainedEarnings",
  "additionalPaidInCapital",
  "accumulatedOtherComprehensiveIncomeLoss",
  "otherTotalStockholdersEquity",
  "totalStockholdersEquity",
  "totalEquity",
  "minorityInterest",
  "totalLiabilitiesAndTotalEquity",
  "totalInvestments",
  "totalDebt",
  "netDebt",
] as const;
export type BalanceSheetField = (typeof BALANCE_SHEET_FIELDS)[number];

/**
 * Provider values are canonical exactly as FMP supplies them; nothing normalizes a sign.
 *
 * Verified conventions consumers must interpret explicitly:
 * - `capitalExpenditure`, `commonDividendsPaid` and `netDividendsPaid` are signed cash outflows
 *   and are normally negative, so they are added rather than subtracted;
 * - `freeCashFlow` is the provider's own `operatingCashFlow + capitalExpenditure` result. It is
 *   never recalculated here and is a reconciliation value, not a primary valuation input;
 * - `changeInWorkingCapital` is already the signed cash-flow contribution and may carry either
 *   sign. Its effect is already inside `operatingCashFlow`; never subtract it again as a
 *   conventional positive delta-NWC.
 *
 * See `docs/decisions/fundamentals-loader.md` for the verification and
 * `packages/fmp/src/mapping.test.ts` for the tests that lock these semantics.
 */
export const CASH_FLOW_FIELDS = [
  "netIncome",
  "depreciationAndAmortization",
  "deferredIncomeTax",
  "stockBasedCompensation",
  "changeInWorkingCapital",
  "accountsReceivables",
  "inventory",
  "accountsPayables",
  "otherWorkingCapital",
  "otherNonCashItems",
  "netCashProvidedByOperatingActivities",
  "investmentsInPropertyPlantAndEquipment",
  "acquisitionsNet",
  "purchasesOfInvestments",
  "salesMaturitiesOfInvestments",
  "otherInvestingActivities",
  "netCashProvidedByInvestingActivities",
  "netDebtIssuance",
  "longTermNetDebtIssuance",
  "shortTermNetDebtIssuance",
  "netStockIssuance",
  "netCommonStockIssuance",
  "commonStockIssuance",
  "commonStockRepurchased",
  "netPreferredStockIssuance",
  "netDividendsPaid",
  "commonDividendsPaid",
  "preferredDividendsPaid",
  "otherFinancingActivities",
  "netCashProvidedByFinancingActivities",
  "effectOfForexChangesOnCash",
  "netChangeInCash",
  "cashAtEndOfPeriod",
  "cashAtBeginningOfPeriod",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
  "incomeTaxesPaid",
  "interestPaid",
] as const;
export type CashFlowField = (typeof CASH_FLOW_FIELDS)[number];

type CanonicalValues<Catalog extends readonly string[]> = Partial<
  Record<Catalog[number], number>
>;

export type IncomeStatementValues = CanonicalValues<typeof INCOME_STATEMENT_FIELDS>;
export type BalanceSheetValues = CanonicalValues<typeof BALANCE_SHEET_FIELDS>;
export type CashFlowValues = CanonicalValues<typeof CASH_FLOW_FIELDS>;

export type FinancialStatementValuesByType = {
  INCOME: IncomeStatementValues;
  BALANCE_SHEET: BalanceSheetValues;
  CASH_FLOW: CashFlowValues;
};

export type FinancialStatement<T extends FinancialStatementType = FinancialStatementType> = {
  securityId: SecurityId;
  statementType: T;
  fiscalDate: LocalDate;
  fiscalYear: number;
  period: FinancialPeriod;
  reportedCurrency: string;
  filingDate: LocalDate;
  availableFromDate: LocalDate;
  observedAt: Instant;
  contentHash: string;
  values: FinancialStatementValuesByType[T];
};

/**
 * The regulatory deadlines FactorSage falls back on when the provider gives no usable filing date.
 *
 * The widest statutory deadline for each report is used on purpose. A filer's class is not in this
 * product's data, and the widest class (non-accelerated) bounds every other one: 45 days after a
 * quarter for a 10-Q, 90 days after a fiscal year for a 10-K. A `Q4` statement is published with
 * the annual report rather than a fourth 10-Q, so it takes the annual deadline.
 *
 * Being late is safe; being early is look-ahead. See
 * `docs/data-correctness-audit/FINAL_DATA_CORRECTNESS_AUDIT.md` (AUD-03).
 */
export const QUARTERLY_REPORT_DEADLINE_DAYS = 45;
export const ANNUAL_REPORT_DEADLINE_DAYS = 90;

function addCalendarDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Saturday and Sunday push a regulatory due date to the following Monday. */
function nextBusinessDay(date: LocalDate): LocalDate {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return weekday === 6
    ? addCalendarDays(date, 2)
    : weekday === 0
      ? addCalendarDays(date, 1)
      : date;
}

/**
 * The first date a statement's figures may be used by a historical calculation.
 *
 * **The rule.** A statement may not affect a historical decision before its information could
 * reasonably have been public. Where the provider supplies a real filing date, that date plus one
 * day is that boundary: the filing is public once it is filed, and the following day is the first
 * whole session that could trade on it.
 *
 * **Where the provider does not.** FMP reports the fiscal period end in `filingDate` (and in
 * `acceptedDate`) for statements whose real filing date it does not hold — it did so for 2,391 of
 * the 16,793 statements this product had stored, including every DIS quarter before the 2019
 * restructuring and every GOOGL quarter before Alphabet's 2015 Q3. Deriving availability from that
 * makes a quarter's results usable the day after the quarter closed, weeks before any filing
 * existed, which is look-ahead. Such a date is not a filing date at all, so the fallback is the
 * latest date the report could lawfully have appeared: the statutory deadline, moved to the next
 * business day when it lands on a weekend, plus one day.
 *
 * The fallback deliberately claims no precision it does not have. It can make information visible
 * later than it really was — for a large accelerated filer by up to a month — and never earlier.
 */
export function statementPublicAvailabilityDate(statement: {
  fiscalDate: LocalDate;
  filingDate: LocalDate;
  period: FinancialPeriod;
}): LocalDate {
  if (statement.filingDate > statement.fiscalDate) {
    return addCalendarDays(statement.filingDate, 1);
  }
  const deadline =
    statement.period === "FY" || statement.period === "Q4"
      ? ANNUAL_REPORT_DEADLINE_DAYS
      : QUARTERLY_REPORT_DEADLINE_DAYS;
  const due = nextBusinessDay(addCalendarDays(statement.fiscalDate, deadline));
  return addCalendarDays(due, 1);
}

/** Whether the provider's filing date for this statement cannot be a real filing date. */
export function hasUnusableProviderFilingDate(statement: {
  fiscalDate: LocalDate;
  filingDate: LocalDate;
}): boolean {
  return statement.filingDate <= statement.fiscalDate;
}

export type FinancialStatementDraft<
  T extends FinancialStatementType = FinancialStatementType,
> = {
  securityId: SecurityId;
  statementType: T;
  fiscalDate: LocalDate;
  fiscalYear: number;
  period: FinancialPeriod;
  reportedCurrency: string;
  filingDate: LocalDate;
  providerAcceptedDate?: string;
  values: FinancialStatementValuesByType[T];
};

export type FinancialStatementQuery = DateRange & {
  statementTypes?: readonly FinancialStatementType[];
  cadence?: FinancialStatementCadence;
  asOf?: LocalDate;
};

const STATEMENT_TYPE_ORDER: FinancialStatementType[] = [
  "INCOME",
  "BALANCE_SHEET",
  "CASH_FLOW",
];

const PERIOD_ORDER: FinancialPeriod[] = ["FY", "Q1", "Q2", "Q3", "Q4"];

function cadenceForPeriod(period: FinancialPeriod): FinancialStatementCadence {
  return period === "FY" ? "ANNUAL" : "QUARTERLY";
}

function periodRank(period: FinancialPeriod): number {
  return PERIOD_ORDER.indexOf(period);
}

function statementTypeRank(statementType: FinancialStatementType): number {
  return STATEMENT_TYPE_ORDER.indexOf(statementType);
}

function revisionRank(
  left: FinancialStatement,
  right: FinancialStatement,
): number {
  return (
    left.availableFromDate.localeCompare(right.availableFromDate) ||
    left.observedAt.localeCompare(right.observedAt) ||
    left.contentHash.localeCompare(right.contentHash)
  );
}

function statementKey(statement: FinancialStatement): string {
  return [
    statement.securityId,
    statement.statementType,
    statement.fiscalYear,
    statement.period,
    statement.fiscalDate,
  ].join(":");
}

function matchesQuery(
  statement: FinancialStatement,
  query: FinancialStatementQuery,
): boolean {
  if (query.statementTypes && !query.statementTypes.includes(statement.statementType)) {
    return false;
  }
  if (query.cadence && cadenceForPeriod(statement.period) !== query.cadence) {
    return false;
  }
  if (query.from && statement.fiscalDate < query.from) {
    return false;
  }
  if (query.to && statement.fiscalDate > query.to) {
    return false;
  }
  if (query.asOf && statement.availableFromDate > query.asOf) {
    return false;
  }
  return true;
}

export function selectFinancialStatements(
  statements: readonly FinancialStatement[],
  query: FinancialStatementQuery = {},
): FinancialStatement[] {
  const selected = new Map<string, FinancialStatement>();
  for (const statement of statements) {
    if (!matchesQuery(statement, query)) {
      continue;
    }
    const key = statementKey(statement);
    const existing = selected.get(key);
    if (!existing || revisionRank(statement, existing) > 0) {
      selected.set(key, statement);
    }
  }
  return [...selected.values()].sort(
    (left, right) =>
      left.fiscalDate.localeCompare(right.fiscalDate) ||
      statementTypeRank(left.statementType) - statementTypeRank(right.statementType) ||
      periodRank(left.period) - periodRank(right.period) ||
      left.availableFromDate.localeCompare(right.availableFromDate) ||
      left.observedAt.localeCompare(right.observedAt) ||
      left.contentHash.localeCompare(right.contentHash),
  );
}

export function statementCadence(
  statement: Pick<FinancialStatement, "period">,
): FinancialStatementCadence {
  return cadenceForPeriod(statement.period);
}
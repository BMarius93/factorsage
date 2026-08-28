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

export const FINANCIAL_PERIODS = ["FY", "Q1", "Q2", "Q3", "Q4"] as const;
export type FinancialPeriod = (typeof FINANCIAL_PERIODS)[number];

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

export type FinancialStatementDraft<T extends FinancialStatementType = FinancialStatementType> = {
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
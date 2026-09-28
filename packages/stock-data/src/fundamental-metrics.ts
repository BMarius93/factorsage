import {
  FUNDAMENTAL_METRICS,
  selectFinancialStatements,
  type BalanceSheetField,
  type CashFlowField,
  type FinancialStatement,
  type FundamentalMetricId,
  type FundamentalMetricSnapshot,
  type IncomeStatementField,
  type LocalDate,
  type SecurityId,
} from "@intrinsic/domain";
import { exactDecimalSum } from "./exact-decimal-sum.js";
import {
  alignedOpeningAndEndingStates,
  commonTrailingFiscalQuarterWindow,
  indexFiscalQuarters,
  latestFiscalQuarterStatement,
  trailingFiscalQuarterWindow,
  trailingYearOverYearWindows,
  TTM_QUARTERS,
  type AlignedStates,
  type FiscalQuarterWindow,
  type YearOverYearWindows,
} from "./fiscal-quarters.js";

/**
 * The fifteen Fundamental Metrics V1 formulas, exactly as locked by
 * `docs/decisions/fundamental-metrics-v1.md`.
 *
 * Pure and infrastructure-free: canonical `FinancialStatement` revisions in, one point-in-time
 * snapshot out. No Prisma, no Redis, no provider DTO, no Strategy document, no clock. The same
 * statements and the same trading day always produce the same snapshot, whatever order the
 * statements arrive in, and nothing the caller passed is mutated.
 *
 * Unavailability is absence. A metric is omitted from the snapshot when a required quarter
 * identity, a required field or a denominator rule fails, and a result that is not a finite
 * number is rejected rather than returned. Missing is never zero, and a provider-reported zero
 * stays a real zero.
 *
 * Every sum is the exact sum of the reported decimals (`exactDecimalSum`), so a rule such as
 * `require EPS_TTM > 0` is decided on the true sign of the sum, never on binary rounding residue.
 */

/**
 * Fixed tax assumption of ROIC TTM's NOPAT. Deliberately the same number as the V1 valuation tax
 * rate, but owned here: Fundamental Metrics never reads a runtime, current or company-specific tax
 * rate, and the statements' own tax lines play no part.
 */
export const FUNDAMENTAL_ROIC_TAX_RATE = 0.21;

export type FundamentalMetricEvaluationRequest = {
  securityId: SecurityId;
  /** The trading day the snapshot is effective on — the only point-in-time cutoff. */
  date: LocalDate;
  statements: readonly FinancialStatement[];
};

/**
 * The point-in-time quarterly windows the fifteen formulas read, assembled once per evaluation by
 * the shared fiscal-quarter helpers. No formula selects its own quarters.
 */
export type FundamentalStatementWindows = {
  /** `Q[-3]..Q[0]` ending at the latest eligible Income quarter. */
  incomeTtm?: FiscalQuarterWindow;
  /** Eight consecutive Income quarters ending at the latest eligible one. */
  incomeYearOverYear?: YearOverYearWindows;
  /** Eight consecutive Cash Flow quarters ending at the latest eligible one. */
  cashFlowYearOverYear?: YearOverYearWindows;
  /**
   * One common four-quarter window across Income and Cash Flow, anchored at the latest quarter
   * both families hold: the two families always cover the same fiscal identities.
   */
  incomeAndCashFlowTtm?: {
    income: readonly FinancialStatement[];
    cashFlow: readonly FinancialStatement[];
  };
  /**
   * Balance sheets aligned to `incomeTtm`: the quarter immediately before `Q[-3]` and `Q[0]`. A
   * newer balance sheet that happens to be eligible never replaces the aligned ending state.
   */
  alignedBalanceSheets?: AlignedStates;
  /** The latest independently eligible quarterly balance sheet, for the latest-state metrics. */
  latestBalanceSheet?: FinancialStatement;
};

/**
 * Selects the statements visible on `date` and assembles every window the formulas read.
 *
 * Only revisions with `availableFromDate <= date` exist here, reduced to the latest eligible
 * revision per fiscal identity by the canonical domain selector, and only standalone quarterly rows
 * — an `FY` row can never enter a window. A revision that is stored but not yet eligible is
 * invisible, so no later information can reach an earlier trading day.
 */
export function assembleFundamentalWindows(
  request: FundamentalMetricEvaluationRequest,
): FundamentalStatementWindows {
  const eligible = selectFinancialStatements(
    request.statements.filter(
      (statement) => statement.securityId === request.securityId,
    ),
    { asOf: request.date, cadence: "QUARTERLY" },
  );
  const income = indexFiscalQuarters(eligible, "INCOME");
  const balanceSheet = indexFiscalQuarters(eligible, "BALANCE_SHEET");
  const cashFlow = indexFiscalQuarters(eligible, "CASH_FLOW");

  const incomeTtm = trailingFiscalQuarterWindow(income, TTM_QUARTERS);
  const incomeYearOverYear = trailingYearOverYearWindows(income);
  const cashFlowYearOverYear = trailingYearOverYearWindows(cashFlow);
  const common = commonTrailingFiscalQuarterWindow(
    [income, cashFlow],
    TTM_QUARTERS,
  );
  const [commonIncome, commonCashFlow] = common?.statements ?? [];
  const alignedBalanceSheets = incomeTtm
    ? alignedOpeningAndEndingStates(balanceSheet, {
        endRank: incomeTtm.endRank,
        count: TTM_QUARTERS,
      })
    : undefined;
  const latestBalanceSheet = latestFiscalQuarterStatement(balanceSheet);

  return {
    ...(incomeTtm ? { incomeTtm } : {}),
    ...(incomeYearOverYear ? { incomeYearOverYear } : {}),
    ...(cashFlowYearOverYear ? { cashFlowYearOverYear } : {}),
    ...(commonIncome && commonCashFlow
      ? {
          incomeAndCashFlowTtm: {
            income: commonIncome,
            cashFlow: commonCashFlow,
          },
        }
      : {}),
    ...(alignedBalanceSheets ? { alignedBalanceSheets } : {}),
    ...(latestBalanceSheet ? { latestBalanceSheet } : {}),
  };
}

/**
 * A line item as a finite number, or `undefined` when the provider did not supply one. A reported
 * zero is returned as zero; nothing here substitutes a value.
 */
function finiteValue(
  statement: FinancialStatement,
  field: IncomeStatementField | BalanceSheetField | CashFlowField,
): number | undefined {
  const value = (statement.values as Readonly<Record<string, unknown>>)[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Sum of one Income line over a window, or `undefined` if any quarter lacks it. */
function incomeSum(
  rows: readonly FinancialStatement[],
  field: IncomeStatementField,
): number | undefined {
  const values: number[] = [];
  for (const row of rows) {
    const value = finiteValue(row, field);
    if (value === undefined) {
      return undefined;
    }
    values.push(value);
  }
  return exactDecimalSum(values);
}

/**
 * `sum(operatingCashFlow_q + capitalExpenditure_q)` over a window, or `undefined` if any quarter
 * lacks either component.
 *
 * FMP reports capital expenditure as a signed outflow, normally negative, so per-quarter free cash
 * flow is an **addition**. The provider's own `freeCashFlow` is a reconciliation field and is never
 * read, not even to fill a missing component.
 */
function freeCashFlowSum(
  rows: readonly FinancialStatement[],
): number | undefined {
  const components: number[] = [];
  for (const row of rows) {
    const operatingCashFlow = finiteValue(row, "operatingCashFlow");
    const capitalExpenditure = finiteValue(row, "capitalExpenditure");
    if (operatingCashFlow === undefined || capitalExpenditure === undefined) {
      return undefined;
    }
    // FCF_q = operatingCashFlow_q + capitalExpenditure_q, summed exactly over the window.
    components.push(operatingCashFlow, capitalExpenditure);
  }
  return exactDecimalSum(components);
}

/**
 * `(current / previous - 1) * 100`, available only when both trailing sums are positive. A
 * loss-to-profit or profit-to-loss crossing, or two non-positive windows, is unavailable rather than
 * an enormous or sign-inverted percentage.
 */
function trailingGrowthPercent(
  current: number | undefined,
  previous: number | undefined,
): number | undefined {
  if (current === undefined || previous === undefined) {
    return undefined;
  }
  if (!(current > 0) || !(previous > 0)) {
    return undefined;
  }
  return (current / previous - 1) * 100;
}

/** `numerator / revenue * 100` — a ratio of sums, never a mean of quarterly ratios. */
function revenueMarginPercent(
  numerator: number | undefined,
  revenue: number | undefined,
): number | undefined {
  if (numerator === undefined || revenue === undefined || !(revenue > 0)) {
    return undefined;
  }
  return (numerator / revenue) * 100;
}

/** `(opening + ending) / 2` of one balance-sheet line, or `undefined` if either state lacks it. */
function averageState(
  states: AlignedStates,
  field: BalanceSheetField,
): number | undefined {
  const opening = finiteValue(states.opening, field);
  const ending = finiteValue(states.ending, field);
  if (opening === undefined || ending === undefined) {
    return undefined;
  }
  return exactDecimalSum([opening, ending]) / 2;
}

/**
 * The terms of `totalDebt + totalStockholdersEquity - cash` for one balance-sheet state, so the
 * average of two states can be summed exactly in one step.
 *
 * `cash` is `cashAndShortTermInvestments`, falling back to `cashAndCashEquivalents` only when the
 * primary field is absent — two fields of the same row, never another row. There is deliberately no
 * fallback from `totalStockholdersEquity` to `totalEquity`: minority interest would change what the
 * denominator means.
 */
function investedCapitalTerms(
  balanceSheet: FinancialStatement,
): number[] | undefined {
  const cash =
    finiteValue(balanceSheet, "cashAndShortTermInvestments") ??
    finiteValue(balanceSheet, "cashAndCashEquivalents");
  const totalDebt = finiteValue(balanceSheet, "totalDebt");
  const totalStockholdersEquity = finiteValue(
    balanceSheet,
    "totalStockholdersEquity",
  );
  if (
    cash === undefined ||
    totalDebt === undefined ||
    totalStockholdersEquity === undefined
  ) {
    return undefined;
  }
  return [totalDebt, totalStockholdersEquity, -cash];
}

function revenueGrowthTtmYoy(
  windows: FundamentalStatementWindows,
): number | undefined {
  const chain = windows.incomeYearOverYear;
  if (!chain) {
    return undefined;
  }
  return trailingGrowthPercent(
    incomeSum(chain.current, "revenue"),
    incomeSum(chain.previous, "revenue"),
  );
}

/**
 * Sums standalone quarterly `epsDiluted`, the same convention as the Graham model; EPS is never
 * reconstructed from a share count.
 */
function epsGrowthTtmYoy(
  windows: FundamentalStatementWindows,
): number | undefined {
  const chain = windows.incomeYearOverYear;
  if (!chain) {
    return undefined;
  }
  return trailingGrowthPercent(
    incomeSum(chain.current, "epsDiluted"),
    incomeSum(chain.previous, "epsDiluted"),
  );
}

function fcfGrowthTtmYoy(
  windows: FundamentalStatementWindows,
): number | undefined {
  const chain = windows.cashFlowYearOverYear;
  if (!chain) {
    return undefined;
  }
  return trailingGrowthPercent(
    freeCashFlowSum(chain.current),
    freeCashFlowSum(chain.previous),
  );
}

function incomeMargin(
  windows: FundamentalStatementWindows,
  numerator: IncomeStatementField,
): number | undefined {
  const window = windows.incomeTtm;
  if (!window) {
    return undefined;
  }
  return revenueMarginPercent(
    incomeSum(window.statements, numerator),
    incomeSum(window.statements, "revenue"),
  );
}

/** Revenue and free cash flow from one common fiscal window, never two independent ones. */
function fcfMarginTtm(
  windows: FundamentalStatementWindows,
): number | undefined {
  const common = windows.incomeAndCashFlowTtm;
  if (!common) {
    return undefined;
  }
  return revenueMarginPercent(
    freeCashFlowSum(common.cashFlow),
    incomeSum(common.income, "revenue"),
  );
}

function roicTtm(windows: FundamentalStatementWindows): number | undefined {
  const window = windows.incomeTtm;
  const states = windows.alignedBalanceSheets;
  if (!window || !states) {
    return undefined;
  }
  const operatingIncomeTtm = incomeSum(window.statements, "operatingIncome");
  const openingTerms = investedCapitalTerms(states.opening);
  const endingTerms = investedCapitalTerms(states.ending);
  if (
    operatingIncomeTtm === undefined ||
    openingTerms === undefined ||
    endingTerms === undefined
  ) {
    return undefined;
  }
  const nopatTtm = operatingIncomeTtm * (1 - FUNDAMENTAL_ROIC_TAX_RATE);
  // (openingInvestedCapital + endingInvestedCapital) / 2, with both states summed exactly at once.
  const averageInvestedCapital =
    exactDecimalSum([...openingTerms, ...endingTerms]) / 2;
  if (!(averageInvestedCapital > 0)) {
    return undefined;
  }
  return (nopatTtm / averageInvestedCapital) * 100;
}

/** `sum(netIncome) / average(state) * 100` over the aligned opening and ending states. */
function returnOnAverageState(
  windows: FundamentalStatementWindows,
  stateField: BalanceSheetField,
): number | undefined {
  const window = windows.incomeTtm;
  const states = windows.alignedBalanceSheets;
  if (!window || !states) {
    return undefined;
  }
  const netIncomeTtm = incomeSum(window.statements, "netIncome");
  const average = averageState(states, stateField);
  if (netIncomeTtm === undefined || average === undefined || !(average > 0)) {
    return undefined;
  }
  return (netIncomeTtm / average) * 100;
}

function debtToEquity(
  windows: FundamentalStatementWindows,
): number | undefined {
  const balanceSheet = windows.latestBalanceSheet;
  if (!balanceSheet) {
    return undefined;
  }
  const totalDebt = finiteValue(balanceSheet, "totalDebt");
  const totalStockholdersEquity = finiteValue(
    balanceSheet,
    "totalStockholdersEquity",
  );
  // Zero or negative equity is unavailable rather than a misleading signed leverage ratio.
  if (
    totalDebt === undefined ||
    totalStockholdersEquity === undefined ||
    !(totalStockholdersEquity > 0)
  ) {
    return undefined;
  }
  return totalDebt / totalStockholdersEquity;
}

function currentRatio(
  windows: FundamentalStatementWindows,
): number | undefined {
  const balanceSheet = windows.latestBalanceSheet;
  if (!balanceSheet) {
    return undefined;
  }
  const totalCurrentAssets = finiteValue(balanceSheet, "totalCurrentAssets");
  const totalCurrentLiabilities = finiteValue(
    balanceSheet,
    "totalCurrentLiabilities",
  );
  if (
    totalCurrentAssets === undefined ||
    totalCurrentLiabilities === undefined ||
    !(totalCurrentLiabilities > 0)
  ) {
    return undefined;
  }
  return totalCurrentAssets / totalCurrentLiabilities;
}

/**
 * The latest Income TTM EBITDA against the latest independently eligible `netDebt`: deliberately a
 * current leverage snapshot, so the balance sheet may be newer than the flow window. Negative net
 * debt is a real net-cash reading; a missing `netDebt` is never reconstructed from other fields.
 */
function netDebtToEbitdaTtm(
  windows: FundamentalStatementWindows,
): number | undefined {
  const window = windows.incomeTtm;
  const balanceSheet = windows.latestBalanceSheet;
  if (!window || !balanceSheet) {
    return undefined;
  }
  const ebitdaTtm = incomeSum(window.statements, "ebitda");
  const netDebt = finiteValue(balanceSheet, "netDebt");
  if (ebitdaTtm === undefined || netDebt === undefined || !(ebitdaTtm > 0)) {
    return undefined;
  }
  return netDebt / ebitdaTtm;
}

/**
 * `sum(ebit) / sum(interestExpense)`. Zero interest expense would make the ratio unbounded and a
 * missing one is not zero, so both are unavailable; negative EBIT is a real negative reading.
 */
function interestCoverageTtm(
  windows: FundamentalStatementWindows,
): number | undefined {
  const window = windows.incomeTtm;
  if (!window) {
    return undefined;
  }
  const ebitTtm = incomeSum(window.statements, "ebit");
  const interestExpenseTtm = incomeSum(window.statements, "interestExpense");
  if (
    ebitTtm === undefined ||
    interestExpenseTtm === undefined ||
    !(interestExpenseTtm > 0)
  ) {
    return undefined;
  }
  return ebitTtm / interestExpenseTtm;
}

function assetTurnoverTtm(
  windows: FundamentalStatementWindows,
): number | undefined {
  const window = windows.incomeTtm;
  const states = windows.alignedBalanceSheets;
  if (!window || !states) {
    return undefined;
  }
  const revenueTtm = incomeSum(window.statements, "revenue");
  const averageAssets = averageState(states, "totalAssets");
  if (
    revenueTtm === undefined ||
    averageAssets === undefined ||
    !(revenueTtm > 0) ||
    !(averageAssets > 0)
  ) {
    return undefined;
  }
  return revenueTtm / averageAssets;
}

type FundamentalMetricCalculator = (
  windows: FundamentalStatementWindows,
) => number | undefined;

/**
 * One calculator per registered identity. Keyed by the registry's own identity type, so a metric
 * added to the registry without a formula — or a formula without a registry entry — is a compile
 * error rather than a column that silently reads as unavailable.
 */
const CALCULATORS = {
  REVENUE_GROWTH_TTM_YOY: revenueGrowthTtmYoy,
  EPS_GROWTH_TTM_YOY: epsGrowthTtmYoy,
  FCF_GROWTH_TTM_YOY: fcfGrowthTtmYoy,
  GROSS_MARGIN_TTM: (windows) => incomeMargin(windows, "grossProfit"),
  OPERATING_MARGIN_TTM: (windows) => incomeMargin(windows, "operatingIncome"),
  NET_MARGIN_TTM: (windows) => incomeMargin(windows, "netIncome"),
  FCF_MARGIN_TTM: fcfMarginTtm,
  ROIC_TTM: roicTtm,
  ROE_TTM: (windows) =>
    returnOnAverageState(windows, "totalStockholdersEquity"),
  ROA_TTM: (windows) => returnOnAverageState(windows, "totalAssets"),
  DEBT_TO_EQUITY: debtToEquity,
  CURRENT_RATIO: currentRatio,
  NET_DEBT_TO_EBITDA_TTM: netDebtToEbitdaTtm,
  INTEREST_COVERAGE_TTM: interestCoverageTtm,
  ASSET_TURNOVER_TTM: assetTurnoverTtm,
} as const satisfies Record<FundamentalMetricId, FundamentalMetricCalculator>;

/**
 * Evaluates all fifteen metrics for one security from the statements visible on one trading day.
 *
 * A stateless snapshot of `date`: it never remembers or looks up an earlier result, so a newer
 * eligible revision that invalidates a metric yields its absence here rather than a stale value.
 * Carry-forward between statement events belongs to the daily materializer.
 *
 * A result that is not a finite number is rejected, never stored as infinity or `NaN`, and an
 * extreme but finite ratio is returned unclamped. A signed zero is returned as plain zero: the sign
 * of zero carries no financial meaning and the persisted decimal has none.
 */
export function evaluateFundamentalMetrics(
  request: FundamentalMetricEvaluationRequest,
): FundamentalMetricSnapshot {
  const windows = assembleFundamentalWindows(request);
  const snapshot: FundamentalMetricSnapshot = {};
  for (const metric of FUNDAMENTAL_METRICS) {
    const value = CALCULATORS[metric.id](windows);
    if (value !== undefined && Number.isFinite(value)) {
      snapshot[metric.field] = value === 0 ? 0 : value;
    }
  }
  return snapshot;
}

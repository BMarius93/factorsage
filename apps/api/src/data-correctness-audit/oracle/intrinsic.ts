/**
 * Reference intrinsic-value engine, written from `docs/decisions/intrinsic-value-engine.md` alone.
 *
 * Nothing here is imported from `@intrinsic/valuation` or `@intrinsic/stock-data`. The formulas are
 * transcribed from the ADR's own text and constants, and the golden vectors printed there are the
 * oracle's unit tests (`intrinsic.test.ts`).
 *
 * Point in time: a valuation on trading day D may read only statement revisions whose
 * `availableFromDate <= D`, and for each fiscal identity (type, fiscal year, period) only the latest
 * such revision. The value is recomputed whenever the eligible set changes and carried forward
 * otherwise, which is the ADR's evaluation-event rule expressed as a pure function of D.
 */

export const FORECAST_YEARS = 10;
export const TAX_RATE = 0.21;
export const DCF_WACC = 0.1;
export const COST_OF_EQUITY = 0.1;
export const TERMINAL_GROWTH = 0.025;
export const DEFAULT_GROWTH = 0.05;
export const MAX_FORECAST_GROWTH = 0.15;

export type OracleStatement = {
  statementType: "INCOME" | "BALANCE_SHEET" | "CASH_FLOW";
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4" | "FY";
  fiscalDate: string;
  filingDate: string;
  availableFromDate: string;
  observedAt: string;
  contentHash: string;
  reportedCurrency: string;
  values: Record<string, unknown>;
};

export type ModelId = "DCF_FCFF" | "RESIDUAL_INCOME" | "DDM" | "GRAHAM";
export type BlendId = "BALANCED" | "CONSERVATIVE" | "DIVIDEND";

export const BLEND_WEIGHTS: Record<
  BlendId,
  Partial<Record<ModelId, number>>
> = {
  BALANCED: { DCF_FCFF: 0.5, RESIDUAL_INCOME: 0.3, GRAHAM: 0.2 },
  CONSERVATIVE: { DCF_FCFF: 0.4, RESIDUAL_INCOME: 0.3, GRAHAM: 0.3 },
  DIVIDEND: { DCF_FCFF: 0.4, DDM: 0.4, RESIDUAL_INCOME: 0.2 },
};

export type ModelOutcome =
  | {
      status: "VALUE";
      value: number;
      currency: string;
      sourceAsOf: string;
      inputs: Record<string, number>;
    }
  | { status: "NOT_APPLICABLE"; reason: string };

export type Valuation = {
  models: Record<ModelId, ModelOutcome>;
  blends: Record<BlendId, { value: number; sourceAsOf: string } | null>;
  /** True when calculated models disagree on currency: the whole day is unavailable. */
  currencyConflict: boolean;
};

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;

function rank(statement: { fiscalYear: number; period: string }): number {
  return (
    statement.fiscalYear * 4 +
    QUARTERS.indexOf(statement.period as (typeof QUARTERS)[number])
  );
}

function numberField(
  statement: OracleStatement,
  field: string,
): number | undefined {
  const value = statement.values[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** The statement set a valuation on `asOf` may read: latest eligible revision per identity. */
export function eligibleStatements(
  statements: readonly OracleStatement[],
  asOf: string,
): OracleStatement[] {
  const latest = new Map<string, OracleStatement>();
  for (const statement of statements) {
    if (statement.availableFromDate > asOf) {
      continue;
    }
    const key = `${statement.statementType}|${statement.fiscalYear}|${statement.period}`;
    const held = latest.get(key);
    if (
      !held ||
      statement.availableFromDate > held.availableFromDate ||
      (statement.availableFromDate === held.availableFromDate &&
        (statement.observedAt > held.observedAt ||
          (statement.observedAt === held.observedAt &&
            statement.contentHash > held.contentHash)))
    ) {
      latest.set(key, statement);
    }
  }
  return [...latest.values()];
}

type Used = OracleStatement[];

function provenance(used: Used): string {
  return used.reduce(
    (max, statement) =>
      statement.availableFromDate > max ? statement.availableFromDate : max,
    "",
  );
}

function sameCurrency(used: Used): string | null {
  const currencies = new Set(
    used.map((statement) => statement.reportedCurrency),
  );
  if (currencies.size !== 1) {
    return null;
  }
  const [currency] = [...currencies];
  return currency ? currency : null;
}

function growth(eligible: readonly OracleStatement[]): {
  growthUsed: number;
  used: Used;
  source: string;
} {
  const annual = eligible.filter(
    (statement) =>
      statement.statementType === "INCOME" && statement.period === "FY",
  );
  if (annual.length === 0) {
    return { growthUsed: DEFAULT_GROWTH, used: [], source: "DEFAULT" };
  }
  const latestYear = Math.max(
    ...annual.map((statement) => statement.fiscalYear),
  );
  const latest = annual.find(
    (statement) => statement.fiscalYear === latestYear,
  )!;
  const earlier = annual.find(
    (statement) => statement.fiscalYear === latestYear - 5,
  );
  if (earlier) {
    for (const field of ["revenue", "netIncome"]) {
      const end = numberField(latest, field);
      const start = numberField(earlier, field);
      if (end !== undefined && start !== undefined && end > 0 && start > 0) {
        const raw = Math.pow(end / start, 1 / 5) - 1;
        return {
          growthUsed: Math.min(raw, MAX_FORECAST_GROWTH),
          used: [latest, earlier],
          source: field,
        };
      }
    }
  }
  return { growthUsed: DEFAULT_GROWTH, used: [], source: "DEFAULT" };
}

function quarterly(
  eligible: readonly OracleStatement[],
  type: OracleStatement["statementType"],
): Map<number, OracleStatement> {
  const map = new Map<number, OracleStatement>();
  for (const statement of eligible) {
    if (statement.statementType === type && statement.period !== "FY") {
      map.set(rank(statement), statement);
    }
  }
  return map;
}

function latestOf(
  map: Map<number, OracleStatement>,
): OracleStatement | undefined {
  let best: number | undefined;
  for (const key of map.keys()) {
    if (best === undefined || key > best) {
      best = key;
    }
  }
  return best === undefined ? undefined : map.get(best);
}

function windowAt(
  anchor: number,
  ...families: Map<number, OracleStatement>[]
): OracleStatement[][] | null {
  const window: OracleStatement[][] = [];
  for (let offset = 3; offset >= 0; offset -= 1) {
    const row: OracleStatement[] = [];
    for (const family of families) {
      const statement = family.get(anchor - offset);
      if (!statement) {
        return null;
      }
      row.push(statement);
    }
    window.push(row);
  }
  return window;
}

function presentValueOfGrowingFlow(
  base: number,
  growthRate: number,
  discount: number,
): number {
  let total = 0;
  for (let year = 1; year <= FORECAST_YEARS; year += 1) {
    total +=
      (base * Math.pow(1 + growthRate, year)) / Math.pow(1 + discount, year);
  }
  return total;
}

function presentTerminal(
  base: number,
  growthRate: number,
  discount: number,
): number {
  const final = base * Math.pow(1 + growthRate, FORECAST_YEARS);
  return (
    (final * (1 + TERMINAL_GROWTH)) /
    (discount - TERMINAL_GROWTH) /
    Math.pow(1 + discount, FORECAST_YEARS)
  );
}

const na = (reason: string): ModelOutcome => ({
  status: "NOT_APPLICABLE",
  reason,
});

function finiteAll(values: number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

export function dcfFcff(input: {
  operatingCashFlowTtm: number;
  capitalExpenditureTtm: number;
  interestExpenseTtm: number;
  growthUsed: number;
  cash: number;
  debt: number;
  shares: number;
}): { value: number } | { reason: string } {
  const {
    operatingCashFlowTtm,
    capitalExpenditureTtm,
    interestExpenseTtm,
    growthUsed,
    cash,
    debt,
    shares,
  } = input;
  if (
    !finiteAll([
      operatingCashFlowTtm,
      capitalExpenditureTtm,
      interestExpenseTtm,
      growthUsed,
      cash,
      debt,
      shares,
    ])
  ) {
    return { reason: "NON_FINITE_INPUT" };
  }
  if (shares <= 0) {
    return { reason: "NON_POSITIVE_SHARES" };
  }
  const fcff0 =
    operatingCashFlowTtm +
    capitalExpenditureTtm +
    interestExpenseTtm * (1 - TAX_RATE);
  if (fcff0 <= 0) {
    return { reason: "NON_POSITIVE_FCFF" };
  }
  const enterprise =
    presentValueOfGrowingFlow(fcff0, growthUsed, DCF_WACC) +
    presentTerminal(fcff0, growthUsed, DCF_WACC);
  const equity = enterprise + cash - debt;
  if (equity <= 0) {
    return { reason: "NON_POSITIVE_EQUITY_VALUE" };
  }
  const value = equity / shares;
  return value > 0 && Number.isFinite(value)
    ? { value }
    : { reason: "NON_POSITIVE_VALUE_PER_SHARE" };
}

export function residualIncome(input: {
  netIncomeTtm: number;
  bookValue: number;
  shares: number;
  growthUsed: number;
}): { value: number } | { reason: string } {
  const { netIncomeTtm, bookValue, shares, growthUsed } = input;
  if (!finiteAll([netIncomeTtm, bookValue, shares, growthUsed])) {
    return { reason: "NON_FINITE_INPUT" };
  }
  if (bookValue <= 0) {
    return { reason: "NON_POSITIVE_BOOK_VALUE" };
  }
  if (shares <= 0) {
    return { reason: "NON_POSITIVE_SHARES" };
  }
  const ri0 = netIncomeTtm - bookValue * COST_OF_EQUITY;
  const equity =
    bookValue +
    presentValueOfGrowingFlow(ri0, growthUsed, COST_OF_EQUITY) +
    presentTerminal(ri0, growthUsed, COST_OF_EQUITY);
  if (equity <= 0) {
    return { reason: "NON_POSITIVE_EQUITY_VALUE" };
  }
  const value = equity / shares;
  return value > 0 && Number.isFinite(value)
    ? { value }
    : { reason: "NON_POSITIVE_VALUE_PER_SHARE" };
}

export function dividendDiscount(
  dpsTtm: number,
): { value: number } | { reason: string } {
  if (!Number.isFinite(dpsTtm)) {
    return { reason: "NON_FINITE_INPUT" };
  }
  if (dpsTtm <= 0) {
    return { reason: "NON_POSITIVE_DIVIDEND" };
  }
  return {
    value:
      (dpsTtm * (1 + TERMINAL_GROWTH)) / (COST_OF_EQUITY - TERMINAL_GROWTH),
  };
}

export function graham(
  epsTtm: number,
  growthUsed: number,
): { value: number } | { reason: string } {
  if (!finiteAll([epsTtm, growthUsed])) {
    return { reason: "NON_FINITE_INPUT" };
  }
  if (epsTtm <= 0) {
    return { reason: "NON_POSITIVE_EPS" };
  }
  const multiplier = 8.5 + 2 * (growthUsed * 100);
  if (multiplier <= 0) {
    return { reason: "NON_POSITIVE_MULTIPLIER" };
  }
  return { value: epsTtm * multiplier };
}

function finish(
  result: { value: number } | { reason: string },
  used: Used,
  inputs: Record<string, number>,
): ModelOutcome {
  if ("reason" in result) {
    return na(result.reason);
  }
  const currency = sameCurrency(used);
  if (!currency) {
    return na("CURRENCY_MISMATCH");
  }
  return {
    status: "VALUE",
    value: result.value,
    currency,
    sourceAsOf: provenance(used),
    inputs,
  };
}

/** Every model and blend for one valuation date. */
export function valueOn(
  statements: readonly OracleStatement[],
  asOf: string,
): Valuation {
  const eligible = eligibleStatements(statements, asOf);
  const income = quarterly(eligible, "INCOME");
  const cashFlow = quarterly(eligible, "CASH_FLOW");
  const balance = quarterly(eligible, "BALANCE_SHEET");
  const growthInput = growth(eligible);
  const latestBalance = latestOf(balance);
  const latestIncome = latestOf(income);

  // Common CASH_FLOW + INCOME window: anchored at the newest quarter both families hold.
  let commonAnchor: number | undefined;
  for (const key of cashFlow.keys()) {
    if (income.has(key) && (commonAnchor === undefined || key > commonAnchor)) {
      commonAnchor = key;
    }
  }
  const commonWindow =
    commonAnchor === undefined
      ? null
      : windowAt(commonAnchor, cashFlow, income);
  const incomeWindow =
    latestIncome === undefined ? null : windowAt(rank(latestIncome), income);

  const models = {} as Record<ModelId, ModelOutcome>;

  // DCF_FCFF
  models.DCF_FCFF = (() => {
    if (!commonWindow) {
      return na("MISSING_TTM_WINDOW");
    }
    if (!latestBalance || !latestIncome) {
      return na("MISSING_LATEST_STATE");
    }
    let ocf = 0;
    let capex = 0;
    let interest = 0;
    for (const [flow, earnings] of commonWindow) {
      const o = numberField(flow!, "operatingCashFlow");
      const c = numberField(flow!, "capitalExpenditure");
      const i = numberField(earnings!, "interestExpense");
      if (o === undefined || c === undefined || i === undefined) {
        return na("MISSING_REQUIRED_FIELD");
      }
      ocf += o;
      capex += c;
      interest += i;
    }
    const cash =
      numberField(latestBalance, "cashAndShortTermInvestments") ??
      numberField(latestBalance, "cashAndCashEquivalents");
    const debt = numberField(latestBalance, "totalDebt");
    const shares = numberField(latestIncome, "weightedAverageShsOutDil");
    if (cash === undefined || debt === undefined || shares === undefined) {
      return na("MISSING_REQUIRED_FIELD");
    }
    const used = [
      ...commonWindow.flat(),
      latestBalance,
      latestIncome,
      ...growthInput.used,
    ];
    return finish(
      dcfFcff({
        operatingCashFlowTtm: ocf,
        capitalExpenditureTtm: capex,
        interestExpenseTtm: interest,
        growthUsed: growthInput.growthUsed,
        cash,
        debt,
        shares,
      }),
      used,
      {
        ocf,
        capex,
        interest,
        cash,
        debt,
        shares,
        growthUsed: growthInput.growthUsed,
      },
    );
  })();

  // RESIDUAL_INCOME
  models.RESIDUAL_INCOME = (() => {
    if (!incomeWindow) {
      return na("MISSING_TTM_WINDOW");
    }
    if (!latestBalance || !latestIncome) {
      return na("MISSING_LATEST_STATE");
    }
    let netIncome = 0;
    for (const [earnings] of incomeWindow) {
      const value = numberField(earnings!, "netIncome");
      if (value === undefined) {
        return na("MISSING_REQUIRED_FIELD");
      }
      netIncome += value;
    }
    const bookValue = numberField(latestBalance, "totalStockholdersEquity");
    const shares = numberField(latestIncome, "weightedAverageShsOutDil");
    if (bookValue === undefined || shares === undefined) {
      return na("MISSING_REQUIRED_FIELD");
    }
    const used = [
      ...incomeWindow.flat(),
      latestBalance,
      latestIncome,
      ...growthInput.used,
    ];
    return finish(
      residualIncome({
        netIncomeTtm: netIncome,
        bookValue,
        shares,
        growthUsed: growthInput.growthUsed,
      }),
      used,
      { netIncome, bookValue, shares, growthUsed: growthInput.growthUsed },
    );
  })();

  // DDM — per-quarter DPS paired with the same quarter's diluted shares.
  models.DDM = (() => {
    if (!commonWindow) {
      return na("MISSING_TTM_WINDOW");
    }
    let dps = 0;
    for (const [flow, earnings] of commonWindow) {
      const dividends = numberField(flow!, "commonDividendsPaid");
      const shares = numberField(earnings!, "weightedAverageShsOutDil");
      if (dividends === undefined || shares === undefined) {
        return na("MISSING_REQUIRED_FIELD");
      }
      if (shares <= 0) {
        return na("INVALID_DILUTED_SHARES");
      }
      dps += Math.abs(dividends) / shares;
    }
    return finish(dividendDiscount(dps), commonWindow.flat(), { dps });
  })();

  // GRAHAM
  models.GRAHAM = (() => {
    if (!incomeWindow) {
      return na("MISSING_TTM_WINDOW");
    }
    let eps = 0;
    for (const [earnings] of incomeWindow) {
      const value = numberField(earnings!, "epsDiluted");
      if (value === undefined) {
        return na("MISSING_REQUIRED_FIELD");
      }
      eps += value;
    }
    return finish(
      graham(eps, growthInput.growthUsed),
      [...incomeWindow.flat(), ...growthInput.used],
      {
        eps,
        growthUsed: growthInput.growthUsed,
      },
    );
  })();

  // Row-level currency rule: calculated models that disagree make the whole day unavailable.
  const currencies = new Set(
    Object.values(models)
      .filter(
        (outcome): outcome is Extract<ModelOutcome, { status: "VALUE" }> =>
          outcome.status === "VALUE",
      )
      .map((outcome) => outcome.currency),
  );
  const currencyConflict = currencies.size > 1;
  if (currencyConflict) {
    for (const id of Object.keys(models) as ModelId[]) {
      models[id] = na("ROW_CURRENCY_CONFLICT");
    }
  }

  const blends = {} as Valuation["blends"];
  for (const [blendId, weights] of Object.entries(BLEND_WEIGHTS) as [
    BlendId,
    Partial<Record<ModelId, number>>,
  ][]) {
    let value = 0;
    let sourceAsOf = "";
    let complete = true;
    for (const [model, weight] of Object.entries(weights) as [
      ModelId,
      number,
    ][]) {
      const outcome = models[model];
      if (outcome.status !== "VALUE") {
        complete = false;
        break;
      }
      value += weight * outcome.value;
      sourceAsOf =
        outcome.sourceAsOf > sourceAsOf ? outcome.sourceAsOf : sourceAsOf;
    }
    blends[blendId] = complete ? { value, sourceAsOf } : null;
  }
  return { models, blends, currencyConflict };
}

/**
 * The daily series: one valuation per trading date, recomputed only when the eligible revision
 * set changes (availability is monotone in the date, so a count of eligible revisions identifies
 * the set).
 */
export function dailyValuations(
  statements: readonly OracleStatement[],
  tradingDates: readonly string[],
): Valuation[] {
  const byAvailability = [...statements].sort((left, right) =>
    left.availableFromDate < right.availableFromDate
      ? -1
      : left.availableFromDate > right.availableFromDate
        ? 1
        : 0,
  );
  const result: Valuation[] = [];
  let eligibleCount = -1;
  let current: Valuation | null = null;
  let cursor = 0;
  for (const date of tradingDates) {
    while (
      cursor < byAvailability.length &&
      byAvailability[cursor]!.availableFromDate <= date
    ) {
      cursor += 1;
    }
    if (cursor !== eligibleCount || current === null) {
      eligibleCount = cursor;
      current = valueOn(statements, date);
    }
    result.push(current);
  }
  return result;
}

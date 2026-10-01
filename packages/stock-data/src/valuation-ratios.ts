import {
  VALUATION_RATIO_IDS,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import {
  isRepresentableCalculatedSeriesValue,
  selectFinancialStatements,
  STOCK_SPLIT_LABEL,
  type BalanceSheetField,
  type CashFlowField,
  type FinancialStatement,
  type IncomeStatementField,
  type Instant,
  type LocalDate,
  type SecurityId,
  type StockSplit,
} from "@intrinsic/domain";
import { addDays } from "./dates.js";
import { exactDecimalSum } from "./exact-decimal-sum.js";
import {
  indexFiscalQuarters,
  isFiscalQuarterPeriod,
  latestFiscalQuarterStatement,
  representsFiscalPeriodOver,
  trailingFiscalQuarterWindow,
  TTM_QUARTERS,
  type FiscalQuarterIndex,
} from "./fiscal-quarters.js";
import {
  basisFactorAt,
  isPlainShareRatio,
  type PriceBasisEvent,
} from "./price-basis.js";

/**
 * Valuation Ratios V1: P/E, P/S, P/B, P/FCF and EV/EBITDA, exactly as
 * `docs/decisions/valuation-ratios-v1.md` defines them.
 *
 * Pure and infrastructure-free: the stored statement revisions, the measured re-bases and the
 * provider's split list in, one compact timeline out; the timeline and a security's closes in, one
 * column per ratio out. No Prisma, no Redis, no provider, no clock. Nothing is stored per session —
 * every consumer (the backtest evaluation frame, the Monitor frame) projects the ratios through this
 * module when it reads them.
 *
 * A ratio is correct or unavailable. Unavailability is `NaN` in a column, never zero, infinity or a
 * stale value, and it has two sources:
 *
 * - **The inputs** (rule 1): a missing input or window, a denominator that is not positive, a share
 *   count that is missing or not positive, or a statement in a currency other than the trading one.
 * - **The price basis** (rules 2–8): wherever the stored close and the share count cannot be shown
 *   to be in the same units. The rules never estimate the distribution factor `Φ`; they withhold.
 */

/**
 * Revision of how valuation ratios are calculated: the definitions, the inputs and the price-basis
 * rules of `docs/decisions/valuation-ratios-v1.md`. Recorded in every backtest snapshot, so a run
 * queued under other rules is refused rather than executed under these. Bump it whenever a rule
 * changes a number.
 *
 * - 1: the five ratios, rules 1–8.
 */
export const VALUATION_RATIO_REVISION = 1;

/** Rule 2: a share count within this fraction of the last accepted one holds the level. */
export const SHARE_LEVEL_TOLERANCE = 0.25;
/** Rule 2: consecutive agreeing quarters before a count outside the level is accepted as a new one. */
export const SHARE_LEVEL_CONFIRMATIONS = 3;
/** Rule 3: a restated count further than this from the previous revision needs a measured re-base. */
export const SHARE_RESTATEMENT_TOLERANCE = 0.02;
/** Rules 5 and 8: calendar days after an event a count, or a session, is not trusted. */
export const EVENT_SETTLING_DAYS = 30;
/** Rules 4 and 8: calendar days within which a measured re-base is the provider entry's event. */
export const ENTRY_MATCH_DAYS = 7;

/** Everything stored that a security's valuation ratios read besides its closes. */
export type ValuationInputs = {
  securityId: SecurityId;
  /** The trading currency: every statement a ratio reads must report it. */
  currency: string;
  /** Every stored statement revision of the security; standalone quarters are read. */
  statements: readonly FinancialStatement[];
  /** When the loader first verified the stored price history, or `null` while it has not. */
  verifiedAt: Instant | null;
  /** The measured re-bases of the stored history (`historical-price-basis-v1.md`, §8). */
  events: readonly PriceBasisEvent[];
  /** The provider's split list. */
  splits: readonly StockSplit[];
};

/** What one ratio reads from the statements of one state, when they support it. */
type RatioInputs = {
  /** Net income, revenue, equity, free cash flow or EBITDA: always positive. */
  denominator: number;
  /** Net debt for EV/EBITDA, added to the market capitalisation; 0 for the others. */
  addend: number;
  /** The earliest of the latest fiscal period ends of the statement families the ratio reads. */
  coveredThrough: LocalDate;
};

/** The statements in force from one statement event until the next. */
type ValuationState = {
  /** From this date on. */
  from: LocalDate;
  /** The share count `R` — the latest point-in-time Income quarter's — when it is usable. */
  shares?: number;
  /** When `R` was observed, for the basis factor. */
  observedAt?: Instant;
  ratios: Partial<Record<ValuationRatioId, RatioInputs>>;
};

/**
 * One security's valuation inputs, precomputed: the statement states between statement events and
 * the corporate-action windows. Compact and immutable, so a backtest computes it once per security
 * and reads every window through it.
 */
export type ValuationTimeline = {
  securityId: SecurityId;
  /** False for a security whose stored price history the loader has not verified: nothing is available. */
  verified: boolean;
  states: readonly ValuationState[];
  events: readonly PriceBasisEvent[];
  /**
   * Rule 7: the dates of the measured re-bases that may have been distributions, ascending. On and
   * after each, a ratio needs statements covering it.
   */
  distributionDates: readonly LocalDate[];
  /** Rule 8: the sessions after a listed upcoming event the provider has not re-based yet. */
  forwardWindows: readonly { from: LocalDate; to: LocalDate }[];
};

/** The statement families each ratio reads. */
const RATIO_FAMILIES = {
  PRICE_TO_EARNINGS_TTM: ["INCOME"],
  PRICE_TO_SALES_TTM: ["INCOME"],
  PRICE_TO_BOOK: ["INCOME", "BALANCE_SHEET"],
  PRICE_TO_FCF_TTM: ["INCOME", "CASH_FLOW"],
  EV_TO_EBITDA_TTM: ["INCOME", "BALANCE_SHEET"],
} as const satisfies Record<
  ValuationRatioId,
  readonly FinancialStatement["statementType"][]
>;

/**
 * Precomputes a security's valuation inputs.
 *
 * Statement-level rules are applied here, once per statement event: the inputs (1), the share
 * level (2), an unexplained restatement (3), the provider's history entries (4) and a count
 * observed soon after an event (5). The session-level rules — the basis factor (6), the window after
 * a possible distribution (7) and a listed event not yet measured (8) — are applied when a column is
 * read.
 */
export function buildValuationTimeline(
  inputs: ValuationInputs,
): ValuationTimeline {
  const statements = inputs.statements.filter(
    (statement) =>
      statement.securityId === inputs.securityId &&
      isFiscalQuarterPeriod(statement.period),
  );
  const verifiedDate = inputs.verifiedAt?.slice(0, 10);
  const measured = inputs.events.filter(
    (event) => event.kind === "MEASURED" && event.priceRatio !== undefined,
  );
  const measuredNear = (date: LocalDate) =>
    measured.some((event) => {
      const from = event.effectiveDate ?? event.effectiveFrom;
      const to = event.effectiveDate ?? event.effectiveTo ?? from;
      return (
        from !== undefined &&
        to !== undefined &&
        from <= addDays(date, ENTRY_MATCH_DAYS) &&
        to >= addDays(date, -ENTRY_MATCH_DAYS)
      );
    });
  // Provider entries not superseded by a re-base the loader measured (that one is read exactly).
  const unmeasured = inputs.splits.filter((split) => !measuredNear(split.date));
  const history =
    verifiedDate === undefined
      ? []
      : unmeasured.filter((split) => split.date <= verifiedDate);
  const forward =
    verifiedDate === undefined
      ? []
      : unmeasured.filter((split) => split.date > verifiedDate);
  // Rule 4.1: before a listed distribution the close carries its factor, so every ratio waits for
  // statements covering the latest one.
  const historyCoverage = history
    .filter((split) => !isPlainEntry(split))
    .map((split) => split.date)
    .sort()
    .at(-1);
  // Rule 5: the dates a count observed soon after them may still be in the old units.
  const settling: { from: LocalDate; to: LocalDate }[] = [
    ...inputs.splits.map((split) => ({ from: split.date, to: split.date })),
    ...measured.flatMap((event) => {
      const from = event.effectiveDate ?? event.effectiveFrom;
      const to = event.effectiveDate ?? event.effectiveTo ?? from;
      return from === undefined || to === undefined ? [] : [{ from, to }];
    }),
  ];

  const eventDates = [
    ...new Set(statements.map((statement) => statement.availableFromDate)),
  ].sort();
  const states: ValuationState[] = eventDates.map((date) =>
    stateOn({
      date,
      currency: inputs.currency,
      statements,
      measured,
      history,
      historyCoverage,
      settling,
    }),
  );

  return {
    securityId: inputs.securityId,
    verified: inputs.verifiedAt !== null,
    states,
    events: inputs.events,
    distributionDates: measured
      .filter((event) => !isPlainShareRatio(event.priceRatio as number))
      .flatMap((event) => {
        const date =
          event.effectiveDate ?? event.effectiveTo ?? event.effectiveFrom;
        return date === undefined ? [] : [date];
      })
      .sort(),
    forwardWindows: forward.map((split) => ({
      from: split.date,
      to: addDays(split.date, EVENT_SETTLING_DAYS),
    })),
  };
}

/**
 * The ratios of a security on each of `dates`, at `closes`, as columns.
 *
 * `statementDateOf` names the date whose statements a row reads when it is not the row's own: a
 * Monitor's provisional session reads the newest closed session's, the carry-forward rule every
 * statement-derived value follows. Every session rule is still read on the row's own date.
 */
export function valuationRatioColumns(input: {
  timeline: ValuationTimeline;
  dates: readonly LocalDate[];
  closes: ArrayLike<number>;
  ratios: readonly ValuationRatioId[];
  statementDateOf?: (index: number) => LocalDate;
}): Map<ValuationRatioId, Float64Array> {
  const { timeline, dates, closes } = input;
  const columns = new Map<ValuationRatioId, Float64Array>();
  for (const ratio of input.ratios) {
    columns.set(ratio, new Float64Array(dates.length).fill(Number.NaN));
  }
  if (!timeline.verified) {
    return columns;
  }
  for (let index = 0; index < dates.length; index += 1) {
    const session = dates[index] as LocalDate;
    const close = closes[index] as number;
    if (!Number.isFinite(close) || close <= 0) {
      continue;
    }
    const state = stateAt(
      timeline.states,
      input.statementDateOf?.(index) ?? session,
    );
    if (state?.shares === undefined || state.observedAt === undefined) {
      continue;
    }
    // Rule 8: a listed event the provider has not re-based yet.
    if (
      timeline.forwardWindows.some(
        (window) => session >= window.from && session <= window.to,
      )
    ) {
      continue;
    }
    // Rule 6: the close on the basis the count was observed on, or nothing.
    const basis = basisFactorAt({
      session,
      observedAt: state.observedAt,
      events: timeline.events,
    });
    if (basis.kind === "WITHHELD") {
      continue;
    }
    // Rule 7: on and after a possible distribution, statements that cover it.
    const distribution = latestOnOrBefore(timeline.distributionDates, session);
    const marketCap = close * basis.factor * state.shares;
    for (const ratio of input.ratios) {
      const inputs = state.ratios[ratio];
      if (
        !inputs ||
        (distribution !== undefined && inputs.coveredThrough < distribution)
      ) {
        continue;
      }
      const value = (marketCap + inputs.addend) / inputs.denominator;
      if (
        Number.isFinite(value) &&
        isRepresentableCalculatedSeriesValue(value)
      ) {
        (columns.get(ratio) as Float64Array)[index] = value === 0 ? 0 : value;
      }
    }
  }
  return columns;
}

/** Whether a provider entry is a plain share change: labelled a split, at an exact common ratio. */
function isPlainEntry(split: StockSplit): boolean {
  return (
    split.label === STOCK_SPLIT_LABEL &&
    split.denominator > 0 &&
    isPlainShareRatio(split.numerator / split.denominator, 0)
  );
}

/** The statement state in force on `date`: the latest one starting on or before it. */
function stateAt(
  states: readonly ValuationState[],
  date: LocalDate,
): ValuationState | undefined {
  let low = 0;
  let high = states.length - 1;
  let found: ValuationState | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const state = states[middle] as ValuationState;
    if (state.from <= date) {
      found = state;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function latestOnOrBefore(
  sorted: readonly LocalDate[],
  date: LocalDate,
): LocalDate | undefined {
  let found: LocalDate | undefined;
  for (const candidate of sorted) {
    if (candidate > date) {
      break;
    }
    found = candidate;
  }
  return found;
}

/** The statements visible on `date` and every statement-level rule applied to them. */
function stateOn(input: {
  date: LocalDate;
  currency: string;
  statements: readonly FinancialStatement[];
  measured: readonly PriceBasisEvent[];
  history: readonly StockSplit[];
  historyCoverage: LocalDate | undefined;
  settling: readonly { from: LocalDate; to: LocalDate }[];
}): ValuationState {
  const eligible = selectFinancialStatements(input.statements, {
    asOf: input.date,
    cadence: "QUARTERLY",
  });
  const income = indexFiscalQuarters(eligible, "INCOME");
  const latest = latestFiscalQuarterStatement(income);
  if (!latest) {
    return { from: input.date, ratios: {} };
  }
  const shares = usableShares({ ...input, income, latest });
  if (shares === undefined) {
    return { from: input.date, ratios: {} };
  }

  const balanceSheet = latestFiscalQuarterStatement(
    indexFiscalQuarters(eligible, "BALANCE_SHEET"),
  );
  const incomeWindow = trailingFiscalQuarterWindow(income, TTM_QUARTERS);
  const cashFlowWindow = trailingFiscalQuarterWindow(
    indexFiscalQuarters(eligible, "CASH_FLOW"),
    TTM_QUARTERS,
  );
  const incomeRows = incomeWindow?.statements ?? [];
  const cashFlowRows = cashFlowWindow?.statements ?? [];
  const latestCashFlow = cashFlowRows.at(-1);

  const candidates: Record<
    ValuationRatioId,
    { denominator?: number; addend?: number; sources: FinancialStatement[] }
  > = {
    PRICE_TO_EARNINGS_TTM: {
      denominator: incomeWindow ? sum(incomeRows, "netIncome") : undefined,
      sources: [...incomeRows],
    },
    PRICE_TO_SALES_TTM: {
      denominator: incomeWindow ? sum(incomeRows, "revenue") : undefined,
      sources: [...incomeRows],
    },
    PRICE_TO_BOOK: {
      denominator: balanceSheet
        ? value(balanceSheet, "totalStockholdersEquity")
        : undefined,
      sources: balanceSheet ? [latest, balanceSheet] : [],
    },
    PRICE_TO_FCF_TTM: {
      denominator: cashFlowWindow ? freeCashFlow(cashFlowRows) : undefined,
      sources: [latest, ...cashFlowRows],
    },
    EV_TO_EBITDA_TTM: {
      denominator: incomeWindow ? sum(incomeRows, "ebitda") : undefined,
      addend: balanceSheet ? value(balanceSheet, "netDebt") : undefined,
      sources: balanceSheet ? [...incomeRows, balanceSheet] : [],
    },
  };

  const familyEnd = {
    INCOME: latest.fiscalDate,
    BALANCE_SHEET: balanceSheet?.fiscalDate,
    CASH_FLOW: latestCashFlow?.fiscalDate,
  } as const;
  const ratios: Partial<Record<ValuationRatioId, RatioInputs>> = {};
  for (const ratio of VALUATION_RATIO_IDS) {
    const candidate = candidates[ratio];
    const addend = ratio === "EV_TO_EBITDA_TTM" ? candidate.addend : 0;
    const ends = RATIO_FAMILIES[ratio].map((family) => familyEnd[family]);
    if (
      candidate.denominator === undefined ||
      !(candidate.denominator > 0) ||
      addend === undefined ||
      candidate.sources.length === 0 ||
      !candidate.sources.every(
        (source) =>
          source.reportedCurrency === input.currency &&
          input.currency.trim() !== "",
      ) ||
      ends.some((end) => end === undefined)
    ) {
      continue;
    }
    const coveredThrough = (ends as LocalDate[]).sort()[0] as LocalDate;
    // Rule 4.1: a listed distribution before which every close carries a factor nothing measured.
    if (
      input.historyCoverage !== undefined &&
      coveredThrough < input.historyCoverage
    ) {
      continue;
    }
    ratios[ratio] = {
      denominator: candidate.denominator,
      addend,
      coveredThrough,
    };
  }
  return {
    from: input.date,
    shares,
    observedAt: latest.observedAt,
    ratios,
  };
}

/**
 * `R`'s diluted share count when the rules let it be read against the stored close: positive,
 * holding the level of the counts before it (rule 2), not restated unexplained (rule 3), observed
 * after every listed event folded into the history before the loader measured anything (rule 4.2),
 * and not observed in the month after an event for a quarter that ended before it (rule 5).
 */
function usableShares(input: {
  income: FiscalQuarterIndex;
  latest: FinancialStatement;
  statements: readonly FinancialStatement[];
  measured: readonly PriceBasisEvent[];
  history: readonly StockSplit[];
  settling: readonly { from: LocalDate; to: LocalDate }[];
  date: LocalDate;
}): number | undefined {
  const { latest } = input;
  const shares = value(latest, "weightedAverageShsOutDil");
  if (shares === undefined || !(shares > 0)) {
    return undefined;
  }
  if (!holdsShareLevel(input.income, latest)) {
    return undefined;
  }
  // Rule 3: a restated count must be explained by a re-base measured no later than it was observed.
  const previous = previousRevision(input.statements, latest, input.date);
  const previousShares = previous
    ? value(previous, "weightedAverageShsOutDil")
    : undefined;
  if (
    previousShares !== undefined &&
    previousShares > 0 &&
    Math.abs(shares / previousShares - 1) > SHARE_RESTATEMENT_TOLERANCE
  ) {
    const restatement = shares / previousShares;
    // The re-base must be new to the previous revision — detected or dated after it was observed —
    // and known by the time `R` was: an older re-base of the same ratio explains nothing.
    const previousObserved = Date.parse(previous!.observedAt);
    const explained = input.measured.some((event) => {
      const detected = Date.parse(event.detectedAt);
      const date =
        event.effectiveDate ?? event.effectiveTo ?? event.effectiveFrom;
      return (
        detected <= Date.parse(latest.observedAt) &&
        (detected > previousObserved ||
          (date !== undefined && date > previous!.observedAt.slice(0, 10))) &&
        Math.abs(restatement / (event.priceRatio as number) - 1) <=
          SHARE_RESTATEMENT_TOLERANCE
      );
    });
    if (!explained) {
      return undefined;
    }
  }
  const observedDate = latest.observedAt.slice(0, 10);
  // Rule 4.2: folded into the stored history before anything was measured, after the count.
  if (input.history.some((split) => observedDate < split.date)) {
    return undefined;
  }
  // Rule 5: the provider may restate after it re-bases the prices.
  if (
    input.settling.some(
      (event) =>
        event.from <= observedDate &&
        observedDate < addDays(event.to, EVENT_SETTLING_DAYS) &&
        latest.fiscalDate < event.to,
    )
  ) {
    return undefined;
  }
  return shares;
}

/**
 * Rule 2: whether `latest` holds the level of the counts before it.
 *
 * Walking the point-in-time Income quarters in order, a count within 25 % of the last accepted one is
 * accepted; one outside it is accepted as a new level only on the third consecutive quarter agreeing
 * with it within 25 %, and withheld until then. A one- or two-quarter artefact is never accepted; a
 * merger or an offering is withheld for two quarters and then read. Consecutive means consecutive
 * fiscal quarters, each with a count: a missing quarter or a missing count starts the agreement
 * again.
 */
function holdsShareLevel(
  income: FiscalQuarterIndex,
  latest: FinancialStatement,
): boolean {
  let level: number | undefined;
  let candidate: number[] = [];
  let latestAccepted = false;
  let previousRank: number | undefined;
  const ranks = [...income.keys()].sort((left, right) => left - right);
  for (const rank of ranks) {
    const statement = income.get(rank) as FinancialStatement;
    const count = value(statement, "weightedAverageShsOutDil");
    if (previousRank !== undefined && rank !== previousRank + 1) {
      candidate = [];
    }
    previousRank = rank;
    let accepted = false;
    if (count === undefined || !(count > 0)) {
      candidate = [];
    } else {
      if (level === undefined || within(count, level)) {
        accepted = true;
        candidate = [];
      } else {
        candidate =
          candidate.length > 0 && within(count, candidate[0] as number)
            ? [...candidate, count]
            : [count];
        if (candidate.length >= SHARE_LEVEL_CONFIRMATIONS) {
          accepted = true;
          candidate = [];
        }
      }
      if (accepted) {
        level = count;
      }
    }
    if (statement === latest) {
      latestAccepted = accepted;
    }
  }
  return latestAccepted;
}

function within(count: number, level: number): boolean {
  return Math.abs(count / level - 1) <= SHARE_LEVEL_TOLERANCE;
}

/**
 * The revision of `latest`'s fiscal quarter that represented it before `latest` did, among those
 * visible on `date`. Matched by fiscal year and period, so a moved period end is still the same
 * quarter.
 */
function previousRevision(
  statements: readonly FinancialStatement[],
  latest: FinancialStatement,
  date: LocalDate,
): FinancialStatement | undefined {
  let previous: FinancialStatement | undefined;
  for (const statement of statements) {
    if (
      statement === latest ||
      statement.statementType !== latest.statementType ||
      statement.fiscalYear !== latest.fiscalYear ||
      statement.period !== latest.period ||
      statement.availableFromDate > date ||
      !representsFiscalPeriodOver(latest, statement)
    ) {
      continue;
    }
    if (!previous || representsFiscalPeriodOver(statement, previous)) {
      previous = statement;
    }
  }
  return previous;
}

/** A line item as a finite number, or `undefined` when the provider did not supply one. */
function value(
  statement: FinancialStatement,
  field: IncomeStatementField | BalanceSheetField | CashFlowField,
): number | undefined {
  const raw = (statement.values as Readonly<Record<string, unknown>>)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** The exact sum of one line over a window, or `undefined` when any quarter lacks it. */
function sum(
  rows: readonly FinancialStatement[],
  field: IncomeStatementField,
): number | undefined {
  const values: number[] = [];
  for (const row of rows) {
    const reported = value(row, field);
    if (reported === undefined) {
      return undefined;
    }
    values.push(reported);
  }
  const total = values.length === 0 ? undefined : exactDecimalSum(values);
  return total !== undefined && Number.isFinite(total) ? total : undefined;
}

/**
 * `sum(operatingCashFlow + capitalExpenditure)` over a window, never the provider's `freeCashFlow`,
 * as Fundamental Metrics define free cash flow.
 */
function freeCashFlow(rows: readonly FinancialStatement[]): number | undefined {
  const components: number[] = [];
  for (const row of rows) {
    const operating = value(row, "operatingCashFlow");
    const capital = value(row, "capitalExpenditure");
    if (operating === undefined || capital === undefined) {
      return undefined;
    }
    components.push(operating, capital);
  }
  const total =
    components.length === 0 ? undefined : exactDecimalSum(components);
  return total !== undefined && Number.isFinite(total) ? total : undefined;
}

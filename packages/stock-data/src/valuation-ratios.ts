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
import { exactDecimalSum, exactlyWithinFraction } from "./exact-decimal-sum.js";
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
 * - 2: rules 4, 5 and 8 read an undated re-base on the days it may lie on, never on its interval's
 *   exclusive start; rule 2's 25 % band and rule 3's 2 % thresholds are judged exactly on the
 *   reported figures (the independent audit, `docs/valuation-ratios-audit/REPORT.md`).
 * - 3: the owner's rulings on the audit's gaps (2026-10-06): rule 2 confirms the walk's first count
 *   like any new level, and rule 3 compares a count with its anchor — the latest revision of the
 *   quarter observed before it that rule 3 accepted — rather than with the revision just before it.
 * - 4: the owner's rulings on the second review (2026-10-06): across share-changing events, a count
 *   that still agrees with an anchor observed before them is not accepted, and one that differs only
 *   when the separating re-bases' ratios together explain it (rule 6's basis assumption, checked in
 *   rule 3); a count first observed in the month before an event is withheld on the sessions before
 *   it (rule 5, before the event).
 */
export const VALUATION_RATIO_REVISION = 4;

/** Rule 2: a share count within this fraction of the last accepted one holds the level. */
export const SHARE_LEVEL_TOLERANCE = 0.25;
/** Rule 2: consecutive agreeing quarters before a count outside the level is accepted as a new one. */
export const SHARE_LEVEL_CONFIRMATIONS = 3;
/** Rule 3: a restated count further than this from its anchor needs a measured re-base. */
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
  /**
   * Rule 5, before the event: `R`'s count was first observed in the month before an event, so no
   * session before this date reads it.
   */
  withheldBefore?: LocalDate;
  ratios: Partial<Record<ValuationRatioId, RatioInputs>>;
};

/**
 * A share-changing event for rule 3 (rule 6's basis assumption, checked): a measured re-base at a
 * plain share ratio, or a provider entry at one that no measured re-base supersedes.
 */
type ShareChange =
  | {
      kind: "MEASURED";
      lastDay: LocalDate;
      detectedAt: Instant;
      event: PriceBasisEvent;
    }
  | { kind: "ENTRY"; date: LocalDate };

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
      const days = possibleDays(event);
      return (
        days !== undefined &&
        days.from <= addDays(date, ENTRY_MATCH_DAYS) &&
        days.to >= addDays(date, -ENTRY_MATCH_DAYS)
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
      const days = possibleDays(event);
      return days === undefined ? [] : [days];
    }),
  ];

  // Rule 3: the events across which a count must change by the event's ratio.
  const shareChanges: ShareChange[] = [
    ...measured.flatMap((event): ShareChange[] => {
      const days = possibleDays(event);
      return days !== undefined && isPlainShareRatio(event.priceRatio as number)
        ? [
            {
              kind: "MEASURED",
              lastDay: days.to,
              detectedAt: event.detectedAt,
              event,
            },
          ]
        : [];
    }),
    ...unmeasured
      .filter((split) => isPlainEntry(split))
      .map((split): ShareChange => ({ kind: "ENTRY", date: split.date })),
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
      shareChanges,
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
    // Rule 5, before the event: a count that may already be restated, against an old-basis close.
    if (state.withheldBefore !== undefined && session < state.withheldBefore) {
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

/**
 * The calendar days a measured re-base may lie on: its date, or, measured between two reads, its
 * undated interval `(effectiveFrom, effectiveTo]`. `effectiveFrom` is the last session certainly
 * before the event (`historical-price-basis-v1.md` §8), as `basisFactorAt` reads it, so the event
 * never lies on it: rules 4 and 8 match an entry, and rule 5 settles a count, only by the days after.
 */
function possibleDays(
  event: PriceBasisEvent,
): { from: LocalDate; to: LocalDate } | undefined {
  if (event.effectiveDate !== undefined) {
    return { from: event.effectiveDate, to: event.effectiveDate };
  }
  if (event.effectiveFrom === undefined) {
    return undefined;
  }
  const from = addDays(event.effectiveFrom, 1);
  return { from, to: event.effectiveTo ?? from };
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
  shareChanges: readonly ShareChange[];
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
  const usable = usableShares({ ...input, income, latest });
  if (usable === undefined) {
    return { from: input.date, ratios: {} };
  }
  const { shares, firstObservedAt } = usable;
  // Rule 5, before the event: first observed in the month before an event, for a quarter that
  // ended before it. An undated re-base lies on every day it may lie on.
  const firstObservedDate = firstObservedAt.slice(0, 10);
  const withheldBefore = input.settling
    .filter(
      (event) =>
        latest.fiscalDate < event.to &&
        addDays(event.from, -EVENT_SETTLING_DAYS) <= firstObservedDate &&
        firstObservedDate < event.to,
    )
    .map((event) => event.to)
    .sort()
    .at(-1);

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
    ...(withheldBefore !== undefined ? { withheldBefore } : {}),
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
  shareChanges: readonly ShareChange[];
  date: LocalDate;
}): { shares: number; firstObservedAt: Instant } | undefined {
  const { latest } = input;
  const shares = value(latest, "weightedAverageShsOutDil");
  if (shares === undefined || !(shares > 0)) {
    return undefined;
  }
  if (!holdsShareLevel(input.income, latest)) {
    return undefined;
  }
  const restatement = restatementVerdict(
    input.statements,
    latest,
    input.date,
    input.measured,
    input.shareChanges,
  );
  if (!restatement.accepted) {
    return undefined;
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
  return { shares, firstObservedAt: restatement.firstObservedAt };
}

/**
 * Rule 2: whether `latest` holds the level of the counts before it.
 *
 * Walking the point-in-time Income quarters in order, a count within 25 % of the last accepted one is
 * accepted; one outside it is accepted as a new level only on the third consecutive quarter agreeing
 * with it within 25 %, and withheld until then. The walk's first count has no level to hold and is
 * confirmed the same way (owner, 2026-10-06), so a listing quarter's weighted average is never read
 * before the quarters after it agree with it. A one- or two-quarter artefact is never accepted; a
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
      if (level !== undefined && within(count, level)) {
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

/** Within 25 % of `level`, judged on the reported counts rather than their doubles. */
function within(count: number, level: number): boolean {
  return exactlyWithinFraction(count, [level], SHARE_LEVEL_TOLERANCE);
}

/** A revision rule 3 accepted with a usable count: an anchor for the revisions after it. */
type Anchor = {
  statement: FinancialStatement;
  shares: number;
  /** When its count was first observed: back through every revision it agreed with. */
  firstObservedAt: Instant;
};

/**
 * Rule 3: whether `latest`'s count passes against its anchor — the latest revision of its fiscal
 * quarter observed before it that rule 3 accepted and that has a usable count (owner, 2026-10-06) —
 * and when the count it reads was first observed (rule 5, before the event).
 *
 * The quarter's revisions visible on `date` and observed before `latest` are taken in the order
 * they were observed (by one observation, in the order that picks a quarter's representing
 * revision), matched by fiscal year and period so a moved period end is still the same quarter. A
 * revision observed after `latest` but dated earlier, as a late-observed amendment is, is never its
 * anchor: what `latest` is judged against was known when it was observed. Each is judged against
 * the anchor before it (`acceptedAgainst`); an accepted one with a usable count anchors the
 * revisions after it, one not accepted anchors nothing, so a restatement stays withheld through
 * every later revision repeating it, or with no count, until one observed no earlier than a matching
 * re-base's detection is explained. A revision with no anchor passes.
 */
function restatementVerdict(
  statements: readonly FinancialStatement[],
  latest: FinancialStatement,
  date: LocalDate,
  measured: readonly PriceBasisEvent[],
  shareChanges: readonly ShareChange[],
): { accepted: boolean; firstObservedAt: Instant } {
  const earlier = statements
    .filter(
      (statement) =>
        statement !== latest &&
        statement.statementType === latest.statementType &&
        statement.fiscalYear === latest.fiscalYear &&
        statement.period === latest.period &&
        statement.availableFromDate <= date &&
        observedBefore(statement, latest),
    )
    .sort((left, right) =>
      observedBefore(left, right) ? -1 : observedBefore(right, left) ? 1 : 0,
    );
  let anchor: Anchor | undefined;
  for (const revision of earlier) {
    const shares = value(revision, "weightedAverageShsOutDil");
    if (shares === undefined || !(shares > 0)) {
      continue;
    }
    const verdict = acceptedAgainst(
      revision,
      shares,
      anchor,
      measured,
      shareChanges,
    );
    if (verdict !== undefined) {
      anchor = { statement: revision, shares, firstObservedAt: verdict };
    }
  }
  const shares = value(latest, "weightedAverageShsOutDil") as number;
  const verdict = acceptedAgainst(
    latest,
    shares,
    anchor,
    measured,
    shareChanges,
  );
  return verdict === undefined
    ? { accepted: false, firstObservedAt: latest.observedAt }
    : { accepted: true, firstObservedAt: verdict };
}

/** Rule 3's order: observed earlier, or by the same observation and represented over by `later`. */
function observedBefore(
  earlier: FinancialStatement,
  later: FinancialStatement,
): boolean {
  return (
    earlier.observedAt < later.observedAt ||
    (earlier.observedAt === later.observedAt &&
      representsFiscalPeriodOver(later, earlier))
  );
}

/**
 * Rule 3 for one revision against its anchor: when its count was first observed if it is accepted,
 * or `undefined` if it is not.
 *
 * With no anchor it is accepted, its own count first observed now. Otherwise it is accepted when it
 * is within 2 % of the anchor's count — the anchor's count, first observed when the anchor's was —
 * or a restatement a measured re-base explains, first observed now. The re-base must be new to the
 * anchor — detected or dated after it was observed, and dated less than rule 5's month before it —
 * and known by the time the revision was observed. An older re-base of the same ratio explains
 * nothing, even when the first verification measures it after the anchor was observed.
 *
 * Across share-changing events that separate them (owner, 2026-10-06: rule 6's basis assumption,
 * checked), agreeing with the anchor is not acceptance: a count in the new units differs from one
 * observed before the events by their ratios. Only the separating re-bases explain it, together
 * (`explainedAcross`), and a separating provider entry, which explains nothing, leaves the revision
 * unaccepted.
 */
function acceptedAgainst(
  revision: FinancialStatement,
  shares: number,
  anchor: Anchor | undefined,
  measured: readonly PriceBasisEvent[],
  shareChanges: readonly ShareChange[],
): Instant | undefined {
  if (anchor === undefined) {
    return revision.observedAt;
  }
  const separating = shareChanges.filter((change) =>
    separates(change, revision, anchor.statement),
  );
  if (separating.length > 0) {
    return explainedAcross(separating, shares, anchor)
      ? revision.observedAt
      : undefined;
  }
  if (
    exactlyWithinFraction(shares, [anchor.shares], SHARE_RESTATEMENT_TOLERANCE)
  ) {
    return anchor.firstObservedAt;
  }
  const anchorObserved = anchor.statement.observedAt;
  const anchorObservedDate = anchorObserved.slice(0, 10);
  const explained = measured.some((event) => {
    // An undated re-base is taken at the latest date it may have.
    const date = event.effectiveDate ?? event.effectiveTo;
    const detected = Date.parse(event.detectedAt);
    return (
      date !== undefined &&
      detected <= Date.parse(revision.observedAt) &&
      (detected > Date.parse(anchorObserved) || date > anchorObservedDate) &&
      anchorObservedDate < addDays(date, EVENT_SETTLING_DAYS) &&
      // The restatement within 2 % of the ratio: |shares − ratio × anchor| <= 2 % of the latter.
      exactlyWithinFraction(
        shares,
        [event.priceRatio as number, anchor.shares],
        SHARE_RESTATEMENT_TOLERANCE,
      )
    );
  });
  return explained ? revision.observedAt : undefined;
}

/**
 * Rule 3 across separating share-changing events: whether the measured re-bases among them explain
 * the count together — within 2 % of the anchor's count times the product of their ratios, each
 * dated less than rule 5's month before the anchor was observed (the separation puts each detection
 * after the anchor's observation and no later than the revision's). A provider entry explains
 * nothing, so across one nothing is accepted. A count within 2 % of the anchor's is never
 * explained, even where the ratios cancel: the anchor may itself have been restated ahead of one
 * of them.
 */
function explainedAcross(
  separating: readonly ShareChange[],
  shares: number,
  anchor: Anchor,
): boolean {
  if (
    exactlyWithinFraction(shares, [anchor.shares], SHARE_RESTATEMENT_TOLERANCE)
  ) {
    return false;
  }
  const anchorObservedDate = anchor.statement.observedAt.slice(0, 10);
  const ratios: number[] = [];
  for (const change of separating) {
    if (change.kind === "ENTRY") {
      return false;
    }
    // An undated re-base is taken at the latest date it may have.
    const date = change.event.effectiveDate ?? change.event.effectiveTo;
    if (
      date === undefined ||
      !(anchorObservedDate < addDays(date, EVENT_SETTLING_DAYS))
    ) {
      return false;
    }
    ratios.push(change.event.priceRatio as number);
  }
  return exactlyWithinFraction(
    shares,
    [...ratios, anchor.shares],
    SHARE_RESTATEMENT_TOLERANCE,
  );
}

/**
 * Whether a share-changing event separates a revision from its anchor: the revision's quarter ended
 * before it, the anchor was observed before it — before its detection, for a measured re-base — and
 * the revision after it — no earlier than the detection, or on or after an entry's date.
 */
function separates(
  change: ShareChange,
  revision: FinancialStatement,
  anchor: FinancialStatement,
): boolean {
  if (change.kind === "MEASURED") {
    const detected = Date.parse(change.detectedAt);
    return (
      revision.fiscalDate < change.lastDay &&
      Date.parse(anchor.observedAt) < detected &&
      Date.parse(revision.observedAt) >= detected
    );
  }
  return (
    revision.fiscalDate < change.date &&
    anchor.observedAt.slice(0, 10) < change.date &&
    revision.observedAt.slice(0, 10) >= change.date
  );
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

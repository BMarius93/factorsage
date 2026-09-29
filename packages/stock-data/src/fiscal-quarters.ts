import type {
  FinancialPeriod,
  FinancialStatement,
  FinancialStatementType,
} from "@intrinsic/domain";

/**
 * Fiscal-quarter identity, adjacency and exact consecutive windows: the one definition every
 * statement-derived calculation assembles its quarterly inputs from.
 *
 * Intrinsic-value input assembly (`intrinsic-value-inputs.ts`) and Fundamental Metrics
 * (`fundamental-metrics.ts`) both read point-in-time quarterly statements through these helpers,
 * so "the previous quarter", "four consecutive quarters" and "the latest eligible quarter" mean
 * exactly one thing in this codebase.
 *
 * Rules every helper keeps:
 *
 * - **Identity is fiscal, never calendar.** A quarter is the provider's `(fiscalYear, period)`.
 *   Adjacency is decided by that identity alone, so a company whose fiscal year ends in September
 *   or January is treated exactly like a calendar-year filer, and `fiscalDate` arithmetic never
 *   decides which quarter comes next.
 * - **Only standalone `Q1`-`Q4` rows are quarters.** An `FY` row is never indexed, so it can never
 *   fill a quarterly gap.
 * - **Windows are exact and current.** A window ends at the newest quarter it is anchored on, and a
 *   missing identity makes it unavailable. Nothing searches back for an older complete window —
 *   that would report a stale period as the current one — and nothing rescales a shorter span.
 * - **Point-in-time selection happens before these helpers.** Callers pass statements already
 *   reduced to one eligible revision per fiscal identity (`selectFinancialStatements` with
 *   `asOf`); nothing here looks at `availableFromDate` to decide eligibility.
 *
 * Everything is pure: no clock, no I/O, and the caller's arrays and statements are never mutated.
 */

export const FISCAL_QUARTER_PERIODS = ["Q1", "Q2", "Q3", "Q4"] as const;
export type FiscalQuarterPeriod = (typeof FISCAL_QUARTER_PERIODS)[number];

/** Fiscal quarter identity. Never inferred from calendar dates or `fiscalDate` arithmetic. */
export type FiscalQuarter = {
  fiscalYear: number;
  period: FiscalQuarterPeriod;
};

/** Quarters in one trailing-twelve-month flow window. */
export const TTM_QUARTERS = 4;

export function isFiscalQuarterPeriod(
  period: FinancialPeriod,
): period is FiscalQuarterPeriod {
  return period !== "FY";
}

/**
 * Monotonic rank over fiscal quarters, so `rank - 1` is always the previous fiscal quarter and
 * Q4 -> next fiscal year's Q1 needs no special case.
 */
export function fiscalQuarterRank(quarter: FiscalQuarter): number {
  return (
    quarter.fiscalYear * FISCAL_QUARTER_PERIODS.length +
    FISCAL_QUARTER_PERIODS.indexOf(quarter.period)
  );
}

/** The fiscal quarter a rank stands for; the inverse of {@link fiscalQuarterRank}. */
export function fiscalQuarterOfRank(rank: number): FiscalQuarter {
  if (!Number.isInteger(rank)) {
    throw new Error(`Fiscal quarter rank must be an integer, received ${rank}`);
  }
  const fiscalYear = Math.floor(rank / FISCAL_QUARTER_PERIODS.length);
  const period =
    FISCAL_QUARTER_PERIODS[rank - fiscalYear * FISCAL_QUARTER_PERIODS.length];
  if (period === undefined) {
    throw new Error(`Invalid fiscal quarter rank ${rank}`);
  }
  return { fiscalYear, period };
}

/** One statement family's quarterly statements keyed by fiscal-quarter rank. */
export type FiscalQuarterIndex = ReadonlyMap<number, FinancialStatement>;

/**
 * Which of two statements for the same family and fiscal period represents that period.
 *
 * They can only differ in `fiscalDate`: the canonical selector treats `fiscalDate` as part of a
 * logical identity, so a provider that moved a period's end date leaves two eligible rows for one
 * fiscal period. The loader dates such a row as a revision of the period it belongs to
 * (`docs/decisions/fundamentals-loader.md`), so the latest revision represents the period, exactly
 * as for a revision that kept its period end: later availability, then later observation. Only
 * between rows one observation delivered together does the later period end decide, then the
 * content hash, so the choice never depends on the order a caller passes.
 *
 * Shared by every statement-derived engine: the quarterly index here and the annual income index
 * of the intrinsic-value models.
 */
export function representsFiscalPeriodOver(
  candidate: FinancialStatement,
  existing: FinancialStatement,
): boolean {
  return (
    (candidate.availableFromDate.localeCompare(existing.availableFromDate) ||
      candidate.observedAt.localeCompare(existing.observedAt) ||
      candidate.fiscalDate.localeCompare(existing.fiscalDate) ||
      candidate.contentHash.localeCompare(existing.contentHash)) > 0
  );
}

/** Indexes one family's standalone quarterly rows by fiscal-quarter rank; `FY` rows are ignored. */
export function indexFiscalQuarters(
  statements: readonly FinancialStatement[],
  statementType: FinancialStatementType,
): FiscalQuarterIndex {
  const index = new Map<number, FinancialStatement>();
  for (const statement of statements) {
    if (
      statement.statementType !== statementType ||
      !isFiscalQuarterPeriod(statement.period)
    ) {
      continue;
    }
    const rank = fiscalQuarterRank({
      fiscalYear: statement.fiscalYear,
      period: statement.period,
    });
    const existing = index.get(rank);
    if (!existing || representsFiscalPeriodOver(statement, existing)) {
      index.set(rank, statement);
    }
  }
  return index;
}

/** The family's latest fiscal quarter, or `undefined` when it has none. */
export function latestFiscalQuarterRank(
  index: FiscalQuarterIndex,
): number | undefined {
  let latest: number | undefined;
  for (const rank of index.keys()) {
    if (latest === undefined || rank > latest) {
      latest = rank;
    }
  }
  return latest;
}

/**
 * Latest fiscal quarter held by every one of the families.
 *
 * Field presence deliberately plays no part in choosing the anchor: a newer quarter every family
 * holds becomes authoritative even if one of its fields is missing, which then makes the
 * calculation unavailable rather than silently reusing an older window. The intrinsic-value models
 * anchor their cross-family windows here; Fundamental Metrics use
 * {@link alignedTrailingFiscalQuarterWindow}, which anchors at the newest quarter instead.
 */
export function latestCommonFiscalQuarterRank(
  indexes: readonly FiscalQuarterIndex[],
): number | undefined {
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

/** The newest fiscal quarter held by any of the families, or `undefined` when none holds one. */
export function newestFiscalQuarterRank(
  indexes: readonly FiscalQuarterIndex[],
): number | undefined {
  let newest: number | undefined;
  for (const index of indexes) {
    const rank = latestFiscalQuarterRank(index);
    if (rank !== undefined && (newest === undefined || rank > newest)) {
      newest = rank;
    }
  }
  return newest;
}

/** `count` consecutive fiscal-quarter ranks ending at `endRank`, oldest first. */
export function consecutiveFiscalQuarterRanks(
  endRank: number,
  count: number,
): number[] {
  return Array.from(
    { length: count },
    (_unused, offset) => endRank - (count - 1 - offset),
  );
}

/**
 * The family's statements for exactly these ranks, in the same order, or `undefined` as soon as
 * one quarter is missing.
 */
export function statementsForFiscalQuarters(
  index: FiscalQuarterIndex,
  ranks: readonly number[],
): FinancialStatement[] | undefined {
  const rows: FinancialStatement[] = [];
  for (const rank of ranks) {
    const statement = index.get(rank);
    if (!statement) {
      return undefined;
    }
    rows.push(statement);
  }
  return rows;
}

/** An exact consecutive window: its statements oldest first and the rank of its final quarter. */
export type FiscalQuarterWindow = {
  /** Rank of `Q[0]`, the window's final quarter. */
  endRank: number;
  statements: readonly FinancialStatement[];
};

/**
 * The exact `count`-quarter window ending at the family's latest quarter, `Q[-(count-1)]..Q[0]`.
 *
 * The latest quarter is authoritative: a gap anywhere inside the window makes it unavailable
 * rather than falling back to an older complete window, and an older quarter outside the window
 * can never change it.
 */
export function trailingFiscalQuarterWindow(
  index: FiscalQuarterIndex,
  count: number,
): FiscalQuarterWindow | undefined {
  const endRank = latestFiscalQuarterRank(index);
  if (endRank === undefined) {
    return undefined;
  }
  const statements = statementsForFiscalQuarters(
    index,
    consecutiveFiscalQuarterRanks(endRank, count),
  );
  return statements ? { endRank, statements } : undefined;
}

/** The current and immediately preceding four-quarter windows of one eight-quarter chain. */
export type YearOverYearWindows = {
  /** `Q[-7]..Q[-4]`, oldest first. */
  previous: readonly FinancialStatement[];
  /** `Q[-3]..Q[0]`, oldest first. */
  current: readonly FinancialStatement[];
};

/**
 * `Q[-7]..Q[-4]` and `Q[-3]..Q[0]` of the family's latest quarter: eight distinct consecutive
 * fiscal quarters, all present, or nothing. A shorter span is never rescaled into a year.
 */
export function trailingYearOverYearWindows(
  index: FiscalQuarterIndex,
): YearOverYearWindows | undefined {
  const window = trailingFiscalQuarterWindow(index, 2 * TTM_QUARTERS);
  if (!window) {
    return undefined;
  }
  return {
    previous: window.statements.slice(0, TTM_QUARTERS),
    current: window.statements.slice(TTM_QUARTERS),
  };
}

/**
 * One aligned `count`-quarter window across several families, ending at the newest fiscal quarter
 * any of them holds. `statements[i]` is family `i`'s rows for exactly the same fiscal identities,
 * oldest first.
 *
 * Every family must hold every quarter of that exact window. A family that lags the others — or has
 * stopped reporting — makes the window unavailable; it never falls back to an older window the
 * families happen to share, which would keep reporting a stale period as the current one. Families
 * are never windowed independently either.
 */
export function alignedTrailingFiscalQuarterWindow(
  indexes: readonly FiscalQuarterIndex[],
  count: number,
):
  | { endRank: number; statements: readonly (readonly FinancialStatement[])[] }
  | undefined {
  const endRank = newestFiscalQuarterRank(indexes);
  if (endRank === undefined) {
    return undefined;
  }
  const ranks = consecutiveFiscalQuarterRanks(endRank, count);
  const statements: FinancialStatement[][] = [];
  for (const index of indexes) {
    const rows = statementsForFiscalQuarters(index, ranks);
    if (!rows) {
      return undefined;
    }
    statements.push(rows);
  }
  return { endRank, statements };
}

/** The two state rows aligned to a flow window. */
export type AlignedStates = {
  /** The fiscal quarter immediately before the window's first quarter. */
  opening: FinancialStatement;
  /** The window's final quarter, `Q[0]`. */
  ending: FinancialStatement;
};

/**
 * Opening and ending state rows aligned to an exact flow window: the quarter immediately before
 * `Q[-(count-1)]` and `Q[0]` itself, both required.
 *
 * A newer state row that happens to be eligible is deliberately ignored: pairing a trailing flow
 * with an unrelated newer state merely because that filing arrived first is what alignment
 * forbids.
 */
export function alignedOpeningAndEndingStates(
  stateIndex: FiscalQuarterIndex,
  window: { endRank: number; count: number },
): AlignedStates | undefined {
  const opening = stateIndex.get(window.endRank - window.count);
  const ending = stateIndex.get(window.endRank);
  return opening && ending ? { opening, ending } : undefined;
}

/**
 * The family's latest independently eligible quarterly statement, whatever quarter any flow window
 * ends on. Latest means latest fiscal quarter, not latest filed.
 */
export function latestFiscalQuarterStatement(
  index: FiscalQuarterIndex,
): FinancialStatement | undefined {
  const rank = latestFiscalQuarterRank(index);
  return rank === undefined ? undefined : index.get(rank);
}

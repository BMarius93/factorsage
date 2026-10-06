import type { Instant, LocalDate, SecurityId } from "@intrinsic/domain";
import { addDays, maxDate } from "./dates.js";

/**
 * Re-base-safe price loading: the pure rules (`docs/decisions/historical-price-basis-v1.md`, §7–§10).
 *
 * The provider's research close is continuous through the corporate actions it folds in, and it
 * rescales the whole history before each one when it does. This module decides, from stored and
 * freshly read rows alone, whether such a rescaling happened and what it measured; whether the
 * newest rows must be held back because the provider may not have rewritten the older ones yet; and
 * the factor that puts a re-based close back on the basis a statement revision was observed on.
 * Nothing here reads a store, a provider or a clock.
 */

/**
 * Revision of how a re-based price history is interpreted: the detector, the hold, and the basis
 * factor that keeps every share-derived value on the units its statements were observed in
 * (`docs/decisions/historical-price-basis-v1.md`, §11).
 *
 * Recorded in every backtest snapshot, so a run queued under another interpretation is refused
 * rather than executed under it. Bump it whenever one of those rules changes a number.
 *
 * - 1: re-base detection by the earliest stored row, single-transaction replacement, measured
 *   re-bases, the ex-date hold, and intrinsic values divided by the basis factor.
 */
export const PRICE_BASIS_REVISION = 1;

/** What one comparison of a re-based history with the stored one measured. */
export type PriceBasisEventKind = "MEASURED" | "UNEXPLAINED";

/**
 * One measured re-base of one security's stored price history.
 *
 * A `MEASURED` event is dated by `effectiveDate`, the first session of the new basis, or, when its
 * ex-date fell between two reads, undated: it lies after `effectiveFrom` and no later than
 * `effectiveTo`, which the writer always sets: for an event after the newest compared session, the
 * newest session the provider had published after it or, with none yet, the later of the detection's
 * date and the day after that session; between two runs of one ratio each, the first session of the
 * newer run; after a stretch whose sessions admit both ratios, the first session that cannot be on
 * the old one (or, when all can, as for an event after the newest compared session).
 * `priceRatio` is the stored close over the new close of every row before the event. An
 * `UNEXPLAINED` event has no ratio. Its `effectiveTo` is the last changed session; its
 * `effectiveFrom` is the first changed session when the rows before it were compared and found
 * unchanged — a bounded block of changed rows, which no re-base can produce — and is absent when
 * the change reaches back to the earliest compared session.
 */
export type PriceBasisEvent = {
  securityId: SecurityId;
  /** The replacement that recorded it. */
  generation: number;
  kind: PriceBasisEventKind;
  effectiveDate?: LocalDate;
  effectiveFrom?: LocalDate;
  effectiveTo?: LocalDate;
  priceRatio?: number;
  detectedAt: Instant;
  evidence: PriceBasisEventEvidence;
};

/** Diagnostics only: no calculation reads them. */
export type PriceBasisEventEvidence = {
  /** The runs of constant `stored ÷ new` the comparison found, newest first. */
  runs: readonly {
    from: LocalDate;
    to: LocalDate;
    sessions: number;
    ratio: number;
  }[];
  comparedSessions: number;
  changedSessions: number;
  unfittedSessions: number;
};

/**
 * Another writer replaced the stored history after this one read the generation it compared
 * against, and nothing was written (§9). The loader's lease makes it unexpected, which is why it is
 * an error and not an outcome.
 */
export class PriceBasisConflictError extends Error {
  constructor(
    readonly securityId: SecurityId,
    readonly expectedGeneration: number,
    readonly actualGeneration: number,
  ) {
    super(
      `The stored price history of ${securityId} was replaced by another writer (generation ${expectedGeneration} -> ${actualGeneration})`,
    );
    this.name = "PriceBasisConflictError";
  }
}

/** The price basis of one security: its generation and when it was first verified. */
export type SecurityPriceBasisState = {
  securityId: SecurityId;
  generation: number;
  verifiedAt: Instant;
};

/** A close as the comparison reads it. */
export type PriceComparisonRow = { date: LocalDate; close: number };

/**
 * A row's rounding allowance: half a cent at or above $1, half a hundredth of a cent below.
 *
 * Stored rows carry up to eight decimals, so this is a floor that tolerates a provider rounding a
 * rescaled price, not the provider's last decimal.
 */
export function priceRoundingAllowance(value: number): number {
  return Math.abs(value) >= 1 ? 0.005 : 0.00005;
}

/** Whether two closes for one session differ beyond rounding. */
export function closesDiffer(stored: number, fresh: number): boolean {
  if (!Number.isFinite(stored) || !Number.isFinite(fresh)) {
    return stored !== fresh;
  }
  return (
    Math.abs(fresh - stored) >
    priceRoundingAllowance(stored) + priceRoundingAllowance(fresh)
  );
}

/** Sessions a split-sized move is held for before it is accepted as genuine (§7, rule 3). */
export const SPLIT_SIZED_MOVE_HOLD_SESSIONS = 4;

/** A close below this multiple of the previous one is split-sized (a 3:2 split or larger). */
export const SPLIT_SIZED_MOVE_FLOOR = 0.7;
/** A close above this multiple of the previous one is split-sized (a 1:2 reverse split or larger). */
export const SPLIT_SIZED_MOVE_CEILING = 1.4;

/** Whether `close` moved from `previousClose` by an amount only a split or a crash produces. */
export function isSplitSizedMove(
  previousClose: number,
  close: number,
): boolean {
  if (
    !Number.isFinite(previousClose) ||
    !Number.isFinite(close) ||
    previousClose <= 0 ||
    close <= 0
  ) {
    return false;
  }
  const ratio = close / previousClose;
  return ratio < SPLIT_SIZED_MOVE_FLOOR || ratio > SPLIT_SIZED_MOVE_CEILING;
}

/**
 * The index from which rows must not be saved yet, or `undefined` when every row may be.
 *
 * `series` is ascending and holds the newest stored row followed by the rows a read would add after
 * it (`firstNewIndex` is the first of those), or, on a first load, only the read's rows
 * (`firstNewIndex` 0). The provider may publish an ex-date row in the new basis before it rewrites
 * the older rows. Saved beside them, that row would read as a −75 % day against every indicator. So
 * a split-sized move into a new row is held while fewer than
 * {@link SPLIT_SIZED_MOVE_HOLD_SESSIONS} sessions stand from it to the newest row: the next read
 * either finds the history rewritten, which a full replacement then takes, or finds the move still
 * standing four sessions on, and then it is genuine and saved.
 */
export function heldFromIndex(
  series: readonly PriceComparisonRow[],
  firstNewIndex: number,
): number | undefined {
  for (
    let index = Math.max(firstNewIndex, 1);
    index < series.length;
    index += 1
  ) {
    const previous = series[index - 1] as PriceComparisonRow;
    const current = series[index] as PriceComparisonRow;
    if (
      isSplitSizedMove(previous.close, current.close) &&
      series.length - index < SPLIT_SIZED_MOVE_HOLD_SESSIONS
    ) {
      return index;
    }
  }
  return undefined;
}

/**
 * The share-changing ratios companies actually use besides `k:1` and `1:k`. Deliberately short:
 * every ratio admitted here is one a distribution is then assumed not to be, and the ratios between
 * 1 and 1.5 are dense with spin-off factors (AXP's 10000:8753 is within 0.03 % of 8:7).
 */
const PLAIN_FRACTIONAL_RATIOS: readonly (readonly [number, number])[] = [
  [3, 2],
  [5, 4],
  [4, 3],
  [5, 2],
  [5, 3],
];

/**
 * Whether a ratio is a plain share change (`valuation-ratios-v1.md`, "Corporate-action events"):
 * `k:1` or `1:k` for a whole `k >= 2`, or one of 3:2, 5:4, 4:3, 5:2, 5:3 either way, within
 * `tolerance` (0 for a provider entry's exact ratio, half a percent for a measured one).
 *
 * Used one-sidedly: an event that fails it may be a distribution and is treated as one. Every
 * provider distribution entry observed fails it (523:500, 131:125, 1323:1000, 10000:8753,
 * 1011:1000, 1907:2000, 5000:2399, 331:250), and every ordinary split and reverse split passes it.
 */
export function isPlainShareRatio(ratio: number, tolerance = 0.005): boolean {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return false;
  }
  const near = (target: number) =>
    Math.abs(ratio / target - 1) <= tolerance + 1e-12;
  const whole = Math.round(ratio >= 1 ? ratio : 1 / ratio);
  if (whole >= 2 && near(ratio >= 1 ? whole : 1 / whole)) {
    return true;
  }
  return PLAIN_FRACTIONAL_RATIOS.some(
    ([larger, smaller]) => near(larger / smaller) || near(smaller / larger),
  );
}

/** Sessions on each side a step needs before it is an event rather than a correction (§8). */
export const MINIMUM_STEP_SESSIONS = 3;

/** The share of compared sessions that may fit no step before the change is unexplained (§8). */
export const UNEXPLAINED_SESSION_SHARE = 0.01;

export type PriceRebaseComparison = {
  /** Sessions both histories hold. */
  comparedSessions: number;
  /** Whether any of them changed beyond rounding. */
  changed: boolean;
  /** Stored sessions the fresh history no longer holds. */
  storedOnly: LocalDate[];
  /** What the change measured, newest first; empty when nothing changed. */
  events: PriceBasisEvent[];
};

/** One common session, with the ratios its two rounded closes admit. */
type ComparedRow = {
  date: LocalDate;
  stored: number;
  fresh: number;
  /** The smallest and largest `stored ÷ new` both closes admit within their rounding. */
  low: number;
  high: number;
  /** Whether the two closes agree within rounding, which is ratio 1. */
  unchanged: boolean;
};

/**
 * Consecutive sessions explained by one ratio.
 *
 * A run is either **unchanged** — every session agrees within rounding, ratio 1 — or **changed**,
 * when every session differs and one ratio fits them all: the intersection of the ratios each
 * session admits, `[low, high]`, is not empty. The two never mix, so a corrected row can never pull
 * an unchanged history off ratio 1, nor an unchanged row join a re-base.
 */
type Run = {
  /** Indexes into the ascending compared rows, `newest` >= `oldest`. */
  newest: number;
  oldest: number;
  unchanged: boolean;
  low: number;
  high: number;
  /**
   * The `stored ÷ new` of the sessions that define the run. Absorbed corrections add none, so a
   * short run that absorbed its neighbours is still short.
   */
  ratios: number[];
};

/**
 * Compares a freshly read history with the stored one and measures what changed (§8).
 *
 * Going back in time a genuine re-base changes every earlier row by one ratio, and each earlier
 * event multiplies onto it, so `stored ÷ new` is constant between event dates and steps only at
 * them. Both histories are rounded — the provider rounds every rescaled row on its own — so a
 * session does not have one ratio but a range of them, and a run is a stretch of sessions whose
 * ranges share a ratio. The comparison walks the common sessions from the newest back and groups
 * them into runs:
 *
 * - a run of no more than two sessions between two runs of one ratio is corrected rows and is
 *   absorbed, as is a short changed run at either end;
 * - a short run between two different ratios fits no step and is dropped, and the runs it separated
 *   are joined when they share a ratio;
 * - each remaining step is a `MEASURED` event dated by the first session of the newer run, with
 *   the older run's ratio over the newer run's;
 * - when even the newest run changed, the event fell after the newest stored session and is
 *   undated: it lies between that session and the newest session the fresh history holds, or the
 *   detection when the provider holds none yet;
 * - when, going back, the ratio returns to "unchanged" after a changed run, the older rows were
 *   stored on a basis newer than the rows after them (a history mixed before this loader verified
 *   it). Their units cannot be restored, so that region is `UNEXPLAINED`;
 * - when more than 1 % of the compared sessions fit no run, the whole change is `UNEXPLAINED`.
 */
export function comparePriceHistories(input: {
  securityId: SecurityId;
  generation: number;
  detectedAt: Instant;
  stored: readonly PriceComparisonRow[];
  fresh: readonly PriceComparisonRow[];
}): PriceRebaseComparison {
  const freshByDate = new Map<LocalDate, number>();
  for (const row of input.fresh) {
    freshByDate.set(row.date, row.close);
  }
  const storedDates = new Set<LocalDate>();
  const common: { date: LocalDate; stored: number; fresh: number }[] = [];
  const storedOnly: LocalDate[] = [];
  for (const row of [...input.stored].sort(byDate)) {
    storedDates.add(row.date);
    const fresh = freshByDate.get(row.date);
    if (fresh === undefined) {
      storedOnly.push(row.date);
      continue;
    }
    common.push({ date: row.date, stored: row.close, fresh });
  }

  const changedIndexes = common
    .map((row, index) => (closesDiffer(row.stored, row.fresh) ? index : -1))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0) {
    return {
      comparedSessions: common.length,
      changed: false,
      storedOnly,
      events: [],
    };
  }

  const event = (
    fields: Omit<
      PriceBasisEvent,
      "securityId" | "generation" | "detectedAt" | "evidence"
    >,
    evidence: PriceBasisEventEvidence,
  ): PriceBasisEvent => ({
    securityId: input.securityId,
    generation: input.generation,
    detectedAt: input.detectedAt,
    ...fields,
    evidence,
  });

  // The end of an interval no session after the newest stored one closes: the detection's date, and
  // never on or before that session.
  const openIntervalEnd = (newestStored: LocalDate): LocalDate =>
    maxDate(
      input.detectedAt.slice(0, 10) as LocalDate,
      addDays(newestStored, 1),
    ) as LocalDate;

  const firstChanged = common[changedIndexes[0] as number]!.date;
  const lastChanged = common[changedIndexes.at(-1) as number]!.date;

  // A non-positive or non-finite close has no ratio; such a session fits no run.
  const valid = common.flatMap((row): ComparedRow[] =>
    Number.isFinite(row.stored) &&
    Number.isFinite(row.fresh) &&
    row.stored > 0 &&
    row.fresh > 0
      ? [comparedRow(row)]
      : [],
  );
  const segmented = segmentRuns(valid);
  const runs = segmented.runs;
  const unfitted = common.length - valid.length + segmented.droppedSessions;
  const evidence: PriceBasisEventEvidence = {
    runs: runs.map((run) => ({
      from: valid[run.oldest]!.date,
      to: valid[run.newest]!.date,
      sessions: length(run),
      ratio: runRatio(run),
    })),
    comparedSessions: common.length,
    changedSessions: changedIndexes.length,
    unfittedSessions: unfitted,
  };

  if (
    runs.length === 0 ||
    unfitted > common.length * UNEXPLAINED_SESSION_SHARE
  ) {
    return {
      comparedSessions: common.length,
      changed: true,
      storedOnly,
      events: [
        event(
          {
            kind: "UNEXPLAINED",
            // Rows before the first changed one were compared and are unchanged: a bounded block,
            // which a re-base (rescaling every earlier row) cannot produce.
            ...(firstChanged > common[0]!.date
              ? { effectiveFrom: firstChanged }
              : {}),
            effectiveTo: lastChanged,
          },
          evidence,
        ),
      ],
    };
  }

  const events: PriceBasisEvent[] = [];
  const newestRun = runs[0] as Run;
  const newestCommon = valid[newestRun.newest]!.date;
  // Sessions the provider published after the newest stored one.
  const later = input.fresh
    .filter((row) => row.date > newestCommon && !storedDates.has(row.date))
    .map((row) => row.date)
    .sort();
  if (!newestRun.unchanged) {
    // Every compared row changed: the event fell after the newest stored session.
    events.push(
      event(
        later.length === 1
          ? {
              kind: "MEASURED",
              effectiveDate: later[0] as LocalDate,
              priceRatio: runRatio(newestRun),
            }
          : {
              kind: "MEASURED",
              effectiveFrom: newestCommon,
              // With no session after it yet, the provider re-based ahead of the event's first
              // session, which is then no later than the detection — and after the newest stored one.
              effectiveTo: later.at(-1) ?? openIntervalEnd(newestCommon),
              priceRatio: runRatio(newestRun),
            },
        evidence,
      ),
    );
  }
  let changedSeen = !newestRun.unchanged;
  for (let index = 1; index < runs.length; index += 1) {
    const newer = runs[index - 1] as Run;
    const older = runs[index] as Run;
    if (changedSeen && older.unchanged) {
      // Going back, the history returns to "unchanged" after a changed run: these rows were stored
      // on a basis newer than the rows after them. Their units cannot be restored.
      events.push(
        event(
          // It reaches back to the earliest compared session, so it is unbounded below.
          { kind: "UNEXPLAINED", effectiveTo: valid[older.newest]!.date },
          evidence,
        ),
      );
      break;
    }
    const ratio = runRatio(older) / runRatio(newer);
    if (index === 1 && newer.unchanged) {
      // The sessions after the latest event may admit its ratio too, on a cheap stretch: the event
      // then lies anywhere up to the first of them that cannot be on it.
      const first = firstExcluding(valid, newer, runRatio(older));
      if (first !== newer.oldest || older.newest + 1 !== newer.oldest) {
        events.push(
          event(
            {
              kind: "MEASURED",
              effectiveFrom: valid[older.newest]!.date,
              effectiveTo:
                first === undefined
                  ? (later.at(-1) ?? openIntervalEnd(newestCommon))
                  : valid[first]!.date,
              priceRatio: ratio,
            },
            evidence,
          ),
        );
        changedSeen = true;
        continue;
      }
    }
    events.push(
      event(
        older.newest + 1 === newer.oldest
          ? {
              kind: "MEASURED",
              effectiveDate: valid[newer.oldest]!.date,
              priceRatio: ratio,
            }
          : {
              // Sessions between the two runs fit neither, so the step lies somewhere among them.
              kind: "MEASURED",
              effectiveFrom: valid[older.newest]!.date,
              effectiveTo: valid[newer.oldest]!.date,
              priceRatio: ratio,
            },
        evidence,
      ),
    );
    changedSeen = true;
  }
  return {
    comparedSessions: common.length,
    changed: true,
    storedOnly,
    events,
  };
}

function byDate(left: PriceComparisonRow, right: PriceComparisonRow): number {
  return left.date < right.date ? -1 : left.date > right.date ? 1 : 0;
}

/**
 * The ratios one session admits: every `stored ÷ new` of two closes within their rounding allowances
 * of the rounded ones. A genuine re-base's ratio lies inside it however each close was rounded.
 */
function comparedRow(row: {
  date: LocalDate;
  stored: number;
  fresh: number;
}): ComparedRow {
  const storedAllowance = priceRoundingAllowance(row.stored);
  const freshAllowance = priceRoundingAllowance(row.fresh);
  const freshLow = row.fresh - freshAllowance;
  return {
    ...row,
    low: (row.stored - storedAllowance) / (row.fresh + freshAllowance),
    high:
      freshLow > 0
        ? (row.stored + storedAllowance) / freshLow
        : Number.POSITIVE_INFINITY,
    unchanged: !closesDiffer(row.stored, row.fresh),
  };
}

/** Whether two runs are explained by one ratio: the same kind, sharing an admitted ratio. */
function shareRatio(left: Run, right: Run): boolean {
  return (
    left.unchanged === right.unchanged &&
    Math.max(left.low, right.low) <= Math.min(left.high, right.high)
  );
}

/**
 * Whether `change` is a re-base of at least {@link MINIMUM_STEP_SESSIONS} sessions sharing an
 * admitted ratio with the unchanged run `unchanged`. A correction never defines a ratio for others
 * to join.
 */
function establishedChange(change: Run, unchanged: Run): boolean {
  return (
    !change.unchanged &&
    change.ratios.length >= MINIMUM_STEP_SESSIONS &&
    Math.max(change.low, unchanged.low) <= Math.min(change.high, unchanged.high)
  );
}

/**
 * Whether the run at `index` holds the sessions after the latest event: the newest run, or one with
 * nothing newer than it but short corrected runs.
 */
function afterLatestEvent(runs: readonly Run[], index: number): boolean {
  return runs
    .slice(0, index)
    .every(
      (newer) =>
        !newer.unchanged && newer.ratios.length < MINIMUM_STEP_SESSIONS,
    );
}

/** The first session of `run` whose closes cannot be on `ratio`, or undefined when all of them can. */
function firstExcluding(
  rows: readonly ComparedRow[],
  run: Run,
  ratio: number,
): number | undefined {
  for (let index = run.oldest; index <= run.newest; index += 1) {
    const row = rows[index] as ComparedRow;
    if (row.low > ratio || row.high < ratio) {
      return index;
    }
  }
  return undefined;
}

/** `newer` and `older` as one run, spanning everything between them. */
function joined(newer: Run, older: Run): Run {
  return {
    newest: newer.newest,
    oldest: older.oldest,
    unchanged: newer.unchanged,
    low: Math.max(newer.low, older.low),
    high: Math.min(newer.high, older.high),
    ratios: [...newer.ratios, ...older.ratios],
  };
}

/**
 * Groups the ascending compared sessions into runs, newest first, and resolves corrections (§8).
 *
 * First, runs from the newest session back: a session joins the current run when it is of the same
 * kind and, for a changed run, still shares a ratio with every session already in it. Then, until
 * nothing changes: two neighbouring runs that share a ratio are one run; a run of fewer than
 * {@link MINIMUM_STEP_SESSIONS} sessions between two that share one is corrected rows, absorbed; a
 * short changed run at either end is corrected rows, absorbed into a neighbour that is not short
 * itself; and any other short run between two runs is dropped, its sessions counted as fitting no
 * run. A run's length here is the sessions that define it, never the corrections it absorbed. A short unchanged run at
 * either end stays: at the newest end it is the sessions after the latest event, however few; at
 * the oldest end, after a changed run, it is rows stored on a newer basis, which the caller reports
 * as unexplained.
 */
function segmentRuns(rows: readonly ComparedRow[]): {
  runs: Run[];
  droppedSessions: number;
} {
  let runs: Run[] = [];
  let current: Run | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index] as ComparedRow;
    if (
      current &&
      current.unchanged === row.unchanged &&
      Math.max(current.low, row.low) <= Math.min(current.high, row.high)
    ) {
      current.oldest = index;
      current.low = Math.max(current.low, row.low);
      current.high = Math.min(current.high, row.high);
      current.ratios.push(row.stored / row.fresh);
      continue;
    }
    current = {
      newest: index,
      oldest: index,
      unchanged: row.unchanged,
      low: row.low,
      high: row.high,
      ratios: [row.stored / row.fresh],
    };
    runs.push(current);
  }

  let droppedSessions = 0;
  const short = (run: Run) => run.ratios.length < MINIMUM_STEP_SESSIONS;
  for (let resolved = false; !resolved;) {
    resolved = true;
    const merge = runs.findIndex(
      (run, index) => index > 0 && shareRatio(runs[index - 1] as Run, run),
    );
    if (merge > 0) {
      runs.splice(merge - 1, 2, joined(runs[merge - 1]!, runs[merge]!));
      resolved = false;
      continue;
    }
    const correction = runs.findIndex(
      (run, index) =>
        index > 0 &&
        index < runs.length - 1 &&
        short(run) &&
        shareRatio(runs[index - 1] as Run, runs[index + 1] as Run),
    );
    if (correction > 0) {
      runs.splice(
        correction - 1,
        3,
        joined(runs[correction - 1]!, runs[correction + 1]!),
      );
      resolved = false;
      continue;
    }
    // Sessions within rounding of 1 that also admit an adjacent re-base's ratio are part of it: on a
    // cheap stretch a small re-base changes the close by less than the rounding. Not the sessions
    // after the latest event, newest or behind corrected newest sessions.
    const ambiguous = runs.findIndex(
      (run, index) =>
        run.unchanged &&
        !afterLatestEvent(runs, index) &&
        [runs[index - 1], runs[index + 1]].some(
          (neighbour) =>
            neighbour !== undefined && establishedChange(neighbour, run),
        ),
    );
    if (ambiguous > 0) {
      const run = runs[ambiguous] as Run;
      const into = establishedChange(runs[ambiguous - 1] as Run, run)
        ? ambiguous - 1
        : ambiguous + 1;
      const change = runs[into] as Run;
      runs[into] = {
        newest: Math.max(change.newest, run.newest),
        oldest: Math.min(change.oldest, run.oldest),
        unchanged: false,
        low: Math.max(change.low, run.low),
        high: Math.min(change.high, run.high),
        ratios: change.ratios,
      };
      runs.splice(ambiguous, 1);
      resolved = false;
      continue;
    }
    if (runs.length > 1) {
      const newest = runs[0] as Run;
      const oldest = runs.at(-1) as Run;
      // The sessions after the latest event are unchanged however few, so a corrected newest session
      // beside them belongs to them.
      if (
        short(newest) &&
        !newest.unchanged &&
        ((runs[1] as Run).unchanged || !short(runs[1] as Run))
      ) {
        runs[1] = { ...(runs[1] as Run), newest: newest.newest };
        runs.shift();
        resolved = false;
        continue;
      }
      if (
        short(oldest) &&
        !oldest.unchanged &&
        !short(runs[runs.length - 2] as Run)
      ) {
        runs[runs.length - 2] = {
          ...(runs[runs.length - 2] as Run),
          oldest: oldest.oldest,
        };
        runs.pop();
        resolved = false;
        continue;
      }
    }
    const stray = runs.findIndex(
      (run, index) =>
        index > 0 &&
        index < runs.length - 1 &&
        short(run) &&
        // The sessions after the latest event, behind corrected newest sessions, are kept.
        !(run.unchanged && afterLatestEvent(runs, index)),
    );
    if (stray > 0) {
      droppedSessions += length(runs[stray] as Run);
      runs = [...runs.slice(0, stray), ...runs.slice(stray + 1)];
      resolved = false;
    }
  }
  return { runs, droppedSessions };
}

function length(run: Run): number {
  return run.newest - run.oldest + 1;
}

/**
 * A run's ratio: 1 for an unchanged run; otherwise the median of its sessions' ratios, held inside
 * the ratios every one of them admits.
 */
function runRatio(run: Run): number {
  if (run.unchanged) {
    return 1;
  }
  const sorted = [...run.ratios].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return Math.min(Math.max(median, run.low), run.high);
}

/** Why a share-derived value is withheld on a session (§10). */
export type BasisWithheldReason =
  /** A change nothing could measure covers the session, or may reach it. */
  | "UNEXPLAINED_REBASE"
  /** The session is on or after a re-base the statement was observed before the detection of. */
  | "AFTER_REBASE"
  /** The statement was observed between a re-base's date and its detection. */
  | "OBSERVED_DURING_REBASE"
  /** The session or the observation lies inside an undated re-base's interval. */
  | "UNDATED_REBASE"
  /**
   * The session precedes a re-base that may have been a distribution, and the statement was
   * observed after it: the close before the event carries a factor nothing measured for those units.
   */
  | "BEFORE_DISTRIBUTION";

export type BasisFactor =
  | { kind: "FACTOR"; factor: number }
  | { kind: "WITHHELD"; reason: BasisWithheldReason };

/**
 * `K(t, R)`: the factor that puts the stored close of `session` on the basis a statement revision
 * observed at `observedAt` was observed on (§10; `valuation-ratios-v1.md`, rule 6).
 *
 * For each measured re-base, by where the observation falls:
 *
 * - **Before the event** (its date, or the start of its undated interval), and detected after the
 *   observation: a session before the event takes the event's ratio, which restores the close as it
 *   was stored when the revision was observed; a session on or after it, or inside its interval, is
 *   withheld, because without classifying the event the revision's units are unknown there.
 * - **Between the event and its detection:** withheld. The provider may or may not have restated
 *   the revision by then.
 * - **After the detection:** the revision is in the event's new units. A session on or after the
 *   event needs nothing. A session before it needs nothing either when the event is a plain share
 *   change, since the restated count and the rescaled close cancel; otherwise the event may have
 *   been a distribution, whose factor the close before it carries and the count does not, and the
 *   session is withheld.
 *
 * An unexplained change bounded by unchanged rows withholds only the sessions it changed; one that
 * reaches back to the earliest compared session withholds every session for a revision observed
 * before its detection. An observation is "before" a date only on an earlier calendar date (UTC),
 * never on the date itself.
 */
export function basisFactorAt(input: {
  session: LocalDate;
  observedAt: Instant;
  events: readonly PriceBasisEvent[];
}): BasisFactor {
  const observedTime = Date.parse(input.observedAt);
  const observedDate = input.observedAt.slice(0, 10);
  let factor = 1;
  for (const event of input.events) {
    const detectedAfter = Date.parse(event.detectedAt) > observedTime;
    if (event.kind === "UNEXPLAINED" || event.priceRatio === undefined) {
      if (!detectedAfter) {
        continue;
      }
      const to = event.effectiveTo;
      if (
        event.effectiveFrom === undefined ||
        to === undefined ||
        (input.session >= event.effectiveFrom && input.session <= to)
      ) {
        return { kind: "WITHHELD", reason: "UNEXPLAINED_REBASE" };
      }
      continue;
    }
    // The last session certainly before an undated event, and where the session falls.
    const lastBefore =
      event.effectiveDate === undefined ? event.effectiveFrom : undefined;
    const sessionBefore =
      event.effectiveDate !== undefined
        ? input.session < event.effectiveDate
        : lastBefore !== undefined && input.session <= lastBefore;
    const sessionAfter =
      !sessionBefore &&
      (event.effectiveDate !== undefined
        ? input.session >= event.effectiveDate
        : event.effectiveTo !== undefined &&
          input.session >= event.effectiveTo);
    if (!detectedAfter) {
      if (sessionAfter || isPlainShareRatio(event.priceRatio)) {
        continue;
      }
      return {
        kind: "WITHHELD",
        reason: sessionBefore ? "BEFORE_DISTRIBUTION" : "UNDATED_REBASE",
      };
    }
    const observedBefore =
      event.effectiveDate !== undefined
        ? observedDate < event.effectiveDate
        : lastBefore !== undefined && observedDate <= lastBefore;
    if (!observedBefore) {
      return {
        kind: "WITHHELD",
        reason:
          event.effectiveDate !== undefined
            ? "OBSERVED_DURING_REBASE"
            : "UNDATED_REBASE",
      };
    }
    if (!sessionBefore) {
      return {
        kind: "WITHHELD",
        reason: sessionAfter ? "AFTER_REBASE" : "UNDATED_REBASE",
      };
    }
    factor *= event.priceRatio;
  }
  return { kind: "FACTOR", factor };
}

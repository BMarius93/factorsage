import type { Instant, LocalDate, SecurityId } from "@intrinsic/domain";

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
 * `effectiveTo`, which is absent when the provider had published no session after it yet.
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

/** Sessions a split-sized move is held for before it is accepted as genuine (§7, rule 4). */
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

type Run = {
  /** Indexes into the ascending common sessions, `newest` >= `oldest`. */
  newest: number;
  oldest: number;
  ratios: number[];
  reference: number;
};

/**
 * Compares a freshly read history with the stored one and measures what changed (§8).
 *
 * Going back in time a genuine re-base changes every earlier row by one ratio, and each earlier
 * event multiplies onto it, so `stored ÷ new` is constant between event dates and steps only at
 * them. The comparison walks the common sessions from the newest back and groups them into runs of
 * one ratio:
 *
 * - a run of no more than two sessions whose neighbours agree with each other is a correction and
 *   is absorbed, as is a short run at either end;
 * - each remaining step is a `MEASURED` event dated by the first session of the newer run, with
 *   the older run's ratio over the newer run's;
 * - when even the newest run changed, the event fell after the newest stored session and is
 *   undated: it lies between that session and the newest session the fresh history holds;
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

  const firstChanged = common[changedIndexes[0] as number]!.date;
  const lastChanged = common[changedIndexes.at(-1) as number]!.date;

  // A non-positive or non-finite close has no ratio; such a session fits no run.
  const valid = common.filter(
    (row) =>
      Number.isFinite(row.stored) &&
      Number.isFinite(row.fresh) &&
      row.stored > 0 &&
      row.fresh > 0,
  );
  const runs = absorbCorrections(buildRuns(valid));
  const fitted = runs.reduce((total, run) => total + length(run), 0);
  const unfitted = common.length - fitted;
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
  if (!isUnit(runRatio(newestRun))) {
    // Every compared row changed: the event fell after the newest stored session.
    const later = input.fresh
      .filter((row) => row.date > newestCommon && !storedDates.has(row.date))
      .map((row) => row.date)
      .sort();
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
              ...(later.length > 0
                ? { effectiveTo: later.at(-1) as LocalDate }
                : {}),
              priceRatio: runRatio(newestRun),
            },
        evidence,
      ),
    );
  }
  let changedSeen = !isUnit(runRatio(newestRun));
  for (let index = 1; index < runs.length; index += 1) {
    const newer = runs[index - 1] as Run;
    const older = runs[index] as Run;
    if (changedSeen && isUnit(runRatio(older))) {
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

/** Whether `ratio` is "unchanged" within the comparison's tolerance. */
function isUnit(ratio: number): boolean {
  return Math.abs(ratio - 1) <= 1e-4;
}

/** Whether a session's closes agree with `ratio` within both rows' rounding. */
function fitsRatio(
  row: { stored: number; fresh: number },
  ratio: number,
): boolean {
  return (
    Math.abs(row.stored - ratio * row.fresh) <=
    priceRoundingAllowance(row.stored) +
      ratio * priceRoundingAllowance(row.fresh) +
      1e-9
  );
}

/** Groups the ascending common sessions into runs of one ratio, newest first. */
function buildRuns(
  common: readonly { date: LocalDate; stored: number; fresh: number }[],
): Run[] {
  const runs: Run[] = [];
  let current: Run | undefined;
  for (let index = common.length - 1; index >= 0; index -= 1) {
    const row = common[index] as { stored: number; fresh: number };
    const unchanged = !closesDiffer(row.stored, row.fresh);
    const ratio = unchanged ? 1 : row.stored / row.fresh;
    if (current && fitsRatio(row, current.reference)) {
      current.oldest = index;
      current.ratios.push(ratio);
      continue;
    }
    current = {
      newest: index,
      oldest: index,
      ratios: [ratio],
      reference: ratio,
    };
    runs.push(current);
  }
  return runs;
}

/**
 * Absorbs corrections. A run of fewer than {@link MINIMUM_STEP_SESSIONS} sessions between two runs
 * that agree with each other is corrected rows, never an event; so is a short changed run at either
 * end. A short run of unchanged sessions at either end stays (see the loop). What remains are the
 * steps; short runs between two different ratios fit no step and are dropped, which the caller
 * counts.
 */
function absorbCorrections(runs: Run[]): Run[] {
  let result = [...runs];
  let merged = true;
  while (merged) {
    merged = false;
    for (
      let index = 0;
      index < result.length && result.length > 1;
      index += 1
    ) {
      const run = result[index] as Run;
      if (length(run) >= MINIMUM_STEP_SESSIONS) {
        continue;
      }
      const newer = result[index - 1];
      const older = result[index + 1];
      if (newer && older) {
        if (sameRatio(runRatio(newer), runRatio(older))) {
          result = [
            ...result.slice(0, index - 1),
            {
              newest: newer.newest,
              oldest: older.oldest,
              ratios: [...newer.ratios, ...older.ratios],
              reference: newer.reference,
            },
            ...result.slice(index + 2),
          ];
          merged = true;
          break;
        }
        continue;
      }
      if (isUnit(runRatio(run))) {
        // Unchanged rows at an end are never corrections. At the newest end they are the sessions
        // after the latest event, however few; at the oldest end, after a changed run, they are
        // rows stored on a newer basis, which the caller reports as unexplained.
        continue;
      }
      const neighbour = (newer ?? older) as Run;
      const absorbed: Run = {
        newest: Math.max(neighbour.newest, run.newest),
        oldest: Math.min(neighbour.oldest, run.oldest),
        ratios: neighbour.ratios,
        reference: neighbour.reference,
      };
      result = newer
        ? [...result.slice(0, index - 1), absorbed]
        : [absorbed, ...result.slice(index + 2)];
      merged = true;
      break;
    }
  }
  return result.filter(
    (run, index) =>
      length(run) >= MINIMUM_STEP_SESSIONS ||
      result.length === 1 ||
      ((index === 0 || index === result.length - 1) && isUnit(runRatio(run))),
  );
}

function length(run: Run): number {
  return run.newest - run.oldest + 1;
}

function sameRatio(left: number, right: number): boolean {
  return Math.abs(left / right - 1) <= 1e-4;
}

/** A run's ratio: the median of its sessions' ratios. */
function runRatio(run: Run): number {
  const sorted = [...run.ratios].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
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
 * observed at `observedAt` was observed on (§10; `valuation-ratios-v1.md`, rule 5).
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
      event.effectiveDate !== undefined
        ? input.session >= event.effectiveDate
        : event.effectiveTo !== undefined && input.session > event.effectiveTo;
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

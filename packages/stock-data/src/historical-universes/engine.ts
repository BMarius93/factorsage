import type {
  LocalDate,
  UniverseMethod,
  UniverseReconstitution,
} from "@intrinsic/domain";

/**
 * The historical universe engine: pure, deterministic and infrastructure-free
 * (`docs/decisions/historical-universes-v1.md` §4).
 *
 * Sessions, parent membership and metric values in; reconstitution dates, selections and the
 * membership periods a List carries out. Nothing here reads a database, a cache, a provider or a
 * clock, so every rule below is tested on fixtures and two runs over the same input are identical.
 *
 * The point-in-time rules, in one place:
 *
 * 1. A reconstitution date `T` is the **last trading session** of a listed month; the calendar is the
 *    sessions the caller observed, never a weekday rule.
 * 2. The candidates on `T` are the parent's members **on `T`** — never a member known only later.
 * 3. A candidate's value is computed by the caller from data **available by `T`'s close**.
 * 4. The selection takes effect on the **day after `T`** — the next trading session for every
 *    purpose a buy window serves, since a window is read only on sessions — and lasts through the
 *    next reconstitution date inclusive.
 * 5. A membership is never wider than the member's parent membership: it is clipped to it.
 * 6. Ties are broken by the larger tie-break value (market capitalization), then the security id,
 *    so an equal ranking always resolves the same way.
 */

/** Bump whenever a rule here changes a selection or a period. Recorded in every generation. */
export const HISTORICAL_UNIVERSE_ENGINE_VERSION = 1;

/** One inclusive range of membership; `endDate` null while it is still open. */
export type MembershipRange = {
  readonly startDate: LocalDate;
  readonly endDate: LocalDate | null;
};

export type ReconstitutionDate = {
  /** The selection is read at this session's close. */
  readonly date: LocalDate;
  /** The first day it is in effect. */
  readonly effectiveDate: LocalDate;
};

export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10) as LocalDate;
}

/**
 * The reconstitution dates inside `range`: the last observed session of each listed month. A month
 * whose last session is not yet known — the current month, or a month after the sessions end — has
 * no reconstitution: the last session of an unfinished month is not its last session.
 */
export function reconstitutionDates(input: {
  readonly sessions: readonly LocalDate[];
  readonly reconstitution: UniverseReconstitution;
  readonly from: LocalDate;
  readonly to: LocalDate;
  /** The first day after the sessions end is known to be outside them (a month is complete). */
  readonly sessionsComplete?: boolean;
}): ReconstitutionDate[] {
  const months = new Set(input.reconstitution.months);
  const lastOfMonth = new Map<string, LocalDate>();
  for (const session of input.sessions) {
    const month = session.slice(0, 7);
    const known = lastOfMonth.get(month);
    if (known === undefined || session > known) {
      lastOfMonth.set(month, session);
    }
  }
  const latestSession = input.sessions.reduce<LocalDate | null>(
    (latest, session) =>
      latest === null || session > latest ? session : latest,
    null,
  );
  const dates: ReconstitutionDate[] = [];
  for (const [month, session] of [...lastOfMonth.entries()].sort(
    (left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
  )) {
    if (!months.has(Number(month.slice(5, 7)))) {
      continue;
    }
    if (session < input.from || session > input.to) {
      continue;
    }
    // The latest observed month may be unfinished; its "last session" is only the latest one seen.
    if (
      latestSession !== null &&
      month === latestSession.slice(0, 7) &&
      input.sessionsComplete !== true
    ) {
      continue;
    }
    dates.push({ date: session, effectiveDate: addCalendarDays(session, 1) });
  }
  return dates;
}

/** Whether `date` lies inside one of the ranges (inclusive). */
export function inRanges(
  ranges: readonly MembershipRange[],
  date: LocalDate,
): boolean {
  return ranges.some(
    (range) =>
      range.startDate <= date &&
      (range.endDate === null || date <= range.endDate),
  );
}

/** The parent's members on `date`: every security one of whose ranges contains it, sorted. */
export function membersOn(
  parent: ReadonlyMap<string, readonly MembershipRange[]>,
  date: LocalDate,
): string[] {
  const members: string[] = [];
  for (const [securityId, ranges] of parent) {
    if (inRanges(ranges, date)) {
      members.push(securityId);
    }
  }
  return members.sort();
}

export type RankingCandidate = {
  readonly securityId: string;
  /** The ranked value, or `null`/`NaN` when it is unavailable on the date. */
  readonly value: number | null;
  /** The tie-break value (market capitalization); `null` when unknown. */
  readonly tieBreak: number | null;
};

export type RankingRule = Extract<UniverseMethod, { kind: "RANK" }>;

export type RankedSelection = {
  readonly securityId: string;
  /** 1 is the first selected. */
  readonly rank: number;
  readonly value: number;
};

export type SelectionOutcome = {
  readonly selected: readonly RankedSelection[];
  /** Candidates whose value was usable (finite, and positive where the rule asks for it). */
  readonly withValue: number;
  /** How many the rule asks for on this date: its count, or its fraction of `withValue`. */
  readonly expected: number;
};

const usable = (value: number | null, positiveOnly: boolean): value is number =>
  value !== null && Number.isFinite(value) && (!positiveOnly || value > 0);

/** The rule's selection among the candidates, deterministically ordered. */
export function selectTop(
  candidates: readonly RankingCandidate[],
  rule: Pick<RankingRule, "order" | "select" | "positiveOnly">,
): SelectionOutcome {
  const positiveOnly = rule.positiveOnly === true;
  const eligible = candidates.filter((candidate) =>
    usable(candidate.value, positiveOnly),
  ) as (RankingCandidate & { value: number })[];
  const direction = rule.order === "HIGHEST" ? -1 : 1;
  eligible.sort((left, right) => {
    if (left.value !== right.value) {
      return left.value < right.value ? -direction : direction;
    }
    const leftTie = left.tieBreak ?? Number.NEGATIVE_INFINITY;
    const rightTie = right.tieBreak ?? Number.NEGATIVE_INFINITY;
    if (leftTie !== rightTie) {
      return leftTie > rightTie ? -1 : 1;
    }
    return left.securityId < right.securityId
      ? -1
      : left.securityId > right.securityId
        ? 1
        : 0;
  });
  const expected =
    "count" in rule.select
      ? rule.select.count
      : Math.floor(eligible.length * rule.select.fraction + 0.5);
  const selected = eligible.slice(0, expected).map((candidate, index) => ({
    securityId: candidate.securityId,
    rank: index + 1,
    value: candidate.value,
  }));
  return { selected, withValue: eligible.length, expected };
}

/**
 * Percentile ranks of one component among the candidates that have it: 0 for the lowest, 1 for the
 * highest, ties sharing the mean of their positions. A single candidate is 0.5.
 */
export function percentileRanks(
  values: ReadonlyMap<string, number | null>,
): Map<string, number> {
  const present = [...values.entries()]
    .filter(
      (entry): entry is [string, number] =>
        entry[1] !== null && Number.isFinite(entry[1]),
    )
    .sort((left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : 1));
  const ranks = new Map<string, number>();
  if (present.length === 1) {
    ranks.set((present[0] as [string, number])[0], 0.5);
    return ranks;
  }
  let index = 0;
  while (index < present.length) {
    let end = index;
    while (
      end + 1 < present.length &&
      (present[end + 1] as [string, number])[1] ===
        (present[index] as [string, number])[1]
    ) {
      end += 1;
    }
    const position = (index + end) / 2 / (present.length - 1);
    for (let tied = index; tied <= end; tied += 1) {
      ranks.set((present[tied] as [string, number])[0], position);
    }
    index = end + 1;
  }
  return ranks;
}

/**
 * A composite score: the mean of a candidate's percentile ranks over the components it has, when it
 * has at least `minimumComponents` of them; otherwise `null`. Each component is ranked among the
 * candidates of the date alone, so the score is point-in-time whenever its components are.
 */
export function compositeScores(
  components: readonly ReadonlyMap<string, number | null>[],
  minimumComponents: number,
): Map<string, number | null> {
  const ranked = components.map(percentileRanks);
  const securities = new Set<string>();
  for (const component of components) {
    for (const securityId of component.keys()) {
      securities.add(securityId);
    }
  }
  const scores = new Map<string, number | null>();
  for (const securityId of [...securities].sort()) {
    const parts = ranked
      .map((ranks) => ranks.get(securityId))
      .filter((rank): rank is number => rank !== undefined);
    scores.set(
      securityId,
      parts.length >= minimumComponents
        ? parts.reduce((sum, rank) => sum + rank, 0) / parts.length
        : null,
    );
  }
  return scores;
}

/** One reconstitution's selection, in the order it was ranked. */
export type ReconstitutionSelection = ReconstitutionDate & {
  readonly securityIds: readonly string[];
};

/**
 * The membership a sequence of selections makes: each selection in effect from its effective date
 * through the next reconstitution date (the last one open-ended), consecutive selections of a
 * security merged into one range, and every range clipped to the security's parent membership and
 * to `floor`. A security selected, dropped and selected again has two ranges.
 */
export function membershipPeriods(input: {
  readonly selections: readonly ReconstitutionSelection[];
  readonly parent: ReadonlyMap<string, readonly MembershipRange[]>;
  readonly floor: LocalDate;
}): Map<string, MembershipRange[]> {
  const ordered = [...input.selections].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  const raw = new Map<string, MembershipRange[]>();
  ordered.forEach((selection, index) => {
    const next = ordered[index + 1];
    const endDate = next ? next.date : null;
    for (const securityId of selection.securityIds) {
      const ranges = raw.get(securityId) ?? [];
      const last = ranges[ranges.length - 1];
      if (
        last &&
        last.endDate !== null &&
        addCalendarDays(last.endDate, 1) === selection.effectiveDate
      ) {
        ranges[ranges.length - 1] = { startDate: last.startDate, endDate };
      } else {
        ranges.push({ startDate: selection.effectiveDate, endDate });
      }
      raw.set(securityId, ranges);
    }
  });
  const periods = new Map<string, MembershipRange[]>();
  const byKey = (left: [string, unknown], right: [string, unknown]) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  for (const [securityId, ranges] of [...raw.entries()].sort(byKey)) {
    const clipped = normalizeRanges(
      intersectRanges(ranges, input.parent.get(securityId) ?? []).flatMap(
        (range) => clipToFloor(range, input.floor),
      ),
    );
    if (clipped.length > 0) {
      periods.set(securityId, clipped);
    }
  }
  return periods;
}

function clipToFloor(
  range: MembershipRange,
  floor: LocalDate,
): MembershipRange[] {
  if (range.endDate !== null && range.endDate < floor) {
    return [];
  }
  return [
    {
      startDate: range.startDate < floor ? floor : range.startDate,
      endDate: range.endDate,
    },
  ];
}

const maxDate = (left: LocalDate, right: LocalDate): LocalDate =>
  left > right ? left : right;

const minEnd = (
  left: LocalDate | null,
  right: LocalDate | null,
): LocalDate | null =>
  left === null ? right : right === null ? left : left < right ? left : right;

/** The pairwise intersection of two sets of inclusive ranges. */
export function intersectRanges(
  left: readonly MembershipRange[],
  right: readonly MembershipRange[],
): MembershipRange[] {
  const out: MembershipRange[] = [];
  for (const a of left) {
    for (const b of right) {
      const startDate = maxDate(a.startDate, b.startDate);
      const endDate = minEnd(a.endDate, b.endDate);
      if (endDate === null || startDate <= endDate) {
        out.push({ startDate, endDate });
      }
    }
  }
  return out;
}

/** Sorted, with overlapping or adjacent ranges merged. */
export function normalizeRanges(
  ranges: readonly MembershipRange[],
): MembershipRange[] {
  const sorted = [...ranges].sort((left, right) =>
    left.startDate < right.startDate
      ? -1
      : left.startDate > right.startDate
        ? 1
        : 0,
  );
  const merged: MembershipRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (
      last &&
      (last.endDate === null ||
        addCalendarDays(last.endDate, 1) >= range.startDate)
    ) {
      merged[merged.length - 1] = {
        startDate: last.startDate,
        endDate:
          last.endDate === null || range.endDate === null
            ? null
            : last.endDate > range.endDate
              ? last.endDate
              : range.endDate,
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/**
 * The most members in effect on any one date, and the distinct securities: a universe's size as a
 * backtest's plan check measures it (`peakSimultaneousMembers`).
 */
export function measurePeriods(
  periods: ReadonlyMap<string, readonly MembershipRange[]>,
): {
  distinctSecurities: number;
  peakSimultaneousMembers: number;
  peakDate: LocalDate | null;
} {
  const events = new Map<LocalDate, number>();
  for (const ranges of periods.values()) {
    for (const range of ranges) {
      events.set(range.startDate, (events.get(range.startDate) ?? 0) + 1);
      if (range.endDate !== null) {
        const after = addCalendarDays(range.endDate, 1);
        events.set(after, (events.get(after) ?? 0) - 1);
      }
    }
  }
  let current = 0;
  let peak = 0;
  let peakDate: LocalDate | null = null;
  for (const [date, delta] of [...events.entries()].sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  )) {
    current += delta;
    if (current > peak) {
      peak = current;
      peakDate = date;
    }
  }
  return {
    distinctSecurities: periods.size,
    peakSimultaneousMembers: peak,
    peakDate,
  };
}

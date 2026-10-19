import {
  normalizeBuyWindowRanges,
  type BuyWindowRange,
  type LocalDate,
} from "@intrinsic/domain";
import { addDays } from "../dates.js";
import type {
  StoredIndexConstituent,
  StoredMembershipPeriod,
} from "./ports.js";

/**
 * How well a reconstruction agrees with what is known about the index, and the List it projects.
 *
 * The S&P 500 holds exactly 500 companies; a company with two listed share classes in the index
 * (Alphabet, Fox, News Corp) contributes two lines, so on any date the index holds **at least** 500
 * lines and, historically, at most about 506. A reconstructed date with fewer than 500 lines is
 * missing constituents the provider's change log does not record; one with more than the ceiling
 * holds a constituent whose removal the log does not record. Those spans are what "cannot be
 * reliably reconstructed" means, measured rather than asserted.
 */

/** Fewer reconstructed lines than this on a date means constituents are missing. */
export const INDEX_EXPECTED_MIN_LINES = 500;

/** More reconstructed lines than this on a date means a removal is missing. */
export const INDEX_EXPECTED_MAX_LINES = 506;

export type MembershipCountSpan = {
  readonly from: LocalDate;
  readonly to: LocalDate;
  readonly minLines: number;
  readonly maxLines: number;
};

export type MembershipQualityReport = {
  readonly horizon: { readonly floor: LocalDate; readonly asOf: LocalDate };
  /** Lines held on the first day of every calendar year, then on `asOf`. */
  readonly checkpoints: readonly { date: LocalDate; lines: number }[];
  readonly minimum: { date: LocalDate; lines: number };
  readonly maximum: { date: LocalDate; lines: number };
  /** Maximal spans with fewer lines than {@link INDEX_EXPECTED_MIN_LINES}. */
  readonly deficits: readonly MembershipCountSpan[];
  /** Maximal spans with more lines than {@link INDEX_EXPECTED_MAX_LINES}. */
  readonly surpluses: readonly MembershipCountSpan[];
  /** Days inside the horizon whose count lies inside the expected band. */
  readonly daysWithinBand: number;
  readonly daysInHorizon: number;
  /** Periods whose end the provider never recorded, inside the horizon: excluded from the List. */
  readonly endUnknownPeriods: readonly {
    constituentKey: string;
    ticker: string;
    startDate: LocalDate | null;
  }[];
};

type CountedConstituent = Pick<
  StoredIndexConstituent,
  "constituentKey" | "ticker"
> & {
  readonly periods: readonly Pick<
    StoredMembershipPeriod,
    "startDate" | "endDate" | "quality"
  >[];
};

/** Counts reconstructed lines on every day of the horizon and reports where they leave the band. */
export function membershipQualityReport(
  constituents: readonly CountedConstituent[],
  horizon: { floor: LocalDate; asOf: LocalDate },
  predicate: (constituent: CountedConstituent) => boolean = () => true,
): MembershipQualityReport {
  const deltas = new Map<LocalDate, number>();
  const endUnknown: MembershipQualityReport["endUnknownPeriods"][number][] = [];
  let base = 0;
  for (const constituent of constituents) {
    if (!predicate(constituent)) {
      continue;
    }
    for (const period of constituent.periods) {
      if (period.quality === "END_UNKNOWN") {
        if (period.startDate === null || period.startDate <= horizon.asOf) {
          endUnknown.push({
            constituentKey: constituent.constituentKey,
            ticker: constituent.ticker,
            startDate: period.startDate,
          });
        }
        continue;
      }
      const start =
        period.startDate === null || period.startDate < horizon.floor
          ? horizon.floor
          : period.startDate;
      const end =
        period.endDate === null || period.endDate > horizon.asOf
          ? horizon.asOf
          : period.endDate;
      if (start > end) {
        continue;
      }
      if (start === horizon.floor) {
        base += 1;
      } else {
        deltas.set(start, (deltas.get(start) ?? 0) + 1);
      }
      const after = addDays(end, 1);
      deltas.set(after, (deltas.get(after) ?? 0) - 1);
    }
  }

  const checkpoints: { date: LocalDate; lines: number }[] = [];
  const deficits: MembershipCountSpan[] = [];
  const surpluses: MembershipCountSpan[] = [];
  let minimum = { date: horizon.floor, lines: Number.POSITIVE_INFINITY };
  let maximum = { date: horizon.floor, lines: Number.NEGATIVE_INFINITY };
  let daysWithinBand = 0;
  let daysInHorizon = 0;
  let current = base;
  let open: { kind: "deficit" | "surplus"; span: MembershipCountSpan } | null =
    null;

  const close = () => {
    if (open) {
      (open.kind === "deficit" ? deficits : surpluses).push(open.span);
      open = null;
    }
  };

  for (let day = horizon.floor; day <= horizon.asOf; day = addDays(day, 1)) {
    if (day !== horizon.floor) {
      current += deltas.get(day) ?? 0;
    }
    daysInHorizon += 1;
    if (day.endsWith("-01-01") || day === horizon.floor) {
      checkpoints.push({ date: day, lines: current });
    }
    if (current < minimum.lines) {
      minimum = { date: day, lines: current };
    }
    if (current > maximum.lines) {
      maximum = { date: day, lines: current };
    }
    const kind =
      current < INDEX_EXPECTED_MIN_LINES
        ? "deficit"
        : current > INDEX_EXPECTED_MAX_LINES
          ? "surplus"
          : null;
    if (kind === null) {
      daysWithinBand += 1;
      close();
      continue;
    }
    if (open && open.kind === kind) {
      open.span = {
        from: open.span.from,
        to: day,
        minLines: Math.min(open.span.minLines, current),
        maxLines: Math.max(open.span.maxLines, current),
      };
    } else {
      close();
      open = {
        kind,
        span: { from: day, to: day, minLines: current, maxLines: current },
      };
    }
  }
  close();
  if (checkpoints.at(-1)?.date !== horizon.asOf) {
    checkpoints.push({ date: horizon.asOf, lines: current });
  }
  return {
    horizon,
    checkpoints,
    minimum,
    maximum,
    deficits,
    surpluses,
    daysWithinBand,
    daysInHorizon,
    endUnknownPeriods: endUnknown,
  };
}

/** One List member projected from the canonical membership. */
export type ProjectedIndexListMember = {
  readonly securityId: string;
  /** Canonical, normalized buy windows: one per membership period, adjacent ones merged. */
  readonly ranges: readonly BuyWindowRange[];
  /** Constituents whose periods this member carries. */
  readonly constituentKeys: readonly string[];
};

/**
 * The List a point-in-time universe projects: every tradeable constituent's periods, merged per
 * security, clipped at the List's floor, open-ended where the membership is ongoing.
 *
 * `END_UNKNOWN` periods are never projected, and neither is any constituent whose resolution is not
 * tradeable. Ordered by security id, so the projection is deterministic.
 *
 * A constituent whose security's prices are its history only from `securityFrom` (an identity
 * correction: an acquirer's own listing before a merger) projects nothing earlier; its earlier
 * membership stays in the canonical dataset, unpriced.
 *
 * One day is restored where the reconstruction's caution would otherwise cut a security's
 * membership in two: when the same security leaves (one constituent) and rejoins (another) on one
 * unconfirmed log date — a merger's survivor, a renamed share class — it was a member on that date
 * under either reading of it (the removal took effect the next session, or the addition that day).
 */
export function projectIndexList(
  constituents: readonly (Pick<
    StoredIndexConstituent,
    "constituentKey" | "securityId" | "resolution" | "periods"
  > &
    Partial<Pick<StoredIndexConstituent, "securityFrom">>)[],
  floor: LocalDate,
): ProjectedIndexListMember[] {
  const tradeable: {
    securityId: string;
    constituentKey: string;
    period: StoredMembershipPeriod;
    /** The first day the security's prices are this constituent's: nothing earlier is projected. */
    securityFrom: LocalDate | null;
  }[] = [];
  for (const constituent of constituents) {
    if (
      constituent.securityId === null ||
      (constituent.resolution !== "RESOLVED" &&
        constituent.resolution !== "RESOLVED_PARTIAL")
    ) {
      continue;
    }
    for (const period of constituent.periods) {
      if (period.quality !== "END_UNKNOWN") {
        tradeable.push({
          securityId: constituent.securityId,
          constituentKey: constituent.constituentKey,
          period,
          securityFrom: constituent.securityFrom ?? null,
        });
      }
    }
  }
  // Per security, the log dates of removals the reconstruction ended the day before.
  const removalLogDates = new Map<string, Set<LocalDate>>();
  for (const { securityId, period } of tradeable) {
    if (period.endDate !== null && period.endLogDate === null) {
      const dates = removalLogDates.get(securityId) ?? new Set<LocalDate>();
      dates.add(addDays(period.endDate, 1));
      removalLogDates.set(securityId, dates);
    }
  }

  const bySecurity = new Map<
    string,
    { ranges: BuyWindowRange[]; keys: string[] }
  >();
  for (const {
    securityId,
    constituentKey,
    period,
    securityFrom,
  } of tradeable) {
    if (period.endDate !== null && period.endDate < floor) {
      continue;
    }
    if (
      securityFrom !== null &&
      period.endDate !== null &&
      period.endDate < securityFrom
    ) {
      continue;
    }
    const deferredFrom =
      period.startLogDate !== null &&
      period.startDate === addDays(period.startLogDate, 1)
        ? period.startLogDate
        : null;
    const start =
      deferredFrom !== null &&
      removalLogDates.get(securityId)?.has(deferredFrom)
        ? deferredFrom
        : period.startDate;
    const clipped =
      securityFrom !== null && (start === null || start < securityFrom)
        ? securityFrom
        : start;
    const startDate = clipped === null || clipped < floor ? floor : clipped;
    const entry = bySecurity.get(securityId) ?? { ranges: [], keys: [] };
    entry.ranges.push({ startDate, endDate: period.endDate });
    if (!entry.keys.includes(constituentKey)) {
      entry.keys.push(constituentKey);
    }
    bySecurity.set(securityId, entry);
  }
  return [...bySecurity.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([securityId, entry]) => ({
      securityId,
      ranges: normalizeBuyWindowRanges(entry.ranges),
      constituentKeys: [...entry.keys].sort(),
    }));
}

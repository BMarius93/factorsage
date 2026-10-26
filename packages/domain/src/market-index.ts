/**
 * Point-in-time index universes: a built-in Stock List whose membership is reconstructed from a
 * provider's index history rather than typed in (`docs/decisions/sp500-historical-pit-v1.md`).
 *
 * The product model does not change. A point-in-time universe is an ordinary SYSTEM-owned List whose
 * members carry `CUSTOM` buy windows — one window per period the security was an index member — so a
 * backtest buys a security only while it was a member, exactly as `isBuyWindowEligible` already
 * says, and never force-sells it when it leaves. What is new is where the windows come from: the
 * canonical membership dataset in PostgreSQL, projected into the List by the index synchronization,
 * never by an editor.
 *
 * This module holds only what every process must agree on: which universes exist, which List each
 * one is, and how big a universe is for an entitlement — which is the most members it held **at
 * once** inside a period, never the number of distinct securities it held across thirty years.
 */

import type { BuyWindowConfiguration } from "./stock-lists.js";
import type { LocalDate } from "./stock-data.js";

/** The indices whose historical membership FactorSage reconstructs. */
export const MARKET_INDEX_KEYS = ["SP500"] as const;

export type MarketIndexKey = (typeof MARKET_INDEX_KEYS)[number];

export function isMarketIndexKey(value: unknown): value is MarketIndexKey {
  return (
    typeof value === "string" &&
    (MARKET_INDEX_KEYS as readonly string[]).includes(value)
  );
}

/** One point-in-time index universe and the built-in List that carries it. */
export type PointInTimeIndexUniverse = {
  readonly indexKey: MarketIndexKey;
  /** The index's own product name — `S&P 500` — as a description of the universe names it. */
  readonly indexName: string;
  /** The built-in List's immutable `systemKey`. */
  readonly listSystemKey: string;
  readonly listName: string;
  readonly listDescription: string;
  /**
   * The earliest date the List's membership is projected from. A member that joined the index
   * before it is a member from this date in the List: the List is a statement about the backtest
   * horizon, and no backtest can start earlier than the thirty-year product horizon anyway. The
   * canonical dataset keeps the provider's earlier history untouched.
   */
  readonly membershipFloor: LocalDate;
};

export const SP500_HISTORICAL_PIT_UNIVERSE: PointInTimeIndexUniverse = {
  indexKey: "SP500",
  indexName: "S&P 500",
  listSystemKey: "sp500-historical-pit",
  listName: "S&P 500 — Historical PIT",
  listDescription:
    "Every security that was an S&P 500 constituent since 1996, each eligible to buy only while it " +
    "was a member. Reconstructed from the data provider's index history. Former constituents the " +
    "provider holds no prices for cannot be traded and are never substituted: before about 2010 a " +
    "large share of past members is missing, so results over earlier years lean toward companies " +
    "that survived.",
  membershipFloor: "1996-01-02",
};

export const POINT_IN_TIME_INDEX_UNIVERSES: readonly PointInTimeIndexUniverse[] =
  [SP500_HISTORICAL_PIT_UNIVERSE];

/** The universe a built-in List carries, by its `systemKey`; `null` for every other List. */
export function pointInTimeIndexUniverseForList(
  systemKey: string | null | undefined,
): PointInTimeIndexUniverse | null {
  if (!systemKey) {
    return null;
  }
  return (
    POINT_IN_TIME_INDEX_UNIVERSES.find(
      (universe) => universe.listSystemKey === systemKey,
    ) ?? null
  );
}

export function pointInTimeIndexUniverse(
  indexKey: MarketIndexKey,
): PointInTimeIndexUniverse {
  const universe = POINT_IN_TIME_INDEX_UNIVERSES.find(
    (candidate) => candidate.indexKey === indexKey,
  );
  if (!universe) {
    throw new Error(`No point-in-time universe is defined for ${indexKey}`);
  }
  return universe;
}

/**
 * How a reconstructed membership period's boundaries are known.
 *
 * - `CONFIRMED`: both ends come from the provider — an addition and a removal in its change log, or
 *   an addition and the current constituent list.
 * - `START_BEFORE_LOG`: the security was already a member when the provider's change log begins, so
 *   the start is the log's own horizon, not an addition.
 * - `END_UNKNOWN`: the change log records the addition but no later removal, and the security is not
 *   a current constituent. The period's end cannot be reconstructed; such a period is never
 *   projected into a List, because an assumed end would invent membership.
 */
export const INDEX_MEMBERSHIP_PERIOD_QUALITIES = [
  "CONFIRMED",
  "START_BEFORE_LOG",
  "END_UNKNOWN",
] as const;

export type IndexMembershipPeriodQuality =
  (typeof INDEX_MEMBERSHIP_PERIOD_QUALITIES)[number];

/**
 * Whether a reconstructed constituent could be tied to a catalog `Security` whose prices the
 * provider holds for its membership.
 *
 * - `RESOLVED`: linked; the provider's price history covers its membership inside the List horizon.
 * - `RESOLVED_PARTIAL`: linked; the provider's history covers only part of that membership, so the
 *   security is tradeable only where prices exist.
 * - `NO_PROVIDER_DATA`: no candidate symbol has provider prices inside the membership — typically a
 *   company delisted long ago, or a ticker since reused by another issuer.
 * - `IDENTITY_REJECTED`: a candidate symbol has prices, but they demonstrably belong to another
 *   issuer (an implausible market capitalization for an index member, or a name that does not
 *   match); attaching them would silently trade the wrong company.
 * - `NOT_ADMISSIBLE`: a candidate has prices, but the catalog's admission rules refuse it (a fund,
 *   an unsupported exchange).
 * - `PENDING`: not resolved yet.
 *
 * Only `RESOLVED` and `RESOLVED_PARTIAL` constituents are projected into the List.
 */
export const INDEX_CONSTITUENT_RESOLUTIONS = [
  "RESOLVED",
  "RESOLVED_PARTIAL",
  "NO_PROVIDER_DATA",
  "IDENTITY_REJECTED",
  "NOT_ADMISSIBLE",
  "PENDING",
] as const;

export type IndexConstituentResolution =
  (typeof INDEX_CONSTITUENT_RESOLUTIONS)[number];

export function isTradeableIndexResolution(
  resolution: IndexConstituentResolution,
): boolean {
  return resolution === "RESOLVED" || resolution === "RESOLVED_PARTIAL";
}

/**
 * The most List members eligible to buy on any one date of `period`, and the first date it is
 * reached. This is the size of a point-in-time universe for an entitlement: a thirty-year S&P 500
 * backtest holds about 500 candidates on any date, although roughly twice as many distinct
 * securities pass through the index over the period.
 *
 * `FULL` counts as eligible on every date. Ranges are inclusive on both ends, as everywhere else.
 */
export function peakSimultaneousMembers(
  configurations: readonly BuyWindowConfiguration[],
  period: { readonly from: LocalDate; readonly to: LocalDate },
): { peak: number; date: LocalDate | null } {
  if (period.from > period.to) {
    return { peak: 0, date: null };
  }
  let always = 0;
  const deltas = new Map<LocalDate, number>();
  const add = (date: LocalDate, delta: number) => {
    deltas.set(date, (deltas.get(date) ?? 0) + delta);
  };
  for (const configuration of configurations) {
    if (configuration.mode === "FULL") {
      always += 1;
      continue;
    }
    for (const range of configuration.ranges) {
      const start =
        range.startDate > period.from ? range.startDate : period.from;
      const end =
        range.endDate === null || range.endDate > period.to
          ? period.to
          : range.endDate;
      if (start > end) {
        continue;
      }
      add(start, 1);
      add(nextDay(end), -1);
    }
  }
  let current = always;
  let peak = always;
  let peakDate: LocalDate | null = always > 0 ? period.from : null;
  for (const date of [...deltas.keys()].sort()) {
    if (date > period.to) {
      break;
    }
    current += deltas.get(date) as number;
    if (current > peak) {
      peak = current;
      peakDate = date;
    }
  }
  return { peak, date: peakDate };
}

function nextDay(date: LocalDate): LocalDate {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

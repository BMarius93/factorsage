import type {
  IndexConstituentResolution,
  LocalDate,
} from "@intrinsic/domain";
import { addDays } from "../dates.js";
import { issuerNameSimilarity } from "./names.js";
import type {
  ReconstructedConstituent,
  ReconstructedPeriod,
  SymbolChangeInput,
} from "./reconstruction.js";

/**
 * From a reconstructed constituent to the catalog security whose prices are its history
 * (`docs/decisions/sp500-historical-pit-v1.md` §4).
 *
 * A constituent is an issuer line in the index; a `Security` is a ticker the provider holds prices
 * for. Linking the two is the step where survivorship and identity errors would otherwise creep in,
 * so it is a decision over measured evidence, recorded with the evidence, and it refuses rather than
 * guesses:
 *
 * 1. **Candidates.** A current member's own symbol; otherwise the ticker the index removed it under,
 *    the tickers that issuer was renamed to afterwards (the provider's rename history, followed
 *    forward from the removal), and the other tickers it held while a member.
 * 2. **Prices inside the membership.** A candidate whose provider history holds no session inside
 *    the constituent's membership is not its history: either the company is gone from the provider,
 *    or the ticker has since been reused by another issuer (Wachovia's `WB` is Weibo's today).
 * 3. **Plausibility.** An index member is a large company. A candidate whose market capitalization
 *    on the first membership session is far below any index member's is another issuer that
 *    happens to hold the ticker the provider's log names (the log names one 1997 addition `PAR`,
 *    whose history is PAR Technology's, a company worth $76 million at the time). It is refused.
 * 4. **One security, one constituent at a time.** Two constituents that were members at the same
 *    time are two issuers. If both resolve to one security, the one the security's ticker named at
 *    the time keeps it and the other is refused, because one of them is being given the other's
 *    prices.
 *
 * Coverage decides `RESOLVED` against `RESOLVED_PARTIAL`; nothing here ever invents a price or a
 * session, and a constituent nobody can be resolved to stays visible in the report.
 */

/** A resolved constituent whose prices cover at least this share of its membership is `RESOLVED`. */
export const INDEX_RESOLUTION_FULL_COVERAGE = 0.9;

/**
 * Market capitalization below which a candidate cannot be the history of an issuer the index added
 * on or after the List horizon. No S&P 500 addition since 1996 has been anywhere near it.
 */
export const INDEX_ADDITION_MIN_MARKET_CAP = 500_000_000;

/**
 * The same floor for a member already in the index when the horizon begins, whose first observed
 * session may be years after it joined: lower, because a long-standing member may have shrunk.
 */
export const INDEX_LEGACY_MEMBER_MIN_MARKET_CAP = 100_000_000;

/** Forward renames followed from a removal, at most. */
const MAX_RENAME_STEPS = 6;

/** Sessions a year holds, against weekdays: holidays, so expected sessions are not overstated. */
const SESSIONS_PER_WEEKDAY = 252 / 261;

export type MembershipWindow = { from: LocalDate; to: LocalDate };

/**
 * A constituent's membership inside the List horizon: every period whose end is known, clipped to
 * `[floor, asOf]`. `END_UNKNOWN` periods are excluded — they are never projected, so they are never
 * resolved either.
 */
export function membershipWithinHorizon(
  periods: readonly Pick<ReconstructedPeriod, "startDate" | "endDate" | "quality">[],
  horizon: { floor: LocalDate; asOf: LocalDate },
): MembershipWindow[] {
  const windows: MembershipWindow[] = [];
  for (const period of periods) {
    if (period.quality === "END_UNKNOWN") {
      continue;
    }
    const from =
      period.startDate === null || period.startDate < horizon.floor
        ? horizon.floor
        : period.startDate;
    const to =
      period.endDate === null || period.endDate > horizon.asOf
        ? horizon.asOf
        : period.endDate;
    if (from <= to) {
      windows.push({ from, to });
    }
  }
  return windows.sort((left, right) => (left.from < right.from ? -1 : 1));
}

/** The tickers that may hold a constituent's history, most likely first. */
export function resolutionCandidates(
  constituent: Pick<
    ReconstructedConstituent,
    "origin" | "ticker" | "tickerHistory"
  >,
  lastMembershipDay: LocalDate,
  renames: readonly SymbolChangeInput[],
): string[] {
  if (constituent.origin === "CURRENT") {
    return [constituent.ticker];
  }
  const candidates: string[] = [constituent.ticker];
  // Forward through renames after the membership ended: the issuer may have kept trading, renamed.
  let ticker = constituent.ticker;
  let after = lastMembershipDay;
  for (let step = 0; step < MAX_RENAME_STEPS; step += 1) {
    const next = renames
      .filter((rename) => rename.oldSymbol === ticker && rename.date > after)
      .sort((left, right) =>
        left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
      )[0];
    if (!next || candidates.includes(next.newSymbol)) {
      break;
    }
    candidates.push(next.newSymbol);
    ticker = next.newSymbol;
    after = next.date;
  }
  for (const span of constituent.tickerHistory) {
    if (!candidates.includes(span.ticker)) {
      candidates.push(span.ticker);
    }
  }
  return candidates;
}

/** What probing one candidate symbol against one constituent's membership measured. */
export type CandidateEvidence = {
  readonly symbol: string;
  /** Sessions the provider holds inside the membership windows. */
  readonly sessionsInMembership: number;
  /** Sessions the membership windows should hold, estimated from weekdays. */
  readonly expectedSessions: number;
  readonly firstSessionInMembership: LocalDate | null;
  readonly lastSessionInMembership: LocalDate | null;
  /** Market capitalization on (or within two weeks after) the first membership session. */
  readonly marketCapAtFirstSession: number | null;
  /** The minimum the candidate had to meet, given how the membership began. */
  readonly marketCapFloor: number;
  /** The provider's or the directory's name for the candidate, when known. */
  readonly listingName: string | null;
  readonly nameSimilarity: number;
  /** Why the candidate was refused, or null when it was usable. */
  readonly refusal: "NO_PRICES_IN_MEMBERSHIP" | "IMPLAUSIBLE_MARKET_CAP" | null;
};

export type ConstituentResolutionDecision = {
  readonly resolution: IndexConstituentResolution;
  /** The chosen candidate, for `RESOLVED`/`RESOLVED_PARTIAL`. */
  readonly symbol: string | null;
  readonly coverage: number | null;
  readonly candidates: readonly CandidateEvidence[];
  readonly reason: string;
};

/** Weekday count of an inclusive window, times the session share of weekdays. */
export function expectedSessions(windows: readonly MembershipWindow[]): number {
  let weekdays = 0;
  for (const window of windows) {
    let day = window.from;
    // Whole weeks at a time, then the remainder: O(weeks), not O(days).
    const start = Date.parse(`${window.from}T00:00:00Z`);
    const end = Date.parse(`${window.to}T00:00:00Z`);
    const days = Math.round((end - start) / 86_400_000) + 1;
    const weeks = Math.floor(days / 7);
    weekdays += weeks * 5;
    day = addDays(window.from, weeks * 7);
    for (let index = weeks * 7; index < days; index += 1) {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        weekdays += 1;
      }
      day = addDays(day, 1);
    }
  }
  return Math.round(weekdays * SESSIONS_PER_WEEKDAY);
}

/** Decides one constituent from its candidates' evidence, in candidate order. */
export function decideConstituentResolution(
  candidates: readonly CandidateEvidence[],
): ConstituentResolutionDecision {
  const usable = candidates.find((candidate) => candidate.refusal === null);
  if (usable) {
    const coverage =
      usable.expectedSessions === 0
        ? 1
        : Math.min(1, usable.sessionsInMembership / usable.expectedSessions);
    return {
      resolution:
        coverage >= INDEX_RESOLUTION_FULL_COVERAGE
          ? "RESOLVED"
          : "RESOLVED_PARTIAL",
      symbol: usable.symbol,
      coverage,
      candidates,
      reason:
        coverage >= INDEX_RESOLUTION_FULL_COVERAGE
          ? `prices cover ${percent(coverage)} of the membership`
          : `prices cover only ${percent(coverage)} of the membership, from ${usable.firstSessionInMembership} to ${usable.lastSessionInMembership}`,
    };
  }
  const implausible = candidates.find(
    (candidate) => candidate.refusal === "IMPLAUSIBLE_MARKET_CAP",
  );
  if (implausible) {
    return {
      resolution: "IDENTITY_REJECTED",
      symbol: null,
      coverage: null,
      candidates,
      reason: `${implausible.symbol} has prices for the membership, but a market capitalization of ${formatMoney(implausible.marketCapAtFirstSession)} on ${implausible.firstSessionInMembership}, below the ${formatMoney(implausible.marketCapFloor)} any index member had: they belong to another issuer`,
    };
  }
  return {
    resolution: "NO_PROVIDER_DATA",
    symbol: null,
    coverage: null,
    candidates,
    reason:
      candidates.length === 0
        ? "no candidate symbol"
        : `the provider holds no prices inside the membership under ${candidates.map((candidate) => candidate.symbol).join(", ")}`,
  };
}

/** A resolved constituent, as the overlap check needs it. */
export type ResolvedConstituentClaim = {
  readonly constituentKey: string;
  readonly symbol: string;
  readonly windows: readonly MembershipWindow[];
  /** Whether the symbol was the constituent's own ticker at its last membership event. */
  readonly ownTicker: boolean;
  readonly nameSimilarity: number;
  readonly coverage: number;
};

export type OverlapConflict = {
  readonly symbol: string;
  readonly kept: string;
  readonly refused: string;
  readonly overlap: MembershipWindow;
};

/**
 * Constituents that were members at the same time and claim the same security. The claim that keeps
 * it: the one whose own ticker is the symbol, then the closer name, then the better coverage, then
 * the lower key (deterministic). Every other overlapping claim is refused.
 */
export function overlappingClaims(
  claims: readonly ResolvedConstituentClaim[],
): OverlapConflict[] {
  const bySymbol = new Map<string, ResolvedConstituentClaim[]>();
  for (const claim of claims) {
    const group = bySymbol.get(claim.symbol);
    if (group) {
      group.push(claim);
    } else {
      bySymbol.set(claim.symbol, [claim]);
    }
  }
  const conflicts: OverlapConflict[] = [];
  for (const [symbol, group] of [...bySymbol.entries()].sort()) {
    if (group.length < 2) {
      continue;
    }
    const ranked = [...group].sort(
      (left, right) =>
        Number(right.ownTicker) - Number(left.ownTicker) ||
        right.nameSimilarity - left.nameSimilarity ||
        right.coverage - left.coverage ||
        (left.constituentKey < right.constituentKey ? -1 : 1),
    );
    const kept: ResolvedConstituentClaim[] = [];
    for (const claim of ranked) {
      const clash = kept
        .map((winner) => ({ winner, overlap: firstOverlap(winner.windows, claim.windows) }))
        .find((entry) => entry.overlap !== null);
      if (clash) {
        conflicts.push({
          symbol,
          kept: clash.winner.constituentKey,
          refused: claim.constituentKey,
          overlap: clash.overlap as MembershipWindow,
        });
      } else {
        kept.push(claim);
      }
    }
  }
  return conflicts;
}

function firstOverlap(
  left: readonly MembershipWindow[],
  right: readonly MembershipWindow[],
): MembershipWindow | null {
  for (const a of left) {
    for (const b of right) {
      const from = a.from > b.from ? a.from : b.from;
      const to = a.to < b.to ? a.to : b.to;
      if (from <= to) {
        return { from, to };
      }
    }
  }
  return null;
}

/** Sessions of `dates` (ascending) inside the windows, with the first and last one. */
export function sessionsWithin(
  dates: readonly LocalDate[],
  windows: readonly MembershipWindow[],
): { count: number; first: LocalDate | null; last: LocalDate | null } {
  let count = 0;
  let first: LocalDate | null = null;
  let last: LocalDate | null = null;
  for (const date of dates) {
    if (windows.some((window) => window.from <= date && date <= window.to)) {
      count += 1;
      first ??= date;
      last = date;
    }
  }
  return { count, first, last };
}

/** The candidate's name evidence against the constituent's. */
export function nameEvidence(
  constituentName: string,
  listingName: string | null,
): number {
  return Math.round(issuerNameSimilarity(constituentName, listingName) * 1000) / 1000;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatMoney(value: number | null): string {
  if (value === null) {
    return "an unknown value";
  }
  return value >= 1e9
    ? `$${(value / 1e9).toFixed(2)}B`
    : `$${Math.round(value / 1e6)}M`;
}

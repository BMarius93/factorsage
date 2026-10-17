import type {
  IndexMembershipPeriodQuality,
  LocalDate,
} from "@intrinsic/domain";
import { addDays } from "../dates.js";
import { issuerNameSimilarity } from "./names.js";

/**
 * Point-in-time index membership, reconstructed from the provider's records
 * (`docs/decisions/sp500-historical-pit-v1.md`).
 *
 * Pure and deterministic: the same current list, change log and rename history always produce the
 * same constituents, periods and anomalies, in the same order, so a reconstruction can be repeated
 * from what PostgreSQL stored and two synchronizations of the same source are provably equal.
 *
 * **Method: a backward walk from today.** The provider's current constituent list is the one fully
 * known state. Walking its change log from the newest effective date to the oldest undoes each
 * change — before an addition took effect the added issuer was not a member, before a removal took
 * effect the removed one was — so the membership on every earlier date follows from today's. No
 * period is ever assumed: a period exists only between an addition and a removal the provider
 * recorded, or the current list.
 *
 * **Identity, not tickers.** The change log names issuers by ticker, and tickers move: Facebook
 * joined as FB and is a member today as META; AT&T Inc. was SBC until it took the ticker T from the
 * AT&T Corp. it acquired, which the index removed on the same day. So every constituent being walked
 * carries its own ticker, and the provider's rename history is undone along the way (META becomes FB
 * before 2022-06-09). An addition is matched to the member it added in three tiers, and the tier is
 * recorded on the period:
 *
 * 1. `EXACT_TICKER` — the member holding that ticker on that date;
 * 2. `TICKER_HISTORY` — the member that held that ticker at some time (the provider's log often
 *    names an issuer by a later ticker: Fiserv's 2001 addition reads `FI`, a ticker it held only
 *    from 2023 to 2025);
 * 3. `NAME` — the one member whose name matches the addition's (similarity ≥ 0.85).
 *
 * An addition that matches nobody was never removed according to the log and is not a member today.
 * Its period is `END_UNKNOWN` and is reported, never projected: assuming an end would invent
 * membership. Ambiguities and ticker collisions are reported as anomalies with what was chosen.
 *
 * **Dates.** The provider records no announcement date, and its change log's date for a change is
 * either the effective date or — about three times in four where the current list lets it be
 * checked — the rebalancing session before it ({@link FIRST_ADDED_REFINEMENT_DAYS}). A period's
 * `startDate` is the first day the index certainly held the issuer: the effective date where the
 * current list establishes it, otherwise the day after the log's date (an addition never starts
 * before the index held the issuer, at the price of one session when the log's date was already
 * effective). Its `endDate` is inclusive, the calendar day before the removal's date — the index no
 * longer held the issuer from that day's open, or held it one session longer. Membership is
 * therefore never claimed for a session the provider's records leave in doubt; at a boundary the
 * log cannot place exactly, it may be one session short. (Where both of the provider's records name
 * the rebalancing session — Amazon's 2005 addition is dated 2005-11-18 in both, effective
 * 2005-11-21 — nothing in the data can tell, and the start is that one session early.) Changes
 * dated after `asOf` have not happened yet and are reported, not applied.
 */
export const INDEX_RECONSTRUCTION_ALGORITHM_VERSION = 2;

/** A name match must be at least this similar to count as tier-3 evidence. */
export const INDEX_NAME_MATCH_THRESHOLD = 0.85;

/**
 * How many calendar days after the change log's date the current list's first-added date may fall
 * and still be read as the same change's effective date.
 *
 * The provider has two dates for a current member's addition, and they often disagree by exactly
 * one session: the change log names the session **before** the effective date — the rebalancing
 * close, a Friday when the change took effect on a Monday — while the current list's
 * `dateFirstAdded` is the effective date (Uber: log 2023-12-15, effective 2023-12-18; Tesla: log
 * 2020-12-18, effective 2020-12-21). Measured on 2026-10-17 over the 915 log dates that add an
 * issuer: 221 are refined (a current member's first-added date one to four days later, nothing
 * contradicting it), 70 are confirmed (a current member added on the date itself; two of them also
 * contradicted, and reported) and 624 are unconfirmed — 623 with no current member to speak for
 * them, one whose members disagree.
 *
 * Where a log date has that evidence and nothing contradicts it — no current member added on the
 * log date itself, no second candidate date — **every** change on that log date takes effect on the
 * refined date, additions and removals alike, because a replacement's two sides take effect
 * together. A log date a current member's first-added date equals is **confirmed**: both of the
 * provider's records agree on it, and it is taken as the effective date.
 * Every other log date — no current member's addition speaks for it, or the evidence contradicts
 * itself (`EFFECTIVE_DATE_CONFLICT`, reported) — may name either session, so its additions start the
 * day after it ({@link reconstructIndexMembership}'s "Dates"). The log's own date is kept beside
 * every boundary that moved away from it.
 */
export const FIRST_ADDED_REFINEMENT_DAYS = 4;

export type CurrentConstituentInput = {
  readonly symbol: string;
  readonly name: string;
  readonly cik: string | null;
  readonly dateFirstAdded: LocalDate | null;
};

export type IndexChangeInput = {
  readonly contentHash: string;
  readonly effectiveDate: LocalDate;
  readonly addedTicker: string | null;
  readonly addedName: string | null;
  readonly removedTicker: string | null;
  readonly removedName: string | null;
};

export type SymbolChangeInput = {
  readonly date: LocalDate;
  readonly oldSymbol: string;
  readonly newSymbol: string;
};

export type ReconstructionInput = {
  readonly current: readonly CurrentConstituentInput[];
  readonly changes: readonly IndexChangeInput[];
  readonly symbolChanges: readonly SymbolChangeInput[];
  /** The date the current list describes. */
  readonly asOf: LocalDate;
};

export type AdditionMatch = "EXACT_TICKER" | "TICKER_HISTORY" | "NAME";

export type ReconstructedPeriod = {
  /** First day of membership; null when the issuer was a member before the change log begins. */
  readonly startDate: LocalDate | null;
  /**
   * The change log's own date for the addition, kept when `startDate` moved away from it — refined
   * to the effective date, or deferred to the next day because nothing confirms the log's date (see
   * {@link FIRST_ADDED_REFINEMENT_DAYS}); null when the log's date is the start.
   */
  readonly startLogDate: LocalDate | null;
  /** Last day of membership, inclusive; null while a member, or when the end is unknown. */
  readonly endDate: LocalDate | null;
  /**
   * The end the change log's own date would give (the day before it), kept when `endDate` was
   * refined with the rest of its log date; null when the log's date is the end.
   */
  readonly endLogDate: LocalDate | null;
  readonly quality: IndexMembershipPeriodQuality;
  readonly startChangeHash: string | null;
  readonly endChangeHash: string | null;
  readonly startMatch: AdditionMatch | null;
};

export type ConstituentOrigin = "CURRENT" | "REMOVAL" | "ORPHAN_ADDITION";

/** One ticker a constituent held, and from when to when as far as the rename history says. */
export type TickerSpan = {
  readonly ticker: string;
  /** First day under this ticker; null when it predates every rename seen. */
  readonly from: LocalDate | null;
  /** Last day under this ticker, inclusive; null when it is the latest. */
  readonly to: LocalDate | null;
};

export type ReconstructedConstituent = {
  /** Stable key: `CURRENT:<symbol>`, `REMOVAL:<change hash>` or `ADDITION:<change hash>`. */
  readonly constituentKey: string;
  readonly origin: ConstituentOrigin;
  /** The ticker at the constituent's most recent index event. */
  readonly ticker: string;
  readonly name: string;
  readonly cik: string | null;
  /** Newest first. */
  readonly tickerHistory: readonly TickerSpan[];
  readonly periods: readonly ReconstructedPeriod[];
};

export type ReconstructionAnomaly =
  | {
      readonly kind: "ORPHAN_ADDITION";
      readonly date: LocalDate;
      readonly ticker: string;
      readonly name: string | null;
      readonly changeHash: string;
    }
  | {
      readonly kind: "AMBIGUOUS_ADDITION";
      readonly date: LocalDate;
      readonly ticker: string;
      readonly name: string | null;
      readonly tier: AdditionMatch;
      readonly candidates: readonly string[];
      readonly chosen: string;
      readonly changeHash: string;
    }
  | {
      readonly kind: "TICKER_COLLISION";
      readonly date: LocalDate;
      readonly ticker: string;
      readonly removedName: string | null;
      readonly activeConstituents: readonly string[];
      readonly changeHash: string;
    }
  | {
      readonly kind: "FUTURE_CHANGE";
      readonly date: LocalDate;
      readonly changeHash: string;
    }
  | {
      readonly kind: "EFFECTIVE_DATE_CONFLICT";
      readonly date: LocalDate;
      /** The first-added dates current members' additions on this log date point to. */
      readonly candidates: readonly LocalDate[];
      /** Whether a current member's first-added date equals the log date itself. */
      readonly logDateConfirmed: boolean;
    }
  | {
      readonly kind: "FIRST_ADDED_MISMATCH";
      readonly ticker: string;
      readonly providerDateFirstAdded: LocalDate;
      readonly reconstructedStart: LocalDate | null;
    }
  | {
      /**
       * An addition removed again before the first day the index certainly held it: no session of
       * membership can be established, so no period is recorded.
       */
      readonly kind: "NO_CONFIRMED_SESSION";
      readonly date: LocalDate;
      readonly ticker: string;
      readonly changeHash: string;
    };

export type ReconstructionResult = {
  readonly algorithmVersion: number;
  /** The oldest effective date in the change log: before it, nothing was reconstructed. */
  readonly logStart: LocalDate | null;
  /**
   * How every applied addition's start was placed: on a date the current list refined or
   * confirmed, or deferred to the day after an unconfirmed log date.
   */
  readonly additionStarts: {
    readonly refined: number;
    readonly confirmed: number;
    readonly deferred: number;
  };
  readonly constituents: readonly ReconstructedConstituent[];
  readonly anomalies: readonly ReconstructionAnomaly[];
};

type Walker = {
  readonly key: string;
  readonly origin: ConstituentOrigin;
  readonly name: string;
  readonly cik: string | null;
  readonly latestTicker: string;
  ticker: string;
  /** Every ticker seen, newest first, with the date each one began (the rename's date). */
  readonly spans: { ticker: string; from: LocalDate | null }[];
  readonly knownTickers: Set<string>;
  /** The open period's end while the walker is a member (walking backward). */
  openEnd: LocalDate | null;
  openEndLogDate: LocalDate | null;
  openEndHash: string | null;
  openQuality: IndexMembershipPeriodQuality;
  readonly periods: ReconstructedPeriod[];
};

export function reconstructIndexMembership(
  input: ReconstructionInput,
): ReconstructionResult {
  const anomalies: ReconstructionAnomaly[] = [];
  const additionStarts = { refined: 0, confirmed: 0, deferred: 0 };
  const walkers: Walker[] = [];
  let active: Walker[] = [];

  const byDate = <T>(rows: readonly T[], dateOf: (row: T) => LocalDate) => {
    const grouped = new Map<LocalDate, T[]>();
    for (const row of rows) {
      const date = dateOf(row);
      const group = grouped.get(date);
      if (group) {
        group.push(row);
      } else {
        grouped.set(date, [row]);
      }
    }
    return grouped;
  };

  // Determinism: inputs are processed in a canonical order whatever order they arrived in.
  const refinement = refineEffectiveDates(
    dedupeChanges(input.changes),
    input.current,
    input.symbolChanges,
  );
  for (const conflict of refinement.conflicts) {
    anomalies.push({ kind: "EFFECTIVE_DATE_CONFLICT", ...conflict });
  }
  const changes = dedupeChanges(input.changes).map((change): EffectiveChange => {
    const refined = refinement.refined.get(change.effectiveDate);
    return {
      ...change,
      logDate: change.effectiveDate,
      effectiveDate: refined ?? change.effectiveDate,
      startConfirmed:
        refined !== undefined || refinement.confirmed.has(change.effectiveDate),
    };
  });
  const future = changes.filter((change) => change.effectiveDate > input.asOf);
  for (const change of future) {
    anomalies.push({
      kind: "FUTURE_CHANGE",
      date: change.effectiveDate,
      changeHash: change.contentHash,
    });
  }
  const applied = changes.filter((change) => change.effectiveDate <= input.asOf);
  const changesByDate = byDate(applied, (change) => change.effectiveDate);
  const renamesByDate = byDate(
    [...input.symbolChanges]
      .filter((rename) => rename.date <= input.asOf)
      .sort(compareRenames),
    (rename) => rename.date,
  );
  const dates = [...new Set([...changesByDate.keys(), ...renamesByDate.keys()])]
    .sort()
    .reverse();
  const logStart =
    applied.length === 0
      ? null
      : applied.reduce(
          (oldest, change) =>
            change.effectiveDate < oldest ? change.effectiveDate : oldest,
          applied[0]?.effectiveDate as LocalDate,
        );

  for (const member of [...input.current].sort((left, right) =>
    compareText(left.symbol, right.symbol),
  )) {
    const walker = newWalker({
      key: `CURRENT:${member.symbol}`,
      origin: "CURRENT",
      ticker: member.symbol,
      name: member.name,
      cik: member.cik,
      openEnd: null,
      openEndLogDate: null,
      openEndHash: null,
    });
    walkers.push(walker);
    active.push(walker);
  }

  for (const date of dates) {
    const dayChanges = changesByDate.get(date) ?? [];

    // 1. Before an addition took effect, the added issuer was not a member.
    for (const change of dayChanges) {
      if (!change.addedTicker) {
        continue;
      }
      if (!change.startConfirmed) {
        additionStarts.deferred += 1;
      } else if (change.effectiveDate !== change.logDate) {
        additionStarts.refined += 1;
      } else {
        additionStarts.confirmed += 1;
      }
      const match = matchAddition(active, change, anomalies);
      if (!match) {
        anomalies.push({
          kind: "ORPHAN_ADDITION",
          date,
          ticker: change.addedTicker,
          name: change.addedName,
          changeHash: change.contentHash,
        });
        const orphan = newWalker({
          key: `ADDITION:${change.contentHash}`,
          origin: "ORPHAN_ADDITION",
          ticker: change.addedTicker,
          name: change.addedName ?? change.addedTicker,
          cik: null,
          openEnd: null,
          openEndLogDate: null,
          openEndHash: null,
        });
        const orphanStart = additionStart(change);
        orphan.periods.push({
          startDate: orphanStart,
          startLogDate: change.logDate === orphanStart ? null : change.logDate,
          endDate: null,
          endLogDate: null,
          quality: "END_UNKNOWN",
          startChangeHash: change.contentHash,
          endChangeHash: null,
          startMatch: null,
        });
        walkers.push(orphan);
        continue;
      }
      const start = additionStart(change);
      if (match.walker.openEnd !== null && start > match.walker.openEnd) {
        anomalies.push({
          kind: "NO_CONFIRMED_SESSION",
          date,
          ticker: change.addedTicker,
          changeHash: change.contentHash,
        });
      } else {
        match.walker.periods.push({
          startDate: start,
          startLogDate: change.logDate === start ? null : change.logDate,
          endDate: match.walker.openEnd,
          endLogDate: match.walker.openEndLogDate,
          quality: match.walker.openQuality,
          startChangeHash: change.contentHash,
          endChangeHash: match.walker.openEndHash,
          startMatch: match.tier,
        });
      }
      active = active.filter((walker) => walker !== match.walker);
    }

    // 2. Before a rename took effect, the renamed issuer traded under its old ticker.
    for (const rename of renamesByDate.get(date) ?? []) {
      for (const walker of active) {
        if (walker.ticker === rename.newSymbol) {
          walker.ticker = rename.oldSymbol;
          walker.knownTickers.add(rename.oldSymbol);
          const newest = walker.spans[walker.spans.length - 1];
          if (newest) {
            newest.from = date;
          }
          walker.spans.push({ ticker: rename.oldSymbol, from: null });
        }
      }
    }

    // 3. Before a removal took effect, the removed issuer was a member.
    for (const change of dayChanges) {
      if (!change.removedTicker) {
        continue;
      }
      const holders = active.filter(
        (walker) => walker.ticker === change.removedTicker,
      );
      if (holders.length > 0) {
        anomalies.push({
          kind: "TICKER_COLLISION",
          date,
          ticker: change.removedTicker,
          removedName: change.removedName,
          activeConstituents: holders.map((walker) => walker.key),
          changeHash: change.contentHash,
        });
      }
      const removed = newWalker({
        key: `REMOVAL:${change.contentHash}`,
        origin: "REMOVAL",
        ticker: change.removedTicker,
        name: change.removedName ?? change.removedTicker,
        cik: null,
        openEnd: addDays(date, -1),
        openEndLogDate:
          change.logDate === date ? null : addDays(change.logDate, -1),
        openEndHash: change.contentHash,
      });
      walkers.push(removed);
      active.push(removed);
    }
  }

  // Whoever is still a member when the log runs out was one before it began.
  for (const walker of active) {
    walker.periods.push({
      startDate: null,
      startLogDate: null,
      endDate: walker.openEnd,
      endLogDate: walker.openEndLogDate,
      quality: "START_BEFORE_LOG",
      startChangeHash: null,
      endChangeHash: walker.openEndHash,
      startMatch: null,
    });
  }

  // A walker whose only stint no session confirms (`NO_CONFIRMED_SESSION`) was never a member.
  const constituents = walkers
    .filter((walker) => walker.periods.length > 0)
    .map(toConstituent)
    .sort((left, right) => compareText(left.constituentKey, right.constituentKey));

  for (const member of input.current) {
    if (!member.dateFirstAdded) {
      continue;
    }
    const constituent = constituents.find(
      (candidate) => candidate.constituentKey === `CURRENT:${member.symbol}`,
    );
    const start = constituent?.periods[0]?.startDate ?? null;
    // A member since before the log cannot contradict a first-added date that also predates it.
    const comparable = start !== null || (logStart !== null && member.dateFirstAdded >= logStart);
    if (comparable && start !== member.dateFirstAdded) {
      anomalies.push({
        kind: "FIRST_ADDED_MISMATCH",
        ticker: member.symbol,
        providerDateFirstAdded: member.dateFirstAdded,
        reconstructedStart: start,
      });
    }
  }

  return {
    algorithmVersion: INDEX_RECONSTRUCTION_ALGORITHM_VERSION,
    logStart,
    additionStarts,
    constituents,
    anomalies: anomalies.sort(compareAnomalies),
  };
}

function newWalker(input: {
  key: string;
  origin: ConstituentOrigin;
  ticker: string;
  name: string;
  cik: string | null;
  openEnd: LocalDate | null;
  openEndLogDate: LocalDate | null;
  openEndHash: string | null;
}): Walker {
  return {
    key: input.key,
    origin: input.origin,
    name: input.name,
    cik: input.cik,
    latestTicker: input.ticker,
    ticker: input.ticker,
    spans: [{ ticker: input.ticker, from: null }],
    knownTickers: new Set([input.ticker]),
    openEnd: input.openEnd,
    openEndLogDate: input.openEndLogDate,
    openEndHash: input.openEndHash,
    openQuality: "CONFIRMED",
    periods: [],
  };
}

/**
 * A change with its effective date refined; `logDate` is the date the provider's log gives, and
 * `startConfirmed` whether the current list establishes `effectiveDate` as the effective date.
 */
type EffectiveChange = IndexChangeInput & {
  readonly logDate: LocalDate;
  readonly startConfirmed: boolean;
};

/**
 * The first day the index certainly held an addition: its effective date where the current list
 * establishes it, otherwise the day after the log's date, which names either the effective session
 * or the one before it.
 */
function additionStart(change: EffectiveChange): LocalDate {
  return change.startConfirmed
    ? change.effectiveDate
    : addDays(change.effectiveDate, 1);
}

/**
 * Per log date, the effective date the current list's first-added dates establish for it
 * ({@link FIRST_ADDED_REFINEMENT_DAYS}), and the log dates whose evidence disagrees.
 */
export function refineEffectiveDates(
  changes: readonly IndexChangeInput[],
  current: readonly CurrentConstituentInput[],
  symbolChanges: readonly SymbolChangeInput[] = [],
): {
  refined: Map<LocalDate, LocalDate>;
  /** Log dates a current member's first-added date equals: both provider records agree on them. */
  confirmed: ReadonlySet<LocalDate>;
  conflicts: { date: LocalDate; candidates: LocalDate[]; logDateConfirmed: boolean }[];
} {
  const firstAdded = new Map<string, LocalDate>();
  for (const member of current) {
    if (member.dateFirstAdded) {
      firstAdded.set(member.symbol, member.dateFirstAdded);
    }
  }
  // An addition is evidence for its log date when its ticker is a current member's, or — when no
  // current member holds it — leads to one through the renames after that date (Bank of New York
  // Mellon was added as BK and is BNY today). A ticker a current member holds is never chained: the
  // rename history is global and tickers are reused (an ETF traded as META until 2022), so a chain
  // from a held ticker can wander to another issuer.
  const currentSymbols = new Set(current.map((member) => member.symbol));
  const renamesByOld = new Map<string, SymbolChangeInput[]>();
  for (const rename of [...symbolChanges].sort(compareRenames)) {
    const list = renamesByOld.get(rename.oldSymbol) ?? [];
    list.push(rename);
    renamesByOld.set(rename.oldSymbol, list);
  }
  const candidates = new Map<LocalDate, Set<LocalDate>>();
  const confirmed = new Set<LocalDate>();
  for (const change of changes) {
    const ticker = change.addedTicker;
    const added =
      ticker === null
        ? undefined
        : firstAdded.get(
            currentSymbols.has(ticker)
              ? ticker
              : tickerToday(ticker, change.effectiveDate, renamesByOld),
          );
    if (!added) {
      continue;
    }
    const days = Math.round(
      (Date.parse(`${added}T00:00:00Z`) - Date.parse(`${change.effectiveDate}T00:00:00Z`)) /
        86_400_000,
    );
    if (days === 0) {
      confirmed.add(change.effectiveDate);
    } else if (days >= 1 && days <= FIRST_ADDED_REFINEMENT_DAYS) {
      const set = candidates.get(change.effectiveDate) ?? new Set<LocalDate>();
      set.add(added);
      candidates.set(change.effectiveDate, set);
    }
  }
  const refined = new Map<LocalDate, LocalDate>();
  const conflicts: { date: LocalDate; candidates: LocalDate[]; logDateConfirmed: boolean }[] = [];
  for (const [date, set] of [...candidates.entries()].sort()) {
    const values = [...set].sort();
    if (values.length === 1 && !confirmed.has(date)) {
      refined.set(date, values[0] as LocalDate);
    } else {
      conflicts.push({ date, candidates: values, logDateConfirmed: confirmed.has(date) });
    }
  }
  return { refined, confirmed, conflicts };
}

/**
 * The ticker an issuer that held `ticker` on `date` trades under today, following the renames after
 * that date in order. Bounded, so a cycle in the provider's rename history cannot loop.
 */
function tickerToday(
  ticker: string,
  date: LocalDate,
  renamesByOld: ReadonlyMap<string, readonly SymbolChangeInput[]>,
): string {
  let symbol = ticker;
  let since = date;
  for (let hop = 0; hop < 16; hop += 1) {
    const next = renamesByOld.get(symbol)?.find((rename) => rename.date > since);
    if (!next) {
      break;
    }
    symbol = next.newSymbol;
    since = next.date;
  }
  return symbol;
}

function matchAddition(
  active: readonly Walker[],
  change: IndexChangeInput,
  anomalies: ReconstructionAnomaly[],
): { walker: Walker; tier: AdditionMatch } | null {
  const ticker = change.addedTicker as string;
  const tiers: [AdditionMatch, Walker[]][] = [
    ["EXACT_TICKER", active.filter((walker) => walker.ticker === ticker)],
    [
      "TICKER_HISTORY",
      active.filter((walker) => walker.knownTickers.has(ticker)),
    ],
    [
      "NAME",
      active.filter(
        (walker) =>
          issuerNameSimilarity(walker.name, change.addedName) >=
          INDEX_NAME_MATCH_THRESHOLD,
      ),
    ],
  ];
  for (const [tier, candidates] of tiers) {
    if (candidates.length === 0) {
      continue;
    }
    // The best name match among the tier's candidates, then the lowest key: deterministic.
    const ranked = [...candidates].sort((left, right) => {
      const score =
        issuerNameSimilarity(right.name, change.addedName) -
        issuerNameSimilarity(left.name, change.addedName);
      return score !== 0 ? score : compareText(left.key, right.key);
    });
    const chosen = ranked[0] as Walker;
    if (candidates.length > 1) {
      anomalies.push({
        kind: "AMBIGUOUS_ADDITION",
        date: change.effectiveDate,
        ticker,
        name: change.addedName,
        tier,
        candidates: ranked.map((walker) => walker.key),
        chosen: chosen.key,
        changeHash: change.contentHash,
      });
    }
    return { walker: chosen, tier };
  }
  return null;
}

function toConstituent(walker: Walker): ReconstructedConstituent {
  // Spans were collected newest first; each one's end is the day before the newer one began.
  const tickerHistory: TickerSpan[] = walker.spans.map((span, index) => {
    const newer = index === 0 ? null : (walker.spans[index - 1] ?? null);
    return {
      ticker: span.ticker,
      from: span.from,
      to: newer?.from ? addDays(newer.from, -1) : null,
    };
  });
  return {
    constituentKey: walker.key,
    origin: walker.origin,
    ticker: walker.latestTicker,
    name: walker.name,
    cik: walker.cik,
    tickerHistory,
    // Oldest period first.
    periods: [...walker.periods].sort((left, right) =>
      compareNullableDates(left.startDate, right.startDate),
    ),
  };
}

function dedupeChanges(
  changes: readonly IndexChangeInput[],
): IndexChangeInput[] {
  const seen = new Map<string, IndexChangeInput>();
  for (const change of changes) {
    if (!seen.has(change.contentHash)) {
      seen.set(change.contentHash, change);
    }
  }
  return [...seen.values()].sort((left, right) =>
    left.effectiveDate !== right.effectiveDate
      ? compareText(left.effectiveDate, right.effectiveDate)
      : compareText(left.contentHash, right.contentHash),
  );
}

function compareRenames(left: SymbolChangeInput, right: SymbolChangeInput): number {
  return (
    compareText(left.date, right.date) ||
    compareText(left.newSymbol, right.newSymbol) ||
    compareText(left.oldSymbol, right.oldSymbol)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Null (before the log) sorts first. */
function compareNullableDates(
  left: LocalDate | null,
  right: LocalDate | null,
): number {
  if (left === right) {
    return 0;
  }
  if (left === null) {
    return -1;
  }
  if (right === null) {
    return 1;
  }
  return compareText(left, right);
}

function compareAnomalies(
  left: ReconstructionAnomaly,
  right: ReconstructionAnomaly,
): number {
  const leftDate = "date" in left ? left.date : "";
  const rightDate = "date" in right ? right.date : "";
  return (
    compareText(left.kind, right.kind) ||
    compareText(leftDate, rightDate) ||
    compareText(JSON.stringify(left), JSON.stringify(right))
  );
}

import {
  MARKET_OVERVIEW_PERIODS,
  MARKET_OVERVIEW_SPARKLINE_MAX_POINTS,
  subtractMonths,
  subtractYears,
  type MarketOverviewInstrumentResponse,
  type MarketOverviewInstrumentStatus,
  type MarketOverviewPeriod,
  type MarketOverviewReturns,
  type MarketOverviewSparkline,
  type MarketOverviewSparklines,
  type MarketOverviewStatus,
} from "@intrinsic/contracts";
import {
  tradingSessionCloseInstant,
  type DateRange,
  type LocalDate,
} from "@intrinsic/domain";
import { addDays } from "@intrinsic/stock-data";

/**
 * The market overview's arithmetic, in one pure module (`docs/decisions/etf-market-overview-v1.md`).
 *
 * Every rule worth getting wrong lives here and is tested without a database, a cache or a clock:
 * which session is complete, where each period is anchored, what a missing boundary means, and how
 * each period's window of closes becomes a bounded trend line. The service only reads and assembles.
 */

/**
 * Calendar days read before one year ago.
 *
 * The earliest anchor any period can have is the `1Y` one — `YTD`'s, the last day of the previous
 * year, is never earlier — and its session is the most recent one on or before it, which can be a
 * long weekend earlier. The margin also lets an instrument that fell a few weeks behind still have
 * its own `1Y` baseline inside the window. An instrument further behind than that reports `1Y` as
 * unavailable rather than read a deeper history for one stale fund.
 */
export const MARKET_OVERVIEW_LOOKBACK_MARGIN_DAYS = 45;

/** The range one overview read asks the history reader for, ending today. */
export function marketOverviewReadRange(today: LocalDate): Required<DateRange> {
  return {
    from: addDays(
      subtractYears(today, 1),
      -MARKET_OVERVIEW_LOOKBACK_MARGIN_DAYS,
    ),
    to: today,
  };
}

/**
 * The date a period is measured from, given the session it is measured to.
 *
 * Calendar arithmetic, never a count of sessions: "one month" is the same calendar month whatever
 * holidays fell inside it. Month ends clamp (`31 March` minus one month is `28 February`, or
 * `29 February` in a leap year) and `29 February` minus a year is `28 February`.
 */
export function periodAnchorDate(
  period: MarketOverviewPeriod,
  sessionDate: LocalDate,
): LocalDate {
  switch (period) {
    case "1W":
      return addDays(sessionDate, -7);
    case "1M":
      return subtractMonths(sessionDate, 1);
    case "3M":
      return subtractMonths(sessionDate, 3);
    case "6M":
      return subtractMonths(sessionDate, 6);
    case "YTD":
      // The close of the final session of the previous calendar year is the session on or before
      // its last day, whichever weekday or holiday that is.
      return `${Number(sessionDate.slice(0, 4)) - 1}-12-31`;
    case "1Y":
      return subtractYears(sessionDate, 1);
  }
}

/**
 * When a session's close is final: its regular 16:00 New York close plus the provider's publication
 * delay. The same convention the market-data refresh aims at (`latestFinalizedSession`), so the
 * overview never calls a bar complete that the refresh would still treat as provisional.
 */
export function sessionFinalizedAt(
  date: LocalDate,
  publicationDelayMs: number,
): number {
  return tradingSessionCloseInstant(date).getTime() + publicationDelayMs;
}

export type OverviewBar = { readonly date: LocalDate; readonly close: number };

export type InstrumentPerformance = {
  /** The latest completed session, or undefined when there is none. */
  sessionDate?: LocalDate;
  returns: MarketOverviewReturns;
  /** The session each period was measured from; null where the return is unavailable. */
  anchors: Record<MarketOverviewPeriod, LocalDate | null>;
  /** Each period's line over exactly the window its return measures; null with the return. */
  sparklines: MarketOverviewSparklines;
};

/**
 * One instrument's six returns and its trend line, from the bars a history read returned.
 *
 * The rules:
 *
 * - **Only completed sessions.** The provider lists the current session while it is still trading,
 *   so a bar counts only once its close plus `publicationDelayMs` has passed — and, when the series
 *   says when its recent tail was last read (`lastTailSyncAt`), only if that read happened after
 *   then. A bar read mid-session stays provisional until a later read replaces it, and until then
 *   the session before it is the latest one. Nothing intraday is ever reported as a close.
 * - **The latest session, never "today".** Every period is measured to the instrument's own latest
 *   completed session.
 * - **The most recent session on or before each anchor.** Never a later one: a boundary that falls
 *   on a weekend or a holiday uses the session before it, and a history that starts after the
 *   anchor has no `1Y` return rather than a shorter one presented as a year.
 * - **A gap in coverage voids a boundary.** When the stored coverage does not hold the days between
 *   that session and the anchor (`missing`), a later session might exist that was simply never
 *   stored, so the return is unavailable rather than measured from an older close.
 * - `returnPct = (latestClose / anchorClose - 1) × 100`, unrounded.
 * - **Each period's line spans the same two sessions as its return** — from the anchor session to
 *   the latest one — so a line can never point the other way from the number beside it
 *   (`buildPeriodSparkline`).
 */
export function computeInstrumentPerformance(input: {
  readonly bars: readonly OverviewBar[];
  /** Parts of the read range the stored coverage does not hold, ascending. */
  readonly missing: readonly Required<DateRange>[];
  readonly now: Date;
  readonly publicationDelayMs: number;
  /** When the series' recent tail was last read successfully, if it ever was. */
  readonly lastTailSyncAt?: string;
}): InstrumentPerformance {
  const sessions = completedSessions(input);
  const latest = sessions.at(-1);
  if (!latest) {
    return {
      returns: emptyReturns(),
      anchors: emptyAnchors(),
      sparklines: emptySparklines(),
    };
  }

  const returns = emptyReturns();
  const anchors = emptyAnchors();
  const sparklines = emptySparklines();
  for (const period of MARKET_OVERVIEW_PERIODS) {
    const anchor = anchorSession(
      sessions,
      periodAnchorDate(period, latest.date),
      input.missing,
    );
    if (anchor) {
      returns[period] = (latest.close / anchor.close - 1) * 100;
      anchors[period] = anchor.date;
      sparklines[period] = buildPeriodSparkline(
        sessions,
        anchor.date,
        input.missing,
      );
    }
  }

  return {
    sessionDate: latest.date,
    returns,
    anchors,
    sparklines,
  };
}

/**
 * Each instrument's status against the overview's reference session, and the reference itself.
 *
 * The reference is the newest completed session any instrument reached: a consistent as-of for all
 * twenty, derived from the data rather than from an exchange calendar the overview may not ask the
 * provider for. An instrument behind it is `STALE` and keeps its own, older `sessionDate`.
 */
export function classifyInstruments(
  sessionDates: readonly (LocalDate | undefined)[],
): {
  asOf?: LocalDate;
  statuses: MarketOverviewInstrumentStatus[];
  status: MarketOverviewStatus;
} {
  const available = sessionDates.filter(
    (date): date is LocalDate => date !== undefined,
  );
  const asOf = available.length > 0 ? [...available].sort().at(-1) : undefined;
  const statuses = sessionDates.map((date): MarketOverviewInstrumentStatus =>
    date === undefined
      ? "UNAVAILABLE"
      : date < (asOf as LocalDate)
        ? "STALE"
        : "AVAILABLE",
  );
  const status: MarketOverviewStatus =
    available.length === 0
      ? "UNAVAILABLE"
      : statuses.every((one) => one === "AVAILABLE")
        ? "AVAILABLE"
        : "PARTIAL";
  return { ...(asOf ? { asOf } : {}), statuses, status };
}

/** An instrument with nothing to show, in the shape the contract requires. */
export function unavailableInstrument(
  ticker: string,
  name: string,
  note?: string,
): MarketOverviewInstrumentResponse {
  return {
    ticker,
    name,
    ...(note ? { note } : {}),
    status: "UNAVAILABLE",
    returns: emptyReturns(),
    sparklines: emptySparklines(),
  };
}

/** Sorted, deduplicated, positive closes whose session is complete. */
function completedSessions(input: {
  readonly bars: readonly OverviewBar[];
  readonly now: Date;
  readonly publicationDelayMs: number;
  readonly lastTailSyncAt?: string;
}): OverviewBar[] {
  const byDate = new Map<LocalDate, OverviewBar>();
  for (const bar of input.bars) {
    if (Number.isFinite(bar.close) && bar.close > 0) {
      byDate.set(bar.date, bar);
    }
  }
  const sessions = [...byDate.values()].sort((left, right) =>
    left.date.localeCompare(right.date),
  );

  const now = input.now.getTime();
  const tailReadAt =
    input.lastTailSyncAt === undefined
      ? undefined
      : Date.parse(input.lastTailSyncAt);
  const readKnown = tailReadAt !== undefined && Number.isFinite(tailReadAt);
  // Only the newest bars can be provisional: a later read rewrites everything inside its tail, so
  // once one bar is final every bar before it is too.
  while (sessions.length > 0) {
    const finalizedAt = sessionFinalizedAt(
      (sessions.at(-1) as OverviewBar).date,
      input.publicationDelayMs,
    );
    const closed = finalizedAt <= now;
    const readAfterClose = !readKnown || (tailReadAt as number) >= finalizedAt;
    if (closed && readAfterClose) {
      break;
    }
    sessions.pop();
  }
  return sessions;
}

/** The most recent session on or before `anchor`, unless coverage has a gap between the two. */
function anchorSession(
  sessions: readonly OverviewBar[],
  anchor: LocalDate,
  missing: readonly Required<DateRange>[],
): OverviewBar | undefined {
  const index = lastIndexOnOrBefore(sessions, anchor);
  if (index < 0) {
    return undefined;
  }
  const session = sessions[index] as OverviewBar;
  // The days strictly after the session through the anchor must all be covered: only then is "no
  // bar there" a statement that the market did not trade rather than that nothing was stored.
  const gapFrom = addDays(session.date, 1);
  const uncovered = missing.some(
    (range) => range.from <= anchor && range.to >= gapFrom,
  );
  return uncovered ? undefined : session;
}

/** Index of the last session dated on or before `date`, or -1. Sessions are ascending. */
function lastIndexOnOrBefore(
  sessions: readonly OverviewBar[],
  date: LocalDate,
): number {
  let low = 0;
  let high = sessions.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((sessions[middle] as OverviewBar).date <= date) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/**
 * One period's trend line: every completed session from the period's anchor session through the
 * latest one, rebased to 100 at the anchor (`MarketOverviewSparkline`).
 *
 * - **The same window as the return.** The first point is the anchor session the return is
 *   measured from and the last is the latest session, so the line's first-to-last change *is* the
 *   return (to the rebased line's two decimals) and its direction cannot contradict it.
 * - **Real sessions only.** Every point is a stored close, in session order; nothing is
 *   interpolated, and a weekend or holiday is simply not a point.
 * - **A gap voids the line.** When the stored coverage does not hold some day inside the window, a
 *   session there may exist that was never stored, and a line drawn through the hole would show a
 *   shape the market never made. The line is then null; the return, whose two endpoints are sound,
 *   is unaffected.
 * - **Bounded.** A window of at most {@link MARKET_OVERVIEW_SPARKLINE_MAX_POINTS} sessions (a week,
 *   a month) is sent whole; a longer one is thinned to that many sessions by
 *   {@link thinSessions}, which always keeps both endpoints.
 */
export function buildPeriodSparkline(
  sessions: readonly OverviewBar[],
  anchorDate: LocalDate,
  missing: readonly Required<DateRange>[],
  maxPoints: number = MARKET_OVERVIEW_SPARKLINE_MAX_POINTS,
): MarketOverviewSparkline | null {
  const first = lastIndexOnOrBefore(sessions, anchorDate);
  if (first < 0 || (sessions[first] as OverviewBar).date !== anchorDate) {
    return null;
  }
  const window = sessions.slice(first);
  const start = window[0] as OverviewBar;
  const end = window.at(-1) as OverviewBar;
  if (window.length < 2) {
    return null;
  }
  // Coverage must hold every day after the anchor session through the latest one.
  const gapFrom = addDays(start.date, 1);
  if (missing.some((range) => range.from <= end.date && range.to >= gapFrom)) {
    return null;
  }

  const points = thinSessions(window, maxPoints);
  return {
    startDate: start.date,
    endDate: end.date,
    // Two decimals of an index based at 100 is a hundredth of a percent: far finer than a 30px line
    // can draw, and it keeps six lines for twenty funds to a few dozen kilobytes.
    values: points.map(
      (point) => Math.round((point.close / start.close) * 100 * 100) / 100,
    ),
  };
}

/**
 * At most `maxPoints` of `sessions`, chosen by Largest-Triangle-Three-Buckets: the first and last
 * session always, and from each of `maxPoints − 2` equal runs of sessions in between, the one that
 * makes the largest triangle with the point chosen before it and the average of the next run.
 *
 * It keeps the peaks and troughs a fixed stride would step over, so a thinned line still turns
 * where the market turned. Deterministic — the same sessions always yield the same points — and it
 * only ever selects: every point it returns is one of the sessions it was given, in their order.
 * Positions are session indices, as the sparkline draws them.
 */
export function thinSessions(
  sessions: readonly OverviewBar[],
  maxPoints: number,
): OverviewBar[] {
  if (sessions.length <= maxPoints || maxPoints < 3) {
    return [...sessions];
  }
  const last = sessions.length - 1;
  const picked: OverviewBar[] = [sessions[0] as OverviewBar];
  const bucket = (sessions.length - 2) / (maxPoints - 2);
  let previous = 0;
  for (let index = 0; index < maxPoints - 2; index += 1) {
    const from = Math.floor(index * bucket) + 1;
    const to = Math.floor((index + 1) * bucket) + 1;
    // The next run's centre of mass; the final run's "next" is the last session.
    const nextFrom = to;
    const nextTo = Math.min(Math.floor((index + 2) * bucket) + 1, last + 1);
    let averageX = 0;
    let averageY = 0;
    for (let next = nextFrom; next < nextTo; next += 1) {
      averageX += next;
      averageY += (sessions[next] as OverviewBar).close;
    }
    const span = Math.max(nextTo - nextFrom, 1);
    averageX /= span;
    averageY /= span;

    const anchor = sessions[previous] as OverviewBar;
    let best = from;
    let bestArea = -1;
    for (let candidate = from; candidate < to; candidate += 1) {
      const area = Math.abs(
        (previous - averageX) *
          ((sessions[candidate] as OverviewBar).close - anchor.close) -
          (previous - candidate) * (averageY - anchor.close),
      );
      if (area > bestArea) {
        bestArea = area;
        best = candidate;
      }
    }
    picked.push(sessions[best] as OverviewBar);
    previous = best;
  }
  picked.push(sessions[last] as OverviewBar);
  return picked;
}

function emptyReturns(): MarketOverviewReturns {
  return {
    "1W": null,
    "1M": null,
    "3M": null,
    "6M": null,
    YTD: null,
    "1Y": null,
  };
}

function emptyAnchors(): Record<MarketOverviewPeriod, LocalDate | null> {
  return {
    "1W": null,
    "1M": null,
    "3M": null,
    "6M": null,
    YTD: null,
    "1Y": null,
  };
}

function emptySparklines(): MarketOverviewSparklines {
  return {
    "1W": null,
    "1M": null,
    "3M": null,
    "6M": null,
    YTD: null,
    "1Y": null,
  };
}

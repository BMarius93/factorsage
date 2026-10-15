import {
  DEFAULT_EOD_PUBLICATION_DELAY_MS,
  eodCutoffDate,
  type DateRange,
  type Instant,
  type LocalDate,
} from "@intrinsic/domain";
import {
  latestFinalizedSession,
  MARKET_DATA_CALENDAR_EXCHANGE,
  type FinalizedSession,
} from "./market-data-refresh.js";
import type { TradingCalendar } from "./trading-calendar.js";

/**
 * Canonical end-of-day finality for stored market prices (`docs/decisions/eod-finality-v1.md`).
 *
 * The provider's `historical-price-eod/full` endpoint lists the current session while it is still
 * trading, so the *endpoint name* proves nothing. A stored bar is final only when it was read after
 * its session became final — its 16:00 New York close plus the publication delay. FactorSage
 * guarantees that in two places, both owned here:
 *
 * 1. **Nothing provisional is ever requested or stored.** Every load and refresh targets the EOD
 *    cutoff (`eodCutoffDate`), never the UTC day, and drops any row the provider returns beyond the
 *    range it was asked for. A row for a date can therefore only ever be written by a read issued
 *    after that date became final.
 * 2. **Freshness is a session question, not a timer.** A stock's recent tail needs a provider read
 *    exactly when the durable synchronization watermark does not prove a read after the newest
 *    finalized session — which also detects a row stored provisionally before this rule existed.
 *
 * The trading calendar only decides which weekday is a session. Without one, every weekday is
 * assumed to be a session: a holiday can then look like a missing bar — a bounded, retried request
 * that stops at the give-up bound — but a missing session can never look present.
 */

/**
 * How long a past year the venue schedule could not answer is left unasked
 * (`EodFinalityPolicy.isScheduledSession`). A published schedule for a finished year does not
 * change, so a failure is far more likely missing coverage than a blip; an hour bounds the provider
 * traffic to one request per such year per hour per process.
 */
export const UNANSWERABLE_YEAR_RETRY_MS = 60 * 60_000;

/** A calendar that knows only weekends: every weekday is taken to be a session. */
export const WEEKDAY_TRADING_CALENDAR: TradingCalendar = {
  async isTradingSession(_exchangeCode: string, date: LocalDate) {
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    return weekday !== 0 && weekday !== 6;
  },
};

export type EodFinalityOptions = {
  /** Close plus this is when a session's bar is final. Defaults to 30 minutes. */
  publicationDelayMs?: number;
  /** Spacing between repeated reads of a session the provider has not published yet. */
  sessionRetryMs?: number;
  /** How long after finalization a still-missing bar keeps being asked for. */
  sessionGiveUpMs?: number;
  /** The venue schedule. Absent: weekdays are sessions. */
  calendar?: TradingCalendar;
  now?: () => Date;
};

/**
 * What the durable record says about a security's recent tail.
 *
 * `lastTailSyncAt` is the instant the newest leading-edge read was **issued**, and `tailDate` the
 * newest date that read asked for; `latestBar` is the newest stored bar.
 */
export type EodTailState = {
  latestBar?: LocalDate;
  lastTailSyncAt?: Instant;
  tailDate?: LocalDate;
};

export type EodTailDecision =
  | {
      action: "SKIP";
      reason:
        /** The newest finalized session is stored, read after it became final. */
        | "UP_TO_DATE"
        /** The session is missing after a post-final read, and was asked for too recently. */
        | "RECENTLY_ASKED"
        /**
         * The session is still missing past the give-up bound after it became final: the security
         * is taken not to have traded it (a halt, a delisting, a late listing).
         */
        | "SESSION_NOT_PUBLISHED";
    }
  | {
      action: "REFRESH";
      reason:
        /** No leading-edge read has ever succeeded. */
        | "NEVER_SYNCED"
        /** The newest finalized session is not stored. */
        | "SESSION_MISSING"
        /** A bar for the session is stored, but no read after it became final proves it. */
        | "SESSION_UNVERIFIED";
    };

/**
 * Whether one security's recent tail needs a provider read for `expected`. Pure.
 *
 * A session found missing after it became final is asked for again on a widening spacing — never
 * sooner than `retryMs`, and never sooner than the time that already passed since finalization — so
 * a late publication is picked up promptly while a security that will never print that session
 * costs a handful of reads, and none at all once `giveUpMs` has passed.
 */
export function decideEodTailRefresh(input: {
  state: EodTailState;
  expected: FinalizedSession;
  now: Date;
  retryMs: number;
  giveUpMs: number;
}): EodTailDecision {
  const { state, expected } = input;
  const lastSync = instant(state.lastTailSyncAt);
  if (lastSync === undefined) {
    return { action: "REFRESH", reason: "NEVER_SYNCED" };
  }
  const finalizedAt = Date.parse(expected.finalizedAt);
  const readAfterFinal =
    lastSync >= finalizedAt &&
    (state.tailDate === undefined || state.tailDate >= expected.session);
  const holdsSession =
    state.latestBar !== undefined && state.latestBar >= expected.session;
  if (!readAfterFinal) {
    return {
      action: "REFRESH",
      reason: holdsSession ? "SESSION_UNVERIFIED" : "SESSION_MISSING",
    };
  }
  if (holdsSession) {
    return { action: "SKIP", reason: "UP_TO_DATE" };
  }
  const now = input.now.getTime();
  if (now - finalizedAt >= input.giveUpMs) {
    return { action: "SKIP", reason: "SESSION_NOT_PUBLISHED" };
  }
  const spacing = Math.max(input.retryMs, lastSync - finalizedAt);
  return now - lastSync < spacing
    ? { action: "SKIP", reason: "RECENTLY_ASKED" }
    : { action: "REFRESH", reason: "SESSION_MISSING" };
}

/**
 * The finality policy one loader applies: its clock, its publication delay, its calendar.
 *
 * One instance per service. It holds no state of its own beyond what it is given; the calendar
 * caches its schedules in process memory.
 */
export class EodFinalityPolicy {
  readonly publicationDelayMs: number;
  readonly sessionRetryMs: number;
  readonly sessionGiveUpMs: number;
  private readonly calendar: TradingCalendar;
  private readonly now: () => Date;
  /** Past years the schedule could not answer, by `EXCHANGE:year`, and when each is asked again. */
  private readonly unanswerableYears = new Map<string, number>();

  constructor(options: EodFinalityOptions = {}) {
    this.publicationDelayMs =
      options.publicationDelayMs ?? DEFAULT_EOD_PUBLICATION_DELAY_MS;
    this.sessionRetryMs = options.sessionRetryMs ?? 30 * 60_000;
    this.sessionGiveUpMs = options.sessionGiveUpMs ?? 24 * 60 * 60_000;
    this.calendar = options.calendar ?? WEEKDAY_TRADING_CALENDAR;
    this.now = options.now ?? (() => new Date());
    for (const [name, value] of Object.entries({
      publicationDelayMs: this.publicationDelayMs,
      sessionRetryMs: this.sessionRetryMs,
      sessionGiveUpMs: this.sessionGiveUpMs,
    })) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`${name} must be a non-negative number`);
      }
    }
  }

  /** The newest calendar date whose bar is final now — the upper bound of every price read. */
  cutoffDate(at: Date = this.now()): LocalDate {
    return eodCutoffDate(at, this.publicationDelayMs);
  }

  /**
   * The newest session on `exchangeCode` whose bar is final now.
   *
   * Asked of the venue schedule; a venue the schedule does not know, or a schedule that cannot be
   * read, falls back to weekdays rather than failing — a weekday holiday then looks like a missing
   * bar, which the give-up bound absorbs.
   */
  async expectedSession(
    exchangeCode: string = MARKET_DATA_CALENDAR_EXCHANGE,
    at: Date = this.now(),
  ): Promise<FinalizedSession> {
    const fromVenue = await latestFinalizedSession({
      now: at,
      calendar: this.calendar,
      publicationDelayMs: this.publicationDelayMs,
      exchangeCode,
    });
    if (fromVenue) {
      return fromVenue;
    }
    const fromWeekdays = await latestFinalizedSession({
      now: at,
      calendar: WEEKDAY_TRADING_CALENDAR,
      publicationDelayMs: this.publicationDelayMs,
      exchangeCode,
    });
    if (!fromWeekdays) {
      // Unreachable: some weekday in any fourteen-day window has closed.
      throw new Error("No finalized weekday session in the last fourteen days");
    }
    return { ...fromWeekdays, calendar: "WEEKDAYS" };
  }

  /**
   * Whether `date` is a scheduled session on `exchangeCode`, from the same venue schedule
   * `expectedSession` reads — or `undefined` when the schedule cannot say. Never a guess: a caller
   * that needs an answer decides for itself what "unknown" must mean (the weekly materializer
   * delays a week, the Monitor holds a member).
   *
   * A **past** year the schedule could not answer is not asked again for
   * {@link UNANSWERABLE_YEAR_RETRY_MS}. Week completion asks about every holiday week of a history
   * (an ETF's reaches back to 1993), and a year the provider holds no schedule for would otherwise
   * cost one provider request per year on every rebuild, Monitor cycle and backtest. The year in
   * progress is asked every time, exactly as `expectedSession` asks it.
   */
  async isScheduledSession(
    exchangeCode: string,
    date: LocalDate,
  ): Promise<boolean | undefined> {
    const year = date.slice(0, 4);
    const key = `${exchangeCode.trim().toUpperCase()}:${year}`;
    const now = this.now();
    const retryAt = this.unanswerableYears.get(key);
    if (retryAt !== undefined && now.getTime() < retryAt) {
      return undefined;
    }
    try {
      return await this.calendar.isTradingSession(exchangeCode, date);
    } catch {
      if (year < this.cutoffDate(now).slice(0, 4)) {
        this.unanswerableYears.set(
          key,
          now.getTime() + UNANSWERABLE_YEAR_RETRY_MS,
        );
      }
      return undefined;
    }
  }

  decide(state: EodTailState, expected: FinalizedSession): EodTailDecision {
    return decideEodTailRefresh({
      state,
      expected,
      now: this.now(),
      retryMs: this.sessionRetryMs,
      giveUpMs: this.sessionGiveUpMs,
    });
  }
}

function instant(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The rows of a provider answer that lie inside the range it was asked for.
 *
 * Every range a loader asks for ends at the EOD cutoff, so a row after it would be a bar whose
 * session had not become final when the read was issued — the provider's in-progress reading. A
 * provider that ignored `to` must not be able to store one, so this is enforced here rather than
 * trusted (`docs/decisions/eod-finality-v1.md`).
 */
export function withinRequestedRange<T extends { date: string }>(
  rows: readonly T[],
  range: Required<DateRange>,
): T[] {
  return rows.filter((row) => row.date >= range.from && row.date <= range.to);
}

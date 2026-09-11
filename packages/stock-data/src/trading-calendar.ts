import {
  SUPPORTED_EXCHANGE_CODES,
  type LocalDate,
} from "@intrinsic/domain";
import type { FmpExchangeCalendarPort } from "@intrinsic/fmp";

/**
 * Whether an exchange holds a trading session on a given calendar day.
 *
 * This is deliberately **not** a general trading-calendar subsystem. It answers one question — did
 * this venue open at all — for the only universe V1 admits (`SUPPORTED_EXCHANGE_CODES`: NASDAQ,
 * NYSE, AMEX). It knows nothing about session times, half-days, futures calendars or settlement.
 *
 * It exists because a fully closed holiday is not a market observation, and treating it as one is
 * not cosmetic: it appends a bar the market never traded, which shifts every rolling window by one
 * observation and can move an average past a price that never moved — and it names a session later
 * than the previous real one, which ends a Trigger Signal that fired there.
 *
 * An **early close is an ordinary session.** The venue opened; it simply closed sooner. Nothing
 * about a daily bar changes, so an early close is not filtered.
 */

/** Milliseconds a resolved schedule is reused before it is fetched again. */
const DEFAULT_SCHEDULE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fewest full closures a complete year of US equity schedule may plausibly contain.
 *
 * NASDAQ, NYSE and AMEX each observe nine or ten full closures a year. The number this guards
 * against is **zero**: an empty array is a valid array, so a provider that starts answering `[]` —
 * a plan change, a deprecated endpoint, an upstream fault — would otherwise hand back a schedule
 * with no closures in it, which reads as "the exchange is open every weekday". That is exactly the
 * assumption this boundary exists to prevent, so an implausible schedule is treated as no schedule.
 * The floor sits well below the real count so a genuine calendar can never trip it.
 */
const MIN_FULL_CLOSURES_PER_YEAR = 6;

export type TradingCalendarOptions = {
  now?: () => Date;
  /** How long a fetched year of schedule is reused. A published schedule changes very rarely. */
  scheduleTtlMs?: number;
};

export interface TradingCalendar {
  /**
   * Whether `date` is a trading session on `exchangeCode`.
   *
   * Throws when the schedule cannot be obtained. That is deliberate: the caller must not be able to
   * mistake "we could not find out" for "the exchange was open", because only one of those may
   * produce an observation.
   */
  isTradingSession(exchangeCode: string, date: LocalDate): Promise<boolean>;
}

/** Raised when a calendar answer is required and the schedule could not be resolved. */
export class TradingCalendarUnavailableError extends Error {
  constructor(
    readonly exchangeCode: string,
    readonly year: number,
    readonly cause: unknown,
  ) {
    super(
      `Trading calendar for ${exchangeCode} ${year} is unavailable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "TradingCalendarUnavailableError";
  }
}

type CachedSchedule = {
  /** Dates the venue does not open at all. Early closes are deliberately absent. */
  fullCloses: ReadonlySet<LocalDate>;
  fetchedAtMs: number;
};

/**
 * A trading calendar backed by the provider's exchange holiday schedule, cached in process memory.
 *
 * Three properties make it affordable, and all three are the point:
 *
 * - **Per exchange and year, never per symbol or per Monitor.** Every security listed on a venue
 *   shares its calendar, so a cycle over a thousand symbols resolves at most one schedule per
 *   exchange.
 * - **Single-flight.** Concurrent callers asking for the same schedule await one request rather
 *   than starting one each — which is what a cycle's bounded symbol concurrency would otherwise do
 *   on its first cold call.
 * - **Process memory, with a TTL.** A published holiday schedule changes very rarely, and this is
 *   not correctness-critical state that must survive a restart: a cold process simply fetches it
 *   again. Nothing is cached in Redis for it.
 */
export class CachedTradingCalendar implements TradingCalendar {
  private readonly now: () => Date;
  private readonly scheduleTtlMs: number;
  private readonly schedules = new Map<string, CachedSchedule>();
  /** In-flight fetches, so concurrent callers share one request rather than racing. */
  private readonly inFlight = new Map<string, Promise<CachedSchedule>>();

  constructor(
    private readonly provider: FmpExchangeCalendarPort,
    options: TradingCalendarOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.scheduleTtlMs = options.scheduleTtlMs ?? DEFAULT_SCHEDULE_TTL_MS;
  }

  async isTradingSession(
    exchangeCode: string,
    date: LocalDate,
  ): Promise<boolean> {
    // A weekend is closed on every venue this product admits, and needs no provider round trip.
    if (isWeekend(date)) {
      return false;
    }
    // A venue outside the admitted universe has no schedule here, and this boundary deliberately
    // does not grow one. Reporting "no session" keeps the effect contained to that security — it
    // becomes NOT_EVALUABLE — rather than either guessing the venue was open or failing a cycle
    // over one mis-catalogued row. The catalog cannot currently produce one; this is the guard that
    // keeps that true if it ever could.
    if (!isSupportedExchange(exchangeCode)) {
      return false;
    }
    const schedule = await this.schedule(exchangeCode, yearOf(date));
    return !schedule.fullCloses.has(date);
  }

  private async schedule(
    exchangeCode: string,
    year: number,
  ): Promise<CachedSchedule> {
    const key = `${exchangeCode.trim().toUpperCase()}:${year}`;
    const cached = this.schedules.get(key);
    if (cached && this.now().getTime() - cached.fetchedAtMs < this.scheduleTtlMs) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = this.fetchSchedule(exchangeCode, year)
      .then((schedule) => {
        this.schedules.set(key, schedule);
        return schedule;
      })
      .catch((error: unknown) => {
        // A refetch that fails does not discard a schedule already in hand. A published holiday
        // calendar for a year in progress does not change, so yesterday's copy of *this* year is
        // the best available truth — and it is real provider data, not a guess that the exchange
        // was open. Without this, a non-retryable failure such as a plan that no longer covers the
        // endpoint would stop monitoring permanently the moment the lifetime lapsed, while a
        // perfectly good schedule sat unused in memory.
        if (cached) {
          return cached;
        }
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  private async fetchSchedule(
    exchangeCode: string,
    year: number,
  ): Promise<CachedSchedule> {
    try {
      const holidays = await this.provider.getExchangeHolidays(
        exchangeCode,
        // `from` is **exclusive** and `to` is inclusive — verified against the live endpoint on
        // 2026-09-11, where `from=2024-01-01` returned a 2024 schedule beginning 2024-01-15 and
        // `from=2023-12-31` returned the same schedule beginning 2024-01-01. Asking from the first
        // of the year therefore drops 1 January, which is the one full closure that occurs every
        // single year — so the day most certain to be closed was the day most certain to be missed.
        `${year - 1}-12-31`,
        `${year}-12-31`,
      );
      const fullCloses = new Set(
        holidays
          .filter(
            (holiday) =>
              holiday.fullClose && holiday.date.startsWith(`${year}-`),
          )
          .map((holiday) => holiday.date),
      );
      if (fullCloses.size < MIN_FULL_CLOSURES_PER_YEAR) {
        throw new Error(
          `Schedule for ${exchangeCode} ${year} lists ${fullCloses.size} full closures, ` +
            `fewer than the ${MIN_FULL_CLOSURES_PER_YEAR} a real year must have`,
        );
      }
      return { fullCloses, fetchedAtMs: this.now().getTime() };
    } catch (error) {
      // Not cached, and not defaulted to "open": the next call retries, and until one succeeds the
      // caller is told it cannot know rather than being handed a schedule with no closures in it.
      throw new TradingCalendarUnavailableError(exchangeCode, year, error);
    }
  }
}

/** Whether this product admits the exchange at all; an unknown venue has no calendar here. */
export function isSupportedExchange(exchangeCode: string): boolean {
  return (SUPPORTED_EXCHANGE_CODES as readonly string[]).includes(
    exchangeCode.trim().toUpperCase(),
  );
}

/** Saturday or Sunday, on the canonical `YYYY-MM-DD` product date. */
export function isWeekend(date: LocalDate): boolean {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return day === 0 || day === 6;
}

function yearOf(date: LocalDate): number {
  return Number.parseInt(date.slice(0, 4), 10);
}

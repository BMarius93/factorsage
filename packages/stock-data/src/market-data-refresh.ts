import {
  tradingSessionCloseInstant,
  tradingSessionDate,
  type Instant,
  type LocalDate,
} from "@intrinsic/domain";
import type { BenchmarkRefreshState } from "./benchmark-ports.js";
import { addDays } from "./dates.js";
import type { TradingCalendar } from "./trading-calendar.js";

/**
 * When the scheduled market-data refresh has something to ask for
 * (`docs/decisions/etf-market-data-v1.md`, "Incremental refresh").
 *
 * The provider's end-of-day series lists the current session while it is still trading, so a bar is
 * final only once its session has closed and the provider has had time to publish the close. The
 * refresh therefore aims at the **latest finalized session** — the newest trading session whose
 * close plus a publication delay has passed — and asks for nothing while every series already holds
 * that session as read after it became final. Weekends and exchange holidays are not sessions, so
 * they never produce a request.
 */

/** The venue whose calendar the ETF universe trades on; every supported US venue shares it. */
export const MARKET_DATA_CALENDAR_EXCHANGE = "NYSE";

/** Days searched back for a session; longer than any US closure on record. */
const SESSION_LOOKBACK_DAYS = 14;

export type FinalizedSession = {
  session: LocalDate;
  /** When the session's bar is expected to be final: its close plus the publication delay. */
  finalizedAt: Instant;
  /**
   * Where the answer came from. `WEEKDAYS` when the exchange schedule could not be read: every
   * weekday is then assumed to be a session, which can only make a holiday look missing — a
   * bounded, retried request — never a missing session look present.
   */
  calendar: "EXCHANGE" | "WEEKDAYS";
};

/**
 * The newest session whose close plus `publicationDelayMs` is at or before `now`.
 *
 * The session's close is the regular 16:00 New York close (`tradingSessionCloseInstant`); an early
 * close is still a session and simply becomes final a little later than it could have.
 */
export async function latestFinalizedSession(input: {
  now: Date;
  calendar: TradingCalendar;
  publicationDelayMs: number;
  exchangeCode?: string;
}): Promise<FinalizedSession | undefined> {
  const exchange = input.exchangeCode ?? MARKET_DATA_CALENDAR_EXCHANGE;
  const today = tradingSessionDate(input.now);
  let calendar: FinalizedSession["calendar"] = "EXCHANGE";
  for (let offset = 0; offset <= SESSION_LOOKBACK_DAYS; offset += 1) {
    const date = addDays(today, -offset) as LocalDate;
    const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) {
      continue;
    }
    if (calendar === "EXCHANGE") {
      try {
        if (!(await input.calendar.isTradingSession(exchange, date))) {
          continue;
        }
      } catch {
        calendar = "WEEKDAYS";
      }
    }
    const finalizedAt = new Date(
      tradingSessionCloseInstant(date).getTime() + input.publicationDelayMs,
    );
    if (finalizedAt.getTime() <= input.now.getTime()) {
      return {
        session: date,
        finalizedAt: finalizedAt.toISOString(),
        calendar,
      };
    }
  }
  return undefined;
}

export type BenchmarkRefreshDecision =
  | {
      action: "SKIP";
      reason:
        /** The session is stored, read after it became final. */
        | "UP_TO_DATE"
        /** The series has no durable coverage; only the bootstrap command loads one. */
        | "NOT_BOOTSTRAPPED"
        /** Asked after the session became final, less than the retry spacing ago. */
        | "RECENTLY_ASKED";
    }
  | {
      action: "REFRESH";
      reason:
        /** The expected session is not stored yet. */
        | "SESSION_MISSING"
        /** The session is stored, but was read before it became final. */
        | "SESSION_PROVISIONAL"
        /** No session could be determined; the tail is refreshed on the retry spacing. */
        | "TAIL_STALE";
    };

/**
 * Whether one series needs a provider read now. Pure: every input is passed in.
 *
 * A session the provider has not published yet is asked for again only after `retryMs`, so a late
 * publication costs one bounded tail read per series per retry interval, never a request per run.
 */
export function decideBenchmarkRefresh(input: {
  state: BenchmarkRefreshState;
  expected: FinalizedSession | undefined;
  now: Date;
  retryMs: number;
}): BenchmarkRefreshDecision {
  const { state, expected } = input;
  if (state.coverageEnd === undefined) {
    return { action: "SKIP", reason: "NOT_BOOTSTRAPPED" };
  }
  // Only the tail watermark says the provider was asked about the recent sessions: a backfill of an
  // older range saves too, but tells nothing about today's bar. A read whose newest bars were held
  // at a possible ex-date advances no watermark; the refresh run spaces those itself.
  const lastSync = instant(state.lastTailSyncAt);
  const recentlyAsked =
    lastSync !== undefined && input.now.getTime() - lastSync < input.retryMs;
  if (expected === undefined) {
    return recentlyAsked
      ? { action: "SKIP", reason: "RECENTLY_ASKED" }
      : { action: "REFRESH", reason: "TAIL_STALE" };
  }
  const readAfterFinal =
    lastSync !== undefined && lastSync >= Date.parse(expected.finalizedAt);
  const holdsSession =
    state.latestBar !== undefined && state.latestBar >= expected.session;
  if (holdsSession && readAfterFinal) {
    return { action: "SKIP", reason: "UP_TO_DATE" };
  }
  if (readAfterFinal && recentlyAsked) {
    return { action: "SKIP", reason: "RECENTLY_ASKED" };
  }
  return {
    action: "REFRESH",
    reason: holdsSession ? "SESSION_PROVISIONAL" : "SESSION_MISSING",
  };
}

function instant(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

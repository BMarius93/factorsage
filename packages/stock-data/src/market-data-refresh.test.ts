import { describe, expect, it } from "vitest";
import {
  decideBenchmarkRefresh,
  latestFinalizedSession,
} from "./market-data-refresh.js";
import type { TradingCalendar } from "./trading-calendar.js";

const DELAY = 30 * 60_000;

/** NYSE full closures in the window these cases use. */
const HOLIDAYS = new Set(["2026-11-26", "2026-12-25", "2027-01-01"]);

const calendar: TradingCalendar = {
  async isTradingSession(_exchange, date) {
    return !HOLIDAYS.has(date);
  },
};

const failing: TradingCalendar = {
  async isTradingSession() {
    throw new Error("schedule unavailable");
  },
};

async function sessionAt(now: string, using: TradingCalendar = calendar) {
  return latestFinalizedSession({
    now: new Date(now),
    calendar: using,
    publicationDelayMs: DELAY,
  });
}

describe("latestFinalizedSession", () => {
  it("is the previous session until today's close plus the publication delay has passed", async () => {
    // Friday 2026-10-09, 16:00 New York is 20:00 UTC; final at 20:30 UTC.
    expect((await sessionAt("2026-10-09T20:29:00.000Z"))?.session).toBe(
      "2026-10-08",
    );
    const after = await sessionAt("2026-10-09T20:30:00.000Z");
    expect(after?.session).toBe("2026-10-09");
    expect(after?.finalizedAt).toBe("2026-10-09T20:30:00.000Z");
    expect(after?.calendar).toBe("EXCHANGE");
  });

  it("stays on Friday through the weekend", async () => {
    expect((await sessionAt("2026-10-11T12:00:00.000Z"))?.session).toBe(
      "2026-10-09",
    );
    expect((await sessionAt("2026-10-12T13:00:00.000Z"))?.session).toBe(
      "2026-10-09",
    );
  });

  it("skips an exchange holiday", async () => {
    // Thanksgiving, Thursday 2026-11-26: the Wednesday stays the latest session through it.
    expect((await sessionAt("2026-11-26T23:00:00.000Z"))?.session).toBe(
      "2026-11-25",
    );
  });

  it("follows the New York clock, not UTC, across midnight", async () => {
    // 01:00 UTC on Saturday is still Friday evening in New York, after Friday's close.
    expect((await sessionAt("2026-10-10T01:00:00.000Z"))?.session).toBe(
      "2026-10-09",
    );
  });

  it("falls back to weekdays when the exchange schedule cannot be read, and says so", async () => {
    const fallback = await sessionAt("2026-11-26T23:00:00.000Z", failing);
    // A holiday then looks like a session: the refresh asks for a bar that never comes, bounded by
    // its retry spacing. It can never make a missing session look present.
    expect(fallback?.session).toBe("2026-11-26");
    expect(fallback?.calendar).toBe("WEEKDAYS");
  });
});

describe("decideBenchmarkRefresh", () => {
  const expected = {
    session: "2026-10-09",
    finalizedAt: "2026-10-09T20:30:00.000Z",
    calendar: "EXCHANGE" as const,
  };
  const now = new Date("2026-10-09T21:00:00.000Z");
  const retryMs = 30 * 60_000;

  it("never bootstraps: a series with no coverage is skipped", () => {
    expect(
      decideBenchmarkRefresh({ state: {}, expected, now, retryMs }),
    ).toEqual({ action: "SKIP", reason: "NOT_BOOTSTRAPPED" });
  });

  it("asks for nothing when the session is stored and was read after it became final", () => {
    expect(
      decideBenchmarkRefresh({
        state: {
          coverageEnd: "2026-10-09",
          latestBar: "2026-10-09",
          lastTailSyncAt: "2026-10-09T20:40:00.000Z",
        },
        expected,
        now,
        retryMs,
      }),
    ).toEqual({ action: "SKIP", reason: "UP_TO_DATE" });
  });

  it("re-reads a session stored while it was still trading", () => {
    expect(
      decideBenchmarkRefresh({
        state: {
          coverageEnd: "2026-10-09",
          latestBar: "2026-10-09",
          lastTailSyncAt: "2026-10-09T15:00:00.000Z",
        },
        expected,
        now,
        retryMs,
      }),
    ).toEqual({ action: "REFRESH", reason: "SESSION_PROVISIONAL" });
  });

  it("asks for a missing session, then waits out the retry spacing while the provider has not published it", () => {
    const missing = {
      coverageEnd: "2026-10-08",
      latestBar: "2026-10-08",
      lastTailSyncAt: "2026-10-08T21:00:00.000Z",
    };
    expect(
      decideBenchmarkRefresh({ state: missing, expected, now, retryMs }),
    ).toEqual({ action: "REFRESH", reason: "SESSION_MISSING" });

    const askedAfterFinal = {
      ...missing,
      coverageEnd: "2026-10-09",
      lastTailSyncAt: "2026-10-09T20:45:00.000Z",
    };
    expect(
      decideBenchmarkRefresh({
        state: askedAfterFinal,
        expected,
        now,
        retryMs,
      }),
    ).toEqual({ action: "SKIP", reason: "RECENTLY_ASKED" });
    // Once the spacing has passed, the delayed bar is asked for again.
    expect(
      decideBenchmarkRefresh({
        state: askedAfterFinal,
        expected,
        now: new Date("2026-10-09T21:16:00.000Z"),
        retryMs,
      }),
    ).toEqual({ action: "REFRESH", reason: "SESSION_MISSING" });
  });

  it("is not delayed by a saved read that never reached the recent sessions", () => {
    // A backtest backfilled 1995-1999 after the close: the base coverage synced, the tail did not.
    expect(
      decideBenchmarkRefresh({
        state: {
          coverageEnd: "2026-10-08",
          latestBar: "2026-10-08",
          lastTailSyncAt: "2026-10-08T21:00:00.000Z",
        },
        expected,
        now,
        retryMs,
      }),
    ).toEqual({ action: "REFRESH", reason: "SESSION_MISSING" });
  });

  it("refreshes on the retry spacing when no session can be determined", () => {
    const state = {
      coverageEnd: "2026-10-09",
      latestBar: "2026-10-09",
      lastTailSyncAt: "2026-10-09T20:45:00.000Z",
    };
    expect(
      decideBenchmarkRefresh({ state, expected: undefined, now, retryMs }),
    ).toEqual({ action: "SKIP", reason: "RECENTLY_ASKED" });
    expect(
      decideBenchmarkRefresh({
        state,
        expected: undefined,
        now: new Date("2026-10-10T03:00:00.000Z"),
        retryMs,
      }),
    ).toEqual({ action: "REFRESH", reason: "TAIL_STALE" });
  });
});

import { describe, expect, it } from "vitest";
import {
  decideEodTailRefresh,
  EodFinalityPolicy,
  WEEKDAY_TRADING_CALENDAR,
} from "./eod-finality.js";
import type { FinalizedSession } from "./market-data-refresh.js";
import type { TradingCalendar } from "./trading-calendar.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Wednesday 14 October 2026, EDT: close 20:00Z, final 20:30Z.
const SESSION: FinalizedSession = {
  session: "2026-10-14",
  finalizedAt: "2026-10-14T20:30:00.000Z",
  calendar: "EXCHANGE",
};

function decide(
  state: Parameters<typeof decideEodTailRefresh>[0]["state"],
  now: string,
) {
  return decideEodTailRefresh({
    state,
    expected: SESSION,
    now: new Date(now),
    retryMs: 30 * MINUTE,
    giveUpMs: 24 * HOUR,
  });
}

describe("decideEodTailRefresh", () => {
  it("asks for a tail that has never been read", () => {
    expect(decide({}, "2026-10-14T21:00:00.000Z")).toEqual({
      action: "REFRESH",
      reason: "NEVER_SYNCED",
    });
  });

  it("re-reads a session bar stored before the session became final", () => {
    // Read at 15:00 New York: the bar it stored was the provider's in-progress reading.
    expect(
      decide(
        {
          latestBar: "2026-10-14",
          lastTailSyncAt: "2026-10-14T19:00:00.000Z",
          tailDate: "2026-10-14",
        },
        "2026-10-14T20:31:00.000Z",
      ),
    ).toEqual({ action: "REFRESH", reason: "SESSION_UNVERIFIED" });
  });

  it("asks for the newest session when the last read predates it", () => {
    expect(
      decide(
        {
          latestBar: "2026-10-13",
          lastTailSyncAt: "2026-10-13T21:00:00.000Z",
          tailDate: "2026-10-13",
        },
        "2026-10-14T20:31:00.000Z",
      ),
    ).toEqual({ action: "REFRESH", reason: "SESSION_MISSING" });
  });

  it("needs nothing once the session is stored and was read after it became final", () => {
    expect(
      decide(
        {
          latestBar: "2026-10-14",
          lastTailSyncAt: "2026-10-14T20:35:00.000Z",
          tailDate: "2026-10-14",
        },
        "2026-10-15T09:00:00.000Z",
      ),
    ).toEqual({ action: "SKIP", reason: "UP_TO_DATE" });
  });

  it("does not trust a post-final read that stopped short of the session", () => {
    // A read issued after 16:30 but bounded at the previous day cannot have stored the session.
    expect(
      decide(
        {
          latestBar: "2026-10-13",
          lastTailSyncAt: "2026-10-14T20:31:00.000Z",
          tailDate: "2026-10-13",
        },
        "2026-10-14T20:32:00.000Z",
      ),
    ).toEqual({ action: "REFRESH", reason: "SESSION_MISSING" });
  });

  it("spaces repeated reads of an unpublished session on a widening interval", () => {
    const missing = (lastTailSyncAt: string) => ({
      latestBar: "2026-10-13",
      lastTailSyncAt,
      tailDate: "2026-10-14",
    });
    // Asked 5 minutes after final: wait the 30-minute floor.
    expect(
      decide(missing("2026-10-14T20:35:00.000Z"), "2026-10-14T20:50:00.000Z"),
    ).toEqual({ action: "SKIP", reason: "RECENTLY_ASKED" });
    expect(
      decide(missing("2026-10-14T20:35:00.000Z"), "2026-10-14T21:05:00.000Z"),
    ).toEqual({ action: "REFRESH", reason: "SESSION_MISSING" });
    // Asked 4 hours after final: wait at least another 4 hours.
    expect(
      decide(missing("2026-10-15T00:30:00.000Z"), "2026-10-15T03:00:00.000Z"),
    ).toEqual({ action: "SKIP", reason: "RECENTLY_ASKED" });
    expect(
      decide(missing("2026-10-15T00:30:00.000Z"), "2026-10-15T04:30:00.000Z"),
    ).toEqual({ action: "REFRESH", reason: "SESSION_MISSING" });
  });

  it("stops asking for a session past the give-up bound", () => {
    expect(
      decide(
        {
          latestBar: "2026-10-13",
          lastTailSyncAt: "2026-10-15T12:00:00.000Z",
          tailDate: "2026-10-15",
        },
        "2026-10-15T20:30:00.000Z",
      ),
    ).toEqual({ action: "SKIP", reason: "SESSION_NOT_PUBLISHED" });
  });

  it("never gives up on a session it has not read after finalization", () => {
    expect(
      decide(
        {
          latestBar: "2026-10-13",
          lastTailSyncAt: "2026-10-14T18:00:00.000Z",
          tailDate: "2026-10-14",
        },
        "2026-10-20T20:30:00.000Z",
      ),
    ).toEqual({ action: "REFRESH", reason: "SESSION_MISSING" });
  });
});

describe("EodFinalityPolicy", () => {
  const holidayCalendar = (closed: readonly string[]): TradingCalendar => ({
    async isTradingSession(_exchange, date) {
      return (
        (await WEEKDAY_TRADING_CALENDAR.isTradingSession("NYSE", date)) &&
        !closed.includes(date)
      );
    },
  });

  it("bounds reads at the EOD cutoff, not the UTC day", () => {
    const policy = new EodFinalityPolicy({
      now: () => new Date("2026-10-14T15:00:00.000Z"),
    });
    expect(policy.cutoffDate()).toBe("2026-10-13");
    expect(
      policy.cutoffDate(new Date("2026-10-15T01:00:00.000Z")),
    ).toBe("2026-10-14");
  });

  it("expects the newest session the venue held, skipping weekends and holidays", async () => {
    const policy = new EodFinalityPolicy({
      calendar: holidayCalendar(["2026-11-26"]),
    });
    // Saturday afternoon: Friday is the newest final session.
    expect(
      (await policy.expectedSession("NYSE", new Date("2026-10-17T18:00:00.000Z")))
        .session,
    ).toBe("2026-10-16");
    // Thanksgiving evening: Wednesday.
    expect(
      (await policy.expectedSession("NYSE", new Date("2026-11-27T01:00:00.000Z")))
        .session,
    ).toBe("2026-11-25");
    // During a session: the previous one.
    const midSession = await policy.expectedSession(
      "NYSE",
      new Date("2026-10-14T15:00:00.000Z"),
    );
    expect(midSession).toEqual({
      session: "2026-10-13",
      finalizedAt: "2026-10-13T20:30:00.000Z",
      calendar: "EXCHANGE",
    });
  });

  it("falls back to weekdays when the venue schedule cannot be read", async () => {
    const policy = new EodFinalityPolicy({
      calendar: {
        async isTradingSession() {
          throw new Error("schedule unavailable");
        },
      },
    });
    const expected = await policy.expectedSession(
      "NYSE",
      new Date("2026-11-27T01:00:00.000Z"),
    );
    expect(expected.session).toBe("2026-11-26");
    expect(expected.calendar).toBe("WEEKDAYS");
  });

  it("falls back to weekdays for a venue the schedule does not know", async () => {
    const policy = new EodFinalityPolicy({
      calendar: { isTradingSession: async () => false },
    });
    const expected = await policy.expectedSession(
      "OTC",
      new Date("2026-10-14T21:00:00.000Z"),
    );
    expect(expected).toMatchObject({ session: "2026-10-14", calendar: "WEEKDAYS" });
  });

  it("refuses a negative bound", () => {
    expect(() => new EodFinalityPolicy({ sessionRetryMs: -1 })).toThrow();
  });

  it("answers whether a date is a scheduled session, and says so when the schedule cannot", async () => {
    const policy = new EodFinalityPolicy({
      calendar: holidayCalendar(["2026-04-03"]),
    });
    expect(await policy.isScheduledSession("NYSE", "2026-04-02")).toBe(true);
    expect(await policy.isScheduledSession("NYSE", "2026-04-03")).toBe(false);
    expect(await policy.isScheduledSession("NYSE", "2026-04-04")).toBe(false);
    const unreadable = new EodFinalityPolicy({
      calendar: {
        async isTradingSession() {
          throw new Error("schedule unavailable");
        },
      },
    });
    expect(
      await unreadable.isScheduledSession("NYSE", "2026-04-03"),
    ).toBeUndefined();
  });

  it("asks about a past year the schedule cannot answer at most once an hour, and the current year every time", async () => {
    let now = new Date("2026-10-14T21:00:00.000Z");
    const asked: string[] = [];
    const policy = new EodFinalityPolicy({
      now: () => now,
      calendar: {
        async isTradingSession(_exchange, date) {
          asked.push(date);
          if (date.startsWith("2001-") || date.startsWith("2026-")) {
            throw new Error("no schedule");
          }
          return true;
        },
      },
    });
    for (const date of ["2001-04-12", "2001-07-05", "2001-12-27"]) {
      expect(await policy.isScheduledSession("NYSE", date)).toBeUndefined();
    }
    expect(await policy.isScheduledSession("NYSE", "2002-03-28")).toBe(true);
    expect(
      await policy.isScheduledSession("NYSE", "2026-04-02"),
    ).toBeUndefined();
    expect(
      await policy.isScheduledSession("NYSE", "2026-04-03"),
    ).toBeUndefined();
    expect(asked).toEqual([
      "2001-04-12",
      "2002-03-28",
      "2026-04-02",
      "2026-04-03",
    ]);

    now = new Date(now.getTime() + 59 * MINUTE);
    expect(
      await policy.isScheduledSession("NYSE", "2001-04-12"),
    ).toBeUndefined();
    expect(asked).toHaveLength(4);
    now = new Date(now.getTime() + 2 * MINUTE);
    expect(
      await policy.isScheduledSession("NYSE", "2001-04-12"),
    ).toBeUndefined();
    expect(asked).toHaveLength(5);
  });
});

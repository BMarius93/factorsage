import type { FmpExchangeHoliday } from "@intrinsic/fmp";
import { describe, expect, it } from "vitest";
import {
  CachedTradingCalendar,
  TradingCalendarUnavailableError,
  isSupportedExchange,
  isWeekend,
} from "./trading-calendar.js";

/**
 * The exchange-session boundary.
 *
 * It answers one question — did this venue open at all — and the tests hold it to exactly that: an
 * early close is a session, a full closure is not, and "we could not find out" is neither.
 */

class RecordingProvider {
  calls: string[] = [];
  failures = 0;
  failNext = 0;
  /** A plausible full year by default, so tests opt in to a degenerate one deliberately. */
  holidays: FmpExchangeHoliday[] = fullYear(2026);
  /** Resolves when the test releases it, so concurrent callers can be observed mid-flight. */
  gate: { promise: Promise<void>; release: () => void } | null = null;

  async getExchangeHolidays(
    exchangeCode: string,
    from: string,
    to: string,
  ): Promise<FmpExchangeHoliday[]> {
    this.calls.push(`${exchangeCode} ${from}..${to}`);
    if (this.gate) {
      await this.gate.promise;
    }
    if (this.failNext > 0) {
      this.failNext -= 1;
      this.failures += 1;
      throw new Error("provider unavailable");
    }
    return this.holidays;
  }
}

/** Ten full closures, the shape of a real US equity year. */
function fullYear(year: number): FmpExchangeHoliday[] {
  return [
    `${year}-01-01`,
    `${year}-01-19`,
    `${year}-02-16`,
    `${year}-04-03`,
    `${year}-05-25`,
    `${year}-06-19`,
    `${year}-07-03`,
    `${year}-09-07`,
    `${year}-11-26`,
    `${year}-12-25`,
  ].map((date) => ({ date, fullClose: true }));
}

function openGate() {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("isWeekend", () => {
  it("is timezone-independent for a bare product date", () => {
    expect(isWeekend("2026-03-07")).toBe(true); // Saturday
    expect(isWeekend("2026-03-08")).toBe(true); // Sunday
    expect(isWeekend("2026-03-06")).toBe(false); // Friday
    expect(isWeekend("2026-03-09")).toBe(false); // Monday
  });
});

describe("isSupportedExchange", () => {
  it("recognises the admitted venues and nothing else", () => {
    expect(isSupportedExchange("NASDAQ")).toBe(true);
    expect(isSupportedExchange("nyse")).toBe(true);
    expect(isSupportedExchange(" AMEX ")).toBe(true);
    expect(isSupportedExchange("LSE")).toBe(false);
  });
});

describe("CachedTradingCalendar", () => {
  it("reports a full closure as no session", async () => {
    const calendar = new CachedTradingCalendar(new RecordingProvider());

    expect(await calendar.isTradingSession("NASDAQ", "2026-01-01")).toBe(false);
    expect(await calendar.isTradingSession("NASDAQ", "2026-01-02")).toBe(true);
  });

  it("treats an early close as an ordinary session", async () => {
    const provider = new RecordingProvider();
    // The venue opened and closed sooner. Nothing about a daily bar changes, so it is not filtered.
    provider.holidays = [
      ...fullYear(2026),
      { date: "2026-11-27", name: "Day After Thanksgiving", fullClose: false },
    ];
    const calendar = new CachedTradingCalendar(provider);

    expect(await calendar.isTradingSession("NASDAQ", "2026-11-27")).toBe(true);
  });

  it("asks from the day before the year, because the provider's `from` is exclusive", async () => {
    const provider = new RecordingProvider();
    const calendar = new CachedTradingCalendar(provider);

    await calendar.isTradingSession("NASDAQ", "2026-06-15");

    // Verified live: `from` filters strictly greater-than. Asking from 2026-01-01 returns a
    // schedule starting 2026-01-19 and silently drops New Year's Day — the one full closure that
    // happens every year, and so the one most certain to be missed.
    expect(provider.calls).toEqual(["NASDAQ 2025-12-31..2026-12-31"]);
    expect(await calendar.isTradingSession("NASDAQ", "2026-01-01")).toBe(false);
  });

  it("refuses a schedule with implausibly few closures rather than reading it as open", async () => {
    const provider = new RecordingProvider();
    // An empty array is a valid array. Accepting it would mean "open every weekday all year".
    provider.holidays = [];
    const calendar = new CachedTradingCalendar(provider);

    await expect(
      calendar.isTradingSession("NASDAQ", "2026-06-15"),
    ).rejects.toBeInstanceOf(TradingCalendarUnavailableError);
  });

  it("ignores rows outside the requested year", async () => {
    const provider = new RecordingProvider();
    provider.holidays = [
      { date: "2025-12-25", fullClose: true },
      ...fullYear(2026),
    ];
    const calendar = new CachedTradingCalendar(provider);

    // The range starts the day before the year, so a stray earlier row must not join the schedule.
    expect(await calendar.isTradingSession("NASDAQ", "2026-01-01")).toBe(false);
    expect(await calendar.isTradingSession("NASDAQ", "2026-06-15")).toBe(true);
  });

  it("serves a schedule already in hand when a refetch fails", async () => {
    const provider = new RecordingProvider();
    let now = new Date("2026-03-02T12:00:00.000Z");
    const calendar = new CachedTradingCalendar(provider, {
      now: () => now,
      scheduleTtlMs: 60_000,
    });

    expect(await calendar.isTradingSession("NASDAQ", "2026-01-01")).toBe(false);

    // A non-retryable failure — a plan that no longer covers the endpoint — must not stop
    // monitoring permanently while a perfectly good copy of this year sits in memory. A published
    // schedule for a year in progress does not change, and real data is not a guess.
    now = new Date(now.getTime() + 120_000);
    provider.failNext = 1;
    expect(await calendar.isTradingSession("NASDAQ", "2026-01-01")).toBe(false);
    expect(await calendar.isTradingSession("NASDAQ", "2026-01-02")).toBe(true);
    expect(provider.failures).toBe(1);
  });

  it("answers a weekend without asking the provider", async () => {
    const provider = new RecordingProvider();
    const calendar = new CachedTradingCalendar(provider);

    expect(await calendar.isTradingSession("NASDAQ", "2026-03-07")).toBe(false);
    expect(provider.calls).toEqual([]);
  });

  it("reports no session for a venue outside the admitted universe", async () => {
    const provider = new RecordingProvider();
    const calendar = new CachedTradingCalendar(provider);

    // Contained rather than guessed: the security becomes NOT_EVALUABLE, and no request is made
    // for a venue this boundary has no schedule for.
    expect(await calendar.isTradingSession("LSE", "2026-03-02")).toBe(false);
    expect(provider.calls).toEqual([]);
  });

  it("fetches one schedule per exchange and year", async () => {
    const provider = new RecordingProvider();
    const calendar = new CachedTradingCalendar(provider);

    provider.holidays = [...fullYear(2026), ...fullYear(2027)];
    await calendar.isTradingSession("NASDAQ", "2026-03-02");
    await calendar.isTradingSession("NASDAQ", "2026-03-03");
    await calendar.isTradingSession("NASDAQ", "2026-06-15");
    await calendar.isTradingSession("NYSE", "2026-03-02");
    await calendar.isTradingSession("NASDAQ", "2027-03-02");

    expect(provider.calls).toEqual([
      "NASDAQ 2025-12-31..2026-12-31",
      "NYSE 2025-12-31..2026-12-31",
      "NASDAQ 2026-12-31..2027-12-31",
    ]);
  });

  it("collapses concurrent callers onto one request", async () => {
    const provider = new RecordingProvider();
    provider.gate = openGate();
    const calendar = new CachedTradingCalendar(provider);

    // A cycle's bounded symbol concurrency would otherwise start one fetch per symbol on a cold
    // calendar; the single-flight is what makes "one request per exchange" true under concurrency.
    const pending = Promise.all([
      calendar.isTradingSession("NASDAQ", "2026-03-02"),
      calendar.isTradingSession("NASDAQ", "2026-03-03"),
      calendar.isTradingSession("NASDAQ", "2026-03-04"),
    ]);
    provider.gate.release();
    expect(await pending).toEqual([true, true, true]);
    expect(provider.calls).toHaveLength(1);
  });

  it("refetches once the schedule's lifetime has passed", async () => {
    const provider = new RecordingProvider();
    let now = new Date("2026-03-02T12:00:00.000Z");
    const calendar = new CachedTradingCalendar(provider, {
      now: () => now,
      scheduleTtlMs: 60_000,
    });

    await calendar.isTradingSession("NASDAQ", "2026-03-02");
    now = new Date(now.getTime() + 30_000);
    await calendar.isTradingSession("NASDAQ", "2026-03-03");
    expect(provider.calls).toHaveLength(1);

    now = new Date(now.getTime() + 61_000);
    await calendar.isTradingSession("NASDAQ", "2026-03-04");
    expect(provider.calls).toHaveLength(2);
  });

  it("throws rather than reporting an open session it could not verify", async () => {
    const provider = new RecordingProvider();
    provider.failNext = 1;
    const calendar = new CachedTradingCalendar(provider);

    // The dangerous failure mode is a silent empty schedule, which reads as "open every day".
    await expect(
      calendar.isTradingSession("NASDAQ", "2026-03-02"),
    ).rejects.toBeInstanceOf(TradingCalendarUnavailableError);
  });

  it("does not cache a failure, and recovers on the next call", async () => {
    const provider = new RecordingProvider();
    provider.failNext = 1;
    const calendar = new CachedTradingCalendar(provider);

    await expect(
      calendar.isTradingSession("NASDAQ", "2026-01-02"),
    ).rejects.toBeInstanceOf(TradingCalendarUnavailableError);

    expect(await calendar.isTradingSession("NASDAQ", "2026-01-02")).toBe(true);
    expect(await calendar.isTradingSession("NASDAQ", "2026-01-01")).toBe(false);
    expect(provider.calls).toHaveLength(2);
  });
});

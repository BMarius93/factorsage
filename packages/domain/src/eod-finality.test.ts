import { describe, expect, it } from "vitest";
import {
  DEFAULT_EOD_PUBLICATION_DELAY_MS,
  eodCutoffDate,
  eodSessionFinalizedAt,
  isEodSessionFinal,
} from "./eod-finality.js";

const DELAY = DEFAULT_EOD_PUBLICATION_DELAY_MS;

describe("EOD finality clock", () => {
  it("finalizes a session thirty minutes after its 16:00 New York close", () => {
    // EDT (UTC-4): the close is 20:00Z.
    expect(eodSessionFinalizedAt("2026-10-14", DELAY).toISOString()).toBe(
      "2026-10-14T20:30:00.000Z",
    );
    // EST (UTC-5): the close is 21:00Z.
    expect(eodSessionFinalizedAt("2026-12-14", DELAY).toISOString()).toBe(
      "2026-12-14T21:30:00.000Z",
    );
  });

  it("keeps the previous day as the cutoff until the session's close plus the delay", () => {
    expect(eodCutoffDate(new Date("2026-10-14T13:30:00.000Z"), DELAY)).toBe(
      "2026-10-13",
    );
    // At the close itself, inside the publication delay, the bar is still not final.
    expect(eodCutoffDate(new Date("2026-10-14T20:00:00.000Z"), DELAY)).toBe(
      "2026-10-13",
    );
    expect(eodCutoffDate(new Date("2026-10-14T20:29:59.999Z"), DELAY)).toBe(
      "2026-10-13",
    );
    expect(eodCutoffDate(new Date("2026-10-14T20:30:00.000Z"), DELAY)).toBe(
      "2026-10-14",
    );
  });

  it("names the New York day, not the UTC day, in the evening", () => {
    // 22:00 New York on the 14th is already the 15th in UTC.
    expect(eodCutoffDate(new Date("2026-10-15T02:00:00.000Z"), DELAY)).toBe(
      "2026-10-14",
    );
    // 23:59 New York on 14 December (EST) is 04:59Z on the 15th.
    expect(eodCutoffDate(new Date("2026-12-15T04:59:00.000Z"), DELAY)).toBe(
      "2026-12-14",
    );
  });

  it("is a calendar date, not a session: a Saturday evening names the Saturday", () => {
    expect(eodCutoffDate(new Date("2026-10-17T15:00:00.000Z"), DELAY)).toBe(
      "2026-10-16",
    );
    expect(eodCutoffDate(new Date("2026-10-17T21:00:00.000Z"), DELAY)).toBe(
      "2026-10-17",
    );
  });

  it("is exact on the first trading day after a daylight-saving change", () => {
    // DST began on 8 March 2026: Monday the 9th closes at 20:00Z, not 21:00Z.
    expect(eodSessionFinalizedAt("2026-03-09", DELAY).toISOString()).toBe(
      "2026-03-09T20:30:00.000Z",
    );
    expect(eodCutoffDate(new Date("2026-03-09T20:15:00.000Z"), DELAY)).toBe(
      "2026-03-08",
    );
    expect(eodCutoffDate(new Date("2026-03-09T20:30:00.000Z"), DELAY)).toBe(
      "2026-03-09",
    );
    // DST ended on 1 November 2026: Monday the 2nd closes at 21:00Z.
    expect(eodSessionFinalizedAt("2026-11-02", DELAY).toISOString()).toBe(
      "2026-11-02T21:30:00.000Z",
    );
    expect(eodCutoffDate(new Date("2026-11-02T20:45:00.000Z"), DELAY)).toBe(
      "2026-11-01",
    );
  });

  it("honours other delays, including none and more than a day", () => {
    expect(eodCutoffDate(new Date("2026-10-14T20:00:00.000Z"), 0)).toBe(
      "2026-10-14",
    );
    const twoDays = 2 * 24 * 60 * 60 * 1000;
    expect(eodCutoffDate(new Date("2026-10-14T21:00:00.000Z"), twoDays)).toBe(
      "2026-10-12",
    );
  });

  it("answers finality for one session", () => {
    expect(
      isEodSessionFinal(
        "2026-10-14",
        new Date("2026-10-14T20:29:00.000Z"),
        DELAY,
      ),
    ).toBe(false);
    expect(
      isEodSessionFinal(
        "2026-10-14",
        new Date("2026-10-14T20:30:00.000Z"),
        DELAY,
      ),
    ).toBe(true);
  });

  it("refuses a negative delay and an invalid instant", () => {
    expect(() => eodCutoffDate(new Date(), -1)).toThrow();
    expect(() => eodCutoffDate(new Date(Number.NaN), DELAY)).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { monitorStateSince } from "./signal-since";

/** A `@db.Date` column reads back as UTC midnight, which is what the services pass in. */
const session = (date: string): Date => new Date(`${date}T00:00:00.000Z`);

describe("monitorStateSince", () => {
  it("dates a reconstructed state at its own session, not at the scan that found it", () => {
    // AUD-05's example: a match reconstructed 49 days later showed as minutes old.
    const since = monitorStateSince({
      observationDate: session("2026-07-30"),
      enteredAt: new Date("2026-09-17T13:02:11.000Z"),
    });

    expect(since).toBe("2026-07-30T20:00:00.000Z");
  });

  it("dates a state found during the session at the scan, never at a close still to come", () => {
    const since = monitorStateSince({
      observationDate: session("2026-09-17"),
      enteredAt: new Date("2026-09-17T17:35:00.000Z"),
    });

    expect(since).toBe("2026-09-17T17:35:00.000Z");
  });

  it("keeps the session close once the session has closed", () => {
    // The same state, persisted again after the close by a later cycle: the beginning does not move.
    const since = monitorStateSince({
      observationDate: session("2026-09-17"),
      enteredAt: new Date("2026-09-17T20:45:00.000Z"),
    });

    expect(since).toBe("2026-09-17T20:00:00.000Z");
  });

  it("uses the winter offset for a winter session", () => {
    expect(
      monitorStateSince({
        observationDate: session("2026-01-15"),
        enteredAt: new Date("2026-02-01T10:00:00.000Z"),
      }),
    ).toBe("2026-01-15T21:00:00.000Z");
  });

  it("falls back to the write instant when no observation was recorded", () => {
    expect(
      monitorStateSince({
        observationDate: null,
        enteredAt: new Date("2026-09-17T13:02:11.000Z"),
      }),
    ).toBe("2026-09-17T13:02:11.000Z");
  });

  it("is monotone in the session it is given", () => {
    const later = monitorStateSince({
      observationDate: session("2026-09-17"),
      enteredAt: new Date("2026-09-30T10:00:00.000Z"),
    });
    const earlier = monitorStateSince({
      observationDate: session("2026-09-16"),
      enteredAt: new Date("2026-09-30T10:00:00.000Z"),
    });

    expect(earlier < later).toBe(true);
  });
});

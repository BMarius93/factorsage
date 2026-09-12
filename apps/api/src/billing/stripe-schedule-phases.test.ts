import { describe, expect, it } from "vitest";
import { selectCurrentPhase } from "./stripe.gateway";

/**
 * Regression coverage for Subscription Schedule phase selection.
 *
 * This is here because the obvious implementation — take the schedule's *last* phase — is correct
 * exactly until a change is already scheduled, and then it is wrong in a way that only real Stripe
 * reports: pinning the future phase as the current one yields `start_date == end_date`, and Stripe
 * answers "Each phase must be at minimum 1 second long". It reproduced every time a user scheduled
 * a cadence change and then scheduled something else.
 *
 * The fake gateway cannot catch this — it models a schedule's *outcome* (one pending phase), not
 * Stripe's phase arithmetic. A pure unit test on the selection itself is what makes the bug
 * un-reintroducible without needing Stripe at all.
 */

const DAY = 86_400;

describe("selectCurrentPhase", () => {
  const now = new Date("2026-09-12T00:00:00.000Z");
  const nowSeconds = Math.floor(now.getTime() / 1000);

  it("returns the only phase of a freshly created schedule", () => {
    const phases = [{ start_date: nowSeconds - DAY, end_date: nowSeconds + 30 * DAY }];
    expect(selectCurrentPhase(phases, now)).toBe(phases[0]);
  });

  it("returns the phase containing now, not the future one", () => {
    // The exact shape that produced the zero-length phase: a yearly phase in progress plus an
    // already-scheduled monthly phase after it.
    const current = { start_date: nowSeconds - 30 * DAY, end_date: nowSeconds + 335 * DAY };
    const future = { start_date: nowSeconds + 335 * DAY, end_date: nowSeconds + 365 * DAY };
    const phases = [current, future];

    expect(selectCurrentPhase(phases, now)).toBe(current);
    expect(selectCurrentPhase(phases, now)).not.toBe(future);
  });

  it("never returns a phase that would make start_date equal end_date", () => {
    const boundary = nowSeconds + 335 * DAY;
    const phases = [
      { start_date: nowSeconds - 30 * DAY, end_date: boundary },
      { start_date: boundary, end_date: boundary + 30 * DAY },
    ];
    const selected = selectCurrentPhase(phases, now);
    expect(selected?.start_date).toBeLessThan(boundary);
  });

  it("ignores phases that have already ended", () => {
    const past = { start_date: nowSeconds - 90 * DAY, end_date: nowSeconds - 60 * DAY };
    const current = { start_date: nowSeconds - 60 * DAY, end_date: nowSeconds + 30 * DAY };
    expect(selectCurrentPhase([past, current], now)).toBe(current);
  });

  it("treats a final open-ended phase as current once it has started", () => {
    const phases = [
      { start_date: nowSeconds - 60 * DAY, end_date: nowSeconds - 30 * DAY },
      { start_date: nowSeconds - 30 * DAY, end_date: null },
    ];
    expect(selectCurrentPhase(phases, now)).toBe(phases[1]);
  });

  it("falls back to the earliest phase when none contains now", () => {
    // A schedule that has not started. Stripe will reject a nonsensical window, which is better
    // than this function inventing one.
    const phases = [
      { start_date: nowSeconds + DAY, end_date: nowSeconds + 30 * DAY },
      { start_date: nowSeconds + 30 * DAY, end_date: nowSeconds + 60 * DAY },
    ];
    expect(selectCurrentPhase(phases, now)).toBe(phases[0]);
  });

  it("returns undefined for a schedule with no phases", () => {
    expect(selectCurrentPhase([], now)).toBeUndefined();
  });
});

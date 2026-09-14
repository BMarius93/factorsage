import { describe, expect, it } from "vitest";
import { hasScheduledCancellation } from "./stripe-gateway";

/**
 * Regression coverage for reading a scheduled cancellation out of a Stripe subscription.
 *
 * The obvious implementation — copy `cancel_at_period_end` — is correct exactly until Customer
 * Portal is the thing doing the cancelling. On the pinned API version a Portal cancellation comes
 * back as:
 *
 * ```text
 * cancel_at_period_end = false
 * cancel_at            = <end of the paid period>
 * canceled_at          = <when the customer asked>
 * ```
 *
 * Copying the flag alone therefore reported "Renews on …" for a subscription Stripe's own Portal was
 * showing as "Cancels on …", and it disarmed the guard that refuses a plan change on a subscription
 * already on its way out. Sandbox verification is where it surfaced; this is what makes it
 * un-reintroducible without Stripe.
 */

const PERIOD_END = new Date("2027-09-14T05:39:36.000Z");

describe("hasScheduledCancellation", () => {
  it("recognises the Customer Portal representation: an instant, with the flag false", () => {
    expect(
      hasScheduledCancellation({ cancelAtPeriodEnd: false, cancelAt: PERIOD_END }),
    ).toBe(true);
  });

  it("still recognises the flag representation", () => {
    expect(
      hasScheduledCancellation({ cancelAtPeriodEnd: true, cancelAt: null }),
    ).toBe(true);
    expect(
      hasScheduledCancellation({ cancelAtPeriodEnd: true, cancelAt: PERIOD_END }),
    ).toBe(true);
  });

  it("reports no cancellation for a subscription that simply renews", () => {
    expect(
      hasScheduledCancellation({ cancelAtPeriodEnd: false, cancelAt: null }),
    ).toBe(false);
  });
});

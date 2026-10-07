"use strict";

/**
 * The valuation audit's pinned clock: preloaded into the hermetic API the `http` comparison reads
 * (`NODE_OPTIONS=--require=…/pinned-clock.cjs VALUATION_AUDIT_NOW=<instant>`), so that API sees the
 * frozen audit copy as the day it was frozen.
 *
 * The copy's prices, statements and split lists stop at the day they were copied. Read on a later
 * day, the API rightly finds the newest sessions missing and asks the provider for them — on the
 * hermetic stack the fixture server, which has no rows for real securities, so every answer is a
 * 503 and nothing is compared. The `real` comparison avoids that by pinning each service's clock to
 * the security's own coverage end; one API process can only have one clock, so this pins it to the
 * instant the copy was current. Every elapsed time stays real: only the wall clock is shifted.
 *
 * Audit-only, like the E2E egress guard it runs beside: nothing in an application imports it, and
 * no process outside the audit's `http` run sets `VALUATION_AUDIT_NOW`. Without it this does nothing.
 */

const pinned = process.env.VALUATION_AUDIT_NOW;

if (pinned) {
  const target = Date.parse(pinned);
  if (!Number.isFinite(target)) {
    throw new Error("VALUATION_AUDIT_NOW must be an ISO-8601 instant");
  }
  const RealDate = Date;
  const offset = target - RealDate.now();
  const now = () => RealDate.now() + offset;

  class PinnedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(now());
      } else {
        super(...args);
      }
    }

    static now() {
      return now();
    }
  }

  // `Date()` called without `new` returns the current time as a string.
  globalThis.Date = new Proxy(PinnedDate, {
    apply() {
      return new PinnedDate().toString();
    },
  });
}

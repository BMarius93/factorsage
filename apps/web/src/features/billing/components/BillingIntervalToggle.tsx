"use client";

import { BILLING_INTERVALS, type BillingInterval } from "@intrinsic/contracts";
import { INTERVAL_LABEL } from "../utils/format";
import styles from "./BillingPage.module.css";

type BillingIntervalToggleProps = {
  readonly value: BillingInterval;
  readonly onChange: (interval: BillingInterval) => void;
};

/**
 * Monthly or yearly, for the whole pricing comparison.
 *
 * A real radio group rather than two buttons with `aria-pressed`: the browser then supplies arrow-key
 * movement, roving focus and the "selected, 1 of 2" announcement for free, and the selected cadence
 * is exposed as *selection* rather than as a pressed state — which is what it is. The radios are
 * visually hidden rather than removed, so focus, `:focus-visible` and form semantics all survive
 * the pill styling.
 *
 * It wears the shared `SegmentedControl`'s look (PR-2) — its pills, its hover and its tinted chosen
 * option, composed from that component's stylesheet in `BillingPage.module.css` and switched by
 * the same `data-active` attribute — rather than a solid-blue slab beside the page's one solid
 * action. Only the look is shared: that component is a row of `aria-pressed` buttons, and the
 * cadence keeps its radios.
 *
 * It changes nothing but which of the four catalog prices each card offers. The cadence is never
 * sent on its own: a card's button carries the resolved logical price key, so what the page shows
 * and what the API is asked for cannot disagree.
 */
export function BillingIntervalToggle({
  value,
  onChange,
}: BillingIntervalToggleProps) {
  return (
    <div
      className={styles.segmented}
      role="radiogroup"
      aria-label="Billing interval"
      data-testid="billing-interval-toggle"
    >
      {BILLING_INTERVALS.map((interval) => (
        <label
          key={interval}
          className={styles.segment}
          data-active={interval === value ? "true" : undefined}
        >
          <input
            className={styles.segmentInput}
            type="radio"
            name="billing-interval"
            value={interval}
            checked={interval === value}
            onChange={() => onChange(interval)}
            data-testid={`billing-interval-${interval}`}
          />
          {INTERVAL_LABEL[interval]}
        </label>
      ))}
    </div>
  );
}

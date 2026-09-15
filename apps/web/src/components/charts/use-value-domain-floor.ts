"use client";

import type { AutoscaleInfo, AutoscaleInfoProvider } from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef } from "react";

/** An inclusive span on a value axis. */
export type ValueSpan = { readonly min: number; readonly max: number };

/** The smallest span containing both, ignoring absent ones. */
export function unionSpan(
  left: ValueSpan | null,
  right: ValueSpan | null,
): ValueSpan | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return {
    min: Math.min(left.min, right.min),
    max: Math.max(left.max, right.max),
  };
}

export type ValueDomainFloor = {
  /**
   * The series option. One stable function for the life of the chart, so applying it never
   * rewrites a series' options and never costs a redraw.
   */
  readonly autoscaleInfoProvider: AutoscaleInfoProvider;
  /** Forgets everything accumulated. The next frame starts again from the seed. */
  readonly reset: () => void;
};

export type ValueDomainFloorInput = {
  /**
   * The span the axis should already cover before any data arrives, or `null` when nothing about
   * the axis is known in advance.
   */
  readonly seed: ValueSpan | null;
  /**
   * While `false` the library's own autoscale is returned untouched, so zooming into a finished
   * series rescales the way a reader expects. While `true` the axis may only ever grow.
   */
  readonly enforced: boolean;
  /** Changing this forgets the accumulated floor: a different subject gets a different axis. */
  readonly resetKey: string;
};

/**
 * A value axis that only ever grows while data is still arriving.
 *
 * The problem it solves is a chart being populated in chunks: the default autoscale fits whatever
 * is currently drawn, so every arriving chunk rescales and recentres the axis and the lines appear
 * to writhe rather than extend. Fixing the axis outright is not an option either — a later value
 * that genuinely exceeds the prepared range must be drawn, not clipped.
 *
 * So the axis is a floor rather than a fixed range. It starts at `seed`, it is unioned with every
 * range the library computes while `enforced`, and it is never allowed to narrow. A chunk that
 * stays inside what is already shown changes nothing; a chunk that exceeds it widens the axis once
 * and keeps it. Because the union always contains the library's own answer, no value is ever
 * clipped — this can only ever show *more* than the default would.
 *
 * `enforced` is released when the data stops arriving, which hands the axis back to the library
 * for good: the accumulated floor by then describes the completed series anyway, so releasing it
 * costs no jump and makes zooming behave normally again.
 */
export function useValueDomainFloor(
  input: ValueDomainFloorInput,
): ValueDomainFloor {
  const { seed, enforced, resetKey } = input;
  const floorRef = useRef<ValueSpan | null>(null);
  const seedRef = useRef<ValueSpan | null>(seed);
  const enforcedRef = useRef(enforced);
  // Read inside the provider, which the library calls during its own render pass rather than
  // from React, so both have to be refs rather than closed-over props.
  seedRef.current = seed;
  enforcedRef.current = enforced;

  const reset = useCallback(() => {
    floorRef.current = null;
  }, []);

  // A different subject — another run, another security — must not inherit the previous axis.
  useEffect(() => {
    floorRef.current = null;
  }, [resetKey]);

  const autoscaleInfoProvider = useMemo<AutoscaleInfoProvider>(
    () =>
      (baseImplementation: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const base = baseImplementation();
        if (!enforcedRef.current) {
          return base;
        }
        // Accumulating here rather than from the data write is deliberate: the library hands us
        // exactly the range it was going to use, so the floor is always expressed in the same
        // terms as the thing it is replacing, and a series this provider is not attached to still
        // contributes through the pane's own union of every source.
        const observed = base?.priceRange
          ? { min: base.priceRange.minValue, max: base.priceRange.maxValue }
          : null;
        const widened = unionSpan(
          unionSpan(floorRef.current, seedRef.current),
          observed,
        );
        if (!widened) {
          return base;
        }
        floorRef.current = widened;
        return {
          priceRange: { minValue: widened.min, maxValue: widened.max },
          ...(base?.margins ? { margins: base.margins } : {}),
        };
      },
    [],
  );

  return { autoscaleInfoProvider, reset };
}

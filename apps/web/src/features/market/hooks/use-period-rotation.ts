"use client";

import {
  MARKET_OVERVIEW_PERIODS,
  type MarketOverviewPeriod,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  useDocumentVisible,
  useMediaQuery,
} from "../../../lib/use-media-query";

/** How long Market watch shows each period before Auto moves to the next. */
export const MARKET_WATCH_ROTATION_MS = 10_000;

/** `1W → 1M → 3M → 6M → YTD → 1Y → 1W …`: the contract's own display order, wrapping. */
export function nextPeriod(period: MarketOverviewPeriod): MarketOverviewPeriod {
  const index = MARKET_OVERVIEW_PERIODS.indexOf(period);
  return MARKET_OVERVIEW_PERIODS[
    (index + 1) % MARKET_OVERVIEW_PERIODS.length
  ] as MarketOverviewPeriod;
}

export type PeriodRotation = {
  /** The one period every row shows: its return and its line. */
  readonly period: MarketOverviewPeriod;
  /** Whether Auto is on — the reader's mode, whether or not the timer is counting right now. */
  readonly auto: boolean;
  /** Whether the timer is counting right now: Auto is on, the page is visible and nothing holds it. */
  readonly rotating: boolean;
  /** A period the reader chose. Pauses Auto, so what they chose stays on screen. */
  readonly select: (period: MarketOverviewPeriod) => void;
  /** Turns Auto on or off. Turning it on counts a full interval from the period on screen. */
  readonly setAuto: (on: boolean) => void;
  /**
   * Holds the rotation while keyboard focus is inside Market watch, so a keyboard reader moving
   * through the period buttons is never moved under. Releasing it starts a full interval again.
   */
  readonly setHeld: (held: boolean) => void;
};

/**
 * The Market watch period, and the **one** timer that rotates it.
 *
 * - One `setTimeout` at a time for the whole sidebar, re-armed on every period change, so all twenty
 *   rows change together and a chosen or resumed period always gets its full ten seconds.
 * - Changing the period is state only: the response already holds every period's return and line,
 *   so a rotation makes no request.
 * - It stops while the tab is hidden (`visibilitychange`), while keyboard focus is inside and while
 *   there is nothing to rotate (loading, failed), and it is cleared on unmount — crossing below the desktop breakpoint unmounts Market watch and
 *   with it the timer.
 * - **Reduced motion.** A reader who asked the system for less motion gets Auto **off** to begin
 *   with: a list that changes by itself every ten seconds is the kind of movement that setting is
 *   about. The Auto control is still there to turn it on. A choice the reader makes overrides the
 *   default either way.
 */
export function usePeriodRotation(
  /** Whether there is anything to rotate: false while the list is loading or failed. */
  active = true,
  intervalMs: number = MARKET_WATCH_ROTATION_MS,
): PeriodRotation {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const visible = useDocumentVisible();
  const [period, setPeriod] = useState<MarketOverviewPeriod>(
    MARKET_OVERVIEW_PERIODS[0],
  );
  // `null` until the reader chooses: the default follows the reduced-motion preference.
  const [choice, setChoice] = useState<boolean | null>(null);
  const [held, setHeld] = useState(false);

  const auto = choice ?? !reducedMotion;
  const rotating = active && auto && visible && !held;

  useEffect(() => {
    if (!rotating) {
      return;
    }
    const timer = window.setTimeout(
      () => setPeriod((current) => nextPeriod(current)),
      intervalMs,
    );
    return () => window.clearTimeout(timer);
  }, [rotating, period, intervalMs]);

  const select = useCallback((next: MarketOverviewPeriod) => {
    setPeriod(next);
    setChoice(false);
  }, []);
  const setAuto = useCallback((on: boolean) => setChoice(on), []);

  return { period, auto, rotating, select, setAuto, setHeld };
}

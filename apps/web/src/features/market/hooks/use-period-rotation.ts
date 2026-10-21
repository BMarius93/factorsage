"use client";

import {
  MARKET_OVERVIEW_PERIODS,
  type MarketOverviewPeriod,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useDocumentVisible,
  useMediaQuery,
} from "../../../lib/use-media-query";

/** How long Market watch shows each period before it moves to the next, swap to swap. */
export const MARKET_WATCH_ROTATION_MS = 8_000;

/**
 * The automatic change's two halves: the values and lines dim, the period swaps while they are
 * dim, and they come back. About 670ms in all, so the change is seen rather than read as a jump.
 */
export const MARKET_WATCH_FADE_OUT_MS = 250;
export const MARKET_WATCH_FADE_IN_MS = 420;

/**
 * Where an automatic change is:
 *
 * - `idle` — nothing is moving;
 * - `out` — the values and lines are dimming; the old period is still on screen;
 * - `in` — the new period is on screen and they are coming back to full strength.
 */
export type RotationPhase = "idle" | "out" | "in";

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
  /**
   * Whether automatic rotation is still on for this page: false once the reader chose a period,
   * and for a reader who prefers reduced motion.
   */
  readonly auto: boolean;
  /** Whether the timer is counting right now: rotation is on and nothing pauses it. */
  readonly rotating: boolean;
  /** Where an automatic change is; always `idle` after a choice the reader made. */
  readonly phase: RotationPhase;
  /**
   * The period the rotation has just moved to, for the selector's one soft highlight; `null` until
   * the first automatic change and after a choice the reader made.
   */
  readonly arrived: MarketOverviewPeriod | null;
  /**
   * A period the reader chose — the one on screen included. Shown at once, and automatic rotation
   * stops for the rest of the page's life: there is no control that starts it again.
   */
  readonly select: (period: MarketOverviewPeriod) => void;
};

type RotationOptions = {
  /** Whether there is anything to rotate: false while the list is loading or failed. */
  readonly active?: boolean;
  /**
   * The reader is pointing at or working inside Market watch. Pauses the timer without turning
   * rotation off; when it is released the period on screen gets a full interval again.
   */
  readonly held?: boolean;
  readonly intervalMs?: number;
};

type RotationState = {
  readonly period: MarketOverviewPeriod;
  readonly phase: RotationPhase;
  readonly arrived: MarketOverviewPeriod | null;
};

const INITIAL_STATE: RotationState = {
  period: MARKET_OVERVIEW_PERIODS[0],
  phase: "idle",
  arrived: null,
};

/**
 * The Market watch period, and the timers that rotate it.
 *
 * - **One interval at a time** for the whole sidebar, re-armed on every period change, so all twenty
 *   rows change together and every period gets the same time on screen.
 * - **A change is staged, never overlapped.** The interval only starts the fade-out; the swap and
 *   the end of the fade-in follow on stage timers, each scheduled by the step before it, and the
 *   interval never starts a change while one is under way.
 * - **Changing the period is state only**: the response already holds every period's return and
 *   line, so a rotation makes no request.
 * - **Paused, not stopped**, while the tab is hidden (`visibilitychange`), while the reader points at
 *   or works inside Market watch (`held`) and while there is nothing to rotate (loading, failed).
 *   A change already under way finishes, so nothing is ever left dimmed.
 * - **Stopped for good** once the reader picks a period — even the one already shown. Their choice
 *   stays put; a new page load starts rotating again.
 * - **Reduced motion.** A reader who asked the system for less motion gets no automatic rotation at
 *   all — a list that changes by itself every few seconds is the movement that setting is about —
 *   and every period stays one click away.
 *
 * Every timer is cleared when its step is left and when Market watch unmounts — crossing below the
 * desktop breakpoint unmounts it — so nothing updates state after it is gone.
 */
export function usePeriodRotation({
  active = true,
  held = false,
  intervalMs = MARKET_WATCH_ROTATION_MS,
}: RotationOptions = {}): PeriodRotation {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const visible = useDocumentVisible();
  const [state, setState] = useState<RotationState>(INITIAL_STATE);
  const [chosen, setChosen] = useState(false);
  // The stage timers of the change under way: the swap, then the end of the fade-in. Each is
  // scheduled by the step before it, so their timing never waits on a render.
  const stages = useRef<number[]>([]);

  const auto = !chosen && !reducedMotion;
  const rotating = active && auto && visible && !held;

  const clearStages = useCallback(() => {
    for (const timer of stages.current) {
      window.clearTimeout(timer);
    }
    stages.current = [];
  }, []);

  const stage = useCallback((run: () => void, ms: number) => {
    const timer = window.setTimeout(() => {
      stages.current = stages.current.filter((one) => one !== timer);
      run();
    }, ms);
    stages.current.push(timer);
  }, []);

  // The interval: from one swap to the start of the next fade, so swaps are `intervalMs` apart.
  // Re-armed on every period change, and only ever starting a change when none is under way.
  useEffect(() => {
    if (!rotating) {
      return;
    }
    const timer = window.setTimeout(
      () => {
        if (stages.current.length > 0) {
          return;
        }
        setState((current) => ({ ...current, phase: "out" }));
        stage(() => {
          setState((current) => {
            const period = nextPeriod(current.period);
            return { period, phase: "in", arrived: period };
          });
          stage(
            () => setState((current) => ({ ...current, phase: "idle" })),
            MARKET_WATCH_FADE_IN_MS,
          );
        }, MARKET_WATCH_FADE_OUT_MS);
      },
      Math.max(0, intervalMs - MARKET_WATCH_FADE_OUT_MS),
    );
    return () => window.clearTimeout(timer);
  }, [rotating, state.period, intervalMs, stage]);

  // Nothing of a change under way outlives the component.
  useEffect(() => clearStages, [clearStages]);

  const select = useCallback(
    (period: MarketOverviewPeriod) => {
      // Cancels a change under way: the reader's choice replaces it, at full strength.
      clearStages();
      setChosen(true);
      setState({ period, phase: "idle", arrived: null });
    },
    [clearStages],
  );

  return {
    period: state.period,
    auto,
    rotating,
    phase: state.phase,
    arrived: state.arrived,
    select,
  };
}

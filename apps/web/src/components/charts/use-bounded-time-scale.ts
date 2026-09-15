"use client";

import type {
  IChartApi,
  LogicalRange as LibraryLogicalRange,
  Time,
} from "lightweight-charts";
import { useCallback, useEffect, useRef } from "react";
import {
  clampLogicalRange,
  leadBarsOf,
  type LogicalRange,
  type TimeDomain,
} from "./time-domain";

/**
 * Applies a {@link TimeDomain} to a Lightweight Charts instance.
 *
 * **The library does the bounding wherever it can.** `fixRightEdge` is what makes panning into the
 * future impossible, `fixLeftEdge` is what pins the oldest edge once nothing older can arrive, and
 * the two together make the library's own minimum bar spacing `width / points`, which is what
 * stops a zoom-out from opening empty space on either side. All three are refusals inside the
 * gesture, not corrections after it, so the viewport never visibly leaves the domain.
 *
 * One case the library cannot express is left over, and it is the reason this hook also clamps:
 * Stock Details deliberately allows the viewport past the oldest *drawn* bar, because that is how
 * the page asks for older history, while still forbidding it past the oldest *permitted* date.
 * That is a boundary between two things the library has no notion of, so it is enforced on the
 * range-change subscription — bounded by {@link leadBarsOf}, epsilon-guarded, and re-entrancy
 * guarded so a correction can never re-trigger itself.
 *
 * Programmatic movement goes through {@link BoundedTimeScale.applyFrame} rather than through the
 * time scale directly, so framing, reset and post-update re-assertion are one code path that is
 * bounded by construction.
 */
export type BoundedTimeScale = {
  /**
   * Binds a freshly created chart. Call it from the effect that creates the chart and return its
   * result as that effect's cleanup: it owns the range subscription and the initial option write.
   */
  readonly attachChart: (chart: IChartApi) => () => void;
  /** Shows exactly `[from, to]`. Both dates must be time points on the scale. */
  readonly showRange: (from: string, to: string) => void;
  /**
   * Shows `[from, to]`. Falls back to the library's own fit when the window reaches at or past the
   * oldest bar, because "everything drawn" is what that asks for and fitting is exact — a calendar
   * start rarely lands on a trading day, so naming it as a range would be approximate.
   */
  readonly applyFrame: (from: string, to: string) => void;
  /**
   * Re-asserts the viewport after a data write while the domain is locked.
   *
   * A locked chart is one whose data is still arriving. Lightweight Charts keeps the visible
   * *logical* range across `setData`, so a series that grew from 100 points to 360 would have the
   * same window cover a shrinking slice of time — the axis would appear to zoom in on every
   * checkpoint. Re-asserting the whole domain is what keeps the X viewport still while the lines
   * fill in. It is deliberately a no-op when unlocked: after that the viewport is the user's.
   *
   * It is the opposite of re-framing: the range written is the fixed domain the chart started
   * with, never anything derived from the data that just arrived, so the viewport cannot move.
   */
  readonly syncAfterData: () => void;
};

export type BoundedTimeScaleInput = {
  readonly domain: TimeDomain;
  /** Time points currently on the scale, including whitespace. The right-hand clamp bound. */
  readonly barCount: number;
  /** The window {@link BoundedTimeScale.applyFrame} restores, and that a locked chart holds. */
  readonly frame: { readonly from: string; readonly to: string };
  /**
   * The viewport after clamping. Never called with a range outside the domain; called with `null`
   * when the chart reports having no viewport at all, so a consumer publishing it can clear it.
   */
  readonly onVisibleRangeChange?: (range: LogicalRange | null) => void;
};

/** Chart options that follow purely from whether the domain is navigable. */
function interactionOptions(interaction: TimeDomain["interaction"]) {
  const locked = interaction === "LOCKED";
  return {
    // `false` disables every gesture at once — wheel, drag, touch drag, pinch, axis drag and
    // double-click reset. The library treats that combination as "all scrolling and scaling
    // disabled" and pins both edges itself, so a locked chart cannot be moved by any path.
    handleScroll: locked
      ? false
      : {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          // A vertical swipe on a phone keeps scrolling the page instead of being captured.
          vertTouchDrag: false,
        },
    handleScale: locked
      ? false
      : {
          mouseWheel: true,
          pinch: true,
          axisPressedMouseMove: { time: true, price: false },
          axisDoubleClickReset: { time: true, price: true },
        },
    // Momentum after a fling would keep moving the viewport after the gesture that is being
    // refused has ended; there is no such thing as a half-locked chart.
    kineticScroll: { touch: !locked, mouse: false },
  };
}

function timeScaleOptions(
  domainComplete: boolean,
  interaction: TimeDomain["interaction"],
) {
  return {
    // What stops a gesture opening empty space after the newest observation — and it is precisely
    // the *newest observation*, not the newest time point: the library pins the right edge to the
    // last index any series has a value at, so trailing whitespace is unreachable behind it.
    //
    // Which is why a locked chart does not set it. A domain still being populated deliberately
    // reaches past its newest value — that is what a fixed axis means — and pinning there would
    // collapse the axis onto the part that happens to have been computed, growing it a year at a
    // time. A locked chart needs no gesture bound in the first place: it refuses every gesture,
    // and the only thing that positions it is the domain itself.
    fixRightEdge: interaction !== "LOCKED",
    // Only once the oldest drawn bar *is* the domain's edge. Before that the empty space to its
    // left is the product's request mechanism, and pinning it would mean history never loads.
    fixLeftEdge: domainComplete,
    // A resize is not navigation: the window the user chose survives it.
    lockVisibleTimeRangeOnResize: true,
  };
}

export function useBoundedTimeScale(
  input: BoundedTimeScaleInput,
): BoundedTimeScale {
  const chartRef = useRef<IChartApi | null>(null);
  // The subscription is registered once per chart instance, so everything it reads comes through
  // a ref: a viewport change must never cost a render, and must never resubscribe.
  const inputRef = useRef(input);
  inputRef.current = input;
  // A correction writes a range, and writing a range reports one. Without this the clamp would be
  // its own trigger. Paired with the epsilon in `clampLogicalRange`, a correction settles in one
  // step and an ordinary in-bounds pan never writes at all.
  const correctingRef = useRef(false);
  /** Whether the previous data write happened while the viewport was locked. */
  const wasLockedRef = useRef(input.domain.interaction === "LOCKED");

  /** Every programmatic write goes through here, so none of them can trigger the clamp. */
  const writeWithoutClamping = useCallback((write: () => void) => {
    correctingRef.current = true;
    try {
      write();
    } finally {
      correctingRef.current = false;
    }
  }, []);

  const clampNow = useCallback((range: LogicalRange): LogicalRange | null => {
    const { domain, barCount } = inputRef.current;
    return clampLogicalRange(range, {
      minFrom: -leadBarsOf(domain),
      maxTo: barCount,
    });
  }, []);

  const showRange = useCallback(
    (from: string, to: string) => {
      const chart = chartRef.current;
      if (!chart) {
        return;
      }
      const timeScale = chart.timeScale();
      // A time range is resolved against the points on the scale, and the library throws rather
      // than answering when there are none. A chart mounted before its first data write is an
      // ordinary state here — a backtest's axis exists from the moment the run does — so an empty
      // scale is nothing to show, not an error.
      if (timeScale.getVisibleLogicalRange() === null) {
        return;
      }
      writeWithoutClamping(() => {
        timeScale.setVisibleRange({ from: from as Time, to: to as Time });
      });
    },
    [writeWithoutClamping],
  );

  const applyFrame = useCallback(
    (from: string, to: string) => {
      const chart = chartRef.current;
      if (!chart) {
        return;
      }
      const oldest = inputRef.current.domain.oldestBar;
      if (oldest === undefined || from <= oldest) {
        writeWithoutClamping(() => chart.timeScale().fitContent());
        return;
      }
      showRange(from, to);
    },
    [showRange, writeWithoutClamping],
  );

  const syncAfterData = useCallback(() => {
    const { domain, frame } = inputRef.current;
    const locked = domain.interaction === "LOCKED";
    // The write that unlocks the chart is re-asserted too, once. Up to that moment the viewport
    // was never the user's — it was pinned to the whole domain — and that write is usually the
    // one where a run's live curve is replaced by its durable result, which changes the point
    // count. Without this the handover would silently shrink the window it hands over.
    if (locked || wasLockedRef.current) {
      showRange(frame.from, frame.to);
    }
    wasLockedRef.current = locked;
  }, [showRange]);

  const attachChart = useCallback(
    (chart: IChartApi) => {
      chartRef.current = chart;
      const { domain } = inputRef.current;
      chart.applyOptions({
        ...interactionOptions(domain.interaction),
        timeScale: timeScaleOptions(domain.domainComplete, domain.interaction),
      });

      const onLogicalRangeChange = (range: LibraryLogicalRange | null) => {
        if (range === null) {
          inputRef.current.onVisibleRangeChange?.(null);
          return;
        }
        let effective: LogicalRange = range;
        if (!correctingRef.current) {
          const clamped = clampNow(range);
          if (clamped) {
            effective = clamped;
            writeWithoutClamping(() =>
              chart.timeScale().setVisibleLogicalRange(clamped),
            );
          }
        }
        // Reported after clamping, so a consumer reading "how much empty space is on screen" can
        // never be handed a number the domain would not have allowed.
        inputRef.current.onVisibleRangeChange?.(effective);
      };
      chart
        .timeScale()
        .subscribeVisibleLogicalRangeChange(onLogicalRangeChange);

      return () => {
        chart
          .timeScale()
          .unsubscribeVisibleLogicalRangeChange(onLogicalRangeChange);
        chartRef.current = null;
        correctingRef.current = false;
      };
    },
    [clampNow, writeWithoutClamping],
  );

  const { interaction, domainComplete, minTime, maxTime } = input.domain;

  // Interaction and the edge pins follow the domain for the life of the chart: a run reaching
  // COMPLETED, or a security's history reaching its boundary, must change them in place rather
  // than only at creation.
  useEffect(() => {
    chartRef.current?.applyOptions({
      ...interactionOptions(interaction),
      timeScale: timeScaleOptions(domainComplete, interaction),
    });
  }, [interaction, domainComplete]);

  // Shrinking the domain — a new run, a different security — can leave the viewport outside it.
  // Clamping on the bounds themselves is what keeps that from surviving as a stuck window.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }
    const current = chart.timeScale().getVisibleLogicalRange();
    if (!current) {
      return;
    }
    const clamped = clampNow(current);
    if (clamped) {
      writeWithoutClamping(() =>
        chart.timeScale().setVisibleLogicalRange(clamped),
      );
    }
  }, [minTime, maxTime, domainComplete, clampNow, writeWithoutClamping]);

  return { attachChart, showRange, applyFrame, syncAfterData };
}

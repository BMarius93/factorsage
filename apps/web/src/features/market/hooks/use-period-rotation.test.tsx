import {
  MARKET_OVERVIEW_PERIODS,
  type MarketOverviewPeriod,
} from "@intrinsic/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFakeViewport,
  type FakeViewport,
} from "../../../lib/__testing__/fake-viewport";
import {
  MARKET_WATCH_FADE_IN_MS,
  MARKET_WATCH_FADE_OUT_MS,
  MARKET_WATCH_ROTATION_MS,
  nextPeriod,
  usePeriodRotation,
  type PeriodRotation,
} from "./use-period-rotation";

let rotation: PeriodRotation;
let options: { active?: boolean; held?: boolean } = {};

function Probe() {
  rotation = usePeriodRotation(options);
  return (
    <p data-testid="probe">
      {rotation.period} {rotation.auto ? "auto" : "off"}{" "}
      {rotation.rotating ? "rotating" : "still"} {rotation.phase}
    </p>
  );
}

function state(): string {
  return screen.getByTestId("probe").textContent ?? "";
}

function period(): string {
  return state().split(" ")[0]!;
}

function tick(ms = MARKET_WATCH_ROTATION_MS) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Until the fade-out begins: one interval minus the fade-out it starts. */
const UNTIL_FADE = MARKET_WATCH_ROTATION_MS - MARKET_WATCH_FADE_OUT_MS;

let viewport: FakeViewport;

beforeEach(() => {
  vi.useFakeTimers();
  viewport = installFakeViewport({ width: 1440 });
  options = {};
});

afterEach(() => {
  viewport.restore();
  vi.useRealTimers();
});

describe("nextPeriod", () => {
  it("rotates 1W → 1M → 3M → 6M → YTD → 1Y and back to 1W", () => {
    const order: MarketOverviewPeriod[] = [MARKET_OVERVIEW_PERIODS[0]];
    for (let step = 0; step < 6; step += 1) {
      order.push(nextPeriod(order.at(-1)!));
    }
    expect(order).toEqual(["1W", "1M", "3M", "6M", "YTD", "1Y", "1W"]);
  });
});

describe("usePeriodRotation", () => {
  it("starts on 1W, rotating, and moves every eight seconds in order", () => {
    render(<Probe />);
    expect(state()).toBe("1W auto rotating idle");
    expect(MARKET_WATCH_ROTATION_MS).toBe(8_000);

    tick(MARKET_WATCH_ROTATION_MS - 1);
    expect(period()).toBe("1W");
    tick(1);
    expect(period()).toBe("1M");

    const seen = ["1W", "1M"];
    for (let step = 0; step < 5; step += 1) {
      tick();
      seen.push(period());
    }
    expect(seen).toEqual(["1W", "1M", "3M", "6M", "YTD", "1Y", "1W"]);
  });

  it("stages each automatic change: dim, swap while dim, brighten, rest", () => {
    render(<Probe />);
    tick(UNTIL_FADE - 1);
    expect(state()).toBe("1W auto rotating idle");

    // The values dim first; the period on screen has not changed yet.
    tick(1);
    expect(state()).toBe("1W auto rotating out");
    expect(rotation.arrived).toBeNull();

    // The swap happens while they are dim, and the new period is marked as just arrived.
    tick(MARKET_WATCH_FADE_OUT_MS);
    expect(state()).toBe("1M auto rotating in");
    expect(rotation.arrived).toBe("1M");

    // Then they come back to full strength and everything rests.
    tick(MARKET_WATCH_FADE_IN_MS - 1);
    expect(rotation.phase).toBe("in");
    tick(1);
    expect(state()).toBe("1M auto rotating idle");
    expect(
      MARKET_WATCH_FADE_OUT_MS + MARKET_WATCH_FADE_IN_MS,
    ).toBeGreaterThanOrEqual(650);
    expect(
      MARKET_WATCH_FADE_OUT_MS + MARKET_WATCH_FADE_IN_MS,
    ).toBeLessThanOrEqual(700);
  });

  it("never overlaps two changes: one interval and at most one stage timer at a time", () => {
    render(<Probe />);
    const phases: string[] = [];
    for (
      let elapsed = 0;
      elapsed < MARKET_WATCH_ROTATION_MS * 3;
      elapsed += 10
    ) {
      tick(10);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(2);
      if (phases.at(-1) !== rotation.phase) {
        phases.push(rotation.phase);
      }
    }
    // Every change runs the whole sequence, in order, and only then does the next begin.
    expect(phases).toEqual([
      "idle",
      "out",
      "in",
      "idle",
      "out",
      "in",
      "idle",
      "out",
      "in",
    ]);
    expect(period()).toBe("6M");
  });

  it("stops for good on a chosen period, shown at once and kept", () => {
    render(<Probe />);
    tick(4_000);
    act(() => rotation.select("6M"));
    expect(state()).toBe("6M off still idle");
    expect(rotation.arrived).toBeNull();
    expect(vi.getTimerCount()).toBe(0);

    tick(120_000);
    expect(state()).toBe("6M off still idle");
  });

  it("stops for good when the reader picks the period already on screen", () => {
    render(<Probe />);
    act(() => rotation.select("1W"));
    expect(state()).toBe("1W off still idle");
    tick(120_000);
    expect(state()).toBe("1W off still idle");
  });

  it("lets a choice cancel a change under way: the chosen period, at full strength, and no late swap", () => {
    render(<Probe />);
    tick(UNTIL_FADE);
    expect(rotation.phase).toBe("out");

    act(() => rotation.select("3M"));
    expect(state()).toBe("3M off still idle");
    tick(MARKET_WATCH_FADE_OUT_MS + MARKET_WATCH_FADE_IN_MS + 60_000);
    expect(state()).toBe("3M off still idle");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits while held, without turning rotation off, and gives the period a full interval after", () => {
    const { rerender } = render(<Probe />);
    tick(6_000);
    options = { held: true };
    rerender(<Probe />);
    expect(state()).toBe("1W auto still idle");
    tick(60_000);
    expect(period()).toBe("1W");

    options = { held: false };
    rerender(<Probe />);
    tick(MARKET_WATCH_ROTATION_MS - 1);
    expect(period()).toBe("1W");
    tick(1);
    expect(period()).toBe("1M");
  });

  it("finishes a change already under way when it is held, so nothing stays dimmed", () => {
    const { rerender } = render(<Probe />);
    tick(UNTIL_FADE);
    expect(rotation.phase).toBe("out");
    options = { held: true };
    rerender(<Probe />);
    tick(MARKET_WATCH_FADE_OUT_MS + MARKET_WATCH_FADE_IN_MS);
    expect(state()).toBe("1M auto still idle");
    tick(60_000);
    expect(period()).toBe("1M");
  });

  it("stops while the tab is hidden and starts a full interval when it returns", () => {
    render(<Probe />);
    tick(5_000);
    viewport.setHidden(true);
    expect(state()).toBe("1W auto still idle");
    expect(vi.getTimerCount()).toBe(0);

    tick(120_000);
    expect(period()).toBe("1W");

    viewport.setHidden(false);
    tick(MARKET_WATCH_ROTATION_MS - 1);
    expect(period()).toBe("1W");
    tick(1);
    expect(period()).toBe("1M");
  });

  it("does not rotate at all for a reader who prefers reduced motion, and every period stays a click away", () => {
    viewport.setReducedMotion(true);
    render(<Probe />);
    expect(state()).toBe("1W off still idle");
    expect(vi.getTimerCount()).toBe(0);
    tick(120_000);
    expect(period()).toBe("1W");

    act(() => rotation.select("YTD"));
    expect(state()).toBe("YTD off still idle");
  });

  it("stops if reduced motion is turned on while it runs", () => {
    render(<Probe />);
    viewport.setReducedMotion(true);
    expect(state()).toBe("1W off still idle");
    tick(60_000);
    expect(period()).toBe("1W");
  });

  it("does not rotate while there is nothing to rotate", () => {
    options = { active: false };
    const { rerender } = render(<Probe />);
    tick(60_000);
    expect(period()).toBe("1W");
    expect(vi.getTimerCount()).toBe(0);

    options = { active: true };
    rerender(<Probe />);
    tick();
    expect(period()).toBe("1M");
  });

  it("clears every timer when it unmounts, even halfway through a change", () => {
    const { unmount } = render(<Probe />);
    tick(UNTIL_FADE);
    expect(rotation.phase).toBe("out");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

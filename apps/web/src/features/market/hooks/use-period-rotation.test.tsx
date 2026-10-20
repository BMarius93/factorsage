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
  MARKET_WATCH_ROTATION_MS,
  nextPeriod,
  usePeriodRotation,
  type PeriodRotation,
} from "./use-period-rotation";

let rotation: PeriodRotation;

function Probe() {
  rotation = usePeriodRotation();
  return (
    <p data-testid="probe">
      {rotation.period} {rotation.auto ? "auto" : "paused"}{" "}
      {rotation.rotating ? "rotating" : "still"}
    </p>
  );
}

function state(): string {
  return screen.getByTestId("probe").textContent ?? "";
}

function tick(ms = MARKET_WATCH_ROTATION_MS) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

let viewport: FakeViewport;

beforeEach(() => {
  vi.useFakeTimers();
  viewport = installFakeViewport({ width: 1440 });
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
  it("starts on 1W with Auto on, and moves every ten seconds in order", () => {
    render(<Probe />);
    expect(state()).toBe("1W auto rotating");

    tick(MARKET_WATCH_ROTATION_MS - 1);
    expect(state()).toBe("1W auto rotating");
    tick(1);
    expect(state()).toBe("1M auto rotating");

    const seen = ["1W", "1M"];
    for (let step = 0; step < 5; step += 1) {
      tick();
      seen.push(state().split(" ")[0]!);
    }
    expect(seen).toEqual(["1W", "1M", "3M", "6M", "YTD", "1Y", "1W"]);
  });

  it("runs exactly one timer at a time", () => {
    render(<Probe />);
    expect(vi.getTimerCount()).toBe(1);
    tick();
    tick();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("pauses on a chosen period, keeps it, and resumes with a full interval", () => {
    render(<Probe />);
    tick(4_000);
    act(() => rotation.select("6M"));
    expect(state()).toBe("6M paused still");
    expect(vi.getTimerCount()).toBe(0);

    tick(60_000);
    expect(state()).toBe("6M paused still");

    act(() => rotation.setAuto(true));
    expect(state()).toBe("6M auto rotating");
    tick(MARKET_WATCH_ROTATION_MS - 1);
    expect(state()).toBe("6M auto rotating");
    tick(1);
    expect(state()).toBe("YTD auto rotating");
  });

  it("stops while the tab is hidden and starts a full interval when it returns", () => {
    render(<Probe />);
    tick(7_000);
    viewport.setHidden(true);
    expect(state()).toBe("1W auto still");
    expect(vi.getTimerCount()).toBe(0);

    tick(120_000);
    expect(state()).toBe("1W auto still");

    viewport.setHidden(false);
    tick(MARKET_WATCH_ROTATION_MS - 1);
    expect(state()).toBe("1W auto rotating");
    tick(1);
    expect(state()).toBe("1M auto rotating");
  });

  it("holds while asked to, without leaving Auto", () => {
    render(<Probe />);
    act(() => rotation.setHeld(true));
    expect(state()).toBe("1W auto still");
    tick(30_000);
    expect(state()).toBe("1W auto still");

    act(() => rotation.setHeld(false));
    tick();
    expect(state()).toBe("1M auto rotating");
  });

  it("starts paused for a reader who prefers reduced motion, and can still be turned on", () => {
    viewport.setReducedMotion(true);
    render(<Probe />);
    expect(state()).toBe("1W paused still");
    tick(60_000);
    expect(state()).toBe("1W paused still");

    act(() => rotation.setAuto(true));
    tick();
    expect(state()).toBe("1M auto rotating");
  });

  it("stops rotating if reduced motion is turned on while it runs, unless the reader chose Auto", () => {
    render(<Probe />);
    viewport.setReducedMotion(true);
    expect(state()).toBe("1W paused still");
  });

  it("does not rotate while there is nothing to rotate", () => {
    let active = false;
    function Gated() {
      rotation = usePeriodRotation(active);
      return <p data-testid="probe">{rotation.period}</p>;
    }
    const { rerender } = render(<Gated />);
    tick(60_000);
    expect(state()).toBe("1W");
    expect(vi.getTimerCount()).toBe(0);

    active = true;
    rerender(<Gated />);
    tick();
    expect(state()).toBe("1M");
  });

  it("clears its timer when it unmounts", () => {
    const { unmount } = render(<Probe />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

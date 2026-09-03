import { render, screen } from "@testing-library/react";
import { createChart } from "lightweight-charts";
import { describe, expect, it, vi, type Mock } from "vitest";
import { CHART_COLORS, overlayColorAt } from "../utils/chart-theme";
import { StockPriceChart } from "./StockPriceChart";

type FakeSeries = {
  setData: Mock;
  applyOptions: Mock;
  createPriceLine: Mock;
  removePriceLine: Mock;
};

type FakePane = { setStretchFactor: Mock };

type FakeChart = {
  addedSeries: Array<{
    definition: unknown;
    options: Record<string, unknown>;
    paneIndex: number | undefined;
    api: FakeSeries;
  }>;
  panesList: FakePane[];
  options: Record<string, unknown>;
  addSeries: Mock;
  removeSeries: Mock;
  applyOptions: Mock;
  timeScale: Mock;
  fitContent: Mock;
  subscribeVisibleLogicalRangeChange: Mock;
  unsubscribeVisibleLogicalRangeChange: Mock;
  panes: Mock;
  subscribeCrosshairMove: Mock;
  unsubscribeCrosshairMove: Mock;
  remove: Mock;
};

// jsdom cannot rasterize a canvas; the library boundary is mocked and the assertions target the
// data and options our component feeds into it.
vi.mock("lightweight-charts", () => {
  const createChartMock = vi.fn(
    (_container: unknown, options: Record<string, unknown>) => {
    const fitContent = vi.fn();
    const subscribeVisibleLogicalRangeChange = vi.fn();
    const unsubscribeVisibleLogicalRangeChange = vi.fn();
    const chart: FakeChart = {
      options,
      addedSeries: [],
      panesList: [
        { setStretchFactor: vi.fn() },
        { setStretchFactor: vi.fn() },
      ],
      addSeries: vi.fn(
        (
          definition: unknown,
          options: Record<string, unknown>,
          paneIndex?: number,
        ) => {
          const api: FakeSeries = {
            setData: vi.fn(),
            applyOptions: vi.fn(),
            // Returns the options so a line stays identifiable: the reference-line assertions
            // track which specific lines are still attached to which series.
            createPriceLine: vi.fn((options: { price: number }) => ({ options })),
            removePriceLine: vi.fn(),
          };
          chart.addedSeries.push({ definition, options, paneIndex, api });
          return api;
        },
      ),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      timeScale: vi.fn(() => ({
        fitContent,
        subscribeVisibleLogicalRangeChange,
        unsubscribeVisibleLogicalRangeChange,
      })),
      fitContent,
      subscribeVisibleLogicalRangeChange,
      unsubscribeVisibleLogicalRangeChange,
      panes: vi.fn(() => chart.panesList),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      remove: vi.fn(),
    };
    return chart;
    },
  );
  return {
    createChart: createChartMock,
    AreaSeries: "AreaSeries",
    LineSeries: "LineSeries",
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 },
  };
});

function lastChart(): FakeChart {
  const results = vi.mocked(createChart).mock.results;
  return results[results.length - 1]?.value as FakeChart;
}

const POINTS = [
  { date: "2026-08-27", value: 200 },
  { date: "2026-08-28", value: 232 },
];

describe("StockPriceChart", () => {
  it("feeds the closing prices into the price series and fits the visible range", () => {
    render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const priceSeries = chart.addedSeries[0];
    expect(priceSeries?.definition).toBe("AreaSeries");
    expect(priceSeries?.options.lineColor).toBe(CHART_COLORS.price);
    expect(priceSeries?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-27", value: 200 },
      { time: "2026-08-28", value: 232 },
    ]);
    expect(chart.fitContent).toHaveBeenCalled();
  });

  it("adds overlay line series and removes them when they are toggled off", () => {
    const overlay = {
      id: "SMA_50D",
      label: "SMA 50D",
      color: overlayColorAt(0),
      placement: "PRICE_OVERLAY" as const,
      points: [{ date: "2026-08-28", value: 220 }],
    };
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[overlay]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const overlaySeries = chart.addedSeries[1];
    expect(overlaySeries?.definition).toBe("LineSeries");
    expect(overlaySeries?.options.color).toBe(overlayColorAt(0));
    expect(overlaySeries?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-28", value: 220 },
    ]);

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.removeSeries).toHaveBeenCalledWith(overlaySeries?.api);
  });

  it("names the close and every enabled overlay in the legend with catalog labels", () => {
    const overlays = [
      {
        id: "SMA_50D",
        label: "SMA 50D",
        color: overlayColorAt(0),
        placement: "PRICE_OVERLAY" as const,
        points: [{ date: "2026-08-28", value: 220 }],
      },
      {
        id: "SMA_20W",
        label: "SMA 20W",
        color: overlayColorAt(1),
        placement: "PRICE_OVERLAY" as const,
        points: [{ date: "2026-08-28", value: 216 }],
      },
      {
        id: "BALANCED",
        label: "Balanced",
        color: overlayColorAt(2),
        placement: "PRICE_OVERLAY" as const,
        points: [{ date: "2026-08-28", value: 290 }],
      },
    ];
    render(
      <StockPriceChart
        points={POINTS}
        overlays={overlays}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const onCrosshairMove = chart.subscribeCrosshairMove.mock.calls[0]?.[0] as (
      param: unknown,
    ) => void;
    const seriesData = new Map<unknown, { value: number }>([
      [chart.addedSeries[0]?.api, { value: 232 }],
      [chart.addedSeries[1]?.api, { value: 220 }],
      [chart.addedSeries[2]?.api, { value: 216 }],
      [chart.addedSeries[3]?.api, { value: 290 }],
    ]);
    onCrosshairMove({ time: "2026-08-28", seriesData });

    const legend = screen.getByTestId("chart-legend");
    expect(legend.hidden).toBe(false);
    expect(legend.textContent).toContain("Close$232.00");
    expect(legend.textContent).toContain("SMA 50D$220.00");
    expect(legend.textContent).toContain("SMA 20W$216.00");
    expect(legend.textContent).toContain("Balanced$290.00");
  });

  it("repaints a reused overlay when the selection shifts its colour position", () => {
    const weekly = {
      id: "SMA_20W",
      label: "SMA 20W",
      placement: "PRICE_OVERLAY" as const,
      points: [{ date: "2026-08-28", value: 216 }],
    };
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[{ ...weekly, color: overlayColorAt(0) }]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const overlaySeries = chart.addedSeries[1];
    expect(overlaySeries?.options.color).toBe(overlayColorAt(0));

    // A daily average is enabled ahead of it, so the weekly line moves to the next palette slot.
    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[
          {
            id: "SMA_50D",
            label: "SMA 50D",
            color: overlayColorAt(0),
            placement: "PRICE_OVERLAY" as const,
            points: [{ date: "2026-08-28", value: 220 }],
          },
          { ...weekly, color: overlayColorAt(1) },
        ]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    expect(overlaySeries?.api.applyOptions).toHaveBeenCalledWith({
      color: overlayColorAt(1),
    });
  });

  it("explains an undrawable dataset instead of rendering a misleading chart", () => {
    render(
      <StockPriceChart
        points={[{ date: "2026-08-28", value: 10 }]}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="NEWCO chart"
      />,
    );

    expect(
      screen.getByText("Not enough price history to draw a chart."),
    ).toBeDefined();
  });

  it("signals when a fuller history is still loading", () => {
    render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        loading
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    expect(
      screen.getByRole("status", { name: "Loading price history" }),
    ).toBeDefined();
  });

  it("enables the standard pan and zoom gestures", () => {
    render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    // Dragging the plot pans through history; wheel and pinch zoom the time scale.
    expect(chart.options.handleScroll).toMatchObject({
      pressedMouseMove: true,
      horzTouchDrag: true,
      // A vertical swipe belongs to the page on a phone, not to the chart.
      vertTouchDrag: false,
    });
    expect(chart.options.handleScale).toMatchObject({
      mouseWheel: true,
      pinch: true,
    });
  });

  it("keeps the viewport across data updates and overlay changes", () => {
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    expect(chart.fitContent).toHaveBeenCalledTimes(1);

    // A fuller dataset for the same range — the kind of update that arrives behind the user's
    // back — must not snap the window they scrolled to back to the whole series.
    rerender(
      <StockPriceChart
        points={[{ date: "2026-08-26", value: 190 }, ...POINTS]}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    // Neither does enabling an indicator.
    rerender(
      <StockPriceChart
        points={[{ date: "2026-08-26", value: 190 }, ...POINTS]}
        overlays={[priceOverlay(0)]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    expect(chart.fitContent).toHaveBeenCalledTimes(1);
  });

  it("reframes when the selected range changes", () => {
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="5Y"
        ariaLabel="AAPL chart"
      />,
    );

    expect(chart.fitContent).toHaveBeenCalledTimes(2);
  });

  it("reframes again once a long range finishes loading its fuller history", () => {
    // Switching to 5Y frames whatever is already loaded, then reframes when the real five years
    // arrive. Only then is the range considered framed, so nothing refits afterwards.
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        loading
        fitKey="5Y"
        ariaLabel="AAPL chart"
      />,
    );
    const longHistory = [{ date: "2022-01-03", value: 90 }, ...POINTS];
    rerender(
      <StockPriceChart
        points={longHistory}
        overlays={[]}
        currency="USD"
        fitKey="5Y"
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.fitContent).toHaveBeenCalledTimes(3);

    rerender(
      <StockPriceChart
        points={longHistory}
        overlays={[priceOverlay(0)]}
        currency="USD"
        fitKey="5Y"
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.fitContent).toHaveBeenCalledTimes(3);
  });

  it("publishes the visible range so the window is observable from the DOM", () => {
    const { container } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const wrapper = container.firstElementChild as HTMLElement;

    const onRangeChange = chart.subscribeVisibleLogicalRangeChange.mock
      .calls[0]?.[0] as (range: { from: number; to: number } | null) => void;
    onRangeChange({ from: 12.5, to: 40.25 });
    expect(wrapper.dataset.visibleRange).toBe("12.50|40.25");

    onRangeChange(null);
    expect(wrapper.dataset.visibleRange).toBeUndefined();
  });

  it("tears the chart instance down on unmount", () => {
    const { unmount } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    unmount();

    expect(chart.remove).toHaveBeenCalled();
  });
});

function rsiOverlay(id: string, label: string, position: number, value: number) {
  return {
    id,
    label,
    color: overlayColorAt(position),
    placement: "OSCILLATOR_PANE" as const,
    scale: { min: 0, max: 100 },
    points: [{ date: "2026-08-28", value }],
  };
}

function priceOverlay(position: number) {
  return {
    id: "SMA_50D",
    label: "SMA 50D",
    color: overlayColorAt(position),
    placement: "PRICE_OVERLAY" as const,
    points: [{ date: "2026-08-28", value: 220 }],
  };
}

/** Chart-mock entries that were added for oscillator overlays, in creation order. */
function oscillatorSeries(chart: FakeChart) {
  return chart.addedSeries.filter((entry) => entry.paneIndex !== undefined);
}

/** Oscillator series the chart has not removed, in creation order. */
function liveOscillatorSeries(chart: FakeChart) {
  const removed = new Set(chart.removeSeries.mock.calls.map((call) => call[0]));
  return oscillatorSeries(chart).filter((entry) => !removed.has(entry.api));
}

/**
 * The live oscillator series carrying `value`.
 *
 * Series are identified by the data they were given, not by creation order: a period toggled off
 * and back on is a new series appended after the ones already present, so positional lookup would
 * silently compare the wrong periods.
 */
function seriesShowing(chart: FakeChart, value: number) {
  const match = liveOscillatorSeries(chart).find((entry) =>
    entry.api.setData.mock.calls.some((call) =>
      (call[0] as { value: number }[]).some((point) => point.value === value),
    ),
  );
  expect(match, `no live oscillator series showing ${value}`).toBeDefined();
  return match!;
}

/**
 * Prices of every reference line still drawn in the pane.
 *
 * A line counts as live when it was created on a series the chart still holds and was not
 * explicitly detached — removing a series disposes its own price lines, which is why removed
 * series are excluded rather than their lines counted as leaked.
 */
function liveReferenceLines(chart: FakeChart): number[] {
  return liveOscillatorSeries(chart).flatMap((entry) => {
    const detached = new Set(
      entry.api.removePriceLine.mock.calls.map((call) => call[0]),
    );
    return entry.api.createPriceLine.mock.results
      .map((result) => result.value as { options: { price: number } })
      .filter((line) => !detached.has(line))
      .map((line) => line.options.price);
  });
}

describe("StockPriceChart oscillator pane", () => {
  it("routes an oscillator into the shared lower pane with the fixed catalog scale", () => {
    render(
      <StockPriceChart
        points={POINTS}
        overlays={[priceOverlay(0), rsiOverlay("RSI_14D", "RSI 14D", 1, 54.32)]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    // The price overlay stays on the price pane; the oscillator is never drawn over it.
    const price = chart.addedSeries[1];
    expect(price?.paneIndex).toBeUndefined();
    const rsi = chart.addedSeries[2];
    expect(rsi?.definition).toBe("LineSeries");
    expect(rsi?.paneIndex).toBe(1);
    expect(rsi?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-28", value: 54.32 },
    ]);

    // The pane renders the catalog's fixed 0-100 range instead of autoscaling.
    const autoscale = rsi?.options.autoscaleInfoProvider as () => {
      priceRange: { minValue: number; maxValue: number };
    };
    expect(autoscale().priceRange).toEqual({ minValue: 0, maxValue: 100 });
    // Unitless axis labels, not money.
    const priceFormat = rsi?.options.priceFormat as {
      type: string;
      formatter: (value: number) => string;
    };
    expect(priceFormat.type).toBe("custom");
    expect(priceFormat.formatter(54.32)).toBe("54.3");
    // The price pane keeps most of the height.
    expect(chart.panesList[1]?.setStretchFactor).toHaveBeenCalledWith(0.35);
  });

  it("keeps one set of 30/50/70 reference levels no matter how many periods are on", () => {
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[
          rsiOverlay("RSI_7D", "RSI 7D", 0, 61.2),
          rsiOverlay("RSI_14D", "RSI 14D", 1, 54.3),
        ]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const [rsi7, rsi14] = oscillatorSeries(chart);
    // Exactly one owner carries the three levels; the second series adds none.
    expect(rsi7?.api.createPriceLine).toHaveBeenCalledTimes(3);
    expect(rsi14?.api.createPriceLine).not.toHaveBeenCalled();
    expect(
      rsi7?.api.createPriceLine.mock.calls.map(
        (call) => (call[0] as { price: number; title: string }).price,
      ),
    ).toEqual([30, 50, 70]);
    expect(
      rsi7?.api.createPriceLine.mock.calls.map(
        (call) => (call[0] as { title: string }).title,
      ),
    ).toEqual(["Oversold 30", "50", "Overbought 70"]);

    // Adding a third period re-renders without duplicating any level anywhere.
    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[
          rsiOverlay("RSI_7D", "RSI 7D", 0, 61.2),
          rsiOverlay("RSI_14D", "RSI 14D", 1, 54.3),
          rsiOverlay("RSI_21D", "RSI 21D", 2, 48.9),
        ]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const [, , rsi21] = oscillatorSeries(chart);
    expect(rsi7?.api.createPriceLine).toHaveBeenCalledTimes(3);
    expect(rsi14?.api.createPriceLine).not.toHaveBeenCalled();
    expect(rsi21?.api.createPriceLine).not.toHaveBeenCalled();
  });

  it("moves the reference levels when the owning period is toggled off and back on", () => {
    const both = [
      rsiOverlay("RSI_7D", "RSI 7D", 0, 61.2),
      rsiOverlay("RSI_14D", "RSI 14D", 1, 54.3),
    ];
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={both}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const [rsi7, rsi14] = oscillatorSeries(chart);

    // Toggling the owner off removes only its line; the surviving period inherits the levels.
    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[rsiOverlay("RSI_14D", "RSI 14D", 0, 54.3)]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.removeSeries).toHaveBeenCalledWith(rsi7?.api);
    expect(chart.removeSeries).not.toHaveBeenCalledWith(rsi14?.api);
    expect(rsi14?.api.createPriceLine).toHaveBeenCalledTimes(3);

    // Toggling it back on moves the levels to the canonically first period — never duplicating.
    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={both}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const readded = oscillatorSeries(chart).at(-1);
    expect(readded?.api).not.toBe(rsi7?.api);
    expect(rsi14?.api.removePriceLine).toHaveBeenCalledTimes(3);
    expect(readded?.api.createPriceLine).toHaveBeenCalledTimes(3);
  });

  it("removes the last oscillator series and restores the price-only layout", () => {
    const { rerender, container } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[rsiOverlay("RSI_7D", "RSI 7D", 0, 61.2)]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.oscillatorPane).toBe("true");
    // The canvas-drawn levels stay assertable from the DOM.
    expect(wrapper.dataset.oscillatorLevels).toBe("30,50,70");

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    // Removing the last oscillator series is what removes the native pane; the wrapper drops back
    // to the price-only height.
    const rsi = oscillatorSeries(chart)[0];
    expect(chart.removeSeries).toHaveBeenCalledWith(rsi?.api);
    expect(wrapper.dataset.oscillatorPane).toBeUndefined();
    expect(wrapper.dataset.oscillatorLevels).toBeUndefined();
  });

  it("survives repeated on/off/on cycles with one series and one line set per period", () => {
    const overlay = rsiOverlay("RSI_14D", "RSI 14D", 0, 54.3);
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[overlay]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      rerender(
        <StockPriceChart
          points={POINTS}
          overlays={[]}
          currency="USD"
          fitKey="1Y"
          ariaLabel="AAPL chart"
        />,
      );
      rerender(
        <StockPriceChart
          points={POINTS}
          overlays={[overlay]}
          currency="USD"
          fitKey="1Y"
          ariaLabel="AAPL chart"
        />,
      );
    }

    // Four alive-series generations in total, each removed before the next was created, and each
    // carrying exactly one set of reference levels.
    const generations = oscillatorSeries(chart);
    expect(generations).toHaveLength(4);
    expect(chart.removeSeries).toHaveBeenCalledTimes(3);
    for (const generation of generations) {
      expect(generation.api.createPriceLine).toHaveBeenCalledTimes(3);
      expect(generation.api.removePriceLine).not.toHaveBeenCalled();
    }
  });

  it("hands the 30/50/70 levels down the selection as each owner is switched off", () => {
    // The pane's reference levels are owned by whichever RSI is canonically first, so switching
    // periods off in order walks the ownership from 7D to 14D to 21D. At no point may the pane
    // show a second set, lose the set while a period is still drawn, or keep one after the last
    // period goes.
    const rsi7 = rsiOverlay("RSI_7D", "RSI 7D", 0, 61.2);
    const rsi14 = rsiOverlay("RSI_14D", "RSI 14D", 1, 54.3);
    const rsi21 = rsiOverlay("RSI_21D", "RSI 21D", 2, 48.9);

    // 1. Enable RSI 7D.
    const { rerender, container } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[rsi7]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const wrapper = container.firstElementChild as HTMLElement;
    const show = (overlays: ReturnType<typeof rsiOverlay>[]) =>
      rerender(
        <StockPriceChart
          points={POINTS}
          overlays={overlays}
          currency="USD"
          fitKey="1Y"
          ariaLabel="AAPL chart"
        />,
      );

    expect(liveReferenceLines(chart)).toEqual([30, 50, 70]);

    // 2-3. Enable RSI 14D and RSI 21D: still exactly one set, on the first period.
    show([rsi7, rsi14, rsi21]);
    expect(liveOscillatorSeries(chart)).toHaveLength(3);
    expect(liveReferenceLines(chart)).toEqual([30, 50, 70]);
    const owner7 = seriesShowing(chart, 61.2);
    expect(owner7.api.createPriceLine).toHaveBeenCalledTimes(3);
    // The later periods carry no levels of their own.
    expect(seriesShowing(chart, 54.3).api.createPriceLine).not.toHaveBeenCalled();
    expect(seriesShowing(chart, 48.9).api.createPriceLine).not.toHaveBeenCalled();

    // 4-6. Disable RSI 7D, the initial owner. 14D and 21D stay drawn and the levels survive
    //      exactly once, having moved to 14D.
    show([rsi14, rsi21]);
    expect(liveOscillatorSeries(chart)).toHaveLength(2);
    expect(chart.removeSeries).toHaveBeenCalledWith(owner7.api);
    expect(liveReferenceLines(chart)).toEqual([30, 50, 70]);
    // Ownership moved to 14D, which now carries the only set; 21D still carries none.
    expect(seriesShowing(chart, 54.3).api.createPriceLine).toHaveBeenCalledTimes(3);
    expect(seriesShowing(chart, 48.9).api.createPriceLine).not.toHaveBeenCalled();

    // 7-8. Disable RSI 14D: RSI 21D and one set remain.
    show([rsi21]);
    expect(liveOscillatorSeries(chart)).toHaveLength(1);
    expect(liveReferenceLines(chart)).toEqual([30, 50, 70]);
    expect(seriesShowing(chart, 48.9).api.createPriceLine).toHaveBeenCalledTimes(3);

    // 9-10. Disable the final RSI: the pane and its levels are gone.
    show([]);
    expect(liveOscillatorSeries(chart)).toHaveLength(0);
    expect(liveReferenceLines(chart)).toEqual([]);
    expect(wrapper.dataset.oscillatorPane).toBeUndefined();
    expect(wrapper.dataset.oscillatorLevels).toBeUndefined();

    // 11. Re-enable one period: one series, one set, nothing duplicated.
    show([rsi14]);
    expect(liveOscillatorSeries(chart)).toHaveLength(1);
    expect(liveReferenceLines(chart)).toEqual([30, 50, 70]);
    expect(wrapper.dataset.oscillatorLevels).toBe("30,50,70");
  });

  it("keeps one level set when the owner is re-enabled ahead of the current owner", () => {
    // The reverse handover: 14D owns the levels, then 7D is switched back on and becomes
    // canonically first. Ownership must move forward without leaving the old owner's set behind.
    const rsi7 = rsiOverlay("RSI_7D", "RSI 7D", 0, 61.2);
    const rsi14 = rsiOverlay("RSI_14D", "RSI 14D", 1, 54.3);
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[rsi14]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    expect(liveReferenceLines(chart)).toEqual([30, 50, 70]);

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[rsi7, rsi14]}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    expect(liveOscillatorSeries(chart)).toHaveLength(2);
    expect(liveReferenceLines(chart)).toEqual([30, 50, 70]);
    // 7D is canonically first, so it takes the levels; 14D detaches its own rather than leaving
    // a second set drawn.
    expect(seriesShowing(chart, 61.2).api.createPriceLine).toHaveBeenCalledTimes(3);
    expect(seriesShowing(chart, 54.3).api.removePriceLine).toHaveBeenCalledTimes(3);
  });

  it("names each oscillator with its unitless value in the hover legend", () => {
    const overlays = [
      priceOverlay(0),
      rsiOverlay("RSI_14D", "RSI 14D", 1, 54.32),
    ];
    render(
      <StockPriceChart
        points={POINTS}
        overlays={overlays}
        currency="USD"
        fitKey="1Y"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const onCrosshairMove = chart.subscribeCrosshairMove.mock.calls[0]?.[0] as (
      param: unknown,
    ) => void;
    const seriesData = new Map<unknown, { value: number }>([
      [chart.addedSeries[0]?.api, { value: 232 }],
      [chart.addedSeries[1]?.api, { value: 220 }],
      [chart.addedSeries[2]?.api, { value: 54.32 }],
    ]);
    onCrosshairMove({ time: "2026-08-28", seriesData });

    const legend = screen.getByTestId("chart-legend");
    expect(legend.textContent).toContain("SMA 50D$220.00");
    // Unitless: an RSI reading is never formatted as money.
    expect(legend.textContent).toContain("RSI 14D54.3");
    expect(legend.textContent).not.toContain("RSI 14D$");
  });
});

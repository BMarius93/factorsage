import { render, screen } from "@testing-library/react";
import { createChart } from "lightweight-charts";
import { StrictMode } from "react";
import { describe, expect, it, vi, type Mock } from "vitest";
import type {
  ChartFundamentalSeries,
  ChartOverlaySeries,
  ChartValuationSeries,
} from "../utils/chart-series";
import { CHART_COLORS, overlayColorAt } from "../utils/chart-theme";
import { StockPriceChart } from "./StockPriceChart";

type FakeSeries = {
  setData: Mock;
  applyOptions: Mock;
  /** The options the series holds, the library's defaults under what it was created with. */
  options: Mock;
  createPriceLine: Mock;
  removePriceLine: Mock;
  /** The series' own price scale; the volume histogram applies its scale margins through it. */
  priceScale: Mock;
  scaleOptions: Record<string, unknown>;
  /** The pane the series currently lives in, which moves with it. */
  getPane: () => FakePane;
};

/**
 * A pane as the library models it: an ordered slot holding series. The mock keeps the library's
 * real rules rather than a fixed list — a series placed at an index past the last pane opens a
 * new pane at the bottom, a pane whose last series is removed disappears and the panes below it
 * move up, and the chart's `swapPanes` reorders — because pane placement is exactly what these
 * tests assert. There is deliberately no `moveTo`: the real one checks its target against pane
 * widgets that lag the model by a frame, so the component must never reach for it.
 */
type FakePane = {
  setStretchFactor: Mock;
  paneIndex: () => number;
  series: FakeSeries[];
  /** Kept when its last series goes, as `addPane(true)` asks the library to. */
  preserved: boolean;
};

/**
 * The mocked time scale keeps real state for the visible range, because the viewport behaviour
 * under test is a read-modify-write: the component reads the logical range before rewriting the
 * series and writes a shifted one back. A pair of bare spies could not tell a correct shift from
 * a missing one.
 */
type FakeTimeScale = {
  logical: { from: number; to: number } | null;
  /** Time points any series has put on the scale. Zero means an empty scale. */
  points: number;
  fitContent: Mock;
  getVisibleLogicalRange: Mock;
  setVisibleLogicalRange: Mock;
  getVisibleRange: Mock;
  setVisibleRange: Mock;
  applyOptions: Mock;
  subscribeVisibleLogicalRangeChange: Mock;
  unsubscribeVisibleLogicalRangeChange: Mock;
};

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
  scale: FakeTimeScale;
  fitContent: Mock;
  subscribeVisibleLogicalRangeChange: Mock;
  unsubscribeVisibleLogicalRangeChange: Mock;
  panes: Mock;
  addPane: Mock;
  removePane: Mock;
  swapPanes: Mock;
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
      const scale: FakeTimeScale = {
        logical: null,
        points: 0,
        fitContent,
        // The real library resolves a range against the points on the scale and answers `null` when
        // there are none, which is what tells a caller there is nothing to position yet. A mock that
        // always answered would hide the chart's first render, before any data is drawn.
        getVisibleLogicalRange: vi.fn(
          () =>
            scale.logical ??
            (scale.points === 0 ? null : { from: 0, to: scale.points }),
        ),
        setVisibleLogicalRange: vi.fn((range: { from: number; to: number }) => {
          scale.logical = range;
        }),
        getVisibleRange: vi.fn(() => null),
        setVisibleRange: vi.fn(),
        applyOptions: vi.fn(),
        subscribeVisibleLogicalRangeChange,
        unsubscribeVisibleLogicalRangeChange,
      };
      const newPane = (preserved = false): FakePane => {
        const pane: FakePane = {
          setStretchFactor: vi.fn(),
          paneIndex: () => chart.panesList.indexOf(pane),
          series: [],
          preserved,
        };
        return pane;
      };
      const chart: FakeChart = {
        options,
        addedSeries: [],
        // The chart starts with its price pane; every other pane is opened by the series placed in it.
        panesList: [],
        addSeries: vi.fn(
          (
            definition: unknown,
            options: Record<string, unknown>,
            paneIndex?: number,
          ) => {
            const requested = paneIndex ?? 0;
            const pane =
              requested < chart.panesList.length
                ? (chart.panesList[requested] as FakePane)
                : (() => {
                    const created = newPane();
                    chart.panesList.push(created);
                    return created;
                  })();
            const api: FakeSeries = {
              setData: vi.fn((rows: unknown[]) => {
                scale.points = Math.max(scale.points, rows.length);
              }),
              applyOptions: vi.fn(),
              // A line series defaults to the library's simple line type.
              options: vi.fn(() => ({ lineType: 0, ...options })),
              // Returns the options so a line stays identifiable: the reference-line assertions
              // track which specific lines are still attached to which series.
              createPriceLine: vi.fn((options: { price: number }) => ({
                options,
              })),
              removePriceLine: vi.fn(),
              scaleOptions: {},
              priceScale: vi.fn(() => ({
                applyOptions: vi.fn((next: Record<string, unknown>) => {
                  Object.assign(api.scaleOptions, next);
                }),
              })),
              getPane: () =>
                chart.panesList.find((candidate) =>
                  candidate.series.includes(api),
                ) as FakePane,
            };
            pane.series.push(api);
            chart.addedSeries.push({ definition, options, paneIndex, api });
            return api;
          },
        ),
        removeSeries: vi.fn((api: FakeSeries) => {
          const pane = chart.panesList.find((candidate) =>
            candidate.series.includes(api),
          );
          if (!pane) {
            // The real library asserts here: removing a series the chart does not hold is a bug.
            throw new Error("Series not found");
          }
          pane.series.splice(pane.series.indexOf(api), 1);
          if (
            pane.series.length === 0 &&
            !pane.preserved &&
            chart.panesList.length > 1
          ) {
            chart.panesList.splice(chart.panesList.indexOf(pane), 1);
          }
        }),
        applyOptions: vi.fn(),
        timeScale: vi.fn(() => scale),
        scale,
        fitContent,
        subscribeVisibleLogicalRangeChange,
        unsubscribeVisibleLogicalRangeChange,
        panes: vi.fn(() => chart.panesList),
        // An empty pane at the bottom, kept without series when asked to be.
        addPane: vi.fn((preserved = false) => {
          const pane = newPane(preserved);
          chart.panesList.push(pane);
          return pane;
        }),
        // The real one drops the pane but not its series, so removing a pane that still holds
        // one is a bug the mock refuses too.
        removePane: vi.fn((index: number) => {
          const pane = chart.panesList[index];
          if (!pane || pane.series.length > 0) {
            throw new Error("Refusing to remove a missing or non-empty pane");
          }
          chart.panesList.splice(index, 1);
        }),
        // Checked against the model's panes, as the real chart does, and a swap of two panes.
        swapPanes: vi.fn((first: number, second: number) => {
          const count = chart.panesList.length;
          if (first < 0 || first >= count || second < 0 || second >= count) {
            throw new Error("Invalid pane index");
          }
          const held = chart.panesList[first] as FakePane;
          chart.panesList[first] = chart.panesList[second] as FakePane;
          chart.panesList[second] = held;
        }),
        subscribeCrosshairMove: vi.fn(),
        unsubscribeCrosshairMove: vi.fn(),
        remove: vi.fn(),
      };
      chart.panesList.push(newPane());
      return chart;
    },
  );
  return {
    createChart: createChartMock,
    AreaSeries: "AreaSeries",
    HistogramSeries: "HistogramSeries",
    LineSeries: "LineSeries",
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2, LargeDashed: 3, SparseDotted: 4 },
    LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
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

/**
 * `count` consecutive daily bars ending on `2026-08-28`.
 *
 * The viewport assertions need a realistic bar count: a logical range is measured in bar indices,
 * and the chart now refuses one that reaches outside the domain, so a window spanning hundreds of
 * bars is only meaningful against a series that has them.
 */
function dailySeries(count: number): Array<{ date: string; value: number }> {
  const end = Date.parse("2026-08-28T00:00:00Z");
  return Array.from({ length: count }, (_unused, index) => ({
    date: new Date(end - (count - 1 - index) * 86_400_000)
      .toISOString()
      .slice(0, 10),
    value: 100 + index,
  }));
}

/**
 * Bars of empty space the chart allows to the left of `oldest`: the unloaded part of the permitted
 * domain, in trading days. Past it the viewport would be reaching before the reported boundary,
 * which is the thirty-year bound this chart exists to enforce.
 */
function leadBarsFor(oldest: string): number {
  return Math.ceil(
    Math.round(
      (Date.parse(`${oldest}T00:00:00Z`) -
        Date.parse(`${FRAME.historyStart}T00:00:00Z`)) /
        86_400_000,
    ) /
      (365 / 252),
  );
}

/**
 * Daily volume for the same sessions as `POINTS`.
 *
 * Most suites assert nothing about it — the histogram is always drawn, so it is simply part of a
 * valid render, and the volume-specific behaviour has its own suite below.
 */
const VOLUME = [
  { date: "2026-08-27", value: 41_237_500 },
  { date: "2026-08-28", value: 52_100_000 },
] as const;

/**
 * No Relative Volume readings: the warm-up state, and the default for every suite that is not
 * about the legend. A session with no entry must leave the legend silent rather than print a zero.
 */
const NO_RELATIVE_VOLUME = new Map<
  string,
  { rvol10?: number; rvol20?: number; rvol50?: number }
>();

/**
 * The window a selected range asks the chart to show. The default asks for exactly what `POINTS`
 * holds, which is the ordinary case: the range fits inside the loaded history, so framing it is
 * `fitContent()`.
 */
const FRAME = {
  frameFrom: "2026-08-27",
  frameTo: "2026-08-28",
  // Thirty years before the loaded window: the navigable boundary the API reports, which is what
  // the chart bounds the viewport by rather than recomputing.
  historyStart: "1996-08-28",
  historyExhausted: false,
} as const;

describe("StockPriceChart", () => {
  it("feeds the closing prices into the price series and fits the visible range", () => {
    render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    // 0 is the price area, 1 is the always-present volume histogram; overlays follow.
    const overlaySeries = chart.addedSeries[2];
    expect(overlaySeries?.definition).toBe("LineSeries");
    expect(overlaySeries?.options.color).toBe(overlayColorAt(0));
    expect(overlaySeries?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-28", value: 220 },
    ]);

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.removeSeries).toHaveBeenCalledWith(overlaySeries?.api);
  });

  it("formats each pane's axis from its own series, so the oscillator axis stays unitless", () => {
    // Regression: money formatting used to be set chart-wide through
    // `localization.priceFormatter`, which Lightweight Charts applies in preference to *every*
    // series' own `priceFormat`. The unitless oscillator pane's axis therefore rendered currency —
    // an RSI reading of 64.9 appeared on the scale as "$64.87". Formatting belongs to the series.
    render(
      <StockPriceChart
        points={POINTS}
        overlays={[priceOverlay(0), rsiOverlay("RSI_14D", "RSI 14D", 1, 54.32)]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    expect(
      (chart.options.localization as { priceFormatter?: unknown } | undefined)
        ?.priceFormatter,
    ).toBeUndefined();

    const formatterOf = (options: Record<string, unknown>) =>
      (options.priceFormat as { formatter: (value: number) => string })
        .formatter;
    const [price, volumeHistogram, overlay, oscillator] = chart.addedSeries;
    expect(formatterOf(volumeHistogram!.options)(41_237_500)).toBe("41.2M");
    expect(formatterOf(price!.options)(232.139)).toBe("$232.14");
    expect(formatterOf(overlay!.options)(232.139)).toBe("$232.14");
    // The oscillator reads as a bare number on its own axis, in both panes' crosshair labels.
    expect(formatterOf(oscillator!.options)(64.87)).toBe("64.9");
  });

  it("hands an unavailable day to the library as whitespace, never as a joined segment", () => {
    // Regression: a point with no value must reach Lightweight Charts as `{ time }` alone. That
    // is the library's whitespace form and is what breaks the line; emitting `{ time, value:
    // undefined }` — or omitting the day entirely — draws a straight segment across the interval
    // instead, inventing intrinsic values the backend deliberately did not materialize.
    const overlay = {
      id: "BALANCED",
      label: "Balanced",
      color: overlayColorAt(0),
      placement: "PRICE_OVERLAY" as const,
      points: [
        { date: "2026-08-27", value: 220 },
        { date: "2026-08-28" },
        { date: "2026-08-31", value: 180 },
      ],
    };
    render(
      <StockPriceChart
        points={POINTS}
        overlays={[overlay]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    const written = lastChart().addedSeries[2]?.api.setData.mock
      .calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(written).toEqual([
      // Painting the point *before* the gap transparent is what removes the bridging segment:
      // the library filters whitespace out before rendering, so whitespace alone would still
      // leave the two values on either side joined by one straight line.
      { time: "2026-08-27", value: 220, color: CHART_COLORS.overlayGap },
      { time: "2026-08-28" },
      { time: "2026-08-31", value: 180 },
    ]);
    // Not merely undefined-valued: the key must be absent, which `toEqual` alone would not catch.
    expect(Object.hasOwn(written[1] as object, "value")).toBe(false);
    // The overlay's own colour is untouched everywhere else, so only the bridge disappears.
    expect(written[2]?.color).toBeUndefined();
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const onCrosshairMove = chart.subscribeCrosshairMove.mock.calls[0]?.[0] as (
      param: unknown,
    ) => void;
    const seriesData = new Map<unknown, { value: number }>([
      [chart.addedSeries[0]?.api, { value: 232 }],
      [chart.addedSeries[1]?.api, { value: 52_100_000 }],
      [chart.addedSeries[2]?.api, { value: 220 }],
      [chart.addedSeries[3]?.api, { value: 216 }],
      [chart.addedSeries[4]?.api, { value: 290 }],
    ]);
    onCrosshairMove({ time: "2026-08-28", seriesData });

    const legend = screen.getByTestId("chart-legend");
    expect(legend.hidden).toBe(false);
    expect(legend.textContent).toContain("Close$232.00");
    expect(legend.textContent).toContain("Volume52.1M");
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const overlaySeries = chart.addedSeries[2];
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        loading
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    // Navigation is written by the shared bounded time scale rather than at creation, so that one
    // place owns both which gestures exist and how far they may reach.
    const applied = Object.assign(
      {},
      ...chart.applyOptions.mock.calls.map((call) => call[0] as object),
    ) as {
      handleScroll?: Record<string, boolean>;
      handleScale?: Record<string, unknown>;
    };
    // Dragging the plot pans through history; wheel and pinch zoom the time scale.
    expect(applied.handleScroll).toMatchObject({
      pressedMouseMove: true,
      horzTouchDrag: true,
      // A vertical swipe belongs to the page on a phone, not to the chart.
      vertTouchDrag: false,
    });
    expect(applied.handleScale).toMatchObject({
      mouseWheel: true,
      pinch: true,
    });
  });

  it("keeps the viewport across data updates and overlay changes", () => {
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    // Neither does enabling an indicator.
    rerender(
      <StockPriceChart
        points={[{ date: "2026-08-26", value: 190 }, ...POINTS]}
        overlays={[priceOverlay(0)]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="5Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    expect(chart.fitContent).toHaveBeenCalledTimes(2);
  });

  it("frames a window that lands inside the loaded history by date", () => {
    // A narrower range than what is loaded is a window, not a fit: showing everything would
    // ignore the range the user picked.
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    expect(chart.fitContent).toHaveBeenCalledTimes(1);

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="3M"
        frameFrom="2026-08-28"
        frameTo="2026-08-28"
        historyStart="1996-08-28"
        historyExhausted={false}
        ariaLabel="AAPL chart"
      />,
    );

    expect(chart.scale.setVisibleRange).toHaveBeenCalledWith({
      from: "2026-08-28",
      to: "2026-08-28",
    });
    expect(chart.fitContent).toHaveBeenCalledTimes(1);
  });

  it("reframes again once a long range finishes loading its fuller history", () => {
    // The page changes the key when a range is picked and once more when that range's history is
    // in; the chart frames on each and on nothing else.
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y|true"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const fiveYear = {
      frameFrom: "2021-08-28",
      frameTo: "2026-08-28",
      historyStart: "1996-08-28",
      historyExhausted: false,
    } as const;

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        loading
        fitKey="5Y|false"
        {...fiveYear}
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.fitContent).toHaveBeenCalledTimes(2);

    // A trading day rarely lands on the requested calendar start, so "the history arrived" is the
    // page's answer, not something the chart infers from the oldest bar it happens to hold.
    const longHistory = [{ date: "2021-08-30", value: 90 }, ...POINTS];
    rerender(
      <StockPriceChart
        points={longHistory}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="5Y|true"
        {...fiveYear}
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.fitContent).toHaveBeenCalledTimes(3);

    // ...and an overlay toggle afterwards is not a request to reframe.
    rerender(
      <StockPriceChart
        points={longHistory}
        overlays={[priceOverlay(0)]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="5Y|true"
        {...fiveYear}
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.fitContent).toHaveBeenCalledTimes(3);
  });

  it("shifts the viewport by the bars an older window prepends", () => {
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    // The user has dragged left: thirty bars of empty space sit in front of the oldest bar.
    chart.scale.logical = { from: -30, to: 2 };
    const older = [
      { date: "2026-08-24", value: 180 },
      { date: "2026-08-25", value: 185 },
      { date: "2026-08-26", value: 190 },
      ...POINTS,
    ];
    rerender(
      <StockPriceChart
        points={older}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    // Three bars appeared in front of the window, so the same days stay on screen. Without the
    // shift the library's index-anchored range would have walked the user three days backwards.
    expect(chart.scale.setVisibleLogicalRange).toHaveBeenCalledWith({
      from: -27,
      to: 5,
    });
    // ...and this is not a reframe: the window the range asked for has not changed.
    expect(chart.fitContent).toHaveBeenCalledTimes(1);
  });

  it("leaves the viewport alone when the data grows at the tail", () => {
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    chart.scale.setVisibleLogicalRange.mockClear();
    chart.scale.logical = { from: 0, to: 2 };

    rerender(
      <StockPriceChart
        points={[...POINTS, { date: "2026-08-31", value: 240 }]}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    expect(chart.scale.setVisibleLogicalRange).not.toHaveBeenCalled();
  });

  it("reports how much empty history the viewport has reached", () => {
    const onReachHistoryEdge = vi.fn();
    render(
      <StockPriceChart
        points={dailySeries(260)}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        onReachHistoryEdge={onReachHistoryEdge}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const onRangeChange = chart.subscribeVisibleLogicalRangeChange.mock
      .calls[0]?.[0] as (range: { from: number; to: number } | null) => void;

    // Well inside the data: nothing to load.
    onRangeChange({ from: 120, to: 260 });
    expect(onReachHistoryEdge).not.toHaveBeenCalled();

    // Framing the whole loaded series leaves a fraction of a bar of padding at the left edge.
    // Reading that as navigation would make every page view prefetch a year nobody asked for.
    onRangeChange({ from: -0.5, to: 257.5 });
    expect(onReachHistoryEdge).not.toHaveBeenCalled();

    // A drag that has walked past the oldest bar reports the empty space it opened up.
    onRangeChange({ from: -42.4, to: 90 });
    expect(onReachHistoryEdge).toHaveBeenCalledWith(43);

    // A wide zoom-out reports a much larger gap, which is what makes one request fill it.
    onReachHistoryEdge.mockClear();
    onRangeChange({ from: -4800, to: 200 });
    expect(onReachHistoryEdge).toHaveBeenCalledWith(4800);
  });

  it("refuses a viewport reaching past the permitted history, and reports only what it allowed", () => {
    const onReachHistoryEdge = vi.fn();
    const points = dailySeries(260);
    const lead = leadBarsFor(points[0]!.date);
    render(
      <StockPriceChart
        points={points}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        onReachHistoryEdge={onReachHistoryEdge}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const onRangeChange = chart.subscribeVisibleLogicalRangeChange.mock
      .calls[0]?.[0] as (range: { from: number; to: number } | null) => void;

    // A drag that has walked three thousand bars past the oldest date this security may ever be
    // navigated to. The zoom the user chose is kept; only the position is corrected.
    onRangeChange({ from: -lead - 3_000, to: -lead - 2_500 });
    expect(chart.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: -lead,
      to: -lead + 500,
    });
    // ...and the history request is sized from what was allowed, never from what was attempted,
    // so a refused gesture cannot ask the API for history before the boundary.
    expect(onReachHistoryEdge).toHaveBeenLastCalledWith(lead);

    // A zoom-out wider than the whole domain cannot keep its span: it becomes the domain.
    onRangeChange({ from: -lead - 5_000, to: 900 });
    expect(chart.scale.setVisibleLogicalRange).toHaveBeenLastCalledWith({
      from: -lead,
      to: points.length,
    });
  });

  it("never opens empty space to the right of the newest bar", () => {
    render(
      <StockPriceChart
        points={dailySeries(260)}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    // The library's own refusal: with the right edge pinned there is no offset past the last bar
    // for a drag, a wheel or a pinch to reach, in any direction and at any zoom.
    const timeScaleOptions = chart.applyOptions.mock.calls
      .map((call) => (call[0] as { timeScale?: { fixRightEdge?: boolean } }).timeScale)
      .filter((options) => options !== undefined);
    expect(timeScaleOptions.at(-1)?.fixRightEdge).toBe(true);

    // A viewport that has somehow run past the newest bar is pulled back to it.
    const onRangeChange = chart.subscribeVisibleLogicalRangeChange.mock
      .calls[0]?.[0] as (range: { from: number; to: number } | null) => void;
    onRangeChange({ from: 300, to: 420 });
    expect(chart.scale.setVisibleLogicalRange).toHaveBeenCalledWith({
      from: 140,
      to: 260,
    });
  });

  it("ignores a viewport report describing data it has not drawn yet", () => {
    // The time scale reports a range while the series is being rewritten — the old, still-negative
    // window against data that is about to grow — and a load resolving re-renders this component
    // before the effect that draws the result. Acting on either report sizes the next request
    // against a window the user is about to be moved out of, which made every pan fetch twice.
    const onReachHistoryEdge = vi.fn();
    const props = {
      overlays: [],
      volume: VOLUME,
      relativeVolume: NO_RELATIVE_VOLUME,
      currency: "USD",
      fitKey: "1Y|true",
      ...FRAME,
      onReachHistoryEdge,
      ariaLabel: "AAPL chart",
    } as const;
    const loaded = dailySeries(260);
    const { rerender } = render(<StockPriceChart points={loaded} {...props} />);
    const chart = lastChart();
    const onRangeChange = chart.subscribeVisibleLogicalRangeChange.mock
      .calls[0]?.[0] as (range: { from: number; to: number } | null) => void;

    // The user has dragged past the oldest bar and the older window has arrived. Replaying the
    // pre-shift range from inside `setData` is what the library does on a real data update.
    chart.addedSeries[0]!.api.setData.mockImplementationOnce(() =>
      onRangeChange({ from: -60, to: 100 }),
    );
    const older = [{ date: "2000-01-03", value: 170 }, ...loaded];
    rerender(<StockPriceChart points={older} {...props} />);

    expect(onReachHistoryEdge).not.toHaveBeenCalled();

    // Once the series is drawn and the window repositioned, the same report is navigation again.
    onRangeChange({ from: -60, to: 100 });
    expect(onReachHistoryEdge).toHaveBeenCalledWith(60);
  });

  it("pins the left edge only once no older history can arrive", () => {
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const lastTimeScaleOptions = () =>
      chart.applyOptions.mock.calls
        .map(
          (call) =>
            (call[0] as { timeScale?: { fixLeftEdge?: boolean } }).timeScale,
        )
        .filter((options) => options !== undefined)
        .at(-1);

    // While history can still be loaded, the empty space to the left is how the user asks for it.
    expect(lastTimeScaleOptions()?.fixLeftEdge).toBe(false);

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        historyExhausted
        ariaLabel="AAPL chart"
      />,
    );
    // At the boundary there is nothing left to fetch, so dragging on into blank space is stopped
    // by the library itself — and the right edge stays pinned throughout.
    expect(lastTimeScaleOptions()).toMatchObject({
      fixLeftEdge: true,
      fixRightEdge: true,
    });
  });

  it("keeps its bounds when the selected series change", () => {
    const points = dailySeries(260);
    const { rerender } = render(
      <StockPriceChart
        points={points}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    chart.scale.setVisibleLogicalRange.mockClear();

    // Enabling an overlay adds a series and rewrites data; it must not re-create the chart, and
    // it must not hand back an unbounded time scale with it.
    rerender(
      <StockPriceChart
        points={points}
        overlays={[priceOverlay(0)]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    expect(lastChart()).toBe(chart);

    const lead = leadBarsFor(points[0]!.date);
    const onRangeChange = chart.subscribeVisibleLogicalRangeChange.mock
      .calls[0]?.[0] as (range: { from: number; to: number } | null) => void;
    onRangeChange({ from: -lead - 500, to: -lead - 400 });
    expect(chart.scale.setVisibleLogicalRange).toHaveBeenCalledWith({
      from: -lead,
      to: -lead + 100,
    });
  });

  it("publishes the visible window and the loaded history so both are observable from the DOM", () => {
    const points = dailySeries(260);
    const { container, rerender } = render(
      <StockPriceChart
        points={points}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    const wrapper = container.firstElementChild as HTMLElement;

    expect(wrapper.dataset.loadedFrom).toBe(points[0]?.date);
    expect(wrapper.dataset.historyExhausted).toBeUndefined();
    // The navigable domain itself, so a browser test can assert a viewport against the bound the
    // page navigates by rather than against a number it recomputed.
    expect(wrapper.dataset.domainFrom).toBe("1996-08-28");
    expect(wrapper.dataset.domainTo).toBe("2026-08-28");

    const onRangeChange = chart.subscribeVisibleLogicalRangeChange.mock
      .calls[0]?.[0] as (range: { from: number; to: number } | null) => void;
    chart.scale.getVisibleRange.mockReturnValue({
      from: "2026-08-27",
      to: "2026-08-28",
    });
    onRangeChange({ from: 12.5, to: 40.25 });

    // Dates are what "the user is looking at older history" means, and they survive a load that
    // prepends bars in front of the window; the logical range is what measures a zoom.
    expect(wrapper.dataset.visibleRange).toBe("2026-08-27|2026-08-28");
    expect(wrapper.dataset.visibleLogical).toBe("12.50|40.25");

    onRangeChange(null);
    expect(wrapper.dataset.visibleRange).toBeUndefined();
    expect(wrapper.dataset.visibleLogical).toBeUndefined();

    rerender(
      <StockPriceChart
        points={points}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        historyExhausted
        ariaLabel="AAPL chart"
      />,
    );
    expect(wrapper.dataset.historyExhausted).toBe("true");
  });

  it("tears the chart instance down on unmount", () => {
    const { unmount } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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

/**
 * Chart-mock entries that were added for oscillator overlays, in creation order.
 *
 * Matched on the oscillator pane's own index rather than on "has a pane index at all": the volume
 * histogram is also placed into a pane, and counting it here would make every oscillator
 * assertion off by one.
 */
function oscillatorSeries(chart: FakeChart) {
  return chart.addedSeries.filter((entry) => entry.paneIndex === 2);
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    // The price overlay stays on the price pane; the oscillator is never drawn over it.
    const price = chart.addedSeries[2];
    expect(price?.paneIndex).toBeUndefined();
    const rsi = chart.addedSeries[3];
    expect(rsi?.definition).toBe("LineSeries");
    // Pane 1 is volume; the oscillator pane sits below it.
    expect(rsi?.paneIndex).toBe(2);
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
    // The price pane keeps most of the height. Pane 1 is volume, pane 2 the oscillator, and both
    // factors are relative to the price pane's own 2 — not to 1.
    expect(chart.panesList[1]?.setStretchFactor).toHaveBeenCalledWith(0.45);
    expect(chart.panesList[2]?.setStretchFactor).toHaveBeenCalledWith(0.35);
  });

  it("keeps one set of 30/50/70 reference levels no matter how many periods are on", () => {
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[
          rsiOverlay("RSI_7D", "RSI 7D", 0, 61.2),
          rsiOverlay("RSI_14D", "RSI 14D", 1, 54.3),
        ]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      rerender(
        <StockPriceChart
          points={POINTS}
          overlays={[]}
          volume={VOLUME}
          relativeVolume={NO_RELATIVE_VOLUME}
          currency="USD"
          fitKey="1Y"
          {...FRAME}
          ariaLabel="AAPL chart"
        />,
      );
      rerender(
        <StockPriceChart
          points={POINTS}
          overlays={[overlay]}
          volume={VOLUME}
          relativeVolume={NO_RELATIVE_VOLUME}
          currency="USD"
          fitKey="1Y"
          {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
          volume={VOLUME}
          relativeVolume={NO_RELATIVE_VOLUME}
          currency="USD"
          fitKey="1Y"
          {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();
    expect(liveReferenceLines(chart)).toEqual([30, 50, 70]);

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[rsi7, rsi14]}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
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
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const onCrosshairMove = chart.subscribeCrosshairMove.mock.calls[0]?.[0] as (
      param: unknown,
    ) => void;
    const seriesData = new Map<unknown, { value: number }>([
      [chart.addedSeries[0]?.api, { value: 232 }],
      [chart.addedSeries[1]?.api, { value: 52_100_000 }],
      [chart.addedSeries[2]?.api, { value: 220 }],
      [chart.addedSeries[3]?.api, { value: 54.32 }],
    ]);
    onCrosshairMove({ time: "2026-08-28", seriesData });

    const legend = screen.getByTestId("chart-legend");
    expect(legend.textContent).toContain("SMA 50D$220.00");
    // Unitless: an RSI reading is never formatted as money.
    expect(legend.textContent).toContain("RSI 14D54.3");
    expect(legend.textContent).not.toContain("RSI 14D$");
  });
});

/**
 * A chosen fundamental as the page hands it to the chart: `points` is the drawn line (whitespace for
 * an unavailable session inside it) and `readings` every loaded session.
 */
function fundamentalSeries(
  overrides: Partial<ChartFundamentalSeries> & {
    points: ChartFundamentalSeries["points"];
  },
): ChartFundamentalSeries {
  return {
    id: "ROIC_TTM",
    label: "ROIC TTM",
    unit: "PERCENT",
    color: CHART_COLORS.fundamental,
    readings: new Map(
      overrides.points.map((point) => [point.date, point.value] as const),
    ),
    ...overrides,
  };
}

/** Five sessions: 12, a step to 18.25, one unavailable session, then 21. */
const ROIC = fundamentalSeries({
  points: [
    { date: "2026-08-24", value: 12 },
    { date: "2026-08-25", value: 18.25 },
    { date: "2026-08-26", value: 18.25 },
    { date: "2026-08-27" },
    { date: "2026-08-28", value: 21 },
  ],
});

const DEBT_TO_EQUITY = fundamentalSeries({
  id: "DEBT_TO_EQUITY",
  label: "Debt / Equity",
  unit: "MULTIPLE",
  points: [
    { date: "2026-08-27", value: 0.75 },
    { date: "2026-08-28", value: 1 },
  ],
});

function renderFundamental(
  fundamental: ChartFundamentalSeries | undefined,
  overlays: Parameters<typeof StockPriceChart>[0]["overlays"] = [],
) {
  return render(
    <StockPriceChart
      points={POINTS}
      overlays={overlays}
      {...(fundamental ? { fundamental } : {})}
      volume={VOLUME}
      relativeVolume={NO_RELATIVE_VOLUME}
      currency="USD"
      fitKey="1Y"
      {...FRAME}
      ariaLabel="AAPL chart"
    />,
  );
}

/** Series added with the fundamental's colour, still attached to the chart. */
function liveFundamentalSeries(chart: FakeChart) {
  const removed = new Set(chart.removeSeries.mock.calls.map((call) => call[0]));
  return chart.addedSeries.filter(
    (entry) =>
      entry.options.color === CHART_COLORS.fundamental &&
      !removed.has(entry.api),
  );
}

function formatterOf(options: Record<string, unknown>) {
  return (options.priceFormat as { formatter: (value: number) => string })
    .formatter;
}

describe("StockPriceChart fundamental pane", () => {
  it("draws the chosen metric as a step line in its own pane below the price and volume", () => {
    const { container } = renderFundamental(
      fundamentalSeries({
        points: [
          { date: "2026-08-27", value: 12 },
          { date: "2026-08-28", value: 18.25 },
        ],
      }),
    );
    const chart = lastChart();

    const [line, ...others] = liveFundamentalSeries(chart);
    expect(others).toEqual([]);
    expect(line?.definition).toBe("LineSeries");
    // Never on the price scale or the volume scale: a new pane at the bottom.
    expect(line?.paneIndex).toBe(2);
    expect(line?.api.getPane()).toBe(chart.panesList[2]);
    expect(chart.panesList).toHaveLength(3);
    // A step, never a slanted line between statement events.
    expect(line?.options.lineType).toBe(1);
    // No last-value label: after an invalidation it would print an older reading as current.
    expect(line?.options.lastValueVisible).toBe(false);
    expect(line?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-27", value: 12 },
      { time: "2026-08-28", value: 18.25 },
    ]);
    expect(chart.panesList[2]?.setStretchFactor).toHaveBeenCalledWith(0.6);
    expect(chart.panesList[1]?.setStretchFactor).toHaveBeenCalledWith(0.45);
    // The readings keep clear of the pane's edges on the one scale every stretch shares.
    expect(line?.api.scaleOptions).toEqual({
      scaleMargins: { top: 0.2, bottom: 0.15 },
    });

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset).toMatchObject({
      fundamental: "ROIC_TTM",
      fundamentalUnit: "PERCENT",
      fundamentalPane: "true",
      fundamentalRuns: "1",
      fundamentalGaps: "0",
      fundamentalSteps: "2026-08-27=12;2026-08-28=18.25",
    });
  });

  it("leaves an unavailable interval empty by drawing each available stretch on its own", () => {
    const { container } = renderFundamental(ROIC);
    const chart = lastChart();

    const lines = liveFundamentalSeries(chart);
    expect(lines).toHaveLength(2);
    // One pane for both stretches, and neither stretch reaches into the gap.
    expect(lines[1]?.paneIndex).toBe(2);
    expect(lines[0]?.api.getPane()).toBe(lines[1]?.api.getPane());
    expect(lines[0]?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-24", value: 12 },
      { time: "2026-08-25", value: 18.25 },
      { time: "2026-08-26", value: 18.25 },
    ]);
    expect(lines[1]?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-28", value: 21 },
    ]);
    // Nothing is carried or invented for 08-27: no point, no whitespace, no bridging colour.
    const written = lines.flatMap(
      (line) =>
        line.api.setData.mock.calls[0]?.[0] as Array<Record<string, unknown>>,
    );
    expect(written.map((point) => point.time)).not.toContain("2026-08-27");
    expect(written.some((point) => "color" in point)).toBe(false);

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.fundamentalRuns).toBe("2");
    expect(wrapper.dataset.fundamentalGaps).toBe("1");
    expect(wrapper.dataset.fundamentalSteps).toBe(
      "2026-08-24=12;2026-08-25=18.25;2026-08-27=;2026-08-28=21",
    );
  });

  it("draws a real zero and negative readings as values", () => {
    renderFundamental(
      fundamentalSeries({
        points: [
          { date: "2026-08-26", value: 0 },
          { date: "2026-08-27", value: -5 },
          { date: "2026-08-28", value: -0.4 },
        ],
      }),
    );
    const [line] = liveFundamentalSeries(lastChart());
    expect(line?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-26", value: 0 },
      { time: "2026-08-27", value: -5 },
      { time: "2026-08-28", value: -0.4 },
    ]);
  });

  it("formats the pane's axis and crosshair label in the metric's unit, never as money", () => {
    renderFundamental(ROIC);
    const [percent] = liveFundamentalSeries(lastChart());
    expect(formatterOf(percent!.options)(18.25)).toBe("18.25%");
    expect(formatterOf(percent!.options)(18.25)).not.toContain("$");

    renderFundamental(DEBT_TO_EQUITY);
    const [multiple] = liveFundamentalSeries(lastChart());
    expect(formatterOf(multiple!.options)(0.75)).toBe("0.75x");
    expect(formatterOf(multiple!.options)(1)).toBe("1.0x");
  });

  it("names the metric in the hover legend, with its reading or with Unavailable", () => {
    renderFundamental(ROIC);
    const chart = lastChart();
    const onCrosshairMove = chart.subscribeCrosshairMove.mock.calls[0]?.[0] as (
      param: unknown,
    ) => void;
    const legend = screen.getByTestId("chart-legend");
    const hover = (time: string) =>
      onCrosshairMove({
        time,
        seriesData: new Map([[chart.addedSeries[0]?.api, { value: 232 }]]),
      });

    hover("2026-08-25");
    expect(legend.textContent).toContain("ROIC TTM18.25%");

    // Inside the unavailable interval: words, never a number and never the previous 18.25%.
    hover("2026-08-27");
    expect(legend.textContent).toContain("ROIC TTMUnavailable");
    expect(legend.textContent).not.toContain("18.25%");

    // A session the metric was never loaded for says nothing about it at all.
    hover("2026-08-21");
    expect(legend.textContent).not.toContain("ROIC TTM");
  });

  it("replaces the previous metric's lines, pane and scale when another is chosen", () => {
    const { rerender } = renderFundamental(ROIC);
    const chart = lastChart();
    const show = (fundamental: ChartFundamentalSeries | undefined) =>
      rerender(
        <StockPriceChart
          points={POINTS}
          overlays={[]}
          {...(fundamental ? { fundamental } : {})}
          volume={VOLUME}
          relativeVolume={NO_RELATIVE_VOLUME}
          currency="USD"
          fitKey="1Y"
          {...FRAME}
          ariaLabel="AAPL chart"
        />,
      );
    const roicLines = liveFundamentalSeries(chart);

    show(DEBT_TO_EQUITY);
    for (const line of roicLines) {
      expect(chart.removeSeries).toHaveBeenCalledWith(line.api);
    }
    const debtLines = liveFundamentalSeries(chart);
    expect(debtLines).toHaveLength(1);
    expect(formatterOf(debtLines[0]!.options)(0.75)).toBe("0.75x");
    expect(debtLines[0]?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-27", value: 0.75 },
      { time: "2026-08-28", value: 1 },
    ]);
    // Still exactly price, volume and one fundamental pane.
    expect(chart.panesList).toHaveLength(3);

    // Repeated switching never accumulates lines or panes.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      show(ROIC);
      show(DEBT_TO_EQUITY);
    }
    expect(liveFundamentalSeries(chart)).toHaveLength(1);
    expect(chart.panesList).toHaveLength(3);

    // None removes the pane altogether.
    show(undefined);
    expect(liveFundamentalSeries(chart)).toHaveLength(0);
    expect(chart.panesList).toHaveLength(2);
  });

  it("keeps the lower panes in order, volume then oscillator then fundamental, whichever came first", () => {
    const rsi = rsiOverlay("RSI_14D", "RSI 14D", 0, 54.3);
    const { rerender, container } = renderFundamental(ROIC);
    const chart = lastChart();
    const fundamentalPane = liveFundamentalSeries(chart)[0]?.api.getPane();
    expect(chart.panesList.indexOf(fundamentalPane!)).toBe(2);

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.paneOrder).toBe("price,volume,fundamental");

    // The oscillator arrives second: its new pane opens at the bottom and is swapped above.
    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[rsi]}
        fundamental={ROIC}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const oscillator = oscillatorSeriesIn(chart).at(-1);
    expect(oscillator?.paneIndex).toBe(3);
    const oscillatorPane = oscillator?.api.getPane();
    expect(chart.panesList).toHaveLength(4);
    expect(chart.panesList.indexOf(oscillatorPane!)).toBe(2);
    expect(chart.panesList.indexOf(fundamentalPane!)).toBe(3);
    expect(chart.swapPanes).toHaveBeenCalledTimes(1);
    expect(chart.swapPanes).toHaveBeenCalledWith(3, 2);
    expect(wrapper.dataset.paneOrder).toBe(
      "price,volume,oscillator,fundamental",
    );
    // The RSI never lands on the fundamental's scale, nor a fundamental on the RSI's.
    expect(oscillatorPane).not.toBe(fundamentalPane);
    expect(oscillatorPane?.setStretchFactor).toHaveBeenCalledWith(0.35);
    expect(fundamentalPane?.setStretchFactor).toHaveBeenCalledWith(0.6);
    expect(wrapper.dataset.oscillatorPane).toBe("true");
    expect(wrapper.dataset.fundamentalPane).toBe("true");

    // The oscillator leaves again: its pane goes and the fundamental's moves up beneath volume.
    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        fundamental={ROIC}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.panesList).toHaveLength(3);
    expect(chart.panesList.indexOf(fundamentalPane!)).toBe(2);
    expect(wrapper.dataset.paneOrder).toBe("price,volume,fundamental");
  });

  it("puts a fundamental chosen after an oscillator below the oscillator's pane", () => {
    const rsi = rsiOverlay("RSI_14D", "RSI 14D", 0, 54.3);
    const { rerender, container } = renderFundamental(undefined, [rsi]);
    const chart = lastChart();
    const oscillatorPane = oscillatorSeriesIn(chart)[0]?.api.getPane();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.paneOrder).toBe("price,volume,oscillator");

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[rsi]}
        fundamental={DEBT_TO_EQUITY}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const [line] = liveFundamentalSeries(chart);
    expect(line?.paneIndex).toBe(3);
    expect(chart.panesList.indexOf(oscillatorPane!)).toBe(2);
    expect(chart.panesList.indexOf(line!.api.getPane())).toBe(3);
    // Already in order: nothing is swapped.
    expect(chart.swapPanes).not.toHaveBeenCalled();
    expect(wrapper.dataset.paneOrder).toBe(
      "price,volume,oscillator,fundamental",
    );
  });

  it("draws no pane for a metric with no value anywhere in the loaded history", () => {
    const { container } = renderFundamental(fundamentalSeries({ points: [] }));
    const chart = lastChart();
    expect(liveFundamentalSeries(chart)).toEqual([]);
    expect(chart.panesList).toHaveLength(2);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.fundamentalPane).toBeUndefined();
    expect(wrapper.dataset.fundamentalSpace).toBeUndefined();
    expect(wrapper.dataset.fundamental).toBe("ROIC_TTM");
    expect(wrapper.dataset.fundamentalRuns).toBe("0");
  });

  it("holds the fundamental's place with an empty pane while a chosen metric loads", () => {
    const chartFor = (props: {
      fundamental?: ChartFundamentalSeries;
      fundamentalPending?: boolean;
      overlays?: ChartOverlaySeries[];
    }) => (
      <StockPriceChart
        points={POINTS}
        overlays={props.overlays ?? []}
        {...(props.fundamental ? { fundamental: props.fundamental } : {})}
        fundamentalPending={props.fundamentalPending ?? false}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />
    );
    const { rerender, container } = render(
      chartFor({ fundamentalPending: true }),
    );
    const chart = lastChart();
    const wrapper = container.firstElementChild as HTMLElement;

    // Chosen, nothing arrived yet: an empty, preserved pane at the fundamental's height, and the
    // wrapper's room for it. No line, and no pane reported as drawn.
    expect(chart.addPane).toHaveBeenCalledWith(true);
    const placeholder = chart.panesList[2];
    expect(chart.panesList).toHaveLength(3);
    expect(placeholder?.series).toEqual([]);
    expect(placeholder?.setStretchFactor).toHaveBeenCalledWith(0.6);
    expect(liveFundamentalSeries(chart)).toEqual([]);
    expect(wrapper.dataset.fundamentalSpace).toBe("true");
    expect(wrapper.dataset.fundamentalPane).toBeUndefined();
    expect(wrapper.dataset.paneOrder).toBe("price,volume,fundamental");

    // Arrived: the placeholder goes and the line opens a fresh pane of its own in the same place,
    // so no scale or range of anything before it can carry over.
    rerender(chartFor({ fundamental: ROIC }));
    expect(chart.removePane).toHaveBeenCalledWith(2);
    expect(chart.panesList).toHaveLength(3);
    expect(chart.panesList).not.toContain(placeholder);
    const [line] = liveFundamentalSeries(chart);
    expect(line?.api.getPane()).toBe(chart.panesList[2]);
    expect(wrapper.dataset.fundamentalSpace).toBe("true");
    expect(wrapper.dataset.fundamentalPane).toBe("true");
    expect(wrapper.dataset.paneOrder).toBe("price,volume,fundamental");

    // Another metric chosen: the line goes and a placeholder holds the same place again.
    rerender(chartFor({ fundamentalPending: true }));
    expect(liveFundamentalSeries(chart)).toEqual([]);
    expect(chart.panesList).toHaveLength(3);
    expect(chart.panesList[2]?.series).toEqual([]);
    expect(chart.addPane).toHaveBeenCalledTimes(2);
    expect(wrapper.dataset.paneOrder).toBe("price,volume,fundamental");

    // None, a failure, or a metric with nothing to draw: no pane and no room.
    rerender(chartFor({}));
    expect(chart.panesList).toHaveLength(2);
    expect(wrapper.dataset.fundamentalSpace).toBeUndefined();
    expect(wrapper.dataset.paneOrder).toBe("price,volume");
    rerender(chartFor({ fundamental: fundamentalSeries({ points: [] }) }));
    expect(chart.panesList).toHaveLength(2);
    expect(wrapper.dataset.fundamentalSpace).toBeUndefined();
  });

  it("keeps the placeholder below an RSI switched on while it waits, and draws the line there", () => {
    const rsi = rsiOverlay("RSI_14D", "RSI 14D", 0, 54.3);
    const chartFor = (props: {
      fundamental?: ChartFundamentalSeries;
      fundamentalPending?: boolean;
      overlays: ChartOverlaySeries[];
    }) => (
      <StockPriceChart
        points={POINTS}
        overlays={props.overlays}
        {...(props.fundamental ? { fundamental: props.fundamental } : {})}
        fundamentalPending={props.fundamentalPending ?? false}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />
    );
    const { rerender, container } = render(
      chartFor({ overlays: [], fundamentalPending: true }),
    );
    const chart = lastChart();
    const wrapper = container.firstElementChild as HTMLElement;
    const placeholder = chart.panesList[2];

    // The RSI's pane arrives below the placeholder and is swapped above it, as above a line.
    rerender(chartFor({ overlays: [rsi], fundamentalPending: true }));
    expect(chart.swapPanes).toHaveBeenCalledWith(3, 2);
    expect(chart.panesList.indexOf(placeholder!)).toBe(3);
    expect(wrapper.dataset.paneOrder).toBe(
      "price,volume,oscillator,fundamental",
    );

    rerender(chartFor({ overlays: [rsi], fundamental: DEBT_TO_EQUITY }));
    expect(chart.removePane).toHaveBeenCalledWith(3);
    const [line] = liveFundamentalSeries(chart);
    expect(chart.panesList.indexOf(line!.api.getPane())).toBe(3);
    expect(chart.panesList[2]?.series.length).toBeGreaterThan(0);
    expect(wrapper.dataset.paneOrder).toBe(
      "price,volume,oscillator,fundamental",
    );
  });

  it("does not redraw the fundamental when an unrelated overlay is toggled", () => {
    const { rerender } = renderFundamental(ROIC);
    const chart = lastChart();
    const before = liveFundamentalSeries(chart);
    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[priceOverlay(0)]}
        fundamental={ROIC}
        volume={VOLUME}
        relativeVolume={NO_RELATIVE_VOLUME}
        currency="USD"
        fitKey="1Y"
        {...FRAME}
        ariaLabel="AAPL chart"
      />,
    );
    const after = liveFundamentalSeries(chart);
    expect(after.map((entry) => entry.api)).toEqual(
      before.map((entry) => entry.api),
    );
    for (const entry of before) {
      expect(chart.removeSeries).not.toHaveBeenCalledWith(entry.api);
    }
  });

  it("survives a development remount without touching a disposed chart", () => {
    // Strict mode mounts, disposes and remounts: the second chart must be built from nothing, and
    // no series belonging to the first may be removed from it — the library throws on that.
    expect(() =>
      render(
        <StrictMode>
          <StockPriceChart
            points={POINTS}
            overlays={[rsiOverlay("RSI_14D", "RSI 14D", 0, 54.3)]}
            fundamental={ROIC}
            volume={VOLUME}
            relativeVolume={NO_RELATIVE_VOLUME}
            currency="USD"
            fitKey="1Y"
            {...FRAME}
            ariaLabel="AAPL chart"
          />
        </StrictMode>,
      ),
    ).not.toThrow();
    const chart = lastChart();
    expect(liveFundamentalSeries(chart)).toHaveLength(2);
    expect(chart.panesList).toHaveLength(4);
  });

  it("builds a fresh placeholder on a development remount, never removing the disposed one", () => {
    // The first chart's placeholder is disposed with it. Were it remembered, the second chart
    // would be asked to remove a pane it does not have.
    expect(() =>
      render(
        <StrictMode>
          <StockPriceChart
            points={POINTS}
            overlays={[]}
            fundamentalPending
            volume={VOLUME}
            relativeVolume={NO_RELATIVE_VOLUME}
            currency="USD"
            fitKey="1Y"
            {...FRAME}
            ariaLabel="AAPL chart"
          />
        </StrictMode>,
      ),
    ).not.toThrow();
    const chart = lastChart();
    expect(chart.removePane).not.toHaveBeenCalled();
    expect(chart.panesList).toHaveLength(3);
    expect(chart.panesList[2]?.series).toEqual([]);
  });
});

/** Every series added into an oscillator pane, identified by its unitless formatter. */
function oscillatorSeriesIn(chart: FakeChart) {
  return chart.addedSeries.filter(
    (entry) =>
      entry.options.autoscaleInfoProvider !== undefined &&
      entry.definition === "LineSeries",
  );
}

/**
 * A chosen valuation ratio as the page hands it to the chart: `points` is the drawn line (whitespace
 * for an unavailable session inside it) and `readings` every loaded session.
 */
function valuationSeries(
  overrides: Partial<ChartValuationSeries> & {
    points: ChartValuationSeries["points"];
  },
): ChartValuationSeries {
  return {
    id: "PRICE_TO_EARNINGS_TTM",
    label: "P/E",
    color: CHART_COLORS.valuation,
    readings: new Map(
      overrides.points.map((point) => [point.date, point.value] as const),
    ),
    ...overrides,
  };
}

/** Five sessions of a daily P/E: a reading every session, one unavailable session, then more. */
const PE = valuationSeries({
  points: [
    { date: "2026-08-24", value: 18.2 },
    { date: "2026-08-25", value: 18.6 },
    { date: "2026-08-26", value: 18.4 },
    { date: "2026-08-27" },
    { date: "2026-08-28", value: 19.1 },
  ],
});

const EV_TO_EBITDA = valuationSeries({
  id: "EV_TO_EBITDA_TTM",
  label: "EV/EBITDA",
  points: [
    { date: "2026-08-27", value: -1.25 },
    { date: "2026-08-28", value: 0.75 },
  ],
});

function chartWith(props: {
  overlays?: ChartOverlaySeries[];
  valuation?: ChartValuationSeries;
  valuationPending?: boolean;
  fundamental?: ChartFundamentalSeries;
  fundamentalPending?: boolean;
}) {
  return (
    <StockPriceChart
      points={POINTS}
      overlays={props.overlays ?? []}
      {...(props.valuation ? { valuation: props.valuation } : {})}
      valuationPending={props.valuationPending ?? false}
      {...(props.fundamental ? { fundamental: props.fundamental } : {})}
      fundamentalPending={props.fundamentalPending ?? false}
      volume={VOLUME}
      relativeVolume={NO_RELATIVE_VOLUME}
      currency="USD"
      fitKey="1Y"
      {...FRAME}
      ariaLabel="AAPL chart"
    />
  );
}

/** Series added with the valuation colour, still attached to the chart. */
function liveValuationSeries(chart: FakeChart) {
  const removed = new Set(chart.removeSeries.mock.calls.map((call) => call[0]));
  return chart.addedSeries.filter(
    (entry) =>
      entry.options.color === CHART_COLORS.valuation && !removed.has(entry.api),
  );
}

function hoverLegend(chart: FakeChart) {
  const onCrosshairMove = chart.subscribeCrosshairMove.mock.calls[0]?.[0] as (
    param: unknown,
  ) => void;
  const legend = screen.getByTestId("chart-legend");
  return (time: string) => {
    onCrosshairMove({
      time,
      seriesData: new Map([[chart.addedSeries[0]?.api, { value: 232 }]]),
    });
    return legend.textContent ?? "";
  };
}

describe("StockPriceChart valuation pane", () => {
  it("draws the chosen ratio as an ordinary line in a pane of its own, below price and volume", () => {
    const { container } = render(
      chartWith({
        valuation: valuationSeries({
          points: [
            { date: "2026-08-27", value: 18.2 },
            { date: "2026-08-28", value: 18.6 },
          ],
        }),
      }),
    );
    const chart = lastChart();

    const [line, ...others] = liveValuationSeries(chart);
    expect(others).toEqual([]);
    expect(line?.definition).toBe("LineSeries");
    // Never on the price scale or the volume scale: a new pane at the bottom.
    expect(line?.paneIndex).toBe(2);
    expect(line?.api.getPane()).toBe(chart.panesList[2]);
    expect(line?.api.getPane()).not.toBe(chart.addedSeries[0]?.api.getPane());
    expect(chart.panesList).toHaveLength(3);
    // An ordinary line, never a step: daily price movement is not a staircase.
    expect(line?.options.lineType).toBe(0);
    expect(line?.options.lineType).not.toBe(1);
    // No last-value label and no price line: after the ratio becomes unavailable either would show
    // an older reading as though it were current.
    expect(line?.options.lastValueVisible).toBe(false);
    expect(line?.options.priceLineVisible).toBe(false);
    expect(line?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-27", value: 18.2 },
      { time: "2026-08-28", value: 18.6 },
    ]);
    expect(chart.panesList[2]?.setStretchFactor).toHaveBeenCalledWith(0.6);
    expect(line?.api.scaleOptions).toEqual({
      scaleMargins: { top: 0.2, bottom: 0.15 },
    });

    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset).toMatchObject({
      valuation: "PRICE_TO_EARNINGS_TTM",
      valuationPane: "true",
      valuationRuns: "1",
      valuationGaps: "0",
      valuationStretches: "2026-08-27..2026-08-28",
      valuationSpace: "true",
      // Read back from the series the library holds.
      valuationLine: "simple",
      paneOrder: "price,volume,valuation",
    });
  });

  it("leaves each unavailable interval empty by drawing every available stretch on its own", () => {
    const { container } = render(
      chartWith({
        valuation: valuationSeries({
          points: [
            { date: "2026-08-24", value: 18.2 },
            { date: "2026-08-25" },
            { date: "2026-08-26", value: 18.4 },
            { date: "2026-08-27" },
            { date: "2026-08-28", value: 19.1 },
          ],
        }),
      }),
    );
    const chart = lastChart();
    const lines = liveValuationSeries(chart);
    expect(lines).toHaveLength(3);
    // One pane for every stretch, and no stretch reaches into a gap.
    for (const line of lines) {
      expect(line.api.getPane()).toBe(lines[0]?.api.getPane());
      expect(line.options.lineType).toBe(0);
    }
    const written = lines.flatMap(
      (line) =>
        line.api.setData.mock.calls[0]?.[0] as Array<Record<string, unknown>>,
    );
    expect(written.map((point) => point.time)).toEqual([
      "2026-08-24",
      "2026-08-26",
      "2026-08-28",
    ]);
    // Nothing carried, interpolated or bridged with a transparent segment.
    expect(written.some((point) => "color" in point)).toBe(false);
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.dataset.valuationRuns).toBe("3");
    expect(wrapper.dataset.valuationGaps).toBe("2");
    expect(wrapper.dataset.valuationStretches).toBe(
      "2026-08-24..2026-08-24;2026-08-26..2026-08-26;2026-08-28..2026-08-28",
    );
  });

  it("draws a real zero and a negative EV/EBITDA as readings", () => {
    render(
      chartWith({
        valuation: valuationSeries({
          id: "EV_TO_EBITDA_TTM",
          label: "EV/EBITDA",
          points: [
            { date: "2026-08-26", value: 0 },
            { date: "2026-08-27", value: -1.25 },
            { date: "2026-08-28", value: -55.55 },
          ],
        }),
      }),
    );
    const [line] = liveValuationSeries(lastChart());
    expect(line?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-26", value: 0 },
      { time: "2026-08-27", value: -1.25 },
      { time: "2026-08-28", value: -55.55 },
    ]);
  });

  it("formats its axis and crosshair label as a raw multiple, never money or a percent", () => {
    render(chartWith({ valuation: PE }));
    const [line] = liveValuationSeries(lastChart());
    const format = formatterOf(line!.options);
    expect(format(0.75)).toBe("0.75x");
    expect(format(1)).toBe("1.0x");
    expect(format(15.2)).toBe("15.2x");
    expect(format(-1.25)).toBe("-1.25x");
    expect(format(0.004)).toBe("0.004x");
    expect(format(18.6)).not.toMatch(/[$%]/);
  });

  it("names the ratio in the hover legend with its reading, or Unavailable inside a gap", () => {
    render(chartWith({ valuation: PE }));
    const hover = hoverLegend(lastChart());

    expect(hover("2026-08-26")).toContain("P/E18.4x");
    // Inside the unavailable session: words, never a number and never the 18.4x before it.
    const gap = hover("2026-08-27");
    expect(gap).toContain("P/EUnavailable");
    expect(gap).not.toContain("18.4x");
    expect(hover("2026-08-28")).toContain("P/E19.1x");
    // A session never loaded for the ratio says nothing about it at all.
    expect(hover("2026-08-21")).not.toContain("P/E");
  });

  it("reads Unavailable on the newest session once the ratio has become unavailable, never the last reading", () => {
    const lapsed = valuationSeries({
      points: [
        { date: "2026-08-24", value: 18.2 },
        { date: "2026-08-25", value: 18.6 },
      ],
      readings: new Map([
        ["2026-08-24", 18.2],
        ["2026-08-25", 18.6],
        ["2026-08-26", undefined],
        ["2026-08-27", undefined],
        ["2026-08-28", undefined],
      ]),
    });
    render(chartWith({ valuation: lapsed }));
    const chart = lastChart();
    const [line] = liveValuationSeries(chart);
    // The line ends where the readings end, with no label carrying 18.6x to the right edge.
    expect(line?.options.lastValueVisible).toBe(false);
    const legend = hoverLegend(chart)("2026-08-28");
    expect(legend).toContain("P/EUnavailable");
    expect(legend).not.toContain("18.6x");
  });

  it("replaces the previous ratio's lines and pane when another is chosen, and None removes only its own pane", () => {
    const { rerender, container } = render(
      chartWith({ valuation: PE, fundamental: ROIC }),
    );
    const chart = lastChart();
    const wrapper = container.firstElementChild as HTMLElement;
    const fundamentalPane = liveFundamentalSeries(chart)[0]?.api.getPane();
    const peLines = liveValuationSeries(chart);
    expect(wrapper.dataset.paneOrder).toBe(
      "price,volume,valuation,fundamental",
    );

    rerender(chartWith({ valuation: EV_TO_EBITDA, fundamental: ROIC }));
    for (const line of peLines) {
      expect(chart.removeSeries).toHaveBeenCalledWith(line.api);
    }
    const evLines = liveValuationSeries(chart);
    expect(evLines).toHaveLength(1);
    expect(evLines[0]?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-27", value: -1.25 },
      { time: "2026-08-28", value: 0.75 },
    ]);
    // Still price, volume, one valuation pane and the fundamental's, in that order; the
    // fundamental's lines were not touched by the change of ratio.
    expect(chart.panesList).toHaveLength(4);
    expect(wrapper.dataset.paneOrder).toBe(
      "price,volume,valuation,fundamental",
    );
    expect(liveFundamentalSeries(chart)[0]?.api.getPane()).toBe(
      fundamentalPane,
    );
    for (const line of liveFundamentalSeries(chart)) {
      expect(chart.removeSeries).not.toHaveBeenCalledWith(line.api);
    }

    // Repeated switching never accumulates lines or panes.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      rerender(chartWith({ valuation: PE, fundamental: ROIC }));
      rerender(chartWith({ valuation: EV_TO_EBITDA, fundamental: ROIC }));
    }
    expect(liveValuationSeries(chart)).toHaveLength(1);
    expect(chart.panesList).toHaveLength(4);

    // None removes the valuation pane and leaves the fundamental's.
    rerender(chartWith({ fundamental: ROIC }));
    expect(liveValuationSeries(chart)).toHaveLength(0);
    expect(liveFundamentalSeries(chart).length).toBeGreaterThan(0);
    expect(chart.panesList).toHaveLength(3);
    expect(wrapper.dataset.paneOrder).toBe("price,volume,fundamental");
    expect(wrapper.dataset.valuationSpace).toBeUndefined();
    expect(wrapper.dataset.valuationLine).toBeUndefined();
  });

  it("keeps one pane order — volume, oscillator, valuation, fundamental — whatever order they are chosen in", () => {
    const rsi = rsiOverlay("RSI_14D", "RSI 14D", 0, 54.3);
    type Step = {
      overlays?: ChartOverlaySeries[];
      valuation?: ChartValuationSeries;
      fundamental?: ChartFundamentalSeries;
    };
    const orders: Step[][] = [
      // Fundamental, then RSI, then valuation.
      [
        { fundamental: ROIC },
        { fundamental: ROIC, overlays: [rsi] },
        { fundamental: ROIC, overlays: [rsi], valuation: PE },
      ],
      // Valuation, then RSI, then fundamental.
      [
        { valuation: PE },
        { valuation: PE, overlays: [rsi] },
        { valuation: PE, overlays: [rsi], fundamental: ROIC },
      ],
      // RSI, then fundamental, then valuation.
      [
        { overlays: [rsi] },
        { overlays: [rsi], fundamental: ROIC },
        { overlays: [rsi], fundamental: ROIC, valuation: PE },
      ],
      // Fundamental, then valuation, then RSI.
      [
        { fundamental: ROIC },
        { fundamental: ROIC, valuation: PE },
        { fundamental: ROIC, valuation: PE, overlays: [rsi] },
      ],
    ];
    for (const steps of orders) {
      const { rerender, container, unmount } = render(chartWith(steps[0]!));
      for (const step of steps.slice(1)) {
        rerender(chartWith(step));
      }
      const chart = lastChart();
      const wrapper = container.firstElementChild as HTMLElement;
      expect(wrapper.dataset.paneOrder).toBe(
        "price,volume,oscillator,valuation,fundamental",
      );
      // Five panes, each holding its own series: no ratio on the RSI's or the metric's scale.
      expect(chart.panesList).toHaveLength(5);
      const valuationPane = liveValuationSeries(chart)[0]?.api.getPane();
      const fundamentalPane = liveFundamentalSeries(chart)[0]?.api.getPane();
      const oscillatorPane = oscillatorSeriesIn(chart).at(-1)?.api.getPane();
      expect(chart.panesList.indexOf(oscillatorPane!)).toBe(2);
      expect(chart.panesList.indexOf(valuationPane!)).toBe(3);
      expect(chart.panesList.indexOf(fundamentalPane!)).toBe(4);
      expect(
        valuationPane?.series.every((series) =>
          liveValuationSeries(chart).some((entry) => entry.api === series),
        ),
      ).toBe(true);
      expect(valuationPane?.setStretchFactor).toHaveBeenCalledWith(0.6);
      unmount();
    }
  });

  it("holds the valuation pane's place with an empty pane while a chosen ratio loads", () => {
    const { rerender, container } = render(
      chartWith({ valuationPending: true }),
    );
    const chart = lastChart();
    const wrapper = container.firstElementChild as HTMLElement;

    expect(chart.addPane).toHaveBeenCalledWith(true);
    const placeholder = chart.panesList[2];
    expect(placeholder?.series).toEqual([]);
    expect(placeholder?.setStretchFactor).toHaveBeenCalledWith(0.6);
    expect(wrapper.dataset.valuationSpace).toBe("true");
    expect(wrapper.dataset.valuationPane).toBeUndefined();
    expect(wrapper.dataset.paneOrder).toBe("price,volume,valuation");

    // A fundamental chosen meanwhile goes below the placeholder.
    rerender(chartWith({ valuationPending: true, fundamental: ROIC }));
    expect(wrapper.dataset.paneOrder).toBe(
      "price,volume,valuation,fundamental",
    );

    // Arrived: the placeholder goes and the line opens a fresh pane in the same place.
    rerender(chartWith({ valuation: PE, fundamental: ROIC }));
    expect(chart.panesList).not.toContain(placeholder);
    expect(wrapper.dataset.paneOrder).toBe(
      "price,volume,valuation,fundamental",
    );
    expect(wrapper.dataset.valuationPane).toBe("true");

    // A ratio with nothing to draw holds no pane and no room.
    rerender(
      chartWith({
        valuation: valuationSeries({ points: [] }),
        fundamental: ROIC,
      }),
    );
    expect(liveValuationSeries(chart)).toEqual([]);
    expect(wrapper.dataset.valuationSpace).toBeUndefined();
    expect(wrapper.dataset.valuationRuns).toBe("0");
    expect(wrapper.dataset.paneOrder).toBe("price,volume,fundamental");
  });

  it("names both lower series on one crosshair, each in its own unit", () => {
    render(chartWith({ valuation: PE, fundamental: ROIC }));
    const legend = hoverLegend(lastChart())("2026-08-25");
    expect(legend).toContain("P/E18.6x");
    expect(legend).toContain("ROIC TTM18.25%");
    // The ratio's row comes first, as its pane does.
    expect(legend.indexOf("P/E")).toBeLessThan(legend.indexOf("ROIC TTM"));
  });

  it("does not redraw the ratio when an unrelated overlay or the fundamental changes", () => {
    const { rerender } = render(chartWith({ valuation: PE }));
    const chart = lastChart();
    const before = liveValuationSeries(chart);
    rerender(chartWith({ valuation: PE, overlays: [priceOverlay(0)] }));
    rerender(
      chartWith({
        valuation: PE,
        overlays: [priceOverlay(0)],
        fundamental: ROIC,
      }),
    );
    rerender(
      chartWith({
        valuation: PE,
        overlays: [priceOverlay(0)],
        fundamental: DEBT_TO_EQUITY,
      }),
    );
    expect(liveValuationSeries(chart).map((entry) => entry.api)).toEqual(
      before.map((entry) => entry.api),
    );
    for (const entry of before) {
      expect(chart.removeSeries).not.toHaveBeenCalledWith(entry.api);
    }
  });

  it("survives a development remount with every lower pane drawn", () => {
    expect(() =>
      render(
        <StrictMode>
          {chartWith({
            overlays: [rsiOverlay("RSI_14D", "RSI 14D", 0, 54.3)],
            valuation: PE,
            fundamental: ROIC,
          })}
        </StrictMode>,
      ),
    ).not.toThrow();
    const chart = lastChart();
    expect(liveValuationSeries(chart)).toHaveLength(2);
    expect(chart.panesList).toHaveLength(5);
    expect(chart.removePane).not.toHaveBeenCalled();
  });
});

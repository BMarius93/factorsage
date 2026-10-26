import type { BacktestCurvePointResponse } from "@intrinsic/contracts";
import { cleanup, render } from "@testing-library/react";
import type React from "react";
import { createChart } from "lightweight-charts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacktestComparisonChart } from "./BacktestComparisonChart";

type SeriesStub = {
  setData: ReturnType<typeof vi.fn>;
  applyOptions: ReturnType<typeof vi.fn>;
  createPriceLine: ReturnType<typeof vi.fn>;
};

const series: SeriesStub[] = [];
const seriesOptions: Array<Record<string, unknown>> = [];
/**
 * Every data write and every range write, in the order the chart made them.
 *
 * Order is load-bearing here, not incidental: a visible range is resolved against the time points
 * that exist when it is written, so framing the period before the curves are drawn names it over a
 * two-point scale — and the data write that follows leaves that two-bar window covering the first
 * week of a thirty-year run. That defect is invisible to an assertion that only checks *what* was
 * written, which is why this records *when*.
 */
const writes: string[] = [];
/**
 * Whether any series has put a point on the time scale.
 *
 * The real library resolves a time range against the points that exist and throws when there are
 * none, so a mock that always answers would hide the one state this chart is deliberately mounted
 * in: a backtest's axis exists from the moment the run does, before a single day is simulated.
 */
let scalePoints = 0;
const fitContent = vi.fn(() => writes.push("fitContent"));
const setVisibleRange = vi.fn((_range: { from: string; to: string }) => {
  writes.push("setVisibleRange");
});
const timeScaleApplyOptions = vi.fn();
const chartApplyOptions = vi.fn();

// jsdom cannot rasterize a canvas, so the library boundary is mocked and the assertions target
// what this component feeds into it — including the options the shared bounded time scale writes,
// which is where the horizontal domain and the interaction lock actually live.
vi.mock("lightweight-charts", () => ({
  createChart: vi.fn((_container: unknown, options: Record<string, unknown>) => {
    chartApplyOptions.mockClear();
    const chart = {
      options,
      addSeries: vi.fn((_definition: unknown, seriesOpts: Record<string, unknown>) => {
        const index = series.length;
        const stub: SeriesStub = {
          setData: vi.fn((rows: unknown[]) => {
            writes.push(`setData:${index}`);
            scalePoints = Math.max(scalePoints, rows.length);
          }),
          applyOptions: vi.fn(),
          createPriceLine: vi.fn(),
        };
        series.push(stub);
        seriesOptions.push(seriesOpts);
        return stub;
      }),
      timeScale: vi.fn(() => ({
        fitContent,
        setVisibleRange,
        applyOptions: timeScaleApplyOptions,
        getVisibleLogicalRange: vi.fn(() =>
          scalePoints === 0 ? null : { from: 0, to: scalePoints },
        ),
        setVisibleLogicalRange: vi.fn(),
        subscribeVisibleLogicalRangeChange: vi.fn(),
        unsubscribeVisibleLogicalRangeChange: vi.fn(),
      })),
      applyOptions: chartApplyOptions,
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      remove: vi.fn(),
    };
    return chart;
  }),
  LineSeries: "LineSeries",
  LineStyle: { Dashed: 2 },
}));

/** The options the chart was last given, merged in the order they were applied. */
function appliedChartOptions(): Record<string, unknown> {
  return Object.assign(
    {},
    ...chartApplyOptions.mock.calls.map((call) => call[0] as object),
  ) as Record<string, unknown>;
}

afterEach(() => {
  cleanup();
  series.length = 0;
  seriesOptions.length = 0;
  writes.length = 0;
  scalePoints = 0;
  fitContent.mockClear();
  setVisibleRange.mockClear();
  timeScaleApplyOptions.mockClear();
  chartApplyOptions.mockClear();
});

/** The order the chart adds them in: Strategy, benchmark, Cash, then the whitespace anchor. */
const STRATEGY = 0;
const BENCHMARK = 1;
const CASH = 2;
const ANCHOR = 3;

function pointOf(
  date: string,
  values: Partial<BacktestCurvePointResponse> = {},
): BacktestCurvePointResponse {
  return {
    date,
    portfolioReturnPercent: 0,
    benchmarkReturnPercent: null,
    strategyValue: 100_000,
    benchmarkValue: 100_000,
    cashBaselineValue: 100_000,
    ...values,
  };
}

const PERIOD = { periodStart: "1996-01-01", periodEnd: "2026-01-01" } as const;

/** The run's capital plan; the value axis is sized from the Cash scenario it implies. */
const CAPITAL = { initialCapital: 100_000, monthlyContribution: 500 } as const;

function chartProps(
  points: BacktestCurvePointResponse[],
  overrides: Partial<
    React.ComponentProps<typeof BacktestComparisonChart>
  > = {},
) {
  return {
    points,
    benchmarkName: "Total Market Index",
    ariaLabel: "Strategy against Total Market Index and cash",
    ...PERIOD,
    ...CAPITAL,
    populating: false,
    ...overrides,
  };
}

function renderChart(
  points: BacktestCurvePointResponse[],
  overrides: Partial<
    React.ComponentProps<typeof BacktestComparisonChart>
  > = {},
) {
  return render(<BacktestComparisonChart {...chartProps(points, overrides)} />);
}

describe("BacktestComparisonChart", () => {
  it("draws three absolute scenarios funded by the same cash flows", () => {
    const { container } = renderChart([
      pointOf("1996-01-02", {
        strategyValue: 100_000,
        benchmarkValue: 100_000,
        cashBaselineValue: 100_000,
      }),
      pointOf("1997-01-02", {
        strategyValue: 118_400,
        benchmarkValue: 112_000,
        cashBaselineValue: 112_000,
      }),
    ]);

    // Currency values, not percentage growth: the axis is what the money is worth.
    expect(series[STRATEGY]?.setData).toHaveBeenLastCalledWith([
      { time: "1996-01-02", value: 100_000 },
      { time: "1997-01-02", value: 118_400 },
    ]);
    expect(series[BENCHMARK]?.setData).toHaveBeenLastCalledWith([
      { time: "1996-01-02", value: 100_000 },
      { time: "1997-01-02", value: 112_000 },
    ]);
    expect(series[CASH]?.setData).toHaveBeenLastCalledWith([
      { time: "1996-01-02", value: 100_000 },
      { time: "1997-01-02", value: 112_000 },
    ]);

    const frame = container.querySelector("[data-testid='backtest-chart']");
    expect(frame?.getAttribute("data-series-count")).toBe("3");
    expect(frame?.getAttribute("data-strategy-points")).toBe("2");
    expect(frame?.getAttribute("data-benchmark-points")).toBe("2");
    expect(frame?.getAttribute("data-cash-points")).toBe("2");
    const legend = container.querySelector(
      "[data-testid='backtest-chart-series']",
    );
    expect(legend?.textContent).toContain("Strategy");
    expect(legend?.textContent).toContain("Total Market Index");
    expect(legend?.textContent).toContain("Cash");
  });

  it("breaks the benchmark line where it has no value rather than drawing a zero", () => {
    const { container } = renderChart([
      pointOf("1996-01-02", { benchmarkValue: null }),
      pointOf("1997-01-02", { benchmarkValue: 112_000 }),
    ]);

    // Whitespace, so the time scale stays aligned with the scenarios beside it.
    expect(series[BENCHMARK]?.setData).toHaveBeenLastCalledWith([
      { time: "1996-01-02" },
      { time: "1997-01-02", value: 112_000 },
    ]);
    const frame = container.querySelector("[data-testid='backtest-chart']");
    expect(frame?.getAttribute("data-benchmark-points")).toBe("1");
  });

  it("keeps Strategy and Cash when a run predates the funded benchmark scenario", () => {
    const { container } = renderChart([
      pointOf("1996-01-02", { benchmarkValue: null }),
      pointOf("1997-01-02", { benchmarkValue: null, strategyValue: 118_400 }),
    ]);

    const frame = container.querySelector("[data-testid='backtest-chart']");
    // Two scenarios, honestly reported, instead of a fabricated benchmark portfolio.
    expect(frame?.getAttribute("data-series-count")).toBe("2");
    expect(frame?.getAttribute("data-benchmark-points")).toBe("0");
    expect(frame?.getAttribute("data-strategy-points")).toBe("2");
    expect(frame?.getAttribute("data-cash-points")).toBe("2");
  });

  it("locks the horizontal axis to the configured period, not to what has been simulated", () => {
    renderChart([pointOf("1996-01-02"), pointOf("1997-01-02")]);

    // The anchor is the fourth series and carries one whitespace slot per calendar day of the
    // period — the domain materialized, because a Lightweight Charts time scale is ordinal and a
    // pair of endpoints would reserve two bars rather than thirty years of axis.
    expect(series).toHaveLength(4);
    const anchorRows = series[ANCHOR]?.setData.mock.calls[0]?.[0] as Array<{
      time: string;
      value?: number;
    }>;
    expect(anchorRows[0]).toEqual({ time: "1996-01-01" });
    expect(anchorRows.at(-1)).toEqual({ time: "2026-01-01" });
    expect(anchorRows).toHaveLength(10_959);
    // Whitespace throughout: not one slot carries a value.
    expect(anchorRows.every((row) => row.value === undefined)).toBe(true);
    expect(setVisibleRange).toHaveBeenCalledWith({
      from: "1996-01-01",
      to: "2026-01-01",
    });
    // Reframing to the computed part is exactly the behaviour being replaced: it would make a
    // running backtest's axis race ahead of its own curve.
    expect(fitContent).not.toHaveBeenCalled();
  });

  it("re-asserts the same period as a completed year extends the curve, never the computed part", () => {
    const { rerender } = renderChart([pointOf("1996-01-02")], {
      populating: true,
    });
    const anchor = series[ANCHOR];
    setVisibleRange.mockClear();
    anchor?.setData.mockClear();

    rerender(
      <BacktestComparisonChart
        {...chartProps(
          [
            pointOf("1996-01-02"),
            pointOf("2001-01-02", { strategyValue: 222_000 }),
          ],
          { populating: true },
        )}
      />,
    );

    // A data write keeps the visible *logical* range, so a curve that grew would otherwise have
    // the same window cover a shrinking slice of time. The domain is therefore re-asserted — and
    // what is re-asserted is the configured period, never anything derived from what has been
    // computed, which is what keeps the axis still while the lines fill in underneath it.
    expect(setVisibleRange).toHaveBeenCalledWith({
      from: "1996-01-01",
      to: "2026-01-01",
    });
    for (const call of setVisibleRange.mock.calls) {
      expect(call[0]).toEqual({ from: "1996-01-01", to: "2026-01-01" });
    }
    // The anchor is untouched: the domain itself did not change.
    expect(anchor?.setData).not.toHaveBeenCalled();
    expect(fitContent).not.toHaveBeenCalled();
    // The new point did reach the Strategy series, so the curve itself grew.
    expect(series[STRATEGY]?.setData).toHaveBeenLastCalledWith([
      { time: "1996-01-02", value: 100_000 },
      { time: "2001-01-02", value: 222_000 },
    ]);
  });

  it("holds the axis still once the run is finished", () => {
    const { rerender } = renderChart([pointOf("1996-01-02")]);
    setVisibleRange.mockClear();

    rerender(
      <BacktestComparisonChart
        {...chartProps([pointOf("1996-01-02"), pointOf("2001-01-02")])}
      />,
    );

    // Nothing is arriving any more, so the viewport belongs to the user: a rerender must not
    // move a window they zoomed or panned to.
    expect(setVisibleRange).not.toHaveBeenCalled();
    expect(fitContent).not.toHaveBeenCalled();
  });

  it("does not name a range on a scale that has no points at all", () => {
    // The library resolves a time range against the points on the scale and throws when there are
    // none. The chart is deliberately mounted before its first data write, so reaching that state
    // is ordinary rather than exceptional.
    scalePoints = 0;
    series.length = 0;
    const anchorless = render(
      <BacktestComparisonChart
        {...chartProps([], { periodStart: "", periodEnd: "" })}
      />,
    );
    expect(setVisibleRange).not.toHaveBeenCalled();
    anchorless.unmount();
  });

  it("establishes the whole configured period before any result exists", () => {
    // Nothing has been simulated. The domain is still the configured period, whole, so the axis a
    // user watches fill in is the axis the finished run will have.
    const { container } = renderChart([], { populating: true });

    const anchorRows = series[ANCHOR]?.setData.mock.calls[0]?.[0] as Array<{
      time: string;
    }>;
    expect(anchorRows[0]).toEqual({ time: "1996-01-01" });
    expect(anchorRows.at(-1)).toEqual({ time: "2026-01-01" });
    expect(setVisibleRange).toHaveBeenCalledWith({
      from: "1996-01-01",
      to: "2026-01-01",
    });
    const frame = container.querySelector("[data-testid='backtest-chart']");
    expect(frame?.getAttribute("data-strategy-points")).toBe("0");
    expect(frame?.getAttribute("data-period-start")).toBe("1996-01-01");
    expect(frame?.getAttribute("data-period-end")).toBe("2026-01-01");
  });

  it("pins both edges of the domain and refuses every gesture while the run is populating", () => {
    const { container, rerender } = renderChart([pointOf("1996-01-02")], {
      populating: true,
    });

    // Every gesture off at once — wheel, drag, touch drag, pinch, axis drag, double-click reset.
    // The library reads that combination as "all scrolling and scaling disabled" and pins the
    // edges itself, so there is no path by which the viewport can move.
    expect(appliedChartOptions()).toMatchObject({
      handleScroll: false,
      handleScale: false,
      kineticScroll: { touch: false, mouse: false },
      // The left edge is pinned to the anchor at the period's start. The right edge is not, and
      // must not be: the library pins it to the newest *value*, so a domain that deliberately
      // reaches past the computed prefix would be collapsed onto that prefix and would grow a
      // year at a time — the exact behaviour the fixed axis exists to prevent. Nothing is left
      // unbounded by it, because a locked chart refuses every gesture.
      timeScale: { fixLeftEdge: true, fixRightEdge: false },
    });
    expect(
      container
        .querySelector("[data-testid='backtest-chart']")
        ?.getAttribute("data-interaction"),
    ).toBe("locked");

    rerender(
      <BacktestComparisonChart
        {...chartProps([pointOf("1996-01-02")], { populating: false })}
      />,
    );

    // A finished run is a result: navigation comes back, and the domain stays exactly the period.
    const completed = appliedChartOptions();
    expect(completed.handleScroll).toMatchObject({
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false,
    });
    expect(completed.handleScale).toMatchObject({ mouseWheel: true, pinch: true });
    expect(completed.timeScale).toMatchObject({
      fixLeftEdge: true,
      fixRightEdge: true,
    });
    expect(
      container
        .querySelector("[data-testid='backtest-chart']")
        ?.getAttribute("data-interaction"),
    ).toBe("bounded");
  });

  it("asks for less bar spacing than fits, so the library's own reset lands on the whole period", () => {
    renderChart([pointOf("1996-01-02")]);

    // With both edges pinned the library's minimum bar spacing becomes "whatever fits every
    // point", and it clamps a smaller request up to that. Which makes the default double-click
    // reset restore exactly the configured period rather than an arbitrary six-pixels-per-bar
    // window anchored at the right edge.
    const created = vi.mocked(createChart).mock.calls.at(-1)?.[1] as {
      timeScale: { barSpacing: number };
    };
    expect(created.timeScale.barSpacing).toBeLessThanOrEqual(0.01);
  });

  it("sizes the value axis from the Cash scenario and only ever widens it while populating", () => {
    renderChart([pointOf("1996-01-02")], { populating: true });

    // Every funded scenario shares one floor; the whitespace anchor does not, because it has no
    // values and the library never consults an autoscale provider for a series without one.
    const provider = seriesOptions[STRATEGY]?.autoscaleInfoProvider as (
      base: () => { priceRange: { minValue: number; maxValue: number } | null },
    ) => { priceRange: { minValue: number; maxValue: number } | null } | null;
    expect(seriesOptions[BENCHMARK]?.autoscaleInfoProvider).toBe(provider);
    expect(seriesOptions[CASH]?.autoscaleInfoProvider).toBe(provider);
    expect(seriesOptions[ANCHOR]?.autoscaleInfoProvider).toBeUndefined();

    // 1996-01-01 to 2026-01-01 is 360 whole months of $500 on top of $100,000.
    const seeded = provider(() => ({
      priceRange: { minValue: 100_000, maxValue: 101_000 },
    }));
    expect(seeded?.priceRange).toEqual({
      minValue: 100_000,
      maxValue: 280_000,
    });

    // A year that genuinely exceeds the prepared range widens it rather than being clipped...
    const widened = provider(() => ({
      priceRange: { minValue: 90_000, maxValue: 400_000 },
    }));
    expect(widened?.priceRange).toEqual({ minValue: 90_000, maxValue: 400_000 });

    // ...and the next year landing back inside it does not shrink or recentre the axis.
    const held = provider(() => ({
      priceRange: { minValue: 120_000, maxValue: 300_000 },
    }));
    expect(held?.priceRange).toEqual({ minValue: 90_000, maxValue: 400_000 });
  });

  it("hands the value axis back to the library once the run is finished", () => {
    renderChart([pointOf("1996-01-02")], { populating: false });

    const provider = seriesOptions[STRATEGY]?.autoscaleInfoProvider as (
      base: () => { priceRange: { minValue: number; maxValue: number } | null },
    ) => { priceRange: { minValue: number; maxValue: number } | null } | null;
    // Nothing is arriving any more, so zooming into a completed curve rescales the way a reader
    // expects instead of being held to a floor accumulated over the run.
    const base = { priceRange: { minValue: 120_000, maxValue: 130_000 } };
    expect(provider(() => base)).toBe(base);
  });

  it("starts a restarted run from a clean value axis", () => {
    // A requeued attempt re-simulates from the first day, so its curve is shorter than what the
    // dead attempt drew. The floor the dead attempt widened must not survive into it.
    const { rerender } = renderChart(
      [pointOf("1996-01-02"), pointOf("2010-01-04", { strategyValue: 900_000 })],
      { populating: true },
    );
    const provider = seriesOptions[STRATEGY]?.autoscaleInfoProvider as (
      base: () => { priceRange: { minValue: number; maxValue: number } | null },
    ) => { priceRange: { minValue: number; maxValue: number } | null } | null;
    provider(() => ({ priceRange: { minValue: 100_000, maxValue: 900_000 } }));

    rerender(
      <BacktestComparisonChart
        {...chartProps([pointOf("1996-01-02")], { populating: true })}
      />,
    );

    const restarted = provider(() => ({
      priceRange: { minValue: 100_000, maxValue: 101_000 },
    }));
    expect(restarted?.priceRange).toEqual({
      minValue: 100_000,
      maxValue: 280_000,
    });
  });

  it("frames the period only once the curves are on the scale", () => {
    // The regression this pins: framing runs against the time points that exist at the time, so
    // naming the period before the curves are drawn resolves it over the anchor's two points, and
    // the data write that follows leaves that two-bar window covering the first days of the run.
    renderChart([pointOf("1996-01-02"), pointOf("1997-01-02")], {
      populating: true,
    });

    const framedAt = writes.lastIndexOf("setVisibleRange");
    expect(framedAt).toBeGreaterThan(-1);
    for (const index of [STRATEGY, BENCHMARK, CASH, ANCHOR]) {
      expect(
        writes.indexOf(`setData:${index}`),
        `series ${index} was drawn after the period was framed`,
      ).toBeLessThan(framedAt);
    }
  });

  it("publishes the period it is framed by", () => {
    const { container } = renderChart([pointOf("1996-01-02")]);
    const frame = container.querySelector("[data-period-start]");
    expect(frame?.getAttribute("data-period-start")).toBe("1996-01-01");
    expect(frame?.getAttribute("data-period-end")).toBe("2026-01-01");
  });
});

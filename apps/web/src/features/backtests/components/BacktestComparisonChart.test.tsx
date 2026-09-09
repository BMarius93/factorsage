import type { BacktestCurvePointResponse } from "@intrinsic/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacktestComparisonChart } from "./BacktestComparisonChart";

type SeriesStub = {
  setData: ReturnType<typeof vi.fn>;
  applyOptions: ReturnType<typeof vi.fn>;
  createPriceLine: ReturnType<typeof vi.fn>;
};

const series: SeriesStub[] = [];
const fitContent = vi.fn();
const setVisibleRange = vi.fn();

vi.mock("lightweight-charts", () => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => {
      const stub: SeriesStub = {
        setData: vi.fn(),
        applyOptions: vi.fn(),
        createPriceLine: vi.fn(),
      };
      series.push(stub);
      return stub;
    }),
    timeScale: vi.fn(() => ({ fitContent, setVisibleRange })),
    applyOptions: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    remove: vi.fn(),
  })),
  LineSeries: "LineSeries",
  LineStyle: { Dashed: 2 },
}));

afterEach(() => {
  cleanup();
  series.length = 0;
  fitContent.mockClear();
  setVisibleRange.mockClear();
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

function renderChart(points: BacktestCurvePointResponse[]) {
  return render(
    <BacktestComparisonChart
      points={points}
      benchmarkName="Total Market Index"
      ariaLabel="Strategy against Total Market Index and cash"
      periodStart="1996-01-01"
      periodEnd="2026-01-01"
    />,
  );
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

    // The anchor is the fourth series and carries only the two period bounds, as whitespace.
    expect(series).toHaveLength(4);
    expect(series[ANCHOR]?.setData).toHaveBeenCalledWith([
      { time: "1996-01-01" },
      { time: "2026-01-01" },
    ]);
    expect(setVisibleRange).toHaveBeenCalledWith({
      from: "1996-01-01",
      to: "2026-01-01",
    });
    // Reframing to the computed part is exactly the behaviour being replaced: it would make a
    // running backtest's axis race ahead of its own curve.
    expect(fitContent).not.toHaveBeenCalled();
  });

  it("leaves the axis alone as a completed year extends the curve", () => {
    const { rerender } = renderChart([pointOf("1996-01-02")]);
    const anchor = series[ANCHOR];
    setVisibleRange.mockClear();
    anchor?.setData.mockClear();

    rerender(
      <BacktestComparisonChart
        points={[
          pointOf("1996-01-02"),
          pointOf("2001-01-02", { strategyValue: 222_000 }),
        ]}
        benchmarkName="Total Market Index"
        ariaLabel="Strategy against Total Market Index and cash"
        periodStart="1996-01-01"
        periodEnd="2026-01-01"
      />,
    );

    // The period did not change, so neither does the frame: the curve fills in under a still axis
    // instead of the axis being recomputed every time a year lands.
    expect(setVisibleRange).not.toHaveBeenCalled();
    expect(anchor?.setData).not.toHaveBeenCalled();
    expect(fitContent).not.toHaveBeenCalled();
    // The new point did reach the Strategy series, so the curve itself grew.
    expect(series[STRATEGY]?.setData).toHaveBeenLastCalledWith([
      { time: "1996-01-02", value: 100_000 },
      { time: "2001-01-02", value: 222_000 },
    ]);
  });

  it("publishes the period it is framed by", () => {
    const { container } = renderChart([pointOf("1996-01-02")]);
    const frame = container.querySelector("[data-period-start]");
    expect(frame?.getAttribute("data-period-start")).toBe("1996-01-01");
    expect(frame?.getAttribute("data-period-end")).toBe("2026-01-01");
  });
});

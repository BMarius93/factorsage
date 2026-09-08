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

function renderChart(
  points: { date: string; portfolioReturnPercent: number }[],
) {
  return render(
    <BacktestComparisonChart
      points={points.map((point) => ({
        ...point,
        benchmarkReturnPercent: null,
      }))}
      benchmarkName="Total Market Index"
      ariaLabel="Portfolio against Total Market Index"
      periodStart="1996-01-01"
      periodEnd="2026-01-01"
    />,
  );
}

describe("BacktestComparisonChart", () => {
  it("locks the horizontal axis to the configured period, not to what has been simulated", () => {
    renderChart([
      { date: "1996-01-02", portfolioReturnPercent: 0 },
      { date: "1997-01-02", portfolioReturnPercent: 4 },
    ]);

    // The anchor is the third series and carries only the two period bounds, as whitespace.
    expect(series).toHaveLength(3);
    expect(series[2]?.setData).toHaveBeenCalledWith([
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

  it("leaves the axis alone as the curve grows", () => {
    const { rerender } = renderChart([
      { date: "1996-01-02", portfolioReturnPercent: 0 },
    ]);
    const anchor = series[2];
    setVisibleRange.mockClear();
    anchor?.setData.mockClear();

    rerender(
      <BacktestComparisonChart
        points={[
          {
            date: "1996-01-02",
            portfolioReturnPercent: 0,
            benchmarkReturnPercent: null,
          },
          {
            date: "2001-01-02",
            portfolioReturnPercent: 22,
            benchmarkReturnPercent: null,
          },
        ]}
        benchmarkName="Total Market Index"
        ariaLabel="Portfolio against Total Market Index"
        periodStart="1996-01-01"
        periodEnd="2026-01-01"
      />,
    );

    // The period did not change, so neither does the frame: the curve fills in under a still axis
    // instead of the axis being recomputed on every checkpoint.
    expect(setVisibleRange).not.toHaveBeenCalled();
    expect(anchor?.setData).not.toHaveBeenCalled();
    expect(fitContent).not.toHaveBeenCalled();
    // The new point did reach the portfolio series, so the curve itself grew.
    expect(series[0]?.setData).toHaveBeenLastCalledWith([
      { time: "1996-01-02", value: 0 },
      { time: "2001-01-02", value: 22 },
    ]);
  });

  it("publishes the period it is framed by", () => {
    const { container } = renderChart([
      { date: "1996-01-02", portfolioReturnPercent: 0 },
    ]);
    const frame = container.querySelector("[data-period-start]");
    expect(frame?.getAttribute("data-period-start")).toBe("1996-01-01");
    expect(frame?.getAttribute("data-period-end")).toBe("2026-01-01");
  });
});

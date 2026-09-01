import { render, screen } from "@testing-library/react";
import { createChart } from "lightweight-charts";
import { describe, expect, it, vi, type Mock } from "vitest";
import { CHART_COLORS } from "../utils/chart-theme";
import { StockPriceChart } from "./StockPriceChart";

type FakeSeries = {
  setData: Mock;
  applyOptions: Mock;
};

type FakeChart = {
  addedSeries: Array<{ definition: unknown; options: Record<string, unknown>; api: FakeSeries }>;
  addSeries: Mock;
  removeSeries: Mock;
  applyOptions: Mock;
  timeScale: Mock;
  fitContent: Mock;
  subscribeCrosshairMove: Mock;
  unsubscribeCrosshairMove: Mock;
  remove: Mock;
};

// jsdom cannot rasterize a canvas; the library boundary is mocked and the assertions target the
// data and options our component feeds into it.
vi.mock("lightweight-charts", () => {
  const createChartMock = vi.fn(() => {
    const fitContent = vi.fn();
    const chart: FakeChart = {
      addedSeries: [],
      addSeries: vi.fn((definition: unknown, options: Record<string, unknown>) => {
        const api: FakeSeries = { setData: vi.fn(), applyOptions: vi.fn() };
        chart.addedSeries.push({ definition, options, api });
        return api;
      }),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      timeScale: vi.fn(() => ({ fitContent })),
      fitContent,
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      remove: vi.fn(),
    };
    return chart;
  });
  return {
    createChart: createChartMock,
    AreaSeries: "AreaSeries",
    LineSeries: "LineSeries",
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
      id: "sma50",
      label: "SMA 50",
      color: CHART_COLORS.sma50,
      points: [{ date: "2026-08-28", value: 220 }],
    };
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[overlay]}
        currency="USD"
        ariaLabel="AAPL chart"
      />,
    );

    const chart = lastChart();
    const overlaySeries = chart.addedSeries[1];
    expect(overlaySeries?.definition).toBe("LineSeries");
    expect(overlaySeries?.options.color).toBe(CHART_COLORS.sma50);
    expect(overlaySeries?.api.setData).toHaveBeenCalledWith([
      { time: "2026-08-28", value: 220 },
    ]);

    rerender(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        ariaLabel="AAPL chart"
      />,
    );
    expect(chart.removeSeries).toHaveBeenCalledWith(overlaySeries?.api);
  });

  it("explains an undrawable dataset instead of rendering a misleading chart", () => {
    render(
      <StockPriceChart
        points={[{ date: "2026-08-28", value: 10 }]}
        overlays={[]}
        currency="USD"
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
        ariaLabel="AAPL chart"
      />,
    );

    expect(
      screen.getByRole("status", { name: "Loading price history" }),
    ).toBeDefined();
  });

  it("tears the chart instance down on unmount", () => {
    const { unmount } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[]}
        currency="USD"
        ariaLabel="AAPL chart"
      />,
    );
    const chart = lastChart();

    unmount();

    expect(chart.remove).toHaveBeenCalled();
  });
});

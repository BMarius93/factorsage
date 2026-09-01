import { render, screen } from "@testing-library/react";
import { createChart } from "lightweight-charts";
import { describe, expect, it, vi, type Mock } from "vitest";
import { CHART_COLORS, overlayColorAt } from "../utils/chart-theme";
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
      id: "SMA_50D",
      label: "SMA 50D",
      color: overlayColorAt(0),
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
    expect(overlaySeries?.options.color).toBe(overlayColorAt(0));
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

  it("names the close and every enabled overlay in the legend with catalog labels", () => {
    const overlays = [
      {
        id: "SMA_50D",
        label: "SMA 50D",
        color: overlayColorAt(0),
        points: [{ date: "2026-08-28", value: 220 }],
      },
      {
        id: "SMA_20W",
        label: "SMA 20W",
        color: overlayColorAt(1),
        points: [{ date: "2026-08-28", value: 216 }],
      },
      {
        id: "BALANCED",
        label: "Balanced",
        color: overlayColorAt(2),
        points: [{ date: "2026-08-28", value: 290 }],
      },
    ];
    render(
      <StockPriceChart
        points={POINTS}
        overlays={overlays}
        currency="USD"
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
      points: [{ date: "2026-08-28", value: 216 }],
    };
    const { rerender } = render(
      <StockPriceChart
        points={POINTS}
        overlays={[{ ...weekly, color: overlayColorAt(0) }]}
        currency="USD"
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
            points: [{ date: "2026-08-28", value: 220 }],
          },
          { ...weekly, color: overlayColorAt(1) },
        ]}
        currency="USD"
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

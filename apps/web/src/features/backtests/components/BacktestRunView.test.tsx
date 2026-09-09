import {
  BACKTEST_PENDING_POLL_INTERVAL_MS,
  BACKTEST_RUNNING_POLL_INTERVAL_MS,
  type BacktestHoldingResponse,
} from "@intrinsic/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBacktestProgress, fetchBacktestRun } from "../api/backtests-api";
import {
  TEST_BENCHMARK_NAME,
  testCurve,
  testDetail,
  testLive,
  testMilestones,
  testProgress,
  testResult,
} from "../utils/backtest.test-helper";
import { BacktestRunView, CHART_PLACEHOLDER_TEXT } from "./BacktestRunView";

vi.mock("../api/backtests-api", () => ({
  fetchBacktestRun: vi.fn(),
  fetchBacktestProgress: vi.fn(),
}));

// jsdom cannot rasterize a canvas; the library boundary is mocked and the assertions target the
// DOM contract the chart publishes about what it drew.
vi.mock("lightweight-charts", () => ({
  createChart: vi.fn(() => ({
    addSeries: vi.fn(() => ({
      setData: vi.fn(),
      applyOptions: vi.fn(),
      createPriceLine: vi.fn(),
    })),
    timeScale: vi.fn(() => ({ fitContent: vi.fn(), setVisibleRange: vi.fn() })),
    applyOptions: vi.fn(),
    subscribeCrosshairMove: vi.fn(),
    unsubscribeCrosshairMove: vi.fn(),
    remove: vi.fn(),
  })),
  LineSeries: "LineSeries",
  LineStyle: { Dashed: 2 },
}));

const fetchRunMock = vi.mocked(fetchBacktestRun);
const fetchProgressMock = vi.mocked(fetchBacktestProgress);

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function tick(interval: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(interval);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchRunMock.mockReset();
  fetchProgressMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BacktestRunView", () => {
  it("shows the phase, the worker's message and a chart placeholder while the run is preparing", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("PREPARING_DATA", {
        progress: {
          percent: 12,
          message: "Loading price history",
          simulatedThrough: null,
          sequence: 1,
          updatedAt: "2026-09-01T10:00:10.000Z",
        },
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("PREPARING_DATA", 1));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    expect(screen.getByTestId("backtest-status").textContent).toContain(
      "Preparing data",
    );
    expect(
      screen.getByTestId("backtest-progress-percent").textContent,
    ).toContain("12%");
    expect(
      screen.getByTestId("backtest-progress-message").textContent,
    ).toContain("Loading price history");
    expect(screen.getByTestId("backtest-chart-placeholder").textContent).toBe(
      CHART_PLACEHOLDER_TEXT,
    );
    expect(screen.queryByTestId("backtest-chart")).toBeNull();

    // Nothing has been measured yet, so no tile may invent a zero.
    expect(screen.getByTestId("metric-portfolio-return").textContent).toContain(
      "—",
    );
    expect(screen.getByTestId("metric-portfolio-value").textContent).toContain(
      "—",
    );
    expect(screen.getByTestId("metric-trades").textContent).toContain("—");
  });

  it("replaces the placeholder with a growing three-scenario chart as years complete", async () => {
    fetchRunMock.mockResolvedValue(testDetail("QUEUED"));
    fetchProgressMock
      .mockResolvedValueOnce(
        testProgress("RUNNING", 1, {
          percent: 40,
          live: testLive({ curve: testCurve(4) }),
        }),
      )
      .mockResolvedValue(
        testProgress("RUNNING", 2, {
          percent: 70,
          live: testLive({ curve: testCurve(9) }),
        }),
      );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    expect(screen.getByTestId("backtest-chart-placeholder")).toBeTruthy();

    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);

    const chart = screen.getByTestId("backtest-chart");
    expect(screen.queryByTestId("backtest-chart-placeholder")).toBeNull();
    expect(chart.dataset.strategyPoints).toBe("4");
    expect(chart.dataset.cashPoints).toBe("4");
    // All three scenarios are present, and the null benchmark points are gaps rather than zeros.
    expect(chart.dataset.seriesCount).toBe("3");
    expect(chart.dataset.benchmarkPoints).toBe("2");
    // The benchmark series is named from the run's own snapshot, never from a hard-coded default,
    // and the other two carry their product labels.
    const legend = screen.getByTestId("backtest-chart-series").textContent;
    expect(legend).toContain(TEST_BENCHMARK_NAME);
    expect(legend).toContain("Strategy");
    expect(legend).toContain("Cash");
    expect(screen.getByTestId("metric-benchmark-return").textContent).toContain(
      `${TEST_BENCHMARK_NAME} return`,
    );

    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);

    // The same chart element grew; it was not remounted.
    expect(screen.getByTestId("backtest-chart")).toBe(chart);
    expect(chart.dataset.strategyPoints).toBe("9");
  });

  it("transitions to the completed view in place, without a reload", async () => {
    fetchRunMock
      .mockResolvedValueOnce(testDetail("QUEUED"))
      .mockResolvedValueOnce(
        testDetail("COMPLETED", {
          completedAt: "2026-09-01T10:20:00.000Z",
          result: testResult(),
        }),
      );
    fetchProgressMock
      .mockResolvedValueOnce(
        testProgress("RUNNING", 1, {
          percent: 60,
          live: testLive({ curve: testCurve(4) }),
        }),
      )
      .mockResolvedValue(testProgress("COMPLETED", 2, { percent: 100 }));

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);
    const chart = screen.getByTestId("backtest-chart");

    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    await flush();

    expect(screen.getByTestId("backtest-status").textContent).toContain(
      "Completed",
    );
    // The progress bar is gone, the final numbers are in the same tiles, and the chart never
    // fell back to its placeholder while the terminal detail was being fetched.
    expect(screen.queryByTestId("backtest-progress")).toBeNull();
    expect(screen.queryByTestId("backtest-chart-placeholder")).toBeNull();
    expect(screen.getByTestId("backtest-chart")).toBe(chart);
    expect(chart.dataset.strategyPoints).toBe("8");
    expect(screen.getByTestId("metric-portfolio-return").textContent).toContain(
      "+36.00%",
    );
    expect(screen.getByTestId("metric-alpha").textContent).toContain("+15.00%");
    expect(screen.getByTestId("metric-max-drawdown").textContent).toContain(
      "-14.20%",
    );
    expect(screen.getByText("Trade log")).toBeTruthy();
    expect(screen.getByText("Final holdings")).toBeTruthy();
  });

  it("shows the sanitized failure message when a run fails", async () => {
    fetchRunMock.mockResolvedValue(testDetail("QUEUED"));
    fetchProgressMock.mockResolvedValue(
      testProgress("FAILED", 3, {
        percent: 34,
        failure: {
          code: "DATA_UNAVAILABLE",
          phase: "PREPARING_DATA",
          message:
            "Price history is unavailable for part of this period. " +
            "No market data was found for ZZZZ.",
        },
      }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);
    await flush();

    expect(screen.getByTestId("backtest-failure").textContent).toContain(
      "Price history is unavailable for part of this period.",
    );
    // Actionable without being internal: which stock, which phase, which code, which run.
    expect(screen.getByTestId("backtest-failure").textContent).toContain(
      "No market data was found for ZZZZ.",
    );
    expect(screen.getByTestId("backtest-failure-phase").textContent).toBe(
      "Preparing data",
    );
    expect(screen.getByTestId("backtest-failure-code").textContent).toBe(
      "DATA_UNAVAILABLE",
    );
    expect(screen.getByTestId("backtest-run-id").textContent).toBe("run-1");
    expect(screen.getByTestId("backtest-status").textContent).toContain(
      "Failed",
    );
    // A finished run has nothing still to come, so the chart frame must not promise progress.
    expect(screen.getByTestId("backtest-chart-placeholder").textContent).toBe(
      "This run produced no comparison curve.",
    );
    expect(screen.queryByTestId("backtest-progress")).toBeNull();
  });

  it("omits the phase row when the failure has no user-facing phase", async () => {
    fetchRunMock.mockResolvedValue(testDetail("QUEUED"));
    fetchProgressMock.mockResolvedValue(
      testProgress("FAILED", 3, {
        percent: 0,
        failure: {
          code: "ABANDONED",
          phase: null,
          message: "The run was abandoned after repeated failures.",
        },
      }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);
    await flush();

    expect(screen.queryByTestId("backtest-failure-phase")).toBeNull();
    expect(screen.getByTestId("backtest-failure-code").textContent).toBe(
      "ABANDONED",
    );
    expect(screen.getByTestId("backtest-run-id").textContent).toBe("run-1");
  });

  it("shows the years a run has finished, and keeps them after it ends", async () => {
    fetchRunMock.mockResolvedValue(testDetail("RUNNING"));
    fetchProgressMock.mockResolvedValue(
      testProgress("RUNNING", 4, {
        percent: 40,
        live: testLive(),
        milestones: testMilestones(["1996", "1997", "1998"]),
      }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    await flush();

    const years = screen.getByTestId("backtest-milestone-years");
    expect(years.getAttribute("data-milestone-count")).toBe("3");
    expect(
      [...years.querySelectorAll("[data-year]")].map((node) =>
        node.getAttribute("data-year"),
      ),
    ).toEqual(["1996", "1997", "1998"]);
    expect(screen.getByTestId("backtest-milestones").textContent).toContain(
      "3 simulated years",
    );

    // A finished run keeps its progression: the trail is what the run went through, not a
    // transient loading affordance.
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        result: testResult(),
        milestones: testMilestones(["1996", "1997", "1998", "1999"]),
      }),
    );
    fetchProgressMock.mockResolvedValue(
      testProgress("COMPLETED", 5, {
        percent: 100,
        milestones: testMilestones(["1996", "1997", "1998", "1999"]),
      }),
    );
    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    await flush();

    expect(
      screen
        .getByTestId("backtest-milestone-years")
        .getAttribute("data-milestone-count"),
    ).toBe("4");
  });

  it("says when a holding is carried at a price older than the run's last day", async () => {
    const result = testResult();
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        result: {
          ...result,
          holdings: [
            {
              ...(result.holdings[0] as BacktestHoldingResponse),
              symbol: "GONE",
              lastPriceDate: "2023-04-11",
            },
            {
              ...(result.holdings[0] as BacktestHoldingResponse),
              symbol: "LIVE",
              lastPriceDate: result.summary.lastSimulatedDate,
            },
          ],
        },
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    expect(
      screen.getByTestId("backtest-holding-stale-GONE").textContent,
    ).toContain("2023-04-11");
    expect(screen.queryByTestId("backtest-holding-stale-LIVE")).toBeNull();
  });

  it("treats a run it cannot see as missing rather than broken", async () => {
    const { ApiError } = await import("../../../lib/api/client");
    fetchRunMock.mockRejectedValue(new ApiError(404, "Backtest not found"));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    expect(screen.getByTestId("backtest-not-found")).toBeTruthy();
  });
});

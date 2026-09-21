import {
  BACKTEST_PENDING_POLL_INTERVAL_MS,
  BACKTEST_RUNNING_POLL_INTERVAL_MS,
} from "@intrinsic/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchBacktestProgress,
  fetchBacktestRun,
  fetchBacktestTrades,
} from "../api/backtests-api";
import {
  TEST_BENCHMARK_NAME,
  TEST_PERIOD_END,
  TEST_PERIOD_START,
  testCurve,
  testDetail,
  testLive,
  testMilestones,
  testProgress,
  testResult,
  testTrade,
  testTradePage,
} from "../utils/backtest.test-helper";
import { BacktestRunView } from "./BacktestRunView";

vi.mock("../api/backtests-api", () => ({
  fetchBacktestRun: vi.fn(),
  fetchBacktestProgress: vi.fn(),
  fetchBacktestTrades: vi.fn(),
}));

/**
 * The trade log's page lives in the URL, so the router is the one piece of the App Router this
 * component genuinely depends on. It is mocked at the boundary rather than simulated.
 */
const pushMock = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/backtests/run-1",
  useSearchParams: () => searchParams,
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
    timeScale: vi.fn(() => ({
      fitContent: vi.fn(),
      setVisibleRange: vi.fn(),
      applyOptions: vi.fn(),
      getVisibleLogicalRange: vi.fn(() => null),
      setVisibleLogicalRange: vi.fn(),
      subscribeVisibleLogicalRangeChange: vi.fn(),
      unsubscribeVisibleLogicalRangeChange: vi.fn(),
    })),
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
const fetchTradesMock = vi.mocked(fetchBacktestTrades);

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
  fetchTradesMock.mockReset();
  fetchTradesMock.mockResolvedValue(testTradePage());
  pushMock.mockReset();
  searchParams = new URLSearchParams();
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
    // The horizontal domain is known before the first day is simulated, so the chart is already
    // there with the whole configured period on its axis and no curve on it yet.
    expect(screen.queryByTestId("backtest-chart-placeholder")).toBeNull();
    const chart = screen.getByTestId("backtest-chart");
    expect(chart.dataset.periodStart).toBe(TEST_PERIOD_START);
    expect(chart.dataset.periodEnd).toBe(TEST_PERIOD_END);
    expect(chart.dataset.strategyPoints).toBe("0");
    // Nothing is inspectable about a run that has not produced anything.
    expect(chart.dataset.interaction).toBe("locked");

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
    // The axis exists from the first render; only the curve is still empty.
    const chart = screen.getByTestId("backtest-chart");
    expect(chart.dataset.strategyPoints).toBe("0");
    expect(chart.dataset.periodStart).toBe(TEST_PERIOD_START);

    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);

    expect(screen.queryByTestId("backtest-chart-placeholder")).toBeNull();
    // The same element, extended in place: the first chunk does not remount the chart.
    expect(screen.getByTestId("backtest-chart")).toBe(chart);
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
    // The domain did not move with it, and interaction stayed refused while it was arriving.
    expect(chart.dataset.periodStart).toBe(TEST_PERIOD_START);
    expect(chart.dataset.periodEnd).toBe(TEST_PERIOD_END);
    expect(chart.dataset.interaction).toBe("locked");
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
    // A finished run is a result: the same bounded domain, now explorable.
    expect(chart.dataset.interaction).toBe("bounded");
    expect(chart.dataset.periodStart).toBe(TEST_PERIOD_START);
    expect(chart.dataset.periodEnd).toBe(TEST_PERIOD_END);
    expect(screen.getByTestId("metric-portfolio-return").textContent).toContain(
      "+36.00%",
    );
    expect(screen.getByTestId("metric-alpha").textContent).toContain("+15.00%");
    expect(screen.getByTestId("metric-max-drawdown").textContent).toContain(
      "-14.20%",
    );
    // "Open positions" is gone: a completed run liquidates everything it held, so the tile could
    // only ever read 0. CAGR took the slot.
    expect(screen.queryByTestId("metric-open-positions")).toBeNull();
    expect(screen.getByTestId("metric-cagr").textContent).toContain("+6.30%");
    expect(screen.getByText("Trade log")).toBeTruthy();
    // The final state is cash, so there is no holdings section to render at all.
    expect(screen.queryByText("Final holdings")).toBeNull();
    expect(screen.queryByTestId("backtest-holdings")).toBeNull();
    // A finished run stays still: only live work wears the activity pulse.
    expect(
      screen.getByTestId("backtest-status").getAttribute("data-activity"),
    ).toBeNull();
  });

  it("reports each calendar year on its own, directly below the results", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult() }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    const section = screen.getByTestId("backtest-annual-returns");
    expect(section.getAttribute("data-year-count")).toBe("3");
    const cells = [...section.querySelectorAll("[data-year]")];
    expect(cells.map((cell) => cell.getAttribute("data-year"))).toEqual([
      "2021",
      "2022",
      "2023",
    ]);
    // Each year's own figure, including a negative one — never a cumulative badge.
    expect(cells.map((cell) => cell.textContent)).toEqual([
      "2021+18.00%",
      "2022-7.50%",
      "2023+24.25%",
    ]);
    // The heading keeps its one line of copy, and the note that explains the asterisk survives
    // the reorder. `testResult` reports three whole years, so this run has no partial marker.
    expect(section.textContent).toContain(
      "Each calendar year on its own, not cumulative.",
    );
    expect(section.querySelector("[data-partial]")).toBeNull();
  });

  it("marks a part-year and explains the asterisk", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        result: testResult({
          annualReturns: [
            {
              year: "1996",
              simulatedThrough: "1996-12-31",
              returnPercent: 4.5,
              partial: true,
            },
            {
              year: "1997",
              simulatedThrough: "1997-12-31",
              returnPercent: 12,
              partial: false,
            },
          ],
        }),
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    const section = screen.getByTestId("backtest-annual-returns");
    expect(
      section.querySelector('[data-year="1996"]')?.getAttribute("data-partial"),
    ).toBe("true");
    expect(
      section.querySelector('[data-year="1997"]')?.getAttribute("data-partial"),
    ).toBeNull();
    expect(section.textContent).toContain(
      "* part of the year only — the run started or ended inside it.",
    );
  });

  it("orders a completed result chart, results, years, configuration, trade log", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult() }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));
    fetchTradesMock.mockResolvedValue(testTradePage());

    render(<BacktestRunView runId="run-1" />);
    await flush();

    // The shape of the run first, then the numbers that summarise it, then the years that
    // decompose those, then the inputs, then every trade.
    const order = [
      "backtest-chart",
      "backtest-results",
      "backtest-annual-returns",
      "run-configuration",
      "backtest-trades",
    ].map((testId) => screen.getByTestId(testId));
    for (const [index, node] of order.slice(0, -1).entries()) {
      expect(
        node.compareDocumentPosition(order[index + 1] as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        `${node.getAttribute("data-testid")} does not precede the next section`,
      ).toBeTruthy();
    }

    // The paragraph that used to set the chart up is gone from the page. The comparison it
    // described is still named — by the legend, and by the chart's own accessible description.
    expect(screen.queryByText(/invested three ways/)).toBeNull();
    expect(
      screen.getByLabelText(/Strategy portfolio value against/),
    ).toBeTruthy();
  });

  it("renders the eight result numbers as one flat section, not a card in a card", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult() }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    const results = screen.getByTestId("backtest-results");
    const years = screen.getByTestId("backtest-annual-returns");
    const grid = screen.getByTestId("backtest-metrics");

    // Results and Annual returns are peers in the hero's one stack — Results does not sit inside
    // a surface of its own that Annual returns does without.
    expect(results.parentElement).toBe(years.parentElement);
    // And the tiles hang straight off the section: heading, grid, tiles, with nothing wrapped
    // around the grid to draw a second box.
    expect(grid.parentElement).toBe(results);
    expect([...results.children].length).toBe(2);

    // All eight, still, in order.
    expect(
      [...grid.children].map((tile) => tile.getAttribute("data-testid")),
    ).toEqual([
      "metric-portfolio-return",
      "metric-benchmark-return",
      "metric-alpha",
      "metric-portfolio-value",
      "metric-net-profit",
      "metric-max-drawdown",
      "metric-trades",
      "metric-cagr",
    ]);
  });

  it("pages the trade log from the server and puts the page in the URL", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult() }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));
    fetchTradesMock.mockResolvedValue(
      testTradePage({
        items: [
          testTrade({ sequence: 120 }),
          testTrade({
            sequence: 119,
            action: "SELL",
            source: "END_OF_BACKTEST",
            levelPercentage: null,
            reason: { kind: "END_OF_BACKTEST" },
          }),
        ],
        page: 2,
        pageSize: 50,
        totalCount: 18_348,
        pageCount: 367,
      }),
    );
    searchParams = new URLSearchParams("tradesPage=2");

    render(<BacktestRunView runId="run-1" />);
    await flush();

    // The server decides the page, not the browser: fifty rows were asked for, not 18,348.
    expect(fetchTradesMock).toHaveBeenCalledWith(
      "run-1",
      { page: 2, pageSize: 50 },
      expect.anything(),
    );
    expect(screen.getAllByTestId("backtest-trade-row")).toHaveLength(2);
    expect(screen.getByTestId("backtest-trades-footer").textContent).toContain(
      "Showing 51–100 of 18348 trades",
    );

    // Each trade says why it happened, in the canonical Strategy language — and the terminal
    // liquidation says the period ended rather than claiming a FINAL EXIT.
    const rows = screen.getAllByTestId("backtest-trade-row");
    expect(rows[0]?.textContent).toContain("SMA 50D is above SMA 200D");
    expect(rows[0]?.textContent).toContain(
      "Triggered: Price crosses above SMA 20D",
    );
    expect(rows[1]?.textContent).toContain("End of backtest");
    expect(rows[1]?.textContent).not.toContain("Final exit");
    expect(
      rows[1]?.querySelector("[data-source]")?.getAttribute("data-source"),
    ).toBe("END_OF_BACKTEST");

    // Next writes the page into the URL — a real history entry, so Back returns to page 2 — and
    // does not scroll the reader back to the top of a long result.
    await act(async () => {
      screen.getByRole("button", { name: "Next" }).click();
    });
    expect(pushMock).toHaveBeenCalledWith("/backtests/run-1?tradesPage=3", {
      scroll: false,
    });
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
    // A data problem is not something a retry fixes (UI-031): the guidance says so, and the
    // recovery edits the configuration rather than resubmitting it unchanged.
    expect(screen.getByTestId("backtest-failure-next").textContent).toContain(
      "would fail the same way",
    );
    expect(screen.getByTestId("backtest-failure-rerun").textContent).toBe(
      "Edit and run again",
    );
    // The raw code lives only in the collapsed support details.
    expect(
      screen.getByTestId("backtest-failure-code").closest("details"),
    ).not.toBeNull();
    expect(screen.queryByTestId("backtest-progress")).toBeNull();
  });

  it("offers the run's own configuration back for editing, never a blank form", async () => {
    fetchRunMock.mockResolvedValue(testDetail("QUEUED"));
    fetchProgressMock.mockResolvedValue(
      testProgress("FAILED", 3, {
        percent: 0,
        failure: {
          code: "ABANDONED",
          phase: "RUNNING",
          message: "The run was abandoned.",
        },
      }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);
    await flush();

    const rerun = screen.getByTestId("backtest-failure-rerun");
    // A system interruption is fine to run again unchanged, and says so.
    expect(rerun.textContent).toBe("Run again with these settings");
    const href = new URL(rerun.getAttribute("href") ?? "", "https://x.test");
    expect(href.pathname).toBe("/backtests/new");
    expect(href.searchParams.get("from")).toBe("run-1");
    expect(href.searchParams.get("start")).toBe(TEST_PERIOD_START);
    expect(href.searchParams.get("end")).toBe(TEST_PERIOD_END);
    expect(href.searchParams.get("positions")).not.toBeNull();
  });

  it("drops a dead attempt's partial curve when the run fails", async () => {
    // The prefix a failed attempt happened to reach is not that run's result, which is why the
    // payload drops its live snapshot. Keeping the chart, KPIs and holdings on screen beside the
    // failure would present a dead attempt as an outcome.
    fetchRunMock.mockResolvedValue(testDetail("QUEUED"));
    fetchProgressMock
      .mockResolvedValueOnce(
        testProgress("RUNNING", 1, {
          percent: 40,
          live: testLive({ curve: testCurve(6) }),
        }),
      )
      .mockResolvedValue(
        testProgress("FAILED", 2, {
          percent: 40,
          failure: {
            code: "DATA_UNAVAILABLE",
            phase: "RUNNING",
            message: "The run stopped before it produced a result.",
          },
        }),
      );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);
    expect(screen.getByTestId("backtest-chart").dataset.strategyPoints).toBe(
      "6",
    );

    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    await flush();

    expect(screen.getByTestId("backtest-status").textContent).toContain(
      "Failed",
    );
    expect(screen.queryByTestId("backtest-chart")).toBeNull();
    // A run that never produced a result shows no result sections at all: no empty chart, no
    // KPIs of "—", no "No positions" or "no trades" copy that reads like an outcome (UI-031).
    expect(screen.queryByTestId("backtest-chart-placeholder")).toBeNull();
    expect(screen.queryByTestId("metric-portfolio-value")).toBeNull();
    expect(screen.queryByText("This run made no trades.")).toBeNull();
    expect(screen.queryByText(/No positions/)).toBeNull();
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

    expect(screen.getByTestId("backtest-milestones").textContent).toContain(
      "3 simulated years",
    );
    // A run in flight reports its finished years the same way a completed one does: per year,
    // chained off the cumulative index each milestone recorded. `testMilestones` grows the
    // cumulative figure by 5 points a year, which is +5.00%, then +4.76%, then +4.55% — not three
    // identical numbers, and not the cumulative ladder this replaced.
    const running = screen.getByTestId("backtest-annual-returns");
    expect(
      [...running.querySelectorAll("[data-year]")].map((node) =>
        node.getAttribute("data-year"),
      ),
    ).toEqual(["1996", "1997", "1998"]);
    expect(running.textContent).toContain("+5.00%");
    expect(running.textContent).not.toContain("+10.00%");
    // Live work wears the pulse.
    expect(
      screen.getByTestId("backtest-status").getAttribute("data-activity"),
    ).toBe("pulse");

    // A finished run keeps its progression, now from its durable result.
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
        .getByTestId("backtest-annual-returns")
        .getAttribute("data-year-count"),
    ).toBe("3");
  });

  it("says when a running holding is carried at a price older than the simulated date", async () => {
    // Holdings belong to a run that is still executing: a completed one has none, because the end
    // of the period sells everything it held.
    const holding = {
      symbol: "GONE",
      name: "Gone Inc.",
      shares: 10,
      averageCost: 100,
      lastPrice: 130,
      lastPriceDate: "2023-04-11",
      marketValue: 1_300,
      unrealizedPnlPercent: 30,
      allocationPercent: 12.5,
    };
    fetchRunMock.mockResolvedValue(testDetail("RUNNING"));
    fetchProgressMock.mockResolvedValue(
      testProgress("RUNNING", 2, {
        percent: 40,
        live: testLive({
          simulatedThrough: "2024-01-05",
          holdings: [
            holding,
            { ...holding, symbol: "LIVE", lastPriceDate: "2024-01-05" },
          ],
        }),
      }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);
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

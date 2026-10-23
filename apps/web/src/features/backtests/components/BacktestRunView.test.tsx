import {
  BACKTEST_PENDING_POLL_INTERVAL_MS,
  BACKTEST_RUNNING_POLL_INTERVAL_MS,
} from "@intrinsic/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../lib/api/client";
import {
  RATE_LIMITED_COPY,
  rateLimited,
} from "../../../lib/api/__testing__/request-failures";
import {
  cancelBacktestRun,
  fetchBacktestProgress,
  fetchBacktestRun,
  fetchBacktestShare,
  fetchBacktestTrades,
} from "../api/backtests-api";
import {
  TEST_BENCHMARK_NAME,
  TEST_PERIOD_END,
  TEST_PERIOD_START,
  testConfiguration,
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
  cancelBacktestRun: vi.fn(),
  // A completed run asks whether it is shared; the control itself is covered by its own suite.
  fetchBacktestShare: vi.fn(async () => ({
    shared: false,
    url: null,
    sharedAt: null,
  })),
  enableBacktestShare: vi.fn(),
  revokeBacktestShare: vi.fn(),
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
const cancelMock = vi.mocked(cancelBacktestRun);

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
  cancelMock.mockReset();
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

  it("titles the page with the Run ID and names what the run executed under it", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        completedAt: "2026-09-01T10:20:00.000Z",
        result: testResult(),
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    // The run's own identity, not the strategy's name, is the page's one heading.
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Run #0084");
    expect(screen.getByTestId("backtest-status").textContent).toBe("Completed");
    // The metadata line: Strategy · List · period · Benchmark, from the run's snapshot.
    const metadata = screen.getByTestId("backtest-run-metadata");
    expect(metadata.textContent).toBe(
      `Strategy: Deep value·List: Quality compounders·Jan 4, 2021 – Jan 2, 2026·Benchmark: ${TEST_BENCHMARK_NAME}`,
    );
    expect(
      screen.getByTestId("backtest-header-strategy").getAttribute("href"),
    ).toBe("/strategies/strategy-1");
    expect(
      screen.getByTestId("backtest-header-list").getAttribute("href"),
    ).toBe("/lists/list-1");
    // The tab names the run and the strategy it executed.
    expect(document.title).toBe("Run #0084 · Deep value · FactorSage");
    // The preserved actions and sections are all still there.
    expect(screen.getByTestId("backtest-edit-and-rerun")).toBeTruthy();
    // The configuration's submission time reads "Created", not "Queued".
    const configuration = screen.getByTestId("backtest-configuration");
    expect(configuration.textContent).toContain("Created");
    expect(configuration.textContent).not.toContain("Queued");
  });

  it("keeps a deleted strategy's and list's snapshot names in the header, unlinked", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        configuration: testConfiguration({
          strategyId: null,
          strategyName: "Retired strategy",
          stockListId: null,
          stockListName: "Retired list",
        }),
        result: testResult(),
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    for (const [testId, name] of [
      ["backtest-header-strategy", "Retired strategy"],
      ["backtest-header-list", "Retired list"],
    ] as const) {
      const reference = screen.getByTestId(testId);
      expect(reference.textContent).toBe(name);
      expect(reference.tagName).not.toBe("A");
      expect(reference.getAttribute("data-static")).toBe("true");
    }
    expect(
      screen.getByTestId("backtest-run-metadata").querySelectorAll("a"),
    ).toHaveLength(0);
  });

  it("updates the chart and all eight numbers live, in place, inside the one overview", async () => {
    fetchRunMock.mockResolvedValue(testDetail("QUEUED"));
    fetchProgressMock
      .mockResolvedValueOnce(
        testProgress("RUNNING", 1, {
          percent: 30,
          live: testLive({
            curve: testCurve(4),
            portfolioReturnPercent: 3,
            totalValue: 10_300,
            tradeCount: 2,
          }),
        }),
      )
      .mockResolvedValue(
        testProgress("RUNNING", 2, {
          percent: 60,
          live: testLive({
            curve: testCurve(9),
            portfolioReturnPercent: 7.25,
            totalValue: 10_725,
            tradeCount: 5,
          }),
        }),
      );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    const overview = screen.getByTestId("backtest-overview");
    const chart = screen.getByTestId("backtest-chart");
    const results = screen.getByTestId("backtest-results");
    expect(overview.contains(chart)).toBe(true);
    expect(overview.contains(results)).toBe(true);

    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);
    expect(chart.dataset.strategyPoints).toBe("4");
    expect(screen.getByTestId("metric-portfolio-return").textContent).toContain(
      "+3.00%",
    );
    expect(screen.getByTestId("metric-trades").textContent).toContain("2");
    expect(results.textContent).toContain("Updating as the run progresses");

    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    // The same chart and the same tiles, fed the newer checkpoint: nothing was remounted or moved.
    expect(screen.getByTestId("backtest-overview")).toBe(overview);
    expect(screen.getByTestId("backtest-chart")).toBe(chart);
    expect(screen.getByTestId("backtest-results")).toBe(results);
    expect(chart.dataset.strategyPoints).toBe("9");
    expect(chart.dataset.interaction).toBe("locked");
    expect(screen.getByTestId("metric-portfolio-return").textContent).toContain(
      "+7.25%",
    );
    expect(screen.getByTestId("metric-portfolio-value").textContent).toContain(
      "$10,725",
    );
    expect(screen.getByTestId("metric-trades").textContent).toContain("5");
  });

  it("says a queued run's status once, names its progress bar, and announces only transitions (BT-5)", async () => {
    fetchRunMock
      .mockResolvedValueOnce(
        testDetail("QUEUED", {
          progress: {
            percent: 0,
            message: "Queued",
            simulatedThrough: null,
            sequence: 0,
            updatedAt: null,
          },
        }),
      )
      .mockResolvedValueOnce(
        testDetail("COMPLETED", {
          completedAt: "2026-09-01T10:20:00.000Z",
          result: testResult(),
        }),
      );
    fetchProgressMock
      .mockResolvedValueOnce(testProgress("RUNNING", 1, { percent: 40 }))
      .mockResolvedValue(testProgress("COMPLETED", 2, { percent: 100 }));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    // The badge says "Queued"; the progress line does not repeat it.
    expect(screen.getByTestId("backtest-status").textContent).toBe("Queued");
    expect(screen.queryByTestId("backtest-progress-message")).toBeNull();
    expect(
      screen.getByRole("progressbar", { name: "Backtest progress" }),
    ).toBeTruthy();
    // Opening the page is not a transition: nothing is announced.
    const announcement = screen.getByTestId("backtest-status-announcement");
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.textContent).toBe("");

    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);
    expect(announcement.textContent).toBe("Backtest running.");
    // A percentage moving is not announced; only the status changing is.
    expect(announcement.textContent).not.toContain("%");

    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    await flush();
    expect(announcement.textContent).toBe(
      "Backtest completed. The results are ready.",
    );
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
    // A difference between two returns, in percentage points (BT-2).
    expect(screen.getByTestId("metric-alpha").textContent).toContain(
      "+15.00 pp",
    );
    expect(screen.getByTestId("metric-max-drawdown").textContent).toContain(
      "-14.20%",
    );
    // "Open positions" is gone: a completed run liquidates everything it held, so the tile could
    // only ever read 0. CAGR took the slot.
    expect(screen.queryByTestId("metric-open-positions")).toBeNull();
    expect(screen.getByTestId("metric-cagr").textContent).toContain("+6.30%");
    // The benchmark's own annualized return and drawdown sit beside the portfolio's (BT-2).
    expect(screen.getByTestId("metric-cagr-benchmark").textContent).toContain(
      "+3.90%",
    );
    expect(
      screen.getByTestId("metric-max-drawdown-benchmark").textContent,
    ).toContain("-18.40%");
    expect(screen.getByText("Trade log")).toBeTruthy();
    // The final state is cash, so there is no holdings section to render at all.
    expect(screen.queryByText("Final holdings")).toBeNull();
    expect(screen.queryByTestId("backtest-holdings")).toBeNull();
    // A finished run stays still: only live work wears the activity pulse.
    expect(
      screen.getByTestId("backtest-status").getAttribute("data-activity"),
    ).toBeNull();
  });

  it("reports each calendar year on its own, Strategy above benchmark, directly below the results", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult() }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    const section = screen.getByTestId("backtest-annual-returns");
    expect(section.getAttribute("data-year-count")).toBe("3");
    // One column per year, oldest first.
    const years = screen.getAllByTestId("backtest-annual-year");
    expect(years.map((cell) => cell.textContent)).toEqual([
      "2021",
      "2022",
      "2023",
    ]);
    // Each year's own figure, including a negative one — never a cumulative badge — in the
    // Strategy row, and the benchmark's own figure for the same year in the row under it.
    const strategy = screen.getAllByTestId("backtest-annual-return");
    const benchmark = screen.getAllByTestId("backtest-annual-benchmark-return");
    expect(strategy.map((cell) => cell.textContent)).toEqual([
      "+18.00%",
      "-7.50%",
      "+24.25%",
    ]);
    expect(benchmark.map((cell) => cell.textContent)).toEqual([
      "+26.89%",
      "-19.44%",
      "+3.10%",
    ]);
    // Aligned: every figure sits in its year's column, in both rows.
    years.forEach((year, index) => {
      const column = (year as HTMLTableCellElement).cellIndex;
      expect((strategy[index] as HTMLTableCellElement).cellIndex).toBe(column);
      expect((benchmark[index] as HTMLTableCellElement).cellIndex).toBe(column);
      expect(strategy[index]?.getAttribute("data-year")).toBe(year.textContent);
      expect(benchmark[index]?.getAttribute("data-year")).toBe(
        year.textContent,
      );
    });
    // The rows are named, the benchmark by the run's own snapshot.
    expect(
      screen.getByTestId("backtest-annual-strategy-row").querySelector("th")
        ?.textContent,
    ).toBe("Strategy");
    expect(
      screen.getByTestId("backtest-annual-benchmark-row").querySelector("th")
        ?.textContent,
    ).toBe(TEST_BENCHMARK_NAME);
    // A real table: the years are column headers and the two series row headers.
    const table = screen.getByTestId("backtest-annual-heatmap");
    expect(table.tagName).toBe("TABLE");
    expect(table.querySelectorAll('th[scope="col"]')).toHaveLength(4);
    expect(table.querySelectorAll('th[scope="row"]')).toHaveLength(2);
    // The heading keeps its one line of copy. `testResult` reports three whole years with a
    // benchmark figure for each, so this run has neither a partial marker nor a gap.
    expect(section.textContent).toContain(
      "Each calendar year on its own, not cumulative.",
    );
    expect(section.querySelector("[data-partial]")).toBeNull();
    expect(screen.queryByTestId("backtest-annual-unavailable-note")).toBeNull();
  });

  it("shades each cell by its direction and size, and keeps the figure written in it", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult() }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    const shades = (testId: string) =>
      screen
        .getAllByTestId(testId)
        .map((cell) => [
          cell.getAttribute("data-tone"),
          cell.getAttribute("data-intensity"),
        ]);
    // +18.00%, -7.50%, +24.25% and +26.89%, -19.44%, +3.10%.
    expect(shades("backtest-annual-return")).toEqual([
      ["positive", "3"],
      ["negative", "2"],
      ["positive", "3"],
    ]);
    expect(shades("backtest-annual-benchmark-return")).toEqual([
      ["positive", "3"],
      ["negative", "3"],
      ["positive", "1"],
    ]);
    // The precise figures stay available on hover, as before the heatmap.
    expect(screen.getAllByTestId("backtest-annual-return")[1]?.title).toBe(
      "2022: Strategy -7.50%",
    );
    expect(
      screen.getAllByTestId("backtest-annual-benchmark-return")[1]?.title,
    ).toBe(`2022: ${TEST_BENCHMARK_NAME} -19.44%`);
  });

  it("scrolls a thirty-year history inside its own region, with every year in one row", async () => {
    const annualReturns = Array.from({ length: 31 }, (_unused, index) => ({
      year: String(1996 + index),
      simulatedThrough: `${1996 + index}-12-31`,
      returnPercent: index % 3 === 0 ? -4 - index : 6 + index,
      benchmarkReturnPercent: index === 0 ? null : 5 + (index % 7),
      partial: index === 0 || index === 30,
    }));
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult({ annualReturns }) }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    expect(screen.getAllByTestId("backtest-annual-year")).toHaveLength(31);
    expect(screen.getAllByTestId("backtest-annual-return")).toHaveLength(31);
    expect(
      screen.getAllByTestId("backtest-annual-benchmark-return"),
    ).toHaveLength(31);
    // A named, keyboard-reachable scroll region holds the table, so the page itself never has to.
    const region = screen.getByTestId("backtest-annual-returns-scroll");
    expect(region.getAttribute("role")).toBe("region");
    expect(region.tabIndex).toBe(0);
    expect(region.getAttribute("aria-labelledby")).toBe(
      screen.getByRole("heading", { name: "Annual returns" }).id,
    );
    expect(region.contains(screen.getByTestId("backtest-annual-heatmap"))).toBe(
      true,
    );
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
              benchmarkReturnPercent: 3.25,
              partial: true,
            },
            {
              year: "1997",
              simulatedThrough: "1997-12-31",
              returnPercent: 12,
              benchmarkReturnPercent: 31.01,
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
    // Both cells of a part-year column are marked, so neither row's figure reads as a whole year,
    // and the tooltip says over which part.
    const strategy1996 = section.querySelector(
      '[data-testid="backtest-annual-return"][data-year="1996"]',
    );
    const benchmark1996 = section.querySelector(
      '[data-testid="backtest-annual-benchmark-return"][data-year="1996"]',
    );
    expect(strategy1996?.getAttribute("data-partial")).toBe("true");
    expect(benchmark1996?.getAttribute("data-partial")).toBe("true");
    expect(strategy1996?.getAttribute("title")).toBe(
      "1996: Strategy +4.50% over the part of the year the run simulated, through 1996-12-31",
    );
    expect(benchmark1996?.getAttribute("title")).toBe(
      `1996: ${TEST_BENCHMARK_NAME} +3.25% over the same part of the year, through 1996-12-31`,
    );
    expect(
      section
        .querySelector(
          '[data-testid="backtest-annual-return"][data-year="1997"]',
        )
        ?.getAttribute("data-partial"),
    ).toBeNull();
  });

  it("says a benchmark year is unavailable rather than inventing a figure", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        result: testResult({
          annualReturns: [
            {
              year: "2021",
              simulatedThrough: "2021-12-31",
              returnPercent: 18,
              benchmarkReturnPercent: null,
              partial: false,
            },
            {
              year: "2022",
              simulatedThrough: "2022-12-30",
              returnPercent: -7.5,
              benchmarkReturnPercent: -19.44,
              partial: false,
            },
          ],
        }),
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    const [missing, present] = screen.getAllByTestId(
      "backtest-annual-benchmark-return",
    );
    // A dash, said in words to assistive technology, on an unshaded tile — never a zero.
    expect(missing?.getAttribute("data-tone")).toBe("unavailable");
    expect(missing?.textContent).toBe("—Unavailable");
    expect(missing?.textContent).not.toContain("0.00%");
    expect(missing?.title).toContain("return unavailable");
    expect(present?.textContent).toBe("-19.44%");
    // The Strategy's figure for that year is unaffected.
    expect(
      screen.getAllByTestId("backtest-annual-return")[0]?.textContent,
    ).toBe("+18.00%");
    expect(
      screen.getByTestId("backtest-annual-unavailable-note").textContent,
    ).toContain(`${TEST_BENCHMARK_NAME} return unavailable`);
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

  it("warns first, above the chart, when an ETF the strategy reads could not be evaluated", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        result: {
          ...testResult(),
          etfConditions: [
            {
              code: "ETF_XLK",
              ticker: "XLK",
              status: "READY",
              firstSession: "1998-12-22",
              latestSession: "2025-12-31",
              basisGeneration: 0,
            },
            { code: "ETF_GLD", ticker: "GLD", status: "NOT_BOOTSTRAPPED" },
          ],
        },
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));

    render(<BacktestRunView runId="run-1" />);
    await flush();

    const notice = screen.getByTestId("backtest-etf-conditions");
    expect(notice.getAttribute("data-tone")).toBe("warning");
    expect(notice.textContent).toContain(
      "Some ETF conditions could not be evaluated",
    );
    const lines = screen.getAllByTestId("backtest-etf-condition");
    expect(
      lines.map((line) => [
        line.getAttribute("data-ticker"),
        line.getAttribute("data-ready"),
      ]),
    ).toEqual([
      ["XLK", "true"],
      ["GLD", "false"],
    ]);
    expect(lines[1]!.textContent).toContain("has not been loaded");
    // What it means and what to do — with the way to do it, the header's own rerun action,
    // directly above it rather than repeated inside it.
    const note = screen.getByTestId("backtest-etf-conditions-note").textContent;
    expect(note).toContain("Rules that read GLD never matched in this run");
    expect(note).toContain("Use “Edit and run again”");
    const rerun = screen.getByTestId("backtest-edit-and-rerun");
    expect(rerun.getAttribute("href")).toContain("/backtests/new");
    expect(
      rerun.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The first thing said about the result: inside the result's own card, before the chart and
    // before every number.
    const hero = screen.getByTestId("backtest-hero");
    expect(hero.contains(notice)).toBe(true);
    for (const after of ["backtest-chart", "backtest-results"]) {
      expect(
        notice.compareDocumentPosition(screen.getByTestId(after)) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        `${after} follows the warning`,
      ).toBeTruthy();
    }
  });

  it("says a zero-trade run's ETF data was missing in its title", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        result: {
          ...testResult(),
          summary: { ...testResult().summary, totalTrades: 0 },
          etfConditions: [
            { code: "SP500", ticker: "SPY", status: "NOT_BOOTSTRAPPED" },
          ],
        },
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));
    render(<BacktestRunView runId="run-1" />);
    await flush();
    expect(screen.getByTestId("backtest-etf-conditions").textContent).toContain(
      "This run made no trades, and its ETF conditions could not be evaluated",
    );
  });

  it("states that every ETF was read, beside the results rather than above them", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        result: {
          ...testResult(),
          summary: { ...testResult().summary, totalTrades: 0 },
          etfConditions: [
            {
              code: "ETF_XLE",
              ticker: "XLE",
              status: "READY",
              firstSession: "1998-12-22",
              latestSession: "2025-12-31",
              basisGeneration: 0,
            },
          ],
        },
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));
    render(<BacktestRunView runId="run-1" />);
    await flush();

    // A valid zero-match result: information, not a warning, and it says why the zero is real.
    const notice = screen.getByTestId("backtest-etf-conditions");
    expect(notice.getAttribute("data-tone")).toBe("info");
    expect(notice.textContent).toContain("ETF conditions were evaluated");
    expect(notice.textContent).toContain("that is the strategy's own result");
    expect(notice.textContent).not.toContain("Edit and run again");
    expect(screen.getByTestId("backtest-hero").contains(notice)).toBe(false);
    expect(
      notice.compareDocumentPosition(screen.getByTestId("run-configuration")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("warns inside the result when a stock had no sector ETF for its Stock's Sector rules", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", {
        result: {
          ...testResult(),
          etfConditions: [
            {
              code: "ETF_XLK",
              ticker: "XLK",
              status: "READY",
              firstSession: "1998-12-22",
              latestSession: "2025-12-31",
              basisGeneration: 0,
            },
          ],
          stockSectors: [
            { symbol: "AAPL", sector: "Technology", code: "ETF_XLK", ticker: "XLK" },
            { symbol: "NOSEC", sector: null, code: null, ticker: null },
          ],
        },
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));
    render(<BacktestRunView runId="run-1" />);
    await flush();

    // Every fund was read, yet one stock had no fund at all: missing data, so a warning.
    const notice = screen.getByTestId("backtest-etf-conditions");
    expect(notice.getAttribute("data-tone")).toBe("warning");
    expect(screen.getByTestId("backtest-hero").contains(notice)).toBe(true);
    const lines = screen.getAllByTestId("backtest-etf-condition");
    expect(
      lines.map((line) => [
        line.getAttribute("data-ticker"),
        line.getAttribute("data-ready"),
      ]),
    ).toEqual([
      ["XLK", "true"],
      ["Stock's Sector", "false"],
    ]);
    expect(lines[1]!.textContent).toContain(
      "AAPL reads XLK. No sector ETF for NOSEC (no FMP sector)",
    );
    expect(screen.getByTestId("backtest-etf-conditions-note").textContent).toContain(
      "The Stock's Sector rules of NOSEC never matched in this run",
    );
  });

  it("shows no ETF notice for a run whose strategy reads none", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult() }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));
    render(<BacktestRunView runId="run-1" />);
    await flush();
    expect(screen.queryByTestId("backtest-etf-conditions")).toBeNull();
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
    const overview = screen.getByTestId("backtest-overview");

    // The chart and Results are the one overview — side by side on a wide desktop, stacked
    // otherwise — and that overview and Annual returns are peers in the hero's one stack: Results
    // does not sit inside a surface of its own that Annual returns does without.
    expect(results.parentElement).toBe(overview);
    expect(overview.contains(screen.getByTestId("backtest-chart"))).toBe(true);
    expect(overview.contains(years)).toBe(false);
    expect(overview.parentElement).toBe(years.parentElement);
    // The chart comes first in it, then the numbers.
    expect(
      [...overview.children].map((child) =>
        child.contains(screen.getByTestId("backtest-chart"))
          ? "chart"
          : child === results
            ? "results"
            : "other",
      ),
    ).toEqual(["chart", "results"]);
    // And the tiles hang straight off the section: heading, grid, tiles, with nothing wrapped
    // around the grid to draw a second box.
    expect(grid.parentElement).toBe(results);
    expect([...results.children].length).toBe(2);

    // All eight, in the order a run is judged (BT-2): annualized return and worst decline first.
    expect(
      [...grid.children].map((tile) => tile.getAttribute("data-testid")),
    ).toEqual([
      "metric-cagr",
      "metric-max-drawdown",
      "metric-portfolio-return",
      "metric-benchmark-return",
      "metric-alpha",
      "metric-portfolio-value",
      "metric-net-profit",
      "metric-trades",
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
      "Showing 51–100 of 18,348 trades",
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
    // Neither the overview nor the annual heatmap stays behind, and the run keeps its Run ID.
    expect(screen.queryByTestId("backtest-overview")).toBeNull();
    expect(screen.queryByTestId("backtest-annual-returns")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Run #0084",
    );
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
      screen
        .getAllByTestId("backtest-annual-year")
        .map((node) => node.getAttribute("data-year")),
    ).toEqual(["1996", "1997", "1998"]);
    expect(running.textContent).toContain("+5.00%");
    expect(running.textContent).not.toContain("+10.00%");
    // The benchmark row is chained the same way from the milestones' cumulative benchmark return
    // (0%, 4%, 8%), its first year measured from the live curve's first point: 0.00%, +4.00%,
    // +3.85% — not the cumulative 8%.
    expect(
      screen
        .getAllByTestId("backtest-annual-benchmark-return")
        .map((node) => node.textContent),
    ).toEqual(["0.00%", "+4.00%", "+3.85%"]);
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

describe("BacktestRunView sharing", () => {
  it("offers Share beside the rerun action for a completed run", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("COMPLETED", { result: testResult() }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("COMPLETED", 2));
    render(<BacktestRunView runId="run-1" />);
    await flush();

    const share = screen.getByTestId("backtest-share");
    expect(share.textContent).toBe("Share");
    expect(vi.mocked(fetchBacktestShare)).toHaveBeenCalledWith(
      "run-1",
      expect.anything(),
    );
    // The private page keeps everything it had: the rerun action and the trade log.
    expect(screen.getByTestId("backtest-edit-and-rerun")).toBeTruthy();
    expect(screen.getByTestId("backtest-trades")).toBeTruthy();
  });

  it("never asks about sharing, or offers it, while a run has no result", async () => {
    vi.mocked(fetchBacktestShare).mockClear();
    fetchRunMock.mockResolvedValue(testDetail("RUNNING"));
    fetchProgressMock.mockResolvedValue(testProgress("RUNNING", 1));
    render(<BacktestRunView runId="run-1" />);
    await flush();

    expect(screen.queryByTestId("backtest-share")).toBeNull();
    expect(vi.mocked(fetchBacktestShare)).not.toHaveBeenCalled();
  });
});

describe("BacktestRunView cancellation", () => {
  const QUEUE = { ahead: 3, executing: 4, capacity: 4 } as const;
  const REQUESTED_AT = "2026-09-01T10:03:00.000Z";

  /** Opens the confirmation from the header and confirms it. */
  async function confirmCancel() {
    fireEvent.click(screen.getByTestId("backtest-cancel"));
    const dialog = screen.getByTestId("confirm-dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel backtest" }),
    );
    await flush();
    await flush();
  }

  it("says where a queued run stands without promising when it starts", async () => {
    fetchRunMock.mockResolvedValue(testDetail("QUEUED", { queue: QUEUE }));
    fetchProgressMock.mockResolvedValue(
      testProgress("RUNNING", 1, { percent: 30 }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();

    expect(screen.getByTestId("backtest-queue-position").textContent).toBe(
      "Up to 3 backtests ahead · 4 of 4 slots busy",
    );
    // An upper bound under fair scheduling, said as one: never a place in line or a time.
    const queue = screen.getByTestId("backtest-queue");
    expect(queue.textContent).toContain("upper bound, not a start time");
    expect(queue.textContent).not.toMatch(/priority|guarantee|minutes?/i);

    // Executing: the run holds a slot and no longer has a place in the queue.
    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS);
    expect(screen.getByTestId("backtest-status").textContent).toBe("Running");
    expect(screen.queryByTestId("backtest-queue")).toBeNull();
  });

  it("confirms first, then shows a cancelled queued run as Cancelled and stops asking", async () => {
    fetchRunMock.mockResolvedValue(testDetail("QUEUED", { queue: QUEUE }));
    cancelMock.mockResolvedValue(
      testDetail("CANCELLED", {
        completedAt: "2026-09-01T10:04:00.000Z",
        progress: {
          percent: 0,
          message: "Cancelled by its owner",
          simulatedThrough: null,
          sequence: 1,
          updatedAt: "2026-09-01T10:04:00.000Z",
        },
      }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();

    const control = screen.getByTestId("backtest-cancel");
    expect(control.textContent).toBe("Cancel backtest");
    fireEvent.click(control);
    // Nothing is stopped until the owner confirms; backing out names what it keeps.
    expect(cancelMock).not.toHaveBeenCalled();
    const dialog = screen.getByTestId("confirm-dialog");
    expect(dialog.textContent).toContain("Run #0084 has not started yet");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep it queued" }),
    );
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(cancelMock).not.toHaveBeenCalled();

    await confirmCancel();

    expect(cancelMock).toHaveBeenCalledWith("run-1");
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    const badge = screen.getByTestId("backtest-status");
    expect(badge.textContent).toBe("Cancelled");
    expect(badge.getAttribute("data-tone")).toBe("neutral");
    expect(badge.getAttribute("data-activity")).toBeNull();
    expect(screen.getByTestId("backtest-cancelled").textContent).toContain(
      "This backtest was cancelled",
    );
    expect(screen.queryByTestId("backtest-cancel")).toBeNull();
    expect(screen.queryByTestId("backtest-progress")).toBeNull();
    expect(screen.getByTestId("backtest-status-announcement").textContent).toBe(
      "Backtest cancelled.",
    );

    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS * 20);
    expect(fetchProgressMock).not.toHaveBeenCalled();
  });

  it("says Cancelling… while an executing run waits for its worker, and cannot be asked twice", async () => {
    const running = {
      progress: {
        percent: 40,
        message: null,
        simulatedThrough: "2023-06-30",
        sequence: 5,
        updatedAt: "2026-09-01T10:03:00.000Z",
      },
      live: testLive(),
    };
    fetchRunMock.mockResolvedValue(testDetail("RUNNING", running));
    cancelMock.mockResolvedValue(
      testDetail("RUNNING", {
        ...running,
        cancellation: { requestedAt: REQUESTED_AT },
      }),
    );
    fetchProgressMock.mockResolvedValue(
      testProgress("RUNNING", 6, {
        percent: 41,
        live: testLive(),
        cancellation: { requestedAt: REQUESTED_AT },
      }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    fireEvent.click(screen.getByTestId("backtest-cancel"));
    expect(screen.getByTestId("confirm-dialog").textContent).toContain(
      "stops at its next checkpoint",
    );
    fireEvent.click(
      within(screen.getByTestId("confirm-dialog")).getByRole("button", {
        name: "Cancel backtest",
      }),
    );
    await flush();
    await flush();

    const control = screen.getByTestId("backtest-cancel");
    expect(control.textContent).toBe("Cancelling…");
    expect(control.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("backtest-cancelling").textContent).toContain(
      "stops at its next checkpoint",
    );
    // The worker has not stopped yet, so the run is still what it was.
    expect(screen.getByTestId("backtest-status").textContent).toBe("Running");
    expect(screen.getByTestId("backtest-status-announcement").textContent).toBe(
      "Cancellation requested. The backtest stops at its next checkpoint.",
    );

    // A checkpoint later the request is still pending, and still said.
    await tick(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    expect(screen.getByTestId("backtest-cancel").textContent).toBe(
      "Cancelling…",
    );
    expect(cancelMock).toHaveBeenCalledTimes(1);
  });

  it("shows a run that finished before it could be cancelled, and says so (409)", async () => {
    fetchRunMock
      .mockResolvedValueOnce(testDetail("RUNNING", { live: testLive() }))
      .mockResolvedValueOnce(
        testDetail("COMPLETED", {
          completedAt: "2026-09-01T10:20:00.000Z",
          progress: {
            percent: 100,
            message: null,
            simulatedThrough: "2026-01-02",
            sequence: 9,
            updatedAt: "2026-09-01T10:20:00.000Z",
          },
          result: testResult(),
        }),
      );
    cancelMock.mockRejectedValue(
      new ApiError(
        409,
        "This backtest has already completed",
        "BACKTEST_NOT_CANCELLABLE",
      ),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await confirmCancel();

    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
    expect(screen.getByTestId("backtest-status").textContent).toBe("Completed");
    expect(screen.getByTestId("backtest-cancel-too-late").textContent).toBe(
      "This backtest finished before it could be cancelled.",
    );
    expect(screen.queryByTestId("backtest-cancel")).toBeNull();
    expect(screen.getByTestId("backtest-edit-and-rerun")).toBeTruthy();
  });

  it("keeps any other refusal in the dialog, in the shared wording", async () => {
    fetchRunMock.mockResolvedValue(testDetail("RUNNING", { live: testLive() }));
    fetchProgressMock.mockResolvedValue(testProgress("RUNNING", 1));
    cancelMock.mockRejectedValue(rateLimited());

    render(<BacktestRunView runId="run-1" />);
    await flush();
    await confirmCancel();

    const dialog = screen.getByTestId("confirm-dialog");
    expect(within(dialog).getByRole("alert").textContent).toBe(
      RATE_LIMITED_COPY,
    );
    expect(
      within(dialog)
        .getByRole("button", { name: "Keep running" })
        .hasAttribute("disabled"),
    ).toBe(false);
    expect(screen.getByTestId("backtest-status").textContent).toBe("Running");
  });

  it("renders a cancelled run with no result, offers it again, and never polls", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("CANCELLED", {
        startedAt: "2026-09-01T10:00:02.000Z",
        completedAt: "2026-09-01T10:04:00.000Z",
        milestones: testMilestones(["2021"]),
      }),
    );

    render(<BacktestRunView runId="run-1" />);
    await flush();

    expect(screen.getByTestId("backtest-status").textContent).toBe("Cancelled");
    const panel = screen.getByTestId("backtest-cancelled");
    expect(panel.textContent).toContain("This backtest was cancelled");
    expect(panel.textContent).toContain("so it has no result");
    const rerun = screen.getByTestId("backtest-cancelled-rerun");
    expect(rerun.textContent).toBe("Run again with these settings");
    const href = new URL(rerun.getAttribute("href") ?? "", "https://x.test");
    expect(href.pathname).toBe("/backtests/new");
    expect(href.searchParams.get("from")).toBe("run-1");
    // No result surface of any kind: a stopped run is not an outcome (UI-031).
    expect(screen.queryByTestId("backtest-overview")).toBeNull();
    expect(screen.queryByTestId("backtest-chart")).toBeNull();
    expect(screen.queryByTestId("backtest-annual-returns")).toBeNull();
    expect(screen.queryByTestId("metric-portfolio-value")).toBeNull();
    expect(screen.queryByText(/No positions/)).toBeNull();
    expect(screen.queryByText("No trades have been executed yet.")).toBeNull();
    expect(screen.queryByTestId("backtest-progress")).toBeNull();
    expect(screen.queryByTestId("backtest-cancel")).toBeNull();
    // The configuration says when it was stopped, not when it "finished".
    const configuration = screen.getByTestId("backtest-configuration");
    expect(configuration.textContent).toContain("Cancelled");
    expect(configuration.textContent).not.toContain("Finished");

    await tick(BACKTEST_PENDING_POLL_INTERVAL_MS * 20);
    expect(fetchProgressMock).not.toHaveBeenCalled();
    expect(fetchTradesMock).not.toHaveBeenCalled();
  });
});

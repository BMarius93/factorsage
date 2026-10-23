import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { TEST_BENCHMARK_NAME } from "../utils/backtest.test-helper";
import { SharedBacktestReport } from "./SharedBacktestReport";
import { testSharedReport } from "./shared-backtest.test-helper";

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

// jsdom cannot rasterize a canvas; the chart's own suite covers what it draws.
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

const sessionMock = vi.mocked(useAuthSession);

function signedOut() {
  sessionMock.mockReturnValue({
    state: { status: "unauthenticated" },
    signOut: vi.fn(),
    retry: vi.fn(),
  } as unknown as ReturnType<typeof useAuthSession>);
}

beforeEach(() => {
  sessionMock.mockReset();
  signedOut();
});

describe("SharedBacktestReport", () => {
  it("is titled by the run's Run ID and presents itself as a shared, read-only report", () => {
    render(<SharedBacktestReport report={testSharedReport()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Run #0084",
    );
    const metadata = screen.getByTestId("shared-backtest-metadata").textContent;
    expect(metadata).toContain("Shared backtest report");
    expect(metadata).toContain("Benchmark: Total Market Index");
    // The owner's line names the strategy and the list; this one names neither.
    expect(metadata).not.toMatch(/Strategy:|List:/);
    expect(screen.getByTestId("shared-backtest-badge").textContent).toBe(
      "Read-only",
    );
    expect(screen.getByTestId("shared-backtest-intro").textContent).toContain(
      "rules, the stock list and its securities, and the individual trades are private",
    );
  });

  it("draws the interactive chart and the owner page's eight figures in one overview", () => {
    render(<SharedBacktestReport report={testSharedReport()} />);
    // The owner page's own overview component: the chart and the tiles side by side.
    const overview = screen.getByTestId("backtest-overview");
    expect(overview.contains(screen.getByTestId("backtest-chart"))).toBe(true);
    expect(overview.contains(screen.getByTestId("backtest-results"))).toBe(
      true,
    );
    const tiles = within(screen.getByTestId("backtest-metrics"));
    expect(tiles.getAllByRole("term")).toHaveLength(8);
    expect(screen.getByTestId("metric-cagr").textContent).toContain("+6.30%");
    expect(screen.getByTestId("metric-cagr-benchmark").textContent).toBe(
      ", compared with Total Market Index +3.90%",
    );
    expect(screen.getByTestId("metric-max-drawdown").textContent).toContain(
      "-14.20%",
    );
    expect(screen.getByTestId("metric-portfolio-value").textContent).toContain(
      "$34,000.00",
    );
    expect(screen.getByTestId("metric-trades").textContent).toContain("42");
  });

  it("shows each year as the Strategy vs benchmark heatmap", () => {
    render(<SharedBacktestReport report={testSharedReport()} />);
    const heatmap = screen.getByTestId("backtest-annual-heatmap");
    expect(
      within(heatmap)
        .getAllByTestId("backtest-annual-year")
        .map((cell) => cell.textContent?.trim()),
    ).toEqual(["2021", "2022", "2023"]);
    const strategy = within(
      screen.getByTestId("backtest-annual-strategy-row"),
    ).getAllByTestId("backtest-annual-return");
    const benchmark = within(
      screen.getByTestId("backtest-annual-benchmark-row"),
    ).getAllByTestId("backtest-annual-benchmark-return");
    expect(strategy.map((cell) => cell.textContent?.trim())).toEqual([
      "+18.00%",
      "-7.50%",
      "+24.25%",
    ]);
    expect(benchmark).toHaveLength(3);
    expect(
      screen.getByTestId("backtest-annual-benchmark-row").textContent,
    ).toContain(TEST_BENCHMARK_NAME);
  });

  it("states the simulation's general parameters and the two counts", () => {
    render(<SharedBacktestReport report={testSharedReport()} />);
    const facts = screen.getByTestId("shared-backtest-configuration");
    expect(facts.textContent).toContain("$10,000.00");
    expect(facts.textContent).toContain("$250.00");
    expect(facts.textContent).toContain(TEST_BENCHMARK_NAME);
    expect(
      screen.getByTestId("shared-backtest-security-count").textContent,
    ).toBe("750");
    expect(screen.getByTestId("shared-backtest-rule-count").textContent).toBe(
      "12",
    );
    expect(screen.getByTestId("shared-backtest-run-id").textContent).toBe(
      "Run #0084",
    );
  });

  it("has no trade log, no owner action, no locked section and no private link", () => {
    const { container } = render(
      <SharedBacktestReport report={testSharedReport()} />,
    );
    for (const testId of [
      "backtest-trades",
      "run-configuration",
      "backtest-edit-and-rerun",
      "backtest-share",
      "backtest-holdings",
    ]) {
      expect(screen.queryByTestId(testId), testId).toBeNull();
    }
    const hrefs = [...container.querySelectorAll("a")].map((link) =>
      link.getAttribute("href"),
    );
    expect(hrefs.some((href) => href?.startsWith("/strategies"))).toBe(false);
    expect(hrefs.some((href) => href?.startsWith("/lists"))).toBe(false);
    expect(hrefs.some((href) => href?.startsWith("/backtests/new?"))).toBe(
      false,
    );
    expect(container.textContent).not.toMatch(/upgrade|unlock|trade log/i);
    // No UUID anywhere: the run is named by its Run ID only.
    expect(container.innerHTML).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("says so instead of drawing a chart for a run with no curve", () => {
    const report = testSharedReport();
    render(
      <SharedBacktestReport
        report={{ ...report, result: { ...report.result, curve: [] } }}
      />,
    );
    expect(screen.getByTestId("backtest-chart-placeholder")).toBeTruthy();
    expect(screen.queryByTestId("backtest-chart")).toBeNull();
  });

  it("sends a visitor without an account to registration, returning to New Backtest", () => {
    render(<SharedBacktestReport report={testSharedReport()} />);
    const cta = screen.getByTestId("shared-backtest-cta");
    expect(cta.textContent).toBe("Create your own backtest");
    expect(cta.getAttribute("href")).toBe("/register?next=%2Fbacktests%2Fnew");
    expect(cta.getAttribute("data-audience")).toBe("guest");
  });

  it("sends a signed-in reader straight to New Backtest, whatever their plan", () => {
    sessionMock.mockReturnValue({
      state: {
        status: "authenticated",
        user: {
          id: "u",
          email: "u@example.test",
          role: "USER",
          plan: "STARTER",
        },
      },
      signOut: vi.fn(),
      retry: vi.fn(),
    } as unknown as ReturnType<typeof useAuthSession>);
    render(<SharedBacktestReport report={testSharedReport()} />);
    const cta = screen.getByTestId("shared-backtest-cta");
    expect(cta.getAttribute("href")).toBe("/backtests/new");
    expect(cta.getAttribute("data-audience")).toBe("member");
  });
});

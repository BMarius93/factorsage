import type {
  BacktestRunSummaryResponse,
  MonitorSummaryResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBacktestRuns } from "../../backtests/api/backtests-api";
import { fetchMonitor, fetchMonitors } from "../../monitors/api/monitors-api";
import { DashboardPage } from "./DashboardPage";

vi.mock("../../monitors/api/monitors-api", () => ({
  fetchMonitors: vi.fn(),
  fetchMonitor: vi.fn(),
}));

vi.mock("../../backtests/api/backtests-api", () => ({
  fetchBacktestRuns: vi.fn(),
}));

const fetchMonitorsMock = vi.mocked(fetchMonitors);
const fetchMonitorMock = vi.mocked(fetchMonitor);
const fetchBacktestRunsMock = vi.mocked(fetchBacktestRuns);

function monitor(
  overrides: Partial<MonitorSummaryResponse> = {},
): MonitorSummaryResponse {
  return {
    id: "monitor-1",
    name: "Value entries",
    enabled: true,
    strategyId: "strategy-1",
    strategyName: "Deep value",
    stockListId: "list-1",
    stockListName: "Quality compounders",
    securityCount: 12,
    activeSignalCount: 0,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    operationalStatus: "ACTIVE",
    ...overrides,
  };
}

function run(
  overrides: Partial<BacktestRunSummaryResponse> = {},
): BacktestRunSummaryResponse {
  return {
    id: "run-1",
    status: "COMPLETED",
    strategyName: "Deep value",
    stockListName: "Quality compounders",
    benchmarkCode: "SP500",
    benchmarkName: "S&P 500",
    startDate: "2020-01-01",
    endDate: "2026-01-01",
    initialCapital: 10000,
    maximumPositions: 10,
    queuedAt: "2026-08-01T10:00:00.000Z",
    startedAt: "2026-08-01T10:00:05.000Z",
    completedAt: "2026-08-01T10:04:00.000Z",
    progressPercent: 100,
    progressMessage: null,
    portfolioReturnPercent: 42,
    benchmarkReturnPercent: 30,
    alphaPercent: 12,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DashboardPage", () => {
  it("summarises monitors and runs from the two collection endpoints only", async () => {
    fetchMonitorsMock.mockResolvedValue([
      monitor({ activeSignalCount: 3 }),
      monitor({
        id: "monitor-2",
        name: "Momentum exits",
        activeSignalCount: 0,
        enabled: false,
      }),
    ]);
    fetchBacktestRunsMock.mockResolvedValue([run()]);

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-summary")).toBeDefined();
    });

    const summary = screen.getByTestId("dashboard-summary");
    // Three active signals across both monitors, one of two scanning.
    expect(within(summary).getByText("3")).toBeDefined();
    expect(within(summary).getByText("1/2")).toBeDefined();
    expect(within(summary).getByText("1 monitor needs attention")).toBeDefined();

    // The per-monitor detail endpoint is the one that carries matched securities.
    // Calling it once per monitor is exactly the N+1 this page must never introduce.
    expect(fetchMonitorMock).not.toHaveBeenCalled();
    expect(fetchMonitorsMock).toHaveBeenCalledTimes(1);
    expect(fetchBacktestRunsMock).toHaveBeenCalledTimes(1);
  });

  it("orders monitors with signals first and links their strategy and list", async () => {
    fetchMonitorsMock.mockResolvedValue([
      monitor({ id: "quiet", name: "Quiet one", activeSignalCount: 0 }),
      monitor({ id: "loud", name: "Loud one", activeSignalCount: 5 }),
    ]);
    fetchBacktestRunsMock.mockResolvedValue([]);

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-monitors")).toBeDefined();
    });

    const rows = screen.getAllByTestId("dashboard-monitor-row");
    expect(within(rows[0]!).getByText("Loud one")).toBeDefined();
    expect(within(rows[0]!).getByText("5 signals")).toBeDefined();

    expect(
      screen.getAllByRole("link", { name: "Deep value" })[0]?.getAttribute("href"),
    ).toBe("/strategies/strategy-1");
    expect(
      screen
        .getAllByRole("link", { name: "Quality compounders" })[0]
        ?.getAttribute("href"),
    ).toBe("/lists/list-1");
  });

  it("filters to the monitors that need attention without hiding the others permanently", async () => {
    fetchMonitorsMock.mockResolvedValue([
      monitor({ id: "ok", name: "Running fine", activeSignalCount: 1 }),
      monitor({
        id: "blocked",
        name: "Over limit",
        operationalStatus: "BLOCKED_BY_ENTITLEMENT",
        blockedReason: "LIST_OVER_LIMIT",
      }),
    ]);
    fetchBacktestRunsMock.mockResolvedValue([]);

    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getAllByTestId("dashboard-monitor-row")).toHaveLength(2);
    });

    await userEvent.click(screen.getByRole("button", { name: /Needs attention/ }));

    const rows = screen.getAllByTestId("dashboard-monitor-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Over limit")).toBeDefined();
    expect(within(rows[0]!).getByText("Not scanning")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /All/ }));
    expect(screen.getAllByTestId("dashboard-monitor-row")).toHaveLength(2);
  });

  it("offers a way in when the account has nothing yet", async () => {
    fetchMonitorsMock.mockResolvedValue([]);
    fetchBacktestRunsMock.mockResolvedValue([]);

    render(<DashboardPage />);

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-monitors-empty")).toBeDefined();
    });
    expect(screen.getByTestId("dashboard-backtests-empty")).toBeDefined();
    expect(
      screen.getByText("Nothing is matching right now"),
    ).toBeDefined();
  });

  it("reports a load failure and recovers through retry", async () => {
    fetchMonitorsMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce([monitor()]);
    fetchBacktestRunsMock.mockResolvedValue([]);

    render(<DashboardPage />);

    await waitFor(() => {
      expect(
        screen.getByText("Your dashboard could not be loaded"),
      ).toBeDefined();
    });

    await userEvent.click(screen.getByText("Try again"));

    await waitFor(() => {
      expect(screen.getByText("Value entries")).toBeDefined();
    });
  });
});

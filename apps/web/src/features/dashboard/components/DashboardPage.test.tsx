import type {
  DashboardMonitorResponse,
  DashboardResponse,
  DashboardRowResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { updateMonitor } from "../../monitors/api/monitors-api";
import {
  fetchDashboard,
  setBuiltInMonitorVisibility,
} from "../api/dashboard-api";
import { DashboardPage } from "./DashboardPage";

vi.mock("../api/dashboard-api", () => ({
  fetchDashboard: vi.fn(),
  setBuiltInMonitorVisibility: vi.fn(),
}));

vi.mock("../../monitors/api/monitors-api", () => ({
  updateMonitor: vi.fn(),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const fetchDashboardMock = vi.mocked(fetchDashboard);
const setVisibilityMock = vi.mocked(setBuiltInMonitorVisibility);
const updateMonitorMock = vi.mocked(updateMonitor);
const useAuthSessionMock = vi.mocked(useAuthSession);

const RECENT_SCAN = new Date(Date.now() - 3 * 60_000).toISOString();

function monitor(overrides: Partial<DashboardMonitorResponse> = {}): DashboardMonitorResponse {
  return {
    id: "monitor-a",
    name: "S&P Value & Trend",
    ownership: "SYSTEM",
    strategy: { id: "strategy-a", name: "Value & Trend" },
    stockList: { id: "list-a", name: "S&P 500 Growth Leaders" },
    visible: true,
    control: "BUILT_IN_PREFERENCE",
    freshness: "CURRENT",
    lastScanAt: RECENT_SCAN,
    activeCount: 1,
    pendingCount: 0,
    ...overrides,
  };
}

function row(overrides: Partial<DashboardRowResponse> = {}): DashboardRowResponse {
  return {
    id: "row-1",
    state: "ACTIVE",
    security: { id: "sec-aapl", symbol: "AAPL", name: "Apple Inc.", exchangeCode: "NASDAQ" },
    levelKind: "BUY",
    levelIndex: 1,
    levelPercentage: 100,
    reasons: [
      {
        conditions: ["Margin of Safety (Balanced) is above 5%", "Price is above SMA 200D"],
        waitingForTrigger: false,
      },
    ],
    monitor: { id: "monitor-a", name: "S&P Value & Trend", ownership: "SYSTEM" },
    strategy: { id: "strategy-a", name: "Value & Trend" },
    stockList: { id: "list-a", name: "S&P 500 Growth Leaders" },
    price: 210.5,
    observationDate: "2026-09-14",
    since: "2026-09-14T15:00:00.000Z",
    reconstructed: false,
    signalId: "signal-1",
    ...overrides,
  };
}

function dashboard(overrides: Partial<DashboardResponse> = {}): DashboardResponse {
  return {
    viewer: "GUEST",
    generatedAt: new Date().toISOString(),
    staleAfterMs: 900_000,
    monitors: [
      monitor(),
      monitor({
        id: "monitor-b",
        name: "Nasdaq Trend Confirmation",
        strategy: { id: "strategy-b", name: "Trend Confirmation" },
        stockList: { id: "list-b", name: "Nasdaq-100 Newcomers" },
        activeCount: 1,
        pendingCount: 1,
      }),
    ],
    rows: [
      row({
        id: "row-pending",
        state: "PENDING_TRIGGER",
        security: { id: "sec-rop", symbol: "ROP", name: "Roper", exchangeCode: "NASDAQ" },
        reasons: [
          {
            conditions: ["SMA 50D is above SMA 200D", "Price is above SMA 200D"],
            trigger: "Price crosses above SMA 20D",
            waitingForTrigger: true,
          },
        ],
        monitor: { id: "monitor-b", name: "Nasdaq Trend Confirmation", ownership: "SYSTEM" },
        strategy: { id: "strategy-b", name: "Trend Confirmation" },
        stockList: { id: "list-b", name: "Nasdaq-100 Newcomers" },
        signalId: undefined,
      }),
      row({ id: "row-b", monitor: { id: "monitor-b", name: "Nasdaq Trend Confirmation", ownership: "SYSTEM" } }),
      row(),
      row({
        id: "row-exit",
        levelKind: "FINAL_EXIT",
        levelIndex: undefined,
        levelPercentage: undefined,
        reconstructed: true,
        security: { id: "sec-uber", symbol: "UBER", name: "Uber", exchangeCode: "NYSE" },
        reasons: [{ conditions: ["Price is below SMA 200D"], waitingForTrigger: false }],
      }),
    ],
    ...overrides,
  };
}

function signedOut() {
  useAuthSessionMock.mockReturnValue({
    state: { status: "unauthenticated" },
    signOut: vi.fn(),
  });
}

function signedIn() {
  useAuthSessionMock.mockReturnValue({
    state: {
      status: "authenticated",
      user: { id: "user-1", email: "user@example.test", role: "USER", plan: "FREE" },
    },
    signOut: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
});

describe("DashboardPage", () => {
  it("renders active signals and waiting setups, one row per monitor outcome", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const table = await screen.findByTestId("dashboard-signals");
    const rows = within(table).getAllByTestId("dashboard-signal-row");
    expect(rows).toHaveLength(4);
    // The same stock under two monitors is two rows.
    expect(rows.filter((entry) => entry.textContent?.includes("AAPL"))).toHaveLength(2);
    expect(within(rows[0]!).getByText("Waiting for trigger")).toBeDefined();
    expect(within(rows[0]!).getByText(/Waiting for: Price crosses above SMA 20D/)).toBeDefined();
    expect(within(rows[1]!).getByText("Active")).toBeDefined();
    expect(within(rows[1]!).getByText("Buy 100%")).toBeDefined();
    expect(within(rows[3]!).getByText("Final exit")).toBeDefined();
    expect(within(rows[3]!).getByText("from history")).toBeDefined();

    // The identity cell is the row's link to Stock Details; the source chips link elsewhere.
    expect(within(rows[1]!).getByRole("link", { name: /AAPL/ }).getAttribute("href")).toBe("/stocks/AAPL");
    expect(
      within(rows[1]!).getByRole("link", { name: "Value & Trend" }).getAttribute("href"),
    ).toBe("/strategies/strategy-a");
    expect(
      within(rows[1]!).getByRole("link", { name: /Backtest/ }).getAttribute("href"),
    ).toBe("/backtests/new?strategyId=strategy-a&stockListId=list-a");
  });

  it("filters by state and by action", async () => {
    const user = userEvent.setup();
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-signals");

    const states = screen.getByTestId("dashboard-state-filter");
    await user.click(within(states).getByRole("button", { name: /Waiting for trigger/ }));
    expect(screen.getAllByTestId("dashboard-signal-row")).toHaveLength(1);

    await user.click(within(states).getByRole("button", { name: /^Active/ }));
    const levels = screen.getByTestId("dashboard-level-filter");
    await user.click(within(levels).getByRole("button", { name: /Final exit/ }));
    expect(screen.getAllByTestId("dashboard-signal-row")).toHaveLength(1);

    await user.click(within(levels).getByRole("button", { name: /Sell/ }));
    expect(screen.getByTestId("dashboard-signals-filtered-empty")).toBeDefined();
  });

  it("asks a Guest to sign in instead of storing a monitor preference", async () => {
    const user = userEvent.setup();
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-guest-notice");

    const [toggle] = screen.getAllByTestId("dashboard-monitor-toggle");
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    await user.click(toggle!);

    const prompt = await screen.findByTestId("sign-in-prompt");
    expect(within(prompt).getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe("/login");
    expect(setVisibilityMock).not.toHaveBeenCalled();
    expect(updateMonitorMock).not.toHaveBeenCalled();
  });

  it("saves a signed-in user's built-in preference and a customer monitor's own switch", async () => {
    signedIn();
    const user = userEvent.setup();
    fetchDashboardMock.mockResolvedValue(
      dashboard({
        viewer: "AUTHENTICATED",
        monitors: [
          monitor(),
          monitor({
            id: "own-monitor",
            name: "My watch",
            ownership: "USER",
            control: "MONITOR_ENABLED",
            visible: false,
            freshness: "PAUSED",
          }),
        ],
      }),
    );
    setVisibilityMock.mockResolvedValue(undefined);
    updateMonitorMock.mockResolvedValue({} as never);
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-signals");
    expect(screen.queryByTestId("dashboard-guest-notice")).toBeNull();

    const toggles = screen.getAllByTestId("dashboard-monitor-toggle");
    await user.click(toggles[0]!);
    await waitFor(() =>
      expect(setVisibilityMock).toHaveBeenCalledWith("monitor-a", { visible: false }),
    );
    await user.click(toggles[1]!);
    await waitFor(() =>
      expect(updateMonitorMock).toHaveBeenCalledWith("own-monitor", { enabled: true }),
    );
    // Each saved change re-reads the Dashboard.
    await waitFor(() => expect(fetchDashboardMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Paused")).toBeDefined();
  });

  it("presents stale scans honestly", async () => {
    fetchDashboardMock.mockResolvedValue(
      dashboard({
        monitors: [
          monitor({
            freshness: "STALE",
            lastScanAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
          }),
        ],
      }),
    );
    render(<DashboardPage />);
    const badge = await screen.findByTestId("dashboard-freshness");
    expect(badge.textContent).toBe("Stale · last scan 2 days ago");
  });

  it("explains an empty dashboard, and recovers from a failed load", async () => {
    const user = userEvent.setup();
    fetchDashboardMock.mockRejectedValueOnce(new Error("offline"));
    fetchDashboardMock.mockResolvedValueOnce(dashboard({ rows: [] }));
    render(<DashboardPage />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("dashboard-signals-empty")).toBeDefined();
    expect(screen.getByText("Nothing is matching right now")).toBeDefined();
  });
});

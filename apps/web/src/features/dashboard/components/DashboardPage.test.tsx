import type {
  DashboardMonitorResponse,
  DashboardResponse,
  DashboardRowResponse,
} from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { fetchDashboard } from "../api/dashboard-api";
import { DashboardPage } from "./DashboardPage";

vi.mock("../api/dashboard-api", () => ({ fetchDashboard: vi.fn() }));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const fetchDashboardMock = vi.mocked(fetchDashboard);
const useAuthSessionMock = vi.mocked(useAuthSession);

const RECENT_SCAN = new Date(Date.now() - 3 * 60_000).toISOString();

function monitor(
  overrides: Partial<DashboardMonitorResponse> = {},
): DashboardMonitorResponse {
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

function row(
  overrides: Partial<DashboardRowResponse> = {},
): DashboardRowResponse {
  return {
    id: "row-1",
    state: "ACTIVE",
    security: {
      id: "sec-aapl",
      symbol: "AAPL",
      name: "Apple Inc.",
      exchangeCode: "NASDAQ",
    },
    levelKind: "BUY",
    levelIndex: 1,
    levelPercentage: 100,
    reasons: [
      {
        conditions: [
          "Margin of Safety (Balanced) is above 5%",
          "Price is above SMA 200D",
        ],
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

function dashboard(
  overrides: Partial<DashboardResponse> = {},
): DashboardResponse {
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
        security: {
          id: "sec-rop",
          symbol: "ROP",
          name: "Roper",
          exchangeCode: "NASDAQ",
        },
        reasons: [
          {
            conditions: ["SMA 50D is above SMA 200D", "Price is above SMA 200D"],
            trigger: "Price crosses above SMA 20D",
            waitingForTrigger: true,
          },
        ],
        monitor: {
          id: "monitor-b",
          name: "Nasdaq Trend Confirmation",
          ownership: "SYSTEM",
        },
        strategy: { id: "strategy-b", name: "Trend Confirmation" },
        stockList: { id: "list-b", name: "Nasdaq-100 Newcomers" },
        signalId: undefined,
      }),
      row({
        id: "row-b",
        monitor: {
          id: "monitor-b",
          name: "Nasdaq Trend Confirmation",
          ownership: "SYSTEM",
        },
      }),
      row(),
      row({
        id: "row-exit",
        levelKind: "FINAL_EXIT",
        levelIndex: undefined,
        levelPercentage: undefined,
        reconstructed: true,
        security: {
          id: "sec-uber",
          symbol: "UBER",
          name: "Uber",
          exchangeCode: "NYSE",
        },
        reasons: [
          { conditions: ["Price is below SMA 200D"], waitingForTrigger: false },
        ],
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
      user: {
        id: "user-1",
        email: "user@example.test",
        role: "USER",
        plan: "FREE",
      },
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
    expect(
      rows.filter((entry) => entry.textContent?.includes("AAPL")),
    ).toHaveLength(2);
    expect(within(rows[0]!).getByText("Waiting for trigger")).toBeDefined();
    expect(
      within(rows[0]!).getByText(/Waiting for: Price crosses above SMA 20D/),
    ).toBeDefined();
    expect(within(rows[1]!).getByText("Active")).toBeDefined();
    expect(within(rows[1]!).getByText("Buy 100%")).toBeDefined();
    expect(within(rows[3]!).getByText("Final exit")).toBeDefined();
  });

  it("shows exactly the agreed columns: no Since, and no per-row Backtest", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const table = await screen.findByTestId("dashboard-signals");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "Stock",
      "Action",
      "Why",
      "Price",
      "Strategy",
      "List",
      "Monitor",
    ]);
    expect(within(table).queryByRole("columnheader", { name: "Since" })).toBeNull();
    expect(screen.queryAllByRole("link", { name: /Backtest/ })).toHaveLength(0);
  });

  it("links the stock, the strategy, the list and the monitor independently", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const rows = within(await screen.findByTestId("dashboard-signals")).getAllByTestId(
      "dashboard-signal-row",
    );
    const active = rows[1]!;
    // The identity cell is the row's own link to Stock Details; the three relationship cells
    // each go somewhere else, and none of them is the row's destination.
    expect(
      within(active).getByRole("link", { name: /AAPL/ }).getAttribute("href"),
    ).toBe("/stocks/AAPL");
    expect(
      within(active)
        .getByRole("link", { name: "Value & Trend" })
        .getAttribute("href"),
    ).toBe("/strategies/strategy-a");
    expect(
      within(active)
        .getByRole("link", { name: "S&P 500 Growth Leaders" })
        .getAttribute("href"),
    ).toBe("/lists/list-a");
    expect(
      within(active)
        .getByRole("link", { name: "Nasdaq Trend Confirmation" })
        .getAttribute("href"),
    ).toBe("/monitors/monitor-b");
  });

  it("filters by state with a segmented control and by action with a dropdown", async () => {
    const user = userEvent.setup();
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-signals");

    const states = screen.getByTestId("dashboard-state-filter");
    expect(
      within(states)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["All4", "Active3", "Waiting1"]);

    await user.click(within(states).getByRole("button", { name: /^Waiting/ }));
    expect(screen.getAllByTestId("dashboard-signal-row")).toHaveLength(1);

    // State AND action compose: back to Active, then narrow to the one final exit.
    await user.click(within(states).getByRole("button", { name: /^Active/ }));
    expect(screen.getAllByTestId("dashboard-signal-row")).toHaveLength(3);
    const actions = screen.getByTestId("dashboard-level-filter");
    await user.selectOptions(actions, "FINAL_EXIT");
    expect(screen.getAllByTestId("dashboard-signal-row")).toHaveLength(1);

    // A composition with no rows says so rather than showing an unfiltered table.
    await user.selectOptions(actions, "SELL");
    expect(screen.getByTestId("dashboard-signals-filtered-empty")).toBeDefined();

    await user.selectOptions(actions, "ALL");
    await user.click(within(states).getByRole("button", { name: /^All/ }));
    expect(screen.getAllByTestId("dashboard-signal-row")).toHaveLength(4);
  });

  it("carries no monitor configuration: that lives with the monitors", async () => {
    signedIn();
    fetchDashboardMock.mockResolvedValue(
      dashboard({ viewer: "AUTHENTICATED" }),
    );
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-signals");

    expect(screen.queryByTestId("dashboard-monitors")).toBeNull();
    expect(screen.queryAllByTestId("dashboard-monitor")).toHaveLength(0);
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByTestId("dashboard-guest-notice")).toBeNull();
  });

  it("invites a Guest in without redirecting them anywhere", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const notice = await screen.findByTestId("dashboard-guest-notice");
    expect(
      within(notice).getByRole("link", { name: "Sign in" }).getAttribute("href"),
    ).toBe("/login");
    expect(screen.getAllByTestId("dashboard-signal-row")).toHaveLength(4);
  });

  it("presents stale scans honestly", async () => {
    fetchDashboardMock.mockResolvedValue(
      dashboard({
        monitors: [
          monitor({
            freshness: "STALE",
            lastScanAt: new Date(
              Date.now() - 2 * 24 * 60 * 60_000,
            ).toISOString(),
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

  it("sends a viewer who hid every monitor to the page that can bring one back", async () => {
    fetchDashboardMock.mockResolvedValue(
      dashboard({ rows: [], monitors: [monitor({ visible: false })] }),
    );
    render(<DashboardPage />);
    const empty = await screen.findByTestId("dashboard-signals-empty");
    expect(within(empty).getByText("No monitors are shown")).toBeDefined();
    expect(
      within(empty)
        .getByRole("link", { name: "Go to monitors" })
        .getAttribute("href"),
    ).toBe("/monitors");
  });
});

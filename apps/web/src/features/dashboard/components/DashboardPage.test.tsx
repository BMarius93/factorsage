import type {
  DashboardMonitorResponse,
  DashboardResponse,
  DashboardRowResponse,
} from "@intrinsic/contracts";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { fetchMarketOverview } from "../../market/api/market-api";
import { fetchDashboard } from "../api/dashboard-api";
import { DashboardPage } from "./DashboardPage";

vi.mock("../api/dashboard-api", () => ({ fetchDashboard: vi.fn() }));

// The overview strip reads its own endpoint. Mocked here so the page's tests stay about the page,
// and so the strip is exercised against a response rather than against a failed jsdom fetch.
vi.mock("../../market/api/market-api", () => ({ fetchMarketOverview: vi.fn() }));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const fetchDashboardMock = vi.mocked(fetchDashboard);
const fetchMarketOverviewMock = vi.mocked(fetchMarketOverview);
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

const MARKET_OVERVIEW = {
  generatedAt: "2026-09-17T20:00:00.000Z",
  basis: "END_OF_DAY" as const,
  items: [
    {
      code: "SP500_INDEX",
      label: "S&P 500",
      status: "AVAILABLE" as const,
      value: 7637.05,
      previousClose: 7551.81,
      changePercent: 1.1287,
      sessionDate: "2026-09-17",
      sparkline: [
        { date: "2026-09-16", value: 7551.81 },
        { date: "2026-09-17", value: 7637.05 },
      ],
    },
    {
      code: "DJIA_INDEX",
      label: "DJIA",
      status: "AVAILABLE" as const,
      value: 51778.04,
      sessionDate: "2026-09-17",
      sparkline: [{ date: "2026-09-17", value: 51778.04 }],
    },
    {
      code: "VIX_INDEX",
      label: "VIX",
      status: "AVAILABLE" as const,
      value: 15.43,
      sessionDate: "2026-09-17",
      sparkline: [{ date: "2026-09-17", value: 15.43 }],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  signedOut();
  fetchMarketOverviewMock.mockResolvedValue(MARKET_OVERVIEW);
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
    const relationshipCells = Array.from(
      active.querySelectorAll<HTMLElement>('td[data-card="links"]'),
    );
    expect(
      relationshipCells.map((cell) => [
        within(cell).getByRole("link").textContent,
        within(cell).getByRole("link").getAttribute("href"),
      ]),
    ).toEqual([
      ["Value & Trend", "/strategies/strategy-a"],
      ["S&P 500 Growth Leaders", "/lists/list-a"],
      ["Nasdaq Trend Confirmation", "/monitors/monitor-b"],
    ]);
  });

  it("folds the three relationships under the stock for the intermediate desktop band", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const rows = within(await screen.findByTestId("dashboard-signals")).getAllByTestId(
      "dashboard-signal-row",
    );
    const active = rows[1]!;
    // The three columns step out between 880 and 1,279px, and the same references are folded
    // into the identity cell instead. CSS shows exactly one of the two at any width.
    expect(
      active.querySelectorAll('td[data-card="links"][data-fold="true"]'),
    ).toHaveLength(3);
    const folded = within(active).getByTestId("dashboard-folded-relationships");
    expect(folded.closest('td')?.getAttribute("data-card")).toBe("identity");
    expect(
      within(folded)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/strategies/strategy-a", "/lists/list-a", "/monitors/monitor-b"]);
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

  it("puts the five-card overview above the signals, and keeps it out of the filters", async () => {
    const user = userEvent.setup();
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const overview = await screen.findByTestId("dashboard-overview");
    const signals = await screen.findByTestId("dashboard-signals");
    // The cards are context for the table, so they precede it in the document.
    expect(
      overview.compareDocumentPosition(signals) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("dashboard-matches-total").textContent).toBe("4");
    expect(screen.getByTestId("dashboard-matches-breakdown").textContent).toBe(
      "3 active · 1 waiting",
    );

    // Narrowing the table below is a view decision; it does not change what is matching, and the
    // card must not restate the filter counts that are already on the filter buttons.
    await user.click(
      within(screen.getByTestId("dashboard-state-filter")).getByRole("button", {
        name: /Active/,
      }),
    );
    expect(
      within(screen.getByTestId("dashboard-signals")).getAllByTestId(
        "dashboard-signal-row",
      ),
    ).toHaveLength(3);
    expect(screen.getByTestId("dashboard-matches-total").textContent).toBe("4");
    expect(screen.getByTestId("dashboard-matches-breakdown").textContent).toBe(
      "3 active · 1 waiting",
    );
  });

  it("shows a Guest the market cards and asks for an account only at the action", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    await screen.findByTestId("dashboard-overview");
    // Identical market data to a signed-in viewer's: the market is not a per-account fact.
    expect(
      screen.getByTestId("dashboard-market-value-SP500_INDEX").textContent,
    ).toBe("7,637");
    // And the Run Backtest card is the one thing that needs an account.
    expect(screen.getByTestId("dashboard-run-backtest").tagName).toBe("BUTTON");
  });

  it("never describes VIX, or anything on the Dashboard, as fear and greed", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-signals");
    await screen.findByTestId("dashboard-market-value-VIX_INDEX");

    const page = screen.getByTestId("dashboard-page");
    expect(page.textContent).not.toMatch(/fear|greed/i);
    expect(page.textContent).not.toMatch(/24h/i);
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

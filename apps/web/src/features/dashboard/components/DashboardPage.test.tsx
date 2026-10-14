import type {
  DashboardActivityEventResponse,
  DashboardMonitorResponse,
  DashboardResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { marketOverviewFixture } from "../../market/__testing__/market-overview";
import { fetchMarketOverview } from "../../market/api/market-api";
import { fetchDashboard, fetchMonitorActivity } from "../api/dashboard-api";
import { DashboardPage } from "./DashboardPage";

vi.mock("../api/dashboard-api", () => ({
  fetchDashboard: vi.fn(),
  fetchMonitorActivity: vi.fn(),
}));

// The market overview reads its own endpoint. Mocked here so the page's tests stay about the page.
vi.mock("../../market/api/market-api", () => ({
  fetchMarketOverview: vi.fn(),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const fetchDashboardMock = vi.mocked(fetchDashboard);
const fetchActivityMock = vi.mocked(fetchMonitorActivity);
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

function event(
  overrides: Partial<DashboardActivityEventResponse> = {},
): DashboardActivityEventResponse {
  return {
    id: "event-1",
    kind: "ACTIVATED",
    reason: "CONDITIONS_MET",
    sessionDate: "2026-10-13",
    security: {
      id: "sec-aapl",
      symbol: "AAPL",
      name: "Apple Inc.",
      exchangeCode: "NASDAQ",
    },
    levelKind: "BUY",
    levelIndex: 1,
    levelPercentage: 100,
    monitor: {
      id: "monitor-a",
      name: "S&P Value & Trend",
      ownership: "SYSTEM",
    },
    strategy: { id: "strategy-a", name: "Value & Trend" },
    stockList: { id: "list-a", name: "S&P 500 Growth Leaders" },
    signalId: "signal-1",
    price: 210.5,
    observationBasis: "EOD_CLOSE",
    why: {
      basis: "EVIDENCE",
      sessionDate: "2026-10-13",
      rules: [
        {
          predicates: [
            {
              role: "CONDITION",
              description: "Price is above SMA 200D",
              result: "TRUE",
              metric: 210.5,
              value: 198.4,
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

const EVENTS: DashboardActivityEventResponse[] = [
  event(),
  event({
    id: "event-2",
    kind: "RESOLVED",
    reason: "CONDITIONS_ENDED",
    sessionDate: "2026-10-12",
    security: {
      id: "sec-rop",
      symbol: "ROP",
      name: "Roper",
      exchangeCode: "NASDAQ",
    },
    monitor: {
      id: "monitor-b",
      name: "Nasdaq Trend Confirmation",
      ownership: "SYSTEM",
    },
    why: {
      basis: "EVIDENCE",
      sessionDate: "2026-10-12",
      rules: [
        {
          predicates: [
            {
              role: "CONDITION",
              description: "Price is above SMA 200D",
              result: "FALSE",
              metric: 95,
              value: 100,
            },
          ],
        },
      ],
    },
  }),
];

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
      }),
    ],
    rows: [],
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
  fetchMarketOverviewMock.mockResolvedValue(marketOverviewFixture());
  fetchDashboardMock.mockResolvedValue(dashboard());
  fetchActivityMock.mockResolvedValue({
    viewer: "GUEST",
    generatedAt: new Date().toISOString(),
    events: EVENTS,
  });
});

describe("DashboardPage", () => {
  it("lists observed activity newest session first, one row per event", async () => {
    render(<DashboardPage />);
    const rows = within(
      await screen.findByTestId("dashboard-activity"),
    ).getAllByTestId("dashboard-activity-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("Buy 1")).toBeDefined();
    expect(within(rows[0]!).getByText("Activated")).toBeDefined();
    expect(within(rows[0]!).getByTestId("dashboard-session").textContent).toBe(
      "Oct 13, 2026",
    );
    expect(rows[0]!.textContent).toMatch(/\$210\.50/);
    expect(
      within(rows[1]!).getByText("Ended · conditions no longer hold"),
    ).toBeDefined();
    // An ending is explained by its Why, not by the price it activated at.
    expect(rows[1]!.textContent).not.toMatch(/\$210\.50/);
    expect(fetchActivityMock).toHaveBeenCalledWith(
      { limit: 15 },
      expect.anything(),
    );
  });

  it("explains each event with the values that decided it", async () => {
    render(<DashboardPage />);
    const rows = within(
      await screen.findByTestId("dashboard-activity"),
    ).getAllByTestId("dashboard-activity-row");
    expect(within(rows[0]!).getByTestId("dashboard-why").textContent).toContain(
      "Price is above SMA 200D (210.50 vs 198.40)",
    );
    expect(within(rows[1]!).getByTestId("dashboard-why").textContent).toContain(
      "did not hold",
    );
  });

  it("shows exactly the agreed columns, and no per-row Backtest", async () => {
    render(<DashboardPage />);
    const table = await screen.findByTestId("dashboard-activity");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Stock", "Signal", "Session", "Why", "Price", "Monitor"]);
    expect(within(table).queryByRole("link", { name: "Backtest" })).toBeNull();
  });

  it("links the stock and the monitor that observed it", async () => {
    render(<DashboardPage />);
    const row = within(
      await screen.findByTestId("dashboard-activity"),
    ).getAllByTestId("dashboard-activity-row")[0]!;
    expect(
      within(row).getByRole("link", { name: /AAPL/ }).getAttribute("href"),
    ).toBe("/stocks/AAPL");
    expect(
      within(row)
        .getAllByRole("link", { name: "S&P Value & Trend" })[0]!
        .getAttribute("href"),
    ).toBe("/monitors/monitor-a");
  });

  it("narrows the feed to one monitor", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    await user.selectOptions(
      screen.getByTestId("dashboard-monitor-filter"),
      "monitor-b",
    );
    await waitFor(() =>
      expect(fetchActivityMock).toHaveBeenLastCalledWith(
        { monitorId: "monitor-b", limit: 15 },
        expect.anything(),
      ),
    );
  });

  it("loads older activity on request", async () => {
    const user = userEvent.setup();
    fetchActivityMock
      .mockResolvedValueOnce({
        viewer: "GUEST",
        generatedAt: new Date().toISOString(),
        events: [EVENTS[0]!],
        nextCursor: "cursor-1",
      })
      .mockResolvedValueOnce({
        viewer: "GUEST",
        generatedAt: new Date().toISOString(),
        events: [EVENTS[1]!],
      });
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    await user.click(screen.getByTestId("dashboard-activity-more"));
    await waitFor(() =>
      expect(screen.getAllByTestId("dashboard-activity-row")).toHaveLength(2),
    );
    expect(fetchActivityMock).toHaveBeenLastCalledWith({
      limit: 15,
      cursor: "cursor-1",
    });
    expect(screen.queryByTestId("dashboard-activity-more")).toBeNull();
  });

  it("marks an event the earlier live-quote monitor recorded, quietly", async () => {
    fetchActivityMock.mockResolvedValue({
      viewer: "GUEST",
      generatedAt: new Date().toISOString(),
      events: [event({ observationBasis: "LIVE_QUOTE" })],
    });
    render(<DashboardPage />);
    const row = (await screen.findAllByTestId("dashboard-activity-row"))[0]!;
    expect(within(row).getByTestId("dashboard-session").textContent).toBe(
      "Oct 13, 2026 · intraday quote",
    );
  });

  it("carries no monitor configuration: that lives with the monitors", async () => {
    signedIn();
    fetchDashboardMock.mockResolvedValue(
      dashboard({ viewer: "AUTHENTICATED" }),
    );
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");

    expect(screen.queryByTestId("dashboard-monitors")).toBeNull();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByTestId("dashboard-guest-notice")).toBeNull();
  });

  it("invites a Guest in without redirecting them anywhere", async () => {
    render(<DashboardPage />);
    const notice = await screen.findByTestId("dashboard-guest-notice");
    expect(notice.textContent).toMatch(
      /^A Monitor watches a List using a Strategy\. You're viewing FactorSage's built-in monitors\./,
    );
    expect(
      within(notice)
        .getByRole("link", { name: "Sign in" })
        .getAttribute("href"),
    ).toBe("/login");
    expect(await screen.findAllByTestId("dashboard-activity-row")).toHaveLength(
      2,
    );
  });

  it("presents stale evaluations honestly", async () => {
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

  it("explains an empty feed, and recovers from a failed load", async () => {
    const user = userEvent.setup();
    fetchActivityMock.mockRejectedValueOnce(new Error("offline"));
    fetchActivityMock.mockResolvedValueOnce({
      viewer: "GUEST",
      generatedAt: new Date().toISOString(),
      events: [],
    });
    render(<DashboardPage />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    const empty = await screen.findByTestId("dashboard-activity-empty");
    expect(within(empty).getByText("No activity yet")).toBeDefined();
  });

  it("sends a viewer who hid every monitor to the page that can bring one back", async () => {
    fetchDashboardMock.mockResolvedValue(
      dashboard({ monitors: [monitor({ visible: false })] }),
    );
    fetchActivityMock.mockResolvedValue({
      viewer: "GUEST",
      generatedAt: new Date().toISOString(),
      events: [],
    });
    render(<DashboardPage />);
    const empty = await screen.findByTestId("dashboard-activity-empty");
    expect(within(empty).getByText("No monitors are shown")).toBeDefined();
    expect(
      within(empty)
        .getByRole("link", { name: "Go to monitors" })
        .getAttribute("href"),
    ).toBe("/monitors");
  });

  it("puts the market overview above the activity, with no summary card above either", async () => {
    render(<DashboardPage />);
    const market = await screen.findByTestId("market-overview");
    const activity = await screen.findByTestId("dashboard-activity");
    expect(
      market.compareDocumentPosition(activity) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByTestId("dashboard-overview")).toBeNull();
    expect(screen.queryByText("Current matches")).toBeNull();
    expect(screen.getAllByText("Monitor activity").length).toBeGreaterThan(0);
  });

  it("never describes anything on the Dashboard as fear and greed, or as live", async () => {
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    await screen.findByTestId("market-overview-row-SPY");
    const page = screen.getByTestId("dashboard-page");
    expect(page.textContent).not.toMatch(/fear|greed/i);
    expect(page.textContent).not.toMatch(/\blive\b|real-time/i);
  });

  it("opens on the content, not on a card introducing itself", async () => {
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Dashboard",
    ]);
    const page = screen.getByTestId("dashboard-page");
    expect(page.firstElementChild?.tagName).toBe("H1");
    expect(page.children[1]).toBe(screen.getByTestId("market-overview"));
  });

  it("keeps the freshness fact beside the activity it describes", async () => {
    render(<DashboardPage />);
    const freshness = await screen.findByTestId("dashboard-freshness");
    expect(freshness.textContent).toBe("Updated 3 min ago");
    const section = screen.getByTestId("dashboard-activity").closest("section");
    expect(section?.contains(freshness)).toBe(true);
  });

  it("composes the phone card as identity, one summary line, why, then the monitor", async () => {
    render(<DashboardPage />);
    const row = within(
      await screen.findByTestId("dashboard-activity"),
    ).getAllByTestId("dashboard-activity-row")[0]!;
    const roleOf = (index: number) =>
      row.querySelector(`td:nth-child(${index})`)?.getAttribute("data-card");
    expect(roleOf(1)).toBe("identity");
    expect(roleOf(2)).toBe("status");
    expect(roleOf(3)).toBe("summary");
    expect(roleOf(5)).toBe("summary");
    expect(roleOf(6)).toBe("hidden");
    const why = row.querySelector<HTMLElement>('td[data-stacked="true"]')!;
    expect(why.textContent).toMatch(/Price is above SMA 200D/);
    const origin = within(why).getByTestId("dashboard-card-monitor");
    expect(origin.textContent).toBe("MonitorS&P Value & Trend");
  });
});

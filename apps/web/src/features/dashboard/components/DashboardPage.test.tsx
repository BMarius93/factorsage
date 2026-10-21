import type {
  DashboardActivityEventResponse,
  DashboardActivityResponse,
  DashboardMonitorResponse,
  DashboardResponse,
} from "@intrinsic/contracts";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFakeViewport,
  type FakeViewport,
} from "../../../lib/__testing__/fake-viewport";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { marketOverviewFixture } from "../../market/__testing__/market-overview";
import { fetchMarketOverview } from "../../market/api/market-api";
import { MARKET_WATCH_ROTATION_MS } from "../../market/hooks/use-period-rotation";
import { fetchDashboard, fetchMonitorActivity } from "../api/dashboard-api";
import { DashboardPage, newActivityLabel } from "./DashboardPage";

vi.mock("../api/dashboard-api", () => ({
  fetchDashboard: vi.fn(),
  fetchMonitorActivity: vi.fn(),
}));

// Market watch reads its own endpoint. Mocked here so the page's tests stay about the page.
vi.mock("../../market/api/market-api", () => ({
  fetchMarketOverview: vi.fn(),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

// Counts how often the page hands the feed its rows: once per render of the page itself, so a
// Market watch rotation that re-rendered the page would show up here.
const feedRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./ActivityFeed", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ActivityFeed")>();
  return {
    ...actual,
    ActivityFeed: (props: Parameters<typeof actual.ActivityFeed>[0]) => {
      feedRenders.count += 1;
      return <actual.ActivityFeed {...props} />;
    },
  };
});

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
            {
              role: "CONDITION",
              description: "RSI 14D is below 55",
              result: "TRUE",
              metric: 42.5,
              value: 55,
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

const ENDED_SELL = event({
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
  levelKind: "SELL",
  levelIndex: 2,
  levelPercentage: 50,
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
});

const EVENTS: DashboardActivityEventResponse[] = [event(), ENDED_SELL];

function page(
  events: DashboardActivityEventResponse[],
  nextCursor?: string,
): DashboardActivityResponse {
  return {
    viewer: "GUEST",
    generatedAt: new Date().toISOString(),
    events,
    ...(nextCursor ? { nextCursor } : {}),
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

async function rows(): Promise<HTMLElement[]> {
  return within(await screen.findByTestId("dashboard-activity")).getAllByTestId(
    "dashboard-activity-row",
  );
}

function sessions(): { date: string; ids: string[] }[] {
  return screen.getAllByTestId("dashboard-session-group").map((group) => ({
    date: within(group).getByTestId("dashboard-session").textContent ?? "",
    ids: within(group)
      .getAllByTestId("dashboard-activity-row")
      .map((row) => row.getAttribute("data-event-id") ?? ""),
  }));
}

let viewport: FakeViewport;

beforeEach(() => {
  vi.clearAllMocks();
  feedRenders.count = 0;
  // A wide desktop unless a test says otherwise: Market watch beside the feed.
  viewport = installFakeViewport({ width: 1440 });
  signedOut();
  fetchMarketOverviewMock.mockResolvedValue(marketOverviewFixture());
  fetchDashboardMock.mockResolvedValue(dashboard());
  fetchActivityMock.mockResolvedValue(page(EVENTS));
});

afterEach(() => {
  viewport.restore();
  vi.useRealTimers();
});

describe("DashboardPage — the Monitor activity feed", () => {
  it("groups observed activity under its market session, newest first, one row per event", async () => {
    render(<DashboardPage />);
    expect(await rows()).toHaveLength(2);
    expect(sessions()).toEqual([
      { date: "October 13, 2026", ids: ["event-1"] },
      { date: "October 12, 2026", ids: ["event-2"] },
    ]);
    // The session is written once, on its heading, as the exchange session it is.
    expect(
      screen.getAllByTestId("dashboard-session")[0]!.getAttribute("dateTime"),
    ).toBe("2026-10-13");
    expect(fetchActivityMock).toHaveBeenCalledWith(
      { limit: 15 },
      expect.anything(),
    );
  });

  it("names the level without its step, and keeps the step's identity on the event", async () => {
    render(<DashboardPage />);
    const [buy, sell] = await rows();
    expect(within(buy!).getByTestId("dashboard-event-level").textContent).toBe(
      "Buy",
    );
    expect(within(sell!).getByTestId("dashboard-event-level").textContent).toBe(
      "Sell",
    );
    expect(buy!.textContent).not.toMatch(/Buy 1|Buy\s*1\b/);
    expect(sell!.textContent).not.toMatch(/Sell 2/);
    // The step is presentation's to drop, not the event's.
    expect(buy!.getAttribute("data-level")).toBe("BUY");
    expect(buy!.getAttribute("data-level-index")).toBe("1");
    expect(sell!.getAttribute("data-level")).toBe("SELL");
    expect(sell!.getAttribute("data-level-index")).toBe("2");
  });

  it("keeps two steps of one stock on one session under one Monitor as two events", async () => {
    fetchActivityMock.mockResolvedValue(
      page([
        event({ id: "buy-2", levelIndex: 2, levelPercentage: 50 }),
        event({ id: "buy-1", levelIndex: 1 }),
      ]),
    );
    render(<DashboardPage />);
    const shown = await rows();
    expect(shown.map((row) => row.getAttribute("data-event-id"))).toEqual([
      "buy-2",
      "buy-1",
    ]);
    expect(shown.map((row) => row.getAttribute("data-level-index"))).toEqual([
      "2",
      "1",
    ]);
    // Same visible label, same session heading, still two rows.
    expect(
      shown.map(
        (row) => within(row).getByTestId("dashboard-event-level").textContent,
      ),
    ).toEqual(["Buy", "Buy"]);
    expect(sessions()).toHaveLength(1);
  });

  it("says Activated or Ended from the event itself, never from its level or a colour", async () => {
    render(<DashboardPage />);
    const [buy, sell] = await rows();
    const state = (row: HTMLElement) =>
      within(row).getByTestId("dashboard-event-state");
    expect(state(buy!).textContent).toBe("Activated");
    expect(state(buy!).getAttribute("data-kind")).toBe("ACTIVATED");
    expect(state(sell!).textContent).toBe("Ended");
    expect(state(sell!).getAttribute("data-kind")).toBe("RESOLVED");
  });

  it("keeps the level and the state independent: an activated Sell, an ended Buy", async () => {
    fetchActivityMock.mockResolvedValue(
      page([
        event({ id: "sell-on", levelKind: "SELL", levelIndex: 1 }),
        event({
          id: "buy-off",
          kind: "RESOLVED",
          reason: "CONDITIONS_ENDED",
        }),
      ]),
    );
    render(<DashboardPage />);
    const [sellOn, buyOff] = await rows();
    expect(
      [sellOn!, buyOff!].map((row) => [
        within(row).getByTestId("dashboard-event-level").textContent,
        within(row).getByTestId("dashboard-event-state").textContent,
      ]),
    ).toEqual([
      ["Sell", "Activated"],
      ["Buy", "Ended"],
    ]);
    // The level's ink is the level's; the ending carries no tone of its own.
    expect(
      within(sellOn!)
        .getByTestId("dashboard-event-level")
        .getAttribute("data-tone"),
    ).toBe("negative");
    expect(
      within(buyOff!)
        .getByTestId("dashboard-event-level")
        .getAttribute("data-tone"),
    ).toBe("positive");
    expect(
      within(buyOff!)
        .getByTestId("dashboard-event-state")
        .getAttribute("data-tone"),
    ).toBeNull();
  });

  it("shows exactly three columns — no Price and no Monitor column — and no standalone price", async () => {
    render(<DashboardPage />);
    const table = await screen.findByTestId("dashboard-activity");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Stock", "Signal", "Conditions"]);
    // $210.50 was the activation price. It is gone as a figure of its own …
    expect(table.textContent).not.toMatch(/\$210\.50/);
    expect(table.textContent).not.toMatch(/\$/);
    // … and stays where a condition compared it.
    const [buy] = await rows();
    expect(
      within(buy!)
        .getAllByTestId("dashboard-condition-values")
        .map((value) => value.textContent),
    ).toEqual(["210.50 > 198.40", "42.50 < 55.00"]);
    expect(within(table).queryByRole("link", { name: "Backtest" })).toBeNull();
  });

  it("names the Monitor on every event, linked to its page, and links the stock", async () => {
    render(<DashboardPage />);
    const [buy, sell] = await rows();
    expect(
      within(buy!).getByRole("link", { name: /AAPL/ }).getAttribute("href"),
    ).toBe("/stocks/AAPL");
    expect(
      within(within(buy!).getByTestId("dashboard-event-monitor"))
        .getByRole("link", { name: "S&P Value & Trend" })
        .getAttribute("href"),
    ).toBe("/monitors/monitor-a");
    expect(
      within(sell!).getByTestId("dashboard-event-monitor").textContent,
    ).toBe("Monitor: Nasdaq Trend Confirmation");
  });

  it("shows every condition of every event with its result", async () => {
    render(<DashboardPage />);
    const [buy, sell] = await rows();
    expect(
      within(buy!)
        .getAllByTestId("dashboard-condition")
        .map((line) => [
          line.getAttribute("data-result"),
          within(line).getByTestId("dashboard-condition-expression")
            .textContent,
        ]),
    ).toEqual([
      ["TRUE", "Price is above SMA 200D"],
      ["TRUE", "RSI 14D is below 55"],
    ]);
    // An ended event keeps its marks: the ✕ is what ended it.
    const [failed] = within(sell!).getAllByTestId("dashboard-condition");
    expect(failed!.getAttribute("data-result")).toBe("FALSE");
    expect(failed!.textContent).toContain("95.00 < 100.00");
  });

  it("marks an event the earlier live-quote monitor recorded, quietly", async () => {
    fetchActivityMock.mockResolvedValue(
      page([event({ observationBasis: "LIVE_QUOTE" })]),
    );
    render(<DashboardPage />);
    const [row] = await rows();
    expect(within(row!).getByTestId("dashboard-event-basis").textContent).toBe(
      "Intraday quote",
    );
  });

  it("opens Stock Details from a click anywhere on the row that is not a control", async () => {
    render(<DashboardPage />);
    const [row] = await rows();
    const link = within(row!).getByRole("link", { name: /AAPL/ });
    const followed = vi.fn((click: Event) => click.preventDefault());
    link.addEventListener("click", followed);
    await userEvent
      .setup()
      .click(within(row!).getByTestId("dashboard-event-state"));
    expect(followed).toHaveBeenCalledTimes(1);
  });
});

describe("DashboardPage — filters and pages", () => {
  it("offers both filters, with every shown Monitor by its stable id", async () => {
    render(<DashboardPage />);
    await rows();
    const monitorFilter = screen.getByTestId(
      "dashboard-monitor-filter",
    ) as HTMLSelectElement;
    expect(
      [...monitorFilter.options].map((option) => [option.value, option.text]),
    ).toEqual([
      ["ALL", "All monitors"],
      ["monitor-a", "S&P Value & Trend"],
      ["monitor-b", "Nasdaq Trend Confirmation"],
    ]);
    const eventFilter = screen.getByTestId(
      "dashboard-event-filter",
    ) as HTMLSelectElement;
    expect(
      [...eventFilter.options].map((option) => [option.value, option.text]),
    ).toEqual([
      ["ALL", "All events"],
      ["ACTIVATED", "Activated"],
      ["RESOLVED", "Ended"],
    ]);
  });

  it("asks the API for one Monitor, one kind, and both at once", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await rows();

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

    await user.selectOptions(
      screen.getByTestId("dashboard-event-filter"),
      "ACTIVATED",
    );
    await waitFor(() =>
      expect(fetchActivityMock).toHaveBeenLastCalledWith(
        { monitorId: "monitor-b", kind: "ACTIVATED", limit: 15 },
        expect.anything(),
      ),
    );

    await user.selectOptions(
      screen.getByTestId("dashboard-monitor-filter"),
      "ALL",
    );
    await waitFor(() =>
      expect(fetchActivityMock).toHaveBeenLastCalledWith(
        { kind: "ACTIVATED", limit: 15 },
        expect.anything(),
      ),
    );
  });

  it("pages the filtered feed, not the loaded rows", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await rows();
    fetchActivityMock.mockResolvedValueOnce(page([ENDED_SELL], "cursor-r1"));
    await user.selectOptions(
      screen.getByTestId("dashboard-event-filter"),
      "RESOLVED",
    );
    await waitFor(async () => expect(await rows()).toHaveLength(1));

    fetchActivityMock.mockResolvedValueOnce(
      page([
        event({ id: "event-0", kind: "RESOLVED", sessionDate: "2026-10-01" }),
      ]),
    );
    await user.click(screen.getByTestId("dashboard-activity-more"));
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    expect(fetchActivityMock).toHaveBeenLastCalledWith({
      kind: "RESOLVED",
      limit: 15,
      cursor: "cursor-r1",
    });
  });

  it("explains a filter that matches nothing and offers to clear both", async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);
    await rows();
    fetchActivityMock.mockResolvedValue(page([]));
    await user.selectOptions(
      screen.getByTestId("dashboard-monitor-filter"),
      "monitor-a",
    );
    await user.selectOptions(
      screen.getByTestId("dashboard-event-filter"),
      "RESOLVED",
    );
    const empty = await screen.findByTestId("dashboard-activity-empty");
    expect(within(empty).getByText("No matching activity")).toBeDefined();

    fetchActivityMock.mockResolvedValue(page(EVENTS));
    await user.click(within(empty).getByTestId("dashboard-clear-filters"));
    await waitFor(() =>
      expect(fetchActivityMock).toHaveBeenLastCalledWith(
        { limit: 15 },
        expect.anything(),
      ),
    );
    expect(await rows()).toHaveLength(2);
    expect(
      (screen.getByTestId("dashboard-monitor-filter") as HTMLSelectElement)
        .value,
    ).toBe("ALL");
    expect(
      (screen.getByTestId("dashboard-event-filter") as HTMLSelectElement).value,
    ).toBe("ALL");
  });

  it("continues a session across a page boundary under one heading", async () => {
    const user = userEvent.setup();
    fetchActivityMock
      .mockResolvedValueOnce(
        page(
          [event({ id: "e3" }), event({ id: "e2", sessionDate: "2026-10-12" })],
          "cursor-1",
        ),
      )
      .mockResolvedValueOnce(
        page([
          event({ id: "e1", sessionDate: "2026-10-12" }),
          event({ id: "e0", sessionDate: "2026-10-09" }),
        ]),
      );
    render(<DashboardPage />);
    await rows();
    await user.click(screen.getByTestId("dashboard-activity-more"));
    await waitFor(async () => expect(await rows()).toHaveLength(4));
    expect(sessions()).toEqual([
      { date: "October 13, 2026", ids: ["e3"] },
      { date: "October 12, 2026", ids: ["e2", "e1"] },
      { date: "October 9, 2026", ids: ["e0"] },
    ]);
    expect(fetchActivityMock).toHaveBeenLastCalledWith({
      limit: 15,
      cursor: "cursor-1",
    });
    expect(screen.queryByTestId("dashboard-activity-more")).toBeNull();
  });

  it("pauses on older activity and returns to the newest events on request (DB-2)", async () => {
    const user = userEvent.setup();
    fetchActivityMock
      .mockResolvedValueOnce(page([EVENTS[0]!], "cursor-1"))
      .mockResolvedValueOnce(page([EVENTS[1]!]));
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    expect(screen.queryByTestId("dashboard-activity-paused")).toBeNull();

    await user.click(screen.getByTestId("dashboard-activity-more"));
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    const paused = screen.getByTestId("dashboard-activity-paused");
    expect(within(paused).getByRole("status").textContent).toBe(
      "Updates are paused while you read older activity.",
    );

    fetchActivityMock.mockResolvedValueOnce(page([EVENTS[0]!], "cursor-1"));
    await user.click(screen.getByTestId("dashboard-activity-show-newest"));
    await waitFor(async () => expect(await rows()).toHaveLength(1));
    expect(screen.queryByTestId("dashboard-activity-paused")).toBeNull();
    expect(fetchActivityMock).toHaveBeenLastCalledWith(
      { limit: 15 },
      expect.anything(),
    );
    // The button that asked is gone; focus lands on the newest event instead of on <body>.
    await waitFor(() =>
      expect(document.activeElement?.closest("tbody")).not.toBeNull(),
    );
  });
});

describe("DashboardPage — states", () => {
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
    expect(await rows()).toHaveLength(2);
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

  it("keeps the freshness fact beside the heading of the activity it describes", async () => {
    render(<DashboardPage />);
    const freshness = await screen.findByTestId("dashboard-freshness");
    expect(freshness.textContent).toBe("Updated 3 min ago");
    const section = screen.getByTestId("dashboard-activity-section");
    expect(section.contains(freshness)).toBe(true);
    expect(section.contains(screen.getByTestId("dashboard-activity"))).toBe(
      true,
    );
  });

  it("shows a loading state, then the feed", async () => {
    let resolve: (value: DashboardActivityResponse) => void = () => undefined;
    fetchActivityMock.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<DashboardPage />);
    expect(
      await screen.findByTestId("dashboard-activity-loading"),
    ).toBeDefined();
    await act(async () => {
      resolve(page(EVENTS));
      await Promise.resolve();
    });
    expect(await rows()).toHaveLength(2);
    expect(screen.queryByTestId("dashboard-activity-loading")).toBeNull();
  });

  it("explains an empty feed, and recovers from a failed load", async () => {
    const user = userEvent.setup();
    fetchActivityMock.mockRejectedValueOnce(new Error("offline"));
    fetchActivityMock.mockResolvedValueOnce(page([]));
    render(<DashboardPage />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    const empty = await screen.findByTestId("dashboard-activity-empty");
    expect(within(empty).getByText("No activity yet")).toBeDefined();
  });

  it("sends a viewer who hid every monitor to the page that can bring one back", async () => {
    fetchDashboardMock.mockResolvedValue(
      dashboard({ monitors: [monitor({ visible: false })] }),
    );
    fetchActivityMock.mockResolvedValue(page([]));
    render(<DashboardPage />);
    const empty = await screen.findByTestId("dashboard-activity-empty");
    expect(within(empty).getByText("No monitors are shown")).toBeDefined();
    expect(
      within(empty)
        .getByRole("link", { name: "Go to monitors" })
        .getAttribute("href"),
    ).toBe("/monitors");
    expect(screen.queryByTestId("dashboard-filters")).toBeNull();
  });

  it("never describes anything on the Dashboard as fear and greed, or as live", async () => {
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    await screen.findByTestId("market-watch-row-SPY");
    const dashboardPage = screen.getByTestId("dashboard-page");
    expect(dashboardPage.textContent).not.toMatch(/fear|greed/i);
    expect(dashboardPage.textContent).not.toMatch(/\blive\b|real-time/i);
  });
});

describe("DashboardPage — layout and Market watch", () => {
  it("puts Market watch beside the activity on a wide desktop, as a sidebar after the feed", async () => {
    render(<DashboardPage />);
    const activity = await screen.findByTestId("dashboard-activity");
    const watch = await screen.findByTestId("market-watch");
    // The feed first in reading order, then the sidebar.
    expect(
      activity.compareDocumentPosition(watch) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByTestId("dashboard-main").contains(activity)).toBe(true);
    const sidebar = screen.getByTestId("dashboard-sidebar");
    expect(sidebar.contains(watch)).toBe(true);
    expect(sidebar.tagName).toBe("ASIDE");
    expect(screen.getByRole("complementary", { name: "Market watch" })).toBe(
      sidebar,
    );
    expect(screen.queryByTestId("market-overview")).toBeNull();
    expect(screen.queryByText("Current matches")).toBeNull();
  });

  it("opens on the content, not on a card introducing itself", async () => {
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Dashboard",
    ]);
    const dashboardPage = screen.getByTestId("dashboard-page");
    expect(dashboardPage.firstElementChild?.tagName).toBe("H1");
    expect(dashboardPage.children[1]).toBe(
      screen.getByTestId("dashboard-layout"),
    );
    // The feed's column opens with the Guest's invitation, then the activity itself.
    const main = screen.getByTestId("dashboard-main");
    expect(main.children[0]).toBe(screen.getByTestId("dashboard-guest-notice"));
    expect(main.children[1]?.querySelector("#activity-title")).not.toBeNull();
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Monitor activity", "Market watch"]);
  });

  it("keeps the whole feed on a phone, conditions included, with no Market watch", async () => {
    viewport.resize(390);
    render(<DashboardPage />);
    const [buy] = await rows();
    expect(within(buy!).getAllByTestId("dashboard-condition")).toHaveLength(2);
    expect(screen.getByTestId("dashboard-event-filter")).toBeDefined();
    expect(screen.queryByTestId("dashboard-sidebar")).toBeNull();
    expect(screen.queryByTestId("market-watch")).toBeNull();
  });

  it("neither mounts Market watch nor asks for market data below 1,280px", async () => {
    for (const width of [360, 390, 768, 1024, 1199, 1279]) {
      viewport.resize(width);
      const { unmount } = render(<DashboardPage />);
      await screen.findByTestId("dashboard-activity");
      expect(
        screen.queryByTestId("dashboard-sidebar"),
        `${width}px`,
      ).toBeNull();
      expect(screen.queryByTestId("market-watch"), `${width}px`).toBeNull();
      unmount();
    }
    expect(fetchMarketOverviewMock).not.toHaveBeenCalled();
  });

  it("mounts Market watch when the window widens to 1,280px and removes it, timer and all, below", async () => {
    viewport.resize(1279);
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    expect(fetchMarketOverviewMock).not.toHaveBeenCalled();

    viewport.resize(1280);
    await screen.findByTestId("market-watch-row-SPY");
    expect(fetchMarketOverviewMock).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    viewport.resize(1279);
    expect(screen.queryByTestId("market-watch")).toBeNull();
    // The feed is untouched by the sidebar leaving.
    expect(
      within(screen.getByTestId("dashboard-activity")).getAllByTestId(
        "dashboard-activity-row",
      ),
    ).toHaveLength(EVENTS.length);
    // Only the page's own timers remain: the clock and the feed's refresh, never the rotation.
    const timers = vi.getTimerCount();
    act(() => {
      vi.advanceTimersByTime(MARKET_WATCH_ROTATION_MS);
    });
    expect(vi.getTimerCount()).toBe(timers);
  });

  it("keeps the feed when Market watch cannot load", async () => {
    fetchMarketOverviewMock.mockRejectedValue(new Error("market down"));
    render(<DashboardPage />);

    expect(await screen.findByTestId("market-watch-error")).toBeTruthy();
    expect(await rows()).toHaveLength(EVENTS.length);
  });

  it("does not re-render Market watch when the feed changes", async () => {
    render(<DashboardPage />);
    await screen.findByTestId("market-watch-row-SPY");
    const row = screen.getByTestId("market-watch-row-SPY");
    fetchActivityMock.mockResolvedValue(
      page([event({ id: "event-9" }), ...EVENTS]),
    );
    await userEvent
      .setup()
      .selectOptions(
        screen.getByTestId("dashboard-monitor-filter"),
        "monitor-b",
      );
    await waitFor(() => expect(fetchActivityMock).toHaveBeenCalledTimes(2));
    // The same node: the sidebar's rows were not rebuilt by the feed's change.
    expect(screen.getByTestId("market-watch-row-SPY")).toBe(row);
    expect(fetchMarketOverviewMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-render Monitor activity, or read anything, as Market watch rotates", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    render(<DashboardPage />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("market-watch-row-SPY")).toBeTruthy();
    expect(
      within(screen.getByTestId("dashboard-activity")).getAllByTestId(
        "dashboard-activity-row",
      ),
    ).toHaveLength(2);
    const feedRow = screen.getAllByTestId("dashboard-activity-row")[0];
    const renders = feedRenders.count;
    const reads = fetchActivityMock.mock.calls.length;

    // Three full rotations, inside the page's own 30-second clock tick.
    for (let step = 0; step < 3; step += 1) {
      act(() => {
        vi.advanceTimersByTime(MARKET_WATCH_ROTATION_MS);
      });
    }
    expect(screen.getByTestId("market-watch").getAttribute("data-period")).toBe(
      "6M",
    );
    expect(feedRenders.count).toBe(renders);
    expect(screen.getAllByTestId("dashboard-activity-row")[0]).toBe(feedRow);
    expect(fetchActivityMock.mock.calls.length).toBe(reads);
    expect(fetchMarketOverviewMock).toHaveBeenCalledTimes(1);
  });
});

describe("newActivityLabel (DB-2)", () => {
  it("states an exact count, says only that something arrived when the count is unknown, and otherwise that updates are paused", () => {
    expect(newActivityLabel({ count: 1 })).toBe("1 new event");
    expect(newActivityLabel({ count: 4 })).toBe("4 new events");
    expect(newActivityLabel({ count: null })).toBe("New events are available.");
    expect(newActivityLabel(null)).toBe(
      "Updates are paused while you read older activity.",
    );
  });
});

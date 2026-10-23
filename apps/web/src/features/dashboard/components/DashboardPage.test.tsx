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
import { DASHBOARD_REFRESH_MS } from "../hooks/use-dashboard";
import { DashboardPage, arrivalsLabel } from "./DashboardPage";

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
    enabled: true,
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
    fromHistory: false,
    recordedAt: "2026-10-13T22:05:00.000Z",
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

/** Runs the Dashboard's slow refresh timers now, as a minute passing would. */
async function minutePasses(spy: {
  readonly mock: { readonly calls: readonly (readonly unknown[])[] };
}) {
  const timers = spy.mock.calls
    .filter((call) => call[1] === DASHBOARD_REFRESH_MS)
    .map((call) => call[0] as () => void);
  await act(async () => {
    for (const timer of timers) timer();
    await Promise.resolve();
  });
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
      { limit: 25 },
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

  it("shows exactly four columns — Stock, Signal, Conditions, Monitor — and no standalone price", async () => {
    render(<DashboardPage />);
    const table = await screen.findByTestId("dashboard-activity");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["Stock", "Signal", "Conditions", "Monitor"]);
    // Every row has the four cells, in the headings' order, so they align down the table.
    for (const row of await rows()) {
      expect(
        [...row.querySelectorAll(":scope > td")].map((cell) =>
          cell.getAttribute("data-column"),
        ),
      ).toEqual(["stock", "signal", "conditions", "monitor"]);
    }
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

  it("names the Monitor in its own column as the product's reference pill, linked to its page", async () => {
    render(<DashboardPage />);
    const [buy, sell] = await rows();
    expect(
      within(buy!).getByRole("link", { name: /AAPL/ }).getAttribute("href"),
    ).toBe("/stocks/AAPL");
    const monitorCell = buy!.querySelector('td[data-column="monitor"]')!;
    expect(
      within(monitorCell as HTMLElement)
        .getByRole("link", { name: "S&P Value & Trend" })
        .getAttribute("href"),
    ).toBe("/monitors/monitor-a");
    expect(
      within(
        sell!.querySelector('td[data-column="monitor"]') as HTMLElement,
      ).getByRole("link", { name: "Nasdaq Trend Confirmation" }),
    ).toBeTruthy();
    // The same clickable pill Strategy and Stock List references use, the whole name in its title
    // for when a long one is clipped, and nothing about the Monitor left under the signal.
    const pill = within(monitorCell as HTMLElement).getByTestId(
      "dashboard-event-monitor-link",
    );
    expect(pill.getAttribute("data-kind")).toBe("monitor");
    expect(pill.getAttribute("title")).toBe("S&P Value & Trend");
    expect(pill.tagName).toBe("A");
    const signal = buy!.querySelector('td[data-column="signal"]')!;
    expect(signal.textContent).not.toContain("S&P Value & Trend");
    expect(signal.querySelector("a")).toBeNull();
    // The small label is for a stacked event only, and is not read twice.
    expect(
      within(buy!).getByTestId("dashboard-event-monitor").firstElementChild,
    ).toHaveProperty("ariaHidden", "true");
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

  it("marks an event found later as From history, under its own session", async () => {
    fetchActivityMock.mockResolvedValue(
      page([
        event({
          fromHistory: true,
          sessionDate: "2026-10-09",
          recordedAt: "2026-10-23T14:02:00.000Z",
        }),
        event({ id: "event-observed", sessionDate: "2026-10-08" }),
      ]),
    );
    render(<DashboardPage />);
    const [found, observed] = await rows();
    const mark = within(found!).getByTestId("dashboard-event-history");
    expect(mark.textContent).toBe("From history");
    // When it was found is said, apart from the session it happened on.
    expect(mark.getAttribute("title")).toMatch(/^Found on Oct 23, 2026/);
    expect(
      found!
        .closest('[data-testid="dashboard-session-group"]')
        ?.getAttribute("data-session"),
    ).toBe("2026-10-09");
    expect(
      within(observed!).queryByTestId("dashboard-event-history"),
    ).toBeNull();
    // No intraday label survives anywhere in the feed.
    expect(screen.queryByText("Intraday quote")).toBeNull();
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
        { monitorId: "monitor-b", limit: 25 },
        expect.anything(),
      ),
    );

    await user.selectOptions(
      screen.getByTestId("dashboard-event-filter"),
      "ACTIVATED",
    );
    await waitFor(() =>
      expect(fetchActivityMock).toHaveBeenLastCalledWith(
        { monitorId: "monitor-b", kind: "ACTIVATED", limit: 25 },
        expect.anything(),
      ),
    );

    await user.selectOptions(
      screen.getByTestId("dashboard-monitor-filter"),
      "ALL",
    );
    await waitFor(() =>
      expect(fetchActivityMock).toHaveBeenLastCalledWith(
        { kind: "ACTIVATED", limit: 25 },
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
    expect(fetchActivityMock).toHaveBeenLastCalledWith(
      {
        kind: "RESOLVED",
        limit: 25,
        cursor: "cursor-r1",
      },
      expect.anything(),
    );
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
        { limit: 25 },
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
    expect(fetchActivityMock).toHaveBeenLastCalledWith(
      {
        limit: 25,
        cursor: "cursor-1",
      },
      expect.anything(),
    );
    expect(screen.queryByTestId("dashboard-activity-more")).toBeNull();
  });

  it("places arrivals without replacing the older pages the reader opened, and goes to the newest on request (DB-2)", async () => {
    const user = userEvent.setup();
    const intervals = vi.spyOn(window, "setInterval");
    fetchActivityMock
      .mockResolvedValueOnce(page([EVENTS[0]!], "cursor-1"))
      .mockResolvedValueOnce(page([EVENTS[1]!]));
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    await user.click(screen.getByTestId("dashboard-activity-more"));
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    expect(screen.queryByTestId("dashboard-activity-arrivals")).toBeNull();

    // A minute later the held range reads with one new event and one written late for October 12.
    fetchActivityMock.mockResolvedValueOnce(
      page([
        event({ id: "event-new", sessionDate: "2026-10-14" }),
        EVENTS[0]!,
        event({ id: "event-late", sessionDate: "2026-10-12" }),
        EVENTS[1]!,
      ]),
    );
    const reads = fetchActivityMock.mock.calls.length;
    await minutePasses(intervals);
    const arrivals = await screen.findByTestId("dashboard-activity-arrivals");
    expect(within(arrivals).getByRole("status").textContent).toBe(
      "1 new event · 1 event added to an earlier session",
    );
    expect(fetchActivityMock).toHaveBeenLastCalledWith({ through: "event-2" });
    expect(fetchActivityMock.mock.calls.length).toBe(reads + 1);
    expect(sessions()).toEqual([
      { date: "October 14, 2026", ids: ["event-new"] },
      { date: "October 13, 2026", ids: ["event-1"] },
      { date: "October 12, 2026", ids: ["event-late", "event-2"] },
    ]);

    // Going to the newest reads nothing again: everything is already in place.
    await user.click(screen.getByTestId("dashboard-activity-show-newest"));
    expect(screen.queryByTestId("dashboard-activity-arrivals")).toBeNull();
    expect(fetchActivityMock.mock.calls.length).toBe(reads + 1);
    // The button that asked is gone; focus lands on the newest event instead of on <body>.
    await waitFor(() =>
      expect(document.activeElement?.closest("tbody")).not.toBeNull(),
    );
    intervals.mockRestore();
  });

  it("says when older activity could not be loaded, and tries it again on request", async () => {
    const user = userEvent.setup();
    fetchActivityMock
      .mockResolvedValueOnce(page([EVENTS[0]!], "cursor-1"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(page([EVENTS[1]!]));
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-activity");
    await user.click(screen.getByTestId("dashboard-activity-more"));
    const failed = await screen.findByTestId("dashboard-activity-more-failed");
    expect(failed.textContent).toBe("Older activity could not be loaded.");
    expect(screen.getByTestId("dashboard-activity-more").textContent).toBe(
      "Try again",
    );
    await user.click(screen.getByTestId("dashboard-activity-more"));
    await waitFor(async () => expect(await rows()).toHaveLength(2));
    expect(screen.queryByTestId("dashboard-activity-more-failed")).toBeNull();
  });

  it("reads the newest page again when the Monitors shown change, not on the first answer", async () => {
    const intervals = vi.spyOn(window, "setInterval");
    render(<DashboardPage />);
    await rows();
    const reads = fetchActivityMock.mock.calls.length;
    expect(reads).toBe(1);
    // Monitor B was hidden in another tab.
    fetchDashboardMock.mockResolvedValueOnce(
      dashboard({ monitors: [monitor()] }),
    );
    // The feed without Monitor B's events: what its newest page and any re-read now answer.
    fetchActivityMock.mockImplementation(async () => page([EVENTS[0]!]));
    await minutePasses(intervals);
    await waitFor(async () => expect(await rows()).toHaveLength(1));
    expect(fetchActivityMock).toHaveBeenLastCalledWith(
      { limit: 25 },
      expect.anything(),
    );
    intervals.mockRestore();
  });
});

describe("DashboardPage — older activity as the reader scrolls", () => {
  /**
   * A stand-in for the browser's `IntersectionObserver`: the test says when the marker at the end
   * of the feed comes within reach, as scrolling would.
   */
  class FakeObserver {
    static live: FakeObserver[] = [];
    constructor(
      private readonly callback: (
        entries: { isIntersecting: boolean }[],
      ) => void,
      readonly options: { rootMargin?: string },
    ) {}
    observe() {
      FakeObserver.live.push(this);
    }
    disconnect() {
      FakeObserver.live = FakeObserver.live.filter((item) => item !== this);
    }
    reach() {
      this.callback([{ isIntersecting: true }]);
    }
  }

  /** The reader scrolls near the end of the feed, once the marker is being watched again. */
  async function nearTheEnd() {
    await waitFor(() => expect(FakeObserver.live).toHaveLength(1));
    act(() => FakeObserver.live[0]!.reach());
  }

  beforeEach(() => {
    FakeObserver.live = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Page `n` of an endless feed: one event, and a cursor to the next page. */
  function pageOf(n: number) {
    return page(
      [event({ id: `e${n}`, sessionDate: "2026-10-13" })],
      `cursor-${n}`,
    );
  }

  it("loads older pages near the end, four of them, then asks with Show more activity", async () => {
    const user = userEvent.setup();
    fetchActivityMock.mockImplementation(async (query) =>
      pageOf(query?.cursor ? Number(query.cursor.slice(7)) + 1 : 1),
    );
    render(<DashboardPage />);
    await rows();
    // Watched 600px below what is on screen, so the next page is there before the reader is.
    await waitFor(() => expect(FakeObserver.live).toHaveLength(1));
    expect(FakeObserver.live[0]!.options.rootMargin).toBe("0px 0px 600px 0px");
    expect(screen.queryByTestId("dashboard-activity-more")).toBeNull();

    for (let older = 1; older <= 4; older += 1) {
      await nearTheEnd();
      await waitFor(async () => expect(await rows()).toHaveLength(older + 1));
    }
    // Four pages on their own; the fifth waits for the reader.
    await waitFor(() =>
      expect(screen.getByTestId("dashboard-activity-more").textContent).toBe(
        "Show more activity",
      ),
    );
    expect(screen.queryByTestId("dashboard-activity-autoload")).toBeNull();
    expect(FakeObserver.live).toHaveLength(0);
    // Each page was asked for once, in order: no page skipped, none read twice.
    expect(
      fetchActivityMock.mock.calls.map(([query]) => query?.cursor ?? null),
    ).toEqual([null, "cursor-1", "cursor-2", "cursor-3", "cursor-4"]);

    await user.click(screen.getByTestId("dashboard-activity-more"));
    await waitFor(async () => expect(await rows()).toHaveLength(6));
    expect(new Set((await rows()).map((row) => row.dataset.eventId)).size).toBe(
      6,
    );
  });

  it("starts the allowance again for another filter", async () => {
    const user = userEvent.setup();
    fetchActivityMock.mockImplementation(async (query) =>
      pageOf(query?.cursor ? Number(query.cursor.slice(7)) + 1 : 1),
    );
    render(<DashboardPage />);
    await rows();
    for (let older = 1; older <= 4; older += 1) {
      await nearTheEnd();
      await waitFor(async () => expect(await rows()).toHaveLength(older + 1));
    }
    await screen.findByTestId("dashboard-activity-more");

    await user.selectOptions(
      screen.getByTestId("dashboard-event-filter"),
      "ACTIVATED",
    );
    await waitFor(async () => expect(await rows()).toHaveLength(1));
    expect(screen.queryByTestId("dashboard-activity-more")).toBeNull();
    await nearTheEnd();
    await waitFor(async () => expect(await rows()).toHaveLength(2));
  });

  it("stops loading on its own after a failure, and offers to try again", async () => {
    const user = userEvent.setup();
    fetchActivityMock
      .mockResolvedValueOnce(pageOf(1))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(pageOf(2));
    render(<DashboardPage />);
    await rows();
    await nearTheEnd();

    const failed = await screen.findByTestId("dashboard-activity-more-failed");
    expect(failed.textContent).toBe("Older activity could not be loaded.");
    expect(FakeObserver.live).toHaveLength(0);
    await user.click(screen.getByTestId("dashboard-activity-more"));
    await waitFor(async () => expect(await rows()).toHaveLength(2));
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
    expect(
      within(empty).getByText("No activity in the last 30 days"),
    ).toBeDefined();
  });

  it("sends a viewer who disabled every monitor to the page that can enable one", async () => {
    fetchDashboardMock.mockResolvedValue(
      dashboard({ monitors: [monitor({ enabled: false })] }),
    );
    fetchActivityMock.mockResolvedValue(page([]));
    render(<DashboardPage />);
    const empty = await screen.findByTestId("dashboard-activity-empty");
    expect(within(empty).getByText("No monitors are enabled")).toBeDefined();
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

describe("arrivalsLabel (DB-2)", () => {
  it("counts what was placed exactly, and says only that more is available after a backlog", () => {
    expect(arrivalsLabel({ above: 1, within: 0, backlog: false })).toBe(
      "1 new event",
    );
    expect(arrivalsLabel({ above: 4, within: 0, backlog: false })).toBe(
      "4 new events",
    );
    expect(arrivalsLabel({ above: 0, within: 1, backlog: false })).toBe(
      "1 event added to an earlier session",
    );
    expect(arrivalsLabel({ above: 2, within: 3, backlog: false })).toBe(
      "2 new events · 3 events added to earlier sessions",
    );
    expect(arrivalsLabel({ above: 2, within: 0, backlog: true })).toBe(
      "More new activity is available.",
    );
  });
});

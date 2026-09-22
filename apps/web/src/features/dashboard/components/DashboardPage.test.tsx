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
          "Margin of Safety · Balanced is above 5%",
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
    const pending = rows.find((entry) => entry.textContent?.includes("Roper"))!;
    expect(within(pending).getByText("Waiting for trigger")).toBeDefined();
    expect(
      within(pending).getByText(/Waiting for: Price crosses above SMA 20D/),
    ).toBeDefined();
    const buy = rows.find((entry) => entry.textContent?.includes("Buy 100%"))!;
    expect(within(buy).getByText("Active")).toBeDefined();
    expect(
      rows.some((entry) => within(entry).queryByText("Final exit") !== null),
    ).toBe(true);
  });

  it("orders active before waiting, then by action, then newest first (UI-025)", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const rows = within(await screen.findByTestId("dashboard-signals")).getAllByTestId(
      "dashboard-signal-row",
    );
    const states = rows.map(
      (entry) =>
        entry.querySelector("[data-state]")?.getAttribute("data-state") ?? "",
    );
    const levels = rows.map(
      (entry) =>
        entry.querySelector("[data-level]")?.getAttribute("data-level") ?? "",
    );
    // The API sent the waiting setup first; it is actionable last.
    expect(states).toEqual(["ACTIVE", "ACTIVE", "ACTIVE", "PENDING_TRIGGER"]);
    expect(levels.slice(0, 3)).toEqual(["BUY", "BUY", "FINAL_EXIT"]);
  });

  it("says when each signal's state began, with the exact time in reachable text (UI-025)", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const since = (await screen.findAllByTestId("dashboard-since"))[0]!;
    expect(since.querySelector("time")?.getAttribute("dateTime")).toMatch(
      /^\d{4}-\d{2}-\d{2}T/,
    );
    // Relative ("… ago") for scanning, the absolute instant for a screen reader.
    expect(since.textContent).toMatch(/ago|just now/);
    expect(since.textContent).toMatch(/\(\w{3} \d{1,2}, \d{4}, /);
  });

  it("shows exactly the agreed columns, Since included, and no per-row Backtest", async () => {
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
      "Since",
      "Why",
      "Price",
      "Strategy",
      "List",
      "Monitor",
    ]);
    expect(screen.queryAllByRole("link", { name: /Backtest/ })).toHaveLength(0);
  });

  it("links the stock, the strategy, the list and the monitor independently", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const rows = within(await screen.findByTestId("dashboard-signals")).getAllByTestId(
      "dashboard-signal-row",
    );
    const active = rows.find((entry) =>
      entry.querySelector('a[href="/monitors/monitor-b"]') &&
      entry.querySelector('a[href="/stocks/AAPL"]'),
    )!;
    // The identity cell is the row's own link to Stock Details; the three relationship cells
    // (desktop columns, so `hidden` from the phone card) each go somewhere else, and none of them
    // is the row's destination.
    expect(
      within(active).getByRole("link", { name: /AAPL/ }).getAttribute("href"),
    ).toBe("/stocks/AAPL");
    const relationshipCells = Array.from(
      active.querySelectorAll<HTMLElement>('td[data-card="hidden"]'),
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
    const active = rows.find((entry) =>
      entry.querySelector('a[href="/monitors/monitor-b"]') &&
      entry.querySelector('a[href="/stocks/AAPL"]'),
    )!;
    // The three columns step out between 880 and 1,279px, and the same references are folded
    // into the identity cell instead. CSS shows exactly one of the two at any width.
    expect(
      active.querySelectorAll('td[data-card="hidden"][data-fold="true"]'),
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

    // And always offers the way back (UI-012): one press resets both filters.
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByTestId("dashboard-signal-row")).toHaveLength(4);
    expect(
      (screen.getByTestId("dashboard-level-filter") as HTMLSelectElement).value,
    ).toBe("ALL");
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
    // The concept comes first, with its three terms emphasised and nothing else.
    expect(notice.textContent).toMatch(
      /^A Monitor watches a List using a Strategy\. You're viewing FactorSage's built-in monitors\./,
    );
    expect(
      Array.from(notice.querySelectorAll("b")).map((term) => term.textContent),
    ).toEqual(["Monitor", "List", "Strategy"]);
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

  it("opens on the content, not on a card introducing itself", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-signals");

    // The page still has exactly one h1 and it is still the page's name — it is simply not a
    // surface any more, so the market strip is the first thing on screen.
    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Dashboard",
    ]);
    const page = screen.getByTestId("dashboard-page");
    expect(page.textContent).not.toMatch(
      /Current matches and setups from your monitors/,
    );
    // Nothing between the heading and the strip.
    expect(page.firstElementChild?.tagName).toBe("H1");
    expect(page.children[1]).toBe(screen.getByTestId("dashboard-overview"));
  });

  it("keeps the freshness fact, beside the matches it describes", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const freshness = await screen.findByTestId("dashboard-freshness");
    // Still the real scan time, not a client-side clock: the fixture scanned three minutes ago.
    expect(freshness.textContent).toBe("Updated 3 min ago");
    // Inside the Current matches section, not in a page header above the market strip.
    const section = screen.getByTestId("dashboard-signals").closest("section");
    expect(section?.contains(freshness)).toBe(true);
    expect(
      screen
        .getByTestId("dashboard-overview")
        .compareDocumentPosition(freshness) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("calls them matches, on the heading, the table and the empty states", async () => {
    const user = userEvent.setup();
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-signals");

    expect(
      screen.getByRole("heading", { level: 2, name: "Current matches" }),
    ).toBeDefined();
    expect(screen.getByRole("table").getAttribute("aria-label")).toBe(
      "Current matches",
    );
    // The lifecycle the caption explains is unchanged; only the word for a row is.
    expect(
      screen.getByText(/Active matches stay here while their conditions hold/),
    ).toBeDefined();
    expect(
      screen.getByText(/Setups waiting for a trigger become active when it fires/),
    ).toBeDefined();
    expect(screen.getByTestId("dashboard-page").textContent).not.toMatch(
      /Current signals/,
    );

    await user.selectOptions(screen.getByTestId("dashboard-level-filter"), "SELL");
    expect(
      screen.getByTestId("dashboard-signals-filtered-empty").textContent,
    ).toMatch(/No matches for these filters/);
  });

  it("never says where a row's state was reconstructed from", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);
    await screen.findByTestId("dashboard-signals");

    // The fixture's FINAL EXIT row is `reconstructed: true`; the contract still carries it and the
    // Monitor page still uses it. The Dashboard shows the age and nothing about the engine.
    const reconstructed = screen
      .getAllByTestId("dashboard-signal-row")
      .find((entry) => entry.textContent?.includes("UBER"))!;
    expect(within(reconstructed).getByTestId("dashboard-since").textContent).toMatch(
      /ago|just now/,
    );
    expect(screen.getByTestId("dashboard-page").textContent).not.toMatch(
      /from history/i,
    );
  });

  it("shows Strategy, List and Monitor as the shared reference pill with the whole name on hover", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const rows = within(await screen.findByTestId("dashboard-signals")).getAllByTestId(
      "dashboard-signal-row",
    );
    const row = rows.find((entry) =>
      entry.querySelector('a[href="/monitors/monitor-b"]'),
    )!;
    const chips = Array.from(
      row.querySelectorAll<HTMLElement>('td[data-card="hidden"] [data-kind]'),
    );
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      // The whole name stays reachable however the CSS clips it.
      expect(chip.getAttribute("title")).toBe(chip.textContent);
    }
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Value & Trend",
      "S&P 500 Growth Leaders",
      "Nasdaq Trend Confirmation",
    ]);

    // The folded copy for the intermediate desktop band and the phone card's row are the same
    // pill, with the same references in the same order.
    for (const testId of [
      "dashboard-folded-relationships",
      "dashboard-card-relationships",
    ]) {
      const copies = within(within(row).getByTestId(testId)).getAllByRole(
        "link",
      );
      expect(
        copies.map((chip) => [chip.className, chip.getAttribute("title")]),
      ).toEqual(
        chips.map((chip) => [chip.className, chip.getAttribute("title")]),
      );
    }
  });

  it("composes the phone card as identity, one summary line, why, then origin", async () => {
    fetchDashboardMock.mockResolvedValue(dashboard());
    render(<DashboardPage />);

    const row = within(await screen.findByTestId("dashboard-signals"))
      .getAllByTestId("dashboard-signal-row")
      .find((entry) => entry.querySelector('a[href="/monitors/monitor-a"]'))!;
    const roleOf = (key: string) =>
      row.querySelector(`td:nth-child(${key})`)?.getAttribute("data-card");

    // Since and Price share one unlabelled summary line instead of a labelled row each.
    expect(roleOf("3")).toBe("summary");
    expect(roleOf("5")).toBe("summary");
    for (const cell of row.querySelectorAll('td[data-card="summary"]')) {
      expect(cell.textContent).not.toMatch(/SINCE|PRICE/i);
    }

    // The reason is the card's prose and carries no label of its own …
    const why = row.querySelector<HTMLElement>('td[data-stacked="true"]')!;
    expect(why.getAttribute("data-card")).toBe("fact");
    expect(why.textContent).toMatch(/Margin of Safety/);
    expect(why.textContent).not.toMatch(/^Why/);

    // … and the origin sits under it, Strategy, List, Monitor, each pill under a small label: the
    // three desktop columns leave the card rather than taking a labelled row each.
    expect(row.querySelectorAll('td[data-card="links"]')).toHaveLength(0);
    expect(row.querySelectorAll('td[data-card="hidden"]')).toHaveLength(3);
    const origin = within(why).getByTestId("dashboard-card-relationships");
    expect(
      Array.from(origin.querySelectorAll<HTMLElement>("[data-kind]")).map(
        (chip) => [chip.getAttribute("data-kind"), chip.textContent],
      ),
    ).toEqual([
      ["strategy", "Value & Trend"],
      ["list", "S&P 500 Growth Leaders"],
      ["monitor", "S&P Value & Trend"],
    ]);
    // A card has no column headers, so each pill carries a visible label naming what it is.
    expect(origin.textContent).toBe(
      "StrategyValue & TrendListS&P 500 Growth LeadersMonitorS&P Value & Trend",
    );

    // Everything the card has to carry is still on it, once each.
    expect(within(row).getByTestId("dashboard-stock").textContent).toMatch(/AAPL/);
    expect(within(row).getByText("Buy 100%")).toBeDefined();
    expect(within(row).getByText("Active")).toBeDefined();
    expect(row.textContent).toMatch(/\$210\.50/);
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

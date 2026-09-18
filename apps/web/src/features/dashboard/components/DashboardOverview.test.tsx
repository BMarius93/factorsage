import type {
  DashboardRowResponse,
  MarketOverviewItemResponse,
  MarketOverviewResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { fetchMarketOverview } from "../../market/api/market-api";
import { DashboardOverview } from "./DashboardOverview";

vi.mock("../../market/api/market-api", () => ({
  fetchMarketOverview: vi.fn(),
}));

vi.mock("../../auth/hooks/use-auth-session", () => ({
  useAuthSession: vi.fn(),
}));

const fetchMarketOverviewMock = vi.mocked(fetchMarketOverview);
const useAuthSessionMock = vi.mocked(useAuthSession);

function item(
  overrides: Partial<MarketOverviewItemResponse> &
    Pick<MarketOverviewItemResponse, "code" | "label">,
): MarketOverviewItemResponse {
  return {
    status: "AVAILABLE",
    sparkline: [
      { date: "2026-09-09", value: 1 },
      { date: "2026-09-10", value: 2 },
      { date: "2026-09-11", value: 3 },
      { date: "2026-09-14", value: 4 },
      { date: "2026-09-15", value: 5 },
      { date: "2026-09-16", value: 6 },
      { date: "2026-09-17", value: 7 },
    ],
    ...overrides,
  };
}

function overview(
  overrides: Partial<MarketOverviewResponse> = {},
): MarketOverviewResponse {
  return {
    generatedAt: "2026-09-17T20:00:00.000Z",
    basis: "END_OF_DAY",
    items: [
      item({
        code: "SP500_INDEX",
        label: "S&P 500",
        value: 7637.05,
        previousClose: 7551.81,
        changePercent: 1.1287,
        sessionDate: "2026-09-17",
      }),
      item({
        code: "DJIA_INDEX",
        label: "DJIA",
        value: 51778.04,
        previousClose: 51461.9,
        changePercent: 0.6143,
        sessionDate: "2026-09-17",
      }),
      item({
        code: "VIX_INDEX",
        label: "VIX",
        value: 15.43,
        previousClose: 17.71,
        changePercent: -12.8741,
        sessionDate: "2026-09-17",
      }),
    ],
    ...overrides,
  };
}

function row(
  overrides: Partial<DashboardRowResponse> = {},
): DashboardRowResponse {
  return {
    id: `row-${Math.random()}`,
    state: "ACTIVE",
    security: {
      id: "sec-1",
      symbol: "QATEST1",
      name: "QA Test One",
      exchangeCode: "NASDAQ",
    },
    levelKind: "BUY",
    reasons: [],
    monitor: { id: "m-1", name: "Monitor", ownership: "SYSTEM" },
    strategy: { id: "s-1", name: "Strategy" },
    stockList: { id: "l-1", name: "List" },
    since: "2026-09-16T12:00:00.000Z",
    reconstructed: false,
    ...overrides,
  };
}

function signedIn(value: boolean) {
  useAuthSessionMock.mockReturnValue({
    state: value
      ? {
          status: "authenticated",
          user: {
            id: "user-1",
            email: "pro@example.test",
            role: "USER",
            plan: "PRO",
          },
        }
      : { status: "unauthenticated" },
    refresh: vi.fn(),
    signOut: vi.fn(),
  } as unknown as ReturnType<typeof useAuthSession>);
}

async function renderOverview(
  rows: DashboardRowResponse[] = [],
  rowsReady = true,
) {
  render(<DashboardOverview rows={rows} rowsReady={rowsReady} />);
  await waitFor(() => expect(fetchMarketOverviewMock).toHaveBeenCalledTimes(1));
}

/**
 * The Dashboard's opening row.
 *
 * The count and the order are asserted literally, because they are the product decision: five
 * cards, `Run Backtest · S&P 500 · DJIA · VIX · Real-time Matches`, and nothing else. A Nasdaq card
 * or a Fear & Greed gauge arriving by accident is exactly the failure these tests exist to catch.
 */
describe("DashboardOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn(true);
    fetchMarketOverviewMock.mockResolvedValue(overview());
  });

  it("renders exactly five cards, in the agreed order", async () => {
    await renderOverview();

    const cards = [
      screen.getByTestId("dashboard-run-backtest"),
      screen.getByTestId("dashboard-market-card-SP500_INDEX"),
      screen.getByTestId("dashboard-market-card-DJIA_INDEX"),
      screen.getByTestId("dashboard-market-card-VIX_INDEX"),
      screen.getByTestId("dashboard-matches-card"),
    ];
    const grid = cards[0]?.parentElement as HTMLElement;
    // Five cards, in this order, and no sixth.
    expect([...grid.children]).toEqual(cards);
    expect(grid.children).toHaveLength(5);
    expect([...grid.children].map((card) => card.textContent)).toEqual([
      expect.stringContaining("Run Backtest"),
      expect.stringContaining("S&P 500"),
      expect.stringContaining("DJIA"),
      expect.stringContaining("VIX"),
      expect.stringContaining("Real-time Matches"),
    ]);
  });

  it("shows no market metric the product did not ask for", async () => {
    await renderOverview();

    const strip = screen.getByTestId("dashboard-overview");
    for (const forbidden of [
      /nasdaq/i,
      /fear/i,
      /greed/i,
      /bitcoin/i,
      /breadth/i,
      /valuation/i,
      /advance/i,
    ]) {
      expect(within(strip).queryByText(forbidden)).toBeNull();
    }
  });

  it("renders the index values, changes and their direction", async () => {
    await renderOverview();

    expect(
      screen.getByTestId("dashboard-market-value-SP500_INDEX").textContent,
    ).toBe("7,637");
    expect(
      screen.getByTestId("dashboard-market-value-DJIA_INDEX").textContent,
    ).toBe("51,778");
    expect(
      screen.getByTestId("dashboard-market-value-VIX_INDEX").textContent,
    ).toBe("15.43");

    const sp500Change = screen.getByTestId(
      "dashboard-market-change-SP500_INDEX",
    );
    expect(sp500Change.textContent).toBe("+1.13%");
    expect(sp500Change.getAttribute("data-tone")).toBe("positive");
    const vixChange = screen.getByTestId("dashboard-market-change-VIX_INDEX");
    expect(vixChange.textContent).toBe("−12.87%");
    expect(vixChange.getAttribute("data-tone")).toBe("negative");
    // The session the close belongs to, stated rather than implied.
    expect(
      screen.getByTestId("dashboard-market-card-SP500_INDEX").textContent,
    ).toContain("17 Sep");
  });

  it("draws a seven-session sparkline that a reader never depends on", async () => {
    await renderOverview();

    const spark = screen.getByTestId("SP500_INDEX-sparkline");
    expect(spark.getAttribute("data-points")).toBe("7");
    expect(spark.getAttribute("aria-hidden")).toBe("true");
    // No axes, no labels, no interaction: the marks are the whole chart.
    expect(spark.querySelectorAll("text")).toHaveLength(0);
    expect(spark.querySelectorAll("polyline")).toHaveLength(1);
    // The card's accessible name carries everything the chart shows, and more.
    expect(
      screen
        .getByTestId("dashboard-market-card-SP500_INDEX")
        .getAttribute("aria-label"),
    ).toBe(
      "S&P 500: 7,637 at the close on 17 Sep, up 1.13% on the previous session.",
    );
  });

  it("renders the same seven points identically on every render", async () => {
    const { unmount } = render(<DashboardOverview rows={[]} rowsReady />);
    await waitFor(() =>
      expect(screen.queryByTestId("SP500_INDEX-sparkline")).not.toBeNull(),
    );
    const first = screen.getByTestId("SP500_INDEX-sparkline").innerHTML;
    const firstGauge = screen.getByTestId("dashboard-vix-gauge").innerHTML;
    unmount();

    render(<DashboardOverview rows={[]} rowsReady />);
    await waitFor(() =>
      expect(screen.queryByTestId("SP500_INDEX-sparkline")).not.toBeNull(),
    );

    // A microchart that is a pure function of its values is what makes a seeded screenshot
    // comparable between runs.
    expect(screen.getByTestId("SP500_INDEX-sparkline").innerHTML).toBe(first);
    expect(screen.getByTestId("dashboard-vix-gauge").innerHTML).toBe(
      firstGauge,
    );
  });

  it("renders a missing market card as unavailable, keeping the other four", async () => {
    fetchMarketOverviewMock.mockResolvedValue(
      overview({
        items: [
          item({
            code: "SP500_INDEX",
            label: "S&P 500",
            value: 7637.05,
            changePercent: 1.1287,
            sessionDate: "2026-09-17",
          }),
          {
            code: "DJIA_INDEX",
            label: "DJIA",
            status: "UNAVAILABLE",
            sparkline: [],
          },
          item({
            code: "VIX_INDEX",
            label: "VIX",
            value: 15.43,
            changePercent: -12.8741,
            sessionDate: "2026-09-17",
          }),
        ],
      }),
    );

    await renderOverview();

    const djia = screen.getByTestId("dashboard-market-card-DJIA_INDEX");
    expect(djia.getAttribute("data-status")).toBe("UNAVAILABLE");
    expect(djia.textContent).toContain("No data");
    // Nothing invented in its place, and no sparkline drawn from nothing.
    expect(screen.queryByTestId("DJIA_INDEX-sparkline")).toBeNull();
    expect(
      screen.getByTestId("dashboard-market-value-SP500_INDEX").textContent,
    ).toBe("7,637");
    // The strip keeps its five cards: an unreadable series costs its own card and nothing else.
    expect(
      screen.getByTestId("dashboard-run-backtest").parentElement?.children,
    ).toHaveLength(5);
  });

  it("states no percentage when the server reported none", async () => {
    fetchMarketOverviewMock.mockResolvedValue(
      overview({
        items: [
          item({
            code: "SP500_INDEX",
            label: "S&P 500",
            value: 7637.05,
            sessionDate: "2026-09-17",
            sparkline: [{ date: "2026-09-17", value: 7637.05 }],
          }),
        ],
      }),
    );

    await renderOverview();

    // Not "+0.00%": that would claim the market was flat.
    expect(
      screen.queryByTestId("dashboard-market-change-SP500_INDEX"),
    ).toBeNull();
    expect(
      screen.getByTestId("dashboard-market-value-SP500_INDEX").textContent,
    ).toBe("7,637");
    // And one point is not a trend line.
    expect(screen.queryByTestId("SP500_INDEX-sparkline")).toBeNull();
  });

  it("still renders five cards when the market request fails entirely", async () => {
    fetchMarketOverviewMock.mockRejectedValue(new Error("network"));

    render(<DashboardOverview rows={[row()]} rowsReady />);
    await waitFor(() =>
      expect(
        screen
          .getByTestId("dashboard-market-card-SP500_INDEX")
          .getAttribute("data-status"),
      ).toBe("UNAVAILABLE"),
    );

    const grid = screen.getByTestId("dashboard-run-backtest")
      .parentElement as HTMLElement;
    expect(grid.children).toHaveLength(5);
    // The two cards that do not depend on the market still work.
    expect(screen.getByTestId("dashboard-matches-total").textContent).toBe("1");
  });

  it("links a signed-in viewer straight to the canonical New Backtest route", async () => {
    await renderOverview();

    const card = screen.getByTestId("dashboard-run-backtest");
    expect(card.tagName).toBe("A");
    expect(card.getAttribute("href")).toBe("/backtests/new");
    expect(card.textContent).toContain("Run Backtest");
  });

  it("asks a Guest for an account in place, without navigating", async () => {
    // The Dashboard is already where sign-in lands by default, so its links carry no `next`.
    window.history.replaceState(null, "", "/dashboard");
    signedIn(false);
    await renderOverview();

    const card = screen.getByTestId("dashboard-run-backtest");
    // A button, not a link: the honest answer to the click is a question, not a destination.
    expect(card.tagName).toBe("BUTTON");
    expect(card.getAttribute("href")).toBeNull();

    await userEvent.click(card);

    const prompt = await screen.findByTestId("sign-in-prompt");
    expect(
      within(prompt)
        .getByRole("link", { name: "Sign in" })
        .getAttribute("href"),
    ).toBe("/login");
    expect(
      within(prompt)
        .getByRole("link", { name: "Create an account" })
        .getAttribute("href"),
    ).toBe("/register");
    // And the Dashboard is still underneath it: no redirect to /login for a click.
    expect(screen.queryByTestId("dashboard-overview")).not.toBeNull();
    expect(
      screen.getByTestId("dashboard-market-value-SP500_INDEX").textContent,
    ).toBe("7,637");
  });

  it("counts every current row the viewer's dashboard returned", async () => {
    await renderOverview([
      row({ id: "a", state: "ACTIVE" }),
      row({ id: "b", state: "ACTIVE" }),
      row({ id: "c", state: "PENDING_TRIGGER" }),
      row({ id: "d", state: "PENDING_TRIGGER" }),
      row({ id: "e", state: "PENDING_TRIGGER" }),
    ]);

    expect(screen.getByTestId("dashboard-matches-total").textContent).toBe("5");
    expect(screen.getByTestId("dashboard-matches-breakdown").textContent).toBe(
      "2 active · 3 waiting",
    );
  });

  it("holds the count back until the dashboard has actually answered", async () => {
    await renderOverview([], false);

    // A premature 0 reads as "nothing is matching", which is a different statement from "not known
    // yet" and the one thing a count must never say by accident.
    expect(screen.queryByTestId("dashboard-matches-total")).toBeNull();
  });

  it("points at the signals section rather than navigating away", async () => {
    await renderOverview([row()]);

    expect(
      screen.getByTestId("dashboard-matches-card").getAttribute("href"),
    ).toBe("#signals");
  });
});

/**
 * VIX is the one market card read as a gauge. Everything asserted here is a way the gauge could lie:
 * by rewriting the number, by drawing a zone for data that is not there, or by borrowing the words
 * of a sentiment dial it is not.
 */
describe("DashboardOverview VIX gauge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signedIn(true);
  });

  function withVix(overrides: Partial<MarketOverviewItemResponse>) {
    const base = overview();
    fetchMarketOverviewMock.mockResolvedValue({
      ...base,
      items: base.items.map((entry) =>
        entry.code === "VIX_INDEX" ? { ...entry, ...overrides } : entry,
      ),
    });
  }

  it("renders VIX as a gauge card, and S&P 500 and DJIA as sparkline cards", async () => {
    withVix({});
    await renderOverview();

    const vix = screen.getByTestId("dashboard-market-card-VIX_INDEX");
    expect(vix.getAttribute("data-variant")).toBe("gauge");
    expect(within(vix).getByTestId("dashboard-vix-gauge")).toBeDefined();
    expect(screen.queryByTestId("VIX_INDEX-sparkline")).toBeNull();

    for (const code of ["SP500_INDEX", "DJIA_INDEX"]) {
      const card = screen.getByTestId(`dashboard-market-card-${code}`);
      expect(card.getAttribute("data-variant")).toBeNull();
      expect(within(card).getByTestId(`${code}-sparkline`)).toBeDefined();
      expect(within(card).queryByTestId("dashboard-vix-gauge")).toBeNull();
    }
  });

  it("shows the real VIX close, its zone and the session change", async () => {
    withVix({});
    await renderOverview();

    expect(
      screen.getByTestId("dashboard-market-value-VIX_INDEX").textContent,
    ).toBe("15.43");
    const status = screen.getByTestId("dashboard-vix-status");
    expect(status.textContent).toBe("Normal");
    expect(status.getAttribute("data-zone")).toBe("NORMAL");
    const change = screen.getByTestId("dashboard-market-change-VIX_INDEX");
    expect(change.textContent).toBe("−12.87%");
    expect(change.getAttribute("data-tone")).toBe("negative");
    // Still the session the close belongs to — never "24h".
    const card = screen.getByTestId("dashboard-market-card-VIX_INDEX");
    expect(card.textContent).toContain("17 Sep");
    expect(card.textContent).not.toMatch(/24h/i);
    expect(card.getAttribute("aria-label")).toBe(
      "VIX: 15.43 at the close on 17 Sep, down 12.87% on the previous session. Volatility level: Normal.",
    );
  });

  it.each([
    [11.99, "Very low", "VERY_LOW"],
    [12, "Normal", "NORMAL"],
    [20, "Elevated", "ELEVATED"],
    [30, "High", "HIGH"],
    [40, "Extreme", "EXTREME"],
  ] as const)("labels a close of %d as %s", async (value, label, zone) => {
    withVix({ value });
    await renderOverview();

    expect(screen.getByTestId("dashboard-vix-status").textContent).toBe(label);
    expect(
      screen.getByTestId("dashboard-vix-gauge").getAttribute("data-status"),
    ).toBe(zone);
  });

  it("positions the marker along the 0–80 display range", async () => {
    withVix({ value: 20 });
    await renderOverview();

    const gauge = screen.getByTestId("dashboard-vix-gauge");
    expect(gauge.getAttribute("data-fraction")).toBe("0.2500");
    // A quarter of the way round a semicircle centred on (50, 49) with radius 42.
    const marker = screen.getByTestId("dashboard-vix-marker");
    expect(Number(marker.getAttribute("cx"))).toBeCloseTo(
      50 - 42 * Math.SQRT1_2,
      1,
    );
    expect(Number(marker.getAttribute("cy"))).toBeCloseTo(
      49 - 42 * Math.SQRT1_2,
      1,
    );
  });

  it("pins the marker at 80+ without clamping the number", async () => {
    withVix({ value: 82.69 });
    await renderOverview();

    // The arc ends at 80 …
    expect(
      screen.getByTestId("dashboard-vix-gauge").getAttribute("data-fraction"),
    ).toBe("1.0000");
    const marker = screen.getByTestId("dashboard-vix-marker");
    expect(Number(marker.getAttribute("cx"))).toBeCloseTo(92, 1);
    // … the reading does not.
    expect(
      screen.getByTestId("dashboard-market-value-VIX_INDEX").textContent,
    ).toBe("82.69");
    expect(screen.getByTestId("dashboard-vix-status").textContent).toBe(
      "Extreme",
    );
  });

  it("draws no gauge, zone, value or change for an unavailable VIX", async () => {
    withVix({
      status: "UNAVAILABLE",
      value: undefined,
      previousClose: undefined,
      changePercent: undefined,
      sessionDate: undefined,
      sparkline: [],
    });
    await renderOverview();

    const card = screen.getByTestId("dashboard-market-card-VIX_INDEX");
    expect(card.textContent).toContain("No data");
    expect(screen.queryByTestId("dashboard-vix-gauge")).toBeNull();
    expect(screen.queryByTestId("dashboard-vix-status")).toBeNull();
    expect(screen.queryByTestId("dashboard-market-value-VIX_INDEX")).toBeNull();
    expect(
      screen.queryByTestId("dashboard-market-change-VIX_INDEX"),
    ).toBeNull();
    // Never a fabricated zero, and never a zone for a level that is not there.
    expect(card.textContent).not.toMatch(/\b0\.00\b|Very low/);
  });

  it("never calls VIX a fear and greed reading anywhere on the strip", async () => {
    withVix({});
    await renderOverview();

    const strip = screen.getByTestId("dashboard-overview");
    expect(strip.textContent).not.toMatch(/fear|greed|sentiment|24h/i);
    expect(strip.innerHTML).not.toMatch(/fear|greed/i);
  });

  it("keeps the five cards in their agreed order", async () => {
    withVix({});
    await renderOverview();

    const grid = screen.getByTestId("dashboard-run-backtest")
      .parentElement as HTMLElement;
    expect(
      [...grid.children].map((card) => card.getAttribute("data-testid")),
    ).toEqual([
      "dashboard-run-backtest",
      "dashboard-market-card-SP500_INDEX",
      "dashboard-market-card-DJIA_INDEX",
      "dashboard-market-card-VIX_INDEX",
      "dashboard-matches-card",
    ]);
  });
});

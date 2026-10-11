import { MARKET_OVERVIEW_GROUP_IDS } from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  marketOverviewFixture,
  unavailableMarketOverview,
} from "../__testing__/market-overview";
import { fetchMarketOverview } from "../api/market-api";
import { MARKET_OVERVIEW_SKELETON_ROWS, MarketOverview } from "./MarketOverview";

vi.mock("../api/market-api", () => ({ fetchMarketOverview: vi.fn() }));

const fetchMock = vi.mocked(fetchMarketOverview);

async function renderReady(response = marketOverviewFixture()) {
  fetchMock.mockResolvedValue(response);
  render(<MarketOverview />);
  await screen.findByTestId("market-overview-row-SPY");
}

function rowTickers(groupId: string): string[] {
  return within(screen.getByTestId(`market-overview-group-${groupId}`))
    .getAllByTestId("market-overview-ticker")
    .map((element) => element.textContent ?? "");
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("MarketOverview", () => {
  it("shows the three groups in order, with exactly 5, 11 and 4 ETFs", async () => {
    await renderReady();

    const groups = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(groups).toEqual(["Benchmarks", "Sector Performance", "Macro & Alternatives"]);
    expect(rowTickers("BENCHMARKS")).toEqual(["SPY", "QQQ", "DIA", "IWM", "RSP"]);
    expect(rowTickers("US_SECTORS")).toHaveLength(11);
    expect(rowTickers("MACRO_ALTERNATIVES")).toEqual(["GLD", "USO", "TLT", "HYG"]);
  });

  it("shows all six periods for every ETF at once, with no period selector", async () => {
    await renderReady();

    for (const row of screen.getAllByTestId(/^market-overview-row-/)) {
      const ticker = row.getAttribute("data-testid")?.replace("market-overview-row-", "");
      for (const period of ["1W", "1M", "3M", "6M", "YTD", "1Y"]) {
        expect(within(row).getByTestId(`market-overview-return-${ticker}-${period}`)).toBeTruthy();
      }
    }
    // No 1D, no comparison with SPY, no relative columns.
    expect(screen.queryByText(/^1D$/)).toBeNull();
    expect(screen.queryByText(/vs\.? SPY|relative/i)).toBeNull();
  });

  it("signs returns, uses a real minus sign and colours by direction", async () => {
    await renderReady(
      marketOverviewFixture({
        instruments: {
          SPY: {
            returns: { "1W": 1.234, "1M": -4.56, "3M": 0.02, "6M": null, YTD: 19.2, "1Y": 0 },
          },
        },
      }),
    );

    const value = (period: string) => screen.getByTestId(`market-overview-return-SPY-${period}`);
    expect(value("1W").textContent).toBe("+1.2%");
    expect(value("1W").getAttribute("data-tone")).toBe("positive");
    expect(value("1M").textContent).toBe("−4.6%");
    expect(value("1M").getAttribute("data-tone")).toBe("negative");
    // Zero and unavailable are different statements and read differently.
    expect(value("3M").textContent).toBe("0.0%");
    expect(value("3M").getAttribute("data-tone")).toBe("zero");
    expect(value("1Y").getAttribute("data-tone")).toBe("zero");
    expect(value("6M").textContent).toContain("—");
    expect(value("6M").textContent).toContain("not available");
    expect(value("6M").getAttribute("data-tone")).toBe("unavailable");
  });

  it("names every value for assistive technology", async () => {
    await renderReady();
    const row = screen.getByTestId("market-overview-row-QQQ");

    const labels = within(row).getAllByRole("term").map((term) => term.textContent);
    expect(labels).toEqual(["1W", "1M", "3M", "6M", "YTD", "1Y"]);
    expect(within(row).getByTitle("1 month")).toBeTruthy();
    expect(screen.getByTestId("market-overview-return-QQQ-1M").getAttribute("title")).toMatch(
      /^1 month: (up|down) \d+\.\d{2}%$/,
    );
  });

  it("draws one trend line per ETF, coloured by its 1Y return and described in words", async () => {
    await renderReady();

    const lines = screen.getAllByRole("img");
    expect(lines).toHaveLength(20);
    const spy = screen.getByTestId("market-overview-SPY-sparkline");
    expect(spy.getAttribute("data-points")).toBe("53");
    expect(spy.getAttribute("data-tone")).toBe("positive");
    expect(spy.getAttribute("aria-label")).toBe(
      "SPY one-year trend, weekly closes from 9 Oct 2025 to 9 Oct 2026, up 9.41%",
    );
    // A falling year draws in the negative tone.
    expect(screen.getByTestId("market-overview-DIA-sparkline").getAttribute("data-tone")).toBe(
      "negative",
    );
  });

  it("states the data basis and the session the numbers closed on", async () => {
    await renderReady();

    expect(screen.getByTestId("market-overview-asof").textContent).toBe(
      "End-of-day price returns · As of the close on Fri 9 Oct 2026",
    );
    const footnote = screen.getByTestId("market-overview-footnote").textContent ?? "";
    expect(footnote).toMatch(/excluding dividends and other distributions/);
    expect(footnote).toMatch(/not index levels/);
    expect(footnote).toMatch(/USO: Tracks near-month WTI crude oil futures, not the spot price/);
    // The row points at its note.
    expect(screen.getByTestId("market-overview-row-USO").getAttribute("aria-describedby")).toBe(
      "market-overview-note-USO",
    );
  });

  it("marks a stale ETF with its own data date, and an unavailable one plainly", async () => {
    await renderReady(
      marketOverviewFixture({
        instruments: {
          XLE: { status: "STALE", sessionDate: "2026-10-07" },
          GLD: {
            status: "UNAVAILABLE",
            sessionDate: undefined,
            sparkline: null,
            returns: { "1W": null, "1M": null, "3M": null, "6M": null, YTD: null, "1Y": null },
          },
        },
      }),
    );

    expect(screen.getByTestId("market-overview-stale-XLE").textContent).toBe("As of 7 Oct");
    expect(screen.getByTestId("market-overview-row-XLE").getAttribute("data-status")).toBe("STALE");
    expect(screen.getByTestId("market-overview-unavailable-GLD").textContent).toBe("No data");
    expect(screen.queryByTestId("market-overview-GLD-sparkline")).toBeNull();
    // The other nineteen are untouched.
    expect(screen.getAllByRole("img")).toHaveLength(19);
  });

  it("sorts a group by a period, strongest first, and restores the catalog order", async () => {
    const user = userEvent.setup();
    await renderReady(
      marketOverviewFixture({
        instruments: {
          GLD: { returns: { "1W": 1, "1M": 2, "3M": 3, "6M": 4, YTD: 5, "1Y": 6 } },
          USO: { returns: { "1W": 9, "1M": -8, "3M": 3, "6M": 4, YTD: 5, "1Y": 6 } },
          TLT: { returns: { "1W": -3, "1M": 7, "3M": 3, "6M": 4, YTD: 5, "1Y": 6 } },
          HYG: { returns: { "1W": null, "1M": 0, "3M": 3, "6M": 4, YTD: 5, "1Y": 6 } },
        },
      }),
    );

    const sort1W = screen.getByTestId("market-overview-sort-MACRO_ALTERNATIVES-1W");
    await user.click(sort1W);
    expect(sort1W.getAttribute("aria-pressed")).toBe("true");
    // Unavailable sorts last.
    expect(rowTickers("MACRO_ALTERNATIVES")).toEqual(["USO", "GLD", "TLT", "HYG"]);

    await user.click(screen.getByTestId("market-overview-sort-MACRO_ALTERNATIVES-1M"));
    expect(rowTickers("MACRO_ALTERNATIVES")).toEqual(["TLT", "GLD", "HYG", "USO"]);

    await user.click(screen.getByTestId("market-overview-sort-MACRO_ALTERNATIVES-1M"));
    expect(rowTickers("MACRO_ALTERNATIVES")).toEqual(["GLD", "USO", "TLT", "HYG"]);
    // Another group's order is its own.
    expect(rowTickers("BENCHMARKS")).toEqual(["SPY", "QQQ", "DIA", "IWM", "RSP"]);
  });

  it("offers the same sort on compact screens", async () => {
    const user = userEvent.setup();
    await renderReady();

    await user.selectOptions(screen.getByTestId("market-overview-sort"), "YTD");
    const sorted = rowTickers("BENCHMARKS");
    expect(sorted).not.toEqual(["SPY", "QQQ", "DIA", "IWM", "RSP"]);
    expect(
      screen.getByTestId("market-overview-sort-BENCHMARKS-YTD").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("switches the compact category, never the period", async () => {
    const user = userEvent.setup();
    await renderReady();
    const category = screen.getByTestId("market-overview-category");

    expect(
      within(category)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Benchmarks", "Sectors", "Macro"]);
    expect(screen.getByTestId("market-overview-group-BENCHMARKS").getAttribute("data-selected")).toBe(
      "true",
    );

    await user.click(within(category).getByRole("button", { name: /Sectors/ }));
    expect(screen.getByTestId("market-overview-group-US_SECTORS").getAttribute("data-selected")).toBe(
      "true",
    );
    expect(
      screen.getByTestId("market-overview-group-BENCHMARKS").getAttribute("data-selected"),
    ).toBeNull();
    // Every card still carries all six periods.
    expect(screen.getByTestId("market-overview-return-XLK-1Y")).toBeTruthy();
  });

  it("holds the final layout's shape while loading, so nothing moves when data lands", async () => {
    let resolve: (value: ReturnType<typeof marketOverviewFixture>) => void = () => {};
    fetchMock.mockReturnValue(new Promise((done) => (resolve = done)));
    render(<MarketOverview />);

    const skeleton = screen.getByTestId("market-overview-loading");
    expect(skeleton.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByTestId("market-overview").getAttribute("aria-busy")).toBe("true");
    const response = marketOverviewFixture();
    for (const id of MARKET_OVERVIEW_GROUP_IDS) {
      const group = skeleton.querySelector(`[data-group="${id}"]`);
      const expected = response.groups.find((one) => one.id === id)?.instruments.length;
      expect(group?.querySelectorAll("li")).toHaveLength(MARKET_OVERVIEW_SKELETON_ROWS[id]);
      expect(MARKET_OVERVIEW_SKELETON_ROWS[id]).toBe(expected);
    }
    // Never a number before the server has given one.
    expect(screen.queryByText(/%/)).toBeNull();

    resolve(response);
    await screen.findByTestId("market-overview-row-SPY");
    expect(screen.queryByTestId("market-overview-loading")).toBeNull();
  });

  it("explains a failed request and asks again on demand", async () => {
    const user = userEvent.setup();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce(marketOverviewFixture());
    render(<MarketOverview />);

    const error = await screen.findByTestId("market-overview-error");
    expect(error.textContent).toMatch(/could not be loaded/);
    await user.click(within(error).getByRole("button", { name: "Try again" }));

    await screen.findByTestId("market-overview-row-SPY");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a response on another contract version as this section's failure, not a crash", async () => {
    // What a mid-deploy version skew looks like: the previous release's index-card body.
    fetchMock.mockResolvedValue({
      generatedAt: "2026-10-10T18:30:00.000Z",
      basis: "END_OF_DAY",
      items: [{ code: "SP500_INDEX", label: "S&P 500", status: "AVAILABLE", sparkline: [] }],
    } as never);
    render(<MarketOverview />);

    expect(await screen.findByTestId("market-overview-error")).toBeTruthy();
    expect(screen.queryByTestId("market-overview-footnote")).toBeNull();
  });

  it("renders a clean unavailable state, with no fabricated rows, when nothing has data", async () => {
    fetchMock.mockResolvedValue(unavailableMarketOverview());
    render(<MarketOverview />);

    const empty = await screen.findByTestId("market-overview-unavailable");
    expect(empty.textContent).toMatch(/not available right now/);
    expect(screen.queryByTestId("market-overview-row-SPY")).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByTestId("market-overview-asof").textContent).toBe("End-of-day price returns");
  });

  it("never shows a fund's price as if it were an index level", async () => {
    await renderReady();
    const values = screen.getAllByRole("definition").map((value) => value.textContent ?? "");

    expect(values).toHaveLength(120);
    // Every figure on a row is a percentage, or says it is not available — never a price.
    for (const value of values) {
      expect(value).toMatch(/^(?:[+−][\d,]+\.\d%|0\.0%|—not available)$/);
    }
    expect(screen.getByTestId("market-overview").textContent).not.toMatch(/\$/);
  });
});

describe("MarketOverview data flow", () => {
  it("asks for the overview once per mount and never polls", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await renderReady();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    } finally {
      vi.useRealTimers();
    }
  });
});

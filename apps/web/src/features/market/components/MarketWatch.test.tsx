import {
  MARKET_OVERVIEW_GROUP_IDS,
  MARKET_OVERVIEW_PERIODS,
  type MarketOverviewPeriod,
  type MarketOverviewResponse,
} from "@intrinsic/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installFakeViewport,
  type FakeViewport,
} from "../../../lib/__testing__/fake-viewport";
import {
  FIXTURE_SPARKLINE_POINTS,
  marketOverviewFixture,
  noSparklines,
  unavailableMarketOverview,
} from "../__testing__/market-overview";
import { fetchMarketOverview } from "../api/market-api";
import { MARKET_WATCH_ROTATION_MS } from "../hooks/use-period-rotation";
import { describeSparkline } from "../utils/format";
import {
  MARKET_WATCH_SKELETON_ROWS,
  MarketWatch,
  MarketWatchBoundary,
} from "./MarketWatch";

vi.mock("../api/market-api", () => ({ fetchMarketOverview: vi.fn() }));

const fetchMock = vi.mocked(fetchMarketOverview);

let viewport: FakeViewport;

beforeEach(() => {
  fetchMock.mockReset();
  viewport = installFakeViewport({ width: 1440 });
});

afterEach(() => {
  viewport.restore();
  vi.useRealTimers();
});

async function renderReady(
  response: MarketOverviewResponse = marketOverviewFixture(),
) {
  fetchMock.mockResolvedValue(response);
  render(<MarketWatch />);
  await screen.findByTestId("market-watch-row-SPY");
  return response;
}

function tickers(groupId: string): string[] {
  return within(screen.getByTestId(`market-watch-group-${groupId}`))
    .getAllByTestId("market-watch-ticker")
    .map((element) => element.textContent ?? "");
}

function periodButton(period: MarketOverviewPeriod): HTMLElement {
  return within(screen.getByTestId("market-watch-period")).getByRole("button", {
    name: period,
  });
}

function selectedPeriod(): string {
  return screen.getByTestId("market-watch").getAttribute("data-period") ?? "";
}

/** The `y` of every drawn point, as the SVG has it. */
function drawnPoints(ticker: string): string {
  return (
    screen
      .getByTestId(`market-watch-${ticker}-sparkline`)
      .querySelector("polyline")
      ?.getAttribute("points") ?? ""
  );
}

describe("MarketWatch", () => {
  it("shows all twenty ETFs in the API's three groups and order", async () => {
    await renderReady();

    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Benchmarks", "Sector Performance", "Macro & Alternatives"]);
    expect(tickers("BENCHMARKS")).toEqual(["SPY", "QQQ", "DIA", "IWM", "RSP"]);
    expect(tickers("US_SECTORS")).toEqual([
      "XLK",
      "XLF",
      "XLE",
      "XLV",
      "XLI",
      "XLY",
      "XLP",
      "XLU",
      "XLB",
      "XLRE",
      "XLC",
    ]);
    expect(tickers("MACRO_ALTERNATIVES")).toEqual(["GLD", "USO", "TLT", "HYG"]);
    expect(screen.getAllByTestId(/^market-watch-row-/)).toHaveLength(20);
  });

  it("gives every row a decorative mark, its ticker, its market's name, a return and a line", async () => {
    const response = await renderReady();

    for (const instrument of response.groups.flatMap(
      (group) => group.instruments,
    )) {
      const row = screen.getByTestId(`market-watch-row-${instrument.ticker}`);
      const icon = row.querySelector("svg[data-icon]");
      expect(icon?.getAttribute("aria-hidden")).toBe("true");
      // Every one of the twenty has a mark that says what it tracks, not the generic fallback.
      expect(icon?.getAttribute("data-icon")).not.toBe("market");
      expect(within(row).getByTestId("market-watch-ticker").textContent).toBe(
        instrument.ticker,
      );
      const name = within(row).getByTestId("market-watch-name");
      expect(name.textContent).toBe(instrument.name);
      expect(name.getAttribute("title")).toBe(instrument.name);
      expect(
        within(row).getByTestId(`market-watch-return-${instrument.ticker}`),
      ).toBeTruthy();
      expect(
        within(row).getByTestId(`market-watch-${instrument.ticker}-sparkline`),
      ).toBeTruthy();
    }
    expect(screen.getByTestId("market-watch-row-SPY").textContent).toContain(
      "S&P 500",
    );
  });

  it("shows one period for the whole list, starting on 1W, with an explicit selected state", async () => {
    await renderReady();

    expect(selectedPeriod()).toBe("1W");
    expect(periodButton("1W").getAttribute("aria-pressed")).toBe("true");
    for (const period of MARKET_OVERVIEW_PERIODS.slice(1)) {
      expect(periodButton(period).getAttribute("aria-pressed")).toBe("false");
    }
    expect(screen.getByTestId("market-watch-caption").textContent).toBe(
      "1-week return · At close · Oct 9, 2026",
    );
  });

  it("switches every row's return and line together for each of the six periods", async () => {
    const response = await renderReady();
    const user = userEvent.setup();
    const instruments = response.groups.flatMap((group) => group.instruments);
    const drawn = new Map<MarketOverviewPeriod, string>();

    for (const period of [...MARKET_OVERVIEW_PERIODS].reverse()) {
      await user.click(periodButton(period));
      expect(selectedPeriod()).toBe(period);
      for (const instrument of instruments) {
        const value = screen.getByTestId(
          `market-watch-return-${instrument.ticker}`,
        );
        const expected = instrument.returns[period] as number;
        const rounded = Math.round(expected * 10) / 10;
        expect(value.textContent).toBe(
          `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(1)}%`,
        );
        const line = screen.getByTestId(
          `market-watch-${instrument.ticker}-sparkline`,
        );
        // The line drawn is that period's own series: its point count and its direction.
        expect(line.getAttribute("data-points")).toBe(
          String(FIXTURE_SPARKLINE_POINTS[period]),
        );
        expect(line.getAttribute("data-tone")).toBe(
          expected > 0 ? "positive" : "negative",
        );
        expect(line.getAttribute("aria-label")).toBe(
          describeSparkline(
            instrument.ticker,
            period,
            instrument.sparklines[period],
            expected,
          ),
        );
      }
      drawn.set(period, drawnPoints("XLK"));
    }
    // Six periods, six different lines: no period reuses another's data.
    expect(new Set(drawn.values()).size).toBe(6);
  });

  it("never reorders groups or rows when the period changes", async () => {
    await renderReady();
    const user = userEvent.setup();
    const order = () =>
      screen
        .getAllByTestId(/^market-watch-row-/)
        .map((row) => row.getAttribute("data-testid"));
    const before = order();
    for (const period of MARKET_OVERVIEW_PERIODS) {
      await user.click(periodButton(period));
      expect(order()).toEqual(before);
    }
  });

  it("rotates every ten seconds in order with one timer, and asks for nothing more", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    fetchMock.mockResolvedValue(marketOverviewFixture());
    render(<MarketWatch />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("market-watch-row-SPY")).toBeTruthy();
    expect(screen.getByTestId("market-watch").getAttribute("data-auto")).toBe(
      "on",
    );
    expect(
      screen.getByTestId("market-watch-auto").getAttribute("aria-pressed"),
    ).toBe("true");

    const seen = [selectedPeriod()];
    for (let step = 0; step < 6; step += 1) {
      act(() => {
        vi.advanceTimersByTime(MARKET_WATCH_ROTATION_MS);
      });
      seen.push(selectedPeriod());
    }
    expect(seen).toEqual(["1W", "1M", "3M", "6M", "YTD", "1Y", "1W"]);
    // One read for the mount, none for six period changes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pauses on a manual choice, says so, and resumes from the Auto control", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    fetchMock.mockResolvedValue(marketOverviewFixture());
    render(<MarketWatch />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.pointerDown(periodButton("3M"));
    fireEvent.click(periodButton("3M"));
    expect(selectedPeriod()).toBe("3M");
    expect(screen.getByTestId("market-watch").getAttribute("data-auto")).toBe(
      "paused",
    );
    expect(
      screen.getByTestId("market-watch-auto").getAttribute("aria-pressed"),
    ).toBe("false");
    expect(screen.getByTestId("market-watch-paused").textContent).toBe(
      "Paused",
    );

    act(() => {
      vi.advanceTimersByTime(MARKET_WATCH_ROTATION_MS * 5);
    });
    expect(selectedPeriod()).toBe("3M");

    fireEvent.click(screen.getByTestId("market-watch-auto"));
    expect(
      screen.getByTestId("market-watch-auto").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByTestId("market-watch-paused")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(MARKET_WATCH_ROTATION_MS);
    });
    expect(selectedPeriod()).toBe("6M");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("holds the rotation while keyboard focus is inside, and selects with the keyboard", async () => {
    await renderReady();
    const user = userEvent.setup();

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByTestId("market-watch-auto"),
    );
    expect(
      screen.getByTestId("market-watch").getAttribute("data-rotating"),
    ).toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(periodButton("1W"));
    await user.tab();
    await user.keyboard("{Enter}");
    expect(selectedPeriod()).toBe("1M");
    expect(screen.getByTestId("market-watch").getAttribute("data-auto")).toBe(
      "paused",
    );

    // The list is its own scroll region with a tab stop, so a keyboard can scroll it.
    const region = screen.getByRole("region", { name: "Market watch ETFs" });
    expect(region.getAttribute("tabindex")).toBe("0");
  });

  it("releases a keyboard hold when the pointer takes focus inside", async () => {
    await renderReady();
    const user = userEvent.setup();

    await user.tab();
    expect(screen.getByTestId("market-watch").getAttribute("data-rotating")).toBeNull();

    // A click on the list (focusable for scrolling) is not keyboard focus: Auto runs again.
    await user.click(screen.getByRole("region", { name: "Market watch ETFs" }));
    expect(screen.getByTestId("market-watch").getAttribute("data-auto")).toBe("on");
    expect(screen.getByTestId("market-watch").getAttribute("data-rotating")).toBe("true");
  });

  it("does not rotate behind an error panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    fetchMock.mockRejectedValue(new Error("offline"));
    render(<MarketWatch />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("market-watch-error")).toBeTruthy();
    expect(screen.getByTestId("market-watch").getAttribute("data-rotating")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("names the Auto control for what it does", async () => {
    await renderReady();
    expect(
      screen.getByRole("button", { name: "Auto rotate periods" }),
    ).toBeTruthy();
    expect(screen.getByRole("group", { name: "Return period" })).toBeTruthy();
  });

  it("announces nothing as it rotates: no live region anywhere in it", async () => {
    await renderReady();
    const watch = screen.getByTestId("market-watch");
    expect(
      watch.querySelector("[aria-live], [role='status'], [role='alert']"),
    ).toBeNull();
  });

  it("shows a stale fund's own date and an unavailable fund's absence, never a zero", async () => {
    await renderReady(
      marketOverviewFixture({
        instruments: {
          XLE: { status: "STALE", sessionDate: "2026-10-07" },
          GLD: {
            status: "UNAVAILABLE",
            returns: {
              "1W": null,
              "1M": null,
              "3M": null,
              "6M": null,
              YTD: null,
              "1Y": null,
            },
            sparklines: noSparklines(),
          },
        },
      }),
    );

    expect(screen.getByTestId("market-watch-stale-XLE").textContent).toBe(
      "As of 7 Oct",
    );
    expect(screen.getByTestId("market-watch-unavailable-GLD").textContent).toBe(
      "No data",
    );
    const gld = screen.getByTestId("market-watch-return-GLD");
    expect(gld.textContent).toBe("—not available");
    expect(gld.getAttribute("data-tone")).toBe("unavailable");
    const empty = screen.getByTestId("market-watch-GLD-no-trend");
    expect(empty.getAttribute("aria-label")).toBe(
      "GLD 1 week trend: not available",
    );
    expect(screen.queryByTestId("market-watch-GLD-sparkline")).toBeNull();
  });

  it("shows no line for a period whose history is too short, and the line for one that has it", async () => {
    const response = marketOverviewFixture();
    const xlc = response.groups[1]!.instruments.find(
      (one) => one.ticker === "XLC",
    )!;
    xlc.returns["1Y"] = null;
    xlc.sparklines["1Y"] = null;
    await renderReady(response);
    const user = userEvent.setup();

    await user.click(periodButton("1Y"));
    expect(screen.getByTestId("market-watch-return-XLC").textContent).toBe(
      "—not available",
    );
    expect(screen.getByTestId("market-watch-XLC-no-trend")).toBeTruthy();

    await user.click(periodButton("6M"));
    expect(screen.getByTestId("market-watch-XLC-sparkline")).toBeTruthy();
  });

  it("draws the skeleton in the shape of the real list while it loads", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    render(<MarketWatch />);
    const loading = screen.getByTestId("market-watch-loading");
    expect(screen.getByTestId("market-watch").getAttribute("aria-busy")).toBe(
      "true",
    );
    expect(loading.querySelectorAll("li")).toHaveLength(20);
    // The skeleton's shape is held to a real response, so the two cannot drift apart.
    for (const group of marketOverviewFixture().groups) {
      expect(MARKET_WATCH_SKELETON_ROWS[group.id]).toBe(
        group.instruments.length,
      );
    }
    expect(Object.keys(MARKET_WATCH_SKELETON_ROWS)).toEqual([
      ...MARKET_OVERVIEW_GROUP_IDS,
    ]);
  });

  it("reports a failed read and asks again on request", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    fetchMock.mockResolvedValueOnce(marketOverviewFixture());
    render(<MarketWatch />);

    const error = await screen.findByTestId("market-watch-error");
    expect(error.textContent).toContain("Market data could not be loaded");
    await userEvent
      .setup()
      .click(within(error).getByRole("button", { name: "Try again" }));
    await screen.findByTestId("market-watch-row-SPY");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a body on another contract version as a failure, not as data", async () => {
    const legacy = marketOverviewFixture() as unknown as {
      groups: { instruments: Record<string, unknown>[] }[];
    };
    for (const group of legacy.groups) {
      for (const instrument of group.instruments) {
        delete instrument.sparklines;
        instrument.sparkline = null;
      }
    }
    fetchMock.mockResolvedValue(legacy as unknown as MarketOverviewResponse);
    render(<MarketWatch />);
    expect(await screen.findByTestId("market-watch-error")).toBeTruthy();
  });

  it("explains an environment with no ETF histories, with no rows and no controls", async () => {
    fetchMock.mockResolvedValue(unavailableMarketOverview());
    render(<MarketWatch />);

    expect(await screen.findByTestId("market-watch-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("market-watch-period")).toBeNull();
    expect(screen.queryByTestId("market-watch-auto")).toBeNull();
    expect(screen.queryAllByTestId(/^market-watch-row-/)).toHaveLength(0);
  });

  it("keeps a body it cannot draw inside its own error state", async () => {
    const broken = marketOverviewFixture();
    // Structurally valid, but a line the sparkline cannot read.
    (broken.groups[0]!.instruments[0]!.sparklines as Record<string, unknown>)[
      "1W"
    ] = {
      startDate: "2026-10-02",
      endDate: "2026-10-09",
      values: null,
    };
    fetchMock.mockResolvedValue(broken);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    render(
      <div>
        <p data-testid="beside">Monitor activity</p>
        <MarketWatchBoundary>
          <MarketWatch />
        </MarketWatchBoundary>
      </div>,
    );

    expect(
      await screen.findByText("Market data could not be shown"),
    ).toBeTruthy();
    expect(screen.getByTestId("beside").textContent).toBe("Monitor activity");
    consoleError.mockRestore();
  });

  it("aborts its read when it unmounts, and never updates afterwards", async () => {
    let signal: AbortSignal | undefined;
    let resolve: (value: MarketOverviewResponse) => void = () => undefined;
    fetchMock.mockImplementation((options) => {
      signal = options?.signal;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const consoleError = vi.spyOn(console, "error");
    const { unmount } = render(<MarketWatch />);
    unmount();

    expect(signal?.aborted).toBe(true);
    await act(async () => {
      resolve(marketOverviewFixture());
      await Promise.resolve();
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

import {
  SELECTABLE_SERIES_CATALOG,
  type DailyPriceResponse,
  type SecurityResponse,
  type StockDetailsResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../lib/api/client";
import {
  fetchDailyPriceHistory,
  fetchDailyTechnicalHistory,
  fetchIntrinsicValueBlendHistory,
  fetchIntrinsicValueHistory,
  fetchStockDetails,
} from "../api/stock-details-api";
import type { StockPriceChartProps } from "./StockPriceChart";
import { StockDetails } from "./StockDetails";

vi.mock("../api/stock-details-api", () => ({
  fetchStockDetails: vi.fn(),
  fetchDailyPriceHistory: vi.fn(),
  fetchDailyTechnicalHistory: vi.fn(),
  fetchIntrinsicValueBlendHistory: vi.fn(),
  fetchIntrinsicValueHistory: vi.fn(),
}));

// The chart library boundary is tested separately; here a probe records the data our feature
// hands to the chart so range/overlay behaviour is asserted on real props.
vi.mock("./StockPriceChart", () => ({
  StockPriceChart: (props: StockPriceChartProps) => (
    <div
      data-testid="price-chart"
      data-point-count={props.points.length}
      data-first-date={props.points[0]?.date ?? ""}
      data-last-date={props.points.at(-1)?.date ?? ""}
      data-overlays={props.overlays
        .map((overlay) => `${overlay.id}:${overlay.points.length}`)
        .join(",")}
      data-overlay-labels={props.overlays
        .map((overlay) => overlay.label)
        .join(",")}
      data-overlay-colors={props.overlays
        .map((overlay) => overlay.color)
        .join(",")}
      data-overlay-panes={props.overlays
        .map((overlay) => overlay.placement)
        .join(",")}
      data-loading={props.loading ? "true" : "false"}
      data-fit-key={props.fitKey}
      data-frame-from={props.frameFrom}
      data-frame-to={props.frameTo}
      data-history-exhausted={props.historyExhausted ? "true" : "false"}
    >
      {/* The two ways a viewport reaches unloaded history, as the real chart reports them:
          a pan that has just crossed the oldest bar, and a zoom-out that opened up years of
          empty space in one gesture. */}
      <button
        type="button"
        data-testid="pan-past-edge"
        onClick={() => props.onReachHistoryEdge?.(30)}
      />
      <button
        type="button"
        data-testid="zoom-out-past-edge"
        onClick={() => props.onReachHistoryEdge?.(5000)}
      />
    </div>
  ),
}));

const fetchStockDetailsMock = vi.mocked(fetchStockDetails);
const fetchDailyPriceHistoryMock = vi.mocked(fetchDailyPriceHistory);
const fetchDailyTechnicalHistoryMock = vi.mocked(fetchDailyTechnicalHistory);
const fetchIntrinsicValueBlendHistoryMock = vi.mocked(
  fetchIntrinsicValueBlendHistory,
);
const fetchIntrinsicValueHistoryMock = vi.mocked(fetchIntrinsicValueHistory);

const SECURITY: SecurityResponse = {
  id: "sec-1",
  symbol: "AAPL",
  name: "Apple Inc.",
  exchangeCode: "NASDAQ",
  exchangeName: "NASDAQ Global Select",
  currency: "USD",
  sector: "Technology",
  industry: "Consumer Electronics",
  ipoDate: "1980-12-12",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

function bar(date: string, close: number): DailyPriceResponse {
  return {
    date,
    open: close,
    high: close + 2,
    low: close - 2,
    close,
    volume: 41_237_500,
  };
}

/** Thirty years before the frozen test date; AAPL listed long before it, so the horizon wins. */
const HISTORY_BOUNDS = {
  start: "1996-08-28",
  end: "2026-08-28",
  startOrigin: "HORIZON",
} as const;

/** Fixture anchored to the frozen test date 2026-08-28 (window 2025-08-28 → 2026-08-28). */
function detailsFixture(): StockDetailsResponse {
  return {
    security: { ...SECURITY },
    history: { ...HISTORY_BOUNDS },
    profile: {
      description: "Designs, manufactures and markets consumer electronics.",
      website: "https://www.apple.com",
      ceo: "Tim Cook",
      employees: 164000,
    },
    prices: [
      bar("2025-09-02", 150),
      bar("2026-03-02", 180),
      bar("2026-06-02", 190),
      bar("2026-07-30", 195),
      bar("2026-08-27", 200),
      bar("2026-08-28", 232),
    ],
    // Deliberately partial: only some catalog entries have data, so the rest must render as
    // discoverable-but-unavailable rather than disappearing.
    technicals: [
      // rsi21d never materializes, so the RSI periods prove per-period availability.
      { date: "2026-08-27", sma50d: 219, sma20w: 215, rsi7d: 41.2 },
      {
        date: "2026-08-28",
        sma50d: 220,
        sma200d: 210,
        ema20d: 225,
        sma20w: 216,
        ema50w: 208,
        rsi7d: 66.8,
        rsi14d: 58.4,
      },
    ],
    intrinsicValues: [
      {
        valuationDate: "2026-08-28",
        sourceDataAsOf: "2026-08-27T22:00:00.000Z",
        model: "DCF_FCFF",
        valuePerShare: 260,
        currency: "USD",
      },
    ],
    intrinsicValueBlends: [
      {
        valuationDate: "2026-08-27",
        sourceDataAsOf: "2026-08-26T22:00:00.000Z",
        blendId: "BALANCED",
        valuePerShare: 240,
        currency: "USD",
      },
      {
        valuationDate: "2026-08-28",
        sourceDataAsOf: "2026-08-27T22:00:00.000Z",
        blendId: "BALANCED",
        valuePerShare: 290,
        currency: "USD",
      },
    ],
  };
}

function chart(): HTMLElement {
  return screen.getByTestId("price-chart");
}

function setupUser() {
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-28T12:00:00.000Z"));
  fetchStockDetailsMock.mockReset();
  fetchDailyPriceHistoryMock.mockReset();
  fetchDailyTechnicalHistoryMock.mockReset();
  fetchIntrinsicValueBlendHistoryMock.mockReset();
  fetchIntrinsicValueHistoryMock.mockReset();
  fetchDailyTechnicalHistoryMock.mockResolvedValue([]);
  fetchIntrinsicValueBlendHistoryMock.mockResolvedValue([]);
  fetchIntrinsicValueHistoryMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StockDetails", () => {
  it("loads real details for a one-year window and renders the stock identity", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());

    render(<StockDetails symbol="AAPL" />);

    const heading = await screen.findByRole("heading", { level: 1, name: /AAPL/ });
    expect(heading.textContent).toContain("Apple Inc.");
    expect(fetchStockDetailsMock).toHaveBeenCalledTimes(1);
    expect(fetchStockDetailsMock).toHaveBeenCalledWith(
      "AAPL",
      { from: "2025-08-28", to: "2026-08-28" },
      expect.anything(),
    );

    expect(screen.getByText("$232.00")).toBeDefined();
    expect(screen.getByText(/\+\$32\.00 \(\+16\.00%\)/)).toBeDefined();
    expect(screen.getByText(/At close · Aug 28, 2026/)).toBeDefined();
    // The exchange shows in the header badges and again under key facts.
    expect(screen.getAllByText("NASDAQ Global Select").length).toBeGreaterThan(0);
    expect(chart().dataset.pointCount).toBe("6");
  });

  it("presents the latest valuation, technicals, and key facts from the payload", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());

    render(<StockDetails symbol="AAPL" />);
    await screen.findByRole("heading", { name: "Intrinsic value" });

    // Scoped to the valuation card: the catalog labels also appear inside the Indicators picker.
    const valuation = screen
      .getByRole("heading", { name: "Intrinsic value" })
      .closest("section")!;
    expect(within(valuation).getByText("Balanced")).toBeDefined();
    expect(within(valuation).getByText("$290.00")).toBeDefined();
    // (290 - 232) / 232 = +25% upside against the latest close.
    expect(within(valuation).getByText("+25.00% vs price")).toBeDefined();
    expect(within(valuation).getByText("DCF (FCFF)")).toBeDefined();
    expect(
      within(valuation).getByText(/Valuation as of Aug 28, 2026/),
    ).toBeDefined();

    const technicals = screen
      .getByRole("heading", { name: "Technicals" })
      .closest("section")!;
    // Daily and weekly rows both use the canonical catalog labels.
    expect(within(technicals).getByText("SMA 200D")).toBeDefined();
    expect(within(technicals).getByText("SMA 20W")).toBeDefined();
    // Close 232 vs SMA 50D of 220 → price sits 5.45% above.
    expect(within(technicals).getByText("price +5.45%")).toBeDefined();

    expect(screen.getByText("Sector")).toBeDefined();
    expect(screen.getByText("Technology")).toBeDefined();
    expect(screen.getByText("41.2M")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "apple.com" }).getAttribute("href"),
    ).toBe("https://www.apple.com");
  });

  it("frames a shorter range out of the loaded window without refetching", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    // Every range inside the loaded window is a viewport change. The chart keeps the whole loaded
    // history — that is what makes panning out of the selected range instant — and is told which
    // window to show.
    await user.click(screen.getByRole("radio", { name: "1M" }));
    expect(chart().dataset.frameFrom).toBe("2026-07-28");
    expect(chart().dataset.pointCount).toBe("6");

    await user.click(screen.getByRole("radio", { name: "3M" }));
    expect(chart().dataset.frameFrom).toBe("2026-05-28");

    await user.click(screen.getByRole("radio", { name: "6M" }));
    expect(chart().dataset.frameFrom).toBe("2026-02-28");

    expect(fetchStockDetailsMock).toHaveBeenCalledTimes(1);
    expect(fetchDailyPriceHistoryMock).not.toHaveBeenCalled();
  });

  it("loads only the gap a long range needs and keeps it for later switches", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    let releaseExtended: (rows: DailyPriceResponse[]) => void = () => {};
    fetchDailyPriceHistoryMock.mockReturnValue(
      new Promise((resolve) => {
        releaseExtended = resolve;
      }),
    );
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    await user.click(screen.getByRole("radio", { name: "5Y" }));
    expect(chart().dataset.loading).toBe("true");
    // Five years, and only the part that is missing: the year already on screen is not refetched.
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledWith(
      "AAPL",
      { from: "2021-08-28", to: "2025-08-27" },
      expect.anything(),
    );

    releaseExtended([bar("2022-08-30", 150), bar("2024-01-05", 180)]);
    await waitFor(() => expect(chart().dataset.loading).toBe("false"));
    // Merged in front of the details window, ascending and without a duplicate at the seam.
    expect(chart().dataset.pointCount).toBe("8");
    expect(chart().dataset.firstDate).toBe("2022-08-30");
    expect(chart().dataset.lastDate).toBe("2026-08-28");

    // MAX is the 30-year product bound, not the listing date, and it asks only for what is left.
    let releaseMax: (rows: DailyPriceResponse[]) => void = () => {};
    fetchDailyPriceHistoryMock.mockReturnValue(
      new Promise((resolve) => {
        releaseMax = resolve;
      }),
    );
    await user.click(screen.getByRole("radio", { name: "MAX" }));
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(2);
    expect(fetchDailyPriceHistoryMock).toHaveBeenLastCalledWith(
      "AAPL",
      { from: "1996-08-28", to: "2021-08-27" },
      expect.anything(),
    );
    // The history already on screen stays there while the older years are on their way.
    expect(chart().dataset.pointCount).toBe("8");

    releaseMax([bar("2010-01-04", 50)]);
    await waitFor(() => expect(chart().dataset.pointCount).toBe("9"));

    // Returning to a shorter range is a viewport change over the same superset: nothing refetches.
    await user.click(screen.getByRole("radio", { name: "1Y" }));
    expect(chart().dataset.frameFrom).toBe("2025-08-28");
    await user.click(screen.getByRole("radio", { name: "5Y" }));
    expect(chart().dataset.frameFrom).toBe("2021-08-28");
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(2);
    expect(fetchStockDetailsMock).toHaveBeenCalledTimes(1);
  });

  it("opens on its own window and asks for no history until the viewport needs it", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    expect(fetchStockDetailsMock).toHaveBeenCalledWith(
      "AAPL",
      { from: "2025-08-28", to: "2026-08-28" },
      expect.anything(),
    );
    // Thirty years are permitted; none of them are downloaded to draw twelve months.
    expect(fetchDailyPriceHistoryMock).not.toHaveBeenCalled();
    expect(fetchDailyTechnicalHistoryMock).not.toHaveBeenCalled();
    expect(chart().dataset.historyExhausted).toBe("false");
  });

  it("asks for nothing on open when the market has been closed for days", async () => {
    // The requested window ends today; the last close inside it is days old. Anchoring the
    // default range to that close puts its start before the year already loaded, and every single
    // page view opens with a history request for the gap between them.
    vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    expect(fetchStockDetailsMock).toHaveBeenCalledWith(
      "AAPL",
      { from: "2025-08-31", to: "2026-08-31" },
      expect.anything(),
    );
    expect(fetchDailyPriceHistoryMock).not.toHaveBeenCalled();
  });

  it("loads older history when a pan reaches the edge, and keeps the range framed where it was", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    fetchDailyPriceHistoryMock.mockResolvedValue([
      bar("2024-09-03", 120),
      bar("2025-03-03", 130),
    ]);
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");
    const framedBefore = chart().dataset.fitKey;

    await user.click(screen.getByTestId("pan-past-edge"));

    // One more year, measured from what is loaded — not a jump to the whole horizon.
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledWith(
      "AAPL",
      { from: "2024-08-28", to: "2025-08-27" },
      expect.anything(),
    );
    await waitFor(() => expect(chart().dataset.pointCount).toBe("8"));
    expect(chart().dataset.firstDate).toBe("2024-09-03");
    // Arriving history is not a reason to reframe: the window the user navigated to is theirs.
    expect(chart().dataset.fitKey).toBe(framedBefore);
    expect(chart().dataset.frameFrom).toBe("2025-08-28");
  });

  it("fills a wide zoom-out in one request sized to the viewport", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    fetchDailyPriceHistoryMock.mockResolvedValue([bar("2005-06-01", 20)]);
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    await user.click(screen.getByTestId("zoom-out-past-edge"));

    // Thousands of empty bars means years, asked for at once rather than a year at a time — and
    // still not the whole horizon.
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledWith(
      "AAPL",
      { from: "2005-05-09", to: "2025-08-27" },
      expect.anything(),
    );
    await waitFor(() => expect(chart().dataset.pointCount).toBe("7"));
    expect(chart().dataset.firstDate).toBe("2005-06-01");
  });

  it("does not refetch history it already holds", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    fetchDailyPriceHistoryMock.mockResolvedValue([bar("2024-09-03", 120)]);
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    await user.click(screen.getByTestId("pan-past-edge"));
    await waitFor(() => expect(chart().dataset.pointCount).toBe("7"));
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);

    // Panning back and forth across a range that is already loaded costs nothing. The edge is
    // reported on every animation frame of a drag, so this is the difference between one request
    // and hundreds.
    await user.click(screen.getByRole("radio", { name: "1M" }));
    await user.click(screen.getByRole("radio", { name: "1Y" }));
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of edge reports into a single outstanding request", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    let release: (rows: DailyPriceResponse[]) => void = () => {};
    fetchDailyPriceHistoryMock.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    fetchDailyPriceHistoryMock.mockResolvedValue([bar("2005-06-01", 20)]);
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    // A fast drag past the edge, then a zoom-out, while the first load is still outstanding.
    await user.click(screen.getByTestId("pan-past-edge"));
    await user.click(screen.getByTestId("pan-past-edge"));
    await user.click(screen.getByTestId("zoom-out-past-edge"));
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);

    release([bar("2024-09-03", 120)]);
    // The widest ask survives and runs once; the duplicates collapsed into it.
    await waitFor(() =>
      expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(2),
    );
    expect(fetchDailyPriceHistoryMock).toHaveBeenLastCalledWith(
      "AAPL",
      expect.objectContaining({ to: "2024-08-27" }),
      expect.anything(),
    );
  });

  it("stops at the 30-year boundary and never asks for anything older", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    fetchDailyPriceHistoryMock.mockResolvedValue([bar("1997-01-02", 5)]);
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    await user.click(screen.getByRole("radio", { name: "MAX" }));
    await waitFor(() => expect(chart().dataset.historyExhausted).toBe("true"));

    const requested = fetchDailyPriceHistoryMock.mock.calls.map(
      (call) => call[1].from,
    );
    expect(requested.every((from) => from >= HISTORY_BOUNDS.start)).toBe(true);

    // Once the boundary is reached, further navigation asks for nothing at all.
    const before = fetchDailyPriceHistoryMock.mock.calls.length;
    await user.click(screen.getByTestId("pan-past-edge"));
    await user.click(screen.getByTestId("zoom-out-past-edge"));
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(before);
  });

  it("stops at a security's first trading day, before the boundary", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    // Nothing older exists: the window before the security's real history can only come back
    // empty, and asking again would repeat that answer for every remaining year.
    fetchDailyPriceHistoryMock.mockResolvedValue([]);
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    await user.click(screen.getByTestId("pan-past-edge"));
    await waitFor(() => expect(chart().dataset.historyExhausted).toBe("true"));
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId("pan-past-edge"));
    await user.click(screen.getByTestId("zoom-out-past-edge"));
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);
    expect(chart().dataset.pointCount).toBe("6");
  });

  it("extends the enabled overlays with the newly loaded history", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    fetchDailyPriceHistoryMock.mockResolvedValue([bar("2024-09-03", 120)]);
    fetchDailyTechnicalHistoryMock.mockResolvedValue([
      { date: "2024-09-03", sma50d: 118, rsi7d: 52.5, rsi14d: 48.1 },
      { date: "2024-09-04", sma50d: 119, rsi7d: 53.5, rsi14d: 49.1 },
    ]);
    fetchIntrinsicValueBlendHistoryMock.mockResolvedValue([
      {
        valuationDate: "2024-09-03",
        sourceDataAsOf: "2024-09-02T22:00:00.000Z",
        blendId: "BALANCED",
        valuePerShare: 130,
        currency: "USD",
      },
    ]);
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    const panel = screen.getByRole("dialog", { name: "Indicators" });
    await user.click(within(panel).getByRole("checkbox", { name: "RSI 14D" }));
    await user.click(within(panel).getByRole("checkbox", { name: "SMA 50D" }));
    await user.keyboard("{Escape}");

    // Two RSI points and two SMA points over the details window, one Balanced pair.
    expect(chart().dataset.overlays).toBe("SMA_50D:2,RSI_14D:1,BALANCED:2");

    await user.click(screen.getByTestId("pan-past-edge"));
    await waitFor(() => expect(chart().dataset.pointCount).toBe("7"));

    // Every enabled series grew with the price history — the oscillator included — and the
    // warm-up day that has no RSI 14D value stays absent rather than becoming a zero.
    expect(chart().dataset.overlays).toBe("SMA_50D:4,RSI_14D:3,BALANCED:3");
  });

  async function openIndicators(user: ReturnType<typeof setupUser>) {
    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");
    await user.click(screen.getByRole("button", { name: /Indicators/ }));
    return screen.getByRole("dialog", { name: "Indicators" });
  }

  it("offers the whole canonical catalog in its ordered groups", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);

    expect(
      Array.from(panel.querySelectorAll("legend")).map(
        (legend) => legend.textContent,
      ),
    ).toEqual([
      "Moving averages — Daily",
      "Moving averages — Weekly",
      "Oscillators",
      "Intrinsic Value — Blends",
      "Intrinsic Value — Models",
    ]);

    const options = within(panel).getAllByRole("checkbox");
    expect(options).toHaveLength(SELECTABLE_SERIES_CATALOG.length);
    // Price is the always-visible base series and is never offered as an option.
    expect(within(panel).queryByRole("checkbox", { name: /Price/ })).toBeNull();
  });

  it("enables Balanced by default and nothing else", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);

    const checked = within(panel)
      .getAllByRole("checkbox")
      .filter((box) => (box as HTMLInputElement).checked);
    expect(checked).toHaveLength(1);
    expect(chart().dataset.overlays).toBe("BALANCED:2");
    expect(chart().dataset.overlayLabels).toBe("Balanced");
  });

  it("marks an unavailable entry disabled without hiding or substituting it", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);

    // The fixture has no SMA 100D, no 200W and no Graham history. The accessible name of an
    // unavailable option carries the "Unavailable" marker, which is exactly the point.
    for (const name of [
      "SMA 100D Unavailable",
      "SMA 200W Unavailable",
      "RSI 21D Unavailable",
      "Graham Unavailable",
      "Dividend Unavailable",
      "Dividend Discount (DDM) Unavailable",
    ]) {
      const option = within(panel).getByRole("checkbox", {
        name,
      }) as HTMLInputElement;
      expect(option.disabled).toBe(true);
    }
    // Every entry is still rendered, and the disabled ones are exactly the ones carrying the
    // marker. Asserting the partition rather than a fixed count keeps this honest when the
    // catalog grows: nothing is hidden, and no entry is both disabled and unmarked.
    const all = within(panel).getAllByRole("checkbox") as HTMLInputElement[];
    const disabled = all.filter((option) => option.disabled);
    expect(all).toHaveLength(SELECTABLE_SERIES_CATALOG.length);
    expect(within(panel).getAllByText("Unavailable")).toHaveLength(
      disabled.length,
    );
    expect(disabled.length).toBeGreaterThan(0);
    expect(disabled.length).toBeLessThan(all.length);

    // Available entries stay enabled.
    for (const name of ["SMA 50D", "SMA 20W", "Balanced", "DCF (FCFF)"]) {
      expect(
        (within(panel).getByRole("checkbox", { name }) as HTMLInputElement)
          .disabled,
      ).toBe(false);
    }

    // Clicking a disabled entry cannot substitute another series onto the chart.
    await user.click(
      within(panel).getByRole("checkbox", { name: "SMA 100D Unavailable" }),
    );
    expect(chart().dataset.overlays).toBe("BALANCED:2");
  });

  it("switches between a daily and a weekly moving average", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);

    await user.click(within(panel).getByRole("checkbox", { name: "SMA 50D" }));
    expect(chart().dataset.overlays).toBe("SMA_50D:2,BALANCED:2");
    expect(chart().dataset.overlayLabels).toBe("SMA 50D,Balanced");

    await user.click(within(panel).getByRole("checkbox", { name: "SMA 50D" }));
    await user.click(within(panel).getByRole("checkbox", { name: "SMA 20W" }));
    // A weekly series is its own identity, not a relabelled daily one.
    expect(chart().dataset.overlays).toBe("SMA_20W:2,BALANCED:2");
    expect(chart().dataset.overlayLabels).toBe("SMA 20W,Balanced");
  });

  it("draws technical and intrinsic-value overlays simultaneously with distinct colours", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);

    await user.click(within(panel).getByRole("checkbox", { name: "SMA 200D" }));
    await user.click(within(panel).getByRole("checkbox", { name: "EMA 50W" }));
    await user.click(
      within(panel).getByRole("checkbox", { name: "DCF (FCFF)" }),
    );

    // Canonical catalog order, not click order.
    expect(chart().dataset.overlays).toBe(
      "SMA_200D:1,EMA_50W:1,BALANCED:2,DCF_FCFF:1",
    );
    expect(chart().dataset.overlayLabels).toBe(
      "SMA 200D,EMA 50W,Balanced,DCF (FCFF)",
    );
    const colors = chart().dataset.overlayColors!.split(",");
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("removes an overlay when it is deselected", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);

    await user.click(within(panel).getByRole("checkbox", { name: "SMA 50D" }));
    expect(chart().dataset.overlays).toBe("SMA_50D:2,BALANCED:2");

    await user.click(within(panel).getByRole("checkbox", { name: "Balanced" }));
    expect(chart().dataset.overlays).toBe("SMA_50D:2");

    await user.click(within(panel).getByRole("checkbox", { name: "SMA 50D" }));
    // Price remains the base series with no overlays at all.
    expect(chart().dataset.overlays).toBe("");
    expect(Number(chart().dataset.pointCount)).toBeGreaterThan(0);
  });

  it("keeps every oscillator toggle off by default, in canonical order", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);

    const oscillators = within(panel).getAllByRole("checkbox", {
      name: /^RSI/,
    }) as HTMLInputElement[];
    expect(
      oscillators.map((option) =>
        option.closest("label")?.textContent?.trim(),
      ),
    ).toEqual(["RSI 7D", "RSI 14D", "RSI 21D Unavailable"]);
    for (const option of oscillators) {
      expect(option.checked).toBe(false);
    }
    // Availability is per period: 7D and 14D have evaluable points, 21D never warmed up.
    expect(oscillators[0]?.disabled).toBe(false);
    expect(oscillators[1]?.disabled).toBe(false);
    expect(oscillators[2]?.disabled).toBe(true);
  });

  it("routes RSI to the oscillator pane beside price overlays, canonically ordered", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);

    await user.click(within(panel).getByRole("checkbox", { name: "RSI 14D" }));
    await user.click(within(panel).getByRole("checkbox", { name: "RSI 7D" }));
    await user.click(within(panel).getByRole("checkbox", { name: "SMA 50D" }));

    // Catalog order, not click order; the oscillator pane never replaces the price overlays.
    expect(chart().dataset.overlays).toBe(
      "SMA_50D:2,RSI_7D:2,RSI_14D:1,BALANCED:2",
    );
    expect(chart().dataset.overlayPanes).toBe(
      "PRICE_OVERLAY,OSCILLATOR_PANE,OSCILLATOR_PANE,PRICE_OVERLAY",
    );
    const colors = chart().dataset.overlayColors!.split(",");
    expect(new Set(colors).size).toBe(colors.length);
  });

  it("toggles each RSI period independently through the full lifecycle", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    const panel = await openIndicators(user);
    await user.click(within(panel).getByRole("checkbox", { name: "Balanced" }));

    await user.click(within(panel).getByRole("checkbox", { name: "RSI 7D" }));
    expect(chart().dataset.overlays).toBe("RSI_7D:2");

    await user.click(within(panel).getByRole("checkbox", { name: "RSI 14D" }));
    expect(chart().dataset.overlays).toBe("RSI_7D:2,RSI_14D:1");

    // Deselecting one period removes only its line.
    await user.click(within(panel).getByRole("checkbox", { name: "RSI 7D" }));
    expect(chart().dataset.overlays).toBe("RSI_14D:1");

    // Deselecting the last period leaves the price chart with no oscillator at all.
    await user.click(within(panel).getByRole("checkbox", { name: "RSI 14D" }));
    expect(chart().dataset.overlays).toBe("");
    expect(chart().dataset.overlayPanes).toBe("");

    // And the cycle repeats without accumulating anything.
    await user.click(within(panel).getByRole("checkbox", { name: "RSI 14D" }));
    expect(chart().dataset.overlays).toBe("RSI_14D:1");
    expect(chart().dataset.overlayPanes).toBe("OSCILLATOR_PANE");
  });

  it("shows a layout-shaped loading state while the request is in flight", () => {
    fetchStockDetailsMock.mockReturnValue(new Promise(() => {}));

    render(<StockDetails symbol="AAPL" />);

    expect(
      screen.getByRole("status", { name: "Loading stock details" }),
    ).toBeDefined();
  });

  it("treats a 404 as an unsupported stock, not an error", async () => {
    fetchStockDetailsMock.mockRejectedValue(new ApiError(404, "not found"));

    render(<StockDetails symbol="GHOST" />);

    expect(
      await screen.findByRole("heading", { name: "Stock not found" }),
    ).toBeDefined();
    expect(screen.getByText(/GHOST is not in the supported stock catalog/)).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Back to Dashboard" }).getAttribute("href"),
    ).toBe("/dashboard");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers a retry for transient failures and recovers on success", async () => {
    fetchStockDetailsMock
      .mockRejectedValueOnce(new ApiError(503, "unavailable"))
      .mockResolvedValueOnce(detailsFixture());
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);

    expect(
      await screen.findByRole("heading", { name: "Something went wrong" }),
    ).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("heading", { level: 1, name: /AAPL/ }),
    ).toBeDefined();
    expect(fetchStockDetailsMock).toHaveBeenCalledTimes(2);
  });

  it("survives a security with minimal catalog data and no derived series", async () => {
    fetchStockDetailsMock.mockResolvedValue({
      security: {
        id: "sec-2",
        symbol: "NEWCO",
        name: "New Company",
        exchangeCode: "NYSE",
        currency: "USD",
        type: "STOCK",
        isAdr: false,
        isActivelyTrading: false,
      },
      history: { ...HISTORY_BOUNDS },
      prices: [bar("2026-08-28", 10)],
      technicals: [],
      intrinsicValues: [],
      intrinsicValueBlends: [],
    });

    render(<StockDetails symbol="NEWCO" />);
    await screen.findByRole("heading", { level: 1, name: /NEWCO/ });

    // One trading day: a price but no derivable change.
    expect(screen.getByText("$10.00")).toBeDefined();
    expect(screen.queryByText(/%\)/)).toBeNull();
    expect(screen.getByText("Not actively trading")).toBeDefined();
    expect(
      screen.getByText("No intrinsic-value estimates are available for this stock yet."),
    ).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Technicals" })).toBeNull();
    // The catalog stays discoverable even with no derived data: every entry is disabled and
    // marked unavailable rather than the control disappearing.
    expect(chart().dataset.overlays).toBe("");
    expect(screen.queryByText("Sector")).toBeNull();
    expect(screen.getAllByText("NYSE").length).toBeGreaterThan(0);
  });
});

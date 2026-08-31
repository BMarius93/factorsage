import type {
  DailyPriceResponse,
  SecurityResponse,
  StockDetailsResponse,
} from "@intrinsic/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../../lib/api/client";
import {
  fetchDailyPriceHistory,
  fetchDailyTechnicalHistory,
  fetchIntrinsicValueBlendHistory,
  fetchStockDetails,
} from "../api/stock-details-api";
import type { StockPriceChartProps } from "./StockPriceChart";
import { StockDetails } from "./StockDetails";

vi.mock("../api/stock-details-api", () => ({
  fetchStockDetails: vi.fn(),
  fetchDailyPriceHistory: vi.fn(),
  fetchDailyTechnicalHistory: vi.fn(),
  fetchIntrinsicValueBlendHistory: vi.fn(),
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
      data-loading={props.loading ? "true" : "false"}
    />
  ),
}));

const fetchStockDetailsMock = vi.mocked(fetchStockDetails);
const fetchDailyPriceHistoryMock = vi.mocked(fetchDailyPriceHistory);
const fetchDailyTechnicalHistoryMock = vi.mocked(fetchDailyTechnicalHistory);
const fetchIntrinsicValueBlendHistoryMock = vi.mocked(
  fetchIntrinsicValueBlendHistory,
);

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

/** Fixture anchored to the frozen test date 2026-08-28 (window 2025-08-28 → 2026-08-28). */
function detailsFixture(): StockDetailsResponse {
  return {
    security: { ...SECURITY },
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
    technicals: [
      { date: "2026-08-27", sma50d: 219 },
      { date: "2026-08-28", sma50d: 220, sma200d: 210, ema20d: 225 },
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

const EXTENDED_PRICES = [
  bar("2010-01-04", 50),
  bar("2022-08-30", 150),
  bar("2024-01-05", 180),
  bar("2026-08-28", 232),
];

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
  fetchDailyTechnicalHistoryMock.mockResolvedValue([]);
  fetchIntrinsicValueBlendHistoryMock.mockResolvedValue([]);
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

    expect(screen.getByText("Balanced")).toBeDefined();
    expect(screen.getByText("$290.00")).toBeDefined();
    // (290 - 232) / 232 = +25% upside against the latest close.
    expect(screen.getByText("+25.00% vs price")).toBeDefined();
    expect(screen.getByText("DCF (FCFF)")).toBeDefined();
    expect(screen.getByText(/Valuation as of Aug 28, 2026/)).toBeDefined();

    expect(screen.getByRole("heading", { name: "Technicals" })).toBeDefined();
    // "SMA 200" labels both the overlay toggle and the technicals row.
    expect(screen.getAllByText("SMA 200").length).toBeGreaterThan(1);
    // Close 232 vs SMA 50 of 220 → price sits 5.45% above.
    expect(screen.getByText("price +5.45%")).toBeDefined();

    expect(screen.getByText("Sector")).toBeDefined();
    expect(screen.getByText("Technology")).toBeDefined();
    expect(screen.getByText("41.2M")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "apple.com" }).getAttribute("href"),
    ).toBe("https://www.apple.com");
  });

  it("switches short ranges by filtering loaded data, without refetching", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    await user.click(screen.getByRole("radio", { name: "1M" }));
    expect(chart().dataset.pointCount).toBe("3");
    expect(chart().dataset.firstDate).toBe("2026-07-30");

    await user.click(screen.getByRole("radio", { name: "3M" }));
    expect(chart().dataset.pointCount).toBe("4");

    await user.click(screen.getByRole("radio", { name: "6M" }));
    expect(chart().dataset.pointCount).toBe("5");

    expect(fetchStockDetailsMock).toHaveBeenCalledTimes(1);
    expect(fetchDailyPriceHistoryMock).not.toHaveBeenCalled();
  });

  it("loads the full history once for long ranges and keeps it for later switches", async () => {
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
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledWith(
      "AAPL",
      { from: "1980-12-12", to: "2026-08-28" },
      expect.anything(),
    );

    releaseExtended(EXTENDED_PRICES);
    await waitFor(() => expect(chart().dataset.loading).toBe("false"));
    // 5Y keeps dates from 2021-08-28 onward.
    expect(chart().dataset.pointCount).toBe("3");
    expect(chart().dataset.firstDate).toBe("2022-08-30");

    await user.click(screen.getByRole("radio", { name: "MAX" }));
    expect(chart().dataset.pointCount).toBe("4");
    expect(chart().dataset.firstDate).toBe("2010-01-04");

    // Returning to a short range falls back to the detail window's own data.
    await user.click(screen.getByRole("radio", { name: "1Y" }));
    expect(chart().dataset.pointCount).toBe("6");

    await user.click(screen.getByRole("radio", { name: "5Y" }));
    expect(chart().dataset.pointCount).toBe("3");
    expect(fetchDailyPriceHistoryMock).toHaveBeenCalledTimes(1);
    expect(fetchStockDetailsMock).toHaveBeenCalledTimes(1);
  });

  it("drives chart overlays from the toggles", async () => {
    fetchStockDetailsMock.mockResolvedValue(detailsFixture());
    const user = setupUser();

    render(<StockDetails symbol="AAPL" />);
    await screen.findByTestId("price-chart");

    // The intrinsic overlay is on by default when blend data exists.
    expect(chart().dataset.overlays).toBe("intrinsic:2");

    await user.click(screen.getByRole("button", { name: "SMA 50" }));
    expect(chart().dataset.overlays).toBe("intrinsic:2,sma50:2");

    await user.click(screen.getByRole("button", { name: "Intrinsic value" }));
    expect(chart().dataset.overlays).toBe("sma50:2");
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
    expect(screen.queryByRole("group", { name: "Chart overlays" })).toBeNull();
    expect(screen.queryByText("Sector")).toBeNull();
    expect(screen.getAllByText("NYSE").length).toBeGreaterThan(0);
  });
});

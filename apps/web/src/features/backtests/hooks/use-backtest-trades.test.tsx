import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATE_LIMITED_COPY,
  rateLimited,
} from "../../../lib/api/__testing__/request-failures";
import {
  fetchBacktestTrades,
  fetchBacktestTradesCsv,
} from "../api/backtests-api";
import { testTradePage } from "../utils/backtest.test-helper";
import { useBacktestTrades } from "./use-backtest-trades";

vi.mock("../api/backtests-api", () => ({
  fetchBacktestTrades: vi.fn(),
  fetchBacktestTradesCsv: vi.fn(),
}));

const pushMock = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  usePathname: () => "/backtests/run-1",
  useSearchParams: () => searchParams,
}));

const fetchTradesMock = vi.mocked(fetchBacktestTrades);
const fetchCsvMock = vi.mocked(fetchBacktestTradesCsv);

beforeEach(() => {
  fetchTradesMock.mockReset();
  fetchTradesMock.mockResolvedValue(
    testTradePage({ symbols: ["AAPL", "MSFT"], unfilteredCount: 900 }),
  );
  fetchCsvMock.mockReset();
  pushMock.mockReset();
  searchParams = new URLSearchParams();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBacktestTrades — the filter and order live in the URL", () => {
  it("asks for exactly the page, filter and order the URL names", async () => {
    searchParams = new URLSearchParams(
      "tradesPage=2&tradesSymbol=AAPL&tradesAction=SELL&tradesOrder=asc",
    );
    const { result } = renderHook(() => useBacktestTrades("run-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    expect(fetchTradesMock).toHaveBeenCalledWith(
      "run-1",
      { page: 2, pageSize: 50, symbol: "AAPL", action: "SELL", order: "asc" },
      expect.anything(),
    );
    expect(result.current.controls).toMatchObject({
      symbol: "AAPL",
      action: "SELL",
      order: "asc",
      symbols: ["AAPL", "MSFT"],
      unfilteredCount: 900,
    });
  });

  it("sends an unfiltered request unchanged, and ignores values the log does not offer", async () => {
    searchParams = new URLSearchParams(
      "tradesAction=HOLD&tradesOrder=sideways&tradesSymbol=%20",
    );
    const { result } = renderHook(() => useBacktestTrades("run-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    expect(fetchTradesMock.mock.calls[0]?.[1]).toEqual({
      page: 1,
      pageSize: 50,
    });
    expect(result.current.controls).toMatchObject({
      symbol: null,
      action: null,
      order: "desc",
    });
  });

  it("reads a page size only when the footer offers it, so the control never claims another", async () => {
    for (const [asked, sent] of [
      ["100", 100],
      ["25", 25],
      ["200", 50],
      ["7", 50],
    ] as const) {
      fetchTradesMock.mockClear();
      searchParams = new URLSearchParams(`tradesPageSize=${asked}`);
      const { result, unmount } = renderHook(() =>
        useBacktestTrades("run-1", true),
      );
      await waitFor(() => expect(result.current.page).not.toBeNull());
      expect(fetchTradesMock.mock.calls[0]?.[1]).toEqual({
        page: 1,
        pageSize: sent,
      });
      unmount();
    }
  });

  it("returns to the first page whenever the filter or the order changes", async () => {
    searchParams = new URLSearchParams("tradesPage=4&tradesPageSize=100");
    const { result } = renderHook(() => useBacktestTrades("run-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    act(() => result.current.controls.setAction("FINAL_EXIT"));
    expect(pushMock).toHaveBeenLastCalledWith(
      "/backtests/run-1?tradesPageSize=100&tradesAction=FINAL_EXIT",
      { scroll: false },
    );

    act(() => result.current.controls.setSymbol("MSFT"));
    expect(pushMock).toHaveBeenLastCalledWith(
      "/backtests/run-1?tradesPageSize=100&tradesSymbol=MSFT",
      { scroll: false },
    );

    act(() => result.current.controls.setOrder("asc"));
    expect(pushMock).toHaveBeenLastCalledWith(
      "/backtests/run-1?tradesPageSize=100&tradesOrder=asc",
      { scroll: false },
    );
  });

  it("clears the filter but keeps the order, and writes no default into the URL", async () => {
    searchParams = new URLSearchParams(
      "tradesPage=3&tradesSymbol=AAPL&tradesAction=BUY&tradesOrder=asc",
    );
    const { result } = renderHook(() => useBacktestTrades("run-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    act(() => result.current.controls.clearFilters());
    expect(pushMock).toHaveBeenLastCalledWith(
      "/backtests/run-1?tradesOrder=asc",
      { scroll: false },
    );

    act(() => result.current.controls.setOrder("desc"));
    expect(pushMock).toHaveBeenLastCalledWith(
      "/backtests/run-1?tradesSymbol=AAPL&tradesAction=BUY",
      { scroll: false },
    );

    // Paging keeps the filter it pages through.
    act(() => result.current.setPage(4));
    expect(pushMock).toHaveBeenLastCalledWith(
      "/backtests/run-1?tradesPage=4&tradesSymbol=AAPL&tradesAction=BUY&tradesOrder=asc",
      { scroll: false },
    );
  });
});

describe("useBacktestTrades — the CSV export", () => {
  // jsdom has no object URLs; the two the download needs are installed for one test at a time.
  const original = {
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  afterEach(() => {
    URL.createObjectURL = original.createObjectURL;
    URL.revokeObjectURL = original.revokeObjectURL;
  });

  function stubDownloads() {
    const createObjectURL = vi.fn(() => "blob:trades");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const clicks: { download: string; href: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push({ download: this.download, href: this.href });
    });
    return { createObjectURL, revokeObjectURL, clicks };
  }

  it("downloads the filtered log under its contract name, busy until it is saved", async () => {
    const downloads = stubDownloads();
    let resolve: (blob: Blob) => void = () => undefined;
    fetchCsvMock.mockReturnValue(
      new Promise<Blob>((settle) => {
        resolve = settle;
      }),
    );
    searchParams = new URLSearchParams(
      "tradesPage=5&tradesSymbol=AAPL&tradesAction=SELL&tradesOrder=asc",
    );
    const { result } = renderHook(() =>
      useBacktestTrades("3f2a9c1d-5b7e-4c1a-9e2f-0123456789ab", true),
    );
    await waitFor(() => expect(result.current.page).not.toBeNull());

    act(() => result.current.controls.exportCsv());
    expect(result.current.controls.exporting).toBe(true);
    // The whole filtered log, not the page on screen: no page or page size is sent.
    expect(fetchCsvMock).toHaveBeenCalledWith(
      "3f2a9c1d-5b7e-4c1a-9e2f-0123456789ab",
      { symbol: "AAPL", action: "SELL", order: "asc" },
    );
    // A second press while the first is being written asks for nothing more.
    act(() => result.current.controls.exportCsv());
    expect(fetchCsvMock).toHaveBeenCalledTimes(1);

    const blob = new Blob(["Sequence\r\n"], { type: "text/csv" });
    await act(async () => {
      resolve(blob);
    });
    await waitFor(() => expect(result.current.controls.exporting).toBe(false));
    expect(downloads.createObjectURL).toHaveBeenCalledWith(blob);
    expect(downloads.clicks).toEqual([
      {
        download: "factorsage-trades-3f2a9c1d-AAPL-sell-oldest-first.csv",
        href: "blob:trades",
      },
    ]);
    expect(downloads.revokeObjectURL).toHaveBeenCalledWith("blob:trades");
    expect(result.current.controls.exportError).toBeNull();
  });

  it("says why an export failed, in the API's own words when it has them", async () => {
    stubDownloads();
    fetchCsvMock.mockRejectedValue(rateLimited());
    const { result } = renderHook(() => useBacktestTrades("run-1", true));
    await waitFor(() => expect(result.current.page).not.toBeNull());

    await act(async () => {
      result.current.controls.exportCsv();
    });
    await waitFor(() =>
      expect(result.current.controls.exportError).toBe(RATE_LIMITED_COPY),
    );
    expect(result.current.controls.exporting).toBe(false);

    fetchCsvMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => {
      result.current.controls.exportCsv();
    });
    await waitFor(() =>
      expect(result.current.controls.exportError).toBe(
        "The trades could not be exported. Try again in a moment.",
      ),
    );
  });
});

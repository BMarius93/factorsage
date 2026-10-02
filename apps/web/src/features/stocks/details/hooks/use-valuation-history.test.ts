import type {
  DailyValuationRatioResponse,
  ValuationRatioId,
} from "@intrinsic/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDailyFundamentalHistory,
  fetchDailyValuationHistory,
} from "../api/stock-details-api";
import { useValuationHistory } from "./use-valuation-history";

vi.mock("../api/stock-details-api", () => ({
  fetchDailyFundamentalHistory: vi.fn(),
  fetchDailyValuationHistory: vi.fn(),
}));

const fetchMock = vi.mocked(fetchDailyValuationHistory);

type Props = {
  symbol?: string;
  ratioId: ValuationRatioId | null;
  from: string;
  to: string;
};

const WINDOW = { from: "2025-08-28", to: "2026-08-28" };

const PE: DailyValuationRatioResponse[] = [
  { date: "2025-08-28", value: 18.25 },
  { date: "2026-08-27" },
  { date: "2026-08-28", value: 21.5 },
];
const PB: DailyValuationRatioResponse[] = [
  { date: "2025-08-28", value: 3.1 },
  { date: "2026-08-28", value: 2.75 },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function renderHistory(initial: Props) {
  return renderHook(
    (props: Props) =>
      useValuationHistory({ ...props, symbol: props.symbol ?? "AAPL" }),
    { initialProps: initial },
  );
}

/** The `[ratio, from, to]` of every request made, in order. */
function requests() {
  return fetchMock.mock.calls.map(([, window, ratio]) => [
    ratio,
    window.from,
    window.to,
  ]);
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(fetchDailyFundamentalHistory).mockReset();
});

describe("useValuationHistory", () => {
  it("asks for nothing until a ratio is chosen", () => {
    const { result } = renderHistory({ ratioId: null, ...WINDOW });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      rows: [],
      loaded: false,
      status: "idle",
    });
  });

  it("asks the valuation endpoint for the chosen ratio alone, over the history the page holds", async () => {
    fetchMock.mockResolvedValue(PE);
    const { result } = renderHistory({
      ratioId: "PRICE_TO_EARNINGS_TTM",
      ...WINDOW,
    });
    expect(result.current.status).toBe("loading");
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(requests()).toEqual([
      ["PRICE_TO_EARNINGS_TTM", WINDOW.from, WINDOW.to],
    ]);
    expect(result.current.rows).toEqual(PE);
    // Never the Fundamental Metric endpoint, whose lifecycle it shares.
    expect(fetchDailyFundamentalHistory).not.toHaveBeenCalled();
  });

  it("extends by the older gap alone, keeping every point it holds", async () => {
    fetchMock.mockResolvedValueOnce(PE);
    const { result, rerender } = renderHistory({
      ratioId: "PRICE_TO_EARNINGS_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    fetchMock.mockResolvedValueOnce([
      { date: "2024-08-28", value: 15.2 },
      { date: "2025-08-27" },
    ]);
    rerender({
      ratioId: "PRICE_TO_EARNINGS_TTM",
      from: "2024-08-28",
      to: WINDOW.to,
    });
    await waitFor(() => expect(result.current.rows).toHaveLength(5));

    expect(requests()).toEqual([
      ["PRICE_TO_EARNINGS_TTM", WINDOW.from, WINDOW.to],
      ["PRICE_TO_EARNINGS_TTM", "2024-08-28", "2025-08-27"],
    ]);
    expect(result.current.rows).toEqual([
      { date: "2024-08-28", value: 15.2 },
      { date: "2025-08-27" },
      ...PE,
    ]);
  });

  it("shows P/B when P/E is chosen first and its answer arrives after P/B's", async () => {
    const pe = deferred<DailyValuationRatioResponse[]>();
    const pb = deferred<DailyValuationRatioResponse[]>();
    fetchMock.mockReturnValueOnce(pe.promise).mockReturnValueOnce(pb.promise);
    const { result, rerender } = renderHistory({
      ratioId: "PRICE_TO_EARNINGS_TTM",
      ...WINDOW,
    });
    rerender({ ratioId: "PRICE_TO_BOOK", ...WINDOW });
    // The superseded request is aborted, not merely ignored.
    expect(fetchMock.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    expect(fetchMock.mock.calls[1]?.[3]?.signal?.aborted).toBe(false);

    await act(async () => pb.resolve(PB));
    await act(async () => pe.resolve(PE));

    expect(result.current.rows).toEqual(PB);
    expect(result.current.status).toBe("idle");
    expect(requests()).toEqual([
      ["PRICE_TO_EARNINGS_TTM", WINDOW.from, WINDOW.to],
      ["PRICE_TO_BOOK", WINDOW.from, WINDOW.to],
    ]);
  });

  it("asks for the new ratio's whole window, never another ratio's rows under its name", async () => {
    fetchMock.mockResolvedValueOnce(PE);
    const { result, rerender } = renderHistory({
      ratioId: "PRICE_TO_EARNINGS_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    rerender({ ratioId: "PRICE_TO_SALES_TTM", ...WINDOW });
    expect(result.current.rows).toEqual([]);
    expect(result.current.loaded).toBe(false);
    expect(result.current.status).toBe("loading");
  });

  it("reports a failure as a failure, not as an empty history, and retries the same interval", async () => {
    fetchMock.mockRejectedValueOnce(new Error("503"));
    const { result } = renderHistory({
      ratioId: "EV_TO_EBITDA_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.loaded).toBe(false);
    expect(result.current.rows).toEqual([]);

    fetchMock.mockResolvedValueOnce([{ date: "2026-08-28", value: -1.25 }]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.rows).toEqual([{ date: "2026-08-28", value: -1.25 }]);
    expect(requests()).toEqual([
      ["EV_TO_EBITDA_TTM", WINDOW.from, WINDOW.to],
      ["EV_TO_EBITDA_TTM", WINDOW.from, WINDOW.to],
    ]);
  });

  it("never shows or extends one security's ratio for another", async () => {
    fetchMock.mockResolvedValueOnce(PE);
    const { result, rerender } = renderHistory({
      ratioId: "PRICE_TO_EARNINGS_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    rerender({ symbol: "MSFT", ratioId: "PRICE_TO_EARNINGS_TTM", ...WINDOW });
    expect(result.current.rows).toEqual([]);
    expect(result.current.status).toBe("loading");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("MSFT");
    expect(requests()[1]).toEqual([
      "PRICE_TO_EARNINGS_TTM",
      WINDOW.from,
      WINDOW.to,
    ]);
  });

  it("drops everything when the ratio is cleared, and aborts what was in flight", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHistory({
      ratioId: "PRICE_TO_BOOK",
      ...WINDOW,
    });
    rerender({ ratioId: null, ...WINDOW });
    expect(fetchMock.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    expect(result.current).toMatchObject({
      rows: [],
      loaded: false,
      status: "idle",
    });
  });
});

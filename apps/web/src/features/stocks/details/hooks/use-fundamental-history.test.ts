import type {
  DailyFundamentalMetricResponse,
  FundamentalMetricId,
} from "@intrinsic/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDailyFundamentalHistory } from "../api/stock-details-api";
import { useFundamentalHistory } from "./use-fundamental-history";

vi.mock("../api/stock-details-api", () => ({
  fetchDailyFundamentalHistory: vi.fn(),
}));

const fetchMock = vi.mocked(fetchDailyFundamentalHistory);

type Props = {
  symbol?: string;
  metricId: FundamentalMetricId | null;
  from: string;
  to: string;
};

const WINDOW = { from: "2025-08-28", to: "2026-08-28" };

const ROIC: DailyFundamentalMetricResponse[] = [
  { date: "2025-08-28", value: 12 },
  { date: "2026-08-28", value: 18 },
];
const DEBT_TO_EQUITY: DailyFundamentalMetricResponse[] = [
  { date: "2025-08-28", value: 0.75 },
  { date: "2026-08-28" },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function renderHistory(initial: Props) {
  return renderHook(
    (props: Props) =>
      useFundamentalHistory({ ...props, symbol: props.symbol ?? "AAPL" }),
    { initialProps: initial },
  );
}

/** The `[metric, from, to]` of every request made, in order. */
function requests() {
  return fetchMock.mock.calls.map(([, window, metric]) => [
    metric,
    window.from,
    window.to,
  ]);
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("useFundamentalHistory", () => {
  it("asks for nothing until a metric is chosen", () => {
    const { result } = renderHistory({ metricId: null, ...WINDOW });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      rows: [],
      loaded: false,
      status: "idle",
    });
  });

  it("asks for exactly the chosen metric over the history the page holds", async () => {
    fetchMock.mockResolvedValue(ROIC);
    const { result } = renderHistory({ metricId: "ROIC_TTM", ...WINDOW });

    // Loading from the very first render: never "no values" before the answer.
    expect(result.current.status).toBe("loading");
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(requests()).toEqual([["ROIC_TTM", WINDOW.from, WINDOW.to]]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("AAPL");
    expect(result.current.rows).toEqual(ROIC);
    expect(result.current.status).toBe("idle");
  });

  it("extends by the gap alone when older price history arrives, and merges it in order", async () => {
    fetchMock.mockResolvedValueOnce(ROIC);
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    fetchMock.mockResolvedValueOnce([
      { date: "2024-08-28" },
      { date: "2025-08-27", value: 9 },
    ]);
    rerender({ metricId: "ROIC_TTM", from: "2024-08-28", to: WINDOW.to });
    await waitFor(() => expect(result.current.rows).toHaveLength(4));

    expect(requests()).toEqual([
      ["ROIC_TTM", WINDOW.from, WINDOW.to],
      // Only the interval the metric does not hold yet: up to the day before what it holds.
      ["ROIC_TTM", "2024-08-28", "2025-08-27"],
    ]);
    expect(result.current.rows.map((row) => row.date)).toEqual([
      "2024-08-28",
      "2025-08-27",
      "2025-08-28",
      "2026-08-28",
    ]);
  });

  it("never asks again for history it already holds", async () => {
    fetchMock.mockResolvedValue(ROIC);
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    // An unrelated rerender, and a watermark inside what is held, cost nothing.
    rerender({ metricId: "ROIC_TTM", ...WINDOW });
    rerender({ metricId: "ROIC_TTM", from: "2026-01-02", to: WINDOW.to });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("switches metric with a request of its own, and never shows the previous rows under it", async () => {
    fetchMock.mockResolvedValueOnce(ROIC);
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const debt = deferred<DailyFundamentalMetricResponse[]>();
    fetchMock.mockReturnValueOnce(debt.promise);
    rerender({ metricId: "DEBT_TO_EQUITY", ...WINDOW });

    // The render the switch happens in: ROIC's rows are gone, not relabelled.
    expect(result.current.rows).toEqual([]);
    expect(result.current.loaded).toBe(false);
    expect(result.current.status).toBe("loading");

    await act(async () => debt.resolve(DEBT_TO_EQUITY));
    expect(result.current.rows).toEqual(DEBT_TO_EQUITY);
    expect(requests()).toEqual([
      ["ROIC_TTM", WINDOW.from, WINDOW.to],
      ["DEBT_TO_EQUITY", WINDOW.from, WINDOW.to],
    ]);
  });

  it("lets only the newest request land when answers arrive out of order", async () => {
    const roic = deferred<DailyFundamentalMetricResponse[]>();
    const debt = deferred<DailyFundamentalMetricResponse[]>();
    const growth = deferred<DailyFundamentalMetricResponse[]>();
    fetchMock
      .mockReturnValueOnce(roic.promise)
      .mockReturnValueOnce(debt.promise)
      .mockReturnValueOnce(growth.promise);
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    rerender({ metricId: "DEBT_TO_EQUITY", ...WINDOW });
    rerender({ metricId: "REVENUE_GROWTH_TTM_YOY", ...WINDOW });

    // Every abandoned request is aborted, not merely ignored.
    const signals = fetchMock.mock.calls.map((call) => call[3]?.signal);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[2]?.aborted).toBe(false);

    await act(async () => growth.resolve([{ date: "2026-08-28", value: 7 }]));
    // The abandoned answers arrive last and change nothing.
    await act(async () => debt.resolve(DEBT_TO_EQUITY));
    await act(async () => roic.resolve(ROIC));

    expect(result.current.rows).toEqual([{ date: "2026-08-28", value: 7 }]);
    expect(result.current.status).toBe("idle");
  });

  it("reports a failure without inventing an empty history, and retries the same interval", async () => {
    fetchMock.mockRejectedValueOnce(new Error("503"));
    const { result } = renderHistory({ metricId: "ROIC_TTM", ...WINDOW });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.loaded).toBe(false);
    expect(result.current.rows).toEqual([]);

    fetchMock.mockResolvedValueOnce(ROIC);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(requests()).toEqual([
      ["ROIC_TTM", WINDOW.from, WINDOW.to],
      ["ROIC_TTM", WINDOW.from, WINDOW.to],
    ]);
    expect(result.current.status).toBe("idle");
  });

  it("keeps what it holds when an older gap fails, and asks for exactly that gap again", async () => {
    fetchMock.mockResolvedValueOnce(ROIC);
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    rerender({ metricId: "ROIC_TTM", from: "2024-08-28", to: WINDOW.to });
    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.rows).toEqual(ROIC);

    fetchMock.mockResolvedValueOnce([{ date: "2024-08-28", value: 5 }]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.rows).toHaveLength(3));
    expect(requests().slice(1)).toEqual([
      ["ROIC_TTM", "2024-08-28", "2025-08-27"],
      ["ROIC_TTM", "2024-08-28", "2025-08-27"],
    ]);
  });

  it("never shows one metric's failure under the next metric's name", async () => {
    fetchMock.mockRejectedValueOnce(new Error("503"));
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.status).toBe("error"));

    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    rerender({ metricId: "DEBT_TO_EQUITY", ...WINDOW });
    expect(result.current.status).toBe("loading");
  });

  it("never shows or extends one security's rows for another", async () => {
    fetchMock.mockResolvedValueOnce(ROIC);
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const msft = deferred<DailyFundamentalMetricResponse[]>();
    fetchMock.mockReturnValueOnce(msft.promise);
    rerender({ symbol: "MSFT", metricId: "ROIC_TTM", ...WINDOW });

    // Same metric, same window, another company: AAPL's readings are not MSFT's.
    expect(result.current.rows).toEqual([]);
    expect(result.current.loaded).toBe(false);
    expect(result.current.status).toBe("loading");

    await act(async () => msft.resolve([{ date: "2026-08-28", value: 31 }]));
    expect(result.current.rows).toEqual([{ date: "2026-08-28", value: 31 }]);
    // The whole window for the new security, never a gap merged into the old one's rows.
    expect(fetchMock.mock.calls.map(([symbol]) => symbol)).toEqual([
      "AAPL",
      "MSFT",
    ]);
    expect(requests()).toEqual([
      ["ROIC_TTM", WINDOW.from, WINDOW.to],
      ["ROIC_TTM", WINDOW.from, WINDOW.to],
    ]);
  });

  it("asks for the whole window again when its end moves, rather than extending rows that ended elsewhere", async () => {
    fetchMock.mockResolvedValueOnce(ROIC);
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    await waitFor(() => expect(result.current.loaded).toBe(true));

    const later = deferred<DailyFundamentalMetricResponse[]>();
    fetchMock.mockReturnValueOnce(later.promise);
    rerender({ metricId: "ROIC_TTM", from: WINDOW.from, to: "2026-08-31" });
    expect(result.current.rows).toEqual([]);
    expect(result.current.status).toBe("loading");

    await act(async () =>
      later.resolve([...ROIC, { date: "2026-08-31", value: 19 }]),
    );
    expect(result.current.rows).toHaveLength(3);
    expect(requests()).toEqual([
      ["ROIC_TTM", WINDOW.from, WINDOW.to],
      ["ROIC_TTM", WINDOW.from, "2026-08-31"],
    ]);
  });

  it("drops everything when the metric is cleared, and aborts what was in flight", async () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const { result, rerender } = renderHistory({
      metricId: "ROIC_TTM",
      ...WINDOW,
    });
    rerender({ metricId: null, ...WINDOW });
    expect(fetchMock.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
    expect(result.current).toMatchObject({
      rows: [],
      loaded: false,
      status: "idle",
    });
  });

  it("aborts the request in flight when the page goes away", () => {
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    const { unmount } = renderHistory({ metricId: "ROIC_TTM", ...WINDOW });
    unmount();
    expect(fetchMock.mock.calls[0]?.[3]?.signal?.aborted).toBe(true);
  });
});

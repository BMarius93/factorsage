import { act, renderHook, waitFor } from "@testing-library/react";
import type { BacktestRunSummaryResponse } from "@intrinsic/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBacktestRuns } from "../api/backtests-api";
import {
  BACKTEST_COLLECTION_POLL_INTERVAL_MS,
  useBacktestRuns,
} from "./use-backtest-runs";

vi.mock("../api/backtests-api", () => ({ fetchBacktestRuns: vi.fn() }));
const fetchMock = vi.mocked(fetchBacktestRuns);

const run = (status: BacktestRunSummaryResponse["status"]) =>
  ({ id: "run-1", status }) as BacktestRunSummaryResponse;

describe("useBacktestRuns polling (UI-048)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("re-reads while a run is in flight and stops once every run is terminal", async () => {
    fetchMock
      .mockResolvedValueOnce([run("RUNNING")])
      .mockResolvedValueOnce([run("COMPLETED")]);
    const { result } = renderHook(() => useBacktestRuns());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKTEST_COLLECTION_POLL_INTERVAL_MS);
    });
    await waitFor(() =>
      expect(result.current.runs[0]?.status).toBe("COMPLETED"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Everything is terminal: no further requests however long the page stays open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        BACKTEST_COLLECTION_POLL_INTERVAL_MS * 4,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never polls a collection with nothing in flight, and cleans up on unmount", async () => {
    fetchMock.mockResolvedValue([run("RUNNING")]);
    const { result, unmount } = renderHook(() => useBacktestRuns());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(
        BACKTEST_COLLECTION_POLL_INTERVAL_MS * 3,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

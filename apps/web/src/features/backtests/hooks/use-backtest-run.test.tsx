import {
  BACKTEST_PENDING_POLL_INTERVAL_MS,
  BACKTEST_RUNNING_POLL_INTERVAL_MS,
} from "@intrinsic/contracts";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testDetail,
  testLive,
  testProgress,
  testResult,
} from "../utils/backtest.test-helper";
import { fetchBacktestProgress, fetchBacktestRun } from "../api/backtests-api";
import { useBacktestRun } from "./use-backtest-run";

vi.mock("../api/backtests-api", () => ({
  fetchBacktestRun: vi.fn(),
  fetchBacktestProgress: vi.fn(),
}));

const fetchRunMock = vi.mocked(fetchBacktestRun);
const fetchProgressMock = vi.mocked(fetchBacktestProgress);

/** Lets every pending promise settle without letting a scheduled poll fire. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Runs the clock far enough for exactly the next scheduled poll to fire and settle. */
async function nextPoll(interval: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(interval);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchRunMock.mockReset();
  fetchProgressMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBacktestRun", () => {
  it("resumes a reloaded run from the persisted progress before any poll answers", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("RUNNING", {
        progress: {
          percent: 42,
          message: "Simulating 2023",
          simulatedThrough: "2023-06-30",
          sequence: 12,
          updatedAt: "2026-09-01T10:05:00.000Z",
        },
        live: testLive(),
      }),
    );
    fetchProgressMock.mockResolvedValue(testProgress("RUNNING", 12));

    const { result } = renderHook(() => useBacktestRun("run-1"));
    await flush();

    expect(result.current.loadStatus).toBe("ready");
    expect(result.current.status).toBe("RUNNING");
    expect(result.current.percent).toBe(42);
    expect(result.current.message).toBe("Simulating 2023");
    expect(result.current.live?.curve).toHaveLength(4);
    expect(fetchProgressMock).not.toHaveBeenCalled();
  });

  it("drops a checkpoint whose sequence lost the race to a newer one", async () => {
    fetchRunMock.mockResolvedValue(testDetail("QUEUED"));
    fetchProgressMock
      .mockResolvedValueOnce(
        testProgress("RUNNING", 5, {
          percent: 50,
          message: "Half way",
          live: testLive({ portfolioReturnPercent: 12 }),
        }),
      )
      .mockResolvedValueOnce(
        testProgress("RUNNING", 3, {
          percent: 20,
          message: "Stale",
          live: testLive({ portfolioReturnPercent: 4 }),
        }),
      );

    const { result } = renderHook(() => useBacktestRun("run-1"));
    await flush();
    await nextPoll(BACKTEST_PENDING_POLL_INTERVAL_MS);

    expect(result.current.percent).toBe(50);

    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS);

    expect(fetchProgressMock).toHaveBeenCalledTimes(2);
    // The older checkpoint answered second and must not have overwritten the newer state.
    expect(result.current.percent).toBe(50);
    expect(result.current.message).toBe("Half way");
    expect(result.current.progress?.sequence).toBe(5);
    expect(result.current.live?.portfolioReturnPercent).toBe(12);
  });

  it("stops polling on a terminal status and refetches the detail exactly once", async () => {
    fetchRunMock
      .mockResolvedValueOnce(testDetail("QUEUED"))
      .mockResolvedValueOnce(
        testDetail("COMPLETED", {
          completedAt: "2026-09-01T10:20:00.000Z",
          result: testResult(),
        }),
      );
    fetchProgressMock
      .mockResolvedValueOnce(testProgress("RUNNING", 1, { percent: 30 }))
      .mockResolvedValueOnce(testProgress("COMPLETED", 2, { percent: 100 }));

    const { result } = renderHook(() => useBacktestRun("run-1"));
    await flush();
    await nextPoll(BACKTEST_PENDING_POLL_INTERVAL_MS);
    expect(result.current.status).toBe("RUNNING");

    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    await flush();

    expect(result.current.status).toBe("COMPLETED");
    expect(result.current.polling).toBe(false);
    expect(result.current.run?.result?.summary.totalTrades).toBe(42);
    expect(fetchRunMock).toHaveBeenCalledTimes(2);

    // Nothing is scheduled any more, however long the page stays open.
    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS * 20);
    expect(fetchProgressMock).toHaveBeenCalledTimes(2);
    expect(fetchRunMock).toHaveBeenCalledTimes(2);
  });

  it("drops the page-load snapshot the moment a terminal poll clears it", async () => {
    // The detail fetched at page load carries a live snapshot. The terminal progress payload
    // deliberately carries none, and that null must win: otherwise the load-time curve would be
    // rendered as the finished run's result for the poll interval before the detail is refetched.
    fetchRunMock
      .mockResolvedValueOnce(
        testDetail("RUNNING", {
          live: testLive({ simulatedThrough: "2024-03-15" }),
        }),
      )
      .mockResolvedValueOnce(
        testDetail("COMPLETED", {
          completedAt: "2026-09-01T10:20:00.000Z",
          result: testResult(),
        }),
      );
    fetchProgressMock.mockResolvedValueOnce(
      testProgress("COMPLETED", 2, { percent: 100, live: null }),
    );

    const { result } = renderHook(() => useBacktestRun("run-1"));
    await flush();
    expect(result.current.live?.simulatedThrough).toBe("2024-03-15");

    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    expect(result.current.status).toBe("COMPLETED");
    expect(result.current.live).toBeNull();
  });

  it("keeps the rendered page through a transient failure and retries on the next tick", async () => {
    fetchRunMock.mockResolvedValue(
      testDetail("RUNNING", { live: testLive({ portfolioReturnPercent: 7 }) }),
    );
    fetchProgressMock
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(
        testProgress("RUNNING", 9, {
          percent: 80,
          live: testLive({ portfolioReturnPercent: 15 }),
        }),
      );

    const { result } = renderHook(() => useBacktestRun("run-1"));
    await flush();
    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS);

    // The lost request is invisible: the run is still rendered exactly as it was.
    expect(result.current.loadStatus).toBe("ready");
    expect(result.current.status).toBe("RUNNING");
    expect(result.current.live?.portfolioReturnPercent).toBe(7);

    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS);

    expect(result.current.live?.portfolioReturnPercent).toBe(15);
    expect(result.current.percent).toBe(80);
  });

  it("never overlaps requests: the next tick is scheduled only after the previous one settles", async () => {
    fetchRunMock.mockResolvedValue(testDetail("RUNNING"));
    let resolveFirst:
      ((value: ReturnType<typeof testProgress>) => void) | undefined;
    fetchProgressMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(testProgress("RUNNING", 2, { percent: 60 }));

    renderHook(() => useBacktestRun("run-1"));
    await flush();
    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    expect(fetchProgressMock).toHaveBeenCalledTimes(1);

    // Several intervals pass while the first request is still in flight.
    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS * 5);
    expect(fetchProgressMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.(testProgress("RUNNING", 1, { percent: 40 }));
      await vi.advanceTimersByTimeAsync(0);
    });
    await nextPoll(BACKTEST_RUNNING_POLL_INTERVAL_MS);
    expect(fetchProgressMock).toHaveBeenCalledTimes(2);
  });

  it("treats a run belonging to another account as missing, not as an error", async () => {
    const { ApiError } = await import("../../../lib/api/client");
    fetchRunMock.mockRejectedValue(new ApiError(404, "Backtest not found"));

    const { result } = renderHook(() => useBacktestRun("run-1"));
    await flush();

    expect(result.current.loadStatus).toBe("not-found");
    expect(fetchProgressMock).not.toHaveBeenCalled();
  });
});

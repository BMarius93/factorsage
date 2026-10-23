import type {
  DashboardActivityEventResponse,
  DashboardActivityResponse,
  MonitorActivityKind,
} from "@intrinsic/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMonitorActivity } from "../api/dashboard-api";
import {
  ACTIVITY_PAGE_SIZE,
  ACTIVITY_REFRESH_READS,
  useMonitorActivity,
} from "./use-monitor-activity";

vi.mock("../api/dashboard-api", () => ({
  fetchMonitorActivity: vi.fn(),
}));

const fetchMock = vi.mocked(fetchMonitorActivity);

/** Event `n` of an imaginary feed, observed on `sessionDate`. */
function event(
  n: number,
  sessionDate = "2026-10-13",
): DashboardActivityEventResponse {
  return { id: `event-${n}`, sessionDate } as DashboardActivityEventResponse;
}

function answer(
  events: DashboardActivityEventResponse[],
  extra: Partial<DashboardActivityResponse> = {},
): DashboardActivityResponse {
  return {
    viewer: "GUEST",
    generatedAt: "2026-10-14T00:00:00.000Z",
    events,
    ...extra,
  };
}

const ids = (hook: {
  result: { current: { events: readonly { id: string }[] } };
}) => hook.result.current.events.map((item) => item.id);

beforeEach(() => {
  fetchMock.mockReset();
});

async function openFeed(
  first: DashboardActivityResponse,
  monitorId: string | null = null,
  kind: MonitorActivityKind | null = null,
) {
  fetchMock.mockResolvedValueOnce(first);
  const hook = renderHook(() => useMonitorActivity(monitorId, kind));
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return hook;
}

describe("useMonitorActivity — a refresh re-reads what the reader holds (DB-2)", () => {
  it("puts new events above what is shown, keeping every older page the reader opened", async () => {
    const hook = await openFeed(
      answer([event(10), event(9)], { nextCursor: "c1" }),
    );
    fetchMock.mockResolvedValueOnce(
      answer([event(8, "2026-10-12"), event(7, "2026-10-12")], {
        nextCursor: "c2",
      }),
    );
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook)).toHaveLength(4));

    fetchMock.mockResolvedValueOnce(
      answer([
        event(12, "2026-10-14"),
        event(11, "2026-10-14"),
        event(10),
        event(9),
        event(8, "2026-10-12"),
        event(7, "2026-10-12"),
      ]),
    );
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.arrivals).toEqual({
        above: 2,
        within: 0,
        backlog: false,
      }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith({ through: "event-7" });
    expect(ids(hook)).toEqual([
      "event-12",
      "event-11",
      "event-10",
      "event-9",
      "event-8",
      "event-7",
    ]);
    // The older pages are still open: the next one continues where they stopped.
    expect(hook.result.current.hasMore).toBe(true);
    act(() => hook.result.current.acknowledge());
    expect(hook.result.current.arrivals).toBeNull();
  });

  it("shows an event written late for a session the reader passed, inside that session", async () => {
    const hook = await openFeed(
      answer([event(10), event(9, "2026-10-12")], { nextCursor: "c1" }),
    );
    fetchMock.mockResolvedValueOnce(
      answer([event(10), event(15, "2026-10-12"), event(9, "2026-10-12")]),
    );
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.arrivals).toEqual({
        above: 0,
        within: 1,
        backlog: false,
      }),
    );
    expect(ids(hook)).toEqual(["event-10", "event-15", "event-9"]);
  });

  it("changes nothing when the range is as it was", async () => {
    const hook = await openFeed(answer([event(10), event(9)]));
    const before = hook.result.current.events;
    fetchMock.mockResolvedValueOnce(answer([event(10), event(9)]));
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({ through: "event-9" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.events).toBe(before);
    expect(hook.result.current.arrivals).toBeNull();
  });

  it("continues a long range with its cursor, and offers the newest page when it is too long to re-read", async () => {
    const hook = await openFeed(answer([event(1)]));
    for (let read = 0; read < ACTIVITY_REFRESH_READS; read += 1) {
      fetchMock.mockResolvedValueOnce(
        answer([event(100 + read, "2026-10-14")], {
          nextCursor: `range-${read}`,
        }),
      );
    }
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.arrivals?.backlog).toBe(true),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1 + ACTIVITY_REFRESH_READS);
    expect(fetchMock).toHaveBeenLastCalledWith({
      through: "event-1",
      cursor: `range-${ACTIVITY_REFRESH_READS - 2}`,
    });
    // Nothing was replaced on a partial read; taking the newest page ends the backlog.
    expect(ids(hook)).toEqual(["event-1"]);
    act(() => hook.result.current.acknowledge());
    expect(hook.result.current.arrivals?.backlog).toBe(true);
    fetchMock.mockResolvedValueOnce(answer([event(200)]));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.arrivals).toBeNull());
    expect(ids(hook)).toEqual(["event-200"]);
  });

  it("starts over when the event that ended the range has left the feed", async () => {
    const hook = await openFeed(answer([event(10), event(9)]));
    fetchMock.mockResolvedValueOnce(answer([]));
    fetchMock.mockResolvedValueOnce(answer([event(20)]));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(ids(hook)).toEqual(["event-20"]));
    expect(fetchMock).toHaveBeenLastCalledWith(
      { limit: ACTIVITY_PAGE_SIZE },
      expect.anything(),
    );
  });

  it("drops what aged out of the rolling window and keeps the rest, rather than starting over", async () => {
    const hook = await openFeed(
      answer(
        [
          event(10, "2026-10-13"),
          event(9, "2026-09-16"),
          event(8, "2026-09-15"),
        ],
        { windowStart: "2026-09-15" },
      ),
    );
    // The window moved to Sep 16: the event the range ended on is older than its first day, so the
    // API answers with everything the window still holds — and one new event above it.
    fetchMock.mockResolvedValueOnce(
      answer(
        [
          event(11, "2026-10-14"),
          event(10, "2026-10-13"),
          event(9, "2026-09-16"),
        ],
        {
          windowStart: "2026-09-16",
        },
      ),
    );
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(ids(hook)).toEqual(["event-11", "event-10", "event-9"]),
    );
    expect(fetchMock).toHaveBeenLastCalledWith({ through: "event-8" });
    expect(hook.result.current.arrivals).toEqual({
      above: 1,
      within: 0,
      backlog: false,
    });
  });

  it("keeps an older page that arrived while the range was being re-read", async () => {
    const hook = await openFeed(
      answer([event(10), event(9)], { nextCursor: "c1" }),
    );
    let resolveRange: (value: DashboardActivityResponse) => void = () =>
      undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRange = resolve;
        }),
    );
    act(() => hook.result.current.refresh());
    fetchMock.mockResolvedValueOnce(answer([event(8, "2026-10-12")]));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook)).toHaveLength(3));
    await act(async () => {
      resolveRange(answer([event(11, "2026-10-14"), event(10), event(9)]));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(ids(hook)).toEqual(["event-11", "event-10", "event-9", "event-8"]),
    );
  });

  it("reports a failed look, and the next one that succeeds clears it", async () => {
    const hook = await openFeed(answer([event(10)]));
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.refreshFailed).toBe(true));
    expect(ids(hook)).toEqual(["event-10"]);

    fetchMock.mockResolvedValueOnce(answer([event(10)]));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.refreshFailed).toBe(false));
  });

  it("drops a look that began before the filter changed", async () => {
    fetchMock.mockResolvedValueOnce(answer([event(10)]));
    const hook = renderHook(
      ({ kind }: { kind: MonitorActivityKind | null }) =>
        useMonitorActivity(null, kind),
      { initialProps: { kind: null as MonitorActivityKind | null } },
    );
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    let resolveLook: (value: DashboardActivityResponse) => void = () =>
      undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLook = resolve;
        }),
    );
    act(() => hook.result.current.refresh());

    fetchMock.mockResolvedValueOnce(answer([event(5, "2026-10-01")]));
    hook.rerender({ kind: "RESOLVED" });
    await waitFor(() => expect(ids(hook)).toEqual(["event-5"]));
    await act(async () => {
      resolveLook(answer([event(11, "2026-10-14"), event(10)]));
      await Promise.resolve();
    });
    expect(ids(hook)).toEqual(["event-5"]);
    expect(hook.result.current.arrivals).toBeNull();
  });
});

describe("useMonitorActivity — older pages", () => {
  it("starts one request for two triggers in the same moment", async () => {
    const hook = await openFeed(answer([event(10)], { nextCursor: "c1" }));
    fetchMock.mockResolvedValueOnce(answer([event(9)], { nextCursor: "c2" }));
    act(() => {
      hook.result.current.loadMore();
      hook.result.current.loadMore();
    });
    await waitFor(() => expect(ids(hook)).toEqual(["event-10", "event-9"]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hook.result.current.olderPages).toBe(1);
  });

  it("shows a failed older page and retries the same cursor", async () => {
    const hook = await openFeed(answer([event(10)], { nextCursor: "c1" }));
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.loadMoreFailed).toBe(true));
    expect(hook.result.current.hasMore).toBe(true);

    fetchMock.mockResolvedValueOnce(answer([event(9)]));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook)).toEqual(["event-10", "event-9"]));
    expect(hook.result.current.loadMoreFailed).toBe(false);
    expect(fetchMock).toHaveBeenLastCalledWith(
      { limit: ACTIVITY_PAGE_SIZE, cursor: "c1" },
      expect.anything(),
    );
  });

  it("never appends an older page of the previous filter to the new one", async () => {
    fetchMock.mockResolvedValueOnce(answer([event(10)], { nextCursor: "c1" }));
    const hook = renderHook(
      ({ kind }: { kind: MonitorActivityKind | null }) =>
        useMonitorActivity(null, kind),
      { initialProps: { kind: null as MonitorActivityKind | null } },
    );
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    let resolveOlder: (value: DashboardActivityResponse) => void = () =>
      undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOlder = resolve;
        }),
    );
    act(() => hook.result.current.loadMore());
    expect(hook.result.current.loadingMore).toBe(true);

    fetchMock.mockResolvedValueOnce(answer([event(3)]));
    hook.rerender({ kind: "ACTIVATED" });
    await waitFor(() => expect(ids(hook)).toEqual(["event-3"]));
    expect(hook.result.current.loadingMore).toBe(false);
    await act(async () => {
      resolveOlder(answer([event(9)]));
      await Promise.resolve();
    });
    expect(ids(hook)).toEqual(["event-3"]);
  });

  it("de-duplicates an older page that overlaps what is shown", async () => {
    const hook = await openFeed(
      answer([event(10), event(9)], { nextCursor: "c1" }),
    );
    fetchMock.mockResolvedValueOnce(answer([event(9), event(8)]));
    act(() => hook.result.current.loadMore());
    await waitFor(() =>
      expect(ids(hook)).toEqual(["event-10", "event-9", "event-8"]),
    );
  });
});

describe("useMonitorActivity — the Monitor and Event filters", () => {
  it("sends both filters on every read, so the API pages and merges the filtered history", async () => {
    const hook = await openFeed(
      answer([event(10)], { nextCursor: "c1" }),
      "monitor-a",
      "RESOLVED",
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      { monitorId: "monitor-a", kind: "RESOLVED", limit: ACTIVITY_PAGE_SIZE },
      expect.anything(),
    );

    fetchMock.mockResolvedValueOnce(answer([event(9)]));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook)).toHaveLength(2));
    expect(fetchMock).toHaveBeenLastCalledWith(
      {
        monitorId: "monitor-a",
        kind: "RESOLVED",
        limit: ACTIVITY_PAGE_SIZE,
        cursor: "c1",
      },
      expect.anything(),
    );

    fetchMock.mockResolvedValueOnce(answer([event(10), event(9)]));
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        monitorId: "monitor-a",
        kind: "RESOLVED",
        through: "event-9",
      }),
    );
  });

  it("starts over from the newest page when a filter changes, and ignores an answer for the old one", async () => {
    let resolveStale: (page: DashboardActivityResponse) => void = () =>
      undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    const hook = renderHook(
      ({ kind }: { kind: MonitorActivityKind | null }) =>
        useMonitorActivity(null, kind),
      { initialProps: { kind: null as MonitorActivityKind | null } },
    );

    fetchMock.mockResolvedValueOnce(answer([event(50)]));
    hook.rerender({ kind: "ACTIVATED" });
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(ids(hook)).toEqual(["event-50"]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      { kind: "ACTIVATED", limit: ACTIVITY_PAGE_SIZE },
      expect.anything(),
    );

    // The unfiltered read answers late: it is not this feed any more.
    await act(async () => {
      resolveStale(answer([event(100)]));
      await Promise.resolve();
    });
    expect(ids(hook)).toEqual(["event-50"]);
  });
});

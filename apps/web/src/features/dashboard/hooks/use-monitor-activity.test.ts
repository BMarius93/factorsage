import type {
  DashboardActivityEventResponse,
  DashboardActivityResponse,
  MonitorActivityKind,
} from "@intrinsic/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMonitorActivity } from "../api/dashboard-api";
import {
  ACTIVITY_CATCH_UP_READS,
  ACTIVITY_PAGE_SIZE,
  useMonitorActivity,
} from "./use-monitor-activity";

vi.mock("../api/dashboard-api", () => ({
  fetchMonitorActivity: vi.fn(),
}));

const fetchMock = vi.mocked(fetchMonitorActivity);

/** Event `n`, written `n`-th: a larger `n` was written later. */
function event(
  n: number,
  sessionDate = "2026-10-13",
): DashboardActivityEventResponse {
  return {
    id: `event-${n}`,
    sequence: String(n),
    sessionDate,
  } as DashboardActivityEventResponse;
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

describe("useMonitorActivity — arrivals are merged, never lost (DB-2)", () => {
  it("places new events above what is shown, keeping every older page the reader opened", async () => {
    const hook = await openFeed(
      answer([event(10), event(9)], { nextCursor: "c1", watermark: "8" }),
    );
    fetchMock.mockResolvedValueOnce(
      answer([event(8, "2026-10-12"), event(7, "2026-10-12")], {
        nextCursor: "c2",
      }),
    );
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook)).toHaveLength(4));

    fetchMock.mockResolvedValueOnce(
      answer([event(12, "2026-10-14"), event(11, "2026-10-14")], {
        watermark: "11",
      }),
    );
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.arrivals).toEqual({
        above: 2,
        within: 0,
        backlog: false,
      }),
    );
    expect(ids(hook)).toEqual([
      "event-12",
      "event-11",
      "event-10",
      "event-9",
      "event-8",
      "event-7",
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith({ since: "8" });

    // The next look continues from the watermark that answer gave.
    fetchMock.mockResolvedValueOnce(answer([], { watermark: "12" }));
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({ since: "11" }),
    );
    // Nothing new is not news: the count stands until the reader goes to the newest.
    expect(hook.result.current.arrivals?.above).toBe(2);
    act(() => hook.result.current.acknowledge());
    expect(hook.result.current.arrivals).toBeNull();
  });

  it("places an event written late for an older session inside that session", async () => {
    const hook = await openFeed(
      answer([event(10, "2026-10-13"), event(9, "2026-10-12")], {
        nextCursor: "c1",
        watermark: "9",
      }),
    );
    fetchMock.mockResolvedValueOnce(
      answer([event(8, "2026-10-09")], { nextCursor: "c2" }),
    );
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(ids(hook)).toHaveLength(3));

    // Written after everything shown, for October 12: newest-written first within its session.
    fetchMock.mockResolvedValueOnce(
      answer([event(15, "2026-10-12")], { watermark: "9" }),
    );
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.arrivals).toEqual({
        above: 0,
        within: 1,
        backlog: false,
      }),
    );
    expect(ids(hook)).toEqual(["event-10", "event-15", "event-9", "event-8"]);
  });

  it("leaves an arrival older than everything loaded to paging while older pages remain", async () => {
    const hook = await openFeed(
      answer([event(10), event(9, "2026-10-12")], {
        nextCursor: "c1",
        watermark: "9",
      }),
    );
    fetchMock.mockResolvedValueOnce(
      answer([event(20, "2026-10-01")], { watermark: "9" }),
    );
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({ since: "9" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    // Placing it now would leave a gap above it; the cursor reaches it in its place.
    expect(ids(hook)).toEqual(["event-10", "event-9"]);
    expect(hook.result.current.arrivals).toBeNull();
  });

  it("places it when the whole history is loaded, and never counts an event already shown", async () => {
    const hook = await openFeed(
      answer([event(10), event(9, "2026-10-12")], { watermark: "9" }),
    );
    fetchMock.mockResolvedValueOnce(
      answer([event(10), event(20, "2026-10-01")], { watermark: "9" }),
    );
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(ids(hook)).toEqual(["event-10", "event-9", "event-20"]),
    );
    expect(hook.result.current.arrivals).toEqual({
      above: 0,
      within: 1,
      backlog: false,
    });
  });

  it("keeps reading while a backlog continues, then offers the newest page", async () => {
    const hook = await openFeed(answer([event(1)], { watermark: "1" }));
    for (let read = 0; read < ACTIVITY_CATCH_UP_READS; read += 1) {
      const n = 100 + read * 10;
      fetchMock.mockResolvedValueOnce(
        answer([event(n, "2026-10-14")], {
          watermark: String(n),
          truncated: true,
        }),
      );
    }
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.arrivals?.backlog).toBe(true),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1 + ACTIVITY_CATCH_UP_READS);
    expect(hook.result.current.arrivals?.above).toBe(ACTIVITY_CATCH_UP_READS);
    // Going to the newest after a backlog reads the newest page, which ends it.
    act(() => hook.result.current.acknowledge());
    expect(hook.result.current.arrivals?.backlog).toBe(true);
    fetchMock.mockResolvedValueOnce(answer([event(200)], { watermark: "150" }));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.arrivals).toBeNull());
    expect(ids(hook)).toEqual(["event-200"]);
  });

  it("reports a failed look, and the next one that succeeds clears it", async () => {
    const hook = await openFeed(answer([event(10)], { watermark: "10" }));
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.refreshFailed).toBe(true));
    expect(ids(hook)).toEqual(["event-10"]);

    fetchMock.mockResolvedValueOnce(answer([], { watermark: "10" }));
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(hook.result.current.refreshFailed).toBe(false));
  });

  it("drops a look that began before the filter changed", async () => {
    fetchMock.mockResolvedValueOnce(answer([event(10)], { watermark: "10" }));
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

    fetchMock.mockResolvedValueOnce(
      answer([event(5, "2026-10-01")], { watermark: "5" }),
    );
    hook.rerender({ kind: "RESOLVED" });
    await waitFor(() => expect(ids(hook)).toEqual(["event-5"]));
    await act(async () => {
      resolveLook(answer([event(11, "2026-10-14")], { watermark: "11" }));
      await Promise.resolve();
    });
    expect(ids(hook)).toEqual(["event-5"]);
    expect(hook.result.current.arrivals).toBeNull();
  });
});

describe("useMonitorActivity — older pages", () => {
  it("starts one request for two triggers in the same moment", async () => {
    const hook = await openFeed(
      answer([event(10)], { nextCursor: "c1", watermark: "10" }),
    );
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
    const hook = await openFeed(
      answer([event(10)], { nextCursor: "c1", watermark: "10" }),
    );
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
    fetchMock.mockResolvedValueOnce(
      answer([event(10)], { nextCursor: "c1", watermark: "10" }),
    );
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

    fetchMock.mockResolvedValueOnce(answer([event(3)], { watermark: "3" }));
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
      answer([event(10), event(9)], { nextCursor: "c1", watermark: "9" }),
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
      answer([event(10)], { nextCursor: "c1", watermark: "10" }),
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

    fetchMock.mockResolvedValueOnce(answer([], { watermark: "10" }));
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith({
        monitorId: "monitor-a",
        kind: "RESOLVED",
        since: "10",
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

    fetchMock.mockResolvedValueOnce(answer([event(50)], { watermark: "50" }));
    hook.rerender({ kind: "ACTIVATED" });
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(ids(hook)).toEqual(["event-50"]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      { kind: "ACTIVATED", limit: ACTIVITY_PAGE_SIZE },
      expect.anything(),
    );

    // The unfiltered read answers late: it is not this feed any more.
    await act(async () => {
      resolveStale(answer([event(100)], { watermark: "100" }));
      await Promise.resolve();
    });
    expect(ids(hook)).toEqual(["event-50"]);
  });
});

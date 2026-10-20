import type {
  DashboardActivityEventResponse,
  DashboardActivityResponse,
} from "@intrinsic/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMonitorActivity } from "../api/dashboard-api";
import { ACTIVITY_PAGE_SIZE, useMonitorActivity } from "./use-monitor-activity";

vi.mock("../api/dashboard-api", () => ({
  fetchMonitorActivity: vi.fn(),
}));

const fetchMock = vi.mocked(fetchMonitorActivity);

/** Event `n` of an imaginary feed, newest first: a larger `n` is newer. */
function event(n: number): DashboardActivityEventResponse {
  return { id: `event-${n}` } as DashboardActivityEventResponse;
}

/** The feed's newest page when `newest` is the newest event, and the older pages behind it. */
function newestPage(newest: number): DashboardActivityResponse {
  return {
    events: Array.from({ length: ACTIVITY_PAGE_SIZE }, (_, index) =>
      event(newest - index),
    ),
    nextCursor: `before-${newest - ACTIVITY_PAGE_SIZE + 1}`,
  } as DashboardActivityResponse;
}

function olderPage(fromNewest: number): DashboardActivityResponse {
  return {
    events: Array.from({ length: ACTIVITY_PAGE_SIZE }, (_, index) =>
      event(fromNewest - index),
    ),
    nextCursor: `before-${fromNewest - ACTIVITY_PAGE_SIZE + 1}`,
  } as DashboardActivityResponse;
}

beforeEach(() => {
  fetchMock.mockReset();
});

async function openFeed(newest = 100) {
  fetchMock.mockResolvedValueOnce(newestPage(newest));
  const hook = renderHook(() => useMonitorActivity(null));
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  return hook;
}

describe("useMonitorActivity — refresh while browsing history (DB-2)", () => {
  it("replaces the list with the newest page on refresh while only the first page is loaded", async () => {
    const hook = await openFeed(100);
    expect(hook.result.current.paused).toBe(false);

    fetchMock.mockResolvedValueOnce(newestPage(103));
    act(() => hook.result.current.refresh());

    await waitFor(() =>
      expect(hook.result.current.events[0]?.id).toBe("event-103"),
    );
    expect(hook.result.current.events).toHaveLength(ACTIVITY_PAGE_SIZE);
  });

  it("keeps every loaded older event and pauses replacement once older activity is shown", async () => {
    const hook = await openFeed(100);
    fetchMock.mockResolvedValueOnce(olderPage(85));
    act(() => hook.result.current.loadMore());
    await waitFor(() =>
      expect(hook.result.current.events).toHaveLength(2 * ACTIVITY_PAGE_SIZE),
    );
    expect(hook.result.current.paused).toBe(true);

    // Three sessions' worth of new events arrive; the timer fires.
    fetchMock.mockResolvedValueOnce(newestPage(103));
    act(() => hook.result.current.refresh());

    await waitFor(() =>
      expect(hook.result.current.newActivity).toEqual({ count: 3 }),
    );
    // Nothing moved: the same thirty events, in the same order, and the next older page still
    // continues from where the reader was.
    expect(hook.result.current.events).toHaveLength(2 * ACTIVITY_PAGE_SIZE);
    expect(hook.result.current.events[0]?.id).toBe("event-100");
    expect(hook.result.current.events.at(-1)?.id).toBe("event-71");
    expect(hook.result.current.hasMore).toBe(true);
  });

  it("does not invent a count when more than a page arrived", async () => {
    const hook = await openFeed(100);
    fetchMock.mockResolvedValueOnce(olderPage(85));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.paused).toBe(true));

    fetchMock.mockResolvedValueOnce(newestPage(140));
    act(() => hook.result.current.refresh());

    await waitFor(() =>
      expect(hook.result.current.newActivity).toEqual({ count: null }),
    );
    expect(hook.result.current.events[0]?.id).toBe("event-100");
  });

  it("reports nothing new when the newest page is unchanged", async () => {
    const hook = await openFeed(100);
    fetchMock.mockResolvedValueOnce(olderPage(85));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.paused).toBe(true));

    fetchMock.mockResolvedValueOnce(newestPage(100));
    act(() => hook.result.current.refresh());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(hook.result.current.newActivity).toBeNull();
    expect(hook.result.current.events).toHaveLength(2 * ACTIVITY_PAGE_SIZE);
  });

  it("an explicit reload shows the newest page and resumes automatic refresh", async () => {
    const hook = await openFeed(100);
    fetchMock.mockResolvedValueOnce(olderPage(85));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.paused).toBe(true));

    fetchMock.mockResolvedValueOnce(newestPage(103));
    act(() => hook.result.current.reload());

    await waitFor(() =>
      expect(hook.result.current.events[0]?.id).toBe("event-103"),
    );
    expect(hook.result.current.paused).toBe(false);
    expect(hook.result.current.newActivity).toBeNull();
    expect(hook.result.current.events).toHaveLength(ACTIVITY_PAGE_SIZE);

    // Back to normal: the next timer tick replaces the list again.
    fetchMock.mockResolvedValueOnce(newestPage(104));
    act(() => hook.result.current.refresh());
    await waitFor(() =>
      expect(hook.result.current.events[0]?.id).toBe("event-104"),
    );
  });
});

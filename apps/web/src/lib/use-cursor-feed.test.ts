import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCursorFeed, type CursorPage } from "./use-cursor-feed";

type Row = { readonly id: string };
const row = (id: string): Row => ({ id });

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function render(
  fetchPage: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<CursorPage<Row, { total: number }>>,
  key = "a",
) {
  return renderHook(
    (props: { key: string }) =>
      useCursorFeed<Row, { total: number }>({
        key: props.key,
        fetchPage,
        getId: (item) => item.id,
      }),
    { initialProps: { key } },
  );
}

describe("useCursorFeed", () => {
  it("reads the first page, keeps its meta, and appends older pages de-duplicated", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [row("3"), row("2")],
        nextCursor: "c1",
        meta: { total: 4 },
      })
      .mockResolvedValueOnce({ items: [row("2"), row("1")], nextCursor: "c2" });
    const hook = render(fetchPage);
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    expect(hook.result.current.meta).toEqual({ total: 4 });
    act(() => hook.result.current.loadMore());
    await waitFor(() =>
      expect(hook.result.current.items.map((item) => item.id)).toEqual([
        "3",
        "2",
        "1",
      ]),
    );
    expect(fetchPage).toHaveBeenLastCalledWith("c1", expect.any(AbortSignal));
    expect(hook.result.current.hasMore).toBe(true);
    expect(hook.result.current.olderPages).toBe(1);
  });

  it("guards older pages with a ref, so triggers in one frame start one request", async () => {
    const older = deferred<CursorPage<Row, { total: number }>>();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [row("2")], nextCursor: "c1" })
      .mockReturnValueOnce(older.promise);
    const hook = render(fetchPage);
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    act(() => {
      hook.result.current.loadMore();
      hook.result.current.loadMore();
      hook.result.current.loadMore();
    });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    await act(async () => {
      older.resolve({ items: [row("1")] });
      await older.promise;
    });
    expect(hook.result.current.hasMore).toBe(false);
    // Nothing more to read: further triggers do nothing.
    act(() => hook.result.current.loadMore());
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("aborts and ignores an older page when the key changes, and starts the new feed with no cursor", async () => {
    const older = deferred<CursorPage<Row, { total: number }>>();
    const signals: AbortSignal[] = [];
    const fetchPage = vi.fn(
      (cursor: string | undefined, signal: AbortSignal) => {
        signals.push(signal);
        if (cursor === "c1") return older.promise;
        return Promise.resolve({
          items: [row(signals.length > 1 ? "b1" : "a1")],
          nextCursor: "c1",
        });
      },
    );
    const hook = render(fetchPage);
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    act(() => hook.result.current.loadMore());
    hook.rerender({ key: "b" });
    expect(hook.result.current.status).toBe("loading");
    expect(hook.result.current.hasMore).toBe(false);
    expect(signals[1]!.aborted).toBe(true);
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    await act(async () => {
      older.resolve({ items: [row("a0")] });
      await Promise.resolve();
    });
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["b1"]);
  });

  it("is an error only when nothing is shown, and keeps the list when a reload fails", async () => {
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ items: [row("1")] })
      .mockRejectedValueOnce(new Error("down again"));
    const hook = render(fetchPage);
    await waitFor(() => expect(hook.result.current.status).toBe("error"));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    act(() => hook.result.current.reload());
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await act(async () => {
      await Promise.resolve();
    });
    expect(hook.result.current.status).toBe("ready");
    expect(hook.result.current.items.map((item) => item.id)).toEqual(["1"]);
  });

  it("reports a failed older page and retries the same cursor", async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [row("2")], nextCursor: "c1" })
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ items: [row("1")] });
    const hook = render(fetchPage);
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.loadMoreFailed).toBe(true));
    act(() => hook.result.current.loadMore());
    await waitFor(() => expect(hook.result.current.items).toHaveLength(2));
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([
      undefined,
      "c1",
      "c1",
    ]);
    expect(hook.result.current.loadMoreFailed).toBe(false);
  });

  it("merges outside changes de-duplicated by id", async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce({ items: [row("1")] });
    const hook = render(fetchPage);
    await waitFor(() => expect(hook.result.current.status).toBe("ready"));
    act(() =>
      hook.result.current.update((items) => [row("2"), ...items, row("1")]),
    );
    expect(hook.result.current.items.map((item) => item.id)).toEqual([
      "2",
      "1",
    ]);
  });
});

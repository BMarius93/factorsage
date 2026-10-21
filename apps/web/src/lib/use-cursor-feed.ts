"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** One page of a cursor-paged collection, as a feed reads it. */
export type CursorPage<TItem, TMeta = undefined> = {
  readonly items: readonly TItem[];
  /** Pass back for the next page; absent on the last. */
  readonly nextCursor?: string;
  /** Anything the first page says about the whole feed (counts, a watermark). */
  readonly meta?: TMeta;
};

export type CursorFeedStatus = "loading" | "ready" | "error";

export type CursorFeedOptions<TItem, TMeta> = {
  /**
   * Everything that decides which items the feed holds — its filters and its scope. A new key
   * starts the feed over from its first page; a response for an older key is never applied.
   */
  readonly key: string;
  readonly fetchPage: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<CursorPage<TItem, TMeta>>;
  /** A stable identity: what de-duplicates pages that overlap. */
  readonly getId: (item: TItem) => string;
};

export type CursorFeed<TItem, TMeta> = {
  readonly status: CursorFeedStatus;
  readonly items: readonly TItem[];
  /** What the most recent first page said about the feed. */
  readonly meta: TMeta | undefined;
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  /** The last request for older items failed; `loadMore` retries it. */
  readonly loadMoreFailed: boolean;
  /** Older pages appended since the feed last started from its first page. */
  readonly olderPages: number;
  /** Counts first pages applied: changes whenever the feed starts over from its newest items. */
  readonly restarts: number;
  /** Appends the next page. Ignored while one is already on its way. */
  readonly loadMore: () => void;
  /** Reads the first page again; what is shown stays until it answers. */
  readonly reload: () => void;
  /**
   * Changes the loaded items in place — merging arrivals a feed learned of another way. The result
   * is de-duplicated by id, keeping the first copy.
   */
  readonly update: (
    change: (items: readonly TItem[]) => readonly TItem[],
  ) => void;
};

/**
 * A collection read one cursor page at a time, which never shows the same item twice and never
 * applies an answer that has stopped being the right one.
 *
 * - **One request at a time.** `loadMore` is guarded by a ref, not by state, so two triggers in the
 *   same frame — a scroll observer and a click, or a double click — start one request.
 * - **Stale answers are dropped.** A new `key` or a `reload` aborts what is in flight and bumps a
 *   generation; an answer from an older generation changes nothing.
 * - **De-duplicated by id.** Pages that overlap (a feed that grew between two reads) merge cleanly.
 * - **Failures are visible.** A first page that fails with nothing shown is `error`; an older page
 *   that fails sets `loadMoreFailed`, and the next `loadMore` retries the same cursor.
 */
export function useCursorFeed<TItem, TMeta = undefined>({
  key,
  fetchPage,
  getId,
}: CursorFeedOptions<TItem, TMeta>): CursorFeed<TItem, TMeta> {
  const [status, setStatus] = useState<CursorFeedStatus>("loading");
  const [items, setItems] = useState<readonly TItem[]>([]);
  const [meta, setMeta] = useState<TMeta | undefined>(undefined);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [olderPages, setOlderPages] = useState(0);
  const [restarts, setRestarts] = useState(0);
  const [attempt, setAttempt] = useState(0);

  const generation = useRef(0);
  const inFlight = useRef<AbortController | null>(null);
  const shownKey = useRef<string | null>(null);
  // The latest callbacks, read without making `loadMore` change identity every render.
  const fetchRef = useRef(fetchPage);
  const idRef = useRef(getId);
  const cursorRef = useRef(cursor);
  useEffect(() => {
    fetchRef.current = fetchPage;
    idRef.current = getId;
    cursorRef.current = cursor;
  });

  const unique = useCallback((list: readonly TItem[]): TItem[] => {
    const seen = new Set<string>();
    const kept: TItem[] = [];
    for (const item of list) {
      const id = idRef.current(item);
      if (!seen.has(id)) {
        seen.add(id);
        kept.push(item);
      }
    }
    return kept;
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    inFlight.current?.abort();
    inFlight.current = null;
    setLoadingMore(false);
    setLoadMoreFailed(false);
    // Another filter is another feed: what was shown no longer answers it, and its cursor would
    // continue the wrong feed.
    if (shownKey.current !== key) {
      setStatus("loading");
      setCursor(undefined);
      cursorRef.current = undefined;
    }
    const controller = new AbortController();
    fetchRef
      .current(undefined, controller.signal)
      .then((page) => {
        if (current !== generation.current) return;
        shownKey.current = key;
        setItems(unique(page.items));
        setMeta(page.meta);
        setCursor(page.nextCursor);
        cursorRef.current = page.nextCursor;
        setOlderPages(0);
        setRestarts((count) => count + 1);
        setStatus("ready");
      })
      .catch(() => {
        if (current !== generation.current || controller.signal.aborted) {
          return;
        }
        // A failed refresh keeps what is shown; only a feed with nothing to show is an error.
        if (shownKey.current !== key) {
          setStatus("error");
        }
      });
    return () => controller.abort();
  }, [key, attempt, unique]);

  useEffect(
    () => () => {
      inFlight.current?.abort();
    },
    [],
  );

  const loadMore = useCallback(() => {
    const from = cursorRef.current;
    if (from === undefined || inFlight.current !== null) return;
    const current = generation.current;
    const controller = new AbortController();
    inFlight.current = controller;
    setLoadingMore(true);
    setLoadMoreFailed(false);
    fetchRef
      .current(from, controller.signal)
      .then((page) => {
        if (current !== generation.current) return;
        setItems((shown) => unique([...shown, ...page.items]));
        setCursor(page.nextCursor);
        cursorRef.current = page.nextCursor;
        setOlderPages((count) => count + 1);
      })
      .catch(() => {
        if (current !== generation.current || controller.signal.aborted) {
          return;
        }
        setLoadMoreFailed(true);
      })
      .finally(() => {
        if (inFlight.current === controller) {
          inFlight.current = null;
          setLoadingMore(false);
        }
      });
  }, [unique]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  const update = useCallback(
    (change: (shown: readonly TItem[]) => readonly TItem[]) => {
      setItems((shown) => unique(change(shown)));
    },
    [unique],
  );

  return {
    status,
    items,
    meta,
    hasMore: cursor !== undefined,
    loadingMore,
    loadMoreFailed,
    olderPages,
    restarts,
    loadMore,
    reload,
    update,
  };
}

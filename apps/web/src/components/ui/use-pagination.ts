"use client";

import { useEffect, useMemo, useState } from "react";
import { COLLECTION_PAGE_SIZES } from "./CollectionFooter";

/**
 * Client-side paging for a collection the page already holds in memory.
 *
 * Deliberately not a data-loading concern: every collection endpoint returns the caller's
 * own records in one response, so paging here is presentation and needs no contract change.
 * If a collection ever outgrows one response, this is the seam to replace.
 */
export function usePagination<TRow>(
  rows: readonly TRow[],
  /**
   * Changes whenever the rows are re-queried (a search, a new order). A new key returns to the first
   * page: page 3 of one search result means nothing for the next.
   */
  resetKey?: string,
) {
  const [page, setPage] = useState(1);
  const [pageKey, setPageKey] = useState(resetKey);
  if (pageKey !== resetKey) {
    setPageKey(resetKey);
    setPage(1);
  }
  const [pageSize, setPageSize] = useState<number>(COLLECTION_PAGE_SIZES[0]);

  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));

  // Deleting the last record on the last page, or shrinking the page size, must not strand
  // the user on a page that no longer exists.
  useEffect(() => {
    if (page > pageCount) {
      setPage(pageCount);
    }
  }, [page, pageCount]);

  const visibleRows = useMemo(() => {
    const start = (Math.min(page, pageCount) - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageCount, pageSize]);

  return {
    page: Math.min(page, pageCount),
    pageSize,
    visibleRows,
    total: rows.length,
    setPage,
    setPageSize: (size: number) => {
      setPageSize(size);
      setPage(1);
    },
  };
}

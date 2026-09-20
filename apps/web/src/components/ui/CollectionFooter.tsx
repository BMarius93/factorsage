"use client";

import actions from "./actions.module.css";
import styles from "./CollectionFooter.module.css";
import { SelectControl, type SelectControlOption } from "./SelectControl";

export const COLLECTION_PAGE_SIZES = [25, 50, 100] as const;

const PAGE_SIZE_OPTIONS: readonly SelectControlOption[] =
  COLLECTION_PAGE_SIZES.map((size) => ({
    value: String(size),
    label: String(size),
  }));

type CollectionFooterProps = {
  /** Total rows in the collection, before paging. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  readonly onPageChange: (page: number) => void;
  readonly onPageSizeChange: (pageSize: number) => void;
  /** Plural noun for the collection, e.g. "runs". Used in the range summary. */
  readonly noun: string;
  readonly testId?: string;
};

/**
 * The one collection footer: page size, the visible range, and page navigation.
 *
 * Presentation only — it draws a position in a collection and reports the moves a reader asks
 * for. Where the rows come from is the caller's business: most collections slice rows the page
 * already holds (`usePagination`), while the backtest trade log pages in the database and hands
 * this the server's own `page`, `pageSize` and `totalCount`. Both look and read identically,
 * which is the point.
 */
export function CollectionFooter({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  noun,
  testId,
}: CollectionFooterProps) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <div
      className={styles.footer}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <div className={styles.group}>
        <SelectControl
          id={`${testId ?? noun}-page-size`}
          label="Rows"
          value={String(pageSize)}
          onChange={(value) => onPageSizeChange(Number(value))}
          options={PAGE_SIZE_OPTIONS}
        />
        <span className={styles.range}>
          Showing {first}–{last} of {total} {noun}
        </span>
      </div>
      {pageCount > 1 ? (
        <div className={styles.group}>
          <button
            type="button"
            className={actions.action}
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </button>
          <span className={styles.page}>
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className={actions.action}
            disabled={page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

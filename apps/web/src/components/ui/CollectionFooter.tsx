"use client";

import actions from "./actions.module.css";
import styles from "./CollectionFooter.module.css";

export const COLLECTION_PAGE_SIZES = [25, 50, 100] as const;

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
 * Paging is applied in the browser over rows the page already holds — no contract changes
 * and no extra requests — so this is presentation, not a data-loading concern. `usePagination`
 * owns the slicing.
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
        <label className={styles.label} htmlFor={`${testId ?? noun}-page-size`}>
          Rows
        </label>
        <select
          id={`${testId ?? noun}-page-size`}
          className={styles.select}
          value={pageSize}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          {COLLECTION_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
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

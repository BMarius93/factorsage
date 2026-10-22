"use client";

import actions from "./actions.module.css";
import styles from "./CollectionFooter.module.css";
import { SelectControl, type SelectControlOption } from "./SelectControl";

/** The page sizes every collection offers. */
export const COLLECTION_PAGE_SIZES = [10, 25, 50, 100] as const;

/**
 * The page size a collection opens at. Not the smallest offered: ten rows is a choice a reader
 * makes, not a default. The backtest trade log keeps its own default of 50.
 */
export const COLLECTION_DEFAULT_PAGE_SIZE = 25;

/**
 * Whether a collection of `total` rows needs paging controls at all. At or under the smallest page
 * size every row fits on one page at any size, so a page-size control and a range would only repeat
 * the count the section's heading already shows.
 */
export function collectionNeedsFooter(total: number): boolean {
  return total > COLLECTION_PAGE_SIZES[0];
}

/** Counts read like counts: "18,234", never "18234". */
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** A count of records as every collection writes it: with thousands separators. */
export function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

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
  /**
   * The page being asked for is still on its way (a collection paged in the database). The moves
   * are held until it lands, so a second press never races the first, and the footer says so to
   * assistive technology.
   */
  readonly busy?: boolean;
  /**
   * `compact` is the footer of a compact `CollectionSection`: tighter, and absent altogether when
   * every row fits on the smallest page (`collectionNeedsFooter`), because the section's heading
   * already carries the count.
   */
  readonly density?: "comfortable" | "compact";
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
  busy = false,
  density = "comfortable",
  testId,
}: CollectionFooterProps) {
  if (density === "compact" && !collectionNeedsFooter(total)) {
    return null;
  }
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const count = formatCount;

  return (
    <div
      className={styles.footer}
      data-density={density}
      aria-busy={busy ? "true" : undefined}
      {...(testId ? { "data-testid": testId } : {})}
    >
      <div className={styles.group}>
        <SelectControl
          id={`${testId ?? noun}-page-size`}
          label="Rows"
          value={String(pageSize)}
          onChange={(value) => onPageSizeChange(Number(value))}
          options={PAGE_SIZE_OPTIONS}
          disabled={busy}
        />
        <span className={styles.range}>
          Showing {count(first)}–{count(last)} of {count(total)} {noun}
        </span>
      </div>
      {pageCount > 1 ? (
        <div className={styles.group}>
          <button
            type="button"
            className={actions.action}
            disabled={busy || page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            Previous
          </button>
          <span className={styles.page}>
            Page {count(page)} of {count(pageCount)}
          </span>
          <button
            type="button"
            className={actions.action}
            disabled={busy || page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

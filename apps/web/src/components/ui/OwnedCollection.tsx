"use client";

import type { ContentOwnership } from "@intrinsic/contracts";
import type { ReactNode } from "react";
import { useCollection, type CollectionSort } from "./Collection";
import styles from "./Collection.module.css";
import { CollectionFooter, formatCount } from "./CollectionFooter";
import { DataTable, type DataTableColumn } from "./DataTable";
import { SectionCard } from "./SectionCard";

/**
 * Anything the product owns twice over: a customer's own record, or platform built-in content.
 *
 * `AGENTS.md` invariant 21 — built-ins are `SYSTEM`-owned, readable by everyone and changed by an
 * administrator alone. Every collection response already carries that discriminator, so no page
 * needs a second way to tell the two apart.
 */
export type OwnedRecord = { readonly ownership: ContentOwnership };

/**
 * Splits a collection into the viewer's own records and the platform's.
 *
 * Order inside each group is the API's, which is what keeps "newest first" meaning the same on
 * both sides of the split.
 */
export function partitionByOwnership<TRow extends OwnedRecord>(
  rows: readonly TRow[],
): { readonly own: readonly TRow[]; readonly builtIn: readonly TRow[] } {
  return {
    own: rows.filter((row) => row.ownership !== "SYSTEM"),
    builtIn: rows.filter((row) => row.ownership === "SYSTEM"),
  };
}

type CollectionSectionProps<TRow> = {
  readonly title: ReactNode;
  readonly caption?: ReactNode;
  /** Accessible name for the table, e.g. "Built-in lists". */
  readonly label: string;
  /** Plural noun for the footer's range summary, e.g. "lists". */
  readonly noun: string;
  readonly columns: readonly DataTableColumn<TRow>[];
  readonly rows: readonly TRow[];
  readonly getRowKey: (row: TRow) => string;
  /** What a search matches (usually the name); the field appears from ten records. */
  readonly searchText?: (row: TRow) => string;
  /**
   * Orders offered in the Sort control, the API's own first. Leave out where order carries no
   * meaning — a two-row built-in section needs no controls at all. An order that names its
   * `column` makes that column's header sort too.
   */
  readonly sorts?: readonly CollectionSort<TRow>[];
  /**
   * `compact` is the Dashboard's density: the title, the count and the search and sort on one
   * heading row, a 13px table, rows stacked inside the section on a phone, and no footer while every
   * row fits on the smallest page. Opt-in per page, until each page that uses it has been checked.
   */
  readonly density?: "comfortable" | "compact";
  /**
   * Shown in place of the table when the section holds nothing. A section that is empty is one
   * empty section, never a full-page dead end that hides the sections under it.
   */
  readonly emptyState?: ReactNode;
  readonly clickableRows?: boolean;
  readonly id?: string;
  readonly testId?: string;
  readonly tableTestId?: string;
  readonly rowTestId?: string;
  /**
   * Distinct per section: the footer builds its page-size control's `id` from it, and two
   * sections of the same collection would otherwise share one.
   */
  readonly footerTestId?: string;
};

/**
 * One titled section of a collection page: a heading, a desktop table / phone cards, and a footer.
 *
 * The product shows a customer their **own** content first and the platform's built-ins under it,
 * on Lists, Strategies and Monitors alike. Each section pages independently — which is the reason
 * this is a component rather than a helper: the paging state belongs to the section that owns it,
 * so pushing one collection to its second page never moves the other.
 *
 * Feature-specific meaning stays in the columns the feature passes; nothing here knows what a List
 * or a Monitor is.
 */
export function CollectionSection<TRow>({
  title,
  caption,
  label,
  noun,
  columns,
  rows,
  getRowKey,
  searchText,
  sorts,
  emptyState,
  clickableRows,
  density = "comfortable",
  id,
  testId,
  tableTestId,
  rowTestId,
  footerTestId,
}: CollectionSectionProps<TRow>) {
  const compact = density === "compact";
  const collection = useCollection(rows, {
    noun,
    ...(testId === undefined ? {} : { testId }),
    ...(searchText ? { searchText } : {}),
    ...(sorts ? { sorts } : {}),
    ...(compact ? { density } : {}),
  });
  const { paging } = collection;
  const empty = rows.length === 0;
  // An empty section shows its own empty state; one filtered to nothing shows the way back.
  const showTable = !empty && collection.filteredEmpty === null;
  // A header sorts where an order names its column; the rest of the columns are left as declared.
  const tableColumns =
    collection.sortColumns.size === 0
      ? columns
      : columns.map((column) =>
          collection.sortColumns.has(column.key)
            ? { ...column, sortable: true }
            : column,
        );
  // The heading's count: every record, or the matches while a search narrows them.
  const count =
    compact && !empty ? (
      <span data-testid={testId ? `${testId}-count` : undefined}>
        {collection.filtering
          ? `${formatCount(collection.rows.length)} of ${formatCount(rows.length)}`
          : formatCount(rows.length)}
        <span className={styles.srOnly}> {noun}</span>
      </span>
    ) : undefined;

  return (
    <SectionCard
      title={title}
      {...(caption === undefined ? {} : { caption })}
      {...(id === undefined ? {} : { id })}
      {...(testId === undefined ? {} : { testId })}
      {...(empty ? {} : { toolbar: collection.toolbar })}
      {...(count === undefined ? {} : { count })}
      {...(compact ? { density } : {})}
      flush={showTable}
    >
      {empty ? emptyState : null}
      {!empty && !showTable ? collection.filteredEmpty : null}
      {showTable ? (
        <>
          <DataTable
            label={label}
            columns={tableColumns}
            rows={paging.visibleRows}
            getRowKey={getRowKey}
            {...(collection.tableSort ? { sort: collection.tableSort } : {})}
            {...(collection.sortColumns.size > 0
              ? { onSortChange: collection.sortByColumn }
              : {})}
            {...(tableTestId === undefined ? {} : { testId: tableTestId })}
            {...(rowTestId === undefined ? {} : { rowTestId })}
            {...(clickableRows ? { clickableRows: true } : {})}
            {...(compact ? { density } : {})}
          />
          <CollectionFooter
            {...(footerTestId === undefined ? {} : { testId: footerTestId })}
            {...(compact ? { density } : {})}
            noun={noun}
            total={paging.total}
            page={paging.page}
            pageSize={paging.pageSize}
            onPageChange={paging.setPage}
            onPageSizeChange={paging.setPageSize}
          />
        </>
      ) : null}
    </SectionCard>
  );
}

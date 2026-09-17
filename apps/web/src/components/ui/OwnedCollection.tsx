"use client";

import type { ContentOwnership } from "@intrinsic/contracts";
import type { ReactNode } from "react";
import { CollectionFooter } from "./CollectionFooter";
import { DataTable, type DataTableColumn } from "./DataTable";
import { SectionCard } from "./SectionCard";
import { usePagination } from "./use-pagination";

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
  emptyState,
  clickableRows,
  id,
  testId,
  tableTestId,
  rowTestId,
  footerTestId,
}: CollectionSectionProps<TRow>) {
  const paging = usePagination(rows);
  const empty = rows.length === 0;

  return (
    <SectionCard
      title={title}
      {...(caption === undefined ? {} : { caption })}
      {...(id === undefined ? {} : { id })}
      {...(testId === undefined ? {} : { testId })}
      flush={!empty}
    >
      {empty ? (
        emptyState
      ) : (
        <>
          <DataTable
            label={label}
            columns={columns}
            rows={paging.visibleRows}
            getRowKey={getRowKey}
            {...(tableTestId === undefined ? {} : { testId: tableTestId })}
            {...(rowTestId === undefined ? {} : { rowTestId })}
            {...(clickableRows ? { clickableRows: true } : {})}
          />
          <CollectionFooter
            {...(footerTestId === undefined ? {} : { testId: footerTestId })}
            noun={noun}
            total={paging.total}
            page={paging.page}
            pageSize={paging.pageSize}
            onPageChange={paging.setPage}
            onPageSizeChange={paging.setPageSize}
          />
        </>
      )}
    </SectionCard>
  );
}

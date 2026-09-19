"use client";

import type { CSSProperties, MouseEvent, ReactNode } from "react";
import styles from "./DataTable.module.css";

/**
 * Where a column's cell belongs inside the mobile card.
 *
 * The same cell is one table cell on desktop and one region of a card on a phone — there is only
 * ever one DOM node for it. `identity` and `status` share the card's top row; `fact`, `links` and
 * `actions` each take a full-width row underneath, in that order, regardless of the order the
 * columns were declared in.
 */
export type DataTableCardRole =
  | "identity"
  | "status"
  | "fact"
  | "links"
  | "actions"
  /** Desktop-only detail that would only clutter a phone card. */
  | "hidden";

export type DataTableColumn<TRow> = {
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: TRow) => ReactNode;
  /** Numeric columns align right and use tabular figures so digits line up. */
  readonly align?: "left" | "right";
  readonly numeric?: boolean;
  /**
   * Keeps the cell on one line. For timestamps and periods, which are meaningless broken
   * across four lines and are what a squeezed table crushes first.
   */
  readonly nowrap?: boolean;
  readonly width?: string;
  /**
   * The narrowest this column may become in the desktop table. An `identity` column gets a
   * floor by default (`12rem`) so a squeezed table never breaks a name mid-word; pass a
   * smaller one where the identifier is short — the Dashboard's ticker needs `7rem`.
   */
  readonly minWidth?: string;
  /**
   * Long prose — a signal's "why", a description. On a phone card the label sits above the
   * value and the text runs left-aligned across the card, instead of a ragged-left block
   * squeezed against its label.
   */
  readonly stacked?: boolean;
  /**
   * Hidden in the intermediate desktop band (880–1,279px), where the table has more columns
   * than room. The feature then folds the same facts into a cell that stays — the Dashboard
   * folds Strategy, List and Monitor under the stock. Only one copy is ever displayed, so a
   * screen reader still meets each fact once.
   */
  readonly foldIntermediate?: boolean;
  /** Defaults to `fact`. */
  readonly cardRole?: DataTableCardRole;
  /** Label beside the value in the mobile card; defaults to `header`. */
  readonly cardLabel?: ReactNode;
  readonly sortable?: boolean;
};

export type DataTableSort = {
  readonly key: string;
  readonly direction: "asc" | "desc";
};

type DataTableProps<TRow> = {
  readonly columns: readonly DataTableColumn<TRow>[];
  readonly rows: readonly TRow[];
  readonly getRowKey: (row: TRow) => string;
  /** Accessible name for the table. */
  readonly label: string;
  readonly sort?: DataTableSort;
  readonly onSortChange?: (key: string) => void;
  readonly rowTestId?: string;
  readonly testId?: string;
  /**
   * Makes the whole row a click target for the page its identity cell links to.
   *
   * The click is forwarded to that cell's own link rather than routed separately, so there is
   * exactly one destination per row and no second copy of it to drift. A convenience for pointers
   * only: the row takes no tab stop and no button role, because the link is already what keyboard
   * and assistive-technology users follow. A click landing on a control inside the row is left to
   * that control.
   */
  readonly clickableRows?: boolean;
  /** Rendered instead of the table when there are no rows. */
  readonly emptyState?: ReactNode;
};

/**
 * Width hints travel as custom properties rather than inline `width`/`min-width`, so they apply
 * only inside the desktop layout's media query and never constrain a phone card.
 */
function columnStyle<TRow>(column: DataTableColumn<TRow>): CSSProperties {
  const style: Record<string, string> = {};
  if (column.width) {
    style["--column-width"] = column.width;
  }
  if (column.minWidth) {
    style["--column-min-width"] = column.minWidth;
  }
  return style as CSSProperties;
}

function SortIndicator({
  state,
}: {
  readonly state: "asc" | "desc" | "none";
}) {
  return (
    <span className={styles.sortIcon} data-state={state} aria-hidden="true">
      {state === "none" ? "↕" : state === "asc" ? "↑" : "↓"}
    </span>
  );
}

/**
 * The product's one collection renderer: a dense table on desktop, a purpose-built card per row on
 * a phone.
 *
 * Both presentations are the *same* DOM. A phone does not get a horizontally scrolling desktop
 * table, and a desktop does not get an endless grid of tiny cards — but neither is a second copy of
 * the rows, so a test that counts rows counts them once and a screen reader is never read the same
 * record twice. Table roles are written explicitly because the mobile card layout changes `display`
 * away from the table values, which would otherwise drop them from the accessibility tree; the
 * header row stays in that tree on mobile as a visually hidden row so every cell keeps its column.
 *
 * Feature-specific meaning stays in the column definitions. Do not fork this to restyle one table.
 */
export function DataTable<TRow>({
  columns,
  rows,
  getRowKey,
  label,
  sort,
  onSortChange,
  rowTestId,
  testId,
  clickableRows,
  emptyState,
}: DataTableProps<TRow>) {
  if (rows.length === 0 && emptyState) {
    return <>{emptyState}</>;
  }

  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    // A click on a link, a button or a form control belongs to that control, never to the row.
    if (
      (event.target as HTMLElement).closest(
        "a, button, input, select, textarea, label, summary, details",
      )
    ) {
      return;
    }
    // Selecting text inside a row is not a navigation.
    if ((window.getSelection()?.toString().length ?? 0) > 0) {
      return;
    }
    event.currentTarget
      .querySelector<HTMLAnchorElement>('[data-card="identity"] a')
      ?.click();
  };

  return (
    <div className={styles.scroll}>
      <table
        className={styles.table}
        role="table"
        aria-label={label}
        {...(testId ? { "data-testid": testId } : {})}
      >
        <thead className={styles.head} role="rowgroup">
          <tr className={styles.headRow} role="row">
            {columns.map((column) => {
              const active = sort?.key === column.key;
              const state = active ? sort.direction : "none";
              return (
                <th
                  key={column.key}
                  role="columnheader"
                  scope="col"
                  className={styles.th}
                  data-align={column.align ?? "left"}
                  data-card={column.cardRole ?? "fact"}
                  data-fold={column.foldIntermediate ? "true" : undefined}
                  {...(active
                    ? {
                        "aria-sort":
                          sort.direction === "asc" ? "ascending" : "descending",
                      }
                    : {})}
                  style={columnStyle(column)}
                >
                  {column.sortable && onSortChange ? (
                    <button
                      type="button"
                      className={styles.sortButton}
                      data-active={active ? "true" : undefined}
                      onClick={() => onSortChange(column.key)}
                    >
                      <span>{column.header}</span>
                      <SortIndicator state={state} />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className={styles.body} role="rowgroup">
          {rows.map((row) => (
            <tr
              key={getRowKey(row)}
              role="row"
              className={styles.row}
              {...(clickableRows
                ? { "data-clickable": "true", onClick: handleRowClick }
                : {})}
              {...(rowTestId ? { "data-testid": rowTestId } : {})}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  role="cell"
                  className={styles.td}
                  data-align={column.align ?? "left"}
                  data-numeric={column.numeric ? "true" : undefined}
                  data-nowrap={column.nowrap ? "true" : undefined}
                  data-card={column.cardRole ?? "fact"}
                  data-stacked={column.stacked ? "true" : undefined}
                  data-fold={column.foldIntermediate ? "true" : undefined}
                  style={columnStyle(column)}
                >
                  {/* The column header is the cell's label on a phone, where the header
                      row is visually hidden. Hidden from assistive tech because the real
                      header still labels the cell there. Relationship cells carry it too:
                      that is what turns three desktop columns into the "Monitor / Strategy
                      / List" linked block on a card. */}
                  {["fact", "links"].includes(column.cardRole ?? "fact") ? (
                    <span className={styles.cardLabel} aria-hidden="true">
                      {column.cardLabel ?? column.header}
                    </span>
                  ) : null}
                  <span className={styles.cardValue}>{column.render(row)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Content shown only in the intermediate desktop band (880–1,279px), inside a cell that stays
 * visible there. It is the other half of `foldIntermediate`: a column steps out of the table in
 * that band and its facts reappear here, beside the fact they belong to, so the table fits
 * without scrolling its actions away (UI-001, UI-003). Outside the band it is not displayed, so
 * a fact is never exposed twice.
 */
export function IntermediateOnly({
  children,
  testId,
}: {
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  return (
    <span
      className={styles.intermediateOnly}
      {...(testId ? { "data-testid": testId } : {})}
    >
      {children}
    </span>
  );
}

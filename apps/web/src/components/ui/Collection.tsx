"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import styles from "./Collection.module.css";
import { EmptyState } from "./EmptyState";
import forms from "./forms.module.css";
import { SelectControl } from "./SelectControl";
import { usePagination } from "./use-pagination";

/** A collection shows its search field from this many records up (UI-011). */
export const COLLECTION_SEARCH_THRESHOLD = 10;

/**
 * One way to order a collection. `compare` is omitted for the order the API already returns, so the
 * default never re-sorts what the server decided.
 */
export type CollectionSort<TRow> = {
  readonly id: string;
  readonly label: string;
  readonly compare?: (a: TRow, b: TRow) => number;
};

type CollectionConfig<TRow> = {
  /** Plural noun: "lists", "runs", "stocks". Used in labels, counts and the filtered-empty state. */
  readonly noun: string;
  /** The text a query is matched against — a name, a ticker and company name. Omit for no search. */
  readonly searchText?: (row: TRow) => string;
  /** Orders offered in the Sort control, the first being the default. One or none hides it. */
  readonly sorts?: readonly CollectionSort<TRow>[];
  /** Prefix for the controls' test ids; defaults to the noun. */
  readonly testId?: string;
};

/** Case- and accent-insensitive, so "nestle" finds "Nestlé". */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Client-side search, sort and paging for a collection the page already holds in full.
 *
 * Every collection endpoint returns the caller's whole owned collection in one response, so this is
 * presentation over rows in memory — no server pagination, no second request. Changing the query or
 * the order returns to the first page, so a filter never strands the user on a page that no longer
 * has rows. The search field appears from `COLLECTION_SEARCH_THRESHOLD` records (and stays while a
 * query is active, so it never vanishes under the user's own text); the Sort control appears
 * wherever the feature offers more than one order and there is more than one record. On phones,
 * where table headers are hidden, the Sort control is the only way to order the cards.
 */
export function useCollection<TRow>(
  rows: readonly TRow[],
  { noun, searchText, sorts = [], testId = noun }: CollectionConfig<TRow>,
) {
  const baseId = useId();
  const [query, setQuery] = useState("");
  const [sortId, setSortId] = useState(sorts[0]?.id ?? "");
  const sort = sorts.find((candidate) => candidate.id === sortId) ?? sorts[0];
  const term = normalize(query);

  const viewRows = useMemo(() => {
    const matched =
      term === "" || !searchText
        ? rows
        : rows.filter((row) => normalize(searchText(row)).includes(term));
    return sort?.compare ? [...matched].sort(sort.compare) : matched;
  }, [rows, term, searchText, sort]);

  const paging = usePagination(
    viewRows,
    JSON.stringify([term, sort?.id ?? ""]),
  );
  const filtering = term !== "";
  const searchable =
    searchText !== undefined &&
    (rows.length >= COLLECTION_SEARCH_THRESHOLD || filtering);
  const sortable = sorts.length > 1 && rows.length > 1;

  const clear = () => setQuery("");

  const toolbar: ReactNode =
    searchable || sortable ? (
      <div className={styles.toolbar} data-testid={`${testId}-toolbar`}>
        {searchable ? (
          <input
            type="search"
            className={`${forms.input} ${styles.search}`}
            aria-label={`Search ${noun}`}
            placeholder={`Search ${noun}…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            data-testid={`${testId}-search`}
          />
        ) : null}
        {sortable ? (
          <SelectControl
            id={`${baseId}-sort`}
            label="Sort"
            value={sort?.id ?? ""}
            onChange={setSortId}
            options={sorts.map((option) => ({
              value: option.id,
              label: option.label,
            }))}
            testId={`${testId}-sort`}
          />
        ) : null}
        {/* The result of a search, said once for assistive technology; the footer shows it too. */}
        <span className={styles.srOnly} role="status">
          {filtering
            ? `${viewRows.length} of ${rows.length} ${noun} match “${query.trim()}”.`
            : ""}
        </span>
      </div>
    ) : null;

  // Filtered to nothing is not "empty": the records exist, and the way back is one press away.
  const filteredEmpty: ReactNode =
    filtering && viewRows.length === 0 ? (
      <EmptyState
        variant="compact"
        testId={`${testId}-filtered-empty`}
        title={`No ${noun} match “${query.trim()}”`}
        actions={
          <button
            type="button"
            className={forms.secondaryButton}
            onClick={clear}
          >
            Clear search
          </button>
        }
      />
    ) : null;

  return { rows: viewRows, paging, toolbar, filteredEmpty, filtering, clear };
}

/** Orders shared by every named, dated collection. */
export function byName<TRow extends { readonly name: string }>(
  a: TRow,
  b: TRow,
): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

export function byNewest<TRow>(
  date: (row: TRow) => string,
): (a: TRow, b: TRow) => number {
  return (a, b) => Date.parse(date(b)) - Date.parse(date(a));
}

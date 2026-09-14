import type { StockSearchResultResponse } from "@intrinsic/contracts";

export type StockShortcut = Pick<StockSearchResultResponse, "symbol" | "name">;

/** How many popular shortcuts the dropdown shows. Unchanged by the recent section above it. */
export const POPULAR_STOCK_SEARCH_COUNT = 3;

/**
 * Shortcuts shown before the user types anything.
 *
 * Deliberately a static frontend list, not a ranked or tracked one: there is no popularity signal
 * in the product, and inventing analytics to fill an empty dropdown would be a backend feature the
 * search slice does not need. Revisit only when real usage data exists.
 *
 * The pool is longer than `POPULAR_STOCK_SEARCH_COUNT` so the section can keep its size when a
 * stock is dropped from it for already appearing under RECENT SEARCHES — the dropdown never shows
 * the same stock twice, and never shrinks to make that true.
 */
export const POPULAR_STOCK_SEARCHES: readonly StockShortcut[] = [
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "AMZN", name: "Amazon" },
  { symbol: "GOOGL", name: "Alphabet" },
  { symbol: "META", name: "Meta Platforms" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "BRK-B", name: "Berkshire Hathaway" },
];

/**
 * The popular shortcuts to show beside a given set of recents.
 *
 * Matching is by symbol, because that is the identity the shortcuts have: they are a hand-written
 * frontend list with no catalog ids, and the symbol is what the user reads and what the row
 * navigates to. Excluded entries are replaced from further down the pool rather than simply
 * removed, so the section stays the same height whether or not the user has recents.
 */
export function popularStockSearches(
  excludedSymbols: readonly string[] = [],
): readonly StockShortcut[] {
  const excluded = new Set(
    excludedSymbols.map((symbol) => symbol.trim().toUpperCase()),
  );
  return POPULAR_STOCK_SEARCHES.filter(
    (shortcut) => !excluded.has(shortcut.symbol),
  ).slice(0, POPULAR_STOCK_SEARCH_COUNT);
}

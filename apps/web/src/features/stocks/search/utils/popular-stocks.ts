import type { StockSearchResultResponse } from "@intrinsic/contracts";

/**
 * Shortcuts shown before the user types anything.
 *
 * Deliberately a static frontend list, not a ranked or tracked one: there is no popularity signal
 * in the product, and inventing analytics to fill an empty dropdown would be a backend feature the
 * search slice does not need. Revisit only when real usage data exists.
 */
export const POPULAR_STOCK_SEARCHES: readonly Pick<
  StockSearchResultResponse,
  "symbol" | "name"
>[] = [
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "NVDA", name: "NVIDIA" },
];

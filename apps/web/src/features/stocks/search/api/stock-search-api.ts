import type { StockSearchResultResponse } from "@intrinsic/contracts";
import { apiGet } from "../../../../lib/api/client";

/**
 * Global stock search against the locally persisted securities universe.
 *
 * The term must already be non-blank: the API rejects a blank `q`, and issuing one would be a
 * wasted round trip on a surface that fires per keystroke.
 */
export function searchStocks(
  term: string,
  options: { signal?: AbortSignal } = {},
): Promise<StockSearchResultResponse[]> {
  return apiGet<StockSearchResultResponse[]>("/stocks/search", {
    query: { q: term },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

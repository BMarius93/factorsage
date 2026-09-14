import type {
  RecordSecurityViewRequest,
  StockSearchResultResponse,
} from "@intrinsic/contracts";
import { apiGet, apiPost } from "../../../../lib/api/client";

/**
 * The caller's recently viewed securities, newest first.
 *
 * `securityIds` carries a Guest's browser-stored recents so the API can resolve them against the
 * live catalog; it is ignored for an authenticated caller, whose set is the one in the database.
 */
export function fetchRecentSearches(
  securityIds: readonly string[] = [],
  options: { signal?: AbortSignal } = {},
): Promise<StockSearchResultResponse[]> {
  return apiGet<StockSearchResultResponse[]>("/recent-searches", {
    ...(securityIds.length > 0
      ? { query: { ids: securityIds.join(",") } }
      : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Records that the authenticated caller opened one security's Stock Details page. */
export async function recordSecurityView(securityId: string): Promise<void> {
  const body: RecordSecurityViewRequest = { securityId };
  await apiPost<never>("/recent-searches", body);
}

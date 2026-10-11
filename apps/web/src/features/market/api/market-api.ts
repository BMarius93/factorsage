import type { MarketOverviewResponse } from "@intrinsic/contracts";
import { apiGet } from "../../../lib/api/client";

/** The ETF market overview, in one request. Guest-readable: it carries no account-specific state. */
export function fetchMarketOverview(options: { signal?: AbortSignal } = {}) {
  return apiGet<MarketOverviewResponse>("/market-overview", options);
}

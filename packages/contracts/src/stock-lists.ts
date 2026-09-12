import type { SecurityResponse } from "./stock-data.js";

/**
 * Buy eligibility of one security inside one stock list.
 *
 * `FULL`: eligible on every date a future strategy/backtest covers; carries zero ranges.
 * `CUSTOM`: eligible only inside the configured date ranges.
 */
export const BUY_WINDOW_MODES = ["FULL", "CUSTOM"] as const;

export type BuyWindowMode = (typeof BUY_WINDOW_MODES)[number];

/**
 * One inclusive `YYYY-MM-DD` buy range. `endDate` null means open-ended. The API always returns
 * the canonical normalized set: chronologically sorted, non-overlapping, non-adjacent, with at
 * most one open-ended range as the final entry.
 */
export type BuyWindowRangeResponse = {
  startDate: string;
  endDate: string | null;
};

/** Shared input limits so the browser UI and the API cannot disagree. */
/**
 * How one List stands against the caller's current entitlements.
 *
 * **Derived on every read, never persisted.** A List created under a higher plan keeps every
 * symbol after a downgrade and stays fully readable; what changes is that `compliant` becomes
 * false, additions are refused, and a Monitor watching it stops being execution-eligible.
 * Persisting this as a column would make it a flag that is correct until the plan or the
 * membership moves and silently wrong afterwards.
 *
 * `symbolLimit` is `null` for an unbounded entitlement.
 */
export type StockListComplianceResponse = {
  symbolCount: number;
  symbolLimit: number | null;
  compliant: boolean;
};

export const STOCK_LIST_NAME_MAX_LENGTH = 120;
export const STOCK_LIST_DESCRIPTION_MAX_LENGTH = 500;
export const STOCK_LIST_MAX_SECURITIES_PER_ADD = 100;
export const BUY_WINDOW_MAX_RANGES = 100;

/** One row of `GET /lists`: enough to render the collection without loading memberships. */
export type StockListSummaryResponse = {
  id: string;
  name: string;
  description?: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  compliance: StockListComplianceResponse;
};

/**
 * Identity of a member security, projected from the canonical catalog. Deliberately lightweight:
 * rendering a list must not require prices, fundamentals, or any provider-backed hydration.
 */
export type StockListSecurityResponse = Pick<
  SecurityResponse,
  "id" | "symbol" | "name" | "exchangeCode" | "exchangeName"
>;

export type StockListItemResponse = {
  id: string;
  security: StockListSecurityResponse;
  buyWindowMode: BuyWindowMode;
  /** Canonical normalized ranges; always empty for `FULL`. */
  buyWindows: BuyWindowRangeResponse[];
};

export type StockListDetailResponse = {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  items: StockListItemResponse[];
  compliance: StockListComplianceResponse;
};

/**
 * `securityIds` lets the create flow save a name plus the selected stocks in one atomic request.
 * Every id must already exist in the `Security` catalog; the list feature never creates catalog
 * rows and never resolves unknown symbols through a provider.
 */
export type CreateStockListRequest = {
  name: string;
  description?: string;
  securityIds?: string[];
};

/** At least one field must be present. `description: null` clears the description. */
export type UpdateStockListRequest = {
  name?: string;
  description?: string | null;
};

/**
 * Adds catalog securities to a list. Idempotent: ids already in the list are skipped rather than
 * duplicated or rejected, so the response is stable under retries and concurrent submissions.
 */
export type AddStockListItemsRequest = {
  securityIds: string[];
};

/**
 * Replaces the COMPLETE buy-window configuration of one list item atomically. `FULL` must be
 * submitted with zero ranges; `CUSTOM` needs at least one. The response carries the canonical
 * normalized result, which is also exactly what gets persisted.
 */
export type ReplaceBuyWindowsRequest = {
  mode: BuyWindowMode;
  ranges: { startDate: string; endDate: string | null }[];
};

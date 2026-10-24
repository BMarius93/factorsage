import type { ContentOwnershipResponse } from "./builtins.js";
import type { SecurityResponse } from "./stock-data.js";

/**
 * Buy eligibility of one security inside one stock list.
 *
 * `FULL`: eligible on every date a future strategy/backtest covers; carries zero ranges.
 * `CUSTOM`: eligible only inside the configured date ranges.
 *
 * > A Buy Window represents the period during which a List member is eligible for new BUY
 * > actions. It may correspond to point-in-time index membership. It does not constrain SELL
 * > actions for existing positions.
 *
 * The browser presents this as **membership**, because that is what a user is describing when
 * they set it. The wire contract keeps the `buyWindow` naming, which is what the domain, the
 * schema, the backtest engine and the Monitor all call it.
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
/**
 * Securities one create or add request may carry: a request-size bound, never a commercial one. Equal
 * to the largest plan's symbol limit (Pro+, 1,000), so any List a plan allows can be created in one
 * request — about 40 KB of identifiers, inside the API's JSON body limit.
 */
export const STOCK_LIST_MAX_SECURITIES_PER_ADD = 1_000;
export const BUY_WINDOW_MAX_RANGES = 100;

/**
 * The maintained historical universe a built-in List carries: an index's own membership
 * (`docs/decisions/sp500-historical-pit-v1.md`) or a universe derived from one
 * (`docs/decisions/historical-universes-v1.md`). Present only on those Lists.
 */
export type StockListUniverseResponse = {
  kind: "POINT_IN_TIME_INDEX";
  /** The root index the universe is drawn from. */
  indexKey: string;
  /** The universe's catalog key: the List's `systemKey`. */
  universeKey: string;
  /** Its catalog group: `MARKET_INDICES`, `MARKET_CAPITALIZATION`, `INVESTMENT_STYLES`, ... */
  category: string;
  /** False for an index's own membership; true for a ranking drawn from one. */
  derived: boolean;
  /** Distinct securities the List holds: every tradeable constituent since the floor. */
  distinctSecurities: number;
  /**
   * The most members eligible on any one date since the floor. A backtest's plan check measures the
   * same quantity over its own period.
   */
  peakSimultaneousMembers: number;
  /** Members whose membership is ongoing. */
  currentMembers: number;
  /** The earliest date the List's membership is projected from. */
  membershipFloor: string;
  /** When the canonical membership was last synchronized with the provider; null if never. */
  syncedAt: string | null;
};

/** One row of `GET /lists`: enough to render the collection without loading memberships. */
export type StockListSummaryResponse = ContentOwnershipResponse & {
  id: string;
  name: string;
  description?: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  /** Built-in content is not a customer's List and is always compliant. */
  compliance: StockListComplianceResponse;
  /** Present only on a point-in-time index universe's built-in List. */
  universe?: StockListUniverseResponse;
};

/**
 * Identity of a member security, projected from the canonical catalog. Deliberately lightweight:
 * rendering a list must not require prices, fundamentals, or any provider-backed hydration.
 */
export type StockListSecurityResponse = Pick<
  SecurityResponse,
  "id" | "symbol" | "name" | "exchangeCode" | "exchangeName"
> & {
  /**
   * The company mark persisted on `SecurityProfile`, when the catalog has profiled this security.
   *
   * Optional for a reason that is not going away: the bulk universe synchronization writes catalog
   * identity only, and a `SecurityProfile` row appears when something hydrates that one stock. So
   * a truthful projection reports the mark it has and stays silent about the rest — the field
   * never means "this security has no logo".
   */
  logoUrl?: string;
};

export type StockListItemResponse = {
  id: string;
  security: StockListSecurityResponse;
  buyWindowMode: BuyWindowMode;
  /** Canonical normalized ranges; always empty for `FULL`. */
  buyWindows: BuyWindowRangeResponse[];
};

export type StockListDetailResponse = ContentOwnershipResponse & {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  items: StockListItemResponse[];
  compliance: StockListComplianceResponse;
  /** Present only on a point-in-time index universe's built-in List. */
  universe?: StockListUniverseResponse;
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
 * Copies a list the caller can read — their own, or a built-in — into a new list they own.
 *
 * The name is the only thing the caller chooses. What a copy contains is decided by the server
 * from the source: its description, its members in their order, and each member's buy windows.
 */
export type DuplicateStockListRequest = {
  name: string;
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

/**
 * `GET /lists/universes`: the historical universe catalog (`docs/decisions/historical-universes-v1.md`
 * §6), grouped as the Lists page shows it. Metadata only, read from PostgreSQL: no membership, no
 * provider request. Every catalog universe is listed, available or not, so the page can say
 * "Historical data unavailable" rather than leave a universe out; internal research universes are
 * never listed.
 */
export type HistoricalUniverseCatalogResponse = {
  categories: {
    key: string;
    label: string;
    universes: HistoricalUniverseCatalogEntry[];
  }[];
};

export type HistoricalUniverseCatalogEntry = {
  key: string;
  name: string;
  description: string;
  /** Every catalog universe is premium (Pro). */
  premium: true;
  /** True when the viewer's plan does not include premium content: "Requires Pro". */
  locked: boolean;
  /**
   * `AVAILABLE`: published, with a List to open and select. `UNAVAILABLE`: its point-in-time data is
   * not available or not validated yet — "Historical data unavailable", whatever the plan.
   */
  availability: "AVAILABLE" | "UNAVAILABLE";
  /** The built-in List carrying it, once published. */
  listId: string | null;
  /** The first date its List holds members: its validated reliable period. */
  availableFrom: string | null;
  /** Why it is unavailable, in a sentence; null when available. */
  unavailableReason: string | null;
};

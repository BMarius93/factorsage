/**
 * The market overview: what the broad market did, as the product reports it.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` made the Dashboard the signals. This is the one
 * piece of context above them — the market the signals were found in — and it is deliberately its
 * own read model rather than extra fields on `DashboardResponse`: it carries no account-specific
 * state, it is identical for a Guest and for a signed-in customer, and a second surface that wants
 * the same three numbers should read the same endpoint instead of the Dashboard's.
 *
 * Every value here is an **end-of-day close**. Nothing in this contract is intraday, and nothing
 * consuming it may describe it as live — {@link MARKET_OVERVIEW_BASIS} exists so that is a stated
 * fact rather than an assumption a UI is free to get wrong.
 */

/**
 * How current the numbers are, as a value rather than a convention.
 *
 * One member today. A future intraday source would be a second member and a different loading
 * path, never a silent reinterpretation of this one.
 */
export const MARKET_OVERVIEW_BASIS = "END_OF_DAY" as const;

export type MarketOverviewBasis = typeof MARKET_OVERVIEW_BASIS;

/**
 * Whether a card has numbers to show.
 *
 * `UNAVAILABLE` is a first-class answer, not an error: one provider series being temporarily
 * unreadable must leave the other cards working, and the honest thing to render is "no value"
 * rather than a stale number presented as today's or a fabricated one.
 */
export const MARKET_OVERVIEW_ITEM_STATUSES = [
  "AVAILABLE",
  "UNAVAILABLE",
] as const;

export type MarketOverviewItemStatus =
  (typeof MARKET_OVERVIEW_ITEM_STATUSES)[number];

/** How many market sessions the trend line covers. Sessions, never calendar days. */
export const MARKET_OVERVIEW_SPARKLINE_SESSIONS = 7;

/** One observed session. `date` is the exchange session, not a padded calendar day. */
export type MarketOverviewPoint = {
  date: string;
  value: number;
};

/**
 * One market reference.
 *
 * `value` is deliberately not called a price: `^VIX` is a level implied by option prices and
 * nothing holds it, so one neutral name across all three cards is more honest than an equity word
 * applied to two of them and quietly stretched over the third.
 *
 * `changePercent` compares the latest session's close with the **previous session's** close. It is
 * never wall-clock arithmetic, so it does not become meaningless over a weekend, and it is absent
 * rather than zero when there is only one observation to compare.
 */
export type MarketOverviewItemResponse = {
  /** The benchmark code, e.g. `SP500_INDEX`. The provider symbol behind it never crosses this contract. */
  code: string;
  /** What the product calls it: `S&P 500`, `DJIA`, `VIX`. */
  label: string;
  status: MarketOverviewItemStatus;
  /** The latest available close. Absent when `status` is `UNAVAILABLE`. */
  value?: number;
  /** The session before the latest one. Absent when there is only one observation. */
  previousClose?: number;
  /** Latest close against the previous session's close, in percent. Absent without both. */
  changePercent?: number;
  /** The exchange session `value` closed on. */
  sessionDate?: string;
  /** The most recent observed sessions, oldest first. Empty when nothing is available. */
  sparkline: MarketOverviewPoint[];
};

/** `GET /market-overview`. */
export type MarketOverviewResponse = {
  generatedAt: string;
  basis: MarketOverviewBasis;
  items: MarketOverviewItemResponse[];
};

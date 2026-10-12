/**
 * The market overview: how the major US market segments, the sectors and a few macro instruments
 * have performed, as the Dashboard reports it.
 *
 * `docs/decisions/etf-market-overview-v1.md` is the decision. It is deliberately its own read model
 * rather than extra fields on `DashboardResponse`: it carries no account-specific state, it is
 * identical for a Guest and for a signed-in customer, and a second surface that wants the same
 * numbers should read the same endpoint instead of the Dashboard's.
 *
 * Every number is derived from **end-of-day closes** of exchange-traded funds. A fund's share price
 * is not an index level, so this contract carries returns and a rebased trend line, never a price.
 * Nothing in it is intraday, and nothing consuming it may describe it as live —
 * {@link MARKET_OVERVIEW_BASIS} exists so that is a stated fact rather than an assumption a UI is free
 * to get wrong.
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
 * What a return measures.
 *
 * `PRICE_RETURN`: the change in the provider's split-adjusted close, with distributions (dividends,
 * interest) **excluded**. A total-return series would be a second member, never a quiet change of
 * what this one means.
 */
export const MARKET_OVERVIEW_RETURN_BASIS = "PRICE_RETURN" as const;

export type MarketOverviewReturnBasis = typeof MARKET_OVERVIEW_RETURN_BASIS;

/**
 * The six trailing periods every instrument reports, in display order.
 *
 * - `1W` — 7 calendar days;
 * - `1M`, `3M`, `6M` — 1, 3 and 6 calendar months, clamped to the end of a shorter month;
 * - `YTD` — since the last session of the previous calendar year;
 * - `1Y` — 1 calendar year, 29 February clamped to 28 February.
 *
 * Each is measured from the instrument's own latest completed session to its most recent session on
 * or before the period's anchor date.
 */
export const MARKET_OVERVIEW_PERIODS = [
  "1W",
  "1M",
  "3M",
  "6M",
  "YTD",
  "1Y",
] as const;

export type MarketOverviewPeriod = (typeof MARKET_OVERVIEW_PERIODS)[number];

/** The three display groups, in order. `@intrinsic/domain` holds the instruments in each. */
export const MARKET_OVERVIEW_GROUP_IDS = [
  "BENCHMARKS",
  "US_SECTORS",
  "MACRO_ALTERNATIVES",
] as const;

export type MarketOverviewGroupId = (typeof MARKET_OVERVIEW_GROUP_IDS)[number];

/**
 * Whether an instrument has numbers to show, and whether they are current.
 *
 * - `AVAILABLE` — its latest completed session is the overview's reference session (`asOf`);
 * - `STALE` — it has data, but its latest completed session is older than `asOf`. Its returns are
 *   measured to its own `sessionDate`, which a UI must show beside them;
 * - `UNAVAILABLE` — no completed session could be read. Its returns are all `null`.
 *
 * `UNAVAILABLE` is a first-class answer, not an error: one unreadable series must leave the other
 * nineteen working, and the honest thing to render is "no value" rather than a fabricated one.
 */
export const MARKET_OVERVIEW_INSTRUMENT_STATUSES = [
  "AVAILABLE",
  "STALE",
  "UNAVAILABLE",
] as const;

export type MarketOverviewInstrumentStatus =
  (typeof MARKET_OVERVIEW_INSTRUMENT_STATUSES)[number];

/**
 * The overview as a whole: `AVAILABLE` when every instrument is, `UNAVAILABLE` when none has any
 * data (an environment whose ETF histories were never loaded), `PARTIAL` otherwise.
 */
export const MARKET_OVERVIEW_STATUSES = [
  "AVAILABLE",
  "PARTIAL",
  "UNAVAILABLE",
] as const;

export type MarketOverviewStatus = (typeof MARKET_OVERVIEW_STATUSES)[number];

/**
 * One percentage per period. `null` means the history does not reach the period's anchor — never
 * zero, which would claim the instrument did not move. Values keep full precision; rounding is a
 * display decision.
 */
export type MarketOverviewReturns = Record<MarketOverviewPeriod, number | null>;

/**
 * The trailing-year trend line, downsampled on the server to about one point a week.
 *
 * `values` are closes **rebased to 100** at the first point, oldest first, so the line carries the
 * shape of the year and never a price that could be mistaken for an index level. The last point is
 * the latest completed session; with a full year of history the first is the `1Y` baseline, so the
 * line ends at `100 × (1 + returns["1Y"] / 100)`.
 */
export type MarketOverviewSparkline = {
  /** The session of the first point. */
  startDate: string;
  /** The session of the last point: the instrument's `sessionDate`. */
  endDate: string;
  values: number[];
};

export type MarketOverviewInstrumentResponse = {
  /** The exchange ticker the product displays. A display field, not a provider identifier. */
  ticker: string;
  /** What the overview calls it: the market the fund tracks, e.g. `Technology` or `S&P 500`. */
  name: string;
  /**
   * A qualification of what the instrument tracks, e.g. that `USO` holds futures. Available to
   * any surface with room for it; the Dashboard's compact table shows `name` and `ticker` only.
   */
  note?: string;
  status: MarketOverviewInstrumentStatus;
  /** The latest completed session the returns are measured to. Absent when `UNAVAILABLE`. */
  sessionDate?: string;
  returns: MarketOverviewReturns;
  /** Null when fewer than two sessions are available to draw. */
  sparkline: MarketOverviewSparkline | null;
};

export type MarketOverviewGroupResponse = {
  id: MarketOverviewGroupId;
  /** `Sector Performance`. */
  label: string;
  /** `Sectors`: the compact label a category selector uses. */
  shortLabel: string;
  instruments: MarketOverviewInstrumentResponse[];
};

/** `GET /market-overview`. */
export type MarketOverviewResponse = {
  /** When this summary was computed. Not a market time: `asOf` is. */
  generatedAt: string;
  basis: MarketOverviewBasis;
  returnBasis: MarketOverviewReturnBasis;
  status: MarketOverviewStatus;
  /**
   * The reference session: the newest completed session any instrument reached. An instrument
   * behind it is `STALE`. Absent when nothing is available.
   */
  asOf?: string;
  /** Exactly the three groups, in {@link MARKET_OVERVIEW_GROUP_IDS} order. */
  groups: MarketOverviewGroupResponse[];
};

export const MARKET_LOGGER = Symbol("MARKET_LOGGER");

/**
 * The clock the market overview reads "today" from.
 *
 * Injected rather than taken as a defaulted constructor parameter: Nest resolves constructor
 * arguments from emitted parameter metadata, and an undecorated `() => Date` is a `Function` it
 * tries — and fails — to find a provider for. A token makes the seam explicit and lets a test fix
 * the date without stubbing the global clock.
 */
export const MARKET_CLOCK = Symbol("MARKET_CLOCK");

/**
 * How the overview decides a session is complete and how long one summary is served
 * (`MarketOverviewOptions`).
 */
export const MARKET_OVERVIEW_OPTIONS = Symbol("MARKET_OVERVIEW_OPTIONS");

export type MarketOverviewOptions = {
  /** A session's close is final this long after its 16:00 New York close. */
  readonly publicationDelayMs: number;
  /** How long one computed summary is served before it is recomputed. */
  readonly cacheTtlMs: number;
  /** The oldest summary ever served, including while a recomputation fails. */
  readonly maxStaleMs: number;
};

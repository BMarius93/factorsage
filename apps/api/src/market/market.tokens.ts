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

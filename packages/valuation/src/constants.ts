/**
 * Locked V1 methodology constants.
 *
 * These are product methodology, not environment configuration: they are never read from
 * `process.env` and never estimated from current market data. `docs/decisions/intrinsic-value-engine.md`
 * is the source of truth; changing a value here is a methodology change that rebuilds materialized
 * derived state.
 */
export const FORECAST_YEARS = 10;
export const TAX_RATE = 0.21;
export const DCF_WACC = 0.1;
export const COST_OF_EQUITY = 0.1;
export const TERMINAL_GROWTH = 0.025;
export const DEFAULT_GROWTH = 0.05;
export const MAX_FORECAST_GROWTH = 0.15;

export const BACKTESTS_LOGGER = Symbol("BACKTESTS_LOGGER");

/**
 * The benchmark code whose series supplies the engine's execution calendar.
 *
 * Injected rather than imported so the one deployment state this service cannot recover from — a
 * catalog with no such benchmark — is reachable without a test having to mutate the canonical
 * `SP500` row. Renaming a globally shared row to prove a local behaviour is not isolation: another
 * suite's module boot reconciles the catalog while it is renamed, recreates `SP500`, and the
 * restore then collides on the unique code.
 *
 * Production wiring supplies `EXECUTION_CALENDAR_REFERENCE_CODE` from `@intrinsic/domain`, which
 * remains the single source of that decision.
 */
export const EXECUTION_CALENDAR_REFERENCE = Symbol(
  "EXECUTION_CALENDAR_REFERENCE",
);

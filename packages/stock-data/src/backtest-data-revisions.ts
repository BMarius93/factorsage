import { BENCHMARK_PRICE_DATASET_VERSION } from "./benchmark-ports.js";
import { DERIVED_STATE_REVISION } from "./derived-state.js";
import { PRICE_DATASET_VERSION } from "./ports.js";
import { FUNDAMENTALS_VARIANT_VERSION } from "./service.js";

/**
 * Every revision of *how canonical data is interpreted* that can move a number the backtest engine
 * sees, without the Strategy document, the execution methodology or the provider's rows changing.
 *
 * A run records these at submission and a worker refuses to execute one it cannot honour, for the
 * same reason it refuses a methodology it cannot honour: a deploy between queueing and claiming
 * would otherwise let today's interpretation produce numbers stored under yesterday's stamps.
 *
 * The inventory is deliberate, not a sweep of every constant with a version in its name:
 *
 * - `priceDatasetVersion` — what a persisted daily bar means. It is every close the engine reads:
 *   the price operand, the fill price, and the value of every holding.
 * - `derivedStateRevision` — every column projected beside the price. Moving averages, oscillators,
 *   materialized intrinsic values, their blends and the provenance that gates them all live in
 *   `DailyDerivedState`, so one revision covers the whole derived operand surface.
 * - `fundamentalsVariantVersion` — which statements a security materializes. It reaches the engine
 *   one step removed, through the intrinsic values computed from those statements, which is
 *   precisely why it is easy to forget and therefore worth naming.
 * - `benchmarkPriceDatasetVersion` — what a benchmark bar means. It is both halves of the
 *   comparison *and* the run's execution calendar, since the calendar is the reference series'
 *   trading days.
 *
 * Deliberately excluded, with reasons:
 *
 * - Redis namespaces and cache-key versions. Redis is a disposable projection of PostgreSQL; a
 *   change there costs a rebuild and cannot alter a value.
 * - `STOCK_HISTORY_YEARS` and the other environment configuration. It changes how much history is
 *   materialized and could in principle move a warm-up-dependent operand at the very start of a
 *   long run, but it is deployment configuration rather than a code revision. Refusing every
 *   queued run because an operator widened the retention horizon would be a worse trade than the
 *   narrow risk it removes; the run's own period, which *is* snapshotted, bounds what it reads.
 * - Provider corrections to an actual historical row. V1 does not persist raw provider vintages
 *   and does not claim to; see the reproducibility statement in `ai/product/backtests.md`.
 */
export const BACKTEST_DATA_REVISIONS = {
  priceDatasetVersion: PRICE_DATASET_VERSION,
  derivedStateRevision: DERIVED_STATE_REVISION,
  fundamentalsVariantVersion: FUNDAMENTALS_VARIANT_VERSION,
  benchmarkPriceDatasetVersion: BENCHMARK_PRICE_DATASET_VERSION,
} as const;

export type BacktestDataRevisions = typeof BACKTEST_DATA_REVISIONS;

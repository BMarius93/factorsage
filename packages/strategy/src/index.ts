/**
 * `@intrinsic/strategy` — the pure evaluation and backtest-execution layer.
 *
 * It depends only on `@intrinsic/contracts` (Strategy model and series catalog) and
 * `@intrinsic/domain` (row shapes, buy-window semantics). It performs no I/O: no database, no HTTP,
 * no `process.env`, no clock. That is what lets the API, the worker and a future monitor share one
 * implementation of what a Strategy *means* instead of three.
 *
 * Loading lives in `@intrinsic/stock-data`, which projects the columnar frames this package
 * consumes and applies the intrinsic-value provenance gate before the evaluator can see a value.
 */
export const STRATEGY_PACKAGE_NAME = "@intrinsic/strategy" as const;

export * from "./evaluability.js";
export * from "./operands.js";
export * from "./frame.js";
export * from "./predicates.js";
export * from "./gates.js";
export * from "./position.js";
export * from "./backtest/methodology.js";
export * from "./backtest/types.js";
export * from "./backtest/calendar.js";
export * from "./backtest/metrics.js";
export * from "./backtest/benchmark.js";
export * from "./backtest/window.js";
export * from "./backtest/diagnostics.js";
export * from "./backtest/comparison.js";
export * from "./backtest/simulation.js";
export * from "./backtest/simulate.js";

export const BENCHMARKS_LOGGER = Symbol("BENCHMARKS_LOGGER");

/**
 * The API's canonical benchmark loader (`BenchmarkDataService`).
 *
 * One instance for the process, exported from `BenchmarksModule`, so every API surface that needs
 * benchmark bars — today the market overview — reads through the same coverage reconciliation,
 * hydration lock, provider gate and Redis projection the worker uses.
 */
export const BENCHMARK_DATA_SERVICE = Symbol("BENCHMARK_DATA_SERVICE");

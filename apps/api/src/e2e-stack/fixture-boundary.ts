import {
  BENCHMARK_CATALOG,
  DEFAULT_BENCHMARK_CODE,
  MARKET_REFERENCE_SERIES,
} from "@intrinsic/domain";
import {
  ENTITLEMENT_FIXTURE_SECURITY_COUNT,
  entitlementFixtureSymbol,
} from "../entitlements/seed-entitlement-fixtures";
import { QA_SECURITIES } from "../stocks/seed-qa-securities";

/**
 * The deterministic E2E fixture namespace: every security and benchmark series the seeds own, and
 * therefore the only rows a reseed may delete and the only symbols the fixture FMP server answers.
 *
 * Derived from the seeds' own declarations rather than listed again, so a fixture added to a seed
 * is automatically inside the boundary — and a symbol the seeds do not own can never be reset or
 * silently answered.
 *
 * - `QATEST1` carries deterministic market data; `QATEST2` carries none on purpose and, like the
 *   ENTF universe, is declared complete and empty so opening it never asks a provider.
 * - `ENTF001`…`ENTF100` are the entitlement universe: catalog identity plus *complete, empty*
 *   coverage (E2E-005), so nothing ever hydrates them from a provider.
 * - `SP500` (the backtest benchmark and execution calendar, provider symbol `SPY`) and the three
 *   market references behind the Dashboard cards carry synthetic bars written by the QA seed.
 * - `ENT-BENCHMARK` (`ENTITLEMENT_FIXTURE_BENCHMARK_CODE`), the entitlement fixtures' own inactive
 *   series behind the pinned runs, holds no bars at all and is never executed, so it has nothing
 *   to reset or answer and stays outside these lists.
 */

/** Product symbols of every fixture security. Provider symbol equals product symbol for all. */
export function e2eFixtureSecuritySymbols(): string[] {
  return [
    ...QA_SECURITIES.map((security) => security.symbol),
    ...Array.from({ length: ENTITLEMENT_FIXTURE_SECURITY_COUNT }, (_, index) =>
      entitlementFixtureSymbol(index),
    ),
  ];
}

/** Codes of every benchmark whose current series the seeds write. */
export function e2eFixtureBenchmarkCodes(): string[] {
  return [
    DEFAULT_BENCHMARK_CODE,
    ...MARKET_REFERENCE_SERIES.map((reference) => reference.code),
  ];
}

/**
 * Provider symbols of the fixture benchmarks (`SPY`, `^GSPC`, `^DJI`, `^VIX`).
 *
 * These are real provider symbols. The fixture server answers them only because, on the E2E stack,
 * their series hold nothing but seeded bars — the answer is "no bars beyond what the seed wrote",
 * never real market data.
 */
export function e2eFixtureBenchmarkProviderSymbols(): string[] {
  const codes = new Set(e2eFixtureBenchmarkCodes());
  return BENCHMARK_CATALOG.filter((entry) => codes.has(entry.code)).map(
    (entry) => entry.providerSymbol,
  );
}

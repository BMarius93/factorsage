import type { BenchmarkDailyPrice, DateRange } from "@intrinsic/domain";
import type { RedisCacheClient } from "./cache.js";
import { yearsInRange } from "./cache.js";
import {
  BENCHMARK_PRICE_DATASET_VERSION,
  type BenchmarkDataCache,
  type BenchmarkManifest,
} from "./benchmark-ports.js";

/**
 * Redis projection of a benchmark's daily bars.
 *
 * The namespace is deliberately its own — `benchmark:v1:benchmark:<id>:daily-price:<year>` — rather
 * than pretending a benchmark is a resident stock. Consequences that matter: the stock LRU can
 * never evict a benchmark, a benchmark can never occupy a stock residency slot, and a Redis flush
 * costs one re-read from PostgreSQL, never user-owned state.
 *
 * Chunking is yearly, exactly like the stock projection, so a read touches one key per calendar
 * year of the requested range and a write republishes only the years it changed.
 */
export const BENCHMARK_CACHE_NAMESPACE = "benchmark:v1";

export class RedisBenchmarkDataCache implements BenchmarkDataCache {
  private readonly namespace: string;

  constructor(
    private readonly redis: RedisCacheClient,
    options: { namespace?: string } = {},
  ) {
    this.namespace = options.namespace ?? BENCHMARK_CACHE_NAMESPACE;
  }

  async getManifest(benchmarkId: string): Promise<BenchmarkManifest | null> {
    const raw = await this.redis.get(this.manifestKey(benchmarkId));
    if (!raw) {
      return null;
    }
    const manifest = parseManifest(raw);
    // A manifest written under an earlier revision describes coverage the loader no longer trusts,
    // however much it claims to hold.
    if (
      !manifest ||
      manifest.priceDatasetVersion !== BENCHMARK_PRICE_DATASET_VERSION
    ) {
      return null;
    }
    return manifest;
  }

  async setManifest(manifest: BenchmarkManifest): Promise<void> {
    await this.redis.set(
      this.manifestKey(manifest.benchmarkId),
      JSON.stringify(manifest),
    );
  }

  async invalidateManifest(benchmarkId: string): Promise<void> {
    await this.redis.del(this.manifestKey(benchmarkId));
  }

  async readDailyPrices(
    benchmarkId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[] | null> {
    const years = yearsInRange(range);
    if (years.length === 0) {
      return [];
    }
    const chunks = await this.redis.mget(
      ...years.map((year) => this.yearKey(benchmarkId, year)),
    );
    const rows: BenchmarkDailyPrice[] = [];
    for (const chunk of chunks) {
      // Any missing year makes the whole read a miss: a partial answer would look like a benchmark
      // with a hole in its history, which is exactly the mistake this cache must not make.
      if (chunk === null) {
        return null;
      }
      const parsed = parseRows(chunk);
      if (!parsed) {
        return null;
      }
      rows.push(...parsed);
    }
    return rows
      .filter((row) => row.date >= range.from && row.date <= range.to)
      .sort((left, right) =>
        left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
      );
  }

  async writeDailyPriceYears(
    benchmarkId: string,
    prices: readonly BenchmarkDailyPrice[],
    years: readonly number[],
  ): Promise<void> {
    const byYear = new Map<number, BenchmarkDailyPrice[]>();
    for (const year of years) {
      byYear.set(year, []);
    }
    for (const price of prices) {
      const year = Number(price.date.slice(0, 4));
      byYear.get(year)?.push(price);
    }
    for (const [year, rows] of byYear) {
      await this.redis.set(
        this.yearKey(benchmarkId, year),
        JSON.stringify(rows),
      );
    }
  }

  private manifestKey(benchmarkId: string): string {
    return `${this.namespace}:benchmark:${benchmarkId}:manifest`;
  }

  private yearKey(benchmarkId: string, year: number): string {
    return `${this.namespace}:benchmark:${benchmarkId}:daily-price:${year}`;
  }
}

function parseManifest(raw: string): BenchmarkManifest | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as BenchmarkManifest).benchmarkId === "string" &&
      typeof (parsed as BenchmarkManifest).coverageStart === "string" &&
      typeof (parsed as BenchmarkManifest).coverageEnd === "string"
    ) {
      return parsed as BenchmarkManifest;
    }
    return null;
  } catch {
    return null;
  }
}

function parseRows(raw: string): BenchmarkDailyPrice[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as BenchmarkDailyPrice[]) : null;
  } catch {
    return null;
  }
}

/** In-memory double for tests and any process without Redis. Never used in production wiring. */
export class NullBenchmarkDataCache implements BenchmarkDataCache {
  async getManifest(): Promise<BenchmarkManifest | null> {
    return null;
  }

  async setManifest(): Promise<void> {}

  async invalidateManifest(): Promise<void> {}

  async readDailyPrices(): Promise<BenchmarkDailyPrice[] | null> {
    return null;
  }

  async writeDailyPriceYears(): Promise<void> {}
}

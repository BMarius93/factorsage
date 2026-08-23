import type {
  DailyPrice,
  DailyTechnical,
  DateRange,
  Security,
} from "@intrinsic/domain";
import type { WeeklyPrice } from "./weekly.js";

export const PRICE_DATASET_VERSION = 1;

export type StockManifest = {
  securityId: string;
  status: "HYDRATING" | "READY";
  historyYears: number;
  coverageStart?: string;
  coverageEnd?: string;
  canonicalHistoryStart?: string;
  canonicalHistoryEnd?: string;
  hydratedAt?: string;
  lastPriceRefreshAt?: string;
  priceDatasetVersion: number;
  dailyTechnicalVersion: number;
  weeklyVersion: number;
};

export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  mget(...keys: string[]): Promise<Array<string | null>>;
  set(key: string, value: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  incr(key: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zscore(key: string, member: string): Promise<string | null>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  eval(
    script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<unknown>;
}

export interface StockDataCache {
  getSecurity(symbol: string): Promise<Security | null>;
  setSecurity(security: Security): Promise<void>;
  getManifest(securityId: string): Promise<StockManifest | null>;
  setManifest(manifest: StockManifest): Promise<void>;
  beginRefresh(manifest: StockManifest): Promise<boolean>;
  invalidateManifest(manifest: StockManifest | null): Promise<boolean>;
  readDailyPrices(
    securityId: string,
    range: Required<DateRange>,
  ): Promise<DailyPrice[] | null>;
  writeDailyPriceYears(
    securityId: string,
    prices: readonly DailyPrice[],
    years: readonly number[],
  ): Promise<void>;
  readDailyTechnicals(
    securityId: string,
    range: Required<DateRange>,
    calculationVersion: number,
  ): Promise<DailyTechnical[] | null>;
  writeDailyTechnicalYears(
    securityId: string,
    technicals: readonly DailyTechnical[],
    years: readonly number[],
    calculationVersion: number,
  ): Promise<void>;
  writeWeeklyPriceYears(
    securityId: string,
    prices: readonly WeeklyPrice[],
    years: readonly number[],
    calculationVersion: number,
  ): Promise<void>;
  hasResidentStock(securityId: string): Promise<boolean>;
  touch(securityId: string): Promise<void>;
  evict(securityId: string): Promise<void>;
}

export class RedisStockDataCache implements StockDataCache {
  constructor(
    private readonly redis: RedisCacheClient,
    private readonly maxResidentStocks: number,
    private readonly namespace = "stock-data:v2",
  ) {
    if (!Number.isInteger(maxResidentStocks) || maxResidentStocks <= 0) {
      throw new Error("maxResidentStocks must be a positive integer");
    }
  }

  async getSecurity(symbol: string): Promise<Security | null> {
    return this.readJson<Security>(this.symbolSecurityKey(symbol));
  }

  async setSecurity(security: Security): Promise<void> {
    const key = this.symbolSecurityKey(security.symbol);
    await this.redis.set(key, JSON.stringify(security));
    await this.register(security.id, key);
  }

  async getManifest(securityId: string): Promise<StockManifest | null> {
    return this.readJson<StockManifest>(this.manifestKey(securityId));
  }

  async setManifest(manifest: StockManifest): Promise<void> {
    const key = this.manifestKey(manifest.securityId);
    if (manifest.status === "READY") {
      await this.redis.set(key, JSON.stringify(manifest));
      await this.register(manifest.securityId, key);
      await this.touch(manifest.securityId);
      await this.enforceLimit();
    } else {
      await this.redis.eval(
        SET_HYDRATING,
        3,
        key,
        this.registryKey(manifest.securityId),
        this.residentKey(),
        manifest.securityId,
        JSON.stringify(manifest),
      );
    }
  }

  async beginRefresh(manifest: StockManifest): Promise<boolean> {
    const result = await this.redis.eval(
      BEGIN_REFRESH,
      3,
      this.manifestKey(manifest.securityId),
      this.registryKey(manifest.securityId),
      this.residentKey(),
      manifest.securityId,
      JSON.stringify({ ...manifest, status: "HYDRATING" }),
    );
    return result === 1;
  }

  async invalidateManifest(manifest: StockManifest | null): Promise<boolean> {
    if (!manifest) {
      return false;
    }
    const result = await this.redis.eval(
      INVALIDATE_MANIFEST,
      2,
      this.manifestKey(manifest.securityId),
      this.residentKey(),
      manifest.securityId,
      JSON.stringify(manifest),
    );
    return result === 1;
  }

  async readDailyPrices(
    securityId: string,
    range: Required<DateRange>,
  ): Promise<DailyPrice[] | null> {
    if ((await this.getManifest(securityId))?.status !== "READY") {
      return null;
    }
    const result = await this.readYearly<DailyPrice>(
      range,
      (year) => this.priceYearKey(securityId, year),
      (row) => row.date,
    );
    if (result) {
      await this.touch(securityId);
    }
    return result;
  }

  async writeDailyPriceYears(
    securityId: string,
    prices: readonly DailyPrice[],
    years: readonly number[],
  ): Promise<void> {
    await this.writeYearly(
      securityId,
      prices,
      years,
      (row) => row.date,
      (year) => this.priceYearKey(securityId, year),
    );
  }

  async readDailyTechnicals(
    securityId: string,
    range: Required<DateRange>,
    calculationVersion: number,
  ): Promise<DailyTechnical[] | null> {
    if ((await this.getManifest(securityId))?.status !== "READY") {
      return null;
    }
    const result = await this.readYearly<DailyTechnical>(
      range,
      (year) => this.technicalYearKey(securityId, calculationVersion, year),
      (row) => row.date,
    );
    if (result) {
      await this.touch(securityId);
    }
    return result;
  }

  async writeDailyTechnicalYears(
    securityId: string,
    technicals: readonly DailyTechnical[],
    years: readonly number[],
    calculationVersion: number,
  ): Promise<void> {
    await this.writeYearly(
      securityId,
      technicals,
      years,
      (row) => row.date,
      (year) => this.technicalYearKey(securityId, calculationVersion, year),
    );
  }

  async writeWeeklyPriceYears(
    securityId: string,
    prices: readonly WeeklyPrice[],
    years: readonly number[],
    calculationVersion: number,
  ): Promise<void> {
    await this.writeYearly(
      securityId,
      prices,
      years,
      (row) => row.weekStartDate,
      (year) => this.weeklyYearKey(securityId, calculationVersion, year),
    );
  }

  async hasResidentStock(securityId: string): Promise<boolean> {
    return (await this.redis.zscore(this.residentKey(), securityId)) !== null;
  }

  async touch(securityId: string): Promise<void> {
    const sequence = await this.redis.incr(this.accessSequenceKey());
    await this.redis.zadd(this.residentKey(), sequence, securityId);
  }

  async evict(securityId: string): Promise<void> {
    await this.redis.eval(
      EVICT_RESIDENT_STOCK,
      2,
      this.registryKey(securityId),
      this.residentKey(),
      securityId,
    );
  }

  private async readJson<T>(key: string): Promise<T | null> {
    const payload = await this.redis.get(key);
    return payload === null ? null : (JSON.parse(payload) as T);
  }

  private async readYearly<T>(
    range: Required<DateRange>,
    keyForYear: (year: number) => string,
    dateOf: (row: T) => string,
  ): Promise<T[] | null> {
    const years = yearsInRange(range);
    const payloads = await this.redis.mget(...years.map(keyForYear));
    if (payloads.some((payload) => payload === null)) {
      return null;
    }
    return payloads
      .flatMap((payload) => JSON.parse(payload ?? "[]") as T[])
      .filter((row) => dateOf(row) >= range.from && dateOf(row) <= range.to)
      .sort((left, right) => dateOf(left).localeCompare(dateOf(right)));
  }

  private async writeYearly<T>(
    securityId: string,
    rows: readonly T[],
    years: readonly number[],
    dateOf: (row: T) => string,
    keyForYear: (year: number) => string,
  ): Promise<void> {
    const byYear = new Map<number, T[]>();
    for (const year of years) {
      byYear.set(year, []);
    }
    for (const row of rows) {
      const year = Number(dateOf(row).slice(0, 4));
      const bucket = byYear.get(year);
      if (bucket) {
        bucket.push(row);
      }
    }
    for (const [year, values] of byYear) {
      values.sort((left, right) => dateOf(left).localeCompare(dateOf(right)));
      const key = keyForYear(year);
      await this.redis.set(key, JSON.stringify(values));
      await this.register(securityId, key);
    }
  }

  private async register(securityId: string, key: string): Promise<void> {
    await this.redis.sadd(this.registryKey(securityId), key);
  }

  private async enforceLimit(): Promise<void> {
    const excess =
      (await this.redis.zcard(this.residentKey())) - this.maxResidentStocks;
    if (excess <= 0) {
      return;
    }
    const victims = await this.redis.zrange(this.residentKey(), 0, excess - 1);
    for (const securityId of victims) {
      await this.evict(securityId);
    }
  }

  private symbolSecurityKey(symbol: string): string {
    return `${this.namespace}:symbol:${encodeURIComponent(symbol.trim().toUpperCase())}:security`;
  }

  private manifestKey(securityId: string): string {
    return `${this.namespace}:security:${securityId}:manifest`;
  }

  private priceYearKey(securityId: string, year: number): string {
    return `${this.namespace}:security:${securityId}:prices:1D:${year}`;
  }

  private technicalYearKey(
    securityId: string,
    version: number,
    year: number,
  ): string {
    return `${this.namespace}:security:${securityId}:technicals:1D:v${version}:${year}`;
  }

  private weeklyYearKey(
    securityId: string,
    version: number,
    year: number,
  ): string {
    return `${this.namespace}:security:${securityId}:weekly:1W:v${version}:${year}`;
  }

  private registryKey(securityId: string): string {
    return `${this.namespace}:security:${securityId}:keys`;
  }

  private residentKey(): string {
    return `${this.namespace}:resident-stocks`;
  }

  private accessSequenceKey(): string {
    return `${this.namespace}:access-sequence`;
  }
}

export class NullStockDataCache implements StockDataCache {
  async getSecurity(_symbol: string): Promise<Security | null> {
    return null;
  }
  async setSecurity(_security: Security): Promise<void> {}
  async getManifest(_securityId: string): Promise<StockManifest | null> {
    return null;
  }
  async setManifest(_manifest: StockManifest): Promise<void> {}
  async beginRefresh(_manifest: StockManifest): Promise<boolean> {
    return false;
  }
  async invalidateManifest(_manifest: StockManifest | null): Promise<boolean> {
    return false;
  }
  async readDailyPrices(
    _securityId: string,
    _range: Required<DateRange>,
  ): Promise<DailyPrice[] | null> {
    return null;
  }
  async writeDailyPriceYears(
    _securityId: string,
    _prices: readonly DailyPrice[],
    _years: readonly number[],
  ): Promise<void> {}
  async readDailyTechnicals(
    _securityId: string,
    _range: Required<DateRange>,
    _calculationVersion: number,
  ): Promise<DailyTechnical[] | null> {
    return null;
  }
  async writeDailyTechnicalYears(
    _securityId: string,
    _technicals: readonly DailyTechnical[],
    _years: readonly number[],
    _calculationVersion: number,
  ): Promise<void> {}
  async writeWeeklyPriceYears(
    _securityId: string,
    _prices: readonly WeeklyPrice[],
    _years: readonly number[],
    _calculationVersion: number,
  ): Promise<void> {}
  async hasResidentStock(_securityId: string): Promise<boolean> {
    return false;
  }
  async touch(_securityId: string): Promise<void> {}
  async evict(_securityId: string): Promise<void> {}
}

export function yearsInRange(range: Required<DateRange>): number[] {
  const first = Number(range.from.slice(0, 4));
  const last = Number(range.to.slice(0, 4));
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

const SET_HYDRATING = `
-- set-hydrating
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

const BEGIN_REFRESH = `
-- begin-refresh
if redis.call('ZSCORE', KEYS[3], ARGV[1]) == false then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SADD', KEYS[2], KEYS[1])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

const INVALIDATE_MANIFEST = `
-- invalidate-manifest
if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

const EVICT_RESIDENT_STOCK = `
-- evict-resident-stock
if redis.call('ZSCORE', KEYS[2], ARGV[1]) == false then return 0 end
local keys = redis.call('SMEMBERS', KEYS[1])
for _, key in ipairs(keys) do redis.call('DEL', key) end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

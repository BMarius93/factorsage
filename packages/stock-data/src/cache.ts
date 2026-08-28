import type {
  DailyPrice,
  DailyTechnical,
  DateRange,
  FinancialStatement,
  FinancialStatementCadence,
  FinancialStatementQuery,
  FinancialStatementType,
  Security,
} from "@intrinsic/domain";
import {
  FINANCIAL_STATEMENT_TYPES,
  selectFinancialStatements,
} from "@intrinsic/domain";
import type { WeeklyPrice } from "./weekly.js";

export const PRICE_DATASET_VERSION = 1;
export const FINANCIAL_STATEMENT_VERSION = 1;

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
  lastFundamentalsRefreshAt?: string;
  hydrationId?: string;
  hydratingAt?: string;
  priceDatasetVersion: number;
  financialStatementVersion: number;
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
  setSecurity(security: Security, hydrating?: StockManifest): Promise<void>;
  getManifest(securityId: string): Promise<StockManifest | null>;
  setManifest(manifest: StockManifest): Promise<void>;
  beginHydration(
    observed: StockManifest | null,
    hydrating: StockManifest,
  ): Promise<boolean>;
  beginRefresh(
    observed: StockManifest,
    hydrating: StockManifest,
  ): Promise<boolean>;
  completeHydration(
    hydrating: StockManifest,
    ready: StockManifest,
  ): Promise<boolean>;
  invalidateManifest(manifest: StockManifest | null): Promise<boolean>;
  readDailyPrices(
    securityId: string,
    range: Required<DateRange>,
  ): Promise<DailyPrice[] | null>;
  writeDailyPriceYears(
    securityId: string,
    prices: readonly DailyPrice[],
    years: readonly number[],
    hydrating?: StockManifest,
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
    hydrating?: StockManifest,
  ): Promise<void>;
  writeWeeklyPriceYears(
    securityId: string,
    prices: readonly WeeklyPrice[],
    years: readonly number[],
    calculationVersion: number,
    hydrating?: StockManifest,
  ): Promise<void>;
  readFinancialStatements(
    securityId: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[] | null>;
  writeFinancialStatementYears(
    securityId: string,
    statements: readonly FinancialStatement[],
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
    years: readonly number[],
    hydrating?: StockManifest,
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
    private readonly hydrationTtlMs = DEFAULT_HYDRATION_TTL_MS,
  ) {
    if (!Number.isInteger(maxResidentStocks) || maxResidentStocks <= 0) {
      throw new Error("maxResidentStocks must be a positive integer");
    }
    if (!Number.isInteger(hydrationTtlMs) || hydrationTtlMs <= 0) {
      throw new Error("hydrationTtlMs must be a positive integer");
    }
  }

  async getSecurity(symbol: string): Promise<Security | null> {
    return this.readJson<Security>(this.symbolSecurityKey(symbol));
  }

  async setSecurity(
    security: Security,
    hydrating?: StockManifest,
  ): Promise<void> {
    const key = this.symbolSecurityKey(security.symbol);
    await this.setRegistered(
      security.id,
      key,
      JSON.stringify(security),
      hydrating,
    );
  }

  async getManifest(securityId: string): Promise<StockManifest | null> {
    return this.readJson<StockManifest>(this.manifestKey(securityId));
  }

  async setManifest(manifest: StockManifest): Promise<void> {
    if (manifest.status === "READY") {
      if (!(await this.publishReady(null, manifest))) {
        throw new Error("Stock cache hydration generation changed");
      }
      return;
    }
    const observed = await this.getManifest(manifest.securityId);
    if (!(await this.beginHydration(observed, manifest))) {
      throw new Error("Stock cache hydration generation changed");
    }
  }

  async beginHydration(
    observed: StockManifest | null,
    hydrating: StockManifest,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      BEGIN_HYDRATION,
      3,
      this.manifestKey(hydrating.securityId),
      this.registryKey(hydrating.securityId),
      this.residentKey(),
      hydrating.securityId,
      observed ? "1" : "0",
      observed ? JSON.stringify(observed) : "",
      JSON.stringify(hydrating),
      String(this.hydrationTtlMs),
    );
    return result === 1;
  }

  async beginRefresh(
    observed: StockManifest,
    hydrating: StockManifest,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      BEGIN_REFRESH,
      3,
      this.manifestKey(observed.securityId),
      this.registryKey(observed.securityId),
      this.residentKey(),
      observed.securityId,
      JSON.stringify(observed),
      JSON.stringify(hydrating),
      String(this.hydrationTtlMs),
    );
    return result === 1;
  }

  async completeHydration(
    hydrating: StockManifest,
    ready: StockManifest,
  ): Promise<boolean> {
    return this.publishReady(hydrating, ready);
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
    hydrating?: StockManifest,
  ): Promise<void> {
    await this.writeYearly(
      securityId,
      prices,
      years,
      (row) => row.date,
      (year) => this.priceYearKey(securityId, year),
      hydrating,
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
    hydrating?: StockManifest,
  ): Promise<void> {
    await this.writeYearly(
      securityId,
      technicals,
      years,
      (row) => row.date,
      (year) => this.technicalYearKey(securityId, calculationVersion, year),
      hydrating,
    );
  }

  async writeWeeklyPriceYears(
    securityId: string,
    prices: readonly WeeklyPrice[],
    years: readonly number[],
    calculationVersion: number,
    hydrating?: StockManifest,
  ): Promise<void> {
    await this.writeYearly(
      securityId,
      prices,
      years,
      (row) => row.weekStartDate,
      (year) => this.weeklyYearKey(securityId, calculationVersion, year),
      hydrating,
    );
  }

  async readFinancialStatements(
    securityId: string,
    query: FinancialStatementQuery,
  ): Promise<FinancialStatement[] | null> {
    const manifest = await this.getManifest(securityId);
    if (manifest?.status !== "READY") {
      return null;
    }
    const range = this.financialReadRange(query, manifest);
    if (!range) {
      return [];
    }

    const years = yearsInRange(range);
    const statementTypes = query.statementTypes ?? FINANCIAL_STATEMENT_TYPES;
    const cadences: readonly FinancialStatementCadence[] = query.cadence
      ? [query.cadence]
      : ["QUARTERLY", "ANNUAL"];

    const keys = statementTypes.flatMap((statementType) =>
      cadences.flatMap((cadence) =>
        years.map((year) =>
          this.financialYearKey(securityId, statementType, cadence, year),
        ),
      ),
    );
    const payloads = await this.redis.mget(...keys);
    if (payloads.some((payload) => payload === null)) {
      return null;
    }
    const selected = selectFinancialStatements(
      payloads
        .flatMap(
          (payload) => JSON.parse(payload ?? "[]") as FinancialStatement[],
        )
        .filter((row) => row.fiscalDate >= range.from && row.fiscalDate <= range.to),
      query,
    );
    await this.touch(securityId);
    return selected;
  }

  async writeFinancialStatementYears(
    securityId: string,
    statements: readonly FinancialStatement[],
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
    years: readonly number[],
    hydrating?: StockManifest,
  ): Promise<void> {
    await this.writeYearly(
      securityId,
      statements,
      years,
      (row) => row.fiscalDate,
      (year) =>
        this.financialYearKey(securityId, statementType, cadence, year),
      hydrating,
    );
  }

  async hasResidentStock(securityId: string): Promise<boolean> {
    return (await this.redis.zscore(this.residentKey(), securityId)) !== null;
  }

  async touch(securityId: string): Promise<void> {
    await this.redis.eval(
      TOUCH_READY,
      3,
      this.manifestKey(securityId),
      this.residentKey(),
      this.accessSequenceKey(),
      securityId,
    );
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
    hydrating?: StockManifest,
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
      await this.setRegistered(
        securityId,
        key,
        JSON.stringify(values),
        hydrating,
      );
    }
  }

  private async setRegistered(
    securityId: string,
    key: string,
    value: string,
    hydrating?: StockManifest,
  ): Promise<void> {
    const result = await this.redis.eval(
      SET_REGISTERED,
      3,
      key,
      this.registryKey(securityId),
      this.manifestKey(securityId),
      value,
      hydrating ? JSON.stringify(hydrating) : "",
      String(this.hydrationTtlMs),
    );
    if (result !== 1) {
      throw new Error("Stock cache hydration generation changed");
    }
  }

  private async publishReady(
    hydrating: StockManifest | null,
    ready: StockManifest,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      PUBLISH_READY,
      4,
      this.manifestKey(ready.securityId),
      this.registryKey(ready.securityId),
      this.residentKey(),
      this.accessSequenceKey(),
      JSON.stringify(ready),
      ready.securityId,
      String(this.maxResidentStocks),
      this.namespace,
      hydrating ? JSON.stringify(hydrating) : "",
    );
    return result === 1;
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

  private financialYearKey(
    securityId: string,
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
    year: number,
  ): string {
    return `${this.namespace}:security:${securityId}:financials:${statementTypeKey(statementType)}:${cadenceKey(cadence)}:v${FINANCIAL_STATEMENT_VERSION}:${year}`;
  }

  private financialReadRange(
    query: FinancialStatementQuery,
    manifest: StockManifest,
  ): Required<DateRange> | null {
    const from = query.from ?? manifest.coverageStart;
    const to = query.to ?? manifest.coverageEnd;
    if (!from || !to || from > to) {
      return null;
    }
    return { from, to };
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
  async setSecurity(
    _security: Security,
    _hydrating?: StockManifest,
  ): Promise<void> {}
  async getManifest(_securityId: string): Promise<StockManifest | null> {
    return null;
  }
  async setManifest(_manifest: StockManifest): Promise<void> {}
  async beginHydration(
    _observed: StockManifest | null,
    _hydrating: StockManifest,
  ): Promise<boolean> {
    return true;
  }
  async beginRefresh(
    _observed: StockManifest,
    _hydrating: StockManifest,
  ): Promise<boolean> {
    return false;
  }
  async completeHydration(
    _hydrating: StockManifest,
    _ready: StockManifest,
  ): Promise<boolean> {
    return true;
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
    _hydrating?: StockManifest,
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
    _hydrating?: StockManifest,
  ): Promise<void> {}
  async writeWeeklyPriceYears(
    _securityId: string,
    _prices: readonly WeeklyPrice[],
    _years: readonly number[],
    _calculationVersion: number,
    _hydrating?: StockManifest,
  ): Promise<void> {}
  async readFinancialStatements(
    _securityId: string,
    _query: FinancialStatementQuery,
  ): Promise<FinancialStatement[] | null> {
    return null;
  }
  async writeFinancialStatementYears(
    _securityId: string,
    _statements: readonly FinancialStatement[],
    _statementType: FinancialStatementType,
    _cadence: FinancialStatementCadence,
    _years: readonly number[],
    _hydrating?: StockManifest,
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

const DEFAULT_HYDRATION_TTL_MS = 15 * 60 * 1_000;

const BEGIN_HYDRATION = `
-- begin-hydration
local current = redis.call('GET', KEYS[1])
if ARGV[2] == '0' and current ~= false then return 0 end
if ARGV[2] == '1' and current ~= ARGV[3] then return 0 end
local keys = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(keys) do redis.call('DEL', key) end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('SET', KEYS[1], ARGV[4], 'PX', ARGV[5])
redis.call('SADD', KEYS[2], KEYS[1])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return 1
`;

const BEGIN_REFRESH = `
-- begin-refresh
if redis.call('GET', KEYS[1]) ~= ARGV[2] then return 0 end
if redis.call('ZSCORE', KEYS[3], ARGV[1]) == false then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
redis.call('SADD', KEYS[2], KEYS[1])
local keys = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(keys) do redis.call('PEXPIRE', key, ARGV[4]) end
redis.call('PEXPIRE', KEYS[2], ARGV[4])
redis.call('ZREM', KEYS[3], ARGV[1])
return 1
`;

const SET_REGISTERED = `
-- set-registered
local temporaryTtl = 0
local manifest = redis.call('GET', KEYS[3])
if ARGV[2] ~= '' then
  if manifest ~= ARGV[2] then return 0 end
  temporaryTtl = tonumber(ARGV[3])
elseif manifest ~= false then
  local ok, value = pcall(cjson.decode, manifest)
  if ok and value.status == 'HYDRATING' then
    temporaryTtl = redis.call('PTTL', KEYS[3])
    if temporaryTtl <= 0 then return 0 end
  end
end
if temporaryTtl > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', temporaryTtl)
else
  redis.call('SET', KEYS[1], ARGV[1])
end
redis.call('SADD', KEYS[2], KEYS[1])
if temporaryTtl > 0 then
  local keys = redis.call('SMEMBERS', KEYS[2])
  for _, key in ipairs(keys) do redis.call('PEXPIRE', key, temporaryTtl) end
  redis.call('PEXPIRE', KEYS[2], temporaryTtl)
end
return 1
`;

const TOUCH_READY = `
-- touch-ready
local manifest = redis.call('GET', KEYS[1])
if manifest == false then return 0 end
local ok, value = pcall(cjson.decode, manifest)
if not ok or value.status ~= 'READY' then return 0 end
local sequence = redis.call('INCR', KEYS[3])
redis.call('ZADD', KEYS[2], sequence, ARGV[1])
return 1
`;

const PUBLISH_READY = `
-- publish-ready
local current = redis.call('GET', KEYS[1])
if ARGV[5] ~= '' then
  if current ~= ARGV[5] then return 0 end
elseif current ~= false then
  return 0
end
local registered = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(registered) do redis.call('PERSIST', key) end
redis.call('PERSIST', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], KEYS[1])
local sequence = redis.call('INCR', KEYS[4])
redis.call('ZADD', KEYS[3], sequence, ARGV[2])
while redis.call('ZCARD', KEYS[3]) > tonumber(ARGV[3]) do
  local victim = redis.call('ZRANGE', KEYS[3], 0, 0)[1]
  if victim == nil then break end
  local registry = ARGV[4] .. ':security:' .. victim .. ':keys'
  local keys = redis.call('SMEMBERS', registry)
  for _, key in ipairs(keys) do redis.call('DEL', key) end
  redis.call('DEL', registry)
  redis.call('ZREM', KEYS[3], victim)
end
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

function statementTypeKey(statementType: FinancialStatementType): string {
  switch (statementType) {
    case "INCOME":
      return "income";
    case "BALANCE_SHEET":
      return "balance-sheet";
    case "CASH_FLOW":
      return "cash-flow";
  }
}

function cadenceKey(cadence: FinancialStatementCadence): string {
  return cadence === "QUARTERLY" ? "quarter" : "annual";
}

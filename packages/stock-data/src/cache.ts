export interface RedisCacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrange(key: string, start: number, stop: number): Promise<string[]>;
  zscore(key: string, member: string): Promise<string | null>;
  zrem(key: string, ...members: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
}

export interface StockDataCache {
  get<T>(symbol: string, datasetKey: string): Promise<T | null>;
  set<T>(symbol: string, datasetKey: string, value: T): Promise<void>;
  hasResidentSymbol(symbol: string): Promise<boolean>;
  touch(symbol: string): Promise<void>;
  evict(symbol: string): Promise<void>;
}

export class RedisSymbolStockCache implements StockDataCache {
  private sequence = 0;

  constructor(
    private readonly redis: RedisCacheClient,
    private readonly maxResidentSymbols: number,
    private readonly namespace = "stock-data:v1",
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxResidentSymbols) || maxResidentSymbols <= 0) {
      throw new Error("maxResidentSymbols must be a positive integer");
    }
  }

  async get<T>(symbol: string, datasetKey: string): Promise<T | null> {
    const payload = await this.redis.get(this.dataKey(symbol, datasetKey));
    if (payload === null) {
      return null;
    }
    await this.touch(symbol);
    return JSON.parse(payload) as T;
  }

  async set<T>(symbol: string, datasetKey: string, value: T): Promise<void> {
    const normalized = this.normalizeSymbol(symbol);
    const key = this.dataKey(normalized, datasetKey);
    await this.redis.set(key, JSON.stringify(value));
    await this.redis.sadd(this.registryKey(normalized), key);
    await this.touch(normalized);
    await this.enforceLimit();
  }

  async hasResidentSymbol(symbol: string): Promise<boolean> {
    return (
      (await this.redis.zscore(
        this.residentKey(),
        this.normalizeSymbol(symbol),
      )) !== null
    );
  }

  async touch(symbol: string): Promise<void> {
    this.sequence = (this.sequence + 1) % 1000;
    const score = this.now() * 1000 + this.sequence;
    await this.redis.zadd(
      this.residentKey(),
      score,
      this.normalizeSymbol(symbol),
    );
  }

  async evict(symbol: string): Promise<void> {
    const normalized = this.normalizeSymbol(symbol);
    const registry = this.registryKey(normalized);
    const keys = await this.redis.smembers(registry);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
    await this.redis.del(registry);
    await this.redis.zrem(this.residentKey(), normalized);
  }

  private async enforceLimit(): Promise<void> {
    const count = await this.redis.zcard(this.residentKey());
    const excess = count - this.maxResidentSymbols;
    if (excess <= 0) {
      return;
    }
    const victims = await this.redis.zrange(this.residentKey(), 0, excess - 1);
    for (const symbol of victims) {
      await this.evict(symbol);
    }
  }

  private normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
  }

  private residentKey(): string {
    return `${this.namespace}:resident-symbols`;
  }

  private registryKey(symbol: string): string {
    return `${this.namespace}:symbol:${encodeURIComponent(symbol)}:keys`;
  }

  private dataKey(symbol: string, datasetKey: string): string {
    return `${this.namespace}:symbol:${encodeURIComponent(this.normalizeSymbol(symbol))}:${datasetKey}`;
  }
}

export class NullStockDataCache implements StockDataCache {
  async get<T>(_symbol: string, _datasetKey: string): Promise<T | null> {
    return null;
  }

  async set<T>(
    _symbol: string,
    _datasetKey: string,
    _value: T,
  ): Promise<void> {}

  async hasResidentSymbol(_symbol: string): Promise<boolean> {
    return false;
  }

  async touch(_symbol: string): Promise<void> {}

  async evict(_symbol: string): Promise<void> {}
}

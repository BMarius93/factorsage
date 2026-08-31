import type {
  DateRange,
  FinancialStatementCadence,
  FinancialStatementDraft,
  FinancialStatementType,
} from "@intrinsic/domain";
import {
  mapFmpDailyPrices,
  mapFmpFinancialStatements,
  financialStatementPath,
  mapFmpProfile,
  mapFmpStockUniverse,
  type FmpDailyPriceDto,
  type FmpProfileDto,
  type FmpSecurityCatalogPort,
  type FmpStockProviderPort,
  type FmpStockUniverseDto,
  type MappedFmpProfile,
  type MappedFmpSecurityListing,
} from "./mapping.js";

export type FmpClientConfig = {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxRetryWaitMs?: number;
};

export interface FmpRequestGate {
  run<T>(request: () => Promise<T>): Promise<T>;
  publishCooldown(delayMs: number): Promise<void>;
}

export class FmpProviderError extends Error {
  readonly retryable: boolean = false;

  constructor(
    message = "Stock data provider request failed",
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "FmpProviderError";
  }
}

export class FmpRateLimitError extends FmpProviderError {
  override readonly retryable: boolean = true;

  constructor(readonly retryAfterMs?: number) {
    super("Stock data provider rate limit exceeded", 429);
    this.name = "FmpRateLimitError";
  }
}

export class FmpUnauthorizedError extends FmpProviderError {
  constructor(statusCode: 401 | 403) {
    super("Stock data provider authentication failed", statusCode);
    this.name = "FmpUnauthorizedError";
  }
}

export class FmpTransientError extends FmpProviderError {
  override readonly retryable: boolean = true;

  constructor(statusCode?: number) {
    super("Stock data provider is temporarily unavailable", statusCode);
    this.name = "FmpTransientError";
  }
}

export type FmpClientDependencies = {
  gate?: FmpRequestGate;
  sleep?: (delayMs: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

const directGate: FmpRequestGate = {
  run: (request) => request(),
  publishCooldown: async () => {},
};

/**
 * Upper bound for one bulk universe request.
 *
 * The screener caps its own page at the requested limit, and the largest supported exchange is
 * well under this, so one request per exchange returns the complete listing set.
 */
const STOCK_UNIVERSE_REQUEST_LIMIT = 20_000;

export class FmpClient
  implements FmpStockProviderPort, FmpSecurityCatalogPort
{
  private readonly gate: FmpRequestGate;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly getConfig: () => FmpClientConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
    dependencies: FmpClientDependencies = {},
  ) {
    this.gate = dependencies.gate ?? directGate;
    this.sleep =
      dependencies.sleep ??
      ((delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }));
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }

  async getProfile(symbol: string): Promise<MappedFmpProfile | null> {
    const payload = await this.request<FmpProfileDto[]>("profile", {
      symbol: symbol.toUpperCase(),
    });
    const first = payload[0];
    return first ? mapFmpProfile(first) : null;
  }

  async getStockUniverse(
    exchangeCode: string,
  ): Promise<MappedFmpSecurityListing[]> {
    // Filtering upstream keeps ETFs and funds off the wire entirely; the domain still re-checks
    // every row, because a provider filter is a convenience, not the product's definition.
    const payload = await this.request<FmpStockUniverseDto[]>(
      "company-screener",
      {
        exchange: exchangeCode.trim().toUpperCase(),
        isEtf: "false",
        isFund: "false",
        limit: String(STOCK_UNIVERSE_REQUEST_LIMIT),
      },
    );
    return mapFmpStockUniverse(payload);
  }

  async getDailyPrices(symbol: string, securityId: string, range: DateRange) {
    const payload = await this.request<FmpDailyPriceDto[]>(
      "historical-price-eod/full",
      {
        symbol: symbol.toUpperCase(),
        ...(range.from ? { from: range.from } : {}),
        ...(range.to ? { to: range.to } : {}),
      },
    );
    return mapFmpDailyPrices(securityId, payload);
  }

  async getFinancialStatements(
    symbol: string,
    securityId: string,
    statementType: FinancialStatementType,
    cadence: FinancialStatementCadence,
    limit: number,
  ): Promise<FinancialStatementDraft[]> {
    const payload = await this.request<unknown[]>(financialStatementPath(statementType), {
      symbol: symbol.toUpperCase(),
      period: cadence === "QUARTERLY" ? "quarter" : "annual",
      limit: String(limit),
    });
    return mapFmpFinancialStatements({
      securityId,
      statementType,
      rows: payload as readonly Record<string, unknown>[],
    });
  }

  private async request<T>(
    path: string,
    query: Record<string, string>,
  ): Promise<T> {
    const config = this.getConfig();
    const maxRetries = config.maxRetries ?? 3;
    const retryBaseDelayMs = config.retryBaseDelayMs ?? 500;
    const retryMaxDelayMs = config.retryMaxDelayMs ?? 30_000;
    const maxRetryWaitMs = config.maxRetryWaitMs ?? 30_000;
    const url = new URL(
      path,
      config.baseUrl ?? "https://financialmodelingprep.com/stable/",
    );
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("apikey", config.apiKey);

    let retryWaitedMs = 0;
    for (let attempt = 0; ; attempt += 1) {
      let error: FmpProviderError;
      let cooldownPublished = false;
      try {
        return await this.gate.run(async () => {
          const response = await this.fetchImplementation(url, {
            signal: AbortSignal.timeout(config.timeoutMs),
            headers: { accept: "application/json" },
          });
          if (!response.ok) {
            const classified = this.classifyResponse(response);
            if (classified instanceof FmpRateLimitError) {
              const delayMs = this.retryDelay(
                classified,
                attempt,
                retryBaseDelayMs,
                retryMaxDelayMs,
              );
              await this.gate.publishCooldown(delayMs);
              cooldownPublished = true;
            }
            throw classified;
          }
          const payload: unknown = await response.json();
          if (!Array.isArray(payload)) {
            throw new FmpProviderError(
              "Stock data provider returned invalid data",
            );
          }
          return payload as T;
        });
      } catch (caught) {
        error =
          caught instanceof FmpProviderError ? caught : new FmpTransientError();
      }

      const delayMs = error.retryable
        ? this.retryDelay(error, attempt, retryBaseDelayMs, retryMaxDelayMs)
        : 0;
      if (error instanceof FmpRateLimitError && !cooldownPublished) {
        await this.gate.publishCooldown(delayMs);
      }
      if (!error.retryable || attempt >= maxRetries) {
        throw error;
      }
      if (retryWaitedMs + delayMs > maxRetryWaitMs) {
        throw error;
      }
      retryWaitedMs += delayMs;
      await this.sleep(delayMs);
    }
  }

  private classifyResponse(response: Response): FmpProviderError {
    if (response.status === 429) {
      return new FmpRateLimitError(
        parseRetryAfter(response.headers.get("retry-after"), this.now()),
      );
    }
    if (response.status === 401 || response.status === 403) {
      return new FmpUnauthorizedError(response.status);
    }
    if (response.status === 408 || response.status >= 500) {
      return new FmpTransientError(response.status);
    }
    return new FmpProviderError(
      "Stock data provider rejected the request",
      response.status,
    );
  }

  private retryDelay(
    error: FmpProviderError,
    attempt: number,
    baseDelayMs: number,
    maxDelayMs: number,
  ): number {
    if (
      error instanceof FmpRateLimitError &&
      error.retryAfterMs !== undefined
    ) {
      const jitter = Math.floor(
        this.random() * Math.min(Math.max(error.retryAfterMs * 0.05, 1), 1_000),
      );
      return error.retryAfterMs + jitter;
    }
    const bounded = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
    const jitter = Math.floor(
      this.random() * Math.min(Math.max(bounded * 0.2, 1), 1_000),
    );
    return Math.min(bounded + jitter, maxDelayMs);
  }
}

export function parseRetryAfter(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) {
    return undefined;
  }
  return Math.max(0, instant - nowMs);
}

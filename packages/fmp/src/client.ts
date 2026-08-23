import type { DateRange } from "@intrinsic/domain";
import {
  mapFmpDailyPrices,
  mapFmpProfile,
  type FmpDailyPriceDto,
  type FmpProfileDto,
  type FmpStockProviderPort,
  type MappedFmpProfile,
} from "./mapping.js";

export type FmpClientConfig = {
  apiKey: string;
  timeoutMs: number;
  baseUrl?: string;
};

export class FmpProviderError extends Error {
  constructor() {
    super("Stock data provider request failed");
    this.name = "FmpProviderError";
  }
}

export class FmpClient implements FmpStockProviderPort {
  constructor(
    private readonly getConfig: () => FmpClientConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async getProfile(symbol: string): Promise<MappedFmpProfile | null> {
    const payload = await this.request<FmpProfileDto[]>("profile", {
      symbol: symbol.toUpperCase(),
    });
    const first = payload[0];
    return first ? mapFmpProfile(first) : null;
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

  private async request<T>(
    path: string,
    query: Record<string, string>,
  ): Promise<T> {
    const config = this.getConfig();
    const url = new URL(
      path,
      config.baseUrl ?? "https://financialmodelingprep.com/stable/",
    );
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    url.searchParams.set("apikey", config.apiKey);

    try {
      const response = await this.fetchImplementation(url, {
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: { accept: "application/json" },
      });
      if (!response.ok) {
        throw new FmpProviderError();
      }
      const payload: unknown = await response.json();
      if (!Array.isArray(payload)) {
        throw new FmpProviderError();
      }
      return payload as T;
    } catch (error) {
      if (error instanceof FmpProviderError) {
        throw error;
      }
      throw new FmpProviderError();
    }
  }
}

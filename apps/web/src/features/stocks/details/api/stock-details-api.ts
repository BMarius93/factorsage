import type {
  DailyPriceResponse,
  DailyTechnicalResponse,
  IntrinsicValueBlendIdResponse,
  IntrinsicValueBlendResponse,
  IntrinsicValueModelResponse,
  IntrinsicValueResponse,
  StockDetailsResponse,
} from "@intrinsic/contracts";
import { apiGet } from "../../../../lib/api/client";

/**
 * Stock Details reads against the V2 API.
 *
 * The composite endpoint carries everything the page needs for its default one-year window; the
 * dedicated history endpoints exist for the single lazy full-history load behind the long chart
 * ranges. All requests are bounded, inclusive `YYYY-MM-DD` windows.
 */
export type StockHistoryWindow = {
  readonly from: string;
  readonly to: string;
};

type RequestOptions = {
  readonly signal?: AbortSignal;
};

function stockPath(symbol: string, suffix = ""): string {
  return `/stocks/${encodeURIComponent(symbol)}${suffix}`;
}

export function fetchStockDetails(
  symbol: string,
  window: StockHistoryWindow,
  options: RequestOptions = {},
): Promise<StockDetailsResponse> {
  return apiGet<StockDetailsResponse>(stockPath(symbol), {
    query: { from: window.from, to: window.to },
    ...options,
  });
}

export function fetchDailyPriceHistory(
  symbol: string,
  window: StockHistoryWindow,
  options: RequestOptions = {},
): Promise<DailyPriceResponse[]> {
  return apiGet<DailyPriceResponse[]>(stockPath(symbol, "/prices"), {
    query: { from: window.from, to: window.to },
    ...options,
  });
}

export function fetchDailyTechnicalHistory(
  symbol: string,
  window: StockHistoryWindow,
  options: RequestOptions = {},
): Promise<DailyTechnicalResponse[]> {
  return apiGet<DailyTechnicalResponse[]>(stockPath(symbol, "/technicals/daily"), {
    query: { from: window.from, to: window.to },
    ...options,
  });
}

export function fetchIntrinsicValueBlendHistory(
  symbol: string,
  window: StockHistoryWindow,
  blendIds: readonly IntrinsicValueBlendIdResponse[],
  options: RequestOptions = {},
): Promise<IntrinsicValueBlendResponse[]> {
  return apiGet<IntrinsicValueBlendResponse[]>(
    stockPath(symbol, "/intrinsic-value-blends"),
    {
      query: { from: window.from, to: window.to, blendIds: blendIds.join(",") },
      ...options,
    },
  );
}

export function fetchIntrinsicValueHistory(
  symbol: string,
  window: StockHistoryWindow,
  models: readonly IntrinsicValueModelResponse[],
  options: RequestOptions = {},
): Promise<IntrinsicValueResponse[]> {
  return apiGet<IntrinsicValueResponse[]>(
    stockPath(symbol, "/intrinsic-values"),
    {
      query: { from: window.from, to: window.to, models: models.join(",") },
      ...options,
    },
  );
}

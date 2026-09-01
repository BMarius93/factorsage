import type {
  AddStockListItemsRequest,
  CreateStockListRequest,
  ReplaceBuyWindowsRequest,
  StockListDetailResponse,
  StockListItemResponse,
  StockListSummaryResponse,
  UpdateStockListRequest,
} from "@intrinsic/contracts";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
} from "../../../lib/api/client";

export function fetchStockLists(options: { signal?: AbortSignal } = {}) {
  return apiGet<StockListSummaryResponse[]>("/lists", options);
}

export async function createStockList(
  input: CreateStockListRequest,
): Promise<StockListDetailResponse> {
  return (await apiPost<StockListDetailResponse>(
    "/lists",
    input,
  )) as StockListDetailResponse;
}

export function fetchStockList(
  listId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<StockListDetailResponse>(`/lists/${listId}`, options);
}

export async function updateStockList(
  listId: string,
  patch: UpdateStockListRequest,
): Promise<StockListSummaryResponse> {
  return (await apiPatch<StockListSummaryResponse>(
    `/lists/${listId}`,
    patch,
  )) as StockListSummaryResponse;
}

export async function deleteStockList(listId: string): Promise<void> {
  await apiDelete(`/lists/${listId}`);
}

/** Idempotent batch add; the API answers with the complete updated list. */
export async function addStockListItems(
  listId: string,
  input: AddStockListItemsRequest,
): Promise<StockListDetailResponse> {
  return (await apiPost<StockListDetailResponse>(
    `/lists/${listId}/items`,
    input,
  )) as StockListDetailResponse;
}

export async function removeStockListItem(
  listId: string,
  itemId: string,
): Promise<void> {
  await apiDelete(`/lists/${listId}/items/${itemId}`);
}

/**
 * Replaces the item's complete buy-window configuration. The response carries the canonical
 * normalized ranges, which callers must render instead of the submitted input.
 */
export async function replaceBuyWindows(
  listId: string,
  itemId: string,
  input: ReplaceBuyWindowsRequest,
): Promise<StockListItemResponse> {
  return (await apiPut<StockListItemResponse>(
    `/lists/${listId}/items/${itemId}/buy-windows`,
    input,
  )) as StockListItemResponse;
}

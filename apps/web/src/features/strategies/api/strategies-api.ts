import type {
  CreateStrategyRequest,
  StrategyDefinition,
  StrategyDetailResponse,
  StrategySummaryResponse,
  StrategyValidationIssue,
  UpdateStrategyRequest,
} from "@intrinsic/contracts";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
} from "../../../lib/api/client";

export function fetchStrategies(options: { signal?: AbortSignal } = {}) {
  return apiGet<StrategySummaryResponse[]>("/strategies", options);
}

export async function createStrategy(
  input: CreateStrategyRequest,
): Promise<StrategyDetailResponse> {
  return (await apiPost<StrategyDetailResponse>(
    "/strategies",
    input,
  )) as StrategyDetailResponse;
}

export function fetchStrategy(
  strategyId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<StrategyDetailResponse>(`/strategies/${strategyId}`, options);
}

export async function updateStrategy(
  strategyId: string,
  patch: UpdateStrategyRequest,
): Promise<StrategySummaryResponse> {
  return (await apiPatch<StrategySummaryResponse>(
    `/strategies/${strategyId}`,
    patch,
  )) as StrategySummaryResponse;
}

/** Replaces the COMPLETE definition; the response carries the canonical normalized result. */
export async function replaceStrategyDefinition(
  strategyId: string,
  definition: StrategyDefinition,
): Promise<StrategyDetailResponse> {
  return (await apiPut<StrategyDetailResponse>(
    `/strategies/${strategyId}/definition`,
    { definition },
  )) as StrategyDetailResponse;
}

export async function deleteStrategy(strategyId: string): Promise<void> {
  await apiDelete(`/strategies/${strategyId}`);
}

/**
 * The validation issues carried by a rejected save, or an empty list for any other failure.
 *
 * The Builder validates with the same canonical validator the API uses, so a UI-driven save should
 * never produce these. When one does — a stale client, a concurrent edit — they are mapped back
 * onto the offending rows rather than shown as an unactionable banner.
 */
export function strategyIssuesFrom(
  error: unknown,
): readonly StrategyValidationIssue[] {
  if (!(error instanceof ApiError) || !error.issues) {
    return [];
  }
  return error.issues as readonly StrategyValidationIssue[];
}

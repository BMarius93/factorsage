import type {
  CreateMonitorRequest,
  MonitorDetailResponse,
  MonitorSummaryResponse,
  UpdateMonitorRequest,
} from "@intrinsic/contracts";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../../lib/api/client";

export function fetchMonitors(options: { signal?: AbortSignal } = {}) {
  return apiGet<MonitorSummaryResponse[]>("/monitors", options);
}

/**
 * One monitor with its current evaluation table and its newest Signals.
 *
 * The whole detail page is this single request: the evaluation status of every monitored security
 * comes back with it, so nothing is fetched per security or per Signal.
 */
export function fetchMonitor(
  monitorId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<MonitorDetailResponse>(`/monitors/${monitorId}`, options);
}

export async function createMonitor(
  input: CreateMonitorRequest,
): Promise<MonitorDetailResponse> {
  return (await apiPost<MonitorDetailResponse>(
    "/monitors",
    input,
  )) as MonitorDetailResponse;
}

/**
 * Patches a monitor's name, whether it is enabled, and which Strategy and Stock List it watches.
 *
 * Sending a different `strategyId` or `stockListId` **rebinds** the monitor: the API resolves the
 * Signals still active under the configuration being replaced, discards its transition state and
 * clears its last-checked time, so the caller should re-read the monitor rather than patch its
 * previous detail locally. Resubmitting the same references changes nothing — the API compares
 * values, not which keys were sent. There is still no cadence to set.
 */
export async function updateMonitor(
  monitorId: string,
  patch: UpdateMonitorRequest,
): Promise<MonitorSummaryResponse> {
  return (await apiPatch<MonitorSummaryResponse>(
    `/monitors/${monitorId}`,
    patch,
  )) as MonitorSummaryResponse;
}

export async function deleteMonitor(monitorId: string): Promise<void> {
  await apiDelete(`/monitors/${monitorId}`);
}

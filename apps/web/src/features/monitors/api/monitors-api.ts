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

export async function createMonitor(
  input: CreateMonitorRequest,
): Promise<MonitorDetailResponse> {
  return (await apiPost<MonitorDetailResponse>(
    "/monitors",
    input,
  )) as MonitorDetailResponse;
}

/**
 * Patches the name or whether the monitor is enabled.
 *
 * Those are the only two things `PATCH /monitors/:id` accepts, and that is the product rule rather
 * than an omission: a monitor's strategy and list are not mutable, and there is no cadence to set.
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

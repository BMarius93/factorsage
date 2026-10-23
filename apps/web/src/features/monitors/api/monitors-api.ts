import type {
  CreateMonitorRequest,
  MonitorDetailResponse,
  MonitorDetailSummaryResponse,
  MonitorLevelKind,
  MonitorSignalPageResponse,
  MonitorSignalRowState,
  MonitorSummaryResponse,
  UpdateMonitorRequest,
} from "@intrinsic/contracts";
import { apiDelete, apiGet, apiPatch, apiPost } from "../../../lib/api/client";

export function fetchMonitors(options: { signal?: AbortSignal } = {}) {
  return apiGet<MonitorSummaryResponse[]>("/monitors", options);
}

/**
 * The Monitor's page as it renders (`?view=summary`): its detail with the current members counted
 * rather than listed, and without the newest Signals, which the page reads a page at a time.
 */
export function fetchMonitor(
  monitorId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<MonitorDetailSummaryResponse>(
    `/monitors/${monitorId}?view=summary`,
    options,
  );
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
 * `enabled` is the one switch every monitor has. On a built-in it is the caller's own choice for
 * their account — whether its activity reaches their dashboard — and it never changes the shared
 * monitor for anyone else; a Guest's call is refused, which is why the page asks for an account.
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

/**
 * One page of the Monitor's Signal table: active occurrences first, then resolved ones — or the
 * waiting setups when `state` is `PENDING_TRIGGER`.
 */
export function fetchMonitorSignals(
  monitorId: string,
  query: {
    state?: MonitorSignalRowState;
    levelKind?: MonitorLevelKind;
    limit?: number;
    cursor?: string;
  } = {},
  options: { signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams();
  if (query.state) params.set("state", query.state);
  if (query.levelKind) params.set("levelKind", query.levelKind);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const search = params.toString();
  return apiGet<MonitorSignalPageResponse>(
    `/monitors/${monitorId}/signals${search ? `?${search}` : ""}`,
    options,
  );
}

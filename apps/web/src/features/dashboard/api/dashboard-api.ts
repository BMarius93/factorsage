import type {
  DashboardResponse,
  UpdateBuiltInMonitorVisibilityRequest,
} from "@intrinsic/contracts";
import { apiGet, apiPut } from "../../../lib/api/client";

/** The whole Dashboard in one request: monitors, their freshness and every current row. */
export function fetchDashboard(options: { signal?: AbortSignal } = {}) {
  return apiGet<DashboardResponse>("/dashboard", options);
}

/**
 * Shows or hides a published built-in monitor on the signed-in user's Dashboard.
 *
 * Visibility only: the shared monitor keeps being evaluated for everyone. A Guest's call is refused
 * by the API, which is why the page asks a Guest to sign in instead of making it.
 */
export async function setBuiltInMonitorVisibility(
  monitorId: string,
  body: UpdateBuiltInMonitorVisibilityRequest,
): Promise<void> {
  await apiPut(`/dashboard/monitors/${monitorId}/visibility`, body);
}

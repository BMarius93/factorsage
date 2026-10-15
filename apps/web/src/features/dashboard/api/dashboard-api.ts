import type {
  DashboardActivityResponse,
  DashboardResponse,
} from "@intrinsic/contracts";
import { apiGet } from "../../../lib/api/client";

/** The whole Dashboard in one request: monitors, their freshness and every current row. */
export function fetchDashboard(options: { signal?: AbortSignal } = {}) {
  return apiGet<DashboardResponse>("/dashboard", options);
}

/**
 * One page of Monitor Activity: the changes the viewer's visible Monitors observed, newest session
 * first. `cursor` continues from the previous page's `nextCursor`.
 */
export function fetchMonitorActivity(
  query: { monitorId?: string; limit?: number; cursor?: string } = {},
  options: { signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams();
  if (query.monitorId) params.set("monitorId", query.monitorId);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const search = params.toString();
  return apiGet<DashboardActivityResponse>(
    `/dashboard/activity${search ? `?${search}` : ""}`,
    options,
  );
}

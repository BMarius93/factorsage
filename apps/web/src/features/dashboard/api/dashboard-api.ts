import type {
  DashboardActivityResponse,
  DashboardResponse,
  MonitorActivityKind,
} from "@intrinsic/contracts";
import { apiGet } from "../../../lib/api/client";

/** The whole Dashboard in one request: monitors, their freshness and every current row. */
export function fetchDashboard(options: { signal?: AbortSignal } = {}) {
  return apiGet<DashboardResponse>("/dashboard", options);
}

/**
 * One page of Monitor Activity: the changes the viewer's visible Monitors observed, newest session
 * first. `cursor` continues from the previous page's `nextCursor`; `monitorId` and `kind` narrow the
 * feed in the database, so the cursor pages the narrowed feed. `since` (a `watermark` an earlier
 * answer gave) reads what was written after it instead of a page.
 */
export function fetchMonitorActivity(
  query: {
    monitorId?: string;
    kind?: MonitorActivityKind;
    limit?: number;
    cursor?: string;
    since?: string;
  } = {},
  options: { signal?: AbortSignal } = {},
) {
  const params = new URLSearchParams();
  if (query.monitorId) params.set("monitorId", query.monitorId);
  if (query.kind) params.set("kind", query.kind);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.since !== undefined) params.set("since", query.since);
  const search = params.toString();
  return apiGet<DashboardActivityResponse>(
    `/dashboard/activity${search ? `?${search}` : ""}`,
    options,
  );
}

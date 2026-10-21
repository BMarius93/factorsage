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
 * feed in the database, so the cursor pages the narrowed feed. `through` (an event id) reads the range
 * from the newest event down to and including that one instead — how a reader refreshes what they
 * hold — continued with `cursor`.
 */
export type ActivityReadQuery = {
  monitorId?: string;
  kind?: MonitorActivityKind;
  limit?: number;
  cursor?: string;
  through?: string;
};

/** One read of an activity feed: the Dashboard's, or one Monitor's own history. */
export type ActivityReader = (
  query: ActivityReadQuery,
  options?: { signal?: AbortSignal },
) => Promise<DashboardActivityResponse>;

function activitySearch(query: ActivityReadQuery): string {
  const params = new URLSearchParams();
  if (query.monitorId) params.set("monitorId", query.monitorId);
  if (query.kind) params.set("kind", query.kind);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.through) params.set("through", query.through);
  const search = params.toString();
  return search ? `?${search}` : "";
}

export function fetchMonitorActivity(
  query: ActivityReadQuery = {},
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<DashboardActivityResponse>(
    `/dashboard/activity${activitySearch(query)}`,
    options,
  );
}

/**
 * One Monitor's own Activity history (`GET /monitors/:monitorId/activity`): the Dashboard's feed over
 * that Monitor alone, whatever the viewer's Dashboard shows. The Monitor is the path's, so a
 * `monitorId` in the query is never sent.
 */
export function fetchMonitorHistory(
  monitorId: string,
  query: ActivityReadQuery = {},
  options: { signal?: AbortSignal } = {},
) {
  const { monitorId: _ignored, ...rest } = query;
  void _ignored;
  return apiGet<DashboardActivityResponse>(
    `/monitors/${encodeURIComponent(monitorId)}/activity${activitySearch(rest)}`,
    options,
  );
}

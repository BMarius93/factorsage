import type { DemoBacktestListResponse } from "@intrinsic/contracts";
import { API_BASE_URL } from "../../lib/api/client";

/**
 * The public demonstration shelf (`GET /demo-backtests`), read on the server per request.
 *
 * No cookie is sent and none is needed: the route is public and its answer is the same for every
 * reader. A failure is the page's error state, never an empty shelf — "there are no demos" and "the
 * demos could not be read" must not look alike.
 */
export async function loadDemoBacktests(): Promise<DemoBacktestListResponse> {
  const response = await fetch(`${API_BASE_URL}/demo-backtests`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`The demonstration backtests could not be read (${response.status})`);
  }
  return (await response.json()) as DemoBacktestListResponse;
}

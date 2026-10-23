import {
  isBacktestShareToken,
  type SharedBacktestPreviewResponse,
  type SharedBacktestReportResponse,
} from "@intrinsic/contracts";
import { cache } from "react";
import { API_BASE_URL } from "../../../lib/api/client";

/**
 * The web server's reads of a shared backtest (`docs/decisions/backtest-sharing-v1.md`).
 *
 * Server-side only: the page and its link preview are rendered by Next.js from the public API, so
 * a crawler that runs no JavaScript still receives the report's metadata in the HTML, and the
 * browser receives the allowlisted report already rendered — no second request for it.
 *
 * Deliberately **no cookie is forwarded**. The public routes do not ask who is reading, so a
 * session would change nothing, and the web server has no business carrying one to them.
 *
 * `no-store`: a revoked link must stop rendering on the next request, so nothing here is kept in
 * Next's data cache. A malformed token is answered without a request at all, and the token never
 * appears in an error this module raises.
 */

async function readShared<T>(path: string): Promise<T | null> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `The shared backtest could not be read (${response.status})`,
    );
  }
  return (await response.json()) as T;
}

/**
 * The report behind a token, or `null` when there is none — malformed, unknown, revoked.
 *
 * Wrapped in React's per-request `cache`, so the page and its `generateMetadata` share one API
 * read rather than making two.
 */
export const loadSharedBacktestReport = cache(
  async (token: string): Promise<SharedBacktestReportResponse | null> => {
    if (!isBacktestShareToken(token)) {
      return null;
    }
    return readShared<SharedBacktestReportResponse>(
      `/shared-backtests/${token}`,
    );
  },
);

/** The link-preview card's data behind a token, or `null` when there is none. */
export async function loadSharedBacktestPreview(
  token: string,
): Promise<SharedBacktestPreviewResponse | null> {
  if (!isBacktestShareToken(token)) {
    return null;
  }
  return readShared<SharedBacktestPreviewResponse>(
    `/shared-backtests/${token}/preview`,
  );
}

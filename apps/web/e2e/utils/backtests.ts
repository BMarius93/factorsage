import { expect, type Page } from "@playwright/test";
import type {
  BacktestRunStatus,
  BacktestRunSummaryResponse,
} from "@intrinsic/contracts";
import { apiBaseUrl } from "./entitlements";

/**
 * Run state read from the API rather than from a page (E2E-003, E2E-004).
 *
 * Specs that submit a backtest must know when it has *settled* — reached `COMPLETED` or `FAILED` —
 * both to assert on it and to leave the persona's concurrency slot free for the next test. The
 * collection page is a poor source for that: it pages at 25 rows, newest first, and a persona that
 * has accumulated runs pushes an older in-flight one off the first page. `GET /backtests` returns
 * every run the signed-in user owns, and the page's own request context carries its session, so
 * this is the user's view of their own runs and nothing more privileged.
 */

const TERMINAL: ReadonlySet<BacktestRunStatus> = new Set([
  "COMPLETED",
  "FAILED",
]);

/** The strategy name the entitlement fixtures give their pinned, never-executing runs. */
export const PINNED_FIXTURE_RUN_STRATEGY = "ENT-In Flight";

/**
 * How long a run submitted by a spec may take to settle on the seeded stack.
 *
 * It bounds, per run: waiting in the durable queue for a worker child (the stack runs two, and
 * these specs never have more than two runs of their own in flight), preparing its data out of
 * PostgreSQL — every fixture security is either seeded or declared complete and empty, so nothing
 * waits on a provider — and simulating at most thirty years of sessions. Observed runs settle in
 * seconds; the margin absorbs a cold Redis projection and a machine under load, and a run that
 * needs longer is stuck, which is what the failure message then says.
 */
export const RUN_SETTLE_TIMEOUT_MS = 90_000;

/** How often run state is re-read while waiting. The API rate-limits this read per user. */
const POLL_INTERVALS_MS = [500, 1_000, 2_000];

export function runIdFromUrl(url: string): string {
  const match = /\/backtests\/([0-9a-f-]{36})$/.exec(url);
  if (!match?.[1]) {
    throw new Error(`Not a backtest run URL: ${url}`);
  }
  return match[1];
}

export function isTerminalStatus(status: string): boolean {
  return TERMINAL.has(status as BacktestRunStatus);
}

/** Every run of the signed-in user, straight from the API. */
export async function listRuns(
  page: Page,
): Promise<BacktestRunSummaryResponse[]> {
  const response = await page.request.get(`${apiBaseUrl()}/backtests`);
  expect(response.ok(), `GET /backtests answered ${response.status()}`).toBe(
    true,
  );
  return (await response.json()) as BacktestRunSummaryResponse[];
}

/** The signed-in user's runs that have not settled, as `id (strategy) STATUS` lines. */
export async function inFlightRuns(
  page: Page,
): Promise<BacktestRunSummaryResponse[]> {
  return (await listRuns(page)).filter((run) => !isTerminalStatus(run.status));
}

export function describeRuns(
  runs: readonly BacktestRunSummaryResponse[],
): string {
  return runs.length === 0
    ? "none"
    : runs
        .map((run) => `${run.id} (${run.strategyName}) ${run.status}`)
        .join("; ");
}

/**
 * Waits until every one of `runIds` has settled, failing with the stragglers named.
 *
 * Used as cleanup after a spec submitted runs, so it must work whether the test passed or failed:
 * a run left executing holds one of the persona's concurrency slots and makes the next spec's
 * result depend on how fast this one's run happened to finish.
 */
export async function waitForRunsToSettle(
  page: Page,
  runIds: readonly string[],
  timeoutMs = RUN_SETTLE_TIMEOUT_MS,
): Promise<void> {
  if (runIds.length === 0) {
    return;
  }
  const wanted = new Set(runIds);
  let unsettled: BacktestRunSummaryResponse[] = [];
  await expect
    .poll(
      async () => {
        unsettled = (await listRuns(page)).filter(
          (run) => wanted.has(run.id) && !isTerminalStatus(run.status),
        );
        return unsettled.length;
      },
      {
        timeout: timeoutMs,
        intervals: POLL_INTERVALS_MS,
        message:
          `Submitted runs did not settle within ${timeoutMs / 1000}s: ` +
          `${describeRuns(unsettled)}. Is \`pnpm dev:worker:e2e\` running?`,
      },
    )
    .toBe(0);
}

/**
 * Waits until the user's only unsettled runs are the entitlement fixtures' pinned ones — the state
 * a concurrency spec must start from and must leave behind.
 */
export async function waitForOnlyPinnedRunsInFlight(
  page: Page,
  timeoutMs = RUN_SETTLE_TIMEOUT_MS,
): Promise<BacktestRunSummaryResponse[]> {
  let stray: BacktestRunSummaryResponse[] = [];
  let pinned: BacktestRunSummaryResponse[] = [];
  await expect
    .poll(
      async () => {
        const inFlight = await inFlightRuns(page);
        pinned = inFlight.filter(
          (run) => run.strategyName === PINNED_FIXTURE_RUN_STRATEGY,
        );
        stray = inFlight.filter(
          (run) => run.strategyName !== PINNED_FIXTURE_RUN_STRATEGY,
        );
        return stray.length;
      },
      {
        timeout: timeoutMs,
        intervals: POLL_INTERVALS_MS,
        message:
          `Runs other than the pinned fixture run are still in flight after ${timeoutMs / 1000}s: ` +
          `${describeRuns(stray)}. A previous spec left one executing, or the worker is not ` +
          "running (`pnpm dev:worker:e2e`).",
      },
    )
    .toBe(0);
  return pinned;
}

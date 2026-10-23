import {
  BACKTEST_QUEUE_FULL_CODE,
  type BacktestQueueStateResponse,
} from "@intrinsic/contracts";
import { ApiError } from "../../../lib/api/client";
import { formatCount } from "./format";

/**
 * Where a queued run stands, in words that promise nothing the scheduler does not
 * (`docs/decisions/entitlements-v2.md` §5, `ai/architecture/backtest-execution.md` "Global
 * admission").
 *
 * Waiting runs are claimed in a fair order across owners — by how many runs each owner already has
 * executing, then by queue time — so `ahead`, the runs queued before this one across the whole
 * deployment, is an upper bound on how many start first. It is never a place in a line and never a
 * start time, which is why the sentence says "up to" and names nothing about when.
 */
export function queuePositionText(queue: BacktestQueueStateResponse): string {
  const ahead =
    queue.ahead === 0
      ? "No backtests queued ahead of it"
      : `Up to ${formatCount(queue.ahead)} ${queue.ahead === 1 ? "backtest" : "backtests"} ahead`;
  return `${ahead} · ${formatCount(queue.executing)} of ${formatCount(queue.capacity)} slots busy`;
}

/** Said under the position, because "ahead" is the one number a reader could take as a promise. */
export const QUEUE_FAIRNESS_NOTE =
  "Backtests start in a fair order across everyone's runs, so this is an upper bound, not a start time.";

/** The API's sentence, for the rare answer that arrives without one. */
const QUEUE_FULL_FALLBACK =
  "Backtests are in high demand right now and the queue is full. Try again in a few minutes.";

/**
 * A submission the deployment-wide queue refused (`503 BACKTEST_QUEUE_FULL`), or `undefined` for
 * any other failure.
 *
 * Not a plan limit and not an outage: the plan allows the run, nothing was created, and the
 * deployment already holds as many waiting runs as it accepts. The API's own sentence says exactly
 * that and when to come back, so it is shown as it is — never as an upgrade offer, and never as the
 * form's generic "could not be submitted" fallback, which would invite an immediate retry.
 */
export function queueFullMessage(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || error.code !== BACKTEST_QUEUE_FULL_CODE) {
    return undefined;
  }
  return error.message.trim() === "" ? QUEUE_FULL_FALLBACK : error.message;
}

import type { RawQueryClient } from "./entitlement-locks.js";

/**
 * The Monitor scan schedule's singleton row, shared by the worker that claims it and the API that
 * may ask it to run sooner. One id in one place, so the two can never address different rows.
 */
export const MONITOR_SCAN_SCHEDULE_ID = "GLOBAL";

/**
 * Asks for a Monitor evaluation soon rather than at the next scheduled cycle
 * (`docs/decisions/monitor-eod-v2.md` §12): a Monitor just started running — enabled, created
 * enabled, globally enabled, rebound — and its missing sessions should be caught up now.
 *
 * It only ever moves the next cycle **earlier**, once: `dueAt` becomes due now if it was later, and
 * `scanRequested` makes a cycle already running schedule its successor at once when it completes,
 * because that cycle loaded its Monitors before the request. Cadence stays an application decision:
 * nothing user-facing chooses an interval, and a request never runs a cycle beside another (the
 * singleton claim is unchanged). No row yet — no worker ever started — is a no-op.
 *
 * Usable inside the caller's transaction, so the request commits with the change that caused it.
 */
export async function requestMonitorEvaluation(
  client: RawQueryClient,
): Promise<void> {
  await client.$executeRaw`
    UPDATE "MonitorScanSchedule"
    SET "dueAt" = LEAST("dueAt", now()),
        "scanRequested" = true,
        "updatedAt" = now()
    WHERE "id" = ${MONITOR_SCAN_SCHEDULE_ID}
  `;
}

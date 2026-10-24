import type { RawQueryClient } from "./entitlement-locks.js";

/**
 * The deployment-wide backtest admission point (`ai/architecture/backtest-execution.md`, "Global
 * admission").
 *
 * The number of backtests executing across the whole deployment — every worker process on every
 * host — is a count of `BacktestJob` rows in `CLAIMED` with a live lease, and the count is only a
 * limit if no two claims can read it at the same time. Every claim therefore takes this one
 * transaction-scoped advisory lock first: claims serialize across all processes, while
 * submissions, progress writes, heartbeats and results never take it and never wait on it.
 *
 * PostgreSQL rather than Redis on purpose: the queue, the leases and the slot count all live in the
 * same rows, so the admission decision and the claim it permits commit together, and a Redis flush
 * or restart can never hand out a fifth slot.
 *
 * A separate namespace from {@link ENTITLEMENT_LOCK_NAMESPACE}; the key is constant.
 */
export const BACKTEST_ADMISSION_LOCK_NAMESPACE = 8_362;

const BACKTEST_ADMISSION_LOCK_KEY = 0;

/**
 * Takes the admission lock for the rest of the calling transaction. **Inside a transaction only.**
 *
 * Lock order: this lock first, then per-user entitlement locks — and those only ever with
 * `tryLockUserEntitlementScope`, never waiting. Nothing else takes this lock, so no transaction can
 * hold a user lock while waiting for it, and the order can never form a cycle.
 */
export async function lockBacktestAdmission(tx: RawQueryClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BACKTEST_ADMISSION_LOCK_NAMESPACE}::int4, ${BACKTEST_ADMISSION_LOCK_KEY}::int4)`;
}

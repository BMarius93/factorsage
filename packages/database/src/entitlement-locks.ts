import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The per-user serialization point behind every capacity limit that can be raced.
 *
 * A concurrency or capacity check is `count`, then decide, then write. At PostgreSQL's default
 * `READ COMMITTED` isolation two transactions doing that at the same instant both read the old
 * count and both write, which is exactly the TOCTOU that turns an enforced limit into an advisory
 * one. Everything that counts a user's quota-controlled rows therefore takes this lock first, so
 * those transactions serialize *per user* while different users never wait on each other.
 *
 * A transaction-scoped advisory lock rather than `SELECT ... FOR UPDATE` on the `User` row: it is
 * released automatically at commit or rollback, it cannot deadlock against the row locks the
 * feature transactions already take, and it does not make an unrelated write to `User` — an email
 * verification, say — wait behind a backtest submission.
 *
 * The API and both worker kinds must use the same namespace and key, or they serialize against
 * nothing. That is the whole reason this lives in `@intrinsic/database` instead of being written
 * out at each call site.
 */

/**
 * Advisory-lock namespace for entitlement capacity checks.
 *
 * The two-argument form of `pg_advisory_xact_lock` splits the 64-bit space into `(classid, objid)`
 * pairs, so this constant is what keeps these locks from colliding with any other advisory lock a
 * future feature might take on the same hashed id.
 */
export const ENTITLEMENT_LOCK_NAMESPACE = 8_361;

/** The subset of a Prisma client this needs; satisfied by the client and by a transaction client. */
export type RawQueryClient = Pick<PrismaClient, "$executeRaw"> &
  Pick<Prisma.TransactionClient, "$executeRaw">;

/**
 * Takes the user's entitlement lock for the rest of the calling transaction.
 *
 * **Must be called inside a transaction.** Outside one, a transaction-scoped advisory lock is
 * taken and released by the same implicit statement, so the caller would be serialized against
 * nothing and would not be able to tell.
 */
export async function lockUserEntitlementScope(
  tx: RawQueryClient,
  userId: string,
): Promise<void> {
  // `hashtext` is PostgreSQL's own stable text hash, so the key does not depend on any application
  // language's hashing. A collision between two user ids would only make them serialize with each
  // other, never let either exceed a limit.
  // The `::int4` cast is required, not cosmetic: Prisma sends a JavaScript number as `bigint`, and
  // PostgreSQL has no `pg_advisory_xact_lock(bigint, integer)` overload to resolve it to.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENTITLEMENT_LOCK_NAMESPACE}::int4, hashtext(${userId}))`;
}

/** A client that can run a raw query and read its rows; satisfied by a transaction client. */
export type RawSelectClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Tries to take the user's entitlement lock for the rest of the calling transaction, **without
 * waiting**, and says whether it got it.
 *
 * For a transaction that already holds another lock and must therefore never block on this one —
 * the backtest claim, which holds the deployment-wide admission lock while it considers owners. A
 * claim that waited here could stall every other claim behind whatever holds the user's lock, and
 * billing reconciliation holds it across a Stripe call. Skipping the owner for one poll costs a
 * second; waiting could cost every user's queue that long.
 */
export async function tryLockUserEntitlementScope(
  tx: RawSelectClient,
  userId: string,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(${ENTITLEMENT_LOCK_NAMESPACE}::int4, hashtext(${userId})) AS locked
  `;
  return row?.locked === true;
}

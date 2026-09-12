import {
  assertBacktestConcurrency,
  assertBacktestHistoricalDepth,
  assertBacktestSymbolLimit,
  assertCanCreateCustomList,
  assertCanCreateCustomStrategy,
  assertCanEnableMonitor,
  assertCanRunLiveBacktest,
  assertListSymbolLimit,
  authenticatedPrincipal,
  listCompliance,
  resolveEntitlements,
  resolveMonitorEligibility,
  type AuthUser,
  type EntitlementPrincipal,
  type Entitlements,
  type MonitorEligibility,
  type ResourceCompliance,
} from "@intrinsic/contracts";
import { lockUserEntitlementScope, type PrismaClient } from "@intrinsic/database";
import { Inject, Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";

/**
 * The server-side entitlement boundary.
 *
 * Every semantic guard in `docs/decisions/entitlements-v1.md` section 12 lives here, and every
 * enforcement point in the application calls one of them. Feature services never compare a plan
 * and never read `User.plan`: they ask a question with a name.
 *
 * Two kinds of guard, and the difference matters:
 *
 * - **Stateless** guards decide from entitlements alone, plus a count the caller already holds.
 *   The trusted principal comes from `CookieAuthGuard`, which reloads plan and role from
 *   PostgreSQL on every request, so nothing a client sent can influence them.
 * - **Transactional** guards decide from a count that another request could be changing right now
 *   — runs in flight, enabled Monitors, List membership. Those take the caller's entitlement lock
 *   and re-read plan and role *inside the caller's transaction*, so the count they read and the
 *   row they permit are part of the same atomic unit. Passing a transaction client is not optional
 *   for them: outside one they would be a check with no teeth.
 */

/** A Prisma client or an interactive transaction client. */
export type EntitlementDb = Pick<PrismaClient, "user" | "$executeRaw">;

/** Statuses a run occupies while it is still in flight; the concurrency denominator. */
const IN_FLIGHT_RUN_STATUSES = [
  "QUEUED",
  "PREPARING_DATA",
  "RUNNING",
  "FINALIZING",
] as const;

@Injectable()
export class EntitlementsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * The entitlements of an authenticated caller.
   *
   * `AuthUser` is not client data: `CookieAuthGuard` verifies the session token and then reloads
   * the row, so `plan` and `role` here are persisted server state as of this request.
   */
  entitlementsOf(user: AuthUser): Entitlements {
    return resolveEntitlements(authenticatedPrincipal(user));
  }

  /** Guest entitlements need no persistence at all — that is the point of the derived state. */
  guestEntitlements(): Entitlements {
    return resolveEntitlements({ kind: "GUEST" });
  }

  /**
   * Re-reads plan and role inside the caller's transaction.
   *
   * Used by the transactional guards so an atomic check cannot be decided against a plan that was
   * read before the transaction began. A user row that vanished mid-transaction resolves to Guest,
   * which fails every authenticated capability closed.
   */
  async resolveIn(db: EntitlementDb, userId: string): Promise<Entitlements> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, plan: true, role: true },
    });
    const principal: EntitlementPrincipal = user
      ? { kind: "AUTHENTICATED", userId: user.id, plan: user.plan, role: user.role }
      : { kind: "GUEST" };
    return resolveEntitlements(principal);
  }

  // -------------------------------------------------------------------------
  // Stateless guards
  // -------------------------------------------------------------------------

  assertCanCreateCustomList(user: AuthUser): Entitlements {
    const entitlements = this.entitlementsOf(user);
    assertCanCreateCustomList(entitlements);
    return entitlements;
  }

  assertCanCreateCustomStrategy(user: AuthUser): Entitlements {
    const entitlements = this.entitlementsOf(user);
    assertCanCreateCustomStrategy(entitlements);
    return entitlements;
  }

  assertCanRunLiveBacktest(user: AuthUser): Entitlements {
    const entitlements = this.entitlementsOf(user);
    assertCanRunLiveBacktest(entitlements);
    return entitlements;
  }

  /**
   * List membership capacity where no concurrent mutation can exist yet — creating a new List.
   *
   * The transactional {@link assertListSymbolLimitIn} is what guards mutations of a List that
   * already exists and could be being changed by another request at the same moment.
   */
  assertListSymbolLimit(
    user: AuthUser,
    usage: { current: number; adding: number },
  ): void {
    assertListSymbolLimit(this.entitlementsOf(user), usage);
  }

  assertBacktestSymbolLimit(user: AuthUser, symbolCount: number): void {
    assertBacktestSymbolLimit(this.entitlementsOf(user), symbolCount);
  }

  assertBacktestHistoricalDepth(user: AuthUser, requestedYears: number): void {
    assertBacktestHistoricalDepth(this.entitlementsOf(user), requestedYears);
  }

  /** Derived, never persisted: a stored compliance flag goes stale the moment either side moves. */
  getListCompliance(user: AuthUser, symbolCount: number): ResourceCompliance {
    return listCompliance(this.entitlementsOf(user), symbolCount);
  }

  // -------------------------------------------------------------------------
  // Transactional guards
  // -------------------------------------------------------------------------

  /**
   * Takes the caller's entitlement lock for the rest of the calling transaction.
   *
   * Call this **before** any other lock a transaction needs, and every writer that touches a
   * capacity-controlled resource will acquire in the same order. That ordering is the point: a
   * transaction that locked a `StockList` row first and reached for this lock second would deadlock
   * against a backtest submission, which holds this lock and then takes the foreign-key share lock
   * every insert referencing that list requires.
   *
   * Re-acquiring it inside the same transaction is free, so a caller that takes it explicitly and
   * then calls an assertion that takes it too is doing nothing wrong.
   */
  async lockUserScope(tx: EntitlementDb, userId: string): Promise<void> {
    await lockUserEntitlementScope(tx, userId);
  }

  /**
   * Refuses a List mutation that would push membership past the plan's symbol limit.
   *
   * `adding` counts only members the mutation would genuinely create, so re-submitting stocks a
   * List already holds is never refused, and a removal is never refused at all. That is what makes
   * an oversized List after a downgrade behave as decided: readable, renameable, correctable —
   * and closed to anything that would make the violation worse.
   *
   * Transactional because two concurrent adds to one List would otherwise each see the pre-add
   * membership and both be allowed. The caller must already hold the List row.
   */
  async assertListSymbolLimitIn(
    tx: EntitlementDb,
    userId: string,
    usage: { current: number; adding: number },
  ): Promise<void> {
    if (usage.adding <= 0) {
      return;
    }
    await lockUserEntitlementScope(tx, userId);
    assertListSymbolLimit(await this.resolveIn(tx, userId), usage);
  }

  /**
   * Refuses a submission that would exceed the plan's concurrent-run capacity.
   *
   * The denominator is the caller's runs that have not reached a terminal status: a `QUEUED` run
   * is work the user has already committed the system to, and counting only executing ones would
   * let a plan with a limit of one hold an unbounded backlog that still executes one at a time.
   *
   * The lock is the whole point. Two submissions arriving together would otherwise both read the
   * same count, both pass, and both create a run — an exactly-reproducible way to run two
   * backtests on a plan that allows one.
   */
  async assertBacktestConcurrency(
    tx: EntitlementDb & { backtestRun: PrismaClient["backtestRun"] },
    userId: string,
  ): Promise<void> {
    await lockUserEntitlementScope(tx, userId);
    const entitlements = await this.resolveIn(tx, userId);
    const inFlight = await tx.backtestRun.count({
      where: { userId, status: { in: [...IN_FLIGHT_RUN_STATUSES] } },
    });
    assertBacktestConcurrency(entitlements, inFlight);
  }

  /**
   * Refuses enabling a Monitor beyond the plan's active capacity.
   *
   * `excludeMonitorId` keeps an update idempotent: re-saving a Monitor that is already enabled
   * must not count it against itself and refuse a no-op.
   *
   * This is the *intent* gate — what a user may switch on now. It is deliberately not the same
   * mechanism as execution eligibility, which is derived per cycle and is what handles a user who
   * is already over capacity because their plan changed underneath them.
   */
  async assertCanEnableMonitor(
    tx: EntitlementDb & { monitor: PrismaClient["monitor"] },
    userId: string,
    options: { excludeMonitorId?: string } = {},
  ): Promise<void> {
    await lockUserEntitlementScope(tx, userId);
    const entitlements = await this.resolveIn(tx, userId);
    const activeCount = await tx.monitor.count({
      where: {
        userId,
        enabled: true,
        ...(options.excludeMonitorId
          ? { id: { not: options.excludeMonitorId } }
          : {}),
      },
    });
    assertCanEnableMonitor(entitlements, activeCount);
  }

  // -------------------------------------------------------------------------
  // Derived Monitor eligibility
  // -------------------------------------------------------------------------

  /**
   * Every Monitor of one user, with the operational status derived from current entitlements.
   *
   * The caller's **complete** Monitor set is loaded on purpose: the active-capacity rule is
   * positional — the first `N` enabled Monitors by `(createdAt, id)` — so deciding one Monitor in
   * isolation would answer a different question than deciding all of them.
   */
  async getMonitorExecutionEligibility(
    userId: string,
  ): Promise<Map<string, MonitorEligibility>> {
    const [entitlements, monitors] = await Promise.all([
      this.resolveIn(this.prisma, userId),
      this.prisma.monitor.findMany({
        where: { userId },
        select: {
          id: true,
          enabled: true,
          createdAt: true,
          stockList: { select: { _count: { select: { items: true } } } },
        },
      }),
    ]);

    const resolved = resolveMonitorEligibility(
      entitlements,
      monitors.map((monitor) => ({
        monitorId: monitor.id,
        enabled: monitor.enabled,
        createdAt: monitor.createdAt,
        listSymbolCount: monitor.stockList._count.items,
      })),
    );
    return new Map(resolved.map((entry) => [entry.monitorId, entry]));
  }
}

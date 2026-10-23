import {
  resolveEntitlements,
  resolveMonitorEligibility,
  type MonitorTransitionReason,
  type UserPlan,
  type UserRole,
} from "@intrinsic/contracts";
import {
  MonitorEvaluableResult,
  type MonitorEvaluationOutcome,
  type MonitorLevelKind,
  type MonitorLifecycleState,
  type Prisma,
  type PrismaClient,
} from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import {
  parseMonitorRuleStates,
  sameLifecycle,
  type MonitorLevelLifecycle,
  type MonitorTransitionEvidence,
} from "@intrinsic/strategy";

/**
 * Durable Monitor state: the Monitors a cycle evaluates, and the lifecycle state that makes the
 * signal semantics survive a restart.
 *
 * `ai/architecture/monitor-engine.md` requires ephemeral memory never to be the sole source of the
 * state a transition is decided from. The cycle decides every transition through the pure
 * lifecycle reducer in `@intrinsic/strategy`; this repository persists that decision atomically —
 * state, Signal occurrence and transition history together, or nothing.
 */

/** One Monitor a cycle should evaluate, with its current Strategy version and universe. */
export type ActiveMonitor = {
  monitorId: string;
  name: string;
  ownership: "USER" | "SYSTEM";
  /** The owner, for correlation. Null for a built-in (SYSTEM) Monitor. */
  actorUserId: string | null;
  strategyId: string;
  /**
   * The `(strategyId, stockListId)` generation this cycle loaded.
   *
   * Every durable write this cycle makes for the Monitor is conditioned on it, so an evaluation of
   * a configuration that has since been replaced cannot land in the new one.
   */
  configVersion: number;
  /** The CURRENT version. A Monitor is live, so an edited Strategy changes what it watches. */
  strategyVersionId: string;
  /** The canonical normalized definition document, still unparsed: the cycle validates it. */
  definition: unknown;
  members: readonly ActiveMonitorMember[];
  /**
   * Whether a member this Monitor has never evaluated is evaluated over the rolling activity window
   * (`docs/decisions/monitor-eod-v2.md` §12) rather than reconstructed at its newest session. Absent
   * where a caller builds Monitors by hand; such a member is then reconstructed.
   */
  windowReplay?: boolean;
};

/** One list membership, with the buy eligibility the canonical list model attaches to it. */
export type ActiveMonitorMember = {
  securityId: string;
  symbol: string;
  buyWindowMode: "FULL" | "CUSTOM";
  buyWindows: readonly { startDate: LocalDate; endDate: LocalDate | null }[];
  /**
   * When the security joined the List. A session that became final before it was not watched for
   * this member, so a change found on it is history (`docs/decisions/monitor-eod-v2.md` §12).
   */
  listedAt?: Date;
};

/** The durable state of one `(monitor, security, level)`. */
export type PersistedSignalState = {
  id: string;
  stateVersion: number;
  /** Canonical fingerprint of the level logic this state belongs to. */
  signalFingerprint: string;
  levelKind: MonitorLevelKind;
  /** The most recent evaluation outcome, including `NOT_EVALUABLE`. Observability only. */
  lastOutcome: MonitorEvaluationOutcome;
  activeSignalId: string | null;
  lifecycle: MonitorLevelLifecycle;
};

/** One current observation: the trading session it belongs to and the price it carried. */
export type MonitorObservation = {
  date: LocalDate;
  price: number;
};

/** One lifecycle transition to record, and which Signal occurrence it concerns. */
export type TransitionRecord = {
  from: MonitorLifecycleState;
  to: MonitorLifecycleState;
  reason: MonitorTransitionReason;
  exitRuleId: string | null;
  observationDate: LocalDate | null;
  /** The logic the transition was decided under — the previous logic for a logic-change reset. */
  signalFingerprint: string;
  /** `closed`: the occurrence this write ends; `opened`: the one it begins. */
  signal: "closed" | "opened" | null;
};

/** Where a recorded change came from; mirrors `MonitorTransitionOrigin`. */
export type TransitionOrigin = "OBSERVED" | "HISTORY" | "ADMINISTRATIVE";

/**
 * One recorded lifecycle change of an EOD evaluation, in order, with the occurrence it ends and/or
 * begins. A catch-up over several sessions produces one per change — never one per session — so an
 * occurrence that opened on Tuesday and closed on Thursday is two changes with their true dates.
 */
export type LevelChange = {
  transition: TransitionRecord;
  origin: TransitionOrigin;
  /** End the occurrence current before this change. */
  close?: { reason: MonitorTransitionReason; observationDate: LocalDate | null };
  /** Begin an occurrence on this change. */
  open?: { observationDate: LocalDate; price: number; reconstructed: boolean };
  /** What the decision read on the change's session; absent for a change no session made. */
  evidence?: MonitorTransitionEvidence;
};

/** Everything one EOD evaluation decided for one level of one member. */
export type LevelSessionsWrite = {
  levelId: string;
  levelKind: MonitorLevelKind;
  signalFingerprint: string;
  hasTrigger: boolean;
  /** Recorded on an opened Signal as the version it was decided under. */
  strategyVersionId: string;
  /** The state this was decided against, or null when there was none. */
  previous: PersistedSignalState | null;
  changes: readonly LevelChange[];
  /** The lifecycle to persist, or `null` to delete the row. */
  lifecycle: MonitorLevelLifecycle | null;
  /** The outcome of the newest session evaluated. */
  outcome: MonitorEvaluationOutcome;
  /** The newest decided observation; `lastEvaluable*` moves only with one. */
  decided: { result: "MATCHED" | "NOT_MATCHED"; observation: MonitorObservation } | null;
  /** Where and at what price the final lifecycle state was entered, when it changed. */
  enteredAt: { observationDate: LocalDate | null; price: number | null } | null;
};

/**
 * One member's EOD evaluation: every level's decisions and the checkpoint they advance, persisted
 * in **one** transaction or not at all.
 */
export type MemberEvaluationWrite = {
  monitorId: string;
  configVersion: number;
  securityId: string;
  now: Date;
  checkpoint: {
    /** The `evaluatedThrough` the evaluation read, or null when the member had no checkpoint. */
    previous: LocalDate | null;
    next: LocalDate;
    basisGeneration: number;
    /** The ongoing membership this progress belongs to: its start, or null for "Always eligible". */
    membershipStart: LocalDate | null;
    /**
     * Where the member's recorded evaluation begins (`docs/decisions/monitor-eod-v2.md` §12), when
     * this write starts it afresh — a window replay, a reconstruction. Absent when the member is
     * caught up from its own checkpoint, whose coverage is kept; a new row then starts at `next`.
     */
    coverageStart?: LocalDate;
  };
  /**
   * The member's ongoing membership is not the one its state belongs to (a re-entry, a moved
   * start): end every state of the member administratively (`MEMBERSHIP_CHANGED`) and delete it,
   * in the same transaction and before `levels` — which were then decided from no state.
   */
  resetMembership?: boolean;
  levels: readonly LevelSessionsWrite[];
};

export type MemberEvaluationResult = {
  applied: boolean;
  /** Nothing was written because the Monitor was rebound after the evaluation loaded it. */
  staleConfiguration?: boolean;
  /** Nothing was written because another evaluation advanced the checkpoint first. */
  contended?: boolean;
  openedSignals: number;
  closedSignals: number;
  transitions: number;
};

/** One member's evaluation progress. */
export type PersistedCheckpoint = {
  evaluatedThrough: LocalDate;
  configVersion: number;
  basisGeneration: number;
  /**
   * The ongoing membership the progress belongs to, or `undefined` for a checkpoint written before
   * memberships were recorded — adopted under the current one, never reset for it.
   */
  membership: { start: LocalDate | null } | undefined;
};

/**
 * What the EOD evaluation needs from durable state (`docs/decisions/monitor-eod-v2.md` §3): the
 * running Monitors and their states, the reconciliations of what is no longer evaluated, per-member
 * progress and the one atomic member write.
 */
export interface MonitorEvaluationRepository {
  listActiveMonitors(): Promise<ActiveMonitor[]>;
  loadSignalStates(monitorId: string): Promise<Map<string, PersistedSignalState>>;
  /**
   * Ends the lifecycle of every state the cycle no longer evaluates.
   *
   * A security removed from the Stock List, or a level removed from the Strategy (or excluded from
   * Monitor evaluation), stops being visited. Its current occurrence is resolved, a pending setup
   * is dropped, the change is recorded, and the row is removed so a returning member or level is
   * reconstructed from history rather than resumed from a stale latch.
   *
   * The visited set is named as the Monitor's **current** securities and levels, because the cycle
   * evaluates exactly their cross product.
   */
  resolveUnvisitedStates(input: {
    monitorId: string;
    configVersion: number;
    securityIds: readonly string[];
    levelIds: readonly string[];
    /**
     * Every security still in the List, when it differs from the evaluated `securityIds`: a listed
     * security that is not evaluated is no longer a current member there, and its states end with
     * `MEMBERSHIP_CHANGED` rather than `MEMBER_REMOVED`.
     */
    listedSecurityIds?: readonly string[];
    now: Date;
  }): Promise<number>;
  /**
   * Records that these Monitors were evaluated, skipping any that has been rebound since the cycle
   * loaded it — its new configuration has not been checked, so it must not be stamped as if it had.
   */
  markScanned(
    monitors: readonly { monitorId: string; configVersion: number }[],
    now: Date,
  ): Promise<void>;
  /**
   * Records which Monitors are running now, and returns when each started being watched.
   *
   * A running Monitor with no `watchingSince` is stamped `now` — it was created, re-enabled,
   * unblocked or globally enabled since the last evaluation — and every Monitor that is no longer
   * running is cleared. A session that became final before a Monitor's `watchingSince` was not
   * watched when it happened.
   */
  markWatching(
    runningMonitorIds: readonly string[],
    now: Date,
  ): Promise<Map<string, Date>>;
  /** Each member's evaluation progress for one Monitor, keyed by security id. */
  loadCheckpoints(monitorId: string): Promise<Map<string, PersistedCheckpoint>>;
  /**
   * Per security, the newest session this Monitor ever recorded a change on — decided history that
   * outlives the member's state and checkpoint, which a membership ending or a rebind deletes. A
   * window replay starts after it, so no recorded change is ever recorded twice.
   */
  loadLastRecordedSessions(monitorId: string): Promise<Map<string, LocalDate>>;
  /**
   * Persists one member's EOD evaluation — every level's changes, Signals and state, and the
   * checkpoint they advance — in one transaction behind the binding fence, the checkpoint's own
   * previous value and every state's `stateVersion`. Nothing is written when any of them moved.
   */
  applyMemberEvaluation(
    write: MemberEvaluationWrite,
  ): Promise<MemberEvaluationResult>;
  /**
   * Forgets the progress of members no longer in the Monitor's list, so a member removed and added
   * back is reconstructed rather than caught up from a stale checkpoint. Fenced like every write.
   */
  pruneCheckpoints(input: {
    monitorId: string;
    configVersion: number;
    securityIds: readonly string[];
  }): Promise<number>;
}

/** The key a `(securityId, levelId)` pair is looked up by inside one Monitor's state map. */
export function signalStateKey(securityId: string, levelId: string): string {
  return `${securityId} ${levelId}`;
}

export class PrismaMonitorRepository implements MonitorEvaluationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Every Monitor a cycle may actually evaluate, with its current Strategy definition and universe.
   *
   * One query for the whole cycle. The universe is read through `StockList` to `StockListItem` to
   * `Security`, the canonical membership path (`AGENTS.md` invariant 2).
   *
   * Two ownerships, two switches:
   *
   * - **A user Monitor** runs when its owner's `enabled` intent is on **and** its owner's current
   *   entitlements make it execution-eligible — only the first `maxActive` enabled Monitors of each
   *   owner by `(createdAt, id)`, and none whose List exceeds the plan's symbol limit. `enabled` is
   *   never rewritten by that derivation.
   * - **A built-in (SYSTEM) Monitor** is shared platform content with no owner and no plan. It runs
   *   when the operator's `isGloballyEnabled` is on, once for everybody. A customer disabling it for
   *   their own account never changes that: a published built-in is enabled by default for every
   *   Guest, so the public Dashboard always needs it, and an unpublished one is evaluated for the
   *   administrators preparing it (`builtin-dashboard-signals-v1.md` §17b).
   *
   * A Monitor whose Strategy somehow has no version is skipped rather than failing the cycle.
   */
  async listActiveMonitors(): Promise<ActiveMonitor[]> {
    const rows = await this.prisma.monitor.findMany({
      where: {
        OR: [
          { ownership: "USER", enabled: true },
          { ownership: "SYSTEM", isGloballyEnabled: true },
        ],
      },
      include: {
        user: { select: { id: true, plan: true, role: true } },
        strategy: {
          include: { versions: { orderBy: { versionNumber: "desc" }, take: 1 } },
        },
        stockList: {
          include: {
            items: {
              include: {
                // Only the symbol, and only so a log line can name the security.
                security: { select: { symbol: true } },
                buyWindows: true,
              },
            },
          },
        },
      },
      orderBy: { id: "asc" },
    });

    const eligibleIds = await this.resolveEligibleUserMonitorIds(rows);

    const monitors: ActiveMonitor[] = [];
    for (const row of rows) {
      const isSystem = row.ownership === "SYSTEM";
      if (!isSystem && !eligibleIds.has(row.id)) {
        continue;
      }
      const version = row.strategy.versions[0];
      if (!version) {
        continue;
      }
      monitors.push({
        monitorId: row.id,
        name: row.name,
        ownership: row.ownership,
        actorUserId: row.userId,
        strategyId: row.strategyId,
        configVersion: row.configVersion,
        strategyVersionId: version.id,
        definition: version.definition,
        windowReplay: row.windowReplay,
        members: row.stockList.items.map((item) => ({
          securityId: item.securityId,
          symbol: item.security.symbol,
          listedAt: item.createdAt,
          buyWindowMode: item.buyWindowMode,
          buyWindows: item.buyWindows
            .map((window) => ({
              startDate: toLocalDate(window.startDate),
              endDate: window.endDate ? toLocalDate(window.endDate) : null,
            }))
            .sort((left, right) => left.startDate.localeCompare(right.startDate)),
        })),
      });
    }
    return monitors;
  }

  /**
   * Which of the enabled user Monitors their owners' plans currently allow to scan.
   *
   * Resolved through the same `resolveMonitorEligibility` the API projects its status from, so
   * what the worker executes and what the user is shown can never disagree.
   */
  private async resolveEligibleUserMonitorIds(
    rows: readonly {
      id: string;
      ownership: "USER" | "SYSTEM";
      enabled: boolean;
      createdAt: Date;
      user: { id: string; plan: UserPlan; role: UserRole } | null;
      stockList: { items: readonly unknown[] };
    }[],
  ): Promise<Set<string>> {
    const byOwner = new Map<string, (typeof rows)[number][]>();
    for (const row of rows) {
      if (row.ownership !== "USER" || !row.user) {
        continue;
      }
      const bucket = byOwner.get(row.user.id);
      if (bucket) {
        bucket.push(row);
      } else {
        byOwner.set(row.user.id, [row]);
      }
    }

    const eligible = new Set<string>();
    for (const owned of byOwner.values()) {
      const owner = owned[0]?.user;
      if (!owner) {
        continue;
      }
      const entitlements = resolveEntitlements({
        kind: "AUTHENTICATED",
        userId: owner.id,
        plan: owner.plan,
        role: owner.role,
      });
      for (const decision of resolveMonitorEligibility(
        entitlements,
        owned.map((row) => ({
          monitorId: row.id,
          enabled: row.enabled,
          createdAt: row.createdAt,
          listSymbolCount: row.stockList.items.length,
        })),
      )) {
        if (decision.executionEligible) {
          eligible.add(decision.monitorId);
        }
      }
    }
    return eligible;
  }

  async loadSignalStates(
    monitorId: string,
  ): Promise<Map<string, PersistedSignalState>> {
    const rows = await this.prisma.monitorSignalState.findMany({
      where: { monitorId },
      select: {
        id: true,
        securityId: true,
        levelId: true,
        levelKind: true,
        stateVersion: true,
        signalFingerprint: true,
        lastOutcome: true,
        activeSignalId: true,
        lifecycleState: true,
        lifecycleSinceDate: true,
        ruleStates: true,
      },
    });
    return new Map(
      rows.map((row) => [
        signalStateKey(row.securityId, row.levelId),
        {
          id: row.id,
          stateVersion: row.stateVersion,
          signalFingerprint: row.signalFingerprint,
          levelKind: row.levelKind,
          lastOutcome: row.lastOutcome,
          activeSignalId: row.activeSignalId,
          lifecycle: {
            state: row.lifecycleState,
            since: row.lifecycleSinceDate ? toLocalDate(row.lifecycleSinceDate) : null,
            rules: parseMonitorRuleStates(row.ruleStates),
          },
        },
      ]),
    );
  }

  async resolveUnvisitedStates(input: {
    monitorId: string;
    configVersion: number;
    securityIds: readonly string[];
    levelIds: readonly string[];
    listedSecurityIds?: readonly string[];
    now: Date;
  }): Promise<number> {
    // An empty security or level list means the cross product the cycle walks is empty, so every
    // state is unvisited. Spelled out rather than left to `notIn: []`.
    const visitsNothing = input.securityIds.length === 0 || input.levelIds.length === 0;
    const orphaned = await this.prisma.monitorSignalState.findMany({
      where: {
        monitorId: input.monitorId,
        ...(visitsNothing
          ? {}
          : {
              OR: [
                { securityId: { notIn: [...input.securityIds] } },
                { levelId: { notIn: [...input.levelIds] } },
              ],
            }),
      },
      select: {
        id: true,
        securityId: true,
        levelId: true,
        levelKind: true,
        signalFingerprint: true,
        lifecycleState: true,
        activeSignalId: true,
      },
    });
    if (orphaned.length === 0) {
      return 0;
    }
    const members = new Set(input.securityIds);
    const listed = new Set(input.listedSecurityIds ?? input.securityIds);
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The visited set belongs to the configuration this cycle loaded. If the Monitor has been
        // rebound since, the rebind already ended every lifecycle itself.
        await assertBindingCurrent(tx, input.monitorId, input.configVersion);
        let resolved = 0;
        for (const row of orphaned) {
          const reason: MonitorTransitionReason = members.has(row.securityId)
            ? "LEVEL_REMOVED"
            : listed.has(row.securityId)
              ? "MEMBERSHIP_CHANGED"
              : "MEMBER_REMOVED";
          const ended = endedStateOf(row.lifecycleState);
          if (row.activeSignalId) {
            resolved += (
              await tx.monitorSignal.updateMany({
                where: { id: row.activeSignalId, resolvedAt: null },
                data: { resolvedAt: input.now, resolutionReason: reason },
              })
            ).count;
          }
          if (ended) {
            await tx.monitorStateTransition.create({
              data: {
                monitorId: input.monitorId,
                securityId: row.securityId,
                levelId: row.levelId,
                levelKind: row.levelKind,
                signalFingerprint: row.signalFingerprint,
                fromState: row.lifecycleState,
                toState: ended,
                reason,
                origin: "ADMINISTRATIVE",
                occurredAt: input.now,
                signalId: row.activeSignalId,
              },
            });
          }
        }
        await tx.monitorSignalState.deleteMany({
          where: { id: { in: orphaned.map((row) => row.id) } },
        });
        return resolved;
      });
    } catch (error) {
      if (error instanceof MonitorBindingChangedError) {
        return 0;
      }
      throw error;
    }
  }

  /**
   * Records that these Monitors were evaluated in this cycle.
   *
   * Raw SQL because `Monitor.updatedAt` is `@updatedAt`: a scan is not an edit, and through the
   * query builder every scanned Monitor would read "updated just now".
   */
  async markScanned(
    monitors: readonly { monitorId: string; configVersion: number }[],
    now: Date,
  ): Promise<void> {
    if (monitors.length === 0) {
      return;
    }
    // The binding is part of the predicate, so a Monitor rebound mid-cycle keeps the null
    // `lastScanAt` its rebind set.
    await this.prisma.$executeRaw`
      UPDATE "Monitor" AS m
      SET "lastScanAt" = ${now}
      FROM UNNEST(
        ${monitors.map((entry) => entry.monitorId)}::text[],
        ${monitors.map((entry) => entry.configVersion)}::int[]
      ) AS scanned(id, config_version)
      WHERE m."id" = scanned.id AND m."configVersion" = scanned.config_version
    `;
  }

  /**
   * Raw SQL for the same reason as `markScanned`: being watched is not an edit, so the Monitor's
   * `updatedAt` must not move.
   */
  async markWatching(
    runningMonitorIds: readonly string[],
    now: Date,
  ): Promise<Map<string, Date>> {
    const running = [...runningMonitorIds];
    await this.prisma.$executeRaw`
      UPDATE "Monitor"
      SET "watchingSince" = NULL
      WHERE "watchingSince" IS NOT NULL AND NOT ("id" = ANY(${running}::text[]))
    `;
    if (running.length === 0) {
      return new Map();
    }
    await this.prisma.$executeRaw`
      UPDATE "Monitor"
      SET "watchingSince" = ${now}
      WHERE "watchingSince" IS NULL AND "id" = ANY(${running}::text[])
    `;
    const rows = await this.prisma.monitor.findMany({
      where: { id: { in: running } },
      select: { id: true, watchingSince: true },
    });
    return new Map(
      rows.map((row) => [row.id, row.watchingSince ?? now] as const),
    );
  }

  async pruneCheckpoints(input: {
    monitorId: string;
    configVersion: number;
    securityIds: readonly string[];
  }): Promise<number> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await assertBindingCurrent(tx, input.monitorId, input.configVersion);
        return (
          await tx.monitorEvaluationCheckpoint.deleteMany({
            where: {
              monitorId: input.monitorId,
              ...(input.securityIds.length > 0
                ? { securityId: { notIn: [...input.securityIds] } }
                : {}),
            },
          })
        ).count;
      });
    } catch (error) {
      if (error instanceof MonitorBindingChangedError) {
        return 0;
      }
      throw error;
    }
  }

  async loadLastRecordedSessions(
    monitorId: string,
  ): Promise<Map<string, LocalDate>> {
    const rows = await this.prisma.monitorStateTransition.groupBy({
      by: ["securityId"],
      where: { monitorId, observationDate: { not: null } },
      _max: { observationDate: true },
    });
    return new Map(
      rows.flatMap((row) =>
        row._max.observationDate
          ? [[row.securityId, toLocalDate(row._max.observationDate)] as const]
          : [],
      ),
    );
  }

  async loadCheckpoints(
    monitorId: string,
  ): Promise<Map<string, PersistedCheckpoint>> {
    const rows = await this.prisma.monitorEvaluationCheckpoint.findMany({
      where: { monitorId },
      select: {
        securityId: true,
        evaluatedThrough: true,
        configVersion: true,
        basisGeneration: true,
        membershipRecorded: true,
        membershipStart: true,
      },
    });
    return new Map(
      rows.map((row) => [
        row.securityId,
        {
          evaluatedThrough: toLocalDate(row.evaluatedThrough),
          configVersion: row.configVersion,
          basisGeneration: row.basisGeneration,
          membership: row.membershipRecorded
            ? {
                start: row.membershipStart
                  ? toLocalDate(row.membershipStart)
                  : null,
              }
            : undefined,
        },
      ]),
    );
  }

  async applyMemberEvaluation(
    write: MemberEvaluationWrite,
  ): Promise<MemberEvaluationResult> {
    const nothing: MemberEvaluationResult = {
      applied: false,
      openedSignals: 0,
      closedSignals: 0,
      transitions: 0,
    };
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // The fence first, in the order a rebind takes it, then the member's own progress.
          await assertBindingCurrent(tx, write.monitorId, write.configVersion);
          const current = await tx.$queryRaw<{ evaluatedThrough: Date }[]>`
            SELECT "evaluatedThrough"
            FROM "MonitorEvaluationCheckpoint"
            WHERE "monitorId" = ${write.monitorId} AND "securityId" = ${write.securityId}
            FOR UPDATE
          `;
          const stored = current[0]
            ? toLocalDate(current[0].evaluatedThrough)
            : null;
          if (stored !== write.checkpoint.previous) {
            throw new MonitorCheckpointConflictError();
          }

          let opened = 0;
          let closed = 0;
          let transitions = 0;
          if (write.resetMembership) {
            const ended = await this.endMemberStates(tx, write, "MEMBERSHIP_CHANGED");
            closed += ended.closed;
            transitions += ended.transitions;
          }
          for (const level of write.levels) {
            const result = await this.applyLevelSessions(tx, write, level);
            opened += result.opened;
            closed += result.closed;
            transitions += result.transitions;
          }

          await tx.monitorEvaluationCheckpoint.upsert({
            where: {
              monitorId_securityId: {
                monitorId: write.monitorId,
                securityId: write.securityId,
              },
            },
            create: {
              monitorId: write.monitorId,
              securityId: write.securityId,
              evaluatedThrough: toDate(write.checkpoint.next),
              configVersion: write.configVersion,
              basisGeneration: write.checkpoint.basisGeneration,
              membershipRecorded: true,
              membershipStart: membershipStartOf(write),
              coverageStart: toDate(
                write.checkpoint.coverageStart ?? write.checkpoint.next,
              ),
            },
            update: {
              evaluatedThrough: toDate(write.checkpoint.next),
              configVersion: write.configVersion,
              basisGeneration: write.checkpoint.basisGeneration,
              membershipRecorded: true,
              membershipStart: membershipStartOf(write),
              ...(write.checkpoint.coverageStart === undefined
                ? {}
                : { coverageStart: toDate(write.checkpoint.coverageStart) }),
            },
          });
          return {
            applied: true,
            openedSignals: opened,
            closedSignals: closed,
            transitions,
          };
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      if (error instanceof MonitorBindingChangedError) {
        return { ...nothing, staleConfiguration: true };
      }
      if (
        error instanceof MonitorCheckpointConflictError ||
        error instanceof MonitorTransitionConflictError ||
        isBenignWriteRace(error)
      ) {
        // Another evaluation moved this member first, or the Monitor or security went away. The
        // transaction rolled back, so nothing this call created survives.
        return { ...nothing, contended: true };
      }
      throw error;
    }
  }

  /**
   * Ends every state of one member administratively, in the caller's transaction: the occurrence
   * each one points at is resolved, the ending is recorded, and the rows are deleted — the same
   * shape as a removed member, under the reason given.
   */
  private async endMemberStates(
    tx: Prisma.TransactionClient,
    write: Pick<MemberEvaluationWrite, "monitorId" | "securityId" | "now">,
    reason: MonitorTransitionReason,
  ): Promise<{ closed: number; transitions: number }> {
    const rows = await tx.monitorSignalState.findMany({
      where: { monitorId: write.monitorId, securityId: write.securityId },
      select: {
        id: true,
        levelId: true,
        levelKind: true,
        signalFingerprint: true,
        lifecycleState: true,
        activeSignalId: true,
      },
    });
    let closed = 0;
    let transitions = 0;
    for (const row of rows) {
      if (row.activeSignalId) {
        closed += (
          await tx.monitorSignal.updateMany({
            where: { id: row.activeSignalId, resolvedAt: null },
            data: { resolvedAt: write.now, resolutionReason: reason },
          })
        ).count;
      }
      const ended = endedStateOf(row.lifecycleState);
      if (ended) {
        await tx.monitorStateTransition.create({
          data: {
            monitorId: write.monitorId,
            securityId: write.securityId,
            levelId: row.levelId,
            levelKind: row.levelKind,
            signalFingerprint: row.signalFingerprint,
            fromState: row.lifecycleState,
            toState: ended,
            reason,
            origin: "ADMINISTRATIVE",
            occurredAt: write.now,
            signalId: row.activeSignalId,
          },
        });
        transitions += 1;
      }
    }
    await tx.monitorSignalState.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    return { closed, transitions };
  }

  /**
   * One level's ordered changes: each close ends the occurrence current at that point, each open
   * begins the next, and the transitions record which occurrence each concerns — so a catch-up that
   * opened Tuesday and closed Thursday leaves exactly that history.
   */
  private async applyLevelSessions(
    tx: Prisma.TransactionClient,
    write: MemberEvaluationWrite,
    level: LevelSessionsWrite,
  ): Promise<{ opened: number; closed: number; transitions: number }> {
    const previous = level.previous;
    const unchanged =
      previous !== null &&
      level.lifecycle !== null &&
      level.changes.length === 0 &&
      previous.lastOutcome === level.outcome &&
      previous.signalFingerprint === level.signalFingerprint &&
      sameLifecycle(previous.lifecycle, level.lifecycle);
    if (unchanged || (previous === null && level.lifecycle === null)) {
      return { opened: 0, closed: 0, transitions: 0 };
    }

    let activeSignalId = previous?.activeSignalId ?? null;
    let opened = 0;
    let closed = 0;
    const transitionRows: Prisma.MonitorStateTransitionCreateManyInput[] = [];
    for (const change of level.changes) {
      let closedSignalId: string | null = null;
      if (change.close && activeSignalId) {
        closedSignalId = activeSignalId;
        closed += (
          await tx.monitorSignal.updateMany({
            where: { id: activeSignalId, resolvedAt: null },
            data: signalClose(write.now, change.close),
          })
        ).count;
        activeSignalId = null;
      }
      let openedSignalId: string | null = null;
      if (change.open) {
        const signal = await tx.monitorSignal.create({
          data: {
            monitorId: write.monitorId,
            securityId: write.securityId,
            levelId: level.levelId,
            levelKind: level.levelKind,
            strategyVersionId: level.strategyVersionId,
            signalFingerprint: level.signalFingerprint,
            hasTrigger: level.hasTrigger,
            observationDate: toDate(change.open.observationDate),
            observationPrice: change.open.price,
            observationBasis: "EOD_CLOSE",
            detectedAt: write.now,
            reconstructed: change.open.reconstructed,
          },
          select: { id: true },
        });
        openedSignalId = signal.id;
        activeSignalId = signal.id;
        opened += 1;
      }
      transitionRows.push({
        monitorId: write.monitorId,
        securityId: write.securityId,
        levelId: level.levelId,
        levelKind: level.levelKind,
        exitRuleId: change.transition.exitRuleId,
        signalFingerprint: change.transition.signalFingerprint,
        fromState: change.transition.from,
        toState: change.transition.to,
        reason: change.transition.reason,
        origin: change.origin,
        occurredAt: write.now,
        observationDate: change.transition.observationDate
          ? toDate(change.transition.observationDate)
          : null,
        signalId:
          change.transition.signal === "opened"
            ? openedSignalId
            : change.transition.signal === "closed"
              ? closedSignalId
              : null,
        // A session decided this change under the current version; an administrative one (a
        // logic-change reset) belongs to logic that no longer exists, so it names none.
        strategyVersionId:
          change.origin === "ADMINISTRATIVE" ? null : level.strategyVersionId,
        ...(change.evidence
          ? { evidence: change.evidence as unknown as Prisma.InputJsonValue }
          : {}),
      });
    }

    if (level.lifecycle === null) {
      if (previous) {
        guard(
          await tx.monitorSignalState.deleteMany({
            where: { id: previous.id, stateVersion: previous.stateVersion },
          }),
        );
      }
    } else {
      const lifecycle = level.lifecycle;
      const data = {
        signalFingerprint: level.signalFingerprint,
        levelKind: level.levelKind,
        lastOutcome: level.outcome,
        lastOutcomeAt: write.now,
        lifecycleState: lifecycle.state,
        lifecycleSinceDate: lifecycle.since ? toDate(lifecycle.since) : null,
        ruleStates: lifecycle.rules as unknown as Prisma.InputJsonValue,
        activeSignalId: lifecycle.state === "ACTIVE" ? activeSignalId : null,
        ...(level.enteredAt
          ? {
              lifecycleSince: write.now,
              lifecycleSincePrice: level.enteredAt.price,
            }
          : {}),
        ...(level.decided
          ? {
              lastEvaluableResult:
                level.decided.result === "MATCHED"
                  ? MonitorEvaluableResult.MATCHED
                  : MonitorEvaluableResult.NOT_MATCHED,
              lastEvaluableDate: toDate(level.decided.observation.date),
              lastEvaluableAt: write.now,
            }
          : {}),
      };
      if (previous) {
        guard(
          await tx.monitorSignalState.updateMany({
            where: { id: previous.id, stateVersion: previous.stateVersion },
            data: { ...data, stateVersion: { increment: 1 } },
          }),
        );
      } else {
        if (!level.decided) {
          throw new Error("A new Monitor state requires a decided observation");
        }
        await tx.monitorSignalState.create({
          data: {
            monitorId: write.monitorId,
            securityId: write.securityId,
            levelId: level.levelId,
            ...data,
            lastEvaluableResult: data.lastEvaluableResult!,
            lastEvaluableDate: data.lastEvaluableDate!,
            lastEvaluableAt: data.lastEvaluableAt!,
          },
        });
      }
    }

    if (transitionRows.length > 0) {
      await tx.monitorStateTransition.createMany({ data: transitionRows });
    }
    return { opened, closed, transitions: transitionRows.length };
  }
}

/** The close a level's persisted Signal row receives. */
type SignalClose = { reason: MonitorTransitionReason; observationDate: LocalDate | null };

/**
 * The state an ended lifecycle moves to when it stops being evaluated: an occurrence resolves, a
 * pending setup is dropped. `null` when there was nothing current to end.
 */
export function endedStateOf(
  state: MonitorLifecycleState,
): MonitorLifecycleState | null {
  if (state === "ACTIVE") {
    return "RESOLVED";
  }
  if (state === "PENDING_TRIGGER") {
    return "INACTIVE";
  }
  return null;
}

function membershipStartOf(write: MemberEvaluationWrite): Date | null {
  return write.checkpoint.membershipStart === null
    ? null
    : toDate(write.checkpoint.membershipStart);
}

/** Turns a lost optimistic guard into a rollback, so a created Signal never outlives it. */
function guard(updated: { count: number }): void {
  if (updated.count !== 1) {
    throw new MonitorTransitionConflictError();
  }
}

/**
 * Asserts the Monitor is still on the binding this cycle loaded, and holds it there until the
 * transaction ends.
 *
 * `stateVersion` alone is not enough: a rebind *deletes* state rows, so the next evaluation of the
 * replaced configuration would find no previous state and have nothing to contend against. The
 * fence is on the Monitor, which is the thing that changed. `FOR SHARE` because a rebind takes
 * `FOR UPDATE` on the same row, so the two serialize.
 */
async function assertBindingCurrent(
  tx: Prisma.TransactionClient,
  monitorId: string,
  configVersion: number,
): Promise<void> {
  const rows = await tx.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one
    FROM "Monitor"
    WHERE "id" = ${monitorId} AND "configVersion" = ${configVersion}
    FOR SHARE
  `;
  if (rows.length !== 1) {
    throw new MonitorBindingChangedError();
  }
}

class MonitorBindingChangedError extends Error {
  constructor() {
    super("Monitor was rebound to a different strategy or stock list");
    this.name = "MonitorBindingChangedError";
  }
}

function signalClose(now: Date, close: SignalClose) {
  return {
    resolvedAt: now,
    resolvedObservationDate: close.observationDate
      ? toDate(close.observationDate)
      : null,
    resolutionReason: close.reason,
  };
}

class MonitorCheckpointConflictError extends Error {
  constructor() {
    super("Monitor member evaluation progress moved concurrently");
    this.name = "MonitorCheckpointConflictError";
  }
}

class MonitorTransitionConflictError extends Error {
  constructor() {
    super("Monitor signal state changed concurrently");
    this.name = "MonitorTransitionConflictError";
  }
}

/**
 * Whether a write failed because the world moved, not because anything is wrong: a concurrent
 * create (`P2002`), a deleted Monitor or Security (`P2003`), a vanished row (`P2025`). Matched by
 * Prisma's stable codes; everything else keeps its original semantics.
 */
const BENIGN_WRITE_RACE_CODES = new Set(["P2002", "P2003", "P2025"]);

function isBenignWriteRace(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    BENIGN_WRITE_RACE_CODES.has((error as { code: string }).code)
  );
}

/** A `YYYY-MM-DD` product date as the UTC midnight PostgreSQL stores in a `date` column. */
function toDate(date: LocalDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** A PostgreSQL `date` back as the canonical product string, without a timezone shift. */
function toLocalDate(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}

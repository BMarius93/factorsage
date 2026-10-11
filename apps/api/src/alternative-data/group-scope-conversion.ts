import {
  ACTOR_SCOPE_MAX_ACTORS,
  collectActorGroupIds,
  collectAlternativeDataMetrics,
  embedActorGroupScopes,
  normalizeStrategyDefinition,
  StrategyValidationError,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import type { Prisma, PrismaClient } from "@intrinsic/database";
import { monitorStrategyLevels } from "@intrinsic/strategy";
import { appendStrategyVersionIfChanged } from "../strategies/strategy-versions";

/**
 * Converting strategies that still name a Congress group into ones that select the members directly.
 *
 * Congress groups left the product on 2026-10-11. A stored strategy version naming one still reads and
 * still executes, so this is never needed for correctness — it exists so the last strategies depending
 * on a group can stop depending on it, deliberately, when an operator decides to.
 *
 * Three properties make it safe to run, and each is tested:
 *
 * 1. **It appends and never rewrites.** A converted strategy gains a new `StrategyVersion` holding the
 *    group's current members as a selection. Every earlier version, every backtest snapshot and every
 *    completed result is left exactly as it was — a `BacktestRun` carries its own frozen membership and
 *    is not read here at all.
 * 2. **It never guesses.** A group that is missing, empty, or not readable by the strategy's owner is
 *    not converted into "nobody" or into "everybody": the strategy is skipped, named in the report with
 *    its reason, and keeps executing as it did.
 * 3. **It is idempotent.** A converted strategy no longer names a group, so a second run finds nothing
 *    to do. Planning and applying are one function, so a dry run reports exactly what an apply would do
 *    to the same database state.
 *
 * ## What it costs a Monitor
 *
 * A Monitor keys its durable state to the fingerprint of each level's logic, and a level's scope is
 * part of that. Converting a strategy therefore resets, once, every level whose rule named the group:
 * the next cycle closes an active Signal on it as `LOGIC_CHANGED` and reconstructs the level from
 * history under the same members. Nothing about that is silent — the report counts the state rows and
 * active Signals each Monitor would lose, and a strategy with a Monitor is converted only when the
 * operator passes `includeMonitored`.
 */

export const GROUP_SCOPE_SKIP_REASONS = [
  /** The current version no longer passes the canonical validator. */
  "DEFINITION_UNREADABLE",
  /** A referenced group row does not exist. */
  "GROUP_MISSING",
  /** A referenced group holds no members; an empty selection is not a rule. */
  "GROUP_EMPTY",
  /** A referenced group exists but its owner is not the strategy's, and it is not built-in. */
  "GROUP_INACCESSIBLE",
  /** A referenced group holds more members than one selection may. */
  "GROUP_TOO_LARGE",
  /** Embedding the members would leave a definition the validator refuses. */
  "CONVERSION_INVALID",
  /** Apply only: the strategy has a Monitor and `includeMonitored` was not given. */
  "MONITORED",
] as const;

export type GroupScopeSkipReason = (typeof GROUP_SCOPE_SKIP_REASONS)[number];

export type GroupScopeGroupStatus =
  "RESOLVED" | "MISSING" | "EMPTY" | "INACCESSIBLE" | "TOO_LARGE";

export type GroupScopeGroupReport = {
  groupId: string;
  /** Null when the group row no longer exists. */
  name: string | null;
  memberCount: number;
  status: GroupScopeGroupStatus;
};

export type GroupScopeMonitorReport = {
  monitorId: string;
  name: string;
  ownership: "USER" | "SYSTEM";
  /** Whether a worker cycle evaluates it now: `enabled`, or for a built-in `isGloballyEnabled`. */
  evaluated: boolean;
  /** Levels whose fingerprint changes — the ones whose rule named a group. */
  levelsReset: number;
  /** `(security, level)` state rows keyed to a fingerprint that changes. */
  statesReset: number;
  /** Of those, the ones holding an open Signal the next cycle closes as `LOGIC_CHANGED`. */
  activeSignalsClosed: number;
  /** Of those, the ones waiting for a Trigger, whose setup is dropped. */
  pendingSetupsDropped: number;
};

export type GroupScopeStrategyOutcome =
  /** Dry run: every group resolves, so an apply would convert it. */
  | "CONVERTIBLE"
  /** Apply: a new version was appended. */
  | "CONVERTED"
  /** Left exactly as it was; `skipReasons` says why. */
  | "SKIPPED";

export type GroupScopeStrategyReport = {
  strategyId: string;
  name: string;
  ownership: "USER" | "SYSTEM";
  /** The version the decision was made against. */
  versionNumber: number;
  /** Apply only: the version the conversion appended. */
  convertedVersionNumber?: number;
  outcome: GroupScopeStrategyOutcome;
  skipReasons: GroupScopeSkipReason[];
  /** What the validator said, when the reason is `DEFINITION_UNREADABLE` or `CONVERSION_INVALID`. */
  detail?: string;
  groups: GroupScopeGroupReport[];
  monitors: GroupScopeMonitorReport[];
};

export type GroupScopeConversionReport = {
  mode: "DRY_RUN" | "APPLY";
  strategiesScanned: number;
  strategiesWithGroupScope: number;
  /** Dry run: would convert. Always 0 on an apply, where they are `converted`. */
  convertible: number;
  converted: number;
  skipped: number;
  skippedByReason: Partial<Record<GroupScopeSkipReason, number>>;
  /** Monitors bound to a strategy that converts (or, on a dry run, would). */
  monitorsAffected: number;
  statesReset: number;
  activeSignalsClosed: number;
  strategies: GroupScopeStrategyReport[];
};

export type GroupScopeConversionOptions = {
  /** Write. Without it nothing is changed and the report says what would be. */
  apply?: boolean;
  /** Convert strategies that have a Monitor, accepting the one-time reset the report describes. */
  includeMonitored?: boolean;
  /** Restrict the run to these strategies. */
  strategyIds?: readonly string[];
};

type Database = PrismaClient | Prisma.TransactionClient;

type CandidateRow = {
  strategyId: string;
  versionNumber: number;
  definition: unknown;
};

/** What one strategy's current version resolves to, before anything is written. */
type StrategyPlan = {
  report: GroupScopeStrategyReport;
  /** Present exactly when every group resolved and the embedded definition is valid. */
  converted: StrategyDefinition | null;
};

/**
 * The current version of every strategy whose definition text mentions a group scope.
 *
 * The text match is only a pre-filter that keeps the read proportional to what could need
 * converting; whether a definition really holds a `GROUP` scope is decided by parsing it.
 */
async function candidateVersions(
  db: Database,
  strategyIds: readonly string[] | undefined,
): Promise<CandidateRow[]> {
  const rows = await db.$queryRaw<CandidateRow[]>`
    SELECT v."strategyId", v."versionNumber", v."definition"
    FROM "StrategyVersion" v
    JOIN (
      SELECT "strategyId", max("versionNumber") AS "versionNumber"
      FROM "StrategyVersion"
      GROUP BY "strategyId"
    ) latest
      ON latest."strategyId" = v."strategyId"
     AND latest."versionNumber" = v."versionNumber"
    WHERE v."definition"::text LIKE '%"GROUP"%'
    ORDER BY v."strategyId"
  `;
  if (!strategyIds) {
    return rows;
  }
  const wanted = new Set(strategyIds);
  return rows.filter((row) => wanted.has(row.strategyId));
}

function validationDetail(error: unknown): string {
  if (error instanceof StrategyValidationError) {
    return error.issues.map((issue) => issue.message).join(" ");
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decides what one strategy's current version converts to. Reads only.
 *
 * Returns null when the definition holds no group scope after all — the text pre-filter matched
 * something else — so the caller does not count it.
 */
async function planStrategy(
  db: Database,
  candidate: CandidateRow,
): Promise<StrategyPlan | null> {
  const strategy = await db.strategy.findUnique({
    where: { id: candidate.strategyId },
    select: { id: true, name: true, ownership: true, userId: true },
  });
  if (!strategy) {
    return null;
  }
  const base = {
    strategyId: strategy.id,
    name: strategy.name,
    ownership: strategy.ownership,
    versionNumber: candidate.versionNumber,
  } as const;

  let definition: StrategyDefinition;
  try {
    definition = normalizeStrategyDefinition(candidate.definition);
  } catch (error) {
    return {
      converted: null,
      report: {
        ...base,
        outcome: "SKIPPED",
        skipReasons: ["DEFINITION_UNREADABLE"],
        detail: validationDetail(error),
        groups: [],
        monitors: [],
      },
    };
  }

  const groupIds = collectActorGroupIds(
    collectAlternativeDataMetrics(definition),
  );
  if (groupIds.length === 0) {
    return null;
  }

  const rows = await db.actorGroup.findMany({
    where: { id: { in: groupIds } },
    select: {
      id: true,
      name: true,
      ownership: true,
      userId: true,
      members: { orderBy: { createdAt: "asc" }, select: { actorId: true } },
    },
  });
  const byId = new Map(rows.map((group) => [group.id, group]));
  const members = new Map<string, readonly string[]>();
  const groups: GroupScopeGroupReport[] = groupIds.map((groupId) => {
    const group = byId.get(groupId);
    if (!group) {
      return { groupId, name: null, memberCount: 0, status: "MISSING" };
    }
    const memberCount = group.members.length;
    // The same rule a backtest submission applies when it freezes a group: a strategy may use a
    // built-in group, or one its own owner holds. A built-in strategy has no owner, so only a
    // built-in group is its to use — one belonging to whichever administrator last edited it is
    // not, and embedding its members would publish a private selection in platform content.
    const accessible =
      group.ownership === "SYSTEM" ||
      (strategy.ownership === "USER" && group.userId === strategy.userId);
    const status: GroupScopeGroupStatus = !accessible
      ? "INACCESSIBLE"
      : memberCount === 0
        ? "EMPTY"
        : memberCount > ACTOR_SCOPE_MAX_ACTORS
          ? "TOO_LARGE"
          : "RESOLVED";
    if (status === "RESOLVED") {
      members.set(
        groupId,
        group.members.map((member) => member.actorId),
      );
    }
    return { groupId, name: group.name, memberCount, status };
  });

  const reasonOf: Record<
    Exclude<GroupScopeGroupStatus, "RESOLVED">,
    GroupScopeSkipReason
  > = {
    MISSING: "GROUP_MISSING",
    EMPTY: "GROUP_EMPTY",
    INACCESSIBLE: "GROUP_INACCESSIBLE",
    TOO_LARGE: "GROUP_TOO_LARGE",
  };
  const skipReasons = [
    ...new Set(
      groups.flatMap((group) =>
        group.status === "RESOLVED" ? [] : [reasonOf[group.status]],
      ),
    ),
  ];

  let converted: StrategyDefinition | null = null;
  let detail: string | undefined;
  if (skipReasons.length === 0) {
    try {
      converted = embedActorGroupScopes(definition, members);
    } catch (error) {
      skipReasons.push("CONVERSION_INVALID");
      detail = validationDetail(error);
    }
  }

  return {
    converted,
    report: {
      ...base,
      outcome: converted ? "CONVERTIBLE" : "SKIPPED",
      skipReasons,
      ...(detail === undefined ? {} : { detail }),
      groups,
      monitors: await monitorImpact(db, strategy.id, definition, converted),
    },
  };
}

/**
 * What converting one strategy would reset in each Monitor bound to it.
 *
 * Computed from the very thing the worker compares — `monitorStrategyLevels(...).fingerprint` before
 * and after — so the report cannot disagree with the cycle about which levels change. A strategy that
 * will not convert resets nothing and reports its Monitors with zeroes, so an operator still sees
 * that they exist.
 */
async function monitorImpact(
  db: Database,
  strategyId: string,
  current: StrategyDefinition,
  converted: StrategyDefinition | null,
): Promise<GroupScopeMonitorReport[]> {
  const monitors = await db.monitor.findMany({
    where: { strategyId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      ownership: true,
      enabled: true,
      isGloballyEnabled: true,
    },
  });
  if (monitors.length === 0) {
    return [];
  }
  const after = new Map(
    (converted ? monitorStrategyLevels(converted) : []).map((level) => [
      level.id,
      level.fingerprint,
    ]),
  );
  const changedLevelIds = converted
    ? monitorStrategyLevels(current)
        .filter((level) => after.get(level.id) !== level.fingerprint)
        .map((level) => level.id)
    : [];

  const reports: GroupScopeMonitorReport[] = [];
  for (const monitor of monitors) {
    const states =
      changedLevelIds.length === 0
        ? []
        : await db.monitorSignalState.groupBy({
            by: ["lifecycleState"],
            where: { monitorId: monitor.id, levelId: { in: changedLevelIds } },
            _count: { _all: true },
          });
    const count = (state: string): number =>
      states.find((entry) => entry.lifecycleState === state)?._count._all ?? 0;
    reports.push({
      monitorId: monitor.id,
      name: monitor.name,
      ownership: monitor.ownership,
      evaluated:
        monitor.ownership === "SYSTEM"
          ? monitor.isGloballyEnabled
          : monitor.enabled,
      levelsReset: changedLevelIds.length,
      statesReset: states.reduce((sum, entry) => sum + entry._count._all, 0),
      activeSignalsClosed: count("ACTIVE"),
      pendingSetupsDropped: count("PENDING_TRIGGER"),
    });
  }
  return reports;
}

/**
 * Plans — and with `apply`, performs — the conversion of every strategy still naming a group.
 *
 * Each strategy is decided and written inside its own transaction, under the same `FOR UPDATE` row
 * lock `replaceDefinition` takes, so a strategy being edited at the same moment is converted from
 * the version that edit left or not at all, never from a version that is no longer current. One
 * strategy failing does not stop the others: it is reported and the run goes on.
 */
export async function convertGroupScopes(
  prisma: PrismaClient,
  options: GroupScopeConversionOptions = {},
): Promise<GroupScopeConversionReport> {
  const apply = options.apply === true;
  const strategiesScanned = await prisma.strategy.count({
    where: options.strategyIds ? { id: { in: [...options.strategyIds] } } : {},
  });
  const candidates = await candidateVersions(prisma, options.strategyIds);

  const strategies: GroupScopeStrategyReport[] = [];
  for (const candidate of candidates) {
    if (!apply) {
      const plan = await planStrategy(prisma, candidate);
      if (plan) {
        strategies.push(plan.report);
      }
      continue;
    }

    const report = await prisma.$transaction(async (tx) => {
      // Serializes with a concurrent `replaceDefinition` of the same strategy.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Strategy" WHERE "id" = ${candidate.strategyId} FOR UPDATE
      `;
      if (locked.length === 0) {
        return null;
      }
      // Re-read under the lock: the version the candidate list saw may already have been replaced.
      const [current] = await candidateVersions(tx, [candidate.strategyId]);
      if (!current) {
        return null;
      }
      const plan = await planStrategy(tx, current);
      if (!plan) {
        return null;
      }
      if (!plan.converted) {
        return plan.report;
      }
      if (
        plan.report.monitors.length > 0 &&
        options.includeMonitored !== true
      ) {
        return {
          ...plan.report,
          outcome: "SKIPPED" as const,
          skipReasons: ["MONITORED" as const],
        };
      }
      await appendStrategyVersionIfChanged(
        tx,
        candidate.strategyId,
        plan.converted,
      );
      const appended = await tx.strategyVersion.findFirst({
        where: { strategyId: candidate.strategyId },
        orderBy: { versionNumber: "desc" },
        select: { versionNumber: true },
      });
      return {
        ...plan.report,
        outcome: "CONVERTED" as const,
        ...(appended ? { convertedVersionNumber: appended.versionNumber } : {}),
      };
    });
    if (report) {
      strategies.push(report);
    }
  }

  const skippedByReason: Partial<Record<GroupScopeSkipReason, number>> = {};
  for (const strategy of strategies) {
    for (const reason of strategy.skipReasons) {
      skippedByReason[reason] = (skippedByReason[reason] ?? 0) + 1;
    }
  }
  const converting = strategies.filter(
    (strategy) => strategy.outcome !== "SKIPPED",
  );
  const affectedMonitors = converting.flatMap((strategy) => strategy.monitors);

  return {
    mode: apply ? "APPLY" : "DRY_RUN",
    strategiesScanned,
    strategiesWithGroupScope: strategies.length,
    convertible: strategies.filter(
      (strategy) => strategy.outcome === "CONVERTIBLE",
    ).length,
    converted: strategies.filter((strategy) => strategy.outcome === "CONVERTED")
      .length,
    skipped: strategies.filter((strategy) => strategy.outcome === "SKIPPED")
      .length,
    skippedByReason,
    monitorsAffected: affectedMonitors.length,
    statesReset: affectedMonitors.reduce(
      (sum, monitor) => sum + monitor.statesReset,
      0,
    ),
    activeSignalsClosed: affectedMonitors.reduce(
      (sum, monitor) => sum + monitor.activeSignalsClosed,
      0,
    ),
    strategies,
  };
}

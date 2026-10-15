import {
  asAlternativeDataMetric,
  collectActorIds,
  describeCondition,
  describeTrigger,
  normalizeStrategyDefinition,
  type AlternativeDataMetric,
  type MonitorLevelKind,
  type MonitorWhyPredicateResponse,
  type MonitorWhyResponse,
  type StrategyScopeNames,
  type StrategySignal,
} from "@intrinsic/contracts";
import type { MonitorTransitionEvidence } from "@intrinsic/strategy";
import type { PrismaService } from "../database/prisma.service";

/**
 * Why a Monitor lifecycle change happened, rendered from the **Strategy version that decided it**
 * and the evidence the worker recorded on the transition (`docs/decisions/monitor-eod-v2.md` §5–§6).
 *
 * Never a re-evaluation and never the Strategy as it reads today: an edited rule must not rewrite
 * why an old Signal fired. Without recorded evidence the decided rule's wording is shown alone
 * (`RULE_ONLY`) — no value is recomputed to fill the gap.
 */

/** One level of a stored Strategy version, as a Why describes it. */
export type StoredLevel = {
  kind: MonitorLevelKind;
  /** Position among levels of its kind (1-based); absent for FINAL EXIT. */
  index?: number;
  percentage?: number;
  /** The level's rules, keyed as the worker keys their evidence: the level id, or each Exit Rule's. */
  rules: { ruleId: string; exitRule?: number; signal: StrategySignal }[];
};

/** Every level of one stored definition, keyed by level id. */
export function storedLevelsOf(stored: unknown): Map<string, StoredLevel> {
  const levels = new Map<string, StoredLevel>();
  const definition = normalizeStrategyDefinition(stored);
  definition.buyLevels.forEach((level, index) => {
    levels.set(level.id, {
      kind: "BUY",
      index: index + 1,
      percentage: level.percentage,
      rules: [{ ruleId: level.id, signal: level.signal }],
    });
  });
  definition.sellLevels.forEach((level, index) => {
    levels.set(level.id, {
      kind: "SELL",
      index: index + 1,
      percentage: level.percentage,
      rules: [{ ruleId: level.id, signal: level.signal }],
    });
  });
  const exit = definition.finalExit;
  if (exit) {
    levels.set(exit.id, {
      kind: "FINAL_EXIT",
      rules: exit.rules.map((rule, index) => ({
        ruleId: rule.id,
        ...(exit.rules.length > 1 ? { exitRule: index + 1 } : {}),
        signal: rule.signal,
      })),
    });
  }
  return levels;
}

/**
 * The levels of each named Strategy version, in one read. A version that cannot be read is simply
 * absent: its rows render without a Why rather than failing the page.
 */
export async function loadStoredLevels(
  prisma: PrismaService,
  versionIds: Iterable<string>,
  onUnreadable: (versionId: string, err: unknown) => void,
): Promise<Map<string, Map<string, StoredLevel>>> {
  const ids = [...new Set(versionIds)];
  const result = new Map<string, Map<string, StoredLevel>>();
  if (ids.length === 0) {
    return result;
  }
  const rows = await prisma.strategyVersion.findMany({
    where: { id: { in: ids } },
    select: { id: true, definition: true },
  });
  for (const row of rows) {
    try {
      result.set(row.id, storedLevelsOf(row.definition));
    } catch (err) {
      onUnreadable(row.id, err);
    }
  }
  return result;
}

/**
 * The names of the members of Congress the described rules select, in one read — platform reference
 * data a Guest may already read on `/alternative-data/actors`.
 */
export async function scopeNamesFor(
  prisma: PrismaService,
  signals: Iterable<StrategySignal>,
): Promise<StrategyScopeNames> {
  const metrics: AlternativeDataMetric[] = [];
  for (const signal of signals) {
    for (const predicate of [
      ...signal.conditions,
      ...(signal.trigger ? [signal.trigger] : []),
    ]) {
      const metric = asAlternativeDataMetric(predicate.metric);
      if (metric) {
        metrics.push(metric);
      }
    }
  }
  const actorIds = collectActorIds(metrics);
  if (actorIds.length === 0) {
    return {};
  }
  const actors = await prisma.alternativeDataActor.findMany({
    where: { id: { in: actorIds } },
    select: { id: true, displayName: true },
  });
  return {
    actors: Object.fromEntries(
      actors.map((actor) => [actor.id, actor.displayName]),
    ),
  };
}

/** The recorded evidence, or null for anything that is not the version-1 shape. */
export function parseTransitionEvidence(
  value: unknown,
): MonitorTransitionEvidence | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as { v?: unknown; rules?: unknown };
  if (record.v !== 1 || !Array.isArray(record.rules)) {
    return null;
  }
  for (const rule of record.rules) {
    if (
      typeof rule !== "object" ||
      rule === null ||
      typeof (rule as { ruleId?: unknown }).ruleId !== "string" ||
      !Array.isArray((rule as { predicates?: unknown }).predicates)
    ) {
      return null;
    }
  }
  return value as MonitorTransitionEvidence;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The Why of one change of `level`: with `evidence`, the rules it names and each predicate's
 * recorded values; without, every rule's wording alone.
 */
export function whyOf(
  level: StoredLevel,
  evidence: MonitorTransitionEvidence | null,
  scopeNames: StrategyScopeNames,
  sessionDate?: string,
): MonitorWhyResponse {
  const describe = (
    signal: StrategySignal,
    id: string,
  ): Pick<MonitorWhyPredicateResponse, "role" | "description"> | null => {
    const condition = signal.conditions.find((entry) => entry.id === id);
    if (condition) {
      return {
        role: "CONDITION",
        description: describeCondition(condition, scopeNames),
      };
    }
    if (signal.trigger?.id === id) {
      return {
        role: "TRIGGER",
        description: describeTrigger(signal.trigger, scopeNames),
      };
    }
    return null;
  };

  if (evidence) {
    const rules = evidence.rules.flatMap((recorded) => {
      const rule = level.rules.find(
        (entry) => entry.ruleId === recorded.ruleId,
      );
      if (!rule) {
        return [];
      }
      const predicates: MonitorWhyPredicateResponse[] = [];
      for (const predicate of recorded.predicates) {
        const described = describe(rule.signal, predicate.id);
        if (!described) {
          continue;
        }
        predicates.push({
          ...described,
          result: predicate.result,
          metric: numberOrNull(predicate.metric),
          value: numberOrNull(predicate.value),
          ...(described.role === "TRIGGER"
            ? {
                previousMetric: numberOrNull(predicate.previousMetric),
                previousValue: numberOrNull(predicate.previousValue),
              }
            : {}),
        });
      }
      return [
        {
          ...(rule.exitRule === undefined ? {} : { exitRule: rule.exitRule }),
          predicates,
        },
      ];
    });
    if (rules.length > 0) {
      return {
        basis: "EVIDENCE",
        ...(sessionDate ? { sessionDate } : {}),
        rules,
      };
    }
  }
  return {
    basis: "RULE_ONLY",
    ...(sessionDate ? { sessionDate } : {}),
    rules: level.rules.map((rule) => ({
      ...(rule.exitRule === undefined ? {} : { exitRule: rule.exitRule }),
      predicates: [
        ...rule.signal.conditions.map((condition) => ({
          role: "CONDITION" as const,
          description: describeCondition(condition, scopeNames),
        })),
        ...(rule.signal.trigger
          ? [
              {
                role: "TRIGGER" as const,
                description: describeTrigger(rule.signal.trigger, scopeNames),
              },
            ]
          : []),
      ],
    })),
  };
}

/** The opaque cursor a page hands back: a JSON object, base64url-encoded. */
export function encodeCursor(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    );
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

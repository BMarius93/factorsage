import {
  describeCondition,
  describeTrigger,
  normalizeStrategyDefinition,
  type AuthUser,
  type DashboardFreshness,
  type DashboardMonitorResponse,
  type DashboardResponse,
  type DashboardRowReason,
  type DashboardRowResponse,
  type MonitorEligibility,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  monitorStrategyLevels,
  parseMonitorRuleStates,
} from "@intrinsic/strategy";
import { Inject, Injectable } from "@nestjs/common";
import type { ContentViewer } from "../builtins/content-access";
import { PrismaService } from "../database/prisma.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { DASHBOARD_LOGGER, DASHBOARD_OPTIONS } from "./dashboard.tokens";

export type DashboardOptions = {
  /** How old a Monitor's latest scan may be and still be presented as current. */
  staleAfterMs: number;
  now?: () => Date;
};

/** A built-in the viewer asked to hide or show does not exist or is not published. */
export class BuiltInMonitorNotFoundError extends Error {
  constructor() {
    super("Built-in monitor was not found");
    this.name = "BuiltInMonitorNotFoundError";
  }
}

const LEVEL_ORDER = { BUY: 0, SELL: 1, FINAL_EXIT: 2 } as const;

/** One level of a current definition, as the Dashboard describes it. */
type LevelDescription = {
  kind: "BUY" | "SELL" | "FINAL_EXIT";
  index?: number;
  percentage?: number;
  /** The level's rules in definition order, with the key their rule-local state is stored under. */
  rules: { key: string; exitRule?: number; signal: StrategySignal }[];
};

/**
 * The Dashboard read model (`docs/decisions/builtin-dashboard-signals-v1.md` sections 4 and 5).
 *
 * A projection of durable Monitor state, never a re-evaluation: the worker decides lifecycles, and
 * this reads the current `ACTIVE` and `PENDING_TRIGGER` rows of the Monitors the viewer can see.
 * Being signed in changes only which Monitors are visible — never what any of them decided.
 */
@Injectable()
export class DashboardService {
  private readonly now: () => Date;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EntitlementsService)
    private readonly entitlements: EntitlementsService,
    @Inject(DASHBOARD_OPTIONS) private readonly options: DashboardOptions,
    @Inject(DASHBOARD_LOGGER) private readonly logger: StructuredLogger,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getDashboard(viewer: ContentViewer): Promise<DashboardResponse> {
    const now = this.now();
    const [monitors, preferences, eligibility] = await Promise.all([
      this.prisma.monitor.findMany({
        where: viewer
          ? {
              OR: [
                { ownership: "SYSTEM", isPublished: true },
                { userId: viewer.id },
              ],
            }
          : { ownership: "SYSTEM", isPublished: true },
        include: {
          strategy: {
            select: {
              id: true,
              name: true,
              versions: {
                orderBy: { versionNumber: "desc" },
                take: 1,
                select: { definition: true },
              },
            },
          },
          stockList: { select: { id: true, name: true } },
        },
        orderBy: [
          { ownership: "desc" },
          { displayOrder: { sort: "asc", nulls: "last" } },
          { createdAt: "asc" },
          { id: "asc" },
        ],
      }),
      viewer
        ? this.prisma.userBuiltInMonitorPreference.findMany({
            where: { userId: viewer.id },
            select: { monitorId: true, enabled: true },
          })
        : Promise.resolve([]),
      viewer
        ? this.entitlements.getMonitorExecutionEligibility(viewer.id)
        : Promise.resolve(new Map<string, MonitorEligibility>()),
    ]);
    const hidden = new Set(
      preferences
        .filter((entry) => !entry.enabled)
        .map((entry) => entry.monitorId),
    );

    const levelsByMonitor = new Map<string, Map<string, LevelDescription>>();
    for (const monitor of monitors) {
      levelsByMonitor.set(
        monitor.id,
        this.describeLevels(
          monitor.id,
          monitor.strategy.versions[0]?.definition,
        ),
      );
    }

    const states = await this.prisma.monitorSignalState.findMany({
      where: {
        monitorId: { in: monitors.map((monitor) => monitor.id) },
        lifecycleState: { in: ["ACTIVE", "PENDING_TRIGGER"] },
      },
      select: {
        id: true,
        monitorId: true,
        levelId: true,
        levelKind: true,
        lifecycleState: true,
        lifecycleSince: true,
        lifecycleSinceDate: true,
        lifecycleSincePrice: true,
        ruleStates: true,
        security: {
          select: {
            id: true,
            symbol: true,
            name: true,
            exchangeCode: true,
            exchangeName: true,
            profile: { select: { logoUrl: true } },
          },
        },
        activeSignal: {
          select: {
            id: true,
            observationDate: true,
            observationPrice: true,
            reconstructed: true,
            resolvedAt: true,
          },
        },
      },
    });

    const counts = new Map<string, { active: number; pending: number }>();
    const monitorResponses: DashboardMonitorResponse[] = [];
    const running = new Set<string>();
    for (const monitor of monitors) {
      const system = monitor.ownership === "SYSTEM";
      const isRunning = system
        ? monitor.isGloballyEnabled
        : (eligibility.get(monitor.id)?.executionEligible ?? false);
      if (isRunning) {
        running.add(monitor.id);
      }
      counts.set(monitor.id, { active: 0, pending: 0 });
      monitorResponses.push({
        id: monitor.id,
        name: monitor.name,
        ownership: monitor.ownership,
        strategy: { id: monitor.strategy.id, name: monitor.strategy.name },
        stockList: { id: monitor.stockList.id, name: monitor.stockList.name },
        visible: system ? !hidden.has(monitor.id) : monitor.enabled,
        control: system ? "BUILT_IN_PREFERENCE" : "MONITOR_ENABLED",
        freshness: this.freshnessOf(isRunning, monitor.lastScanAt, now),
        ...(monitor.lastScanAt
          ? { lastScanAt: monitor.lastScanAt.toISOString() }
          : {}),
        activeCount: 0,
        pendingCount: 0,
      });
    }

    const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
    const shown = new Set(
      monitorResponses
        .filter((monitor) => monitor.visible && running.has(monitor.id))
        .map((monitor) => monitor.id),
    );
    const rows: DashboardRowResponse[] = [];
    for (const state of states) {
      const monitor = byId.get(state.monitorId);
      const level = levelsByMonitor.get(state.monitorId)?.get(state.levelId);
      // A row belonging to a level the current Strategy no longer monitors describes nothing
      // current; the worker's next cycle closes it.
      if (!monitor || !level) {
        continue;
      }
      const active = state.lifecycleState === "ACTIVE";
      const signal = state.activeSignal;
      if (active && (!signal || signal.resolvedAt !== null)) {
        continue;
      }
      const tally = counts.get(monitor.id)!;
      if (active) {
        tally.active += 1;
      } else {
        tally.pending += 1;
      }
      if (!shown.has(monitor.id)) {
        continue;
      }

      const ruleStates = parseMonitorRuleStates(state.ruleStates);
      const wanted = active ? "ACTIVE" : "PENDING_TRIGGER";
      const described = level.rules.filter(
        (rule) => (ruleStates[rule.key]?.state ?? wanted) === wanted,
      );
      const reasons: DashboardRowReason[] = (
        described.length > 0 ? described : level.rules
      ).map((rule) => ({
        ...(rule.exitRule === undefined ? {} : { exitRule: rule.exitRule }),
        conditions: rule.signal.conditions.map(describeCondition),
        ...(rule.signal.trigger
          ? { trigger: describeTrigger(rule.signal.trigger) }
          : {}),
        waitingForTrigger:
          ruleStates[rule.key]?.state === "PENDING_TRIGGER" || !active,
      }));
      const observationDate = active
        ? signal!.observationDate
        : state.lifecycleSinceDate;
      const price = active
        ? Number(signal!.observationPrice)
        : state.lifecycleSincePrice === null
          ? undefined
          : Number(state.lifecycleSincePrice);

      rows.push({
        id: state.id,
        state: wanted,
        security: {
          id: state.security.id,
          symbol: state.security.symbol,
          name: state.security.name,
          exchangeCode: state.security.exchangeCode,
          ...(state.security.exchangeName
            ? { exchangeName: state.security.exchangeName }
            : {}),
          ...(state.security.profile?.logoUrl
            ? { logoUrl: state.security.profile.logoUrl }
            : {}),
        },
        levelKind: state.levelKind,
        ...(level.index === undefined ? {} : { levelIndex: level.index }),
        ...(level.percentage === undefined
          ? {}
          : { levelPercentage: level.percentage }),
        reasons,
        monitor: {
          id: monitor.id,
          name: monitor.name,
          ownership: monitor.ownership,
        },
        strategy: { id: monitor.strategy.id, name: monitor.strategy.name },
        stockList: { id: monitor.stockList.id, name: monitor.stockList.name },
        ...(price === undefined ? {} : { price }),
        ...(observationDate
          ? { observationDate: observationDate.toISOString().slice(0, 10) }
          : {}),
        since: state.lifecycleSince.toISOString(),
        reconstructed: active ? signal!.reconstructed : false,
        ...(active ? { signalId: signal!.id } : {}),
      });
    }

    for (const monitor of monitorResponses) {
      const tally = counts.get(monitor.id)!;
      monitor.activeCount = tally.active;
      monitor.pendingCount = tally.pending;
    }

    const monitorOrder = new Map(
      monitors.map((monitor, index) => [monitor.id, index]),
    );
    rows.sort(
      (left, right) =>
        (right.observationDate ?? "").localeCompare(
          left.observationDate ?? "",
        ) ||
        right.since.localeCompare(left.since) ||
        monitorOrder.get(left.monitor.id)! -
          monitorOrder.get(right.monitor.id)! ||
        left.security.symbol.localeCompare(right.security.symbol) ||
        LEVEL_ORDER[left.levelKind] - LEVEL_ORDER[right.levelKind] ||
        (left.levelIndex ?? 0) - (right.levelIndex ?? 0) ||
        left.id.localeCompare(right.id),
    );

    return {
      viewer: viewer ? "AUTHENTICATED" : "GUEST",
      generatedAt: now.toISOString(),
      staleAfterMs: this.options.staleAfterMs,
      monitors: monitorResponses,
      rows,
    };
  }

  /**
   * Records a signed-in customer's choice to show or hide a published built-in.
   *
   * Only the override is stored, and it changes this user's Dashboard alone — the shared Monitor
   * keeps being evaluated for everyone.
   */
  async setBuiltInVisibility(
    user: AuthUser,
    monitorId: string,
    visible: boolean,
  ): Promise<{ monitorId: string; visible: boolean }> {
    const monitor = await this.prisma.monitor.findFirst({
      where: { id: monitorId, ownership: "SYSTEM", isPublished: true },
      select: { id: true },
    });
    if (!monitor) {
      throw new BuiltInMonitorNotFoundError();
    }
    await this.prisma.userBuiltInMonitorPreference.upsert({
      where: { userId_monitorId: { userId: user.id, monitorId } },
      create: { userId: user.id, monitorId, enabled: visible },
      update: { enabled: visible },
    });
    this.logger.info({
      event: "dashboard.built-in-visibility.updated",
      actorUserId: user.id,
      monitorId,
      visible,
    });
    return { monitorId, visible };
  }

  private freshnessOf(
    running: boolean,
    lastScanAt: Date | null,
    now: Date,
  ): DashboardFreshness {
    if (!running) {
      return "PAUSED";
    }
    if (!lastScanAt) {
      return "NOT_SCANNED";
    }
    return now.getTime() - lastScanAt.getTime() > this.options.staleAfterMs
      ? "STALE"
      : "CURRENT";
  }

  /**
   * The levels the current Strategy version is evaluated on, keyed by level id, with what the
   * Dashboard says about each. Read through `monitorStrategyLevels`, the list the worker walks.
   */
  private describeLevels(
    monitorId: string,
    stored: unknown,
  ): Map<string, LevelDescription> {
    const levels = new Map<string, LevelDescription>();
    if (stored === undefined) {
      return levels;
    }
    let definition: StrategyDefinition;
    try {
      definition = normalizeStrategyDefinition(stored);
    } catch (err) {
      this.logger.error({
        event: "dashboard.definition.unreadable",
        monitorId,
        err,
      });
      return levels;
    }
    const monitored = new Set(
      monitorStrategyLevels(definition).map((level) => level.id),
    );
    definition.buyLevels.forEach((level, index) => {
      if (monitored.has(level.id)) {
        levels.set(level.id, {
          kind: "BUY",
          index: index + 1,
          percentage: level.percentage,
          rules: [{ key: level.id, signal: level.signal }],
        });
      }
    });
    definition.sellLevels.forEach((level, index) => {
      if (monitored.has(level.id)) {
        levels.set(level.id, {
          kind: "SELL",
          index: index + 1,
          percentage: level.percentage,
          rules: [{ key: level.id, signal: level.signal }],
        });
      }
    });
    const exit = definition.finalExit;
    if (exit && monitored.has(exit.id)) {
      levels.set(exit.id, {
        kind: "FINAL_EXIT",
        rules: exit.rules.map((rule, index) => ({
          key: rule.id,
          ...(exit.rules.length > 1 ? { exitRule: index + 1 } : {}),
          signal: rule.signal,
        })),
      });
    }
    return levels;
  }
}

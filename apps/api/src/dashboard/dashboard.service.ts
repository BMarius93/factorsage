import {
  describeCondition,
  describeTrigger,
  monitorActivityWindowStart,
  normalizeStrategyDefinition,
  type AuthUser,
  type DashboardActivityEventResponse,
  type DashboardActivityResponse,
  type DashboardFreshness,
  type DashboardMonitorResponse,
  type DashboardResponse,
  type DashboardRowReason,
  type DashboardRowResponse,
  type MonitorEligibility,
  type StrategyDefinition,
  type StrategyScopeNames,
  type StrategySignal,
} from "@intrinsic/contracts";
import { Prisma } from "@intrinsic/database";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  monitorStrategyLevels,
  parseMonitorRuleStates,
} from "@intrinsic/strategy";
import { Inject, Injectable } from "@nestjs/common";
import type { ContentViewer } from "../builtins/content-access";
import { PrismaService } from "../database/prisma.service";
import { eodToday } from "../eod-today";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { visibleMonitorWhere } from "../monitors/monitor-visibility";
import { monitorStateSince } from "../monitors/signal-since";
import {
  decodeCursor,
  encodeCursor,
  loadStoredLevels,
  parseTransitionEvidence,
  scopeNamesFor,
  whyOf,
} from "../monitors/signal-why";
import {
  ACTIVITY_THROUGH_LIMIT,
  type ActivityQuery,
} from "./dashboard-requests";
import { DASHBOARD_LOGGER, DASHBOARD_OPTIONS } from "./dashboard.tokens";

export type DashboardOptions = {
  /** How old a Monitor's latest scan may be and still be presented as current. */
  staleAfterMs: number;
  now?: () => Date;
};

/** An Activity cursor this API did not issue. */
export class InvalidActivityCursorError extends Error {
  constructor() {
    super("Invalid activity cursor");
    this.name = "InvalidActivityCursorError";
  }
}

/** A Monitor whose Activity history was asked for does not exist or is not the viewer's to read. */
export class MonitorActivityNotFoundError extends Error {
  constructor() {
    super("Monitor not found");
    this.name = "MonitorActivityNotFoundError";
  }
}

/** What the feed shows of each Monitor an event belongs to. */
const ACTIVITY_MONITOR_SELECT = {
  id: true,
  name: true,
  ownership: true,
  enabled: true,
  strategy: { select: { id: true, name: true } },
  stockList: { select: { id: true, name: true } },
} satisfies Prisma.MonitorSelect;

type ActivityMonitor = Prisma.MonitorGetPayload<{
  select: typeof ACTIVITY_MONITOR_SELECT;
}>;

/** What one stored change contributes to an event. */
const ACTIVITY_EVENT_SELECT = {
  id: true,
  sequence: true,
  monitorId: true,
  levelId: true,
  levelKind: true,
  toState: true,
  reason: true,
  origin: true,
  occurredAt: true,
  observationDate: true,
  strategyVersionId: true,
  evidence: true,
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
  signal: {
    select: {
      id: true,
      observationPrice: true,
      observationBasis: true,
      strategyVersionId: true,
    },
  },
} satisfies Prisma.MonitorStateTransitionSelect;

type ActivityEventRow = Prisma.MonitorStateTransitionGetPayload<{
  select: typeof ACTIVITY_EVENT_SELECT;
}>;

/**
 * The reasons a finalized session enters `ACTIVE` by. A reconstructed state (`RECONSTRUCTED`) is
 * where a replay or a reconstruction *starts*, established from history before it rather than
 * decided on its date, so it is never an event.
 */
const ACTIVATING_REASONS = ["CONDITIONS_MET", "TRIGGER_FIRED"] as const;

/**
 * What an event is (§6.1, §12), narrowed to one kind when asked. Each branch is exactly the
 * classification the response applies, so a filtered read holds the same events as the unfiltered
 * feed minus the other kind, and the keyset cursor and `through` ranges page it unchanged.
 */
function activityKindWhere(
  kind: ActivityQuery["kind"],
): Prisma.MonitorStateTransitionWhereInput {
  const activated: Prisma.MonitorStateTransitionWhereInput = {
    toState: "ACTIVE",
    reason: { in: [...ACTIVATING_REASONS] },
  };
  const resolved: Prisma.MonitorStateTransitionWhereInput = {
    fromState: "ACTIVE",
    toState: { not: "ACTIVE" },
    reason: "CONDITIONS_ENDED",
  };
  if (kind === "ACTIVATED") {
    return activated;
  }
  if (kind === "RESOLVED") {
    return resolved;
  }
  return { OR: [activated, resolved] };
}

/**
 * What every event is, whatever the kind (`docs/decisions/monitor-eod-v2.md` §12), enforced in the
 * query so no page, cursor or count can include anything else:
 *
 * - **a finalized end-of-day session decided it** — observed, or found afterwards (`HISTORY`, shown
 *   as From history); never an administrative change, which observed no session;
 * - **its evidence was recorded** — every condition shows the values it compared on that session.
 *   A change recorded before evidence existed is shown only once `monitors:backfill-evidence` has
 *   verified and recorded it, and never with values recomputed at read time;
 * - **its occurrence was decided on the session's close** (`EOD_CLOSE`): an occurrence the earlier
 *   live-quote Monitor decided on an intraday price is history kept for the Signal table, not
 *   activity — neither its activation nor its ending.
 */
const ACTIVITY_EVENT_SCOPE = {
  origin: { in: ["OBSERVED", "HISTORY"] },
  observationDate: { not: null },
  evidence: { not: Prisma.DbNull },
  signal: { is: { observationBasis: "EOD_CLOSE" } },
} satisfies Prisma.MonitorStateTransitionWhereInput;

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
    const disabled = new Set(
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
    const scopeNames = await this.scopeNamesOf(levelsByMonitor);

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
        enabled: system ? !disabled.has(monitor.id) : monitor.enabled,
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
        .filter((monitor) => monitor.enabled && running.has(monitor.id))
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
        conditions: rule.signal.conditions.map((condition) =>
          describeCondition(condition, scopeNames),
        ),
        ...(rule.signal.trigger
          ? { trigger: describeTrigger(rule.signal.trigger, scopeNames) }
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
        // The session the row reports, not the scan that wrote it (AUD-05).
        since: monitorStateSince({
          observationDate,
          enteredAt: state.lifecycleSince,
        }),
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
   * The Monitor Activity feed (`docs/decisions/monitor-eod-v2.md` §6, §12): the end-of-day activity
   * of the Monitors this viewer has enabled, over the rolling 30-day window, newest session first.
   *
   * An event is an occurrence a finalized session activated, or one a market observation ended
   * (`CONDITIONS_ENDED`) — observed, or found afterwards (`fromHistory`: a window replay, a resumed
   * Monitor's catch-up, a member added later). Never shown: a reconstructed state, administrative
   * endings (an edit, a removal, a membership change, a rebind), a trigger day passing
   * (`EVENT_SESSION_ENDED`), setups waiting for a trigger, anything without recorded evidence, and
   * the live-quote Monitor's intraday occurrences (`ACTIVITY_EVENT_SCOPE`). The Monitors are the
   * ones Enabled for the viewer — published built-ins they have not disabled (all of them for a
   * Guest), and their own enabled Monitors — and each event explains itself from the version and
   * evidence recorded with it. Keyset-paged on `(session, sequence)`, so a page is stable while new
   * sessions arrive.
   */
  async getActivity(
    viewer: ContentViewer,
    query: ActivityQuery,
  ): Promise<DashboardActivityResponse> {
    const now = this.now();
    const [monitors, preferences] = await Promise.all([
      this.prisma.monitor.findMany({
        where: viewer
          ? {
              OR: [
                { ownership: "SYSTEM", isPublished: true },
                { userId: viewer.id },
              ],
            }
          : { ownership: "SYSTEM", isPublished: true },
        select: ACTIVITY_MONITOR_SELECT,
      }),
      viewer
        ? this.prisma.userBuiltInMonitorPreference.findMany({
            where: { userId: viewer.id, enabled: false },
            select: { monitorId: true },
          })
        : Promise.resolve([]),
    ]);
    const disabled = new Set(preferences.map((entry) => entry.monitorId));
    const enabled = new Map(
      monitors
        .filter((monitor) =>
          monitor.ownership === "SYSTEM"
            ? !disabled.has(monitor.id)
            : monitor.enabled,
        )
        .map((monitor) => [monitor.id, monitor]),
    );
    const monitorIds =
      query.monitorId === undefined
        ? [...enabled.keys()]
        : enabled.has(query.monitorId)
          ? [query.monitorId]
          : [];
    // The rolling window ends at the newest finalized date: never later than the newest session any
    // pass evaluated, so every day shown is a day the worker's window covered.
    const windowStart = monitorActivityWindowStart(eodToday(now));
    return this.readActivity(
      viewer,
      enabled,
      monitorIds,
      query,
      now,
      windowStart,
    );
  }

  /**
   * One Monitor's own Activity history (`GET /monitors/:monitorId/activity`): the Dashboard feed's
   * events, pages, cursors and `through` re-reads, over that Monitor alone — the same events, the
   * same order, no second event model.
   *
   * Readable exactly where the Monitor's own page is (`visibleMonitorWhere`): its owner's, enabled
   * or not, and a published built-in, enabled for this viewer or not. The Dashboard shows the last
   * thirty days of what a viewer enabled; a Monitor's page shows its whole history.
   */
  async getMonitorActivity(
    viewer: ContentViewer,
    monitorId: string,
    query: Omit<ActivityQuery, "monitorId">,
  ): Promise<DashboardActivityResponse> {
    const now = this.now();
    const monitor = await this.prisma.monitor.findFirst({
      where: { id: monitorId, ...visibleMonitorWhere(viewer) },
      select: ACTIVITY_MONITOR_SELECT,
    });
    if (!monitor) {
      throw new MonitorActivityNotFoundError();
    }
    return this.readActivity(
      viewer,
      new Map([[monitor.id, monitor]]),
      [monitor.id],
      { ...query, monitorId },
      now,
    );
  }

  /**
   * One read of the Activity feed over the given Monitors: a page (the first, or the one after
   * `cursor`), or — with `through` — the range from the newest event down to and including a given
   * one, which is how a reader refreshes everything they already hold.
   *
   * Keyset-ordered on `(observationDate, sequence)`, both descending, so a page is stable while new
   * sessions arrive. A `through` read exists for what new pages cannot show: an event written for a
   * session older than the newest — an ETF waiting for its data, a late bar — lands *inside* the range
   * a reader has loaded. Re-reading that range by key finds it whenever it was committed; no clock or
   * commit order is assumed.
   */
  private async readActivity(
    viewer: ContentViewer,
    monitors: ReadonlyMap<string, ActivityMonitor>,
    monitorIds: readonly string[],
    query: ActivityQuery,
    now: Date,
    /** The Dashboard's rolling window; absent on a Monitor's own, unwindowed history. */
    windowStart?: string,
  ): Promise<DashboardActivityResponse> {
    const empty: DashboardActivityResponse = {
      viewer: viewer ? "AUTHENTICATED" : "GUEST",
      generatedAt: now.toISOString(),
      ...(windowStart === undefined ? {} : { windowStart }),
      events: [],
    };
    if (monitorIds.length === 0) {
      return empty;
    }
    const scope: Prisma.MonitorStateTransitionWhereInput = {
      ...ACTIVITY_EVENT_SCOPE,
      monitorId: { in: [...monitorIds] },
      observationDate:
        windowStart === undefined
          ? { not: null }
          : { gte: new Date(`${windowStart}T00:00:00.000Z`) },
    };

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (
      query.cursor &&
      (cursor === null ||
        typeof cursor.d !== "string" ||
        typeof cursor.s !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(cursor.d) ||
        !/^\d+$/.test(cursor.s))
    ) {
      throw new InvalidActivityCursorError();
    }
    const after = cursor
      ? {
          date: new Date(`${cursor.d as string}T00:00:00.000Z`),
          sequence: BigInt(cursor.s as string),
        }
      : null;

    // The bottom of a `through` range: an event of this feed. One the viewer can no longer see (its
    // Monitor hidden or gone) ends the range at once, and the reader starts over from the top.
    let floor: { date: Date; sequence: bigint } | null = null;
    if (query.through !== undefined) {
      const bottom = await this.prisma.monitorStateTransition.findFirst({
        where: {
          ...scope,
          id: query.through,
          AND: [activityKindWhere(query.kind)],
        },
        select: { observationDate: true, sequence: true },
      });
      if (!bottom) {
        return empty;
      }
      floor = { date: bottom.observationDate!, sequence: bottom.sequence };
    }
    const limit =
      query.through === undefined ? query.limit : ACTIVITY_THROUGH_LIMIT;

    const rows = await this.prisma.monitorStateTransition.findMany({
      where: {
        ...scope,
        AND: [
          activityKindWhere(query.kind),
          ...(after
            ? [
                {
                  OR: [
                    { observationDate: { lt: after.date } },
                    {
                      observationDate: after.date,
                      sequence: { lt: after.sequence },
                    },
                  ],
                },
              ]
            : []),
          ...(floor
            ? [
                {
                  OR: [
                    { observationDate: { gt: floor.date } },
                    {
                      observationDate: floor.date,
                      sequence: { gte: floor.sequence },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: [{ observationDate: "desc" }, { sequence: "desc" }],
      take: limit + 1,
      select: ACTIVITY_EVENT_SELECT,
    });
    const page = rows.slice(0, limit);
    const events = await this.activityEvents(page, monitors);
    const last = page[page.length - 1];
    return {
      ...empty,
      events,
      ...(rows.length > limit && last
        ? {
            nextCursor: encodeCursor({
              d: last.observationDate!.toISOString().slice(0, 10),
              s: last.sequence.toString(),
            }),
          }
        : {}),
    };
  }

  /**
   * The response for each stored change, explained by the version and evidence recorded with it.
   *
   * The query already admits only changes with recorded evidence, so every Why is `EVIDENCE`. A row
   * whose evidence cannot be matched to the version that decided it would render without values,
   * which the feed never shows: it is left out of the page and logged — the page's cursor is still
   * its last stored row, so nothing after it is skipped.
   */
  private async activityEvents(
    page: readonly ActivityEventRow[],
    monitors: ReadonlyMap<string, ActivityMonitor>,
  ): Promise<DashboardActivityEventResponse[]> {
    const versionOf = (row: ActivityEventRow) =>
      row.strategyVersionId ?? row.signal?.strategyVersionId ?? null;
    const levelsByVersion = await loadStoredLevels(
      this.prisma,
      page.flatMap((row) => {
        const version = versionOf(row);
        return version ? [version] : [];
      }),
      (versionId, err) =>
        this.logger.error({
          event: "dashboard.activity.version-unreadable",
          strategyVersionId: versionId,
          err,
        }),
    );
    const scopeNames = await scopeNamesFor(
      this.prisma,
      [...levelsByVersion.values()].flatMap((levels) =>
        [...levels.values()].flatMap((level) =>
          level.rules.map((rule) => rule.signal),
        ),
      ),
    );

    return page.flatMap((row) => {
      const monitor = monitors.get(row.monitorId)!;
      const version = versionOf(row);
      const level = version
        ? levelsByVersion.get(version)?.get(row.levelId)
        : undefined;
      const sessionDate = row.observationDate!.toISOString().slice(0, 10);
      const why = level
        ? whyOf(
            level,
            parseTransitionEvidence(row.evidence),
            scopeNames,
            sessionDate,
          )
        : undefined;
      if (why?.basis !== "EVIDENCE") {
        this.logger.warn({
          event: "dashboard.activity.evidence-unmatched",
          transitionId: row.id,
          monitorId: row.monitorId,
          ...(version ? { strategyVersionId: version } : {}),
        });
        return [];
      }
      const event: DashboardActivityEventResponse = {
        id: row.id,
        kind: row.toState === "ACTIVE" ? "ACTIVATED" : "RESOLVED",
        reason: row.reason,
        sessionDate,
        security: {
          id: row.security.id,
          symbol: row.security.symbol,
          name: row.security.name,
          exchangeCode: row.security.exchangeCode,
          ...(row.security.exchangeName
            ? { exchangeName: row.security.exchangeName }
            : {}),
          ...(row.security.profile?.logoUrl
            ? { logoUrl: row.security.profile.logoUrl }
            : {}),
        },
        levelKind: row.levelKind,
        ...(level?.index === undefined ? {} : { levelIndex: level.index }),
        ...(level?.percentage === undefined
          ? {}
          : { levelPercentage: level.percentage }),
        monitor: {
          id: monitor.id,
          name: monitor.name,
          ownership: monitor.ownership,
        },
        strategy: { id: monitor.strategy.id, name: monitor.strategy.name },
        stockList: { id: monitor.stockList.id, name: monitor.stockList.name },
        ...(row.signal
          ? {
              signalId: row.signal.id,
              price: Number(row.signal.observationPrice),
            }
          : {}),
        fromHistory: row.origin === "HISTORY",
        recordedAt: row.occurredAt.toISOString(),
        why,
      };
      return [event];
    });
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
   * The names of the members of Congress the described rules select, in one read for the page.
   *
   * A rule scoped to members stores their ids, so without this a reason reads
   * `Congress buyers is above 0 (30D · 2 selected members)` where the rule plainly names two
   * people. The actor catalog is platform reference data — it is served without a session on
   * `/alternative-data/actors` — so reading a name from it reveals nothing a Guest could not
   * already see. A legacy group's name is deliberately not resolved here: a group belongs to
   * somebody, and a Dashboard row is not the place to decide who may read its name.
   */
  private async scopeNamesOf(
    levelsByMonitor: ReadonlyMap<string, ReadonlyMap<string, LevelDescription>>,
  ): Promise<StrategyScopeNames> {
    const signals: StrategySignal[] = [];
    for (const levels of levelsByMonitor.values()) {
      for (const level of levels.values()) {
        signals.push(...level.rules.map((rule) => rule.signal));
      }
    }
    return scopeNamesFor(this.prisma, signals);
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

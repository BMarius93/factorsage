import {
  normalizeStrategyDefinition,
  resolveStockSectorEtf,
  type StrategyDefinition,
  type StrategyEtfSourceCode,
} from "@intrinsic/contracts";
import {
  eodCutoffDate,
  eodSessionFinalizedAt,
  ongoingMembershipStart,
  type DateRange,
  type LocalDate,
  type Security,
  type SecurityId,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  addDays,
  monitorWindowCalendarDays,
  PriceBasisChangedError,
  withEtfOperandColumns,
  type EodFinalityPolicy,
  type FinalizedSession,
  type StockRefreshState,
} from "@intrinsic/stock-data";
import {
  collectEtfOperands,
  collectOperands,
  collectSectorOperands,
  monitorStrategyLevels,
  type EvaluationFrame,
  type MonitorStrategyLevel,
  type OperandKey,
} from "@intrinsic/strategy";
import {
  loadEtfTechnicalSnapshots,
  type EtfTechnicalSnapshots,
} from "../shared/etf-context.js";
import { mapWithConcurrency } from "../shared/concurrency.js";
import type { MonitorEtfContexts } from "./monitor-cycle.js";
import {
  signalStateKey,
  type ActiveMonitor,
  type ActiveMonitorMember,
  type LevelSessionsWrite,
  type MonitorEvaluationRepository,
  type PersistedCheckpoint,
  type PersistedSignalState,
  type TransitionOrigin,
} from "./monitor-repository.js";
import { decideLevelSessions } from "./session-decision.js";

/**
 * One Monitor EOD evaluation pass (`docs/decisions/monitor-eod-v2.md` §3).
 *
 * A Monitor evaluates **finalized end-of-day sessions**, each at most once, never a provisional
 * quote. Per pass:
 *
 * ```text
 * newest finalized session (once)
 *     -> running Monitors, their states and per-member checkpoints
 *     -> per security, once however many Monitors watch it:
 *          readiness from PostgreSQL (`stockRefreshState`): the newest bar proven final and
 *          materialized
 *          one bounded PostgreSQL frame (`readFinalizedEvaluationFrame`) + ETF columns
 *          per (Monitor, member): every session after its checkpoint, in order, through the
 *          canonical lifecycle (`decideLevelSessions`)
 *          one transaction per member: Signals, transitions, states and the checkpoint together
 *     -> removed members and levels reconciled
 * ```
 *
 * It reaches no provider: the stock EOD child made the sessions durable, and the ETF histories are
 * read through the provider-free reader. A member whose newest bar is not yet proven final waits
 * at its checkpoint — partial progress is per member, never "the Monitor is current" — and a
 * session is never stepped before every ETF its rules read holds that very session.
 */

/** What the pass needs from the data layer — provider-free reads only. */
export interface MonitorEvaluationData {
  findSecurities(securityIds: readonly SecurityId[]): Promise<Security[]>;
  stockRefreshState(security: Security): Promise<StockRefreshState>;
  readFinalizedEvaluationFrame(
    security: Security,
    range: Required<DateRange>,
    operands: readonly OperandKey[],
  ): Promise<{ frame: EvaluationFrame; priceBasisGeneration: number }>;
  /** The first session of the security's canonical history: a read from here is complete. */
  reconstructionHistoryStart(security: Security): LocalDate;
}

export type MonitorEvaluationOptions = {
  securityConcurrency: number;
  /** Closed sessions first read to reconstruct a level with no state; doubled until it rests. */
  reconstructionSessions?: number;
  /**
   * How long after a session became final a missing ETF bar is waited for. Past it the session is
   * decided with that ETF's columns absent — its rules `NOT_EVALUABLE`, never a carried value.
   */
  dependencyGiveUpMs: number;
  now?: () => Date;
};

export const DEFAULT_RECONSTRUCTION_SESSIONS = 252;

export type MonitorEvaluationSummary = {
  expectedSession: LocalDate;
  calendar: FinalizedSession["calendar"];
  monitors: number;
  securities: number;
  /** (Monitor, member) pairs evaluated: current members of the List on the expected session. */
  members: number;
  /**
   * (Monitor, member) pairs still in the List but not current members on the expected session —
   * no open-ended membership, or one that has not begun. Not evaluated; any state they had is ended
   * with `MEMBERSHIP_CHANGED`.
   */
  membersNotCurrent: number;
  /** Members whose ongoing membership changed under their state, which was ended and rebuilt. */
  membershipResets: number;
  /** Members whose checkpoint reached the expected session by the end of the pass. */
  membersCurrent: number;
  /** Members whose security has no bar proven final and materialized yet. */
  membersAwaitingData: number;
  /** Members held back because an ETF their rules read does not hold the session yet. */
  membersAwaitingEtf: number;
  /** Sessions decided, summed over members. */
  sessionsEvaluated: number;
  signalsOpened: number;
  signalsClosed: number;
  transitionsRecorded: number;
  levelsReconstructed: number;
  reconstructionHistoryExtensions: number;
  /** Member writes another evaluation applied first; persistently non-zero means overlap. */
  contended: number;
  /** Member writes discarded because the Monitor was rebound meanwhile. */
  staleConfiguration: number;
  securitiesFailed: number;
  aborted: boolean;
};

type PreparedMonitor = {
  monitor: ActiveMonitor;
  definition: StrategyDefinition;
  levels: MonitorStrategyLevel[];
  states: Map<string, PersistedSignalState>;
  checkpoints: Map<string, PersistedCheckpoint>;
  watchingSince: Date;
  etfCodes: readonly StrategyEtfSourceCode[];
  readsSector: boolean;
  /** The members evaluated this pass: current members of the List on the expected session. */
  currentMemberIds: SecurityId[];
};

type Entry = {
  prepared: PreparedMonitor;
  member: ActiveMonitorMember;
  /** The member's ongoing membership: its start, or null for "Always eligible". */
  membershipStart: LocalDate | null;
};

export class MonitorEodEvaluation {
  private readonly now: () => Date;

  constructor(
    private readonly repository: MonitorEvaluationRepository,
    private readonly data: MonitorEvaluationData,
    private readonly policy: Pick<
      EodFinalityPolicy,
      "expectedSession" | "decide" | "publicationDelayMs"
    >,
    private readonly logger: StructuredLogger,
    private readonly options: MonitorEvaluationOptions,
    /** Absent only in tests whose Monitors read no ETF; then ETF rules are NOT_EVALUABLE. */
    private readonly etfContexts?: MonitorEtfContexts,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async run(
    cycleSequence: number,
    isAborted: () => boolean = () => false,
  ): Promise<MonitorEvaluationSummary> {
    const startedAt = Date.now();
    const now = this.now();
    const expected = await this.policy.expectedSession();
    if (expected.calendar === "WEEKDAYS") {
      this.logger.warn({
        event: "monitor.evaluation.calendar-unavailable",
        cycleSequence,
        expectedSession: expected.session,
      });
    }
    const monitors = await this.repository.listActiveMonitors();
    const watching = await this.repository.markWatching(
      monitors.map((monitor) => monitor.monitorId),
      now,
    );
    const summary: MonitorEvaluationSummary = {
      expectedSession: expected.session,
      calendar: expected.calendar,
      monitors: monitors.length,
      securities: 0,
      members: 0,
      membersCurrent: 0,
      membersAwaitingData: 0,
      membersAwaitingEtf: 0,
      sessionsEvaluated: 0,
      signalsOpened: 0,
      signalsClosed: 0,
      transitionsRecorded: 0,
      levelsReconstructed: 0,
      reconstructionHistoryExtensions: 0,
      membersNotCurrent: 0,
      membershipResets: 0,
      contended: 0,
      staleConfiguration: 0,
      securitiesFailed: 0,
      aborted: false,
    };

    const prepared: PreparedMonitor[] = [];
    for (const monitor of monitors) {
      let definition: StrategyDefinition;
      try {
        definition = normalizeStrategyDefinition(monitor.definition);
      } catch (err) {
        this.logger.error({
          event: "monitor.definition.invalid",
          cycleSequence,
          monitorId: monitor.monitorId,
          actorUserId: monitor.actorUserId ?? undefined,
          err,
        });
        continue;
      }
      try {
        prepared.push({
          monitor,
          definition,
          levels: monitorStrategyLevels(definition),
          states: await this.repository.loadSignalStates(monitor.monitorId),
          checkpoints: await this.repository.loadCheckpoints(monitor.monitorId),
          watchingSince: watching.get(monitor.monitorId) ?? now,
          etfCodes: [...collectEtfOperands(definition).keys()].sort(),
          readsSector: collectSectorOperands(definition).length > 0,
          currentMemberIds: [],
        });
      } catch (err) {
        this.logger.error({
          event: "monitor.state.load-failed",
          cycleSequence,
          monitorId: monitor.monitorId,
          actorUserId: monitor.actorUserId ?? undefined,
          err,
        });
      }
    }

    // Per security, once: every (Monitor, member) watching it and the union of what they read.
    const entriesBySecurity = new Map<SecurityId, Entry[]>();
    const operandsBySecurity = new Map<SecurityId, Set<OperandKey>>();
    const etfOperandSet = new Set<OperandKey>();
    const etfCodes = new Set<StrategyEtfSourceCode>();
    for (const entry of prepared) {
      const operands = collectOperands(entry.definition);
      for (const [code, keys] of collectEtfOperands(entry.definition)) {
        etfCodes.add(code);
        keys.forEach((key) => etfOperandSet.add(key));
      }
      collectSectorOperands(entry.definition).forEach((key) =>
        etfOperandSet.add(key),
      );
      for (const member of entry.monitor.members) {
        // The Monitor universe: current members only — "Always eligible", or an open-ended period
        // that has begun by the expected session. Every level is gated alike, BUY, SELL and FINAL
        // EXIT; closed periods play no part (`docs/decisions/monitor-eod-v2.md` §4).
        const membershipStart = ongoingMembershipStart({
          mode: member.buyWindowMode,
          ranges: member.buyWindows,
        });
        if (
          membershipStart === undefined ||
          (membershipStart !== null && membershipStart > expected.session)
        ) {
          summary.membersNotCurrent += 1;
          continue;
        }
        entry.currentMemberIds.push(member.securityId);
        const entries = entriesBySecurity.get(member.securityId) ?? [];
        entries.push({ prepared: entry, member, membershipStart });
        entriesBySecurity.set(member.securityId, entries);
        const required =
          operandsBySecurity.get(member.securityId) ?? new Set<OperandKey>();
        operands.forEach((operand) => required.add(operand));
        operandsBySecurity.set(member.securityId, required);
      }
    }
    const securities = await this.data.findSecurities([
      ...entriesBySecurity.keys(),
    ]);
    summary.securities = securities.length;

    // Stock's Sector: each watched security's fund, decided once per pass from its current sector.
    const sectorCodeBySecurity = new Map<
      SecurityId,
      StrategyEtfSourceCode | null
    >();
    for (const security of securities) {
      const reads = entriesBySecurity
        .get(security.id)
        ?.some((entry) => entry.prepared.readsSector);
      if (!reads) {
        continue;
      }
      const resolution = resolveStockSectorEtf(security.sector);
      if (resolution.status === "RESOLVED") {
        sectorCodeBySecurity.set(security.id, resolution.code);
        etfCodes.add(resolution.code);
      } else {
        sectorCodeBySecurity.set(security.id, null);
      }
    }
    const etfSnapshots = await this.loadEtfSnapshots(
      etfCodes,
      now,
      cycleSequence,
    );
    const etfOperands = [...etfOperandSet].sort();

    await mapWithConcurrency(
      securities,
      this.options.securityConcurrency,
      async (security) => {
        if (isAborted()) {
          summary.aborted = true;
          return;
        }
        const entries = entriesBySecurity.get(security.id) ?? [];
        summary.members += entries.length;
        try {
          await this.evaluateSecurity({
            security,
            entries,
            operands: [...(operandsBySecurity.get(security.id) ?? [])].sort(),
            etfOperands,
            etfSnapshots,
            sectorCode: sectorCodeBySecurity.get(security.id) ?? null,
            expected,
            now,
            summary,
            cycleSequence,
          });
        } catch (err) {
          summary.securitiesFailed += 1;
          this.logger.error({
            event: "monitor.symbol.failed",
            cycleSequence,
            symbol: security.symbol,
            err,
          });
        }
      },
    );

    // Reconciliation: a member removed from the list or a level removed from the Strategy stops
    // being visited, so its occurrence is closed administratively and its progress forgotten.
    const scanned: { monitorId: string; configVersion: number }[] = [];
    for (const entry of prepared) {
      if (summary.aborted) {
        break;
      }
      const { monitor } = entry;
      const securityIds = entry.currentMemberIds;
      try {
        // A listed security that is not a current member is ended as a membership change, one that
        // left the List as a removal; both forget their progress.
        const resolved = await this.repository.resolveUnvisitedStates({
          monitorId: monitor.monitorId,
          configVersion: monitor.configVersion,
          securityIds,
          levelIds: entry.levels.map((level) => level.id),
          listedSecurityIds: monitor.members.map((member) => member.securityId),
          now,
        });
        await this.repository.pruneCheckpoints({
          monitorId: monitor.monitorId,
          configVersion: monitor.configVersion,
          securityIds,
        });
        if (resolved > 0) {
          summary.signalsClosed += resolved;
          this.logger.info({
            event: "monitor.signals.orphaned-resolved",
            cycleSequence,
            monitorId: monitor.monitorId,
            actorUserId: monitor.actorUserId ?? undefined,
            resolved,
          });
        }
      } catch (err) {
        this.logger.error({
          event: "monitor.signals.orphan-sweep.failed",
          cycleSequence,
          monitorId: monitor.monitorId,
          err,
        });
      }
      scanned.push({
        monitorId: monitor.monitorId,
        configVersion: monitor.configVersion,
      });
    }
    await this.repository.markScanned(scanned, now);

    this.logger.info({
      event: "monitor.cycle.completed",
      cycleSequence,
      durationMs: Date.now() - startedAt,
      ...summary,
    });
    return summary;
  }

  private async loadEtfSnapshots(
    codes: ReadonlySet<StrategyEtfSourceCode>,
    now: Date,
    cycleSequence: number,
  ): Promise<EtfTechnicalSnapshots> {
    if (codes.size === 0) {
      return new Map();
    }
    if (!this.etfContexts) {
      this.logger.warn({
        event: "monitor.etf-context.unconfigured",
        cycleSequence,
        codes: [...codes].sort(),
      });
      return new Map();
    }
    const series: { code: StrategyEtfSourceCode; seriesId: string }[] = [];
    for (const code of [...codes].sort()) {
      try {
        series.push({
          code,
          seriesId: await this.etfContexts.resolveSeriesId(code),
        });
      } catch (err) {
        this.logger.warn({
          event: "monitor.etf-context.resolve-failed",
          cycleSequence,
          code,
          err,
        });
      }
    }
    const { snapshots } = await loadEtfTechnicalSnapshots({
      series,
      loader: this.etfContexts.loader,
      now,
      publicationDelayMs: this.etfContexts.publicationDelayMs,
      logger: this.logger,
      logContext: { component: "monitor" },
    });
    return snapshots;
  }

  /**
   * Evaluates every (Monitor, member) watching one security, from one readiness answer and one
   * frame, and persists each member in its own transaction.
   */
  private async evaluateSecurity(input: {
    security: Security;
    entries: readonly Entry[];
    operands: readonly OperandKey[];
    etfOperands: readonly OperandKey[];
    etfSnapshots: EtfTechnicalSnapshots;
    sectorCode: StrategyEtfSourceCode | null;
    expected: FinalizedSession;
    now: Date;
    summary: MonitorEvaluationSummary;
    cycleSequence: number;
  }): Promise<void> {
    const { security, entries, expected, summary } = input;
    const state = await this.data.stockRefreshState(security);
    // The newest session this security is ready for: its bar proven final, its derived state
    // materialized, and nothing beyond the session the pass expects.
    const horizon = minDefined(
      state.latestVerifiedBar,
      state.derivedThrough,
      expected.session,
    );
    const ready =
      state.latestVerifiedBar !== undefined &&
      state.derivedThrough !== undefined &&
      horizon !== undefined;
    // The security will not print the expected session (a halt, a delisting): once storage has
    // stopped asking, the session may be passed without an observation.
    const decision = this.policy.decide(state, expected);
    const sessionWillNotPrint =
      decision.action === "SKIP" && decision.reason === "SESSION_NOT_PUBLISHED";
    if (!ready) {
      summary.membersAwaitingData += entries.length;
      return;
    }

    // Which members have sessions to decide, and from where.
    const plans = entries.map((entry) => {
      const checkpoint = entry.prepared.checkpoints.get(
        entry.member.securityId,
      );
      // A checkpoint from another binding is not progress under this one (the boundary deletes
      // them, so this is defence only): the member is decided as if it had none. The stored value
      // is still what the write must replace, or the guard would refuse it forever.
      const stored = checkpoint?.evaluatedThrough ?? null;
      // Progress recorded under a different ongoing membership — a re-entry after a gap, a moved
      // start — belongs to a membership that no longer exists: the member's state is ended
      // administratively and rebuilt from the current membership's history, in one transaction.
      const resetMembership =
        checkpoint?.membership !== undefined &&
        checkpoint.membership.start !== entry.membershipStart;
      const from =
        checkpoint &&
        !resetMembership &&
        checkpoint.configVersion === entry.prepared.monitor.configVersion
          ? checkpoint.evaluatedThrough
          : undefined;
      const { through, waitingOn } = this.entryHorizon(
        entry,
        horizon,
        input.sectorCode,
        input.etfSnapshots,
        input.now,
      );
      const needsReconstruction =
        resetMembership ||
        entry.prepared.levels.some((level) => {
          const persisted = entry.prepared.states.get(
            signalStateKey(entry.member.securityId, level.id),
          );
          return (
            !persisted || persisted.signalFingerprint !== level.fingerprint
          );
        });
      return {
        entry,
        stored,
        from,
        through,
        waitingOn,
        needsReconstruction,
        resetMembership,
      };
    });
    const work = plans.filter(
      (plan) =>
        plan.through !== undefined &&
        (plan.from === undefined || plan.from < plan.through),
    );
    for (const plan of plans) {
      if (plan.waitingOn.length > 0) {
        summary.membersAwaitingEtf += 1;
        this.logger.debug({
          event: "monitor.etf-dependency.waiting",
          cycleSequence: input.cycleSequence,
          monitorId: plan.entry.prepared.monitor.monitorId,
          symbol: security.symbol,
          codes: plan.waitingOn,
          expectedSession: expected.session,
        });
      }
    }

    // A member already through every session the security printed, whose expected session will not
    // print, is passed to the expected session without an observation.
    const passOnly = plans.filter(
      (plan) =>
        sessionWillNotPrint &&
        plan.from !== undefined &&
        plan.from >= horizon &&
        plan.from < expected.session &&
        plan.waitingOn.length === 0,
    );
    for (const plan of passOnly) {
      await this.persist(
        plan.entry,
        security,
        {
          previous: plan.stored,
          next: expected.session,
          basisGeneration: state.priceBasisGeneration,
          membershipStart: plan.entry.membershipStart,
        },
        [],
        input,
        0,
        false,
      );
    }
    summary.membersCurrent += plans.filter(
      (plan) =>
        !work.includes(plan) &&
        !passOnly.includes(plan) &&
        plan.from !== undefined &&
        plan.from >= expected.session,
    ).length;
    if (work.length === 0) {
      return;
    }

    // One frame for every member of this security: from the oldest checkpoint, or deep enough to
    // reconstruct, through the horizon. Deepened only while some level's state depends on older
    // history.
    const historyStart = this.data.reconstructionHistoryStart(security);
    const anyReconstruction = work.some((plan) => plan.needsReconstruction);
    let sessions =
      this.options.reconstructionSessions ?? DEFAULT_RECONSTRUCTION_SESSIONS;
    // Each member's first session to decide: the day after its checkpoint, or — with none — the
    // newest session it may be decided through.
    const steadyFrom = work.reduce<LocalDate>((oldest, plan) => {
      const first =
        plan.from !== undefined
          ? addDays(plan.from, 1)
          : (plan.through ?? horizon);
      return first < oldest ? first : oldest;
    }, horizon);
    for (;;) {
      const reconstructionFrom = anyReconstruction
        ? addDays(horizon, -monitorWindowCalendarDays(sessions))
        : horizon;
      let from =
        steadyFrom < reconstructionFrom ? steadyFrom : reconstructionFrom;
      const complete = from <= historyStart;
      if (complete && historyStart <= horizon) {
        from = historyStart;
      }
      let read: { frame: EvaluationFrame; priceBasisGeneration: number };
      try {
        read = await this.data.readFinalizedEvaluationFrame(
          security,
          { from, to: horizon },
          input.operands,
        );
      } catch (err) {
        if (err instanceof PriceBasisChangedError) {
          // Re-based while it was read: nothing failed, the next pass reads the replaced history.
          this.logger.warn({
            event: "monitor.evaluation.history-rebased",
            cycleSequence: input.cycleSequence,
            symbol: security.symbol,
            expectedGeneration: err.expectedGeneration,
            actualGeneration: err.actualGeneration,
          });
          return;
        }
        throw err;
      }
      const frame =
        input.etfOperands.length > 0
          ? withEtfOperandColumns(
              read.frame,
              input.etfOperands,
              input.etfSnapshots,
              input.sectorCode,
            )
          : read.frame;

      const decided = work.map((plan) =>
        this.decideEntry(
          plan,
          frame,
          complete,
          sessionWillNotPrint,
          horizon,
          expected,
        ),
      );
      if (decided.some((item) => item.needsDeeperHistory) && !complete) {
        summary.reconstructionHistoryExtensions += 1;
        sessions *= 2;
        continue;
      }
      for (const item of decided) {
        if (!item.next) {
          continue;
        }
        summary.levelsReconstructed += item.reconstructed;
        await this.persist(
          item.plan.entry,
          security,
          {
            previous: item.plan.stored,
            next: item.next,
            basisGeneration: read.priceBasisGeneration,
            membershipStart: item.plan.entry.membershipStart,
          },
          item.levels,
          input,
          item.sessions,
          item.plan.resetMembership,
        );
      }
      return;
    }
  }

  /**
   * The newest session one member may be decided through: the security's horizon, held back to the
   * newest session every ETF its rules read holds — except a session past the dependency give-up
   * bound, which is decided with that ETF's columns absent.
   */
  private entryHorizon(
    entry: Entry,
    horizon: LocalDate,
    sectorCode: StrategyEtfSourceCode | null,
    snapshots: EtfTechnicalSnapshots,
    now: Date,
  ): { through: LocalDate | undefined; waitingOn: string[] } {
    const codes = [
      ...entry.prepared.etfCodes,
      ...(entry.prepared.readsSector && sectorCode ? [sectorCode] : []),
    ];
    let through: LocalDate | undefined = horizon;
    const waitingOn: string[] = [];
    for (const code of codes) {
      const latest = snapshots.get(code)?.latestSession;
      if (latest !== undefined && latest >= horizon) {
        continue;
      }
      // Sessions after the ETF's newest are waited for until the give-up bound.
      const abandonedThrough = this.abandonedThrough(now);
      const allowed =
        latest === undefined || abandonedThrough > latest
          ? abandonedThrough
          : latest;
      through = minDefined(through, allowed);
      if (allowed < horizon) {
        waitingOn.push(code);
      }
    }
    return { through, waitingOn };
  }

  /** The newest date whose finalization is older than the dependency give-up bound. */
  private abandonedThrough(now: Date): LocalDate {
    return eodCutoffDate(
      new Date(now.getTime() - this.options.dependencyGiveUpMs),
      this.policy.publicationDelayMs,
    );
  }

  private decideEntry(
    plan: {
      entry: Entry;
      stored: LocalDate | null;
      from: LocalDate | undefined;
      through: LocalDate | undefined;
      resetMembership: boolean;
    },
    frame: EvaluationFrame,
    complete: boolean,
    sessionWillNotPrint: boolean,
    horizon: LocalDate,
    expected: FinalizedSession,
  ): {
    plan: typeof plan;
    levels: LevelSessionsWrite[];
    next: LocalDate | undefined;
    sessions: number;
    reconstructed: number;
    needsDeeperHistory: boolean;
  } {
    const { entry, from, through } = plan;
    const start = entry.membershipStart;
    // A current member on a session: its ongoing membership had begun. Sessions before it are not
    // this membership's and are never stepped.
    const monitoredOn = (date: LocalDate): boolean =>
      start === null || date >= start;
    const indices: number[] = [];
    for (
      let index = frame.periodStartIndex;
      index < frame.dates.length;
      index += 1
    ) {
      const date = frame.dates[index]!;
      if (
        (from === undefined || date > from) &&
        through !== undefined &&
        date <= through &&
        monitoredOn(date)
      ) {
        indices.push(index);
      }
    }
    // A member with no checkpoint is decided on its newest session alone: a catch-up of state it
    // already has, or a reconstruction there — never a regenerated history.
    const sessions = from === undefined ? indices.slice(-1) : indices;
    const newestIndex = sessions[sessions.length - 1];
    const lastStepped =
      newestIndex === undefined ? undefined : frame.dates[newestIndex];
    const watchingSince = entry.prepared.watchingSince.getTime();
    const originOf = (date: LocalDate): TransitionOrigin =>
      eodSessionFinalizedAt(date, this.policy.publicationDelayMs).getTime() >=
      watchingSince
        ? "OBSERVED"
        : "HISTORY";

    const levels: LevelSessionsWrite[] = [];
    let reconstructed = 0;
    let needsDeeperHistory = false;
    for (const level of entry.prepared.levels) {
      const decision = decideLevelSessions({
        level,
        member: entry.member,
        strategyVersionId: entry.prepared.monitor.strategyVersionId,
        // A membership reset ends every state in the same transaction: decide as if none existed.
        previous: plan.resetMembership
          ? null
          : (entry.prepared.states.get(
              signalStateKey(entry.member.securityId, level.id),
            ) ?? null),
        frame,
        sessions,
        historyComplete: complete,
        originOf,
        monitoredOn,
      });
      needsDeeperHistory ||= decision.needsDeeperHistory;
      reconstructed += decision.reconstructed ? 1 : 0;
      if (decision.write) {
        levels.push(decision.write);
      }
    }
    // Progress: the newest session decided — or, when that is the security's newest and its
    // expected session will not print, the expected session itself.
    const next =
      lastStepped !== undefined &&
      sessionWillNotPrint &&
      lastStepped >= horizon &&
      horizon < expected.session
        ? expected.session
        : lastStepped;
    return {
      plan,
      levels,
      next,
      sessions: sessions.length,
      reconstructed,
      needsDeeperHistory,
    };
  }

  private async persist(
    entry: Entry,
    security: Security,
    checkpoint: {
      previous: LocalDate | null;
      next: LocalDate;
      basisGeneration: number;
      membershipStart: LocalDate | null;
    },
    levels: readonly LevelSessionsWrite[],
    input: {
      now: Date;
      summary: MonitorEvaluationSummary;
      cycleSequence: number;
      expected: FinalizedSession;
    },
    sessions: number,
    resetMembership: boolean,
  ): Promise<void> {
    const { monitor } = entry.prepared;
    const result = await this.repository.applyMemberEvaluation({
      monitorId: monitor.monitorId,
      configVersion: monitor.configVersion,
      securityId: security.id,
      now: input.now,
      checkpoint,
      ...(resetMembership ? { resetMembership: true } : {}),
      levels,
    });
    const { summary } = input;
    if (!result.applied) {
      if (result.staleConfiguration) {
        summary.staleConfiguration += 1;
      } else {
        summary.contended += 1;
      }
      this.logger.debug({
        event: result.staleConfiguration
          ? "monitor.evaluation.stale-configuration"
          : "monitor.evaluation.contended",
        cycleSequence: input.cycleSequence,
        monitorId: monitor.monitorId,
        symbol: security.symbol,
      });
      return;
    }
    if (resetMembership) {
      summary.membershipResets += 1;
      this.logger.info({
        event: "monitor.member.membership-changed",
        cycleSequence: input.cycleSequence,
        monitorId: monitor.monitorId,
        actorUserId: monitor.actorUserId ?? undefined,
        symbol: security.symbol,
        membershipStart: checkpoint.membershipStart,
      });
    }
    summary.sessionsEvaluated += sessions;
    summary.signalsOpened += result.openedSignals;
    summary.signalsClosed += result.closedSignals;
    summary.transitionsRecorded += result.transitions;
    if (checkpoint.next >= input.expected.session) {
      summary.membersCurrent += 1;
    }
    if (result.openedSignals > 0) {
      this.logger.info({
        event: "monitor.signal.emitted",
        cycleSequence: input.cycleSequence,
        monitorId: monitor.monitorId,
        ownership: monitor.ownership,
        actorUserId: monitor.actorUserId ?? undefined,
        symbol: security.symbol,
        signals: result.openedSignals,
        evaluatedThrough: checkpoint.next,
      });
    }
  }
}

function minDefined(
  ...dates: readonly (LocalDate | undefined)[]
): LocalDate | undefined {
  let result: LocalDate | undefined;
  for (const date of dates) {
    if (date === undefined) {
      return undefined;
    }
    if (result === undefined || date < result) {
      result = date;
    }
  }
  return result;
}

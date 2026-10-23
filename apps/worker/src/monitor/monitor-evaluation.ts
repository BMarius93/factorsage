import {
  monitorActivityWindowStart,
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
  type ScheduledSessionCheck,
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
  type EtfContextLoader,
  type EtfTechnicalSnapshots,
} from "../shared/etf-context.js";
import { mapWithConcurrency } from "../shared/concurrency.js";
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

/**
 * The ETF histories behind ETF-sourced conditions: the provider-free benchmark reader slice, how a
 * catalog code resolves to its series, and the publication delay that decides when a session's bar
 * is final (`docs/decisions/strategy-etf-conditions-v1.md` §5).
 */
export type MonitorEtfContexts = {
  loader: EtfContextLoader;
  resolveSeriesId: (code: StrategyEtfSourceCode) => Promise<string>;
  publicationDelayMs: number;
  /** The funds' venue schedule, for the week-completion rule the backtest applies too. */
  isScheduledSession: ScheduledSessionCheck;
};

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
   * The late-recovery horizon (`EOD_LATE_RECOVERY_MS`, `docs/decisions/monitor-eod-v2.md` §10):
   * how long after a session became final a bar the security has not printed may still arrive.
   *
   * A member is never stepped past such a session while it is recoverable, so a bar published late
   * is decided in order rather than skipped behind an advanced checkpoint. A stock's session stops
   * being recoverable once a provider read issued at least this long after its finalization still
   * found no bar (`lastTailSyncAt`): then it was genuinely not printed (a halt) and is passed. An
   * ETF's missing session is waited for this long after finalization, then decided with that ETF's
   * columns absent — its rules `NOT_EVALUABLE`, never a carried value.
   */
  lateRecoveryMs: number;
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
  /**
   * Members never evaluated before whose missing activity-window sessions were evaluated this pass,
   * from the exact state before them (`docs/decisions/monitor-eod-v2.md` §12).
   */
  membersReplayed: number;
  /** Members whose checkpoint reached the expected session by the end of the pass. */
  membersCurrent: number;
  /** Members whose security has no bar proven final and materialized yet. */
  membersAwaitingData: number;
  /** Members held back because an ETF their rules read does not hold the session yet. */
  membersAwaitingEtf: number;
  /**
   * Members held before a session the security (or an ETF its rules read) has not printed while a
   * late bar may still arrive (`lateRecoveryMs`): stepping past it would skip the late bar forever.
   */
  membersAwaitingLateSession: number;
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
  /**
   * The rolling activity window's first day, when this Monitor evaluates a never-evaluated member
   * over it (`windowReplay`, `monitor-eod-v2.md` §12); null when it reconstructs such a member at
   * its newest session instead.
   */
  windowStart: LocalDate | null;
  /**
   * The newest session this Monitor has recorded any change on, per security, read only when it
   * replays windows. A replay never steps a session on or before it, so no session whose changes are
   * already recorded — under an ended membership, a previous binding — is ever recorded twice.
   */
  lastRecorded: ReadonlyMap<string, LocalDate>;
  /** Securities with any persisted state: never replayed, whatever their checkpoint says. */
  securitiesWithState: ReadonlySet<string>;
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
      "expectedSession" | "isScheduledSession" | "publicationDelayMs"
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
      membersAwaitingLateSession: 0,
      sessionsEvaluated: 0,
      signalsOpened: 0,
      signalsClosed: 0,
      transitionsRecorded: 0,
      levelsReconstructed: 0,
      reconstructionHistoryExtensions: 0,
      membersNotCurrent: 0,
      membershipResets: 0,
      membersReplayed: 0,
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
        const states = await this.repository.loadSignalStates(
          monitor.monitorId,
        );
        const windowStart = monitor.windowReplay
          ? monitorActivityWindowStart(expected.session)
          : null;
        prepared.push({
          monitor,
          definition,
          levels: monitorStrategyLevels(definition),
          states,
          checkpoints: await this.repository.loadCheckpoints(monitor.monitorId),
          watchingSince: watching.get(monitor.monitorId) ?? now,
          etfCodes: [...collectEtfOperands(definition).keys()].sort(),
          readsSector: collectSectorOperands(definition).length > 0,
          currentMemberIds: [],
          windowStart,
          lastRecorded:
            windowStart === null
              ? new Map<string, LocalDate>()
              : await this.repository.loadLastRecordedSessions(
                  monitor.monitorId,
                ),
          // Keys are `signalStateKey(securityId, levelId)`; a security id holds no space.
          securitiesWithState: new Set(
            [...states.keys()].map((key) => key.split(" ")[0]!),
          ),
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
    const { snapshots: etfSnapshots, unreadable: etfUnreadable } =
      await this.loadEtfSnapshots(etfCodes, now, cycleSequence);
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
            etfUnreadable,
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

  /**
   * The ETF snapshots this pass reads, and the codes whose snapshot could not be read.
   *
   * "Could not be read" — no configured loader, a code that would not resolve, a load that threw —
   * is kept apart from every answer the loader *did* give (a fund not bootstrapped, not yet
   * synchronized, behind), because only an answer can justify deciding a session without the fund.
   */
  private async loadEtfSnapshots(
    codes: ReadonlySet<StrategyEtfSourceCode>,
    now: Date,
    cycleSequence: number,
  ): Promise<{
    snapshots: EtfTechnicalSnapshots;
    unreadable: ReadonlySet<string>;
  }> {
    if (codes.size === 0) {
      return { snapshots: new Map(), unreadable: new Set() };
    }
    if (!this.etfContexts) {
      this.logger.warn({
        event: "monitor.etf-context.unconfigured",
        cycleSequence,
        codes: [...codes].sort(),
      });
      return { snapshots: new Map(), unreadable: new Set(codes) };
    }
    const unreadable = new Set<string>();
    const series: { code: StrategyEtfSourceCode; seriesId: string }[] = [];
    for (const code of [...codes].sort()) {
      try {
        series.push({
          code,
          seriesId: await this.etfContexts.resolveSeriesId(code),
        });
      } catch (err) {
        unreadable.add(code);
        this.logger.warn({
          event: "monitor.etf-context.resolve-failed",
          cycleSequence,
          code,
          err,
        });
      }
    }
    const { snapshots, diagnostics } = await loadEtfTechnicalSnapshots({
      series,
      loader: this.etfContexts.loader,
      now,
      publicationDelayMs: this.etfContexts.publicationDelayMs,
      isScheduledSession: this.etfContexts.isScheduledSession,
      logger: this.logger,
      logContext: { component: "monitor" },
    });
    for (const diagnostic of diagnostics) {
      if (diagnostic.status === "LOAD_FAILED") {
        unreadable.add(diagnostic.code);
      }
    }
    if (unreadable.size > 0) {
      this.logger.warn({
        event: "monitor.etf-context.unreadable",
        cycleSequence,
        codes: [...unreadable].sort(),
      });
    }
    return { snapshots, unreadable };
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
    /** ETFs whose snapshot could not be read this pass — never the same as an ETF that is behind. */
    etfUnreadable: ReadonlySet<string>;
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
    if (!ready) {
      summary.membersAwaitingData += entries.length;
      return;
    }
    // Sessions on or before this are no longer recoverable: a provider read issued at least the
    // late-recovery horizon after their finalization has already happened, so a bar the security
    // still has not printed for one of them was genuinely not printed. Anything later may yet
    // arrive, and is never stepped past.
    const confirmedThrough = this.confirmedThrough(state, input.now);
    // A member through every session the security printed may be passed, without an observation,
    // through the sessions it confirmably did not print — never into one that may still arrive. It
    // is passed to the newest such *session*, so its checkpoint always names a session.
    const passThrough =
      (state.latestBar === undefined || state.latestBar <= horizon) &&
      confirmedThrough > horizon
        ? await this.newestSessionAfter(
            security,
            horizon,
            minDefined(confirmedThrough, expected.session)!,
          )
        : undefined;

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
        input.etfUnreadable,
        input.now,
      );
      const persistedOf = (levelId: string) =>
        entry.prepared.states.get(
          signalStateKey(entry.member.securityId, levelId),
        );
      const needsReconstruction =
        resetMembership ||
        entry.prepared.levels.some((level) => {
          const persisted = persistedOf(level.id);
          return (
            !persisted || persisted.signalFingerprint !== level.fingerprint
          );
        });
      // A level whose logic was edited since its state was written is re-decided at once, even with
      // no new session: an edit takes effect on the next pass, not the next close.
      const logicChanged = entry.prepared.levels.some((level) => {
        const persisted = persistedOf(level.id);
        return (
          persisted !== undefined &&
          persisted.signalFingerprint !== level.fingerprint
        );
      });
      // A member with no progress and no state under this configuration is evaluated over the
      // rolling activity window (§12): its missing sessions, in order, from the exact state before
      // the first. The first is the window's, the membership's when that began later, and never a
      // session on or before the newest one this Monitor already recorded a change on for the
      // security — a membership that ended and was restored, a previous binding — so a recorded
      // change is never recorded twice (MON-01). With nothing left to step, the member is
      // reconstructed at its newest session instead.
      const windowStart = entry.prepared.windowStart;
      const fresh =
        from === undefined &&
        (resetMembership ||
          !entry.prepared.securitiesWithState.has(entry.member.securityId));
      const recorded = entry.prepared.lastRecorded.get(entry.member.securityId);
      const replayFrom =
        windowStart !== null && fresh
          ? latestOf(
              windowStart,
              entry.membershipStart ?? windowStart,
              recorded === undefined ? windowStart : addDays(recorded, 1),
            )
          : undefined;
      return {
        entry,
        stored,
        from,
        through,
        waitingOn,
        needsReconstruction: needsReconstruction || replayFrom !== undefined,
        resetMembership,
        replayFrom,
        logicChanged,
      };
    });
    const work = plans.filter(
      (plan) =>
        plan.through !== undefined &&
        (plan.from === undefined ||
          plan.from < plan.through ||
          plan.logicChanged),
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

    // A member already through every session the security printed is passed through the sessions
    // the security confirmably did not print (a halt, a delisting), without an observation.
    const passOnly = plans.filter(
      (plan) =>
        passThrough !== undefined &&
        plan.from !== undefined &&
        plan.from >= horizon &&
        plan.from < passThrough &&
        plan.waitingOn.length === 0,
    );
    for (const plan of passOnly) {
      await this.persist(
        plan.entry,
        security,
        {
          previous: plan.stored,
          next: passThrough!,
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
        plan.replayFrom ??
        (plan.from !== undefined
          ? addDays(plan.from, 1)
          : (plan.through ?? horizon));
      return first < oldest ? first : oldest;
    }, horizon);
    // Where a reconstruction is anchored: a replay's state is established before its window, any
    // other at the newest session it is decided through.
    const reconstructionBase = work.reduce<LocalDate>((oldest, plan) => {
      if (!plan.needsReconstruction) {
        return oldest;
      }
      const anchor = plan.replayFrom ?? plan.through ?? horizon;
      return anchor < oldest ? anchor : oldest;
    }, horizon);
    for (;;) {
      const reconstructionFrom = anyReconstruction
        ? addDays(reconstructionBase, -monitorWindowCalendarDays(sessions))
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

      // A session the security, or an ETF a member's rules read, has not printed while a late bar
      // may still arrive holds each member before it: stepping past would skip that bar forever.
      const stockGaps = await this.recoverableGaps(
        security,
        frame,
        { from, confirmedThrough },
        horizon,
      );
      const holds = work.map((plan) =>
        this.holdAtRecoverableGap(
          plan,
          frame,
          stockGaps,
          input.etfSnapshots,
          input.sectorCode,
          input.now,
        ),
      );
      const decided = work.map((plan, index) => {
        const held = holds[index]!;
        return this.decideEntry(
          { ...plan, through: held.through },
          frame,
          complete,
          held.held ? undefined : passThrough,
          horizon,
        );
      });
      if (decided.some((item) => item.needsDeeperHistory) && !complete) {
        summary.reconstructionHistoryExtensions += 1;
        sessions *= 2;
        continue;
      }
      // Counted once the read is final, never once per deepening read.
      work.forEach((plan, index) => {
        const held = holds[index]!;
        if (held.held) {
          summary.membersAwaitingLateSession += 1;
          this.logger.debug({
            event: "monitor.late-session.waiting",
            cycleSequence: input.cycleSequence,
            monitorId: plan.entry.prepared.monitor.monitorId,
            symbol: security.symbol,
            session: held.gap,
            source: held.source,
          });
        }
      });
      for (const item of decided) {
        if (!item.next) {
          continue;
        }
        summary.levelsReconstructed += item.reconstructed;
        summary.membersReplayed += item.replayed ? 1 : 0;
        await this.persist(
          item.plan.entry,
          security,
          {
            previous: item.plan.stored,
            next: item.next,
            basisGeneration: read.priceBasisGeneration,
            membershipStart: item.plan.entry.membershipStart,
            ...(item.coverageStart === undefined
              ? {}
              : { coverageStart: item.coverageStart }),
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
    unreadable: ReadonlySet<string>,
    now: Date,
  ): { through: LocalDate | undefined; waitingOn: string[] } {
    const codes = [
      ...entry.prepared.etfCodes,
      ...(entry.prepared.readsSector && sectorCode ? [sectorCode] : []),
    ];
    // An ETF whose snapshot could not be read this pass says nothing about whether the fund
    // printed: a Redis blip, a timeout, a series that would not resolve. Deciding a session without
    // it would record every rule that reads it as NOT_EVALUABLE, permanently — no later pass decides
    // that session again (MON-02). The member is held where it is, with no give-up bound, until a
    // pass reads the fund; only a fund that was read and is behind waits the bounded way below.
    const unread = codes.filter((code) => unreadable.has(code));
    if (unread.length > 0) {
      return { through: undefined, waitingOn: unread };
    }
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

  /** The newest date whose finalization is older than the late-recovery horizon. */
  private abandonedThrough(now: Date): LocalDate {
    return eodCutoffDate(
      new Date(now.getTime() - this.options.lateRecoveryMs),
      this.policy.publicationDelayMs,
    );
  }

  /**
   * The newest session whose missing bar is confirmed absent: one a provider read issued at least
   * the late-recovery horizon after its finalization still did not return. Evidence, not the clock:
   * while the stock EOD child is not reading, nothing is confirmed, and a late bar it later finds
   * is still decided in order. A security never read at all falls back to the clock alone.
   */
  private confirmedThrough(state: StockRefreshState, now: Date): LocalDate {
    const readAt =
      state.lastTailSyncAt === undefined
        ? undefined
        : Date.parse(state.lastTailSyncAt);
    const evidence =
      readAt === undefined || !Number.isFinite(readAt) ? now.getTime() : readAt;
    return eodCutoffDate(
      new Date(evidence - this.options.lateRecoveryMs),
      this.policy.publicationDelayMs,
    );
  }

  /**
   * The newest scheduled session in `(after, through]`, or `undefined` when there is none. A day
   * the schedule cannot answer for is not passed to: passing is the one move that must be sure.
   */
  private async newestSessionAfter(
    security: Security,
    after: LocalDate,
    through: LocalDate,
  ): Promise<LocalDate | undefined> {
    for (let date = through; date > after; date = addDays(date, -1)) {
      if (
        (await this.policy.isScheduledSession(security.exchangeCode, date)) ===
        true
      ) {
        return date;
      }
    }
    return undefined;
  }

  /**
   * The scheduled sessions after `confirmedThrough`, up to `horizon`, that the frame holds no bar
   * for: each may still be printed late. A day the venue schedule cannot answer for is taken to be
   * a session — holding a member is recoverable, skipping a late bar is not. Only dates the frame
   * was read for are asked about (`range.from` on): it starts at the day after the oldest member's
   * checkpoint, or deeper.
   */
  private async recoverableGaps(
    security: Security,
    frame: EvaluationFrame,
    range: { from: LocalDate; confirmedThrough: LocalDate },
    horizon: LocalDate,
  ): Promise<LocalDate[]> {
    const printed = new Set(frame.dates);
    const gaps: LocalDate[] = [];
    for (
      let date =
        range.confirmedThrough >= range.from
          ? addDays(range.confirmedThrough, 1)
          : range.from;
      date <= horizon;
      date = addDays(date, 1)
    ) {
      if (printed.has(date)) {
        continue;
      }
      const scheduled = await this.policy.isScheduledSession(
        security.exchangeCode,
        date,
      );
      if (scheduled !== false) {
        gaps.push(date);
      }
    }
    return gaps;
  }

  /**
   * Where one member is held: before the first recoverable gap after its checkpoint — the
   * security's own, or a session an ETF its rules read has not printed although the stock did,
   * while that ETF's bar may still arrive.
   */
  private holdAtRecoverableGap(
    plan: {
      entry: Entry;
      from: LocalDate | undefined;
      through: LocalDate | undefined;
    },
    frame: EvaluationFrame,
    stockGaps: readonly LocalDate[],
    snapshots: EtfTechnicalSnapshots,
    sectorCode: StrategyEtfSourceCode | null,
    now: Date,
  ):
    | { held: false; through: LocalDate | undefined }
    | {
        held: true;
        through: LocalDate | undefined;
        gap: LocalDate;
        source: "STOCK" | StrategyEtfSourceCode;
      } {
    const { entry, from, through } = plan;
    if (through === undefined) {
      return { held: false, through };
    }
    const after = (date: LocalDate) => from === undefined || date > from;
    let gap:
      { date: LocalDate; source: "STOCK" | StrategyEtfSourceCode } | undefined;
    const stockGap = stockGaps.find((date) => after(date) && date <= through);
    if (stockGap !== undefined) {
      gap = { date: stockGap, source: "STOCK" };
    }
    const codes = [
      ...entry.prepared.etfCodes,
      ...(entry.prepared.readsSector && sectorCode ? [sectorCode] : []),
    ];
    const abandoned = this.abandonedThrough(now);
    for (const code of codes) {
      const snapshot = snapshots.get(code);
      const listed = snapshot?.dates[0];
      if (!snapshot || listed === undefined) {
        continue;
      }
      for (const date of frame.dates) {
        if (
          after(date) &&
          date <= through &&
          date > listed &&
          date > abandoned &&
          !snapshot.index.has(date) &&
          (gap === undefined || date < gap.date)
        ) {
          gap = { date, source: code };
          break;
        }
      }
    }
    if (gap === undefined) {
      return { held: false, through };
    }
    // The newest printed session before the gap; with none after the checkpoint, nothing moves.
    let heldThrough: LocalDate | undefined;
    for (const date of frame.dates) {
      if (date >= gap.date) {
        break;
      }
      heldThrough = date;
    }
    return {
      held: true,
      through:
        heldThrough !== undefined && after(heldThrough) ? heldThrough : from,
      gap: gap.date,
      source: gap.source,
    };
  }

  private decideEntry(
    plan: {
      entry: Entry;
      stored: LocalDate | null;
      from: LocalDate | undefined;
      through: LocalDate | undefined;
      resetMembership: boolean;
      replayFrom: LocalDate | undefined;
      logicChanged: boolean;
    },
    frame: EvaluationFrame,
    complete: boolean,
    /** Through where the security confirmably printed nothing more, when a member may pass to it. */
    passThrough: LocalDate | undefined,
    /** The newest session the security printed and is ready for. */
    horizon: LocalDate,
  ): {
    plan: typeof plan;
    levels: LevelSessionsWrite[];
    next: LocalDate | undefined;
    /** Where the member's recorded evaluation now begins, when this write starts it afresh. */
    coverageStart: LocalDate | undefined;
    sessions: number;
    reconstructed: number;
    needsDeeperHistory: boolean;
    replayed: boolean;
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
    // A replay decides every window session it has; with none (a security whose newest bar is
    // older than the window) it falls back to the newest-session reconstruction.
    const window =
      plan.replayFrom === undefined
        ? []
        : indices.filter((index) => frame.dates[index]! >= plan.replayFrom!);
    const replay = window.length > 0;
    // Already evaluated through its newest session, with a level whose logic changed: that level
    // alone is reset and reconstructed at the newest session; the rest are left exactly as they are.
    const redecideEdited =
      from !== undefined && indices.length === 0 && plan.logicChanged;
    const newestDecided = redecideEdited ? frame.dates.lastIndexOf(from) : -1;
    const sessions = replay
      ? window
      : redecideEdited
        ? newestDecided >= frame.periodStartIndex
          ? [newestDecided]
          : []
        : from === undefined
          ? indices.slice(-1)
          : indices;
    const newestIndex = sessions[sessions.length - 1];
    const lastStepped =
      newestIndex === undefined ? undefined : frame.dates[newestIndex];
    // Observed only when the Monitor was watching this member as the session became final: watched
    // since `watchingSince`, and the security in its List by then. A session finalized before
    // either — a paused Monitor's gap, a member added later — is history, found afterwards.
    const watchedFrom = Math.max(
      entry.prepared.watchingSince.getTime(),
      entry.member.listedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    );
    const originOf = (date: LocalDate): TransitionOrigin =>
      eodSessionFinalizedAt(date, this.policy.publicationDelayMs).getTime() >=
      watchedFrom
        ? "OBSERVED"
        : "HISTORY";

    const levels: LevelSessionsWrite[] = [];
    let reconstructed = 0;
    let needsDeeperHistory = false;
    for (const level of entry.prepared.levels) {
      const persisted = entry.prepared.states.get(
        signalStateKey(entry.member.securityId, level.id),
      );
      if (
        redecideEdited &&
        persisted !== undefined &&
        persisted.signalFingerprint === level.fingerprint
      ) {
        // Its session was decided already under this very logic: never decided twice.
        continue;
      }
      const decision = decideLevelSessions({
        level,
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
        replay,
      });
      needsDeeperHistory ||= decision.needsDeeperHistory;
      reconstructed += decision.reconstructed ? 1 : 0;
      if (decision.write) {
        levels.push(decision.write);
      }
    }
    // Progress: the newest session decided — or, when that is the security's newest printed one,
    // through the sessions after it the security confirmably did not print.
    const next =
      lastStepped !== undefined &&
      passThrough !== undefined &&
      lastStepped >= horizon &&
      lastStepped < passThrough
        ? passThrough
        : lastStepped;
    return {
      plan,
      levels,
      next,
      // A member caught up from its own checkpoint keeps the coverage it had. One decided afresh
      // is recorded from its window replay's start, or — reconstructed at its newest session — from
      // that session alone: the sessions before it were never recorded one by one.
      coverageStart:
        from !== undefined
          ? undefined
          : replay
            ? plan.replayFrom
            : lastStepped,
      sessions: sessions.length,
      reconstructed,
      needsDeeperHistory,
      replayed: replay,
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
      coverageStart?: LocalDate;
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

function latestOf(...dates: readonly LocalDate[]): LocalDate {
  return dates.reduce((latest, date) => (date > latest ? date : latest));
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

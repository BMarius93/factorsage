import {
  normalizeStrategyDefinition,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import {
  tradingSessionDate,
  type LocalDate,
  type Security,
  type SecurityId,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import {
  addDays,
  monitorWindowCalendarDays,
  type CurrentObservation,
  type MonitorEvaluationFrame,
  type TradingCalendar,
} from "@intrinsic/stock-data";
import {
  collectOperands,
  monitorStrategyLevels,
  type EvaluationFrame,
  type MonitorStrategyLevel,
  type OperandKey,
} from "@intrinsic/strategy";
import { mapWithConcurrency } from "../shared/concurrency.js";
import { decideLevel } from "./level-decision.js";
import {
  signalStateKey,
  type ActiveMonitor,
  type MonitorRepository,
  type PersistedSignalState,
} from "./monitor-repository.js";

/**
 * One Monitor evaluation cycle.
 *
 * The shape is the one `ai/architecture/monitor-engine.md` fixes, and the ordering is the whole
 * point of it:
 *
 * ```text
 * active Monitors
 *     -> resolve monitored symbols
 *     -> aggregate required series per symbol
 *     -> load/update each symbol once for the evaluation cycle
 *     -> compute each required series once for that symbol
 *     -> evaluate every relevant Monitor using the shared snapshot
 *     -> persist Signal/state transitions
 * ```
 *
 * Data work is organized **per symbol** and evaluation **per Monitor**. Ten Monitors watching NVDA
 * cost one hydration, one projection read, one series computation and one current-quote slot
 * between them — never ten of each.
 */

/** What the cycle needs from the data layer. Narrow on purpose, so a test can supply it. */
export interface MonitorDataLoader {
  findSecurities(securityIds: readonly SecurityId[]): Promise<Security[]>;
  getCurrentObservations(
    securities: readonly Security[],
  ): Promise<Map<SecurityId, CurrentObservation>>;
  prepareMonitorEvaluationData(
    security: Security,
    observations: number,
    asOf: LocalDate,
  ): Promise<void>;
  readMonitorEvaluationFrame(input: {
    security: Security;
    operands: readonly OperandKey[];
    observations: number;
    asOf: LocalDate;
    observation: CurrentObservation | null;
    observationDate: LocalDate;
  }): Promise<MonitorEvaluationFrame | null>;
  /** Trading observations the required operands need behind the current one. */
  monitorWindowObservations(operands: readonly OperandKey[]): number;
  /**
   * Prepares closed history for historical reconstruction — the canonical backtest path, so the
   * replay reads the same materialized series a backtest would.
   */
  prepareReconstructionData(
    security: Security,
    range: { from: LocalDate; to: LocalDate },
  ): Promise<void>;
  readReconstructionFrame(
    security: Security,
    range: { from: LocalDate; to: LocalDate },
    operands: readonly OperandKey[],
  ): Promise<EvaluationFrame>;
}

export type MonitorCycleOptions = {
  symbolConcurrency: number;
  /** How stale a provider quote may be and still act as the provisional observation. */
  quoteMaxAgeMs: number;
  /**
   * Closed exchange sessions replayed to reconstruct a level that has no current state — a new
   * Monitor, a new member, a rebind or an edited level. Defaults to about one year.
   */
  reconstructionSessions?: number;
  now?: () => Date;
};

export const DEFAULT_RECONSTRUCTION_SESSIONS = 252;

export type MonitorCycleSummary = {
  monitors: number;
  symbols: number;
  evaluations: number;
  signalsEmitted: number;
  signalsResolved: number;
  /** Lifecycle state changes recorded, pending setups included. */
  transitionsRecorded: number;
  /** Levels whose state was established by historical reconstruction this cycle. */
  levelsReconstructed: number;
  notEvaluable: number;
  /** Symbols with no usable current quote. Every Monitor watching one is NOT_EVALUABLE. */
  symbolsWithoutCurrentData: number;
  /** Symbols whose quote named a day the exchange did not hold a session on. */
  symbolsOutsideTradingSession: number;
  /**
   * Symbols the cycle could build no evaluable snapshot for — no persisted history, or a price the
   * provider could not give. Every predicate is NOT_EVALUABLE. A day the venue did not open is
   * counted separately, in `symbolsOutsideTradingSession`.
   */
  symbolsWithoutSnapshot: number;
  /** Transitions a concurrent cycle applied first. Persistently non-zero means overlapping cycles. */
  transitionsContended: number;
  /**
   * Transitions discarded because the user rebound the Monitor to a different Strategy or Stock
   * List while this cycle was evaluating the configuration it replaced. Not an error: the
   * evaluation described a configuration the Monitor no longer has.
   */
  transitionsStaleConfiguration: number;
  /** Evaluations that repeated the recorded outcome and needed no write at all. */
  transitionsUnchanged: number;
  /** True when the cycle stopped early: the lease was lost, or the process is shutting down. */
  aborted: boolean;
};

/** Whether the cycle in flight should stop at its next Monitor boundary. */
export type AbortSignalCheck = () => boolean;

/** One prepared per-symbol snapshot, shared by every Monitor that references the symbol. */
export type SymbolSnapshot = {
  security: Security;
  frame: MonitorEvaluationFrame | null;
  /**
   * Closed history before the observation, for reconstruction. `undefined` when no level of this
   * security needed reconstructing; `null` when it was needed and could not be read — those
   * levels then wait for a later cycle rather than starting as if nothing had happened before.
   */
  history?: EvaluationFrame | null;
};

/** One Monitor, parsed, with the levels it evaluates and its durable state. */
type PreparedMonitor = {
  monitor: ActiveMonitor;
  definition: StrategyDefinition;
  levels: MonitorStrategyLevel[];
  states: Map<string, PersistedSignalState>;
};

export class MonitorCycle {
  private readonly now: () => Date;

  constructor(
    private readonly repository: MonitorRepository,
    private readonly data: MonitorDataLoader,
    private readonly calendar: TradingCalendar,
    private readonly logger: StructuredLogger,
    private readonly options: MonitorCycleOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async run(
    cycleSequence: number,
    isAborted: AbortSignalCheck = () => false,
  ): Promise<MonitorCycleSummary> {
    const startedAt = Date.now();
    const monitors = await this.repository.listActiveMonitors();
    const summary: MonitorCycleSummary = {
      monitors: monitors.length,
      symbols: 0,
      evaluations: 0,
      signalsEmitted: 0,
      signalsResolved: 0,
      transitionsRecorded: 0,
      levelsReconstructed: 0,
      notEvaluable: 0,
      symbolsWithoutCurrentData: 0,
      symbolsOutsideTradingSession: 0,
      symbolsWithoutSnapshot: 0,
      transitionsContended: 0,
      transitionsStaleConfiguration: 0,
      transitionsUnchanged: 0,
      aborted: false,
    };

    if (monitors.length === 0) {
      this.logger.debug({ event: "monitor.cycle.empty", cycleSequence });
      return summary;
    }

    // A Monitor whose persisted definition no longer normalizes is skipped, not guessed at.
    const parsed = monitors.flatMap((monitor) => {
      try {
        return [{ monitor, definition: normalizeStrategyDefinition(monitor.definition) }];
      } catch (err) {
        this.logger.error({
          event: "monitor.definition.invalid",
          cycleSequence,
          monitorId: monitor.monitorId,
          actorUserId: monitor.actorUserId ?? undefined,
          err,
        });
        return [];
      }
    });

    // Durable state first: which levels have none (or state under logic that no longer exists)
    // decides which securities need closed history for reconstruction.
    const prepared: PreparedMonitor[] = [];
    for (const { monitor, definition } of parsed) {
      try {
        prepared.push({
          monitor,
          definition,
          levels: monitorStrategyLevels(definition),
          states: await this.repository.loadSignalStates(monitor.monitorId),
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
    const needsReconstruction = new Set<SecurityId>();
    for (const { monitor, levels, states } of prepared) {
      for (const member of monitor.members) {
        for (const level of levels) {
          const state = states.get(signalStateKey(member.securityId, level.id));
          if (!state || state.signalFingerprint !== level.fingerprint) {
            needsReconstruction.add(member.securityId);
          }
        }
      }
    }

    // Required-series aggregation: the union of the operands every Monitor references, per symbol.
    // This is what decides both which frame columns exist and how much history is loaded, so a
    // symbol is never asked for a series no active Monitor names.
    const operandsBySecurity = new Map<SecurityId, Set<OperandKey>>();
    for (const { monitor, definition } of prepared) {
      const operands = collectOperands(definition);
      for (const member of monitor.members) {
        let required = operandsBySecurity.get(member.securityId);
        if (!required) {
          required = new Set<OperandKey>();
          operandsBySecurity.set(member.securityId, required);
        }
        for (const operand of operands) {
          required.add(operand);
        }
      }
    }

    const securityIds = [...operandsBySecurity.keys()];
    summary.symbols = securityIds.length;
    // Deliberately no early return when the universe is empty. Every call below is a no-op on an
    // empty list — including the current-data read, which makes no provider request — and the
    // per-Monitor pass still has to run: a Monitor whose list was emptied has states to reconcile,
    // and returning here would leave its Signals active against securities nobody watches.
    const securities = await this.data.findSecurities(securityIds);
    const now = this.now();
    // The cycle's own exchange session, resolved the same way every observation date is. It only
    // bounds the history read behind the observation, and durable history can never run past the
    // current session — but deriving it from the UTC day would name tomorrow for part of every
    // evening, which is exactly the trap `tradingSessionDate` exists to close.
    const asOf = tradingSessionDate(now);

    // One current-data request for the whole cycle, and it is all-or-nothing: a failure fails the
    // cycle rather than being absorbed into it. `ai/product/monitors.md` makes partial cycles a
    // non-concept for V1, and absorbing the failure would be worse than it looks — it would record
    // a successful scan, mark every Monitor scanned, reset the schedule's failure counter and wait
    // a full interval, having evaluated nothing. Failing hands the cycle to the worker's retry
    // path with the backoff and failure history that exist for exactly this. Nothing has been
    // persisted at this point, so every durable latch is untouched.
    let observations: Map<SecurityId, CurrentObservation>;
    try {
      observations = await this.data.getCurrentObservations(securities);
    } catch (err) {
      this.logger.error({
        event: "monitor.current-data.failed",
        cycleSequence,
        symbols: securities.length,
        err,
      });
      // Rethrown unchanged: the provider's own error is the diagnosis, and replacing it would
      // discard the classification the FMP layer already made.
      throw err;
    }

    // Which quote belongs to which session, decided before any symbol work so the calendar is
    // resolved once for the cycle rather than once per symbol.
    const resolvedObservations = new Map<
      SecurityId,
      { observation: CurrentObservation; date: LocalDate }
    >();
    for (const security of securities) {
      const resolved = this.resolveObservation(
        observations.get(security.id),
        now,
      );
      if (resolved) {
        resolvedObservations.set(security.id, resolved);
      }
    }

    // One calendar answer per (exchange, session) for the whole cycle. A cycle over a thousand
    // symbols on three venues asks at most three times, and a failure here fails the cycle for the
    // same reason a failed quote read does: the alternative is assuming the exchange was open.
    const sessions = await this.resolveTradingSessions(
      securities,
      resolvedObservations,
      cycleSequence,
    );

    const snapshots = new Map<SecurityId, SymbolSnapshot>();
    await mapWithConcurrency(
      securities,
      this.options.symbolConcurrency,
      async (security) => {
        const operands = [
          ...(operandsBySecurity.get(security.id) ?? new Set<OperandKey>()),
        ].sort();
        const resolved = resolvedObservations.get(security.id);
        if (resolved && !sessions.get(sessionKey(security.exchangeCode, resolved.date))) {
          // The venue held no session that day, so there is no observation to evaluate — and
          // nothing that may append a bar, shift a rolling window or end a Trigger's session.
          summary.symbolsOutsideTradingSession += 1;
          this.logger.debug({
            event: "monitor.symbol.outside-session",
            cycleSequence,
            symbol: security.symbol,
            exchangeCode: security.exchangeCode,
            observationDate: resolved.date,
          });
          snapshots.set(security.id, { security, frame: null });
          return;
        }
        if (!resolved) {
          // No current observation means the evaluation a Monitor is defined to make cannot be
          // made. It is reported as NOT_EVALUABLE rather than decided from closed history, so an
          // outage leaves every durable latch exactly as it was.
          summary.symbolsWithoutCurrentData += 1;
          snapshots.set(security.id, { security, frame: null });
          return;
        }
        const snapshot = await this.loadSymbolSnapshot({
          security,
          operands,
          observation: resolved.observation,
          observationDate: resolved.date,
          asOf,
          cycleSequence,
        });
        if (snapshot.frame && needsReconstruction.has(security.id)) {
          snapshot.history = await this.loadHistory({
            security,
            operands,
            observationDate: snapshot.frame.observationDate,
            cycleSequence,
          });
        }
        snapshots.set(security.id, snapshot);
        if (!snapshot.frame) {
          summary.symbolsWithoutSnapshot += 1;
        }
      },
    );

    const scanned: { monitorId: string; configVersion: number }[] = [];
    for (const entry of prepared) {
      const { monitor } = entry;
      if (isAborted()) {
        // Stopping between Monitors is safe: every transition is decided from durable state and
        // persisted history, so the next cycle re-evaluates whatever this one did not reach and
        // reaches the same conclusions.
        summary.aborted = true;
        break;
      }
      await this.evaluateMonitor({
        prepared: entry,
        snapshots,
        now,
        summary,
        cycleSequence,
      });
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
   * Prepares one symbol once for the whole cycle.
   *
   * A load failure for one symbol is contained: its snapshot is absent, every Monitor watching it
   * reports NOT_EVALUABLE for that symbol, and the rest of the cycle continues. A cycle that died
   * on one unreachable security would stop monitoring everything else.
   */
  private async loadSymbolSnapshot(input: {
    security: Security;
    operands: readonly OperandKey[];
    observation: CurrentObservation;
    observationDate: LocalDate;
    asOf: LocalDate;
    cycleSequence: number;
  }): Promise<SymbolSnapshot> {
    const { security, operands, observation, asOf } = input;
    const windowObservations = this.data.monitorWindowObservations(operands);
    try {
      await this.data.prepareMonitorEvaluationData(
        security,
        windowObservations,
        asOf,
      );
      const frame = await this.data.readMonitorEvaluationFrame({
        security,
        operands,
        observations: windowObservations,
        asOf,
        observation,
        observationDate: input.observationDate,
      });
      this.logger.debug({
        event: "monitor.symbol.prepared",
        cycleSequence: input.cycleSequence,
        symbol: security.symbol,
        operands: operands.length,
        windowObservations,
        observationDate: frame?.observationDate ?? null,
      });
      return { security, frame };
    } catch (err) {
      this.logger.error({
        event: "monitor.symbol.failed",
        cycleSequence: input.cycleSequence,
        symbol: security.symbol,
        err,
      });
      return { security, frame: null };
    }
  }

  /**
   * Reads the closed history a reconstruction replays: the sessions strictly before the observation,
   * through the canonical backtest frame.
   *
   * A failure is contained to this security and reported as `null`, so its unreconstructed levels
   * wait for a later cycle instead of starting from a history that was never read.
   */
  private async loadHistory(input: {
    security: Security;
    operands: readonly OperandKey[];
    observationDate: LocalDate;
    cycleSequence: number;
  }): Promise<EvaluationFrame | null> {
    const sessions =
      this.options.reconstructionSessions ?? DEFAULT_RECONSTRUCTION_SESSIONS;
    const range = {
      from: addDays(input.observationDate, -monitorWindowCalendarDays(sessions)),
      to: addDays(input.observationDate, -1),
    };
    try {
      await this.data.prepareReconstructionData(input.security, range);
      return await this.data.readReconstructionFrame(
        input.security,
        range,
        input.operands,
      );
    } catch (err) {
      this.logger.error({
        event: "monitor.reconstruction.history-failed",
        cycleSequence: input.cycleSequence,
        symbol: input.security.symbol,
        err,
      });
      return null;
    }
  }

  /**
   * Evaluates one Monitor against the shared snapshots and persists every decided change.
   *
   * The snapshots are already built, so this does no data work: it reads one index of a frame per
   * level per security through the canonical evaluator, folds it through the lifecycle reducer and
   * hands the repository a fully decided write.
   */
  private async evaluateMonitor(input: {
    prepared: PreparedMonitor;
    snapshots: Map<SecurityId, SymbolSnapshot>;
    now: Date;
    summary: MonitorCycleSummary;
    cycleSequence: number;
  }): Promise<void> {
    const { prepared, snapshots, now, summary } = input;
    const { monitor, levels, states } = prepared;
    const actorUserId = monitor.actorUserId ?? undefined;

    for (const member of monitor.members) {
      const snapshot = snapshots.get(member.securityId);
      for (const level of levels) {
        const previous =
          states.get(signalStateKey(member.securityId, level.id)) ?? null;
        const decision = decideLevel({
          monitor,
          member,
          level,
          previous,
          snapshot,
          now,
        });
        summary.evaluations += 1;
        if (decision.outcome === "NOT_EVALUABLE") {
          summary.notEvaluable += 1;
        }
        if (!decision.write) {
          summary.transitionsUnchanged += 1;
          continue;
        }

        try {
          const applied = await this.repository.applyLevelState(decision.write);
          if (!applied.applied) {
            // Nothing was written. Either a concurrent cycle moved this state first, or the
            // Monitor was rebound and this evaluation belongs to the configuration it replaced.
            if (applied.staleConfiguration) {
              summary.transitionsStaleConfiguration += 1;
            } else {
              summary.transitionsContended += 1;
            }
            this.logger.debug({
              event: applied.staleConfiguration
                ? "monitor.transition.stale-configuration"
                : "monitor.transition.contended",
              cycleSequence: input.cycleSequence,
              monitorId: monitor.monitorId,
              symbol: member.symbol,
              levelId: level.id,
            });
            continue;
          }
          if (applied.unchanged) {
            summary.transitionsUnchanged += 1;
            continue;
          }
          summary.transitionsRecorded += applied.transitions;
          if (decision.reconstructed) {
            summary.levelsReconstructed += 1;
          }
          if (applied.closedSignalId) {
            summary.signalsResolved += 1;
          }
          if (applied.openedSignalId) {
            summary.signalsEmitted += 1;
            this.logger.info({
              event: "monitor.signal.emitted",
              cycleSequence: input.cycleSequence,
              monitorId: monitor.monitorId,
              ownership: monitor.ownership,
              actorUserId,
              symbol: member.symbol,
              levelId: level.id,
              levelKind: level.kind,
              reconstructed: decision.write.open?.reconstructed ?? false,
              observationDate: decision.write.open?.observationDate ?? null,
            });
          }
        } catch (err) {
          this.logger.error({
            event: "monitor.transition.failed",
            cycleSequence: input.cycleSequence,
            monitorId: monitor.monitorId,
            actorUserId,
            symbol: member.symbol,
            levelId: level.id,
            err,
          });
        }
      }
    }

    // A security removed from the list, or a level removed from the Strategy, stops being visited.
    // Only an evaluation ever moves a lifecycle, so without this its occurrence would stay current
    // forever — pointing at a level or a holding that no longer exists.
    try {
      const resolved = await this.repository.resolveUnvisitedStates({
        monitorId: monitor.monitorId,
        configVersion: monitor.configVersion,
        securityIds: monitor.members.map((member) => member.securityId),
        levelIds: levels.map((level) => level.id),
        now,
      });
      if (resolved > 0) {
        summary.signalsResolved += resolved;
        this.logger.info({
          event: "monitor.signals.orphaned-resolved",
          cycleSequence: input.cycleSequence,
          monitorId: monitor.monitorId,
          actorUserId,
          resolved,
        });
      }
    } catch (err) {
      this.logger.error({
        event: "monitor.signals.orphan-sweep.failed",
        cycleSequence: input.cycleSequence,
        monitorId: monitor.monitorId,
        err,
      });
    }
  }

  /**
   * Whether each (exchange, session) the cycle is about to evaluate was a trading day.
   *
   * Resolved once for the whole cycle, from the distinct pairs the quotes actually named, so the
   * venue's schedule is fetched per exchange rather than per symbol or per Monitor.
   *
   * A failure fails the cycle. That is the same rule a failed quote read follows and for the same
   * reason: the only alternative is assuming the exchange was open, which is precisely the
   * assumption that fabricates a bar on a day nothing traded.
   */
  private async resolveTradingSessions(
    securities: readonly Security[],
    resolved: ReadonlyMap<SecurityId, { date: LocalDate }>,
    cycleSequence: number,
  ): Promise<Map<string, boolean>> {
    const pairs = new Map<string, { exchangeCode: string; date: LocalDate }>();
    for (const security of securities) {
      const observation = resolved.get(security.id);
      if (observation) {
        pairs.set(sessionKey(security.exchangeCode, observation.date), {
          exchangeCode: security.exchangeCode,
          date: observation.date,
        });
      }
    }

    const sessions = new Map<string, boolean>();
    try {
      await Promise.all(
        [...pairs].map(async ([key, pair]) => {
          sessions.set(
            key,
            await this.calendar.isTradingSession(pair.exchangeCode, pair.date),
          );
        }),
      );
    } catch (err) {
      this.logger.error({
        event: "monitor.trading-calendar.failed",
        cycleSequence,
        sessions: pairs.size,
        err,
      });
      throw err;
    }
    return sessions;
  }

  /**
   * The observation to evaluate this symbol on, with the trading session it belongs to.
   *
   * Three ways a quote is refused, and none of them fabricate anything:
   *
   * - **Too old.** A stale quote presented as the current observation would be a fabricated bar.
   * - **Dated after the cycle's own session.** A provider clock that is wrong, or a timestamp in
   *   the wrong unit, would otherwise name a session that has not happened — and a session is what
   *   advances a Trigger Signal's lifetime. The bound is the session, not the millisecond: a
   *   timestamp slightly ahead of this process's clock inside the same session is ordinary skew and
   *   names the right session anyway, so it is accepted.
   * - **Unreadable.** A timestamp that will not parse gives no session, so there is nothing to
   *   date the observation with.
   *
   * A provider that reports no timestamp at all is taken at its word — it is answering now — and
   * the cycle's own session is used. Failing closed there would stop monitoring for every symbol
   * whose feed omits the field.
   */
  private resolveObservation(
    observation: CurrentObservation | undefined,
    now: Date,
  ): { observation: CurrentObservation; date: LocalDate } | null {
    if (!observation) {
      return null;
    }
    const cycleSession = tradingSessionDate(now);
    if (observation.quotedAt === undefined) {
      return { observation, date: cycleSession };
    }
    const quotedAt = Date.parse(observation.quotedAt);
    if (!Number.isFinite(quotedAt)) {
      return null;
    }
    if (now.getTime() - quotedAt > this.options.quoteMaxAgeMs) {
      return null;
    }
    const date = tradingSessionDate(new Date(quotedAt));
    return date > cycleSession ? null : { observation, date };
  }
}

/** One exchange's session on one day, as a map key. */
function sessionKey(exchangeCode: string, date: LocalDate): string {
  return `${exchangeCode.trim().toUpperCase()} ${date}`;
}



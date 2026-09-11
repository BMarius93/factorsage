import {
  normalizeStrategyDefinition,
  strategySignalFingerprint,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import {
  isBuyWindowEligible,
  type LocalDate,
  type Security,
  type SecurityId,
} from "@intrinsic/domain";
import type { StructuredLogger } from "@intrinsic/observability";
import type {
  CurrentObservation,
  MonitorEvaluationFrame,
} from "@intrinsic/stock-data";
import {
  Evaluability,
  collectOperands,
  evaluateSignalWithoutPosition,
  monitorStrategyLevels,
  type OperandKey,
} from "@intrinsic/strategy";
import { mapWithConcurrency } from "../shared/concurrency.js";
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
}

export type MonitorCycleOptions = {
  symbolConcurrency: number;
  /** How stale a provider quote may be and still act as the provisional observation. */
  quoteMaxAgeMs: number;
  now?: () => Date;
};

export type MonitorCycleSummary = {
  monitors: number;
  symbols: number;
  evaluations: number;
  signalsEmitted: number;
  signalsResolved: number;
  notEvaluable: number;
  /** Symbols with no usable current quote. Every Monitor watching one is NOT_EVALUABLE. */
  symbolsWithoutCurrentData: number;
  /** Symbols with no usable persisted history at all; every predicate is NOT_EVALUABLE. */
  symbolsWithoutSnapshot: number;
  currentDataFailed: boolean;
  /** Transitions a concurrent cycle applied first. Persistently non-zero means overlapping cycles. */
  transitionsContended: number;
  /** Evaluations that repeated the recorded outcome and needed no write at all. */
  transitionsUnchanged: number;
  /** True when the cycle stopped early: the lease was lost, or the process is shutting down. */
  aborted: boolean;
};

/** Whether the cycle in flight should stop at its next Monitor boundary. */
export type AbortSignalCheck = () => boolean;

/** One prepared per-symbol snapshot, shared by every Monitor that references the symbol. */
type SymbolSnapshot = {
  security: Security;
  frame: MonitorEvaluationFrame | null;
};

export class MonitorCycle {
  private readonly now: () => Date;

  constructor(
    private readonly repository: MonitorRepository,
    private readonly data: MonitorDataLoader,
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
      notEvaluable: 0,
      symbolsWithoutCurrentData: 0,
      symbolsWithoutSnapshot: 0,
      currentDataFailed: false,
      transitionsContended: 0,
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
          actorUserId: monitor.actorUserId,
          err,
        });
        return [];
      }
    });

    // Required-series aggregation: the union of the operands every Monitor references, per symbol.
    // This is what decides both which frame columns exist and how much history is loaded, so a
    // symbol is never asked for a series no active Monitor names.
    const operandsBySecurity = new Map<SecurityId, Set<OperandKey>>();
    for (const { monitor, definition } of parsed) {
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
    const asOf = toLocalDate(now);

    // One current-data request for the whole cycle. A failure here is not a match and not an error
    // the cycle dies on: every symbol is left without a current observation and therefore reports
    // NOT_EVALUABLE, which leaves every durable latch exactly as it was.
    let observations = new Map<SecurityId, CurrentObservation>();
    try {
      observations = await this.data.getCurrentObservations(securities);
    } catch (err) {
      summary.currentDataFailed = true;
      this.logger.error({
        event: "monitor.current-data.failed",
        cycleSequence,
        symbols: securities.length,
        err,
      });
    }

    const snapshots = new Map<SecurityId, SymbolSnapshot>();
    await mapWithConcurrency(
      securities,
      this.options.symbolConcurrency,
      async (security) => {
        const operands = [
          ...(operandsBySecurity.get(security.id) ?? new Set<OperandKey>()),
        ].sort();
        const observation = this.usableObservation(
          observations.get(security.id),
          now,
        );
        if (!observation) {
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
          observation,
          // The quote's own trading date, not the cycle's calendar day: the provider is the
          // authority on which session it is pricing, and using the wall clock would append a
          // provisional bar on a day the market never opened.
          observationDate: observationDateOf(observation, asOf),
          asOf,
          cycleSequence,
        });
        snapshots.set(security.id, snapshot);
        if (!snapshot.frame) {
          summary.symbolsWithoutSnapshot += 1;
        }
      },
    );

    const scanned: string[] = [];
    for (const { monitor, definition } of parsed) {
      if (isAborted()) {
        // Stopping between Monitors is safe: every transition is decided from durable state and
        // persisted history, so the next cycle re-evaluates whatever this one did not reach and
        // reaches the same conclusions.
        summary.aborted = true;
        break;
      }
      await this.evaluateMonitor({
        monitor,
        definition,
        snapshots,
        now,
        summary,
        cycleSequence,
      });
      scanned.push(monitor.monitorId);
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
   * Evaluates one Monitor against the shared snapshots and persists every transition.
   *
   * The snapshots are already built, so this does no data work at all: it reads one index of a
   * frame per level per security through the canonical evaluator.
   */
  private async evaluateMonitor(input: {
    monitor: ActiveMonitor;
    definition: StrategyDefinition;
    snapshots: Map<SecurityId, SymbolSnapshot>;
    now: Date;
    summary: MonitorCycleSummary;
    cycleSequence: number;
  }): Promise<void> {
    const { monitor, definition, snapshots, now, summary } = input;
    const levels = monitorStrategyLevels(definition);
    if (levels.length === 0) {
      return;
    }

    let states: Map<string, PersistedSignalState>;
    try {
      states = await this.repository.loadSignalStates(monitor.monitorId);
    } catch (err) {
      this.logger.error({
        event: "monitor.state.load-failed",
        cycleSequence: input.cycleSequence,
        monitorId: monitor.monitorId,
        actorUserId: monitor.actorUserId,
        err,
      });
      return;
    }

    for (const member of monitor.members) {
      const snapshot = snapshots.get(member.securityId);
      for (const level of levels) {
        const previous =
          states.get(signalStateKey(member.securityId, level.id)) ?? null;
        const outcome = this.evaluateLevel(snapshot, level, member, now);
        if (outcome.result === "NOT_EVALUABLE") {
          summary.notEvaluable += 1;
        }
        summary.evaluations += 1;

        try {
          const applied = await this.repository.applyTransition({
            monitorId: monitor.monitorId,
            securityId: member.securityId,
            levelId: level.id,
            levelKind: level.kind,
            strategyVersionId: monitor.strategyVersionId,
            signalFingerprint: strategySignalFingerprint(level.signal),
            hasTrigger: level.signal.trigger !== undefined,
            outcome: outcome.result,
            observationDate: outcome.observationDate,
            observationPrice: outcome.observationPrice,
            now,
            previous,
          });
          if (!applied.applied) {
            // A concurrent cycle moved this state first and nothing was written. Counting it makes
            // overlapping cycles visible instead of silent.
            summary.transitionsContended += 1;
            this.logger.debug({
              event: "monitor.transition.contended",
              cycleSequence: input.cycleSequence,
              monitorId: monitor.monitorId,
              symbol: member.symbol,
              levelId: level.id,
            });
            continue;
          }
          if (applied.unchanged) {
            summary.transitionsUnchanged += 1;
          }
          if (applied.emittedSignalId) {
            summary.signalsEmitted += 1;
            this.logger.info({
              event: "monitor.signal.emitted",
              cycleSequence: input.cycleSequence,
              monitorId: monitor.monitorId,
              actorUserId: monitor.actorUserId,
              symbol: member.symbol,
              levelId: level.id,
              levelKind: level.kind,
              hasTrigger: level.signal.trigger !== undefined,
              observationDate: outcome.observationDate,
            });
          }
          summary.signalsResolved += applied.resolvedSignalIds.length;
        } catch (err) {
          this.logger.error({
            event: "monitor.transition.failed",
            cycleSequence: input.cycleSequence,
            monitorId: monitor.monitorId,
            actorUserId: monitor.actorUserId,
            symbol: member.symbol,
            levelId: level.id,
            err,
          });
        }
      }
    }

    // A security removed from the list, or a level removed from the Strategy, stops being visited.
    // Only an evaluation ever resolves a Signal, so without this its match would stay active
    // forever — pointing at a level or a holding that no longer exists.
    try {
      const resolved = await this.repository.resolveUnvisitedSignals({
        monitorId: monitor.monitorId,
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
          actorUserId: monitor.actorUserId,
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
   * One level, one security, one observation.
   *
   * Two gates come before the evaluator, and both are canonical rather than Monitor-specific:
   *
   * - **No snapshot means NOT_EVALUABLE.** A symbol whose history could not be loaded, or that has
   *   no current observation this cycle, has nothing to compare — and the architecture is explicit
   *   that a provider failure or a missing history must never become a match.
   * - **A BUY level honours the list membership's buy window.** `ai/product/lists.md` defines a
   *   CUSTOM window as the dates the member is eligible on, and the backtest reads the same
   *   `isBuyWindowEligible` before firing a BUY. A member the list says is not buyable today is
   *   not a BUY match today. SELL and FINAL EXIT are not gated, matching the engine.
   */
  private evaluateLevel(
    snapshot: SymbolSnapshot | undefined,
    level: { id: string; kind: string; signal: Parameters<typeof evaluateSignalWithoutPosition>[0] },
    member: { buyWindowMode: "FULL" | "CUSTOM"; buyWindows: readonly { startDate: LocalDate; endDate: LocalDate | null }[] },
    now: Date,
  ): {
    result: "MATCHED" | "NOT_MATCHED" | "NOT_EVALUABLE";
    observationDate: LocalDate;
    observationPrice: number;
  } {
    const frame = snapshot?.frame;
    if (!frame) {
      return {
        result: "NOT_EVALUABLE",
        observationDate: toLocalDate(now),
        observationPrice: 0,
      };
    }

    const context = {
      observationDate: frame.observationDate,
      observationPrice: frame.observationPrice,
    };

    if (
      level.kind === "BUY" &&
      !isBuyWindowEligible(
        { mode: member.buyWindowMode, ranges: member.buyWindows },
        frame.observationDate,
      )
    ) {
      return { result: "NOT_MATCHED", ...context };
    }

    const evaluability = evaluateSignalWithoutPosition(
      level.signal,
      frame.frame,
      frame.observationIndex,
    );
    return {
      result:
        evaluability === Evaluability.TRUE
          ? "MATCHED"
          : evaluability === Evaluability.FALSE
            ? "NOT_MATCHED"
            : "NOT_EVALUABLE",
      ...context,
    };
  }

  /**
   * A quote is usable only if it is recent enough to be "current".
   *
   * A stale quote is dropped rather than trusted: evaluating yesterday's price as today's
   * provisional observation would be a fabricated bar, and reporting NOT_EVALUABLE is the honest
   * alternative. A quote the provider gave no timestamp for is accepted — the provider is
   * answering now — because failing closed on a missing optional field would stop monitoring for
   * every symbol whose feed omits it.
   */
  private usableObservation(
    observation: CurrentObservation | undefined,
    now: Date,
  ): CurrentObservation | null {
    if (!observation) {
      return null;
    }
    if (observation.quotedAt === undefined) {
      return observation;
    }
    const quotedAt = Date.parse(observation.quotedAt);
    if (!Number.isFinite(quotedAt)) {
      return null;
    }
    return now.getTime() - quotedAt <= this.options.quoteMaxAgeMs
      ? observation
      : null;
  }
}

/** The cycle's own UTC calendar day. Product dates carry no timezone (`LocalDate`). */
function toLocalDate(value: Date): LocalDate {
  return value.toISOString().slice(0, 10);
}

/**
 * The trading date a quote belongs to.
 *
 * The provider's own timestamp is preferred over the cycle's wall clock: on a Saturday the clock
 * says "today" while the quote is still pricing Friday's session, and trusting the clock would
 * append a provisional bar to a day the market never opened. A provider that reports no timestamp
 * falls back to the cycle's day, which is the best available answer.
 */
function observationDateOf(
  observation: CurrentObservation,
  asOf: LocalDate,
): LocalDate {
  if (observation.quotedAt === undefined) {
    return asOf;
  }
  const quotedAt = Date.parse(observation.quotedAt);
  return Number.isFinite(quotedAt)
    ? new Date(quotedAt).toISOString().slice(0, 10)
    : asOf;
}

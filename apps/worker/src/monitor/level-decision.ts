import type { MonitorTransitionReason } from "@intrinsic/contracts";
import type { MonitorEvaluationOutcome } from "@intrinsic/database";
import { isBuyWindowEligible, type LocalDate } from "@intrinsic/domain";
import {
  Evaluability,
  evaluateLevelWithoutPosition,
  frameIndexOf,
  isRestingMonitorStep,
  observeMonitorLevel,
  reconstructMonitorLevel,
  stepMonitorLevel,
  type EvaluationFrame,
  type MonitorLevelLifecycle,
  type MonitorLevelStep,
  type MonitorStrategyLevel,
} from "@intrinsic/strategy";
import type { ReconstructionHistory, SymbolSnapshot } from "./monitor-cycle.js";
import {
  endedStateOf,
  type ActiveMonitor,
  type ActiveMonitorMember,
  type LevelStateWrite,
  type MonitorObservation,
  type PersistedSignalState,
  type TransitionRecord,
} from "./monitor-repository.js";

/**
 * What one evaluation of one `(monitor, security, level)` decides.
 *
 * Pure: the lifecycle itself is `stepMonitorLevel`; this adds the Monitor-specific framing around
 * it — the observation, buy-window gating, logic-change resets and historical reconstruction — and
 * produces the one write the repository persists. `write` is `null` when there is nothing to
 * persist at all.
 */
export type LevelDecision = {
  outcome: MonitorEvaluationOutcome;
  reconstructed: boolean;
  /**
   * True when the level needed reconstructing but the history read could not establish its state
   * — no resting session in it, and it does not reach the start of the security's history. Nothing
   * is written; the cycle reads deeper history before it gets here, so this is a safety net.
   */
  reconstructionIncomplete?: boolean;
  write: LevelStateWrite | null;
};

export function decideLevel(input: {
  monitor: Pick<
    ActiveMonitor,
    "monitorId" | "configVersion" | "strategyVersionId"
  >;
  member: ActiveMonitorMember;
  level: MonitorStrategyLevel;
  previous: PersistedSignalState | null;
  snapshot: SymbolSnapshot | undefined;
  now: Date;
}): LevelDecision {
  const { monitor, member, level, previous, snapshot, now } = input;
  const stale =
    previous !== null && previous.signalFingerprint !== level.fingerprint;
  const frame = snapshot?.frame ?? null;

  const base = {
    monitorId: monitor.monitorId,
    configVersion: monitor.configVersion,
    securityId: member.securityId,
    levelId: level.id,
    levelKind: level.kind,
    strategyVersionId: monitor.strategyVersionId,
    signalFingerprint: level.fingerprint,
    hasTrigger: level.hasTrigger,
    now,
    previous,
  } as const;

  // The reset a logic change makes, whatever else happens: the old occurrence closes, a pending
  // setup is dropped, and both are recorded under the logic they belonged to.
  const reset = stale ? logicChangeReset(previous) : null;

  if (!frame) {
    // No observation: a weekend, a closure, a missing quote, a failed load. Nothing may advance —
    // no session was observed — and nothing is invented.
    if (reset) {
      return {
        outcome: "NOT_EVALUABLE",
        reconstructed: false,
        write: {
          ...base,
          outcome: "NOT_EVALUABLE",
          decided: null,
          // The latch belongs to logic that no longer exists and nothing decidable replaced it.
          // Absence is the honest "unknown"; the next decidable cycle reconstructs.
          lifecycle: null,
          enteredAt: null,
          transitions: reset.transitions,
          close: reset.close,
          open: null,
        },
      };
    }
    if (previous && previous.lastOutcome !== "NOT_EVALUABLE") {
      return {
        outcome: "NOT_EVALUABLE",
        reconstructed: false,
        write: {
          ...base,
          outcome: "NOT_EVALUABLE",
          decided: null,
          lifecycle: previous.lifecycle,
          enteredAt: null,
          transitions: [],
          close: null,
          open: null,
        },
      };
    }
    return { outcome: "NOT_EVALUABLE", reconstructed: false, write: null };
  }

  const observation: MonitorObservation = {
    date: frame.observationDate,
    price: frame.observationPrice,
  };
  const eligible = eligibleOn(level, member, observation.date);
  const outcome = outcomeOf(
    eligible
      ? evaluateLevelWithoutPosition(
          level.rules,
          frame.frame,
          frame.observationIndex,
        )
      : Evaluability.FALSE,
  );
  const decided =
    outcome === "NOT_EVALUABLE" ? null : { result: outcome, observation };
  const liveStep: MonitorLevelStep = {
    date: observation.date,
    eligible,
    rules: observeMonitorLevel(level, frame.frame, frame.observationIndex),
  };

  if (previous && !stale) {
    const step = stepMonitorLevel(previous.lifecycle, liveStep);
    return {
      outcome,
      reconstructed: false,
      write: {
        ...base,
        outcome,
        decided,
        lifecycle: step.next,
        enteredAt:
          step.transitions.length > 0
            ? { observationDate: observation.date, price: observation.price }
            : null,
        transitions: step.transitions.map((transition) => ({
          from: transition.from,
          to: transition.to,
          reason: transition.reason,
          exitRuleId: transition.exitRuleId,
          observationDate: transition.date,
          signalFingerprint: level.fingerprint,
          signal:
            transition.to === "ACTIVE"
              ? "opened"
              : transition.from === "ACTIVE"
                ? "closed"
                : null,
        })),
        close: step.closed
          ? { reason: step.closed.reason, observationDate: observation.date }
          : null,
        open: step.opened
          ? {
              observationDate: observation.date,
              price: observation.price,
              reconstructed: false,
            }
          : null,
      },
    };
  }

  // No current state for this logic: a new Monitor, member or level, a rebind, or an edit. The
  // state is reconstructed from closed history and then advanced by the live observation — only a
  // decidable live observation may create it.
  const history = snapshot?.history;
  if (!decided || history === null) {
    if (reset) {
      return {
        outcome,
        reconstructed: false,
        write: {
          ...base,
          outcome,
          decided: null,
          lifecycle: null,
          enteredAt: null,
          transitions: reset.transitions,
          close: reset.close,
          open: null,
        },
      };
    }
    return { outcome, reconstructed: false, write: null };
  }

  // Replayed from the latest resting session, so the result is the full canonical replay's
  // whatever the window's length (`reconstructMonitorLevel`).
  const reconstruction = reconstructMonitorLevel({
    history: history
      ? historySteps(level, member, history.frame, observation.date)
      : [],
    live: liveStep,
    complete: history ? history.complete : true,
  });
  if (!reconstruction.exact) {
    return {
      outcome,
      reconstructed: false,
      reconstructionIncomplete: true,
      write: null,
    };
  }
  const step = reconstruction.live;
  const final = reconstruction.lifecycle;
  // Only an ACTIVE state carries an occurrence. A reconstructed "resolved" is simply "nothing is
  // current": no occurrence was ever persisted for it, so it is recorded as INACTIVE.
  const state = final.state === "RESOLVED" ? "INACTIVE" : final.state;
  const lifecycle: MonitorLevelLifecycle = { ...final, state };
  const since = final.since;
  const enteredLive = since === observation.date && step.transitions.length > 0;
  const lastLive = step.transitions[step.transitions.length - 1];
  const reconstructed = state !== "INACTIVE" && !enteredLive;
  const priceAtSince =
    since === null
      ? null
      : since === observation.date
        ? observation.price
        : ((history ? closeOn(history.frame, since) : null) ??
          closeOn(frame.frame, since));

  const transitions: TransitionRecord[] = [...(reset?.transitions ?? [])];
  let open: LevelStateWrite["open"] = null;
  if (state !== "INACTIVE" && since !== null) {
    const reason: MonitorTransitionReason =
      enteredLive && lastLive ? lastLive.reason : "RECONSTRUCTED";
    transitions.push({
      from: "INACTIVE",
      to: state,
      reason,
      exitRuleId: enteredLive && lastLive ? lastLive.exitRuleId : null,
      observationDate: since,
      signalFingerprint: level.fingerprint,
      signal: state === "ACTIVE" ? "opened" : null,
    });
    if (state === "ACTIVE") {
      open = {
        observationDate: since,
        price: priceAtSince ?? observation.price,
        reconstructed,
      };
    }
  }

  return {
    outcome,
    reconstructed: history !== undefined,
    write: {
      ...base,
      outcome,
      decided,
      lifecycle,
      enteredAt:
        since === null ? null : { observationDate: since, price: priceAtSince },
      transitions,
      close: reset?.close ?? null,
      open,
    },
  };
}

/** A BUY level honours the member's canonical buy window; SELL and FINAL EXIT never do. */
function eligibleOn(
  level: Pick<MonitorStrategyLevel, "kind">,
  member: ActiveMonitorMember,
  date: LocalDate,
): boolean {
  return (
    level.kind !== "BUY" ||
    isBuyWindowEligible(
      { mode: member.buyWindowMode, ranges: member.buyWindows },
      date,
    )
  );
}

function outcomeOf(evaluability: Evaluability): MonitorEvaluationOutcome {
  return evaluability === Evaluability.TRUE
    ? "MATCHED"
    : evaluability === Evaluability.FALSE
      ? "NOT_MATCHED"
      : "NOT_EVALUABLE";
}

/** The reset a logic change makes to a state recorded under the previous logic. */
function logicChangeReset(previous: PersistedSignalState): {
  transitions: TransitionRecord[];
  close: LevelStateWrite["close"];
} {
  const ended = endedStateOf(previous.lifecycle.state);
  return {
    transitions: ended
      ? [
          {
            from: previous.lifecycle.state,
            to: ended,
            reason: "LOGIC_CHANGED",
            exitRuleId: null,
            observationDate: null,
            signalFingerprint: previous.signalFingerprint,
            signal: previous.lifecycle.state === "ACTIVE" ? "closed" : null,
          },
        ]
      : [],
    close: previous.activeSignalId
      ? { reason: "LOGIC_CHANGED", observationDate: null }
      : null,
  };
}

function historyStep(
  level: MonitorStrategyLevel,
  member: ActiveMonitorMember,
  history: EvaluationFrame,
  index: number,
): MonitorLevelStep {
  const date = history.dates[index]!;
  return {
    date,
    eligible: eligibleOn(level, member, date),
    rules: observeMonitorLevel(level, history, index),
  };
}

/** The last index of the history frame's period that is strictly before `before`, or -1. */
function lastHistoryIndex(history: EvaluationFrame, before: LocalDate): number {
  let index = history.dates.length - 1;
  while (index >= history.periodStartIndex && history.dates[index]! >= before) {
    index -= 1;
  }
  return index;
}

/**
 * The closed sessions of the history frame before the live observation, as lifecycle steps —
 * from the latest resting session on when there is one, since nothing before it can matter.
 * Scanning backwards means a level that rested recently evaluates a handful of sessions, not the
 * whole window.
 */
function historySteps(
  level: MonitorStrategyLevel,
  member: ActiveMonitorMember,
  history: EvaluationFrame,
  before: LocalDate,
): MonitorLevelStep[] {
  const last = lastHistoryIndex(history, before);
  const steps: MonitorLevelStep[] = [];
  for (let index = last; index >= history.periodStartIndex; index -= 1) {
    const step = historyStep(level, member, history, index);
    steps.push(step);
    if (isRestingMonitorStep(step)) {
      break;
    }
  }
  return steps.reverse();
}

/**
 * Whether reconstructing this level needs more history than `history` holds.
 *
 * Only a level that will actually be created now can need it: one whose live observation is
 * decidable and does not itself rest. It needs it when the history read has no resting session
 * and does not already start where the security's history starts — the level's state then depends
 * on something older than the read (`reconstructMonitorLevel`).
 */
export function needsDeeperHistory(input: {
  level: MonitorStrategyLevel;
  member: ActiveMonitorMember;
  snapshot: SymbolSnapshot;
  history: ReconstructionHistory;
}): boolean {
  const { level, member, snapshot, history } = input;
  const frame = snapshot.frame;
  if (!frame || history.complete) {
    return false;
  }
  const date = frame.observationDate;
  const eligible = eligibleOn(level, member, date);
  if (
    eligible &&
    evaluateLevelWithoutPosition(
      level.rules,
      frame.frame,
      frame.observationIndex,
    ) === Evaluability.NOT_EVALUABLE
  ) {
    return false;
  }
  const live: MonitorLevelStep = {
    date,
    eligible,
    rules: observeMonitorLevel(level, frame.frame, frame.observationIndex),
  };
  if (isRestingMonitorStep(live)) {
    return false;
  }
  const steps = historySteps(level, member, history.frame, date);
  return steps.length === 0 || !isRestingMonitorStep(steps[0]!);
}

function closeOn(frame: EvaluationFrame, date: LocalDate): number | null {
  const index = frameIndexOf(frame, date);
  if (index < 0) {
    return null;
  }
  const close = frame.closes[index];
  return close === undefined || !Number.isFinite(close) ? null : close;
}

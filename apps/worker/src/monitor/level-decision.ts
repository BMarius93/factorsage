import type { MonitorTransitionReason } from "@intrinsic/contracts";
import type { MonitorEvaluationOutcome } from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import {
  Evaluability,
  frameIndexOf,
  isRestingMonitorStep,
  observeMonitorLevel,
  type EvaluationFrame,
  type MonitorLevelStep,
  type MonitorStrategyLevel,
} from "@intrinsic/strategy";
import {
  endedStateOf,
  type PersistedSignalState,
  type TransitionRecord,
} from "./monitor-repository.js";

/**
 * The pieces of a level decision `session-decision.ts` composes: outcomes, the logic-change reset,
 * ongoing-membership eligibility and the history steps a reconstruction walks. Pure.
 */

export function outcomeOf(
  evaluability: Evaluability,
): MonitorEvaluationOutcome {
  return evaluability === Evaluability.TRUE
    ? "MATCHED"
    : evaluability === Evaluability.FALSE
      ? "NOT_MATCHED"
      : "NOT_EVALUABLE";
}

/** The reset a logic change makes to a state recorded under the previous logic. */
export function logicChangeReset(previous: PersistedSignalState): {
  transitions: TransitionRecord[];
  close: {
    reason: MonitorTransitionReason;
    observationDate: LocalDate | null;
  } | null;
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

/**
 * Whether a member is evaluated on a date: its ongoing membership, which gates every level
 * (`docs/decisions/monitor-eod-v2.md` §4).
 */
export type MemberEligibility = (date: LocalDate) => boolean;

export function historyStep(
  level: MonitorStrategyLevel,
  history: EvaluationFrame,
  index: number,
  eligibility: MemberEligibility,
): MonitorLevelStep {
  const date = history.dates[index]!;
  return {
    date,
    eligible: eligibility(date),
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
 * The closed sessions of the history frame before `before`, as lifecycle steps — from the latest
 * resting session on when there is one, since nothing before it can matter. Scanning backwards
 * means a level that rested recently evaluates a handful of sessions, not the whole window.
 */
export function historySteps(
  level: MonitorStrategyLevel,
  history: EvaluationFrame,
  before: LocalDate,
  eligibility: MemberEligibility,
): MonitorLevelStep[] {
  const last = lastHistoryIndex(history, before);
  const steps: MonitorLevelStep[] = [];
  for (let index = last; index >= history.periodStartIndex; index -= 1) {
    const step = historyStep(level, history, index, eligibility);
    steps.push(step);
    if (isRestingMonitorStep(step)) {
      break;
    }
  }
  return steps.reverse();
}

export function closeOn(
  frame: EvaluationFrame,
  date: LocalDate,
): number | null {
  const index = frameIndexOf(frame, date);
  if (index < 0) {
    return null;
  }
  const close = frame.closes[index];
  return close === undefined || !Number.isFinite(close) ? null : close;
}

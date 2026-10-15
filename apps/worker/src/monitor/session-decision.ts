import type { MonitorEvaluationOutcome } from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import {
  Evaluability,
  evaluateLevelWithoutPosition,
  observeMonitorLevel,
  reconstructMonitorLevel,
  stepMonitorLevel,
  type EvaluationFrame,
  type MonitorLevelLifecycle,
  type MonitorLevelStep,
  type MonitorStrategyLevel,
} from "@intrinsic/strategy";
import {
  closeOn,
  eligibleOn,
  historySteps,
  logicChangeReset,
  outcomeOf,
} from "./level-decision.js";
import type {
  ActiveMonitorMember,
  LevelChange,
  LevelSessionsWrite,
  PersistedSignalState,
  TransitionOrigin,
} from "./monitor-repository.js";

/**
 * What one EOD evaluation decides for one `(monitor, member, level)` over one or more finalized
 * sessions (`docs/decisions/monitor-eod-v2.md` §3).
 *
 * Pure: the lifecycle is `stepMonitorLevel`, applied to each session **in order** — a missed Tuesday
 * is never skipped on the way to Thursday — and every change it makes is recorded with the session
 * it happened on. Nothing here reads a clock, a quote or a store.
 *
 * Two shapes:
 *
 * - **A level with state under its current logic** is caught up session by session from that state.
 *   Each change carries its true session date and its origin; a catch-up over a week writes the
 *   changes of that week, never one row per session.
 * - **A level with no state, or state under logic that changed**, is reconstructed at the newest
 *   session from the closed history before it, exactly as V1 did — the one result a full replay
 *   would reach, recorded as one `RECONSTRUCTED` change (or the change the newest session itself
 *   made) — never a regenerated history.
 */

export type SessionDecisionInput = {
  level: MonitorStrategyLevel;
  member: ActiveMonitorMember;
  strategyVersionId: string;
  previous: PersistedSignalState | null;
  frame: EvaluationFrame;
  /** Frame indices of the sessions to decide, ascending: finalized sessions the member has a bar for. */
  sessions: readonly number[];
  /** The frame begins at the security's first canonical session: a reconstruction is complete. */
  historyComplete: boolean;
  /** Whether a change on this session was observed while the Monitor was watched. */
  originOf: (date: LocalDate) => TransitionOrigin;
};

export type SessionDecision = {
  write: LevelSessionsWrite | null;
  /** The level needs reconstruction and the frame does not reach a resting session: read deeper. */
  needsDeeperHistory: boolean;
  reconstructed: boolean;
};

type SessionReading = {
  step: MonitorLevelStep;
  outcome: MonitorEvaluationOutcome;
  price: number;
};

export function decideLevelSessions(
  input: SessionDecisionInput,
): SessionDecision {
  const { level, member, previous, frame, sessions } = input;
  const stale =
    previous !== null && previous.signalFingerprint !== level.fingerprint;
  const base = {
    levelId: level.id,
    levelKind: level.kind,
    signalFingerprint: level.fingerprint,
    hasTrigger: level.hasTrigger,
    strategyVersionId: input.strategyVersionId,
    previous,
  } as const;
  const reset = stale ? resetChanges(previous) : [];
  const resetOnly = (): SessionDecision => ({
    write: stale
      ? {
          ...base,
          changes: reset,
          // The latch belongs to logic that no longer exists and nothing decidable replaced it.
          lifecycle: null,
          outcome: "NOT_EVALUABLE",
          decided: null,
          enteredAt: null,
        }
      : null,
    needsDeeperHistory: false,
    reconstructed: false,
  });

  const newest = sessions[sessions.length - 1];
  if (newest === undefined) {
    return resetOnly();
  }
  const read = (index: number): SessionReading => {
    const date = frame.dates[index]!;
    const eligible = eligibleOn(level, member, date);
    return {
      step: {
        date,
        eligible,
        rules: observeMonitorLevel(level, frame, index),
      },
      outcome: outcomeOf(
        eligible
          ? evaluateLevelWithoutPosition(level.rules, frame, index)
          : Evaluability.FALSE,
      ),
      price: frame.closes[index]!,
    };
  };

  if (previous && !stale) {
    return {
      write: catchUp(input, base, previous, sessions.map(read)),
      needsDeeperHistory: false,
      reconstructed: false,
    };
  }

  // No state for this logic: reconstruct at the newest session. Only a decidable observation may
  // create a state, so an undecidable one waits — as in V1 — for a later session.
  const live = read(newest);
  if (live.outcome === "NOT_EVALUABLE") {
    return resetOnly();
  }
  const reconstruction = reconstructMonitorLevel({
    history: historySteps(level, member, frame, live.step.date),
    live: live.step,
    complete: input.historyComplete,
  });
  if (!reconstruction.exact) {
    return { ...resetOnly(), needsDeeperHistory: true };
  }
  const final = reconstruction.lifecycle;
  // A reconstructed "resolved" is simply "nothing is current": no occurrence was ever recorded.
  const state = final.state === "RESOLVED" ? "INACTIVE" : final.state;
  const lifecycle: MonitorLevelLifecycle = { ...final, state };
  const since = final.since;
  const liveTransitions = reconstruction.live.transitions;
  const enteredLive = since === live.step.date && liveTransitions.length > 0;
  const lastLive = liveTransitions[liveTransitions.length - 1];
  const priceAtSince =
    since === null
      ? null
      : since === live.step.date
        ? live.price
        : closeOn(frame, since);

  const changes: LevelChange[] = [...reset];
  if (state !== "INACTIVE" && since !== null) {
    changes.push({
      transition: {
        from: "INACTIVE",
        to: state,
        reason: enteredLive && lastLive ? lastLive.reason : "RECONSTRUCTED",
        exitRuleId: enteredLive && lastLive ? lastLive.exitRuleId : null,
        observationDate: since,
        signalFingerprint: level.fingerprint,
        signal: state === "ACTIVE" ? "opened" : null,
      },
      origin: enteredLive ? input.originOf(since) : "HISTORY",
      ...(state === "ACTIVE"
        ? {
            open: {
              observationDate: since,
              price: priceAtSince ?? live.price,
              reconstructed: !enteredLive,
            },
          }
        : {}),
    });
  }
  return {
    write: {
      ...base,
      changes,
      lifecycle,
      outcome: live.outcome,
      decided: decidedOf(live),
      enteredAt:
        since === null ? null : { observationDate: since, price: priceAtSince },
    },
    needsDeeperHistory: false,
    reconstructed: true,
  };
}

/** Applies each session in order to a level's persisted lifecycle, recording every change. */
function catchUp(
  input: SessionDecisionInput,
  base: Omit<
    LevelSessionsWrite,
    "changes" | "lifecycle" | "outcome" | "decided" | "enteredAt"
  >,
  previous: PersistedSignalState,
  readings: readonly SessionReading[],
): LevelSessionsWrite {
  let lifecycle = previous.lifecycle;
  let enteredAt: LevelSessionsWrite["enteredAt"] = null;
  const changes: LevelChange[] = [];
  for (const reading of readings) {
    const result = stepMonitorLevel(lifecycle, reading.step);
    for (const transition of result.transitions) {
      const change: LevelChange = {
        transition: {
          from: transition.from,
          to: transition.to,
          reason: transition.reason,
          exitRuleId: transition.exitRuleId,
          observationDate: transition.date,
          signalFingerprint: input.level.fingerprint,
          signal:
            transition.to === "ACTIVE"
              ? "opened"
              : transition.from === "ACTIVE"
                ? "closed"
                : null,
        },
        origin: input.originOf(transition.date),
      };
      if (transition.from === "ACTIVE" && result.closed) {
        change.close = {
          reason: result.closed.reason,
          observationDate: transition.date,
        };
      }
      if (transition.to === "ACTIVE" && result.opened) {
        change.open = {
          observationDate: transition.date,
          price: reading.price,
          reconstructed: false,
        };
      }
      changes.push(change);
    }
    if (result.transitions.length > 0) {
      enteredAt = { observationDate: reading.step.date, price: reading.price };
    }
    lifecycle = result.next;
  }
  const newest = readings[readings.length - 1]!;
  return {
    ...base,
    changes,
    lifecycle,
    outcome: newest.outcome,
    decided: decidedOf(newest),
    enteredAt,
  };
}

function decidedOf(reading: SessionReading): LevelSessionsWrite["decided"] {
  return reading.outcome === "NOT_EVALUABLE"
    ? null
    : {
        result: reading.outcome,
        observation: { date: reading.step.date, price: reading.price },
      };
}

/** The administrative reset a logic change makes to state recorded under the previous logic. */
function resetChanges(previous: PersistedSignalState): LevelChange[] {
  const reset = logicChangeReset(previous);
  return reset.transitions.map((transition) => ({
    transition,
    origin: "ADMINISTRATIVE" as const,
    ...(transition.signal === "closed" && reset.close
      ? { close: reset.close }
      : {}),
  }));
}

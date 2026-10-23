import type { MonitorEvaluationOutcome } from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import {
  Evaluability,
  evaluateLevelWithoutPosition,
  explainMonitorLevel,
  observeMonitorLevel,
  reconstructMonitorLevel,
  stepMonitorLevel,
  type EvaluationFrame,
  type MonitorLevelLifecycle,
  type MonitorLevelStep,
  type MonitorStrategyLevel,
  type MonitorTransitionEvidence,
} from "@intrinsic/strategy";
import {
  closeOn,
  historySteps,
  logicChangeReset,
  outcomeOf,
} from "./level-decision.js";
import type {
  LevelChange,
  LevelSessionsWrite,
  PersistedSignalState,
  TransitionOrigin,
} from "./monitor-repository.js";

/**
 * What one EOD evaluation decides for one `(monitor, member, level)` over one or more finalized
 * sessions (`docs/decisions/monitor-eod-v2.md` §3, §5).
 *
 * Pure: the lifecycle is `stepMonitorLevel`, applied to each session **in order** — a missed Tuesday
 * is never skipped on the way to Thursday — and every change it makes is recorded with the session
 * it happened on, its origin and the evidence it was decided on. Nothing here reads a clock, a quote
 * or a store.
 *
 * Three shapes:
 *
 * - **A level with state under its current logic** is caught up session by session from that state.
 *   A catch-up over a week writes the changes of that week, never one row per session.
 * - **A replay** (a never-evaluated member's activity window, `docs/decisions/monitor-eod-v2.md`
 *   §12) establishes the exact state **before** the window — a reconstruction at the session just
 *   before it, from the closed history before that, so a long-latched setup or occurrence survives
 *   the cutoff — and then steps every window session in order, recording every change with its true
 *   session date.
 * - **Otherwise, a level with no state, or state under logic that changed**, is reconstructed at
 *   the newest session from the closed history before it — the one result a full replay would
 *   reach, recorded as one `RECONSTRUCTED` change (or the change the newest session itself made) —
 *   never a regenerated history.
 */

export type SessionDecisionInput = {
  level: MonitorStrategyLevel;
  strategyVersionId: string;
  previous: PersistedSignalState | null;
  frame: EvaluationFrame;
  /** Frame indices of the sessions to decide, ascending: finalized sessions the member has a bar for. */
  sessions: readonly number[];
  /** The frame begins at the security's first canonical session: a reconstruction is complete. */
  historyComplete: boolean;
  /** Whether a change on this session was observed while the Monitor was watched. */
  originOf: (date: LocalDate) => TransitionOrigin;
  /**
   * Whether the member is a current member of the List on a session — its ongoing membership had
   * begun (`isOngoingListMember`). It gates **every** level: a session before the membership began
   * is never stepped by a catch-up, and rests every level in a reconstruction's history.
   */
  monitoredOn: (date: LocalDate) => boolean;
  /**
   * Decide every session in `sessions` from the exact state before the first, recording each change
   * — a never-evaluated member's activity-window replay. Ignored for a level with state under its
   * current logic, which is caught up as always.
   */
  replay?: boolean;
};

export type SessionDecision = {
  write: LevelSessionsWrite | null;
  /** The level needs reconstruction and the frame does not reach a resting session: read deeper. */
  needsDeeperHistory: boolean;
  reconstructed: boolean;
};

type SessionReading = {
  index: number;
  step: MonitorLevelStep;
  outcome: MonitorEvaluationOutcome;
  price: number;
};

type WriteBase = Omit<
  LevelSessionsWrite,
  "changes" | "lifecycle" | "outcome" | "decided" | "enteredAt"
>;

export function decideLevelSessions(
  input: SessionDecisionInput,
): SessionDecision {
  const { level, previous, frame, sessions } = input;
  const stale =
    previous !== null && previous.signalFingerprint !== level.fingerprint;
  const base: WriteBase = {
    levelId: level.id,
    levelKind: level.kind,
    signalFingerprint: level.fingerprint,
    hasTrigger: level.hasTrigger,
    strategyVersionId: input.strategyVersionId,
    previous,
  };
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
    const eligible = input.monitoredOn(date);
    return {
      index,
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
  const historyBefore = (date: LocalDate) =>
    historySteps(level, frame, date, input.monitoredOn);

  if (previous && !stale) {
    const readings = sessions.map(read);
    const stepped = stepThrough(input, previous.lifecycle, readings);
    const newestReading = readings[readings.length - 1]!;
    return {
      write: {
        ...base,
        changes: stepped.changes,
        lifecycle: stepped.lifecycle,
        outcome: newestReading.outcome,
        decided: decidedOf(newestReading),
        enteredAt: stepped.enteredAt,
      },
      needsDeeperHistory: false,
      reconstructed: false,
    };
  }

  if (input.replay) {
    return replayLevel(input, base, reset, read, historyBefore, resetOnly);
  }

  // No state for this logic: reconstruct at the newest session. Only a decidable observation may
  // create a state, so an undecidable one waits — as in V1 — for a later session.
  const live = read(newest);
  if (live.outcome === "NOT_EVALUABLE") {
    return resetOnly();
  }
  const reconstruction = reconstructMonitorLevel({
    history: historyBefore(live.step.date),
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
    const exitRuleId = enteredLive && lastLive ? lastLive.exitRuleId : null;
    const origin = enteredLive ? input.originOf(since) : "HISTORY";
    const evidence = evidenceAt(level, frame, since, exitRuleId);
    changes.push({
      transition: {
        from: "INACTIVE",
        to: state,
        reason: enteredLive && lastLive ? lastLive.reason : "RECONSTRUCTED",
        exitRuleId,
        observationDate: since,
        signalFingerprint: level.fingerprint,
        signal: state === "ACTIVE" ? "opened" : null,
      },
      origin,
      ...(evidence ? { evidence } : {}),
      ...(state === "ACTIVE"
        ? {
            open: {
              observationDate: since,
              price: priceAtSince ?? live.price,
              reconstructed: origin === "HISTORY",
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

/**
 * A never-evaluated member's activity window (`docs/decisions/monitor-eod-v2.md` §5, §12): the exact
 * state before the first window session, then every window session stepped in order.
 *
 * The state before the window is a reconstruction at the session just before it — the same exact
 * mechanism the newest-session reconstruction uses, anchored earlier — so a 30-day cutoff can never
 * reset a setup or an occurrence latched long before it. That state, when something is current, is
 * recorded as one `RECONSTRUCTED` change on its true activation session; everything inside the
 * window is recorded change by change.
 */
function replayLevel(
  input: SessionDecisionInput,
  base: WriteBase,
  reset: readonly LevelChange[],
  read: (index: number) => SessionReading,
  historyBefore: (date: LocalDate) => MonitorLevelStep[],
  resetOnly: () => SessionDecision,
): SessionDecision {
  const { level, frame, sessions } = input;
  const firstIndex = sessions[0]!;
  let prefix: MonitorLevelLifecycle | null = null;
  let prefixReading: SessionReading | null = null;
  if (firstIndex - 1 >= frame.periodStartIndex) {
    prefixReading = read(firstIndex - 1);
    const reconstruction = reconstructMonitorLevel({
      history: historyBefore(prefixReading.step.date),
      live: prefixReading.step,
      complete: input.historyComplete,
    });
    if (!reconstruction.exact) {
      return { ...resetOnly(), needsDeeperHistory: true };
    }
    prefix = reconstruction.lifecycle;
  } else if (!input.historyComplete) {
    // Nothing before the window was read, and the window is not where the security's history begins.
    return { ...resetOnly(), needsDeeperHistory: true };
  }
  // Before its first session a security had no lifecycle at all; a reconstructed "resolved" is
  // "nothing is current", exactly as the newest-session reconstruction stores it.
  const start: MonitorLevelLifecycle =
    prefix === null
      ? { state: "INACTIVE", since: null, rules: {} }
      : prefix.state === "RESOLVED"
        ? { ...prefix, state: "INACTIVE" }
        : prefix;

  const changes: LevelChange[] = [...reset];
  let enteredAt: LevelSessionsWrite["enteredAt"] = null;
  if (
    (start.state === "ACTIVE" || start.state === "PENDING_TRIGGER") &&
    start.since !== null
  ) {
    const since = start.since;
    // `since` is a session the reconstruction stepped, so the frame holds it; the session before
    // the window stands in only if it somehow does not, never an invented price.
    const price = closeOn(frame, since) ?? prefixReading?.price ?? null;
    const evidence = evidenceAt(level, frame, since, null);
    changes.push({
      transition: {
        from: "INACTIVE",
        to: start.state,
        reason: "RECONSTRUCTED",
        exitRuleId: null,
        observationDate: since,
        signalFingerprint: level.fingerprint,
        signal: start.state === "ACTIVE" ? "opened" : null,
      },
      origin: "HISTORY",
      ...(evidence ? { evidence } : {}),
      ...(start.state === "ACTIVE" && price !== null
        ? { open: { observationDate: since, price, reconstructed: true } }
        : {}),
    });
    enteredAt = { observationDate: since, price };
  }

  const readings = sessions.map(read);
  const stepped = stepThrough(input, start, readings);
  changes.push(...stepped.changes);
  const newestReading = readings[readings.length - 1]!;
  // The newest decided observation the replay saw: a new state needs one to exist at all.
  const decidedReading = [
    ...readings,
    ...(prefixReading ? [prefixReading] : []),
  ]
    .filter((reading) => reading.outcome !== "NOT_EVALUABLE")
    .sort((left, right) => right.index - left.index)[0];
  if (decidedReading === undefined) {
    return resetOnly();
  }
  return {
    write: {
      ...base,
      changes,
      lifecycle: stepped.lifecycle,
      outcome: newestReading.outcome,
      decided: decidedOf(decidedReading),
      enteredAt: stepped.enteredAt ?? enteredAt,
    },
    needsDeeperHistory: false,
    reconstructed: true,
  };
}

/**
 * Applies each session in order to a lifecycle, recording every change with its session, origin and
 * evidence. An occurrence opened on a session the Monitor was not watching is marked reconstructed:
 * history established it, not an observation.
 */
function stepThrough(
  input: SessionDecisionInput,
  from: MonitorLevelLifecycle,
  readings: readonly SessionReading[],
): {
  changes: LevelChange[];
  lifecycle: MonitorLevelLifecycle;
  enteredAt: LevelSessionsWrite["enteredAt"];
} {
  let lifecycle = from;
  let enteredAt: LevelSessionsWrite["enteredAt"] = null;
  const changes: LevelChange[] = [];
  for (const reading of readings) {
    const result = stepMonitorLevel(lifecycle, reading.step);
    for (const transition of result.transitions) {
      const origin = input.originOf(transition.date);
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
        origin,
        evidence: explainMonitorLevel(
          input.level,
          input.frame,
          reading.index,
          transition.exitRuleId,
        ),
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
          reconstructed: origin === "HISTORY",
        };
      }
      changes.push(change);
    }
    if (result.transitions.length > 0) {
      enteredAt = { observationDate: reading.step.date, price: reading.price };
    }
    lifecycle = result.next;
  }
  return { changes, lifecycle, enteredAt };
}

/** The evidence on `date`, when the frame holds that session. */
function evidenceAt(
  level: MonitorStrategyLevel,
  frame: EvaluationFrame,
  date: LocalDate,
  exitRuleId: string | null,
): MonitorTransitionEvidence | undefined {
  const index = frame.dates.indexOf(date);
  return index < 0
    ? undefined
    : explainMonitorLevel(level, frame, index, exitRuleId);
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

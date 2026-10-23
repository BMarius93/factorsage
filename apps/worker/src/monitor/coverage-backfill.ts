import type { MonitorLifecycleState } from "@intrinsic/database";
import type { LocalDate } from "@intrinsic/domain";
import type {
  EvaluationFrame,
  MonitorLevelLifecycle,
  MonitorStrategyLevel,
} from "@intrinsic/strategy";
import type {
  BackfillChange,
  BackfillLevelWrite,
  BackfillSignalRef,
  LevelChange,
  MemberRecord,
  RecordedSignal,
  RecordedTransition,
} from "./monitor-repository.js";
import { decideLevelSessions } from "./session-decision.js";

/**
 * Which of a member's window sessions were never evaluated, and what recording them adds
 * (`docs/decisions/monitor-eod-v2.md` §12.2).
 *
 * A member's recorded evaluation can begin inside its rolling window — a checkpoint written before
 * coverage was recorded, a rebound Monitor whose window replay started after the sessions its
 * previous binding recorded, a restored membership. The missing sessions are decided now exactly as
 * a window replay decides them: the exact state before the first, from the closed history before it,
 * then every session in order through the canonical `stepMonitorLevel`, each change with its
 * evidence. Pure: nothing here reads a clock or a store.
 *
 * Append-only. The canonical history is **reconciled** with what is recorded, never written over it:
 *
 * - **Verified first.** Stepped on through the member's checkpoint, the canonical history must end
 *   in the persisted state, record every change of the sessions already recorded, and contain every
 *   decision recorded for those sessions under this logic. Anything else — sessions an earlier
 *   intraday Monitor decided, data re-based since, logic that differed — is a conflict: nothing is
 *   written, and the member reports the history it has.
 * - **Only what is missing is added.** A change already recorded — by this binding, an earlier
 *   one under the same logic, or an earlier membership — is never recorded twice.
 * - **Occurrences are reused.** A change concerns the occurrence already recorded for it when one is
 *   recorded with the same activation and the same ending; a new occurrence is created only for one
 *   that began and ended inside the missing sessions. An occurrence a reconstruction recorded as its
 *   starting state keeps that `RECONSTRUCTED` change; the session that activated it is recorded
 *   beside it, on the same occurrence.
 */

export type CoveragePlanInput = {
  levels: readonly MonitorStrategyLevel[];
  strategyVersionId: string;
  frame: EvaluationFrame;
  /** The frame begins at the security's first canonical session: a reconstruction is complete. */
  historyComplete: boolean;
  /** The first session the member's recorded evaluation must cover. */
  from: LocalDate;
  /** Whether the member was a current member of the List on a session. */
  monitoredOn: (date: LocalDate) => boolean;
  record: MemberRecord;
};

/** Why a member's missing sessions could not be recorded as they are. */
export type CoverageConflict =
  /** The canonical history does not end in the member's persisted state. */
  | "STATE_DIFFERS"
  /** A change of a session already recorded is not recorded, or one recorded is not canonical. */
  | "RECORDED_DECISION_DIFFERS"
  /** An occurrence the canonical history reaches has no recorded occurrence it can be. */
  | "OCCURRENCE_UNMATCHED"
  /** A level's state belongs to logic that has changed since: decided by the next pass first. */
  | "LOGIC_CHANGED";

export type CoveragePlan =
  | {
      kind: "PLANNED";
      levels: BackfillLevelWrite[];
      /** Missing sessions decided, per level. */
      sessions: number;
    }
  | { kind: "DEEPER_HISTORY" }
  | {
      kind: "CONFLICT";
      reason: CoverageConflict;
      levelId: string;
      session?: LocalDate;
      /**
       * The day after the newest recorded decision that disagrees with the canonical history,
       * when every disagreement lies inside the missing sessions: recording may start there.
       */
      retryFrom?: LocalDate;
    };

/** Both mean nothing is current: a reconstruction stores a level at rest as `INACTIVE`. */
const resting = (state: MonitorLifecycleState): MonitorLifecycleState =>
  state === "RESOLVED" ? "INACTIVE" : state;

export function sameRestingLifecycle(
  left: MonitorLevelLifecycle,
  right: MonitorLevelLifecycle,
): boolean {
  if (
    resting(left.state) !== resting(right.state) ||
    left.since !== right.since
  ) {
    return false;
  }
  const keys = Object.keys(left.rules);
  if (keys.length !== Object.keys(right.rules).length) {
    return false;
  }
  return keys.every((key) => {
    const a = left.rules[key];
    const b = right.rules[key];
    return (
      a !== undefined &&
      b !== undefined &&
      resting(a.state) === resting(b.state) &&
      a.since === b.since &&
      a.triggerDate === b.triggerDate
    );
  });
}

type Fate =
  | { open: true }
  | {
      open: false;
      observationDate: LocalDate;
      reason: RecordedSignal["resolutionReason"];
    };

export function planCoverageBackfill(input: CoveragePlanInput): CoveragePlan {
  const { frame, from, record } = input;
  const coverageStart = record.checkpoint.coverageStart;
  const through = record.checkpoint.evaluatedThrough;
  const sessions: number[] = [];
  for (
    let index = frame.periodStartIndex;
    index < frame.dates.length;
    index += 1
  ) {
    const date = frame.dates[index]!;
    if (date >= from && date <= through && input.monitoredOn(date)) {
      sessions.push(index);
    }
  }
  const missing = sessions.filter(
    (index) => frame.dates[index]! < coverageStart,
  );
  if (missing.length === 0) {
    // No session the security printed lies in between: the window is covered already.
    return { kind: "PLANNED", levels: [], sessions: 0 };
  }

  const levels: BackfillLevelWrite[] = [];
  let retryFrom: LocalDate | undefined;
  let retryLevel: string | undefined;
  for (const level of input.levels) {
    const persisted = record.states.get(level.id) ?? null;
    if (
      persisted !== null &&
      persisted.signalFingerprint !== level.fingerprint
    ) {
      return { kind: "CONFLICT", reason: "LOGIC_CHANGED", levelId: level.id };
    }
    const decision = decideLevelSessions({
      level,
      strategyVersionId: input.strategyVersionId,
      previous: null,
      frame,
      sessions,
      historyComplete: input.historyComplete,
      // Decided now, for sessions nobody was watching for this member: history.
      originOf: () => "HISTORY",
      monitoredOn: input.monitoredOn,
      replay: true,
    });
    if (decision.needsDeeperHistory) {
      return { kind: "DEEPER_HISTORY" };
    }
    const write = decision.write;
    const changes = write?.changes ?? [];
    // The state the window started from, when something was current: `RECONSTRUCTED`, first.
    const anchor =
      changes[0]?.transition.reason === "RECONSTRUCTED"
        ? changes[0]
        : undefined;
    const stepped = anchor ? changes.slice(1) : changes;

    // The canonical history must end exactly where the member is.
    if (persisted === null) {
      if (changes.length > 0) {
        return { kind: "CONFLICT", reason: "STATE_DIFFERS", levelId: level.id };
      }
      continue;
    }
    if (
      write === null ||
      write.lifecycle === null ||
      !sameRestingLifecycle(write.lifecycle, persisted.lifecycle)
    ) {
      return { kind: "CONFLICT", reason: "STATE_DIFFERS", levelId: level.id };
    }

    // What is recorded for this level under this very logic, by any binding or membership.
    const recorded = record.transitions.filter(
      (row) =>
        row.levelId === level.id &&
        row.signalFingerprint === level.fingerprint &&
        row.origin !== "ADMINISTRATIVE" &&
        row.observationDate !== null,
    );
    const decided = recorded.filter((row) => row.reason !== "RECONSTRUCTED");
    const keyOf = (
      date: LocalDate,
      fromState: MonitorLifecycleState,
      to: MonitorLifecycleState,
      reason: string,
    ) => `${date}|${resting(fromState)}|${to}|${reason}`;
    const changeKey = (change: LevelChange) =>
      keyOf(
        change.transition.observationDate!,
        change.transition.from,
        change.transition.to,
        change.transition.reason,
      );
    const decidedKeys = new Set(
      decided.map((row) =>
        keyOf(row.observationDate!, row.fromState, row.toState, row.reason),
      ),
    );
    const canonicalKeys = new Set(stepped.map(changeKey));

    // Every change of a session already recorded must be recorded...
    const unrecorded = stepped.find(
      (change) =>
        change.transition.observationDate! >= coverageStart &&
        !decidedKeys.has(changeKey(change)),
    );
    if (unrecorded) {
      return {
        kind: "CONFLICT",
        reason: "RECORDED_DECISION_DIFFERS",
        levelId: level.id,
        session: unrecorded.transition.observationDate!,
      };
    }
    // ...and every decision recorded for the sessions in question must be canonical.
    const divergent = decided.filter(
      (row) =>
        row.observationDate! >= from &&
        row.observationDate! <= through &&
        !canonicalKeys.has(
          keyOf(row.observationDate!, row.fromState, row.toState, row.reason),
        ),
    );
    if (divergent.some((row) => row.observationDate! >= coverageStart)) {
      return {
        kind: "CONFLICT",
        reason: "RECORDED_DECISION_DIFFERS",
        levelId: level.id,
        session: divergent.find((row) => row.observationDate! >= coverageStart)!
          .observationDate!,
      };
    }
    if (divergent.length > 0) {
      // Recording may still start after the newest of them: the recorded decisions before it are
      // left as they are, and the sessions they cover stay outside the recorded evaluation.
      const newest = divergent
        .map((row) => row.observationDate!)
        .reduce((latest, date) => (date > latest ? date : latest));
      const next = dayAfter(newest);
      if (retryFrom === undefined || next > retryFrom) {
        retryFrom = next;
        retryLevel = level.id;
      }
      continue;
    }

    const planned = reconcileLevel({
      level,
      strategyVersionId: input.strategyVersionId,
      anchor,
      stepped,
      coverageStart,
      recorded,
      decidedKeys,
      changeKey,
      // The occurrence a recorded change of this logic concerns, whatever it recorded itself.
      signals: record.signals.filter((signal) => signal.levelId === level.id),
      activeSignalId: persisted.activeSignalId,
    });
    if ("conflict" in planned) {
      return { kind: "CONFLICT", ...planned.conflict };
    }
    if (planned.write.changes.length > 0) {
      levels.push(planned.write);
    }
  }
  if (retryFrom !== undefined) {
    return {
      kind: "CONFLICT",
      reason: "RECORDED_DECISION_DIFFERS",
      levelId: retryLevel!,
      retryFrom,
    };
  }
  return { kind: "PLANNED", levels, sessions: missing.length };
}

/**
 * The changes one level's missing sessions add, each tied to its occurrence: the one recorded for
 * it when there is one, or one this write adds for an occurrence the missing sessions began and
 * ended.
 */
function reconcileLevel(input: {
  level: MonitorStrategyLevel;
  strategyVersionId: string;
  anchor: LevelChange | undefined;
  stepped: readonly LevelChange[];
  coverageStart: LocalDate;
  recorded: readonly RecordedTransition[];
  decidedKeys: ReadonlySet<string>;
  changeKey: (change: LevelChange) => string;
  signals: readonly RecordedSignal[];
  activeSignalId: string | null;
}):
  | { write: BackfillLevelWrite }
  | {
      conflict: {
        reason: CoverageConflict;
        levelId: string;
        session?: LocalDate;
      };
    } {
  const { level, anchor, stepped, coverageStart } = input;
  const signalsById = new Map(
    input.signals.map((signal) => [signal.id, signal]),
  );
  const all = anchor ? [anchor, ...stepped] : [...stepped];
  /** How the occurrence a change opens ends in the canonical history, through the checkpoint. */
  const fateOf = (opening: LevelChange): Fate => {
    const after = all.slice(all.indexOf(opening) + 1);
    const ending = after.find((change) => change.transition.from === "ACTIVE");
    return ending
      ? {
          open: false,
          observationDate: ending.transition.observationDate!,
          reason: ending.close?.reason ?? ending.transition.reason,
        }
      : { open: true };
  };
  /** Whether a recorded occurrence ended — or not — exactly as the canonical one did. */
  const compatible = (signal: RecordedSignal, fate: Fate): boolean =>
    fate.open
      ? !signal.resolved && signal.id === input.activeSignalId
      : signal.resolved &&
        signal.resolvedObservationDate === fate.observationDate &&
        signal.resolutionReason === fate.reason;
  /** The most recently recorded occurrence entering `state` on `date` that can be this one. */
  const recordedOccurrence = (
    date: LocalDate,
    fate: Fate,
  ): string | undefined => {
    for (const row of [...input.recorded].reverse()) {
      if (
        row.toState === "ACTIVE" &&
        row.observationDate === date &&
        row.signalId !== null
      ) {
        const signal = signalsById.get(row.signalId);
        if (signal && compatible(signal, fate)) {
          return signal.id;
        }
      }
    }
    return undefined;
  };
  const conflict = (session: LocalDate) => ({
    conflict: {
      reason: "OCCURRENCE_UNMATCHED" as const,
      levelId: level.id,
      session,
    },
  });

  const changes: BackfillChange[] = [];
  const signals: BackfillLevelWrite["signals"][number][] = [];
  const toChange = (
    change: LevelChange,
    signal: BackfillSignalRef | null,
  ): BackfillChange => ({
    from: change.transition.from,
    to: change.transition.to,
    reason: change.transition.reason,
    exitRuleId: change.transition.exitRuleId,
    observationDate: change.transition.observationDate!,
    ...(change.evidence ? { evidence: change.evidence } : {}),
    signal,
  });
  /** A new occurrence, for one that began and ended inside the missing sessions — never beyond. */
  const plannedOccurrence = (
    opening: LevelChange,
    fate: Fate,
  ): BackfillSignalRef | null => {
    if (fate.open || fate.observationDate >= coverageStart || !opening.open) {
      return null;
    }
    signals.push({
      observationDate: opening.open.observationDate,
      price: opening.open.price,
      close: { observationDate: fate.observationDate, reason: fate.reason! },
    });
    return { planned: signals.length - 1 };
  };

  let current: BackfillSignalRef | null = null;
  if (anchor) {
    const since = anchor.transition.observationDate!;
    if (anchor.transition.to === "ACTIVE") {
      const fate = fateOf(anchor);
      const existing = recordedOccurrence(since, fate);
      if (existing !== undefined) {
        current = { existing };
      } else {
        current = plannedOccurrence(anchor, fate);
        if (current === null) {
          return conflict(since);
        }
        changes.push(toChange(anchor, current));
      }
    } else if (
      !input.recorded.some(
        (row) =>
          row.toState === anchor.transition.to && row.observationDate === since,
      )
    ) {
      changes.push(toChange(anchor, null));
    }
  }

  for (const change of stepped) {
    const date = change.transition.observationDate!;
    if (date >= coverageStart) {
      break;
    }
    const recorded = input.decidedKeys.has(input.changeKey(change));
    if (change.transition.from === "ACTIVE") {
      if (current === null) {
        return conflict(date);
      }
      if (!recorded) {
        changes.push(toChange(change, current));
      } else if ("planned" in current) {
        // The ending is recorded on another occurrence, the beginning nowhere: no single
        // occurrence can be both, so nothing is recorded.
        return conflict(date);
      }
      current = null;
    }
    if (change.transition.to === "ACTIVE") {
      const fate = fateOf(change);
      const existing = recordedOccurrence(date, fate);
      if (existing !== undefined) {
        current = { existing };
        if (!recorded) {
          changes.push(toChange(change, current));
        }
      } else if (recorded) {
        // The session's decision is recorded, on an occurrence that ended otherwise.
        return conflict(date);
      } else {
        current = plannedOccurrence(change, fate);
        if (current === null) {
          return conflict(date);
        }
        changes.push(toChange(change, current));
      }
      continue;
    }
    if (change.transition.from !== "ACTIVE" && !recorded) {
      changes.push(toChange(change, null));
    }
  }

  return {
    write: {
      levelId: level.id,
      levelKind: level.kind,
      signalFingerprint: level.fingerprint,
      hasTrigger: level.hasTrigger,
      strategyVersionId: input.strategyVersionId,
      signals,
      changes,
    },
  };
}

function dayAfter(date: LocalDate): LocalDate {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

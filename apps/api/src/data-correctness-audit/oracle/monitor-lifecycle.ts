import { and, marketPredicate, type MarketRow, type Tri } from "./predicates";
import type { OracleSignal } from "./strategy-model";

/**
 * The Signal lifecycle, written from `ai/product/monitors.md` ("The signal lifecycle") alone.
 *
 * Per rule (one Signal):
 *
 *   Conditions only:     Conditions TRUE -> ACTIVE; Conditions FALSE -> ACTIVE ends (RESOLVED).
 *   Conditions + Trigger: Conditions TRUE and the Trigger fires -> ACTIVE (latched while the
 *                        Conditions hold); Conditions TRUE without it -> PENDING_TRIGGER;
 *                        any Condition FALSE -> RESOLVED (from ACTIVE) or INACTIVE (from PENDING).
 *   Trigger only:        the Trigger fires -> ACTIVE for that session; a later session ends it,
 *                        and that same later session may fire it again.
 *
 * A closed buy window ends an ACTIVE occurrence and drops a pending setup (BUY levels only).
 * NOT_EVALUABLE moves nothing. FINAL EXIT is ACTIVE while any Exit Rule is, else PENDING_TRIGGER
 * while any is pending.
 *
 * This is the state after replaying every observation in order; the product requires a level with
 * no stored state to be reconstructed from history to exactly this.
 */

export type LifecycleState =
  "INACTIVE" | "PENDING_TRIGGER" | "ACTIVE" | "RESOLVED";

export type RuleState = {
  state: LifecycleState;
  since: string | null;
  activeSince: string | null;
};

export type Observation = {
  row: MarketRow;
  previous: MarketRow | null;
  eligible: boolean;
};

function conditionsOf(
  signal: OracleSignal,
  observation: Observation,
): Tri | null {
  if (signal.conditions.length === 0) {
    return null;
  }
  return and(
    signal.conditions.map((condition) =>
      marketPredicate(condition, false, observation.row, observation.previous),
    ),
  );
}

function triggerOf(signal: OracleSignal, observation: Observation): Tri | null {
  return signal.trigger
    ? marketPredicate(
        signal.trigger,
        true,
        observation.row,
        observation.previous,
      )
    : null;
}

export function stepRule(
  current: RuleState,
  signal: OracleSignal,
  observation: Observation,
): RuleState {
  const date = observation.row.date;
  const conditions = conditionsOf(signal, observation);
  const trigger = triggerOf(signal, observation);
  let state = current.state;
  let since = current.since;
  let activeSince = current.activeSince;
  const end = (): void => {
    if (state === "ACTIVE") {
      state = "RESOLVED";
      since = date;
      activeSince = null;
    } else if (state === "PENDING_TRIGGER") {
      state = "INACTIVE";
      since = date;
    }
  };
  if (!observation.eligible) {
    end();
    return { state, since, activeSince };
  }
  if (conditions === "FALSE") {
    end();
    return { state, since, activeSince };
  }
  if (conditions === null) {
    // Trigger only: the occurrence lives for the session it fired in.
    if (
      state === "ACTIVE" &&
      current.activeSince !== null &&
      date > current.activeSince
    ) {
      end();
    }
    if (trigger === "TRUE") {
      state = "ACTIVE";
      since = date;
      activeSince = date;
    }
    return { state, since, activeSince };
  }
  if (conditions === "NOT_EVALUABLE") {
    return { state, since, activeSince };
  }
  // Conditions TRUE.
  if (state === "ACTIVE") {
    return { state, since, activeSince };
  }
  if (trigger === null || trigger === "TRUE") {
    return { state: "ACTIVE", since: date, activeSince: date };
  }
  if (state !== "PENDING_TRIGGER") {
    return { state: "PENDING_TRIGGER", since: date, activeSince: null };
  }
  return { state, since, activeSince };
}

export function levelState(rules: readonly RuleState[]): LifecycleState {
  if (rules.some((rule) => rule.state === "ACTIVE")) {
    return "ACTIVE";
  }
  if (rules.some((rule) => rule.state === "PENDING_TRIGGER")) {
    return "PENDING_TRIGGER";
  }
  if (rules.some((rule) => rule.state === "RESOLVED")) {
    return "RESOLVED";
  }
  return "INACTIVE";
}

/** Replays every observation; returns each rule's state after the last. */
export function replay(
  signals: readonly OracleSignal[],
  observations: readonly Observation[],
): RuleState[] {
  let states: RuleState[] = signals.map(() => ({
    state: "INACTIVE",
    since: null,
    activeSince: null,
  }));
  for (const observation of observations) {
    states = states.map((state, index) =>
      stepRule(state, signals[index]!, observation),
    );
  }
  return states;
}

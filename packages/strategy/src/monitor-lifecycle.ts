import {
  MONITOR_LIFECYCLE_STATES,
  type MonitorLifecycleState,
  type MonitorTransitionReason,
  type StrategySignal,
} from "@intrinsic/contracts";
import type { LocalDate } from "@intrinsic/domain";
import { Evaluability, evaluabilityAll } from "./evaluability.js";
import type { EvaluationFrame } from "./frame.js";
import type { MonitorStrategyLevel } from "./monitor.js";
import {
  evaluateMarketCondition,
  evaluateMarketTrigger,
} from "./predicates.js";

/**
 * The Monitor signal lifecycle, as one pure reducer.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` section 2 is the product decision; this file is
 * its only implementation. The live cycle and historical reconstruction both fold observations
 * through {@link stepMonitorLevel}, so the two cannot develop separate opinions about when a Signal
 * begins, waits or ends.
 *
 * Three shapes of Strategy signal, each with its own lifecycle:
 *
 * ```text
 * Conditions only       INACTIVE/RESOLVED --true--> ACTIVE --false--> RESOLVED
 * Conditions + Trigger  INACTIVE --true--> PENDING_TRIGGER --fires--> ACTIVE --a Condition false--> RESOLVED
 *                       PENDING_TRIGGER --a Condition false--> INACTIVE (no occurrence existed)
 * Trigger only          INACTIVE/RESOLVED --fires--> ACTIVE --later real session--> RESOLVED
 * ```
 *
 * The Trigger of a Conditions + Trigger Signal is **latched** once it fires: the Conditions alone
 * maintain `ACTIVE`, so the Trigger predicate turning false later — or crossing again — changes
 * nothing. A fresh setup after a resolution requires a fresh Trigger event, which is what
 * `triggerDate` records: the observation date of the crossing the latest occurrence consumed.
 *
 * FINAL EXIT may hold several Exit Rules. Each keeps its own rule-local lifecycle here, and the
 * level's state is their OR: `ACTIVE` when any rule is, otherwise `PENDING_TRIGGER` when any rule
 * is. The level — never a rule — owns the one Signal occurrence, so several rules matching on one
 * observation still produce one Signal.
 */

/** One rule's own lifecycle. BUY and SELL levels have exactly one rule, keyed by the level id. */
export type MonitorRuleLifecycle = {
  state: MonitorLifecycleState;
  /** Observation date the rule entered `state`; null only for the initial state. */
  since: LocalDate | null;
  /** Observation date of the Trigger event the most recent occurrence consumed. */
  triggerDate: LocalDate | null;
};

/** One level's lifecycle: the state the product sees, plus the rule-local state behind it. */
export type MonitorLevelLifecycle = {
  state: MonitorLifecycleState;
  /** Observation date the level entered `state`; null only for the initial state. */
  since: LocalDate | null;
  rules: Readonly<Record<string, MonitorRuleLifecycle>>;
};

export const INITIAL_MONITOR_LEVEL_LIFECYCLE: MonitorLevelLifecycle = {
  state: "INACTIVE",
  since: null,
  rules: {},
};

/**
 * What one rule's predicates evaluated to on one observation.
 *
 * `null` means the rule has no such part — a trigger-only rule has no Conditions, a
 * condition-only rule no Trigger — which is a different statement from `NOT_EVALUABLE`.
 */
export type MonitorRuleObservation = {
  /** The key the rule's lifecycle is stored under. */
  key: string;
  /** The FINAL EXIT Exit Rule id, or null for a BUY or SELL level. Reported on transitions. */
  exitRuleId: string | null;
  conditions: Evaluability | null;
  trigger: Evaluability | null;
};

/** One real observation of one level. A cycle with no observation never produces a step. */
export type MonitorLevelStep = {
  /** The exchange session date observed. */
  date: LocalDate;
  /**
   * Whether new entries are admitted on `date`. Always true for SELL and FINAL EXIT; for BUY it
   * is the member's canonical buy-window eligibility.
   */
  eligible: boolean;
  rules: readonly MonitorRuleObservation[];
};

export type MonitorLifecycleTransition = {
  from: MonitorLifecycleState;
  to: MonitorLifecycleState;
  reason: MonitorTransitionReason;
  exitRuleId: string | null;
  date: LocalDate;
};

export type MonitorLevelStepResult = {
  next: MonitorLevelLifecycle;
  /** Level state changes only, in order. Never an `X -> X` row. */
  transitions: MonitorLifecycleTransition[];
  /** The occurrence that was active before this step ended, and why. */
  closed: { reason: MonitorTransitionReason } | null;
  /** A new occurrence began. */
  opened: boolean;
  /** Whether anything durable — level or rule-local — differs from the input. */
  changed: boolean;
};

type RuleStep = {
  afterClose: MonitorRuleLifecycle;
  afterOpen: MonitorRuleLifecycle;
  closeReason: MonitorTransitionReason | null;
  openReason: MonitorTransitionReason | null;
};

/**
 * The lifecycle of a rule the stored level does not describe yet.
 *
 * Only a level persisted before rule-local state existed reaches this: a level written by this
 * reducer always stores every rule. Each such rule inherits the level's state, which converges on
 * the next decided observation — a condition rule that no longer holds resolves, an event rule
 * resolves on the next session — without inventing an occurrence.
 */
function inheritedRule(level: MonitorLevelLifecycle): MonitorRuleLifecycle {
  switch (level.state) {
    case "ACTIVE":
      return { state: "ACTIVE", since: level.since, triggerDate: level.since };
    case "PENDING_TRIGGER":
      return {
        state: "PENDING_TRIGGER",
        since: level.since,
        triggerDate: null,
      };
    default:
      return { state: level.state, since: level.since, triggerDate: null };
  }
}

function stepRule(
  rule: MonitorRuleLifecycle,
  observation: MonitorRuleObservation,
  date: LocalDate,
  eligible: boolean,
): RuleStep {
  // A reading of a session older than the one the rule already moved on never moves it back.
  if (rule.since !== null && date < rule.since) {
    return {
      afterClose: rule,
      afterOpen: rule,
      closeReason: null,
      openReason: null,
    };
  }
  const hasConditions = observation.conditions !== null;
  const hasTrigger = observation.trigger !== null;

  // Close phase: everything that can end what is current.
  let closeTo: MonitorLifecycleState | null = null;
  let closeReason: MonitorTransitionReason | null = null;
  if (!eligible) {
    // Buy-window gating is decided whatever the predicates say: the list itself refuses the date.
    if (rule.state === "ACTIVE") {
      closeTo = "RESOLVED";
    } else if (rule.state === "PENDING_TRIGGER") {
      closeTo = "INACTIVE";
    }
    closeReason = "BUY_WINDOW_CLOSED";
  } else if (hasConditions) {
    if (observation.conditions === Evaluability.FALSE) {
      if (rule.state === "ACTIVE") {
        closeTo = "RESOLVED";
      } else if (rule.state === "PENDING_TRIGGER") {
        closeTo = "INACTIVE";
      }
    }
    closeReason = "CONDITIONS_ENDED";
  } else if (
    rule.state === "ACTIVE" &&
    (rule.since === null || date > rule.since)
  ) {
    // A trigger-only event lives for the session it fired in. Any real later session ends it —
    // including one whose predicates cannot be decided — and nothing else does.
    closeTo = "RESOLVED";
    closeReason = "EVENT_SESSION_ENDED";
  }
  let current: MonitorRuleLifecycle =
    closeTo === null ? rule : { ...rule, state: closeTo, since: date };
  if (closeTo === null) {
    closeReason = null;
  }
  const afterClose = current;

  // Open phase: everything that can begin a setup or an occurrence.
  let openReason: MonitorTransitionReason | null = null;
  if (eligible && current.state !== "ACTIVE") {
    const freshTrigger =
      observation.trigger === Evaluability.TRUE &&
      (current.triggerDate === null || date > current.triggerDate);
    if (!hasConditions) {
      if (freshTrigger) {
        current = { state: "ACTIVE", since: date, triggerDate: date };
        openReason = "TRIGGER_FIRED";
      }
    } else if (observation.conditions === Evaluability.TRUE) {
      if (!hasTrigger) {
        current = { ...current, state: "ACTIVE", since: date };
        openReason = "CONDITIONS_MET";
      } else if (freshTrigger) {
        current = { state: "ACTIVE", since: date, triggerDate: date };
        openReason = "TRIGGER_FIRED";
      } else if (current.state !== "PENDING_TRIGGER") {
        current = { ...current, state: "PENDING_TRIGGER", since: date };
        openReason = "SETUP_STARTED";
      }
    }
  }
  return { afterClose, afterOpen: current, closeReason, openReason };
}

function levelOf(
  rules: readonly MonitorRuleLifecycle[],
): "ACTIVE" | "PENDING_TRIGGER" | null {
  if (rules.some((rule) => rule.state === "ACTIVE")) {
    return "ACTIVE";
  }
  if (rules.some((rule) => rule.state === "PENDING_TRIGGER")) {
    return "PENDING_TRIGGER";
  }
  return null;
}

/**
 * Applies one real observation to one level.
 *
 * Resolution is decided before activation, so a trigger-only event that is superseded by a new
 * crossing on the next session produces two transitions — the old occurrence ends, a new one
 * begins — rather than silently continuing.
 */
export function stepMonitorLevel(
  previous: MonitorLevelLifecycle,
  step: MonitorLevelStep,
): MonitorLevelStepResult {
  const steps = step.rules.map((observation) =>
    stepRule(
      previous.rules[observation.key] ?? inheritedRule(previous),
      observation,
      step.date,
      step.eligible,
    ),
  );

  const prior = previous.state;
  const closedAggregate = levelOf(steps.map((entry) => entry.afterClose));
  let afterClose: MonitorLifecycleState = prior;
  if (prior === "ACTIVE" && closedAggregate !== "ACTIVE") {
    afterClose = "RESOLVED";
  } else if (prior === "PENDING_TRIGGER" && closedAggregate === null) {
    afterClose = "INACTIVE";
  }
  const afterOpen: MonitorLifecycleState =
    levelOf(steps.map((entry) => entry.afterOpen)) ?? afterClose;
  // Another rule taking over on the observation the last active one ended is the same occurrence:
  // the level was never without a match. Only a rule that itself ended and re-fired — a
  // trigger-only event superseded by the next session's crossing — begins a new one.
  if (
    prior === "ACTIVE" &&
    afterClose === "RESOLVED" &&
    afterOpen === "ACTIVE" &&
    steps.some(
      (entry) =>
        entry.openReason !== null &&
        entry.closeReason === null &&
        entry.afterOpen.state === "ACTIVE",
    )
  ) {
    afterClose = "ACTIVE";
  }

  // The reason a level state ended is the reason of a rule that ended that same state.
  const closeIndex = steps.findIndex((entry, index) => {
    const before =
      previous.rules[step.rules[index]!.key] ?? inheritedRule(previous);
    return entry.closeReason !== null && before.state === prior;
  });
  const closeReason = closeIndex >= 0 ? steps[closeIndex]!.closeReason : null;
  const closeRule = closeIndex >= 0 ? step.rules[closeIndex] : undefined;
  const openIndex = steps.findIndex(
    (entry) => entry.openReason !== null && entry.afterOpen.state === afterOpen,
  );

  let transitions: MonitorLifecycleTransition[] = [];
  if (afterClose !== prior && closeReason !== null) {
    transitions.push({
      from: prior,
      to: afterClose,
      reason: closeReason,
      exitRuleId: closeRule?.exitRuleId ?? null,
      date: step.date,
    });
  }
  if (afterOpen !== afterClose && openIndex >= 0) {
    transitions.push({
      from: afterClose,
      to: afterOpen,
      reason: steps[openIndex]!.openReason!,
      exitRuleId: step.rules[openIndex]!.exitRuleId,
      date: step.date,
    });
  }
  // One pending rule breaking while another starts its own setup is not a level change.
  if (
    prior === "PENDING_TRIGGER" &&
    afterClose === "INACTIVE" &&
    afterOpen === "PENDING_TRIGGER"
  ) {
    transitions = [];
  }

  const state = transitions.length > 0 ? afterOpen : prior;
  const rules: Record<string, MonitorRuleLifecycle> = {};
  step.rules.forEach((observation, index) => {
    rules[observation.key] = steps[index]!.afterOpen;
  });
  const next: MonitorLevelLifecycle = {
    state,
    since: transitions.length > 0 ? step.date : previous.since,
    rules,
  };
  const closed =
    prior === "ACTIVE" && afterClose === "RESOLVED" && closeReason !== null
      ? { reason: closeReason }
      : null;
  return {
    next,
    transitions,
    closed,
    opened: afterOpen === "ACTIVE" && afterClose !== "ACTIVE",
    changed: !sameLifecycle(previous, next),
  };
}

/** Structural equality of two lifecycles, rules included, independent of key order. */
export function sameLifecycle(
  left: MonitorLevelLifecycle,
  right: MonitorLevelLifecycle,
): boolean {
  if (left.state !== right.state || left.since !== right.since) {
    return false;
  }
  const leftKeys = Object.keys(left.rules);
  if (leftKeys.length !== Object.keys(right.rules).length) {
    return false;
  }
  return leftKeys.every((key) => {
    const a = left.rules[key];
    const b = right.rules[key];
    return (
      a !== undefined &&
      b !== undefined &&
      a.state === b.state &&
      a.since === b.since &&
      a.triggerDate === b.triggerDate
    );
  });
}

/**
 * Evaluates a level's rules separately into Conditions and Trigger on one frame index.
 *
 * The lifecycle needs the two apart — the Conditions maintain a latched occurrence the Trigger
 * began — but each half is still the canonical predicate evaluation: `evaluateMarketSignal` is
 * exactly the AND of these two results. Only market-derived levels reach here;
 * `monitorStrategyLevels` has already excluded every level that needs a position.
 */
export function observeMonitorLevel(
  level: Pick<MonitorStrategyLevel, "kind" | "rules" | "ruleIds">,
  frame: EvaluationFrame,
  index: number,
): MonitorRuleObservation[] {
  return level.rules.map((signal, position) => ({
    key: level.ruleIds[position]!,
    exitRuleId: level.kind === "FINAL_EXIT" ? level.ruleIds[position]! : null,
    ...observeSignal(signal, frame, index),
  }));
}

function observeSignal(
  signal: StrategySignal,
  frame: EvaluationFrame,
  index: number,
): Pick<MonitorRuleObservation, "conditions" | "trigger"> {
  return {
    conditions:
      signal.conditions.length === 0
        ? null
        : evaluabilityAll(
            signal.conditions.map((condition) =>
              evaluateMarketCondition(condition, frame, index),
            ),
          ),
    trigger: signal.trigger
      ? evaluateMarketTrigger(signal.trigger, frame, index)
      : null,
  };
}

/**
 * Folds a run of historical observations through the lifecycle, starting from nothing.
 *
 * This is the reconstruction mode: it establishes where a level stands — including whether a
 * setup's Trigger already fired — from the same evaluator and the same reducer the live cycle
 * uses, and it reports only the final lifecycle. Nothing in between is history a customer should
 * see; the caller persists the result, never the intermediate steps.
 */
export function replayMonitorLevel(
  steps: Iterable<MonitorLevelStep>,
  initial: MonitorLevelLifecycle = INITIAL_MONITOR_LEVEL_LIFECYCLE,
): MonitorLevelLifecycle {
  let current = initial;
  for (const step of steps) {
    current = stepMonitorLevel(current, step).next;
  }
  return current;
}

const LIFECYCLE_STATES = new Set<string>(MONITOR_LIFECYCLE_STATES);
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads persisted rule-local lifecycle (`MonitorSignalState.ruleStates`). Anything malformed is
 * dropped rather than trusted: a missing rule inherits the level's own state, which is the
 * documented safe fallback.
 */
export function parseMonitorRuleStates(
  value: unknown,
): Record<string, MonitorRuleLifecycle> {
  const rules: Record<string, MonitorRuleLifecycle> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return rules;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const since = dateOrNull(entry.since);
    const triggerDate = dateOrNull(entry.triggerDate);
    if (
      typeof entry.state !== "string" ||
      !LIFECYCLE_STATES.has(entry.state) ||
      since === undefined ||
      triggerDate === undefined
    ) {
      continue;
    }
    rules[key] = {
      state: entry.state as MonitorLifecycleState,
      since,
      triggerDate,
    };
  }
  return rules;
}

function dateOrNull(field: unknown): LocalDate | null | undefined {
  if (field === null) {
    return null;
  }
  return typeof field === "string" && LOCAL_DATE.test(field)
    ? field
    : undefined;
}

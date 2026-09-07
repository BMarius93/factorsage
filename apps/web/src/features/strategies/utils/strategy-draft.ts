import {
  BUY_LEVEL_PERCENTAGES,
  STRATEGY_SCHEMA_VERSION,
  SELL_LEVEL_PERCENTAGES,
  checkStrategyValue,
  conditionOperatorsFor,
  defaultConditionOperatorFor,
  defaultTriggerOperatorFor,
  defaultValueFor,
  emptyStrategyDefinition,
  strategyMetricOptions,
  strategyMetricSeriesId,
  triggerOperatorsFor,
  type ConditionOperator,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyDetailResponse,
  type StrategyDraft,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategySignal,
  type StrategyTrigger,
  type StrategyValue,
  type TriggerOperator,
} from "@intrinsic/contracts";

/**
 * The Strategy Builder draft and its pure reducer.
 *
 * Every option, operator, limit, label and compatibility rule comes from `@intrinsic/contracts`.
 * Nothing here decides what a valid strategy is; it decides how an edit moves the document from
 * one valid shape to another.
 *
 * Cascading resets live here rather than in components, which is what makes an invalid
 * intermediate state unreachable rather than merely flagged: choosing a Metric that does not
 * support the current operator replaces the operator, and a Value the new Metric cannot be
 * compared with is replaced by that Metric's default.
 */
export type StrategyDraftState = {
  readonly name: string;
  /** Always a string so the textarea stays controlled; trimmed to `undefined` when saved. */
  readonly description: string;
  readonly definition: StrategyDefinition;
};

/** Addresses one level. `levelIndex` is absent for FINAL EXIT, which is a single level. */
export type LevelRef = {
  readonly levelKind: StrategyLevelKind;
  readonly levelIndex?: number;
};

/** Addresses one Condition or the Trigger inside a level, mirroring `StrategyIssuePath`. */
export type PredicateRef = LevelRef & {
  readonly part: "CONDITION" | "TRIGGER";
  readonly conditionIndex?: number;
};

export type StrategyDraftAction =
  | { type: "setName"; name: string }
  | { type: "setDescription"; description: string }
  | { type: "addLevel"; levelKind: StrategyLevelKind }
  | { type: "removeLevel"; ref: LevelRef }
  | { type: "moveLevel"; ref: LevelRef; direction: -1 | 1 }
  | { type: "setPercentage"; ref: LevelRef; percentage: number }
  | { type: "addCondition"; ref: LevelRef }
  | { type: "removeCondition"; ref: PredicateRef }
  | { type: "addTrigger"; ref: LevelRef }
  | { type: "removeTrigger"; ref: LevelRef }
  | { type: "setMetric"; ref: PredicateRef; metric: StrategyMetric }
  | { type: "setOperator"; ref: PredicateRef; operator: string }
  | { type: "setValue"; ref: PredicateRef; value: StrategyValue }
  | { type: "reset"; draft: StrategyDraftState };

let localIdCounter = 0;

/**
 * A stable client-generated row id.
 *
 * Ids must be unique across a definition — the canonical validator rejects a collision — so this
 * combines the platform's UUID where available with a counter that cannot repeat within a session.
 */
export function newRowId(prefix: string): string {
  localIdCounter += 1;
  const unique =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${localIdCounter}-${unique}`;
}

/** The first Metric the registry offers for a level kind: `Price` in every V1 level. */
function firstMetricFor(levelKind: StrategyLevelKind): StrategyMetric {
  const [first] = strategyMetricOptions(levelKind);
  // The registry always offers at least Price in every level kind.
  return first?.metric ?? { kind: "PRICE" };
}

function newCondition(levelKind: StrategyLevelKind): StrategyCondition {
  const metric = firstMetricFor(levelKind);
  return {
    id: newRowId("condition"),
    metric,
    operator: defaultConditionOperatorFor(metric),
    value: defaultValueFor(metric) ?? { kind: "PERCENT", value: 0 },
  };
}

function newTrigger(levelKind: StrategyLevelKind): StrategyTrigger {
  const metric = firstMetricFor(levelKind);
  return {
    id: newRowId("trigger"),
    metric,
    operator: defaultTriggerOperatorFor(metric),
    value: defaultValueFor(metric) ?? { kind: "PERCENT", value: 0 },
  };
}

/** A new level opens with one usable Condition rather than an empty, already-invalid signal. */
function newSignal(levelKind: StrategyLevelKind): StrategySignal {
  return { conditions: [newCondition(levelKind)] };
}

export function emptyDraft(): StrategyDraftState {
  return { name: "", description: "", definition: emptyStrategyDefinition() };
}

/** The draft a saved strategy is edited from. */
export function draftFrom(
  strategy: StrategyDetailResponse,
): StrategyDraftState {
  return {
    name: strategy.name,
    description: strategy.description ?? "",
    definition: strategy.definition,
  };
}

/**
 * Replaces an operator or Value the new Metric cannot carry.
 *
 * Compatibility is asked of the registry through `checkStrategyValue`, never re-decided here.
 */
function reconcile(
  part: "CONDITION" | "TRIGGER",
  metric: StrategyMetric,
  operator: string,
  value: StrategyValue,
): { operator: string; value: StrategyValue } {
  const supported: readonly string[] =
    part === "TRIGGER"
      ? triggerOperatorsFor(metric)
      : conditionOperatorsFor(metric);
  const nextOperator = supported.includes(operator)
    ? operator
    : (supported[0] ?? operator);
  const nextValue = checkStrategyValue(metric, value).compatible
    ? value
    : (defaultValueFor(metric) ?? value);
  return { operator: nextOperator, value: nextValue };
}

function mapSignal(
  signal: StrategySignal,
  ref: PredicateRef,
  change: (row: StrategyCondition | StrategyTrigger) => {
    metric: StrategyMetric;
    operator: string;
    value: StrategyValue;
  },
): StrategySignal {
  if (ref.part === "TRIGGER") {
    if (!signal.trigger) {
      return signal;
    }
    const next = change(signal.trigger);
    return {
      ...signal,
      trigger: {
        ...signal.trigger,
        metric: next.metric,
        operator: next.operator as TriggerOperator,
        value: next.value,
      },
    };
  }
  return {
    ...signal,
    conditions: signal.conditions.map((row, index) =>
      index === ref.conditionIndex
        ? (() => {
            const next = change(row);
            return {
              ...row,
              metric: next.metric,
              operator: next.operator as ConditionOperator,
              value: next.value,
            };
          })()
        : row,
    ),
  };
}

function levelsOf(
  definition: StrategyDefinition,
  levelKind: StrategyLevelKind,
) {
  return levelKind === "BUY" ? definition.buyLevels : definition.sellLevels;
}

/** Applies `change` to the signal the ref points at, leaving every other level untouched. */
function withSignal(
  definition: StrategyDefinition,
  ref: LevelRef,
  change: (signal: StrategySignal) => StrategySignal,
): StrategyDefinition {
  if (ref.levelKind === "FINAL_EXIT") {
    return definition.finalExit
      ? {
          ...definition,
          finalExit: {
            ...definition.finalExit,
            signal: change(definition.finalExit.signal),
          },
        }
      : definition;
  }
  const key = ref.levelKind === "BUY" ? "buyLevels" : "sellLevels";
  return {
    ...definition,
    [key]: levelsOf(definition, ref.levelKind).map((level, index) =>
      index === ref.levelIndex
        ? { ...level, signal: change(level.signal) }
        : level,
    ),
  } as StrategyDefinition;
}

export function strategyDraftReducer(
  state: StrategyDraftState,
  action: StrategyDraftAction,
): StrategyDraftState {
  switch (action.type) {
    case "reset":
      return action.draft;

    case "setName":
      return { ...state, name: action.name };

    case "setDescription":
      return { ...state, description: action.description };

    case "addLevel": {
      const definition = state.definition;
      if (action.levelKind === "FINAL_EXIT") {
        return definition.finalExit
          ? state
          : {
              ...state,
              definition: {
                ...definition,
                finalExit: {
                  id: newRowId("exit"),
                  signal: newSignal("FINAL_EXIT"),
                },
              },
            };
      }
      const key = action.levelKind === "BUY" ? "buyLevels" : "sellLevels";
      const percentage =
        action.levelKind === "BUY"
          ? BUY_LEVEL_PERCENTAGES[0]
          : SELL_LEVEL_PERCENTAGES[0];
      return {
        ...state,
        definition: {
          ...definition,
          [key]: [
            ...levelsOf(definition, action.levelKind),
            {
              id: newRowId(action.levelKind.toLowerCase()),
              percentage,
              signal: newSignal(action.levelKind),
            },
          ],
        } as StrategyDefinition,
      };
    }

    case "removeLevel": {
      const definition = state.definition;
      if (action.ref.levelKind === "FINAL_EXIT") {
        // Rebuilt without the key rather than set to undefined, so the saved document carries no
        // empty `finalExit` field.
        return {
          ...state,
          definition: {
            schemaVersion: STRATEGY_SCHEMA_VERSION,
            buyLevels: definition.buyLevels,
            sellLevels: definition.sellLevels,
          },
        };
      }
      const key = action.ref.levelKind === "BUY" ? "buyLevels" : "sellLevels";
      return {
        ...state,
        definition: {
          ...definition,
          [key]: levelsOf(definition, action.ref.levelKind).filter(
            (_level, index) => index !== action.ref.levelIndex,
          ),
        } as StrategyDefinition,
      };
    }

    case "moveLevel": {
      const { levelKind, levelIndex } = action.ref;
      if (levelKind === "FINAL_EXIT" || levelIndex === undefined) {
        return state;
      }
      const levels = [...levelsOf(state.definition, levelKind)];
      const target = levelIndex + action.direction;
      const moved = levels[levelIndex];
      const displaced = levels[target];
      if (!moved || !displaced) {
        return state;
      }
      levels[levelIndex] = displaced;
      levels[target] = moved;
      const key = levelKind === "BUY" ? "buyLevels" : "sellLevels";
      return {
        ...state,
        definition: {
          ...state.definition,
          [key]: levels,
        } as StrategyDefinition,
      };
    }

    case "setPercentage": {
      const { levelKind, levelIndex } = action.ref;
      if (levelKind === "FINAL_EXIT") {
        // FINAL EXIT has no percentage; the type makes this unrepresentable in a saved document.
        return state;
      }
      const key = levelKind === "BUY" ? "buyLevels" : "sellLevels";
      return {
        ...state,
        definition: {
          ...state.definition,
          [key]: levelsOf(state.definition, levelKind).map((level, index) =>
            index === levelIndex
              ? { ...level, percentage: action.percentage }
              : level,
          ),
        } as StrategyDefinition,
      };
    }

    case "addCondition":
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) => ({
          ...signal,
          conditions: [
            ...signal.conditions,
            newCondition(action.ref.levelKind),
          ],
        })),
      };

    case "removeCondition":
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) => ({
          ...signal,
          conditions: signal.conditions.filter(
            (_row, index) => index !== action.ref.conditionIndex,
          ),
        })),
      };

    case "addTrigger":
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) =>
          signal.trigger
            ? signal
            : { ...signal, trigger: newTrigger(action.ref.levelKind) },
        ),
      };

    case "removeTrigger":
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) => ({
          conditions: signal.conditions,
        })),
      };

    case "setMetric":
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) =>
          mapSignal(signal, action.ref, (row) => ({
            metric: action.metric,
            ...reconcile(
              action.ref.part,
              action.metric,
              row.operator,
              row.value,
            ),
          })),
        ),
      };

    case "setOperator":
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) =>
          mapSignal(signal, action.ref, (row) => ({
            metric: row.metric,
            ...reconcile(
              action.ref.part,
              row.metric,
              action.operator,
              row.value,
            ),
          })),
        ),
      };

    case "setValue":
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) =>
          mapSignal(signal, action.ref, (row) => ({
            metric: row.metric,
            operator: row.operator,
            value: action.value,
          })),
        ),
      };
  }
}

/** The strategy a draft would save, with a blank description dropped. */
export function draftPayload(draft: StrategyDraftState): StrategyDraft {
  const description = draft.description.trim();
  return {
    name: draft.name.trim(),
    ...(description === "" ? {} : { description }),
    definition: draft.definition,
  };
}

/** A key for a metric option, used only to address a `<select>` option. */
export function metricKey(metric: StrategyMetric): string {
  return `${metric.kind}:${strategyMetricSeriesId(metric) ?? ""}`;
}

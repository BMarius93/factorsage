import {
  BUY_LEVEL_PERCENTAGES,
  STRATEGY_MAX_EXIT_RULES,
  STRATEGY_SCHEMA_VERSION,
  SELL_LEVEL_PERCENTAGES,
  checkStrategyValue,
  conditionOperatorsFor,
  defaultConditionOperatorFor,
  defaultStrategyMetric,
  defaultTriggerOperatorFor,
  defaultValueFor,
  emptyStrategyDefinition,
  strategyMetricCategory,
  triggerOperatorsFor,
  type ConditionOperator,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyDetailResponse,
  type StrategyDraft,
  type StrategyExitRule,
  type StrategyLevelKind,
  type StrategyMetric,
  type StrategyMetricCategoryId,
  type StrategyPredicatePart,
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
 *
 * A row's category is never stored. It is a property of its metric (`strategyMetricCategory`), so
 * the two controls that choose them can never disagree, and changing the category is nothing but
 * installing that category's first metric.
 */
export type StrategyDraftState = {
  readonly name: string;
  /** Always a string so the textarea stays controlled; trimmed to `undefined` when saved. */
  readonly description: string;
  readonly definition: StrategyDefinition;
};

/**
 * Addresses one Signal in the document.
 *
 * `levelIndex` is absent for FINAL EXIT, which is a single level. `ruleIndex` is present **only**
 * for FINAL EXIT, and says which of its Exit Rules owns the Signal — the two are never both set,
 * which is what keeps OR out of BUY and SELL by construction rather than by a guard.
 */
export type LevelRef = {
  readonly levelKind: StrategyLevelKind;
  readonly levelIndex?: number;
  readonly ruleIndex?: number;
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
  | { type: "addExitRule" }
  | { type: "removeExitRule"; ruleIndex: number }
  | { type: "moveLevel"; ref: LevelRef; direction: -1 | 1 }
  | { type: "setPercentage"; ref: LevelRef; percentage: number }
  | { type: "addCondition"; ref: LevelRef }
  | { type: "removeCondition"; ref: PredicateRef }
  | { type: "addTrigger"; ref: LevelRef }
  | { type: "removeTrigger"; ref: LevelRef }
  | {
      type: "setCategory";
      ref: PredicateRef;
      category: StrategyMetricCategoryId;
    }
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

/**
 * The Metric a new row starts from: the first metric of the first category the registry offers for
 * this level kind and half of a Signal — `Price` in every V1 level.
 */
function firstMetricFor(
  levelKind: StrategyLevelKind,
  part: StrategyPredicatePart,
): StrategyMetric {
  // The registry offers Price in every level kind and both halves of a Signal.
  return defaultStrategyMetric(levelKind, part) ?? { kind: "PRICE" };
}

function newCondition(levelKind: StrategyLevelKind): StrategyCondition {
  const metric = firstMetricFor(levelKind, "CONDITION");
  return {
    id: newRowId("condition"),
    metric,
    operator: defaultConditionOperatorFor(metric),
    value: defaultValueFor(metric) ?? { kind: "PERCENT", value: 0 },
  };
}

function newTrigger(levelKind: StrategyLevelKind): StrategyTrigger {
  const metric = firstMetricFor(levelKind, "TRIGGER");
  return {
    id: newRowId("trigger"),
    metric,
    operator: defaultTriggerOperatorFor(metric),
    value: defaultValueFor(metric) ?? { kind: "PERCENT", value: 0 },
  };
}

/**
 * A new level opens with one complete Condition row: the first category's first metric, with that
 * metric's default operator and Value. There is never a row without a valid category and metric —
 * a new row is an ordinary rule the user edits, and validation judges it like any other (a row
 * repeating another is reported as a duplicate once touched or saved).
 */
function newSignal(levelKind: StrategyLevelKind): StrategySignal {
  return { conditions: [newCondition(levelKind)] };
}

/** A new Exit Rule: its own identity and one Condition row, exactly as a new level has. */
function newExitRule(): StrategyExitRule {
  return { id: newRowId("exit-rule"), signal: newSignal("FINAL_EXIT") };
}

/** The row a predicate ref points at, if it exists. */
export function rowAt(
  definition: StrategyDefinition,
  ref: PredicateRef,
): StrategyCondition | StrategyTrigger | undefined {
  const signal =
    ref.levelKind === "FINAL_EXIT"
      ? definition.finalExit?.rules[ref.ruleIndex ?? 0]?.signal
      : levelsOf(definition, ref.levelKind)[ref.levelIndex ?? -1]?.signal;
  if (!signal) {
    return undefined;
  }
  return ref.part === "TRIGGER"
    ? signal.trigger
    : signal.conditions[ref.conditionIndex ?? -1];
}

/**
 * The row with this id, wherever in the document it sits now.
 *
 * Unlike a `PredicateRef`, an id survives the removal of a row or level before it: the canonical
 * validator keeps predicate ids unique across a definition, and no edit of a row changes its own.
 */
export function rowWithId(
  definition: StrategyDefinition,
  rowId: string,
): StrategyCondition | StrategyTrigger | undefined {
  const signals = [
    ...definition.buyLevels.map((level) => level.signal),
    ...definition.sellLevels.map((level) => level.signal),
    ...(definition.finalExit?.rules.map((rule) => rule.signal) ?? []),
  ];
  for (const signal of signals) {
    const row =
      signal.conditions.find((condition) => condition.id === rowId) ??
      (signal.trigger?.id === rowId ? signal.trigger : undefined);
    if (row) {
      return row;
    }
  }
  return undefined;
}

export function emptyDraft(): StrategyDraftState {
  return {
    name: "",
    description: "",
    definition: emptyStrategyDefinition(),
  };
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

/** The metric's own starting rule: its default operator for this half of a Signal, and its default Value. */
function freshRule(
  part: "CONDITION" | "TRIGGER",
  metric: StrategyMetric,
  value: StrategyValue,
): { operator: string; value: StrategyValue } {
  return {
    operator:
      part === "TRIGGER"
        ? defaultTriggerOperatorFor(metric)
        : defaultConditionOperatorFor(metric),
    value: defaultValueFor(metric) ?? value,
  };
}

/**
 * Replaces an operator or Value the new Metric cannot carry.
 *
 * Compatibility is asked of the registry through `checkStrategyValue`, never re-decided here. A
 * Value that survives keeps the operator it was written with. A Value that cannot survive is
 * replaced **together with** the operator: the replacement is the metric's own starting rule, and
 * pairing a kept operator with it can say nothing at all — `Price is below SMA 200D` would become
 * `Insider buyers is below 0`, which no session can ever satisfy.
 */
function reconcile(
  part: "CONDITION" | "TRIGGER",
  metric: StrategyMetric,
  operator: string,
  value: StrategyValue,
): { operator: string; value: StrategyValue } {
  if (!checkStrategyValue(metric, value).compatible) {
    return freshRule(part, metric, value);
  }
  const supported: readonly string[] =
    part === "TRIGGER"
      ? triggerOperatorsFor(metric)
      : conditionOperatorsFor(metric);
  return {
    operator: supported.includes(operator)
      ? operator
      : (supported[0] ?? operator),
    value,
  };
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
    const finalExit = definition.finalExit;
    if (!finalExit) {
      return definition;
    }
    // Only the addressed rule is rebuilt; every other rule keeps its identity, so editing rule 1
    // cannot touch rule 2 and React never re-keys a row the user did not edit.
    const target = ref.ruleIndex ?? 0;
    return {
      ...definition,
      finalExit: {
        ...finalExit,
        rules: finalExit.rules.map((rule, index) =>
          index === target ? { ...rule, signal: change(rule.signal) } : rule,
        ),
      },
    };
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

/** The draft reducer: every edit a user can make to the name, the description and the document. */
export function strategyDraftReducer(
  state: StrategyDraftState,
  action: StrategyDraftAction,
): StrategyDraftState {
  return documentReducer(state, action);
}

function documentReducer(
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
                  rules: [newExitRule()],
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

    case "addExitRule": {
      const finalExit = state.definition.finalExit;
      if (!finalExit || finalExit.rules.length >= STRATEGY_MAX_EXIT_RULES) {
        return state;
      }
      return {
        ...state,
        definition: {
          ...state.definition,
          finalExit: { ...finalExit, rules: [...finalExit.rules, newExitRule()] },
        },
      };
    }

    case "removeExitRule": {
      const finalExit = state.definition.finalExit;
      // The last rule is never removed: FINAL EXIT with no way to match is not a document the
      // product allows, and removing FINAL EXIT itself is the action that means that.
      if (!finalExit || finalExit.rules.length <= 1) {
        return state;
      }
      return {
        ...state,
        definition: {
          ...state.definition,
          finalExit: {
            ...finalExit,
            rules: finalExit.rules.filter(
              (_rule, index) => index !== action.ruleIndex,
            ),
          },
        },
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

    case "setCategory": {
      // A category is chosen by installing its first metric as that metric's own starting rule:
      // default configuration, default operator, default Value. A category change changes what the
      // rule measures, so nothing of the previous rule means anything any more — not its
      // configuration, and not a threshold written in another unit (an insider count of 1 is not
      // an RSI level of 1).
      const row = rowAt(state.definition, action.ref);
      if (!row || strategyMetricCategory(row.metric) === action.category) {
        return state;
      }
      const metric = defaultStrategyMetric(
        action.ref.levelKind,
        action.ref.part,
        action.category,
      );
      if (!metric) {
        return state;
      }
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) =>
          mapSignal(signal, action.ref, (current) => ({
            metric,
            ...freshRule(action.ref.part, metric, current.value),
          })),
        ),
      };
    }

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

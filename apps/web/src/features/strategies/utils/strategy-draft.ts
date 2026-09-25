import {
  BUY_LEVEL_PERCENTAGES,
  STRATEGY_MAX_EXIT_RULES,
  STRATEGY_SCHEMA_VERSION,
  SELL_LEVEL_PERCENTAGES,
  checkStrategyValue,
  conditionOperatorsFor,
  defaultConditionOperatorFor,
  defaultTriggerOperatorFor,
  defaultValueFor,
  emptyStrategyDefinition,
  strategyMetricOptions,
  strategyMetricKey,
  triggerOperatorsFor,
  type ConditionOperator,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyDetailResponse,
  type StrategyDraft,
  type StrategyExitRule,
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
  /**
   * Rows the user added but has not chosen a Metric for yet (UI-013).
   *
   * The canonical document has no "no metric" value — every Condition and Trigger names one — so a
   * freshly added row carries a placeholder there, and its id is listed here until the user picks
   * a Metric. A listed row authors no logic: validation asks for its Metric instead of judging the
   * placeholder, the logic preview leaves it out, and the draft cannot be saved while one remains.
   * The persisted document, its semantics and its fingerprint are untouched by this, because an
   * unset row can never be saved.
   */
  readonly unset: readonly string[];
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

/**
 * A new level opens with one Condition row waiting for its Metric — a place to start, not a rule
 * the user did not choose. It used to open as the complete rule "Price is above SMA 20D", so every
 * "+ Add" authored real, and often duplicate, logic (UI-013).
 */
function newSignal(levelKind: StrategyLevelKind): StrategySignal {
  return { conditions: [newCondition(levelKind)] };
}

/** A new Exit Rule: its own identity and one Condition row waiting for its Metric. */
function newExitRule(): StrategyExitRule {
  return { id: newRowId("exit-rule"), signal: newSignal("FINAL_EXIT") };
}

/** Every Condition and Trigger row id in a signal. */
function rowIdsOf(signal: StrategySignal): string[] {
  return [
    ...signal.conditions.map((row) => row.id),
    ...(signal.trigger ? [signal.trigger.id] : []),
  ];
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
 * The document with every unset row left out: what the user has actually authored so far. The
 * logic preview reads this, so a row waiting for its Metric is never described as a rule.
 */
export function authoredDefinition(
  state: Pick<StrategyDraftState, "definition" | "unset">,
): StrategyDefinition {
  if (state.unset.length === 0) {
    return state.definition;
  }
  const unset = new Set(state.unset);
  const strip = (signal: StrategySignal): StrategySignal => ({
    conditions: signal.conditions.filter((row) => !unset.has(row.id)),
    ...(signal.trigger && !unset.has(signal.trigger.id)
      ? { trigger: signal.trigger }
      : {}),
  });
  const definition = state.definition;
  return {
    ...definition,
    buyLevels: definition.buyLevels.map((level) => ({
      ...level,
      signal: strip(level.signal),
    })),
    sellLevels: definition.sellLevels.map((level) => ({
      ...level,
      signal: strip(level.signal),
    })),
    ...(definition.finalExit
      ? {
          finalExit: {
            ...definition.finalExit,
            rules: definition.finalExit.rules.map((rule) => ({
              ...rule,
              signal: strip(rule.signal),
            })),
          },
        }
      : {}),
  };
}

export function emptyDraft(): StrategyDraftState {
  return {
    name: "",
    description: "",
    definition: emptyStrategyDefinition(),
    unset: [],
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
    unset: [],
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

/**
 * The draft reducer: the document edit, plus the bookkeeping of which rows are still unset.
 *
 * A row becomes unset when an "+ Add" action creates it and stops being unset when the user picks
 * its Metric. Ids of rows that were removed simply fall out of the list.
 */
export function strategyDraftReducer(
  state: StrategyDraftState,
  action: StrategyDraftAction,
): StrategyDraftState {
  if (action.type === "reset") {
    return action.draft;
  }
  const next = documentReducer(state, action);
  if (next === state) {
    return state;
  }
  const before = new Set(allRowIds(state.definition));
  const after = allRowIds(next.definition);
  const created = after.filter((id) => !before.has(id));
  const present = new Set(after);
  let unset = [...state.unset, ...created].filter((id) => present.has(id));
  if (action.type === "setMetric") {
    const chosen = rowAt(next.definition, action.ref)?.id;
    unset = unset.filter((id) => id !== chosen);
  }
  return { ...next, unset };
}

function allRowIds(definition: StrategyDefinition): string[] {
  return [
    ...definition.buyLevels.flatMap((level) => rowIdsOf(level.signal)),
    ...definition.sellLevels.flatMap((level) => rowIdsOf(level.signal)),
    ...(definition.finalExit?.rules.flatMap((rule) => rowIdsOf(rule.signal)) ??
      []),
  ];
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

/**
 * A key for a metric option, used only to address a `<select>` option.
 *
 * The encoding belongs to `@intrinsic/contracts`, beside the metric union it has to keep up with:
 * not every metric is parameterized by a catalog id, and a key built from `seriesId` alone would
 * collapse the three Relative Volume periods onto one option.
 */
export function metricKey(metric: StrategyMetric): string {
  return strategyMetricKey(metric);
}

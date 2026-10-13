import {
  BUY_LEVEL_PERCENTAGES,
  STRATEGY_MAX_EXIT_RULES,
  STRATEGY_SCHEMA_VERSION,
  SELL_LEVEL_PERCENTAGES,
  asAlternativeDataMetric,
  buildAlternativeDataMetric,
  checkStrategyValue,
  conditionOperatorsFor,
  defaultConditionOperatorFor,
  defaultStrategyMetric,
  defaultTriggerOperatorFor,
  defaultValueFor,
  emptyStrategyDefinition,
  strategyMetricCategory,
  strategyMetricKey,
  strategyMetricLabel,
  strategyMetricOptions,
  strategyMetricSource,
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
 * the Metric picker — which shows a category, then that category's metrics — can never hold a
 * category and a metric that disagree. Browsing a category changes nothing; choosing a metric is
 * one `chooseMetric` edit.
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
  | { type: "chooseMetric"; ref: PredicateRef; metric: StrategyMetric }
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

/**
 * The chosen metric, carrying the configuration of the one it replaces when both are measures of the
 * same alternative-data family.
 *
 * Every Insider measure takes the same lookback and role filter, and every Congressional measure the
 * same lookback, scope, chamber and owner filters — the configuration's shape belongs to the family,
 * never to the measure, and the canonical validator accepts any of it on any measure of that family.
 * So `Insider sellers · 180D · CEO, CFO` becomes `Insider buyers · 180D · CEO, CFO` rather than
 * silently dropping what the user narrowed. Anything else — another family, a market metric — has
 * no configuration in common and starts from the chosen metric's own defaults.
 */
function withCarriedConfiguration(
  previous: StrategyMetric,
  chosen: StrategyMetric,
): StrategyMetric {
  const from = asAlternativeDataMetric(previous);
  const to = asAlternativeDataMetric(chosen);
  if (from?.kind === "INSIDER_ACTIVITY" && to?.kind === "INSIDER_ACTIVITY") {
    return buildAlternativeDataMetric({ ...from, measure: to.measure });
  }
  if (from?.kind === "CONGRESS_ACTIVITY" && to?.kind === "CONGRESS_ACTIVITY") {
    return buildAlternativeDataMetric({ ...from, measure: to.measure });
  }
  return chosen;
}

/**
 * Whether the registry offers this metric's identity — under its own data source — in the ref's
 * level kind and half of a Signal. An ETF-sourced metric is asked of that ETF's menu, so a
 * stock-only metric handed an ETF, or any ETF metric handed to a Trigger, is simply not offered.
 */
function isOffered(ref: PredicateRef, metric: StrategyMetric): boolean {
  const key = strategyMetricKey(metric);
  return strategyMetricOptions(
    ref.levelKind,
    ref.part,
    strategyMetricSource(metric),
  ).some((option) => strategyMetricKey(option.metric) === key);
}

/** The three things a rule row holds besides its identity. */
type RuleFields = {
  metric: StrategyMetric;
  operator: string;
  value: StrategyValue;
};

/**
 * What choosing `chosen` makes of one row, or `null` when the choice changes nothing.
 *
 * The one statement of the Metric picker's edit, read by the reducer that applies it and by the row
 * that has to say what it did — so the outcome a row announces is the outcome the document took.
 *
 * - The row's own metric again changes nothing, so reopening the picker and confirming the current
 *   choice can never reset a configuration. Nor does a metric the registry does not offer there.
 * - Another category is a category change: the chosen metric's own starting rule, because a
 *   threshold written for another family means nothing here.
 * - Another metric of the same category keeps whatever operator and Value it can still take
 *   (`reconcile`), and a measure of the same alternative-data family keeps the configuration.
 *
 * A change of **data source** is the same edit: the picker hands over the row's own identity under
 * the new source (`strategyMetricUnderSource`), which is another metric of the same category — so
 * `RSI 14D is above 50` becomes `XLK · RSI 14D is above 50` untouched, while `Price is below
 * Balanced` becomes `XLK · Price` at its own starting rule, since an intrinsic value is not a Value
 * an ETF's Price can be compared with.
 */
export function chooseMetricOutcome(
  ref: PredicateRef,
  row: RuleFields,
  chosen: StrategyMetric,
): RuleFields | null {
  if (
    !isOffered(ref, chosen) ||
    strategyMetricKey(row.metric) === strategyMetricKey(chosen)
  ) {
    return null;
  }
  const crossesCategory =
    strategyMetricCategory(row.metric) !== strategyMetricCategory(chosen);
  const metric = crossesCategory
    ? chosen
    : withCarriedConfiguration(row.metric, chosen);
  return {
    metric,
    ...(crossesCategory
      ? freshRule(ref.part, metric, row.value)
      : reconcile(ref.part, metric, row.operator, row.value)),
  };
}

function sameValue(left: StrategyValue, right: StrategyValue): boolean {
  if (left.kind === "SERIES" || right.kind === "SERIES") {
    return (
      left.kind === "SERIES" &&
      right.kind === "SERIES" &&
      left.seriesId === right.seriesId
    );
  }
  return left.kind === right.kind && Object.is(left.value, right.value);
}

/** Which of a row's two other fields a change of metric or data source could not keep. */
export type MetricChangeResets = {
  readonly operator: boolean;
  readonly value: boolean;
};

/** What one change of metric or data source replaced: the row before it against the row after. */
export function metricChangeResets(
  before: RuleFields,
  after: RuleFields,
): MetricChangeResets {
  return {
    operator: before.operator !== after.operator,
    value: !sameValue(before.value, after.value),
  };
}

/**
 * The resets of several changes made one after another, as one: a Value replaced by the first is
 * still a replaced Value after a second change that kept everything — moving a rule from the stock
 * to `XLF` and on to `GLD` must not retract the notice the first step raised.
 */
export function mergeMetricChangeResets(
  earlier: MetricChangeResets | null,
  later: MetricChangeResets,
): MetricChangeResets | null {
  const merged = {
    operator: (earlier?.operator ?? false) || later.operator,
    value: (earlier?.value ?? false) || later.value,
  };
  return merged.operator || merged.value ? merged : null;
}

/**
 * What changes of metric or data source replaced in a row, in words, or `null` when the row kept
 * both its operator and its Value. `metric` is the one the row holds now: the sentence names the
 * rule as it reads today, not as it read when the reset happened.
 *
 * A change that cannot keep them resets them to the new metric's own starting rule — that is the
 * reducer's job — and this is what makes the reset **visible**: the row prints the sentence, so a
 * threshold is never swapped out behind the user's back
 * (`docs/decisions/strategy-etf-conditions-v1.md` §4.6).
 */
export function metricResetNotice(
  part: "CONDITION" | "TRIGGER",
  resets: MetricChangeResets | null,
  metric: StrategyMetric,
): string | null {
  if (!resets || (!resets.operator && !resets.value)) {
    return null;
  }
  const operatorName = part === "TRIGGER" ? "Trigger" : "Condition";
  const what =
    resets.operator && resets.value
      ? `${operatorName} and value were`
      : resets.operator
        ? `${operatorName} was`
        : "Value was";
  return `${what} reset to match ${strategyMetricLabel(metric)}.`;
}

/** {@link metricResetNotice} for one change: the row before it against the row after. */
export function metricChangeNotice(
  part: "CONDITION" | "TRIGGER",
  before: RuleFields,
  after: RuleFields,
): string | null {
  return metricResetNotice(
    part,
    metricChangeResets(before, after),
    after.metric,
  );
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

    case "chooseMetric": {
      // What the Metric picker dispatches: one choice that may cross a category or a data source.
      // `chooseMetricOutcome` is the whole rule.
      const row = rowAt(state.definition, action.ref);
      const outcome = row
        ? chooseMetricOutcome(action.ref, row, action.metric)
        : null;
      if (!outcome) {
        return state;
      }
      return {
        ...state,
        definition: withSignal(state.definition, action.ref, (signal) =>
          mapSignal(signal, action.ref, () => outcome),
        ),
      };
    }

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

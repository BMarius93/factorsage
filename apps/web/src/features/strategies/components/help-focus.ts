import type {
  ConditionOperator,
  StrategyLevelKind,
  StrategyMetric,
  TriggerOperator,
} from "@intrinsic/contracts";

/**
 * What the explanation surface should describe right now.
 *
 * UI-only state, kept out of the draft so typing in a row does not re-render the whole editor. It
 * carries identities, never text: the words come from the canonical help metadata in contracts.
 */
export type HelpFocus =
  | { kind: "METRIC"; metric: StrategyMetric }
  | { kind: "OPERATOR"; operator: ConditionOperator | TriggerOperator }
  | { kind: "LEVEL"; levelKind: StrategyLevelKind }
  | null;

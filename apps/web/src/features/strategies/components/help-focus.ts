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
 *
 * `origin` names the row the focus came from. Desktop ignores it and renders one panel beside the
 * editor; mobile uses it to place the same explanation directly below the row being edited, which
 * is where a phone user can actually read it. Same semantics, different placement.
 */
export type HelpSubject =
  | { kind: "METRIC"; metric: StrategyMetric }
  | { kind: "OPERATOR"; operator: ConditionOperator | TriggerOperator }
  | { kind: "LEVEL"; levelKind: StrategyLevelKind };

export type HelpFocus = (HelpSubject & { origin?: string }) | null;

/** A stable key for one predicate row, used only to match a focus to its origin. */
export function rowOriginKey(
  levelKind: string,
  levelIndex: number | undefined,
  part: string,
  conditionIndex: number | undefined,
): string {
  return `${levelKind}|${levelIndex ?? ""}|${part}|${conditionIndex ?? ""}`;
}

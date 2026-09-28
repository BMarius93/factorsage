import type {
  ConditionOperator,
  StrategyCondition,
  StrategyDefinition,
  StrategyLevelKind,
  StrategyMetric,
  StrategyTrigger,
  StrategyValue,
  TriggerOperator,
} from "@intrinsic/contracts";
import { rowWithId } from "../utils/strategy-draft";

/**
 * What the explanation surface describes: resolved content, never a place.
 *
 * It carries identities, never text: the words come from the canonical help metadata in contracts.
 */
export type HelpSubject =
  | { kind: "METRIC"; metric: StrategyMetric }
  | { kind: "OPERATOR"; operator: ConditionOperator | TriggerOperator }
  /**
   * The third field: the series a rule compares against.
   *
   * A Value is the same object as a Metric wherever the product offers it as both, so this is the
   * identity and the panel reads the same canonical entry for it. Only a `SERIES` Value is ever
   * described — a typed threshold explains itself and has no canonical help.
   */
  | { kind: "VALUE"; value: StrategyValue }
  | { kind: "LEVEL"; levelKind: StrategyLevelKind };

/** The three controls of a rule row the explanation can follow. */
export type HelpField = "METRIC" | "OPERATOR" | "VALUE";

/**
 * What the explanation surface should follow right now: a **rule**, never a copy of what is in it.
 *
 * UI-only state, kept out of the draft so typing in a row does not re-render the whole editor. A row
 * field is addressed by the row's id and read back from the draft whenever the explanation is drawn,
 * so a change made anywhere else — a Configure dialog applying a new lookback, a category change
 * reconciling the operator — is described the moment it happens, instead of the copy taken when the
 * field was focused. An id rather than a position, so removing a rule or level before the focused
 * one never hands the explanation to whichever rule moves into its place.
 *
 * Desktop renders one panel beside the editor; mobile uses `rowId` to place the same explanation
 * directly below the row being edited. Same semantics, different placement.
 */
export type HelpFocus =
  | { kind: "FIELD"; rowId: string; field: HelpField }
  | { kind: "LEVEL"; levelKind: StrategyLevelKind }
  | null;

/** What one field of a row holds now, or `null` when it has nothing canonical to explain. */
export function subjectOfRow(
  row: StrategyCondition | StrategyTrigger,
  field: HelpField,
): HelpSubject | null {
  switch (field) {
    case "METRIC":
      return { kind: "METRIC", metric: row.metric };
    case "OPERATOR":
      return { kind: "OPERATOR", operator: row.operator };
    case "VALUE":
      return row.value.kind === "SERIES"
        ? { kind: "VALUE", value: row.value }
        : null;
  }
}

/**
 * Resolves a focus against the current document.
 *
 * `null` when nothing is focused, when the focused row no longer exists, or when the focused field
 * holds nothing canonical to explain; the Builder then falls back to its default subject.
 */
export function resolveHelpSubject(
  focus: HelpFocus,
  definition: StrategyDefinition,
): HelpSubject | null {
  if (!focus) {
    return null;
  }
  if (focus.kind === "LEVEL") {
    return focus;
  }
  const row = rowWithId(definition, focus.rowId);
  return row ? subjectOfRow(row, focus.field) : null;
}

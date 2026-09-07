import type {
  StrategyIssuePath,
  StrategyValidationIssue,
} from "@intrinsic/contracts";

/**
 * Groups the canonical validator's issues so each control can ask for its own.
 *
 * One validator drives both the inline field errors here and the API's 400 body, which only works
 * because every issue is path-addressed. This file turns those paths into lookup keys; it never
 * decides what an issue is.
 */
export type StrategyIssueLookup = ReadonlyMap<
  string,
  readonly StrategyValidationIssue[]
>;

export function strategyIssueKey(path: StrategyIssuePath): string {
  return [
    path.levelKind ?? "",
    path.levelIndex ?? "",
    path.part,
    path.conditionIndex ?? "",
    path.field ?? "",
  ].join("|");
}

export function groupStrategyIssues(
  issues: readonly StrategyValidationIssue[],
): StrategyIssueLookup {
  const grouped = new Map<string, StrategyValidationIssue[]>();
  for (const issue of issues) {
    const key = strategyIssueKey(issue.path);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(issue);
    } else {
      grouped.set(key, [issue]);
    }
  }
  return grouped;
}

export function issuesAt(
  lookup: StrategyIssueLookup,
  path: StrategyIssuePath,
): readonly StrategyValidationIssue[] {
  return lookup.get(strategyIssueKey(path)) ?? [];
}

/**
 * The message a control should show, or `null` when it has none or should stay quiet.
 *
 * A field's issue appears once that field is touched or a save has been attempted: an empty
 * builder must not open to a wall of red.
 */
export function messageAt(
  lookup: StrategyIssueLookup,
  path: StrategyIssuePath,
  revealed: boolean,
): string | null {
  if (!revealed) {
    return null;
  }
  return issuesAt(lookup, path)[0]?.message ?? null;
}

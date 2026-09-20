"use client";

import { validateStrategy } from "@intrinsic/contracts";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import {
  draftPayload,
  rowAt,
  strategyDraftReducer,
  type StrategyDraftAction,
  type StrategyDraftState,
} from "../utils/strategy-draft";
import {
  groupStrategyIssues,
  strategyIssueKey,
  type StrategyIssueLookup,
} from "../utils/strategy-issues";
import type {
  StrategyDefinition,
  StrategyIssuePath,
  StrategySignal,
  StrategyValidationIssue,
} from "@intrinsic/contracts";

export type StrategyDraftBinding = {
  readonly draft: StrategyDraftState;
  readonly dispatch: (action: StrategyDraftAction) => void;
  readonly issues: StrategyIssueLookup;
  readonly issueCount: number;
  readonly dirty: boolean;
  /** True once a save has been attempted; before that, only touched fields show their issue. */
  readonly saveAttempted: boolean;
  /**
   * True once the user has touched a field or tried to save. Until then the issue count stays
   * neutral: a blank builder must not greet anyone with red "2 issues to fix" (UI-013).
   */
  readonly interacted: boolean;
  readonly markSaveAttempted: () => void;
  readonly touch: (path: StrategyIssuePath) => void;
  readonly isRevealed: (path: StrategyIssuePath) => boolean;
  /** Adopts a saved response as the new clean baseline. */
  readonly markSaved: (draft: StrategyDraftState) => void;
};

/**
 * React binding for the pure draft reducer.
 *
 * Validation is derived, never stored: it is the canonical `validateStrategy` over the current
 * draft, so no component holds a rule and the Builder cannot disagree with the API. Touched fields
 * and save attempts are UI state kept separate from the document.
 */
export function useStrategyDraft(
  initial: StrategyDraftState,
): StrategyDraftBinding {
  const [draft, dispatch] = useReducer(strategyDraftReducer, initial);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [saveAttempted, setSaveAttempted] = useState(false);
  const baselineRef = useRef(initial);

  const issueList = useMemo(() => draftIssues(draft), [draft]);
  const issues = useMemo(() => groupStrategyIssues(issueList), [issueList]);

  const touch = useCallback((path: StrategyIssuePath) => {
    const key = strategyIssueKey(path);
    setTouched((current) =>
      current.has(key) ? current : new Set([...current, key]),
    );
  }, []);

  const isRevealed = useCallback(
    (path: StrategyIssuePath) =>
      saveAttempted || touched.has(strategyIssueKey(path)),
    [saveAttempted, touched],
  );

  const markSaved = useCallback((saved: StrategyDraftState) => {
    baselineRef.current = saved;
    setSaveAttempted(false);
    setTouched(new Set());
    dispatch({ type: "reset", draft: saved });
  }, []);

  const dirty = useMemo(
    () =>
      JSON.stringify(draftPayload(draft)) !==
      JSON.stringify(draftPayload(baselineRef.current)),
    [draft],
  );

  return {
    draft,
    dispatch,
    issues,
    issueCount: issueList.length,
    dirty,
    saveAttempted,
    interacted: saveAttempted || touched.size > 0,
    markSaveAttempted: useCallback(() => setSaveAttempted(true), []),
    touch,
    isRevealed,
    markSaved,
  };
}

/**
 * The canonical validator's issues for a draft, with rows still waiting for a Metric judged as
 * exactly that.
 *
 * An unset row carries a placeholder the user never chose, so any issue about that placeholder —
 * a duplicate of another placeholder, an operator it happens to carry — would blame the user for
 * logic they did not write. Those issues are replaced by one: "Choose a metric."
 */
export function draftIssues(
  draft: StrategyDraftState,
): readonly StrategyValidationIssue[] {
  const canonical = validateStrategy(draftPayload(draft));
  if (draft.unset.length === 0) {
    return canonical;
  }
  const unset = new Set(draft.unset);
  const isUnsetRow = (path: StrategyIssuePath) =>
    (path.part === "CONDITION" || path.part === "TRIGGER") &&
    unset.has(
      rowAt(draft.definition, {
        levelKind: path.levelKind ?? "BUY",
        ...(path.levelIndex === undefined
          ? {}
          : { levelIndex: path.levelIndex }),
        ...(path.ruleIndex === undefined ? {} : { ruleIndex: path.ruleIndex }),
        part: path.part,
        ...(path.conditionIndex === undefined
          ? {}
          : { conditionIndex: path.conditionIndex }),
      })?.id ?? "",
    );
  const ruleHasUnset = (path: StrategyIssuePath) =>
    path.part === "EXIT_RULE" &&
    path.ruleIndex !== undefined &&
    signalHasUnset(
      draft.definition.finalExit?.rules[path.ruleIndex]?.signal,
      unset,
    );
  const kept = canonical.filter(
    (issue) => !isUnsetRow(issue.path) && !ruleHasUnset(issue.path),
  );
  return [...kept, ...unsetIssues(draft.definition, unset)];
}

function signalHasUnset(
  signal: StrategySignal | undefined,
  unset: ReadonlySet<string>,
): boolean {
  return (
    signal !== undefined &&
    (signal.conditions.some((row) => unset.has(row.id)) ||
      (signal.trigger !== undefined && unset.has(signal.trigger.id)))
  );
}

function unsetIssues(
  definition: StrategyDefinition,
  unset: ReadonlySet<string>,
): StrategyValidationIssue[] {
  const issues: StrategyValidationIssue[] = [];
  const visit = (
    signal: StrategySignal,
    base: Pick<StrategyIssuePath, "levelKind" | "levelIndex" | "ruleIndex">,
  ) => {
    signal.conditions.forEach((row, conditionIndex) => {
      if (unset.has(row.id)) {
        issues.push(
          chooseMetric({ ...base, part: "CONDITION", conditionIndex }),
        );
      }
    });
    if (signal.trigger && unset.has(signal.trigger.id)) {
      issues.push(chooseMetric({ ...base, part: "TRIGGER" }));
    }
  };
  definition.buyLevels.forEach((level, levelIndex) =>
    visit(level.signal, { levelKind: "BUY", levelIndex }),
  );
  definition.sellLevels.forEach((level, levelIndex) =>
    visit(level.signal, { levelKind: "SELL", levelIndex }),
  );
  definition.finalExit?.rules.forEach((rule, ruleIndex) =>
    visit(rule.signal, { levelKind: "FINAL_EXIT", ruleIndex }),
  );
  return issues;
}

function chooseMetric(
  path: Omit<StrategyIssuePath, "field">,
): StrategyValidationIssue {
  return {
    // The canonical code list has no "not chosen yet": it only ever sees saved documents. The
    // message and the path are what the Builder shows.
    code: "SHAPE_INVALID",
    path: { ...path, field: "METRIC" },
    message: "Choose a metric.",
  };
}

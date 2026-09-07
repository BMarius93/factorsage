"use client";

import { validateStrategy } from "@intrinsic/contracts";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import {
  draftPayload,
  strategyDraftReducer,
  type StrategyDraftAction,
  type StrategyDraftState,
} from "../utils/strategy-draft";
import {
  groupStrategyIssues,
  strategyIssueKey,
  type StrategyIssueLookup,
} from "../utils/strategy-issues";
import type { StrategyIssuePath } from "@intrinsic/contracts";

export type StrategyDraftBinding = {
  readonly draft: StrategyDraftState;
  readonly dispatch: (action: StrategyDraftAction) => void;
  readonly issues: StrategyIssueLookup;
  readonly issueCount: number;
  readonly dirty: boolean;
  /** True once a save has been attempted; before that, only touched fields show their issue. */
  readonly saveAttempted: boolean;
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

  const issueList = useMemo(
    () => validateStrategy(draftPayload(draft)),
    [draft],
  );
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
    markSaveAttempted: useCallback(() => setSaveAttempted(true), []),
    touch,
    isRevealed,
    markSaved,
  };
}

"use client";

import {
  STRATEGY_LEVEL_LABELS,
  STRATEGY_MAX_BUY_LEVELS,
  STRATEGY_MAX_SELL_LEVELS,
  type StrategyDetailResponse,
  type StrategySignal,
} from "@intrinsic/contracts";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { OverflowMenu } from "../../../components/ui/OverflowMenu";
import { RunBacktestLink } from "../../backtests/components/RunBacktestLink";
import { PageContainer } from "../../../components/layout/PageContainer";
import { PageHeader } from "../../../components/ui/PageHeader";
import forms from "../../../components/ui/forms.module.css";
import { useUnsavedChangesGuard } from "../../../components/layout/unsaved-changes";
import { ApiError } from "../../../lib/api/client";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import {
  createStrategy,
  deleteStrategy,
  replaceStrategyDefinition,
  strategyIssuesFrom,
  updateStrategy,
} from "../api/strategies-api";
import { useStrategyDraft } from "../hooks/use-strategy-draft";
import {
  authoredDefinition,
  draftFrom,
  draftPayload,
  emptyDraft,
  type StrategyDraftAction,
  type StrategyDraftState,
} from "../utils/strategy-draft";
import { UnsetRowsContext } from "./unset-rows";
import { ExplanationPanel } from "./ExplanationPanel";
import type { HelpFocus } from "./help-focus";
import { LogicPreview } from "./LogicPreview";
import panel from "./ExplanationPanel.module.css";
import { FinalExitCard } from "./FinalExitCard";
import { LevelSection } from "./LevelSection";
import { BuiltInEditNotice } from "../../../components/ui/BuiltInEditNotice";
import { useDocumentTitle } from "../../../lib/use-document-title";
import styles from "./StrategyBuilder.module.css";
import { StrategyDetailsCard } from "./StrategyDetailsCard";

/** Asked before an in-app navigation would discard the draft. */
const UNSAVED_CHANGES_PROMPT =
  "This strategy has unsaved changes. Leave the page and discard them?";

type StrategyBuilderProps = {
  /** Absent when creating; the saved strategy when editing. */
  readonly strategy?: StrategyDetailResponse;
};

/**
 * Create and edit share one builder, because they edit the same document.
 *
 * Save is explicit and never automatic: a strategy is a coherent document, and autosaving would
 * persist incoherent intermediate states and churn the version history. Editing saves identity and
 * logic separately, because a rename is not a change of strategy and must not append a version.
 */
export function StrategyBuilder({ strategy }: StrategyBuilderProps) {
  const router = useRouter();
  const [saved, setSaved] = useState<StrategyDetailResponse | undefined>(
    strategy,
  );
  useDocumentTitle(saved?.name);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focus, setFocus] = useState<HelpFocus>(null);

  const binding = useStrategyDraft(
    strategy ? draftFrom(strategy) : emptyDraft(),
  );
  const {
    draft,
    dispatch: dispatchDraft,
    issues,
    issueCount,
    dirty,
    interacted,
    isRevealed,
    touch,
    markSaveAttempted,
    markSaved,
  } = binding;
  const [undo, setUndo] = useState<{
    readonly label: string;
    readonly draft: StrategyDraftState;
  } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const unsetRows = useMemo(() => new Set(draft.unset), [draft.unset]);

  /**
   * Every edit goes through here. Removing a level or an Exit Rule that holds authored logic is
   * recoverable (UI-014): the draft as it was is kept until the next edit, and the save bar offers
   * "Undo". Removal itself stays one neutral click, never a red button at rest.
   */
  const dispatch = (action: StrategyDraftAction) => {
    const removal = removalLabel(draft, action);
    setUndo(removal ? { label: removal, draft } : null);
    dispatchDraft(action);
  };

  // Leaving with unsaved work is almost always a mistake, so both a reload and an in-app
  // navigation ask first. Nothing is autosaved or stashed: staying keeps the draft in memory,
  // leaving discards it.
  useUnsavedChangesGuard(dirty, UNSAVED_CHANGES_PROMPT);

  const definition = draft.definition;
  const canSave = dirty && issueCount === 0 && !pending;

  /**
   * What the explanation panel describes before anything is focused: the first rule in the
   * document, which is the one a reader's eye lands on anyway.
   */
  const authored = authoredDefinition(draft);
  const firstRow =
    authored.buyLevels[0]?.signal.conditions[0] ??
    authored.buyLevels[0]?.signal.trigger;
  const shownFocus: HelpFocus =
    focus ?? (firstRow ? { kind: "METRIC", metric: firstRow.metric } : null);

  const save = async () => {
    markSaveAttempted();
    if (issueCount > 0 || pending) {
      return;
    }
    setPending(true);
    setSaveError(null);
    const payload = draftPayload(draft);

    try {
      if (!saved) {
        const created = await createStrategy(payload);
        setSaved(created);
        setUndo(null);
        markSaved(draftFrom(created));
        router.replace(`/strategies/${created.id}`);
        return;
      }

      let latest = saved;
      const identityChanged =
        payload.name !== saved.name ||
        (payload.description ?? null) !== (saved.description ?? null);
      if (identityChanged) {
        const summary = await updateStrategy(saved.id, {
          name: payload.name,
          description: payload.description ?? null,
        });
        latest = { ...latest, ...summary, definition: latest.definition };
      }
      if (
        JSON.stringify(payload.definition) !== JSON.stringify(saved.definition)
      ) {
        latest = await replaceStrategyDefinition(saved.id, payload.definition);
      }
      setSaved(latest);
      // A saved document is the new baseline; an Undo from before it would silently revert a save.
      setUndo(null);
      markSaved(draftFrom(latest));
    } catch (error) {
      const rejected = strategyIssuesFrom(error);
      setSaveError(
        rejected.length > 0
          ? (rejected[0]?.message ??
              "The strategy was rejected. Check the highlighted rows.")
          : error instanceof ApiError && error.status === 404
            ? "This strategy no longer exists."
            : requestFailureMessage(
                error,
                "The strategy could not be saved right now. Try again in a moment.",
              ),
      );
      setPending(false);
      return;
    }
    setPending(false);
  };

  const applyDraft = (next: StrategyDraftState) => {
    setUndo(null);
    dispatchDraft({ type: "reset", draft: next });
  };

  /**
   * A disabled Save button with no explanation is a dead end, so the issue count is the way out:
   * it reveals every issue and moves focus to the first one in document order.
   */
  const revealIssues = () => {
    markSaveAttempted();
    requestAnimationFrame(() => {
      const first = document.querySelector<HTMLElement>(
        '[data-testid="strategy-builder"] [aria-invalid="true"]',
      );
      // `scrollIntoView` is absent in some non-browser DOM implementations; focus alone is enough
      // for keyboard and assistive-technology users, so it must not be able to throw.
      if (typeof first?.scrollIntoView === "function") {
        first.scrollIntoView({ block: "center" });
      }
      first?.focus();
    });
  };

  return (
    <PageContainer>
      <UnsetRowsContext.Provider value={unsetRows}>
        <div className={styles.builder} data-testid="strategy-builder">
          <div className={styles.editor}>
            <PageHeader
              variant="plain"
              back={{ href: "/strategies", label: "Strategies" }}
              // An existing strategy is named by its name, not by what the page does with it
              // (UI-015); "Edit strategy" was also the rename dialog's title.
              title={saved ? saved.name : "New strategy"}
              lead="Buy, sell and final-exit logic. A backtest decides which stocks and how much capital to run it with — a strategy never does."
              {...(saved
                ? {
                    actions: (
                      <>
                        {/* Runs the saved version: unsaved edits are not part of any backtest. */}
                        <RunBacktestLink
                          prefill={{ strategyId: saved.id }}
                          testId="strategy-run-backtest"
                        />
                        <OverflowMenu
                          label={saved.name}
                          testId="strategy-editor-actions"
                          items={[
                            {
                              // The name is edited in place, in the Details card; Rename takes the
                              // user there rather than opening a second editor for the same field.
                              label: "Rename",
                              onSelect: () => {
                                const input =
                                  document.getElementById("strategy-name");
                                input?.focus();
                                (input as HTMLInputElement | null)?.select();
                              },
                            },
                            {
                              label: "Delete",
                              tone: "danger",
                              separated: true,
                              onSelect: () => setDeleting(true),
                            },
                          ]}
                        />
                      </>
                    ),
                  }
                : {})}
            />
            {strategy?.ownership === "SYSTEM" ? (
              <BuiltInEditNotice thing="strategy" />
            ) : null}

            <StrategyDetailsCard
              name={draft.name}
              description={draft.description}
              issues={issues}
              isRevealed={isRevealed}
              touch={touch}
              onNameChange={(name) => dispatch({ type: "setName", name })}
              onDescriptionChange={(description) =>
                dispatch({ type: "setDescription", description })
              }
            />

            <LevelSection
              levelKind="BUY"
              levels={definition.buyLevels}
              atLimit={definition.buyLevels.length >= STRATEGY_MAX_BUY_LEVELS}
              issues={issues}
              isRevealed={isRevealed}
              touch={touch}
              dispatch={dispatch}
              onFocusHelp={setFocus}
              focus={focus}
            />

            <LevelSection
              levelKind="SELL"
              levels={definition.sellLevels}
              atLimit={definition.sellLevels.length >= STRATEGY_MAX_SELL_LEVELS}
              issues={issues}
              isRevealed={isRevealed}
              touch={touch}
              dispatch={dispatch}
              onFocusHelp={setFocus}
              focus={focus}
            />

            <section
              className={styles.section}
              data-testid="section-FINAL_EXIT"
            >
              <header className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle} data-tone="FINAL_EXIT">
                  {STRATEGY_LEVEL_LABELS.FINAL_EXIT}
                </h2>
                {definition.finalExit ? null : (
                  <button
                    type="button"
                    className={styles.addLevel}
                    data-testid="add-level-FINAL_EXIT"
                    onClick={() =>
                      dispatch({ type: "addLevel", levelKind: "FINAL_EXIT" })
                    }
                  >
                    + Add final exit
                  </button>
                )}
              </header>
              {definition.finalExit ? (
                <ul className={styles.levelList}>
                  <FinalExitCard
                    finalExit={definition.finalExit}
                    issues={issues}
                    isRevealed={isRevealed}
                    touch={touch}
                    dispatch={dispatch}
                    onFocusHelp={setFocus}
                    focus={focus}
                  />
                </ul>
              ) : (
                <p className={styles.sectionEmpty}>
                  Optional — the rules that close the whole remaining position.
                  FINAL EXIT occurs when any one of them matches.
                </p>
              )}
            </section>
          </div>

          <aside className={panel.panel} data-testid="strategy-explanation">
            <div className={panel.sideExplanation}>
              <ExplanationPanel focus={shownFocus} />
            </div>
            <LogicPreview definition={authored} />
          </aside>
        </div>
      </UnsetRowsContext.Provider>

      <div className={styles.saveBar} data-testid="strategy-save-bar">
        <div className={styles.saveStatus} aria-live="polite">
          {saveError ? (
            <span className={styles.saveError} role="alert">
              {saveError}
            </span>
          ) : undo ? (
            <span className={styles.undo} data-testid="strategy-undo">
              {undo.label} removed.
              <button
                type="button"
                className={styles.undoButton}
                onClick={() => applyDraft(undo.draft)}
              >
                Undo
              </button>
            </span>
          ) : !dirty && !interacted ? (
            <span className={styles.saveClean}>
              {saved ? "All changes saved" : "Nothing to save yet"}
            </span>
          ) : issueCount > 0 ? (
            // Neutral until a field is touched or a save is attempted (UI-013): a count of what is
            // left to fill in, not an accusation. It turns red once the user has engaged.
            <button
              type="button"
              className={styles.saveIssues}
              data-testid="issue-count"
              data-tone={interacted ? "error" : "neutral"}
              onClick={revealIssues}
            >
              {interacted
                ? `${issueCount} ${issueCount === 1 ? "issue" : "issues"} to fix`
                : `${issueCount} ${issueCount === 1 ? "thing" : "things"} left to complete`}
            </button>
          ) : dirty ? (
            <span className={styles.saveDirty}>Unsaved changes</span>
          ) : (
            <span className={styles.saveClean}>
              {saved ? "All changes saved" : "Nothing to save yet"}
            </span>
          )}
        </div>
        <div className={styles.saveActions}>
          {saved && dirty ? (
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={() => applyDraft(draftFrom(saved))}
            >
              Discard changes
            </button>
          ) : null}
          <button
            type="button"
            className={`${forms.primaryButton} ${styles.saveButton}`}
            data-testid="save-strategy"
            disabled={!canSave}
            onClick={save}
          >
            {pending ? "Saving…" : "Save strategy"}
          </button>
        </div>
      </div>

      {deleting && saved ? (
        <ConfirmDialog
          title="Delete strategy"
          body={
            <p className={styles.confirmBody}>
              Delete <strong>{saved.name}</strong> and its saved versions? This
              cannot be undone.
            </p>
          }
          confirmLabel="Delete strategy"
          pendingLabel="Deleting…"
          onClose={() => setDeleting(false)}
          onConfirm={async () => {
            await deleteStrategy(saved.id);
            // Nothing is left to protect: the guard must not ask about a draft of a deleted strategy.
            markSaved(draftFrom(saved));
            router.push("/strategies");
          }}
        />
      ) : null}
    </PageContainer>
  );
}

/**
 * What a removal took away, when it took authored logic — the label the Undo offer names. A level
 * or rule with nothing chosen yet is removed without ceremony.
 */
function removalLabel(
  draft: StrategyDraftState,
  action: StrategyDraftAction,
): string | null {
  const unset = new Set(draft.unset);
  const authored = (signal: StrategySignal | undefined) =>
    signal !== undefined &&
    (signal.conditions.some((row) => !unset.has(row.id)) ||
      (signal.trigger !== undefined && !unset.has(signal.trigger.id)));
  const definition = draft.definition;
  if (action.type === "removeLevel") {
    const { levelKind, levelIndex } = action.ref;
    if (levelKind === "FINAL_EXIT") {
      return definition.finalExit?.rules.some((rule) => authored(rule.signal))
        ? "Final exit"
        : null;
    }
    const level = (
      levelKind === "BUY" ? definition.buyLevels : definition.sellLevels
    )[levelIndex ?? -1];
    return authored(level?.signal)
      ? `${STRATEGY_LEVEL_LABELS[levelKind]} ${(levelIndex ?? 0) + 1}`
      : null;
  }
  if (action.type === "removeExitRule") {
    return authored(definition.finalExit?.rules[action.ruleIndex]?.signal)
      ? `Exit rule ${action.ruleIndex + 1}`
      : null;
  }
  return null;
}

"use client";

import {
  STRATEGY_LEVEL_LABELS,
  STRATEGY_MAX_BUY_LEVELS,
  STRATEGY_MAX_SELL_LEVELS,
  type StrategyDetailResponse,
} from "@intrinsic/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ApiError } from "../../../lib/api/client";
import {
  createStrategy,
  replaceStrategyDefinition,
  strategyIssuesFrom,
  updateStrategy,
} from "../api/strategies-api";
import { useStrategyDraft } from "../hooks/use-strategy-draft";
import {
  draftFrom,
  draftPayload,
  emptyDraft,
  type StrategyDraftState,
} from "../utils/strategy-draft";
import { ExplanationPanel } from "./ExplanationPanel";
import type { HelpFocus } from "./help-focus";
import { LogicPreview } from "./LogicPreview";
import panel from "./ExplanationPanel.module.css";
import { LevelCard } from "./LevelCard";
import { LevelSection } from "./LevelSection";
import styles from "./StrategyBuilder.module.css";
import { StrategyDetailsCard } from "./StrategyDetailsCard";

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
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focus, setFocus] = useState<HelpFocus>(null);

  const binding = useStrategyDraft(
    strategy ? draftFrom(strategy) : emptyDraft(),
  );
  const {
    draft,
    dispatch,
    issues,
    issueCount,
    dirty,
    isRevealed,
    touch,
    markSaveAttempted,
    markSaved,
  } = binding;

  // Leaving with unsaved work is almost always a mistake, so the browser asks first.
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const definition = draft.definition;
  const canSave = dirty && issueCount === 0 && !pending;

  /**
   * What the explanation panel describes before anything is focused: the first rule in the
   * document, which is the one a reader's eye lands on anyway.
   */
  const firstRow =
    definition.buyLevels[0]?.signal.conditions[0] ??
    definition.buyLevels[0]?.signal.trigger;
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
      markSaved(draftFrom(latest));
    } catch (error) {
      const rejected = strategyIssuesFrom(error);
      setSaveError(
        rejected.length > 0
          ? (rejected[0]?.message ??
              "The strategy was rejected. Check the highlighted rows.")
          : error instanceof ApiError && error.status === 404
            ? "This strategy no longer exists."
            : "The strategy could not be saved right now. Try again in a moment.",
      );
      setPending(false);
      return;
    }
    setPending(false);
  };

  const applyDraft = (next: StrategyDraftState) =>
    dispatch({ type: "reset", draft: next });

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
      <div className={styles.builder} data-testid="strategy-builder">
        <div className={styles.editor}>
          <header className={styles.pageHeader}>
            <h1 className={styles.pageTitle}>
              {saved ? "Edit strategy" : "New strategy"}
            </h1>
            <p className={styles.pageLead}>
              Buy, sell and final-exit logic. A backtest decides which stocks
              and how much capital to run it with — a strategy never does.
            </p>
          </header>

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

          <section className={styles.section} data-testid="section-FINAL_EXIT">
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
                <LevelCard
                  levelKind="FINAL_EXIT"
                  signal={definition.finalExit.signal}
                  canMoveUp={false}
                  canMoveDown={false}
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
                Optional — the condition that closes the whole remaining
                position.
              </p>
            )}
          </section>
        </div>

        <aside className={panel.panel} data-testid="strategy-explanation">
          <div className={panel.sideExplanation}>
            <ExplanationPanel focus={shownFocus} />
          </div>
          <LogicPreview definition={definition} />
        </aside>
      </div>

      <div className={styles.saveBar} data-testid="strategy-save-bar">
        <div className={styles.saveStatus} aria-live="polite">
          {saveError ? (
            <span className={styles.saveError} role="alert">
              {saveError}
            </span>
          ) : issueCount > 0 ? (
            <button
              type="button"
              className={styles.saveIssues}
              data-testid="issue-count"
              onClick={revealIssues}
            >
              {issueCount} {issueCount === 1 ? "issue" : "issues"} to fix
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
              className={styles.discardButton}
              onClick={() => applyDraft(draftFrom(saved))}
            >
              Discard changes
            </button>
          ) : null}
          <button
            type="button"
            className={styles.saveButton}
            data-testid="save-strategy"
            disabled={!canSave}
            onClick={save}
          >
            {pending ? "Saving…" : "Save strategy"}
          </button>
        </div>
      </div>
    </PageContainer>
  );
}

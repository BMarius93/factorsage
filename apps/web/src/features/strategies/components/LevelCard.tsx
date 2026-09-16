"use client";

import {
  STRATEGY_LEVEL_LABELS,
  type StrategyIssuePath,
  type StrategySignal,
} from "@intrinsic/contracts";
import type { LevelRef, StrategyDraftAction } from "../utils/strategy-draft";
import { messageAt, type StrategyIssueLookup } from "../utils/strategy-issues";
import type { HelpFocus } from "./help-focus";
import { LevelPercentageSelect } from "./LevelPercentageSelect";
import { SignalEditor } from "./SignalEditor";
import styles from "./StrategyBuilder.module.css";

type LevelCardProps = {
  /** BUY and SELL only. FINAL EXIT is one action with alternatives; `FinalExitCard` renders it. */
  readonly levelKind: "BUY" | "SELL";
  readonly levelIndex: number;
  readonly ordinal: number;
  readonly percentage: number;
  readonly signal: StrategySignal;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly issues: StrategyIssueLookup;
  readonly isRevealed: (path: StrategyIssuePath) => boolean;
  readonly touch: (path: StrategyIssuePath) => void;
  readonly dispatch: (action: StrategyDraftAction) => void;
  readonly onFocusHelp: (focus: HelpFocus) => void;
  readonly focus: HelpFocus;
};

/**
 * One BUY or SELL level: an ordered candidate action with a percentage.
 *
 * The tone comes from the level kind so the families read apart at a glance without having to read
 * every label. FINAL EXIT is deliberately not rendered here — it carries no percentage, no
 * ordering, and one or more alternative Exit Rules — so `FinalExitCard` owns it rather than this
 * component growing a second personality.
 */
export function LevelCard({
  levelKind,
  levelIndex,
  ordinal,
  percentage,
  signal,
  canMoveUp,
  canMoveDown,
  issues,
  isRevealed,
  touch,
  dispatch,
  onFocusHelp,
  focus,
}: LevelCardProps) {
  const levelRef: LevelRef = { levelKind, levelIndex };
  const levelPath: StrategyIssuePath = { ...levelRef, part: "LEVEL" };
  const percentagePath: StrategyIssuePath = { ...levelRef, part: "PERCENTAGE" };
  const levelMessage =
    messageAt(issues, levelPath, isRevealed(levelPath)) ??
    messageAt(issues, percentagePath, isRevealed(percentagePath));

  const title = `${STRATEGY_LEVEL_LABELS[levelKind]} ${ordinal}`;

  return (
    <li
      className={styles.levelCard}
      data-tone={levelKind}
      data-testid={`level-card-${levelKind}`}
    >
      <header className={styles.levelHeader}>
        <button
          type="button"
          className={styles.levelTitle}
          onClick={() => onFocusHelp({ kind: "LEVEL", levelKind })}
        >
          {title}
        </button>
        <LevelPercentageSelect
          levelKind={levelKind}
          levelIndex={levelIndex}
          percentage={percentage}
          onChange={(next) =>
            dispatch({
              type: "setPercentage",
              ref: levelRef,
              percentage: next,
            })
          }
        />
        <div className={styles.levelActions}>
          <button
            type="button"
            className={styles.levelAction}
            aria-label={`Move ${title} up`}
            disabled={!canMoveUp}
            onClick={() =>
              dispatch({ type: "moveLevel", ref: levelRef, direction: -1 })
            }
          >
            ↑
          </button>
          <button
            type="button"
            className={styles.levelAction}
            aria-label={`Move ${title} down`}
            disabled={!canMoveDown}
            onClick={() =>
              dispatch({ type: "moveLevel", ref: levelRef, direction: 1 })
            }
          >
            ↓
          </button>
          <button
            type="button"
            className={styles.levelRemove}
            aria-label={`Remove ${title}`}
            onClick={() => dispatch({ type: "removeLevel", ref: levelRef })}
          >
            Remove
          </button>
        </div>
      </header>

      {levelMessage ? (
        <p className={styles.levelError} role="alert">
          {levelMessage}
        </p>
      ) : null}

      <SignalEditor
        levelKind={levelKind}
        levelRef={levelRef}
        signal={signal}
        issues={issues}
        isRevealed={isRevealed}
        touch={touch}
        dispatch={dispatch}
        onFocusHelp={onFocusHelp}
        focus={focus}
      />
    </li>
  );
}

"use client";

import {
  STRATEGY_LEVEL_LABELS,
  type StrategyBuyLevel,
  type StrategyIssuePath,
  type StrategySellLevel,
} from "@intrinsic/contracts";
import type { StrategyDraftAction } from "../utils/strategy-draft";
import { messageAt, type StrategyIssueLookup } from "../utils/strategy-issues";
import type { HelpFocus } from "./help-focus";
import { LevelCard } from "./LevelCard";
import styles from "./StrategyBuilder.module.css";

type LevelSectionProps = {
  readonly levelKind: "BUY" | "SELL";
  readonly levels: readonly (StrategyBuyLevel | StrategySellLevel)[];
  readonly atLimit: boolean;
  readonly issues: StrategyIssueLookup;
  readonly isRevealed: (path: StrategyIssuePath) => boolean;
  readonly touch: (path: StrategyIssuePath) => void;
  readonly dispatch: (action: StrategyDraftAction) => void;
  readonly onFocusHelp: (focus: HelpFocus) => void;
};

/** All the BUY levels or all the SELL levels, in the order the strategy defines them. */
export function LevelSection({
  levelKind,
  levels,
  atLimit,
  issues,
  isRevealed,
  touch,
  dispatch,
  onFocusHelp,
}: LevelSectionProps) {
  const sectionPath: StrategyIssuePath = { levelKind, part: "STRATEGY" };
  const sectionMessage = messageAt(
    issues,
    sectionPath,
    isRevealed(sectionPath),
  );
  const heading = `${STRATEGY_LEVEL_LABELS[levelKind]} levels`;

  return (
    <section className={styles.section} data-testid={`section-${levelKind}`}>
      <header className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle} data-tone={levelKind}>
          {heading}
        </h2>
        <button
          type="button"
          className={styles.addLevel}
          data-testid={`add-level-${levelKind}`}
          disabled={atLimit}
          onClick={() => dispatch({ type: "addLevel", levelKind })}
        >
          + Add {levelKind === "BUY" ? "buy" : "sell"} level
        </button>
      </header>

      {sectionMessage ? (
        <p className={styles.sectionError} role="alert">
          {sectionMessage}
        </p>
      ) : null}

      {levels.length === 0 ? (
        <p className={styles.sectionEmpty}>
          {levelKind === "BUY"
            ? "Every strategy needs at least one buy level."
            : "Optional — a strategy that only buys and holds is valid."}
        </p>
      ) : (
        <ul className={styles.levelList}>
          {levels.map((level, levelIndex) => (
            <LevelCard
              key={level.id}
              levelKind={levelKind}
              levelIndex={levelIndex}
              ordinal={levelIndex + 1}
              percentage={level.percentage}
              signal={level.signal}
              canMoveUp={levelIndex > 0}
              canMoveDown={levelIndex < levels.length - 1}
              issues={issues}
              isRevealed={isRevealed}
              touch={touch}
              dispatch={dispatch}
              onFocusHelp={onFocusHelp}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

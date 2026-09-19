"use client";

import {
  STRATEGY_MAX_EXIT_RULES,
  type StrategyFinalExit,
  type StrategyIssuePath,
} from "@intrinsic/contracts";
import type { StrategyDraftAction } from "../utils/strategy-draft";
import { messageAt, type StrategyIssueLookup } from "../utils/strategy-issues";
import type { HelpFocus } from "./help-focus";
import { SignalEditor } from "./SignalEditor";
import styles from "./StrategyBuilder.module.css";

type FinalExitCardProps = {
  readonly finalExit: StrategyFinalExit;
  readonly issues: StrategyIssueLookup;
  readonly isRevealed: (path: StrategyIssuePath) => boolean;
  readonly touch: (path: StrategyIssuePath) => void;
  readonly dispatch: (action: StrategyDraftAction) => void;
  readonly onFocusHelp: (focus: HelpFocus) => void;
  readonly focus: HelpFocus;
};

/**
 * FINAL EXIT: one card, one action, and the alternative Exit Rules that can reach it.
 *
 * It stays a single card on purpose. The rules are separated by a labelled OR divider rather than
 * nested in cards of their own, because they are alternatives *within* this action, not a second
 * tier of levels — and a card inside a card would say the opposite.
 *
 * With one rule the card reads exactly as it did before Exit Rules existed: no rule heading, no
 * divider, just the Signal. Headings and dividers appear the moment there is a genuine choice to
 * label, which is also when "EXIT RULE 1" starts meaning something.
 *
 * It renders no percentage and no reordering controls, because FINAL EXIT has neither: it closes
 * the entire remaining position, and OR is commutative so rule order is presentation, not meaning.
 */
export function FinalExitCard({
  finalExit,
  issues,
  isRevealed,
  touch,
  dispatch,
  onFocusHelp,
  focus,
}: FinalExitCardProps) {
  const levelPath: StrategyIssuePath = {
    levelKind: "FINAL_EXIT",
    part: "LEVEL",
  };
  const levelMessage = messageAt(issues, levelPath, isRevealed(levelPath));
  const rules = finalExit.rules;
  const multiple = rules.length > 1;

  return (
    <li
      className={styles.levelCard}
      data-tone="FINAL_EXIT"
      data-testid="level-card-FINAL_EXIT"
    >
      {/* No title of its own: the section above is already headed FINAL EXIT, and the card
          repeating it read as a second, nested level (UI-014). */}
      <header className={styles.levelHeader} data-untitled="true">
        <div className={styles.levelActions}>
          <button
            type="button"
            className={styles.levelRemove}
            aria-label="Remove final exit"
            onClick={() =>
              dispatch({ type: "removeLevel", ref: { levelKind: "FINAL_EXIT" } })
            }
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

      <ol className={styles.exitRuleList}>
        {rules.map((rule, ruleIndex) => {
          const rulePath: StrategyIssuePath = {
            levelKind: "FINAL_EXIT",
            ruleIndex,
            part: "EXIT_RULE",
          };
          const ruleMessage = messageAt(
            issues,
            rulePath,
            isRevealed(rulePath),
          );
          return (
            <li
              key={rule.id}
              className={styles.exitRule}
              data-testid="exit-rule"
            >
              {ruleIndex > 0 ? (
                <p className={styles.exitRuleOr} data-testid="exit-rule-or">
                  <span>OR</span>
                </p>
              ) : null}

              {multiple ? (
                <div className={styles.exitRuleHeader}>
                  <h3 className={styles.exitRuleTitle}>
                    Exit rule {ruleIndex + 1}
                  </h3>
                  {/* Every rule is removable once there is more than one, including the first:
                      with two alternatives neither is the "real" one, and the remaining rule
                      simply renumbers. The last rule is not removable — removing FINAL EXIT is
                      what "this strategy has no final exit" means. */}
                  <button
                    type="button"
                    className={styles.exitRuleRemove}
                    aria-label={`Remove exit rule ${ruleIndex + 1}`}
                    onClick={() =>
                      dispatch({ type: "removeExitRule", ruleIndex })
                    }
                  >
                    Remove
                  </button>
                </div>
              ) : null}

              {ruleMessage ? (
                <p className={styles.levelError} role="alert">
                  {ruleMessage}
                </p>
              ) : null}

              <SignalEditor
                levelKind="FINAL_EXIT"
                levelRef={{ levelKind: "FINAL_EXIT", ruleIndex }}
                signal={rule.signal}
                issues={issues}
                isRevealed={isRevealed}
                touch={touch}
                dispatch={dispatch}
                onFocusHelp={onFocusHelp}
                focus={focus}
              />
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        className={styles.addExitRule}
        data-testid="add-exit-rule"
        disabled={rules.length >= STRATEGY_MAX_EXIT_RULES}
        onClick={() => dispatch({ type: "addExitRule" })}
      >
        + Add OR rule
      </button>
    </li>
  );
}

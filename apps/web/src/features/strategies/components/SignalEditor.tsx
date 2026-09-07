"use client";

import {
  STRATEGY_MAX_CONDITIONS_PER_SIGNAL,
  type StrategyIssuePath,
  type StrategyLevelKind,
  type StrategySignal,
} from "@intrinsic/contracts";
import type { LevelRef, StrategyDraftAction } from "../utils/strategy-draft";
import type { StrategyIssueLookup } from "../utils/strategy-issues";
import type { HelpFocus } from "./help-focus";
import { PredicateRow } from "./PredicateRow";
import styles from "./StrategyBuilder.module.css";

type SignalEditorProps = {
  readonly levelKind: StrategyLevelKind;
  readonly levelRef: LevelRef;
  readonly signal: StrategySignal;
  readonly issues: StrategyIssueLookup;
  readonly isRevealed: (path: StrategyIssuePath) => boolean;
  readonly touch: (path: StrategyIssuePath) => void;
  readonly dispatch: (action: StrategyDraftAction) => void;
  readonly onFocusHelp: (focus: HelpFocus) => void;
  readonly focus: HelpFocus;
};

/**
 * One Signal: zero or more Conditions combined with AND, plus at most one optional Trigger.
 *
 * The two blocks are visually separate because they mean different things — Conditions describe a
 * state that can stay true for days, the Trigger is the single event that fires while it holds.
 * "At most one" needs no guard here: the document has one optional trigger field, so the control
 * is an add button that becomes a remove button.
 */
export function SignalEditor({
  levelKind,
  levelRef,
  signal,
  issues,
  isRevealed,
  touch,
  dispatch,
  onFocusHelp,
  focus,
}: SignalEditorProps) {
  const atConditionLimit =
    signal.conditions.length >= STRATEGY_MAX_CONDITIONS_PER_SIGNAL;

  return (
    <div className={styles.signal}>
      <div className={styles.signalBlock}>
        <span className={styles.signalLabel}>Conditions</span>
        {signal.conditions.length === 0 ? (
          <p className={styles.signalEmpty}>
            No conditions yet — this signal fires on its trigger alone.
          </p>
        ) : (
          <ul className={styles.predicateList}>
            {signal.conditions.map((condition, conditionIndex) => (
              <PredicateRow
                key={condition.id}
                levelKind={levelKind}
                ref_={{ ...levelRef, part: "CONDITION", conditionIndex }}
                row={condition}
                issues={issues}
                isRevealed={isRevealed}
                touch={touch}
                connector={conditionIndex === 0 ? null : "AND"}
                removeLabel={`Remove condition ${conditionIndex + 1}`}
                onSetMetric={(metric) =>
                  dispatch({
                    type: "setMetric",
                    ref: { ...levelRef, part: "CONDITION", conditionIndex },
                    metric,
                  })
                }
                onSetOperator={(operator) =>
                  dispatch({
                    type: "setOperator",
                    ref: { ...levelRef, part: "CONDITION", conditionIndex },
                    operator,
                  })
                }
                onSetValue={(value) =>
                  dispatch({
                    type: "setValue",
                    ref: { ...levelRef, part: "CONDITION", conditionIndex },
                    value,
                  })
                }
                onRemove={() =>
                  dispatch({
                    type: "removeCondition",
                    ref: { ...levelRef, part: "CONDITION", conditionIndex },
                  })
                }
                onFocusHelp={onFocusHelp}
                focus={focus}
              />
            ))}
          </ul>
        )}
        <button
          type="button"
          className={styles.addRow}
          data-testid="add-condition"
          disabled={atConditionLimit}
          onClick={() => dispatch({ type: "addCondition", ref: levelRef })}
        >
          + Add condition
        </button>
      </div>

      <div className={styles.signalBlock}>
        <span className={styles.signalLabel}>
          Trigger <span className={styles.optional}>· optional</span>
        </span>
        {signal.trigger ? (
          <ul className={styles.predicateList}>
            <PredicateRow
              key={signal.trigger.id}
              levelKind={levelKind}
              ref_={{ ...levelRef, part: "TRIGGER" }}
              row={signal.trigger}
              issues={issues}
              isRevealed={isRevealed}
              touch={touch}
              connector={signal.conditions.length > 0 ? "AND" : null}
              removeLabel="Remove trigger"
              onSetMetric={(metric) =>
                dispatch({
                  type: "setMetric",
                  ref: { ...levelRef, part: "TRIGGER" },
                  metric,
                })
              }
              onSetOperator={(operator) =>
                dispatch({
                  type: "setOperator",
                  ref: { ...levelRef, part: "TRIGGER" },
                  operator,
                })
              }
              onSetValue={(value) =>
                dispatch({
                  type: "setValue",
                  ref: { ...levelRef, part: "TRIGGER" },
                  value,
                })
              }
              onRemove={() =>
                dispatch({ type: "removeTrigger", ref: levelRef })
              }
              onFocusHelp={onFocusHelp}
              focus={focus}
            />
          </ul>
        ) : (
          <button
            type="button"
            className={styles.addRow}
            data-testid="add-trigger"
            onClick={() => dispatch({ type: "addTrigger", ref: levelRef })}
          >
            + Add trigger
          </button>
        )}
      </div>
    </div>
  );
}

"use client";

import {
  STRATEGY_LEVEL_LABELS,
  STRATEGY_LEVEL_PERCENTAGE_BASIS,
  describeStrategy,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import styles from "./ExplanationPanel.module.css";

/**
 * The strategy in words, derived at render time and never persisted.
 *
 * `describeStrategy` returns structured lines rather than a formatted string, so each line is
 * toned by its level kind here instead of being generated and then re-parsed. A stored rendering
 * would be a second source of truth that goes stale the moment this component changes.
 */
export function LogicPreview({
  definition,
}: {
  readonly definition: StrategyDefinition;
}) {
  const lines = describeStrategy(definition);

  return (
    <section className={styles.panelCard} data-testid="logic-preview">
      <h2 className={styles.panelHeading}>Strategy logic</h2>
      {lines.length === 0 ? (
        <p className={styles.panelEmpty}>
          Add a buy level to see this strategy in words.
        </p>
      ) : (
        <ol className={styles.previewList}>
          {lines.map((line, index) => {
            if (line.kind === "LEVEL") {
              const basis =
                line.levelKind === "FINAL_EXIT" || line.percentage === undefined
                  ? null
                  : `${line.percentage}% ${STRATEGY_LEVEL_PERCENTAGE_BASIS[line.levelKind]}`;
              return (
                <li
                  key={index}
                  className={styles.previewLevel}
                  data-tone={line.levelKind}
                >
                  {STRATEGY_LEVEL_LABELS[line.levelKind]}
                  {line.index === undefined ? "" : ` ${line.index}`}
                  {basis ? (
                    <span className={styles.previewBasis}> · {basis}</span>
                  ) : null}
                </li>
              );
            }
            if (line.kind === "EMPTY") {
              return (
                <li key={index} className={styles.previewEmpty}>
                  No conditions or trigger yet
                </li>
              );
            }
            return (
              <li key={index} className={styles.previewRule}>
                {line.connector ? (
                  <span className={styles.previewConnector}>
                    {line.connector}{" "}
                  </span>
                ) : null}
                {line.text}
                {line.kind === "TRIGGER" ? (
                  <span className={styles.previewTag}> (trigger)</span>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

"use client";

import {
  STRATEGY_LEVEL_LABELS,
  STRATEGY_LEVEL_PERCENTAGE_BASIS,
  describeStrategy,
  type StrategyDefinition,
  type StrategyScopeNames,
} from "@intrinsic/contracts";
import { Fragment } from "react";
import styles from "./ExplanationPanel.module.css";

/**
 * The strategy in words, derived at render time and never persisted.
 *
 * `describeStrategy` returns structured lines rather than a formatted string, so each line is
 * toned by its level kind here instead of being generated and then re-parsed. A stored rendering
 * would be a second source of truth that goes stale the moment this component changes.
 *
 * FINAL EXIT prints one heading followed by its Exit Rules, separated by OR. A single-rule FINAL
 * EXIT prints no rule headings at all, because there is no alternative to distinguish it from.
 */
export function LogicPreview({
  definition,
  framed = true,
  scopeNames,
}: {
  readonly definition: StrategyDefinition;
  /**
   * Names for the actors and groups the definition references.
   *
   * Passed in rather than fetched here, because the same lines are rendered by the Builder (which has
   * the live names) and by the read-only view; and because an unresolved name renders a neutral
   * fallback rather than nothing, so this component never waits on a request.
   */
  readonly scopeNames?: StrategyScopeNames;
  /**
   * `false` renders the lines alone, for a page whose `SectionCard` is already the surface. The
   * Builder's side column keeps the framed card with its own heading and mobile disclosure.
   */
  readonly framed?: boolean;
}) {
  const lines = describeStrategy(definition, scopeNames);
  const body =
    lines.length === 0 ? (
      <p className={styles.panelEmpty}>
        Add a buy level to see this strategy in words.
      </p>
    ) : (
      <PreviewLines lines={lines} />
    );

  if (!framed) {
    return <div data-testid="logic-preview">{body}</div>;
  }

  return (
    // A disclosure on mobile, where a long preview would otherwise push the editor off screen;
    // opened and flattened into a plain card on desktop, where the side column has the room.
    <details
      className={styles.previewDisclosure}
      data-testid="logic-preview"
      open
    >
      <summary className={styles.previewSummary}>Strategy logic</summary>
      <section className={styles.panelCard}>
        <h2 className={styles.panelHeading}>Strategy logic</h2>
        {body}
      </section>
    </details>
  );
}

function PreviewLines({
  lines,
}: {
  readonly lines: ReturnType<typeof describeStrategy>;
}) {
  return (
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
        if (line.kind === "EXIT_RULE") {
          // The OR belongs between two rules, so it is drawn as its own divider row rather
          // than as a prefix on the heading: `(rule 1) OR (rule 2)` has to be legible as one
          // FINAL EXIT with alternatives, never as two Final Exit actions in sequence.
          return (
            <Fragment key={index}>
              {line.connector ? (
                <li
                  className={styles.previewOr}
                  data-testid="preview-exit-rule-or"
                >
                  <span>{line.connector}</span>
                </li>
              ) : null}
              <li className={styles.previewExitRule}>Exit rule {line.index}</li>
            </Fragment>
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
              <span className={styles.previewConnector}>{line.connector} </span>
            ) : null}
            {line.text}
            {line.scope ? (
              // The configured first operand's summary, joined with an em dash so the line still reads
              // as one sentence: `Institutional buyers 60D is at least 3 — Superinvestors`.
              <span className={styles.previewScope}> — {line.scope}</span>
            ) : null}
            {line.kind === "TRIGGER" ? (
              <span className={styles.previewTag}> (trigger)</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

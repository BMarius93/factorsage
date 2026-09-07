"use client";

import {
  STRATEGY_DESCRIPTION_MAX_LENGTH,
  STRATEGY_NAME_MAX_LENGTH,
  type StrategyIssuePath,
} from "@intrinsic/contracts";
import { messageAt, type StrategyIssueLookup } from "../utils/strategy-issues";
import styles from "./StrategyBuilder.module.css";

type StrategyDetailsCardProps = {
  readonly name: string;
  readonly description: string;
  readonly issues: StrategyIssueLookup;
  readonly isRevealed: (path: StrategyIssuePath) => boolean;
  readonly touch: (path: StrategyIssuePath) => void;
  readonly onNameChange: (name: string) => void;
  readonly onDescriptionChange: (description: string) => void;
};

const NAME_PATH: StrategyIssuePath = { part: "NAME" };
const DESCRIPTION_PATH: StrategyIssuePath = { part: "DESCRIPTION" };

/** Strategy identity: the name it is known by, and an optional note about what it is for. */
export function StrategyDetailsCard({
  name,
  description,
  issues,
  isRevealed,
  touch,
  onNameChange,
  onDescriptionChange,
}: StrategyDetailsCardProps) {
  const nameMessage = messageAt(issues, NAME_PATH, isRevealed(NAME_PATH));
  const descriptionMessage = messageAt(
    issues,
    DESCRIPTION_PATH,
    isRevealed(DESCRIPTION_PATH),
  );

  return (
    <section className={styles.card} data-testid="strategy-details">
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="strategy-name">
          Name
        </label>
        <input
          id="strategy-name"
          className={styles.textInput}
          type="text"
          value={name}
          maxLength={STRATEGY_NAME_MAX_LENGTH}
          placeholder="e.g. Deep value entries"
          aria-invalid={nameMessage !== null || undefined}
          {...(nameMessage ? { "aria-describedby": "strategy-name-error" } : {})}
          onChange={(event) => onNameChange(event.target.value)}
          onBlur={() => touch(NAME_PATH)}
        />
        {nameMessage ? (
          <p className={styles.fieldError} id="strategy-name-error" role="alert">
            {nameMessage}
          </p>
        ) : null}
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="strategy-description">
          Description <span className={styles.optional}>· optional</span>
        </label>
        <textarea
          id="strategy-description"
          className={styles.textArea}
          value={description}
          maxLength={STRATEGY_DESCRIPTION_MAX_LENGTH}
          placeholder="What is this strategy for?"
          aria-invalid={descriptionMessage !== null || undefined}
          onChange={(event) => onDescriptionChange(event.target.value)}
          onBlur={() => touch(DESCRIPTION_PATH)}
        />
        {descriptionMessage ? (
          <p className={styles.fieldError} role="alert">
            {descriptionMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}

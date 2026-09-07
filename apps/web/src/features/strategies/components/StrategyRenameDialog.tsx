"use client";

import {
  STRATEGY_DESCRIPTION_MAX_LENGTH,
  STRATEGY_NAME_MAX_LENGTH,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import { useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { ApiError } from "../../../lib/api/client";
import { updateStrategy } from "../api/strategies-api";

type StrategyRenameDialogProps = {
  readonly strategy: Pick<
    StrategySummaryResponse,
    "id" | "name" | "description"
  >;
  readonly onUpdated: (summary: StrategySummaryResponse) => void;
  readonly onClose: () => void;
};

function requestMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return error.message;
  }
  return "The strategy could not be saved right now. Try again in a moment.";
}

/**
 * Renames a strategy and edits its description.
 *
 * Both are strategy identity rather than signal logic, so this never touches the definition and
 * never appends a version. The rules themselves are edited in the Builder.
 */
export function StrategyRenameDialog({
  strategy,
  onUpdated,
  onClose,
}: StrategyRenameDialogProps) {
  const [name, setName] = useState(strategy.name);
  const [description, setDescription] = useState(strategy.description ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameMissing, setNameMissing] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setNameMissing(true);
      return;
    }

    setPending(true);
    setError(null);
    try {
      onUpdated(
        await updateStrategy(strategy.id, {
          name: trimmedName,
          description: description.trim() === "" ? null : description.trim(),
        }),
      );
    } catch (caught) {
      setError(requestMessage(caught));
      setPending(false);
    }
  };

  return (
    <Modal
      title="Edit strategy"
      onClose={onClose}
      testId="strategy-rename-dialog"
    >
      <form className={forms.form} onSubmit={submit} noValidate>
        <div className={forms.field}>
          <label className={forms.label} htmlFor="strategy-rename-name">
            Name
          </label>
          <input
            id="strategy-rename-name"
            className={forms.input}
            type="text"
            value={name}
            maxLength={STRATEGY_NAME_MAX_LENGTH}
            aria-invalid={nameMissing && name.trim() === ""}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          {nameMissing && name.trim() === "" ? (
            <p className={forms.hint} role="alert">
              A strategy needs a name.
            </p>
          ) : null}
        </div>

        <div className={forms.field}>
          <label className={forms.label} htmlFor="strategy-rename-description">
            Description <span aria-hidden="true">·</span> optional
          </label>
          <textarea
            id="strategy-rename-description"
            className={forms.textarea}
            value={description}
            maxLength={STRATEGY_DESCRIPTION_MAX_LENGTH}
            placeholder="What is this strategy for?"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {error ? (
          <p className={forms.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={forms.actions}>
          <button
            type="button"
            className={forms.secondaryButton}
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={forms.primaryButton}
            disabled={pending}
          >
            {pending ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

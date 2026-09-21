"use client";

import { useEffect, useRef, useState } from "react";
import {
  isEntitlementError,
  requestFailureMessage,
} from "../../lib/api/entitlement-errors";
import styles from "./DuplicateDialog.module.css";
import { EntitlementNotice } from "./EntitlementNotice";
import forms from "./forms.module.css";
import { Modal } from "./Modal";

const COPY_SUFFIX = " — Copy";

/**
 * The name a copy is offered: the source's name followed by ` — Copy`, with the source's name
 * shortened when both would not fit the name limit, so the default can always be saved as it is.
 *
 * Names are not unique in FactorSage — identity is the id — so no numbering is needed to tell two
 * copies apart, and the name can be changed before anything is created.
 */
export function copyNameOf(name: string, maxLength: number): string {
  const room = Math.max(0, maxLength - COPY_SUFFIX.length);
  return `${name.trim().slice(0, room).trimEnd()}${COPY_SUFFIX}`;
}

type DuplicateDialogProps = {
  /** What is being copied, in product words: `list`, `strategy`. */
  readonly thing: string;
  readonly sourceName: string;
  readonly maxNameLength: number;
  /**
   * Makes the copy under the given, already trimmed, name. The dialog owns pending and error
   * state; the caller moves on to the copy once this resolves.
   */
  readonly onDuplicate: (name: string) => Promise<void>;
  readonly onClose: () => void;
};

/**
 * Names a copy of a list or a strategy, then asks the API to make it.
 *
 * The API copies from the source it already holds, so the name is all this asks for. The default
 * name is selected on open: typing replaces it, and Enter accepts it.
 */
export function DuplicateDialog({
  thing,
  sourceName,
  maxNameLength,
  onDuplicate,
  onClose,
}: DuplicateDialogProps) {
  const [name, setName] = useState(() => copyNameOf(sourceName, maxNameLength));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refusedByPlan, setRefusedByPlan] = useState(false);
  const [nameMissing, setNameMissing] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  // A second Enter or click can arrive before the disabled button renders: one copy per submit.
  const submitting = useRef(false);

  useEffect(() => {
    // Runs after `Modal` has opened the dialog, which is what makes the field focusable.
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) {
      return;
    }
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setNameMissing(true);
      return;
    }

    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onDuplicate(trimmedName);
    } catch (caught) {
      setRefusedByPlan(isEntitlementError(caught));
      setError(
        requestFailureMessage(
          caught,
          `The ${thing} could not be duplicated right now. Try again in a moment.`,
        ),
      );
      setPending(false);
      submitting.current = false;
    }
  };

  const invalid = nameMissing && name.trim() === "";

  return (
    <Modal
      title={`Duplicate ${thing}`}
      onClose={onClose}
      testId="duplicate-dialog"
    >
      <form className={forms.form} onSubmit={submit} noValidate>
        <p className={styles.lead}>
          Create an independent copy that you can edit.
        </p>

        <div className={forms.field}>
          <label className={forms.label} htmlFor="duplicate-name">
            Name
          </label>
          <input
            id="duplicate-name"
            ref={nameRef}
            className={forms.input}
            type="text"
            value={name}
            maxLength={maxNameLength}
            aria-invalid={invalid}
            onChange={(event) => setName(event.target.value)}
          />
          {invalid ? (
            <p className={forms.hint} role="alert">
              A {thing} needs a name.
            </p>
          ) : null}
        </div>

        {error && refusedByPlan ? (
          <EntitlementNotice message={error} />
        ) : error ? (
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
            {pending ? "Duplicating…" : "Duplicate"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

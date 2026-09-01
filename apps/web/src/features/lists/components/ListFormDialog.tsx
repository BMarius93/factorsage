"use client";

import {
  STOCK_LIST_DESCRIPTION_MAX_LENGTH,
  STOCK_LIST_NAME_MAX_LENGTH,
  type StockListDetailResponse,
  type StockListSecurityResponse,
  type StockListSummaryResponse,
} from "@intrinsic/contracts";
import { useState } from "react";
import { ApiError } from "../../../lib/api/client";
import { createStockList, updateStockList } from "../api/stock-lists-api";
import forms from "./lists-forms.module.css";
import { Modal } from "./Modal";
import { SecurityMultiSelect } from "./SecurityMultiSelect";

type CreateProps = {
  readonly mode: "create";
  readonly onCreated: (detail: StockListDetailResponse) => void;
  readonly onClose: () => void;
};

type RenameProps = {
  readonly mode: "rename";
  readonly list: Pick<StockListSummaryResponse, "id" | "name" | "description">;
  readonly onUpdated: (summary: StockListSummaryResponse) => void;
  readonly onClose: () => void;
};

type ListFormDialogProps = CreateProps | RenameProps;

function requestMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 400) {
    return error.message;
  }
  return "The list could not be saved right now. Try again in a moment.";
}

/**
 * Create and rename share one form. Creation stays fast on purpose: name the list, pick stocks
 * through the catalog search, save — buy windows are configured afterwards on the list page.
 */
export function ListFormDialog(props: ListFormDialogProps) {
  const [name, setName] = useState(
    props.mode === "rename" ? props.list.name : "",
  );
  const [description, setDescription] = useState(
    props.mode === "rename" ? (props.list.description ?? "") : "",
  );
  const [selected, setSelected] = useState<StockListSecurityResponse[]>([]);
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
      if (props.mode === "create") {
        const detail = await createStockList({
          name: trimmedName,
          ...(description.trim() === ""
            ? {}
            : { description: description.trim() }),
          ...(selected.length === 0
            ? {}
            : { securityIds: selected.map((entry) => entry.id) }),
        });
        props.onCreated(detail);
      } else {
        const summary = await updateStockList(props.list.id, {
          name: trimmedName,
          description: description.trim() === "" ? null : description.trim(),
        });
        props.onUpdated(summary);
      }
    } catch (caught) {
      setError(requestMessage(caught));
      setPending(false);
    }
  };

  return (
    <Modal
      title={props.mode === "create" ? "New list" : "Edit list"}
      onClose={props.onClose}
      testId="list-form-dialog"
    >
      <form className={forms.form} onSubmit={submit} noValidate>
        <div className={forms.field}>
          <label className={forms.label} htmlFor="list-name">
            Name
          </label>
          <input
            id="list-name"
            className={forms.input}
            type="text"
            value={name}
            maxLength={STOCK_LIST_NAME_MAX_LENGTH}
            aria-invalid={nameMissing && name.trim() === ""}
            placeholder="e.g. Dividend compounders"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
          {nameMissing && name.trim() === "" ? (
            <p className={forms.hint} role="alert">
              A list needs a name.
            </p>
          ) : null}
        </div>

        <div className={forms.field}>
          <label className={forms.label} htmlFor="list-description">
            Description <span aria-hidden="true">·</span> optional
          </label>
          <textarea
            id="list-description"
            className={forms.textarea}
            value={description}
            maxLength={STOCK_LIST_DESCRIPTION_MAX_LENGTH}
            placeholder="What is this universe for?"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>

        {props.mode === "create" ? (
          <div className={forms.field}>
            <span className={forms.label} id="list-stocks-label">
              Stocks
            </span>
            <SecurityMultiSelect
              selected={selected}
              onChange={setSelected}
              inputLabel="Search stocks to add to the new list"
            />
            <p className={forms.hint}>
              Every stock starts with full buy eligibility. You can restrict
              buy windows per stock after saving.
            </p>
          </div>
        ) : null}

        {error ? (
          <p className={forms.error} role="alert">
            {error}
          </p>
        ) : null}

        <div className={forms.actions}>
          <button
            type="button"
            className={forms.secondaryButton}
            onClick={props.onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button type="submit" className={forms.primaryButton} disabled={pending}>
            {props.mode === "create"
              ? pending
                ? "Creating…"
                : "Create list"
              : pending
                ? "Saving…"
                : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

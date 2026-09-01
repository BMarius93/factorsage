"use client";

import type {
  BuyWindowMode,
  StockListItemResponse,
} from "@intrinsic/contracts";
import { useState } from "react";
import { ApiError } from "../../../lib/api/client";
import { replaceBuyWindows } from "../api/stock-lists-api";
import {
  editableRangeError,
  editableRangesTouch,
  toEditableRanges,
  type EditableBuyWindowRange,
} from "../utils/buy-windows";
import forms from "./lists-forms.module.css";
import { Modal } from "./Modal";
import styles from "./BuyWindowEditor.module.css";

type BuyWindowEditorProps = {
  readonly listId: string;
  readonly item: StockListItemResponse;
  /** Receives the canonical normalized item the API returned. */
  readonly onSaved: (item: StockListItemResponse) => void;
  readonly onClose: () => void;
};

const EMPTY_RANGE: EditableBuyWindowRange = { startDate: "", endDate: "" };

/**
 * Focused editor for one stock's buy eligibility. The API normalizes the submitted set (sorting,
 * merging overlap and adjacency) and answers with the canonical ranges; those, not the raw form
 * input, are what the list shows after saving. Switching to FULL deletes every persisted range.
 */
export function BuyWindowEditor({
  listId,
  item,
  onSaved,
  onClose,
}: BuyWindowEditorProps) {
  const [mode, setMode] = useState<BuyWindowMode>(item.buyWindowMode);
  const [ranges, setRanges] = useState<EditableBuyWindowRange[]>(() => {
    const existing = toEditableRanges(item.buyWindows);
    return existing.length > 0 ? existing : [EMPTY_RANGE];
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);

  const rangeErrors = ranges.map(editableRangeError);
  const customInvalid =
    mode === "CUSTOM" && rangeErrors.some((message) => message !== null);
  const mergeHint =
    mode === "CUSTOM" && ranges.length > 1 && editableRangesTouch(ranges);

  const updateRange = (
    index: number,
    patch: Partial<EditableBuyWindowRange>,
  ) => {
    setRanges((current) =>
      current.map((range, at) =>
        at === index ? { ...range, ...patch } : range,
      ),
    );
    setError(null);
  };

  const removeRange = (index: number) => {
    setRanges((current) => {
      const next = current.filter((_, at) => at !== index);
      // CUSTOM always shows at least one editable row.
      return next.length > 0 ? next : [EMPTY_RANGE];
    });
  };

  const save = async () => {
    if (pending) {
      return;
    }
    if (customInvalid) {
      setShowValidation(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const saved = await replaceBuyWindows(listId, item.id, {
        mode,
        ranges:
          mode === "FULL"
            ? []
            : ranges.map((range) => ({
                startDate: range.startDate,
                endDate: range.endDate === "" ? null : range.endDate,
              })),
      });
      onSaved(saved);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 400
          ? caught.message
          : "The buy windows could not be saved right now. Try again in a moment.",
      );
      setPending(false);
    }
  };

  return (
    <Modal
      title={`${item.security.symbol} · Buy eligibility`}
      onClose={onClose}
      testId="buy-window-editor"
      wide
    >
      <div className={forms.form}>
        <p className={styles.explainer}>
          Buy windows restrict when a strategy or backtest may open a new BUY
          in {item.security.symbol}. Selling is never restricted.
        </p>

        <fieldset className={styles.modes}>
          <legend className={forms.label}>Buy eligibility</legend>
          <label className={styles.modeOption} data-checked={mode === "FULL"}>
            <input
              type="radio"
              name="buy-window-mode"
              value="FULL"
              checked={mode === "FULL"}
              onChange={() => {
                setMode("FULL");
                setError(null);
              }}
            />
            <span>
              <span className={styles.modeName}>Full history</span>
              <span className={styles.modeHint}>
                Eligible on every date a strategy covers.
              </span>
            </span>
          </label>
          <label className={styles.modeOption} data-checked={mode === "CUSTOM"}>
            <input
              type="radio"
              name="buy-window-mode"
              value="CUSTOM"
              checked={mode === "CUSTOM"}
              onChange={() => {
                setMode("CUSTOM");
                setError(null);
              }}
            />
            <span>
              <span className={styles.modeName}>Custom windows</span>
              <span className={styles.modeHint}>
                Eligible only inside the date ranges below.
              </span>
            </span>
          </label>
        </fieldset>

        {mode === "CUSTOM" ? (
          <div className={styles.ranges}>
            {ranges.map((range, index) => {
              const message = rangeErrors[index] ?? null;
              return (
                <div key={index} className={styles.rangeRow}>
                  <div className={styles.rangeFields}>
                    <label className={styles.rangeField}>
                      <span className={styles.rangeLabel}>Start</span>
                      <input
                        type="date"
                        className={forms.input}
                        value={range.startDate}
                        aria-invalid={showValidation && message !== null}
                        aria-label={`Range ${index + 1} start date`}
                        onChange={(event) =>
                          updateRange(index, { startDate: event.target.value })
                        }
                      />
                    </label>
                    <span className={styles.rangeArrow} aria-hidden="true">
                      →
                    </span>
                    <label className={styles.rangeField}>
                      <span className={styles.rangeLabel}>
                        End <span className={styles.rangeLabelSoft}>· empty = no end date</span>
                      </span>
                      <input
                        type="date"
                        className={forms.input}
                        value={range.endDate}
                        aria-invalid={showValidation && message !== null}
                        aria-label={`Range ${index + 1} end date`}
                        onChange={(event) =>
                          updateRange(index, { endDate: event.target.value })
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className={styles.rangeRemove}
                      aria-label={`Remove range ${index + 1}`}
                      onClick={() => removeRange(index)}
                    >
                      Remove
                    </button>
                  </div>
                  {showValidation && message ? (
                    <p className={styles.rangeError} role="alert">
                      {message}
                    </p>
                  ) : null}
                </div>
              );
            })}

            <button
              type="button"
              className={styles.addRange}
              onClick={() => setRanges((current) => [...current, EMPTY_RANGE])}
            >
              + Add range
            </button>

            {mergeHint ? (
              <p className={forms.hint} role="note">
                Overlapping or back-to-back ranges are saved as one continuous
                window.
              </p>
            ) : null}
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
            onClick={onClose}
            disabled={pending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={forms.primaryButton}
            data-testid="save-buy-windows"
            onClick={save}
            disabled={pending}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

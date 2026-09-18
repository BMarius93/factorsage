"use client";

import type {
  BuyWindowMode,
  StockListItemResponse,
} from "@intrinsic/contracts";
import { useId, useState } from "react";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { replaceBuyWindows } from "../api/stock-lists-api";
import {
  formatMembershipPeriod,
  membershipError,
  previewMembershipPeriod,
  toEditableMembership,
  toRequestRange,
  type EditableMembership,
} from "../utils/buy-windows";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import styles from "./MembershipEditor.module.css";

type MembershipEditorProps = {
  readonly listId: string;
  readonly item: StockListItemResponse;
  /** Receives the canonical normalized item the API returned. */
  readonly onSaved: (item: StockListItemResponse) => void;
  readonly onClose: () => void;
};

/**
 * Editor for one stock's membership of one list.
 *
 * **V1 exposes exactly one membership period.** The backend stores any number of them — that is
 * what makes point-in-time index reconstruction possible — but a user building an ordinary list
 * should not have to learn index history to add a stock, so there is no "add another period", no
 * timeline and no history browser here.
 *
 * That leaves one hazard, and it is handled rather than ignored: an item that already holds more
 * than one period cannot be edited by a one-period form without destroying the rest. Such an item
 * opens **read-only**, showing every period it has, and the form appears only after the user
 * explicitly asks to replace them. A read/edit/save cycle can therefore never quietly flatten
 * `[p1, p2, p3]` into `[p1]`.
 *
 * The API normalizes what is submitted and answers with the canonical configuration; that
 * response, never the raw form input, is what the list renders afterwards.
 */
export function MembershipEditor({
  listId,
  item,
  onSaved,
  onClose,
}: MembershipEditorProps) {
  const fieldId = useId();
  const startId = `${fieldId}-from`;
  const endId = `${fieldId}-to`;
  const presentId = `${fieldId}-present`;
  const errorId = `${fieldId}-error`;
  const previewId = `${fieldId}-preview`;

  const existingPeriodCount = item.buyWindows.length;
  const [replacingHistory, setReplacingHistory] = useState(
    existingPeriodCount <= 1,
  );
  const [mode, setMode] = useState<BuyWindowMode>(item.buyWindowMode);
  const [membership, setMembership] = useState<EditableMembership>(() =>
    toEditableMembership(item.buyWindows),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);

  const validation = mode === "CUSTOM" ? membershipError(membership) : null;
  const visibleValidation = showValidation ? validation : null;
  const preview =
    mode === "CUSTOM" ? previewMembershipPeriod(membership) : null;

  const patch = (next: Partial<EditableMembership>) => {
    setMembership((current) => ({ ...current, ...next }));
    setError(null);
  };

  const save = async () => {
    if (pending) {
      return;
    }
    if (validation !== null) {
      setShowValidation(true);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const saved = await replaceBuyWindows(listId, item.id, {
        mode,
        ranges: mode === "FULL" ? [] : [toRequestRange(membership)],
      });
      onSaved(saved);
    } catch (caught) {
      setError(
        requestFailureMessage(
          caught,
          "The membership could not be saved right now. Try again in a moment.",
        ),
      );
      setPending(false);
    }
  };

  return (
    <Modal
      title={`${item.security.symbol} · Membership`}
      onClose={onClose}
      testId="membership-editor"
    >
      <div className={forms.form}>
        <p className={styles.explainer}>
          Membership decides when a strategy, backtest or monitor may open a new
          BUY in {item.security.symbol}. A position opened while it was a member
          can still be sold after membership ends.
        </p>

        {replacingHistory ? null : (
          <section
            className={styles.history}
            data-testid="membership-history"
            aria-labelledby={`${fieldId}-history`}
          >
            <h3 className={styles.historyTitle} id={`${fieldId}-history`}>
              {existingPeriodCount} membership periods
            </h3>
            <ul className={styles.historyList}>
              {item.buyWindows.map((range) => (
                <li key={`${range.startDate}:${range.endDate ?? "open"}`}>
                  {formatMembershipPeriod(range)}
                </li>
              ))}
            </ul>
            <p className={forms.hint}>
              This editor manages a single period, so saving here would replace
              all {existingPeriodCount}. Nothing changes until you choose to.
            </p>
            <button
              type="button"
              className={forms.secondaryButton}
              data-testid="replace-membership-history"
              onClick={() => setReplacingHistory(true)}
            >
              Replace with one period
            </button>
          </section>
        )}

        {replacingHistory ? (
          <>
            <fieldset className={styles.modes}>
              <legend className={forms.label}>Membership</legend>
              <label
                className={styles.modeOption}
                data-checked={mode === "FULL"}
              >
                <input
                  type="radio"
                  name="membership-mode"
                  value="FULL"
                  checked={mode === "FULL"}
                  onChange={() => {
                    setMode("FULL");
                    setError(null);
                  }}
                />
                <span>
                  <span className={styles.modeName}>Always eligible</span>
                  <span className={styles.modeHint}>
                    Can be bought on every date a strategy or backtest covers.
                  </span>
                </span>
              </label>
              <label
                className={styles.modeOption}
                data-checked={mode === "CUSTOM"}
              >
                <input
                  type="radio"
                  name="membership-mode"
                  value="CUSTOM"
                  checked={mode === "CUSTOM"}
                  onChange={() => {
                    setMode("CUSTOM");
                    setError(null);
                  }}
                />
                <span>
                  <span className={styles.modeName}>Membership period</span>
                  <span className={styles.modeHint}>
                    Part of this list only between the dates below.
                  </span>
                </span>
              </label>
            </fieldset>

            {mode === "CUSTOM" ? (
              <fieldset className={styles.period}>
                <legend className={forms.label}>Membership period</legend>
                <div className={styles.periodFields}>
                  <div className={styles.periodField}>
                    <label className={styles.periodLabel} htmlFor={startId}>
                      From
                    </label>
                    <input
                      id={startId}
                      type="date"
                      className={forms.input}
                      value={membership.startDate}
                      aria-invalid={
                        visibleValidation?.field === "startDate" || undefined
                      }
                      {...(visibleValidation?.field === "startDate"
                        ? { "aria-describedby": errorId }
                        : {})}
                      onChange={(event) =>
                        patch({ startDate: event.target.value })
                      }
                    />
                  </div>

                  <span className={styles.periodArrow} aria-hidden="true">
                    →
                  </span>

                  <div className={styles.periodField}>
                    <label className={styles.periodLabel} htmlFor={endId}>
                      To
                    </label>
                    <input
                      id={endId}
                      type="date"
                      className={forms.input}
                      value={membership.present ? "" : membership.endDate}
                      disabled={membership.present}
                      aria-invalid={
                        visibleValidation?.field === "endDate" || undefined
                      }
                      {...(visibleValidation?.field === "endDate"
                        ? { "aria-describedby": errorId }
                        : {})}
                      onChange={(event) =>
                        patch({ endDate: event.target.value })
                      }
                    />
                  </div>

                  <div className={styles.presentToggle}>
                    <input
                      id={presentId}
                      type="checkbox"
                      checked={membership.present}
                      onChange={(event) =>
                        patch({
                          present: event.target.checked,
                          ...(event.target.checked ? { endDate: "" } : {}),
                        })
                      }
                    />
                    <label htmlFor={presentId}>Present</label>
                  </div>
                </div>

                {visibleValidation ? (
                  <p
                    className={styles.fieldError}
                    id={errorId}
                    role="alert"
                    data-testid="membership-validation"
                  >
                    {visibleValidation.message}
                  </p>
                ) : (
                  <p
                    className={forms.hint}
                    id={previewId}
                    data-testid="membership-preview"
                    aria-live="polite"
                  >
                    {preview === null ? (
                      "Membership runs from the start date to the end date, inclusive."
                    ) : (
                      <>Saves as {preview}</>
                    )}
                  </p>
                )}
              </fieldset>
            ) : null}
          </>
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
            {replacingHistory ? "Cancel" : "Close"}
          </button>
          {replacingHistory ? (
            <button
              type="button"
              className={forms.primaryButton}
              data-testid="save-membership"
              onClick={save}
              disabled={pending}
            >
              {pending ? "Saving…" : "Save"}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

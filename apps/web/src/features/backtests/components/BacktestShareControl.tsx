"use client";

import { useId, useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { useBacktestShare } from "../hooks/use-backtest-share";
import { formatTimestamp } from "../utils/format";
import styles from "./BacktestShareControl.module.css";

export type BacktestShareControlProps = {
  readonly runId: string;
};

function failureMessage(error: unknown): string {
  return requestFailureMessage(
    error,
    "That did not work. Check your connection and try again.",
  );
}

/**
 * The owner's Share action on a completed run (`docs/decisions/backtest-sharing-v1.md`).
 *
 * The dialog says what a link publishes before it creates one — the results, never the strategy,
 * the list or the trades — because that is the decision being made. Stopping is a second, explicit
 * step: a revoked link can never be restored, only replaced by a new one, so a single misplaced
 * click must not cost a link somebody already sent.
 */
export function BacktestShareControl({ runId }: BacktestShareControlProps) {
  const { state, enable, revoke, retry } = useBacktestShare(runId, true);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<"enable" | "revoke" | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkId = useId();

  const share = state.status === "ready" ? state.share : null;
  const shared = share?.shared === true && share.url !== null;

  const close = () => {
    setOpen(false);
    setConfirmingRevoke(false);
    setFailure(null);
    setCopied(false);
  };

  const run = async (action: "enable" | "revoke") => {
    setPending(action);
    setFailure(null);
    try {
      if (action === "enable") {
        await enable();
      } else {
        await revoke();
        setConfirmingRevoke(false);
        setCopied(false);
      }
    } catch (caught) {
      setFailure(failureMessage(caught));
    } finally {
      setPending(null);
    }
  };

  const copy = (url: string) => {
    void navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <>
      <button
        type="button"
        className={forms.secondaryButton}
        data-testid="backtest-share"
        data-shared={shared ? "true" : "false"}
        onClick={() => setOpen(true)}
      >
        {shared ? (
          <>
            <span className={styles.liveDot} aria-hidden="true" />
            Shared
          </>
        ) : (
          "Share"
        )}
      </button>

      {open ? (
        <Modal
          title="Share backtest results"
          onClose={close}
          testId="backtest-share-dialog"
        >
          <div className={forms.form}>
            <div className={styles.explanation}>
              <p>
                Anyone with the link can open a read-only report of this run:
                its chart, the performance figures, the annual returns and the
                simulation settings. No account is needed.
              </p>
              <p data-testid="backtest-share-privacy">
                Your strategy&apos;s rules, the stock list and its securities,
                and the trade log stay private. The report shows only how many
                rules and securities the run used.
              </p>
            </div>

            {state.status === "loading" || state.status === "idle" ? (
              <p className={styles.status}>Checking whether it is shared…</p>
            ) : null}

            {state.status === "error" ? (
              <div className={styles.status}>
                <p className={forms.error} role="alert">
                  Sharing could not be checked. Try again in a moment.
                </p>
                <button
                  type="button"
                  className={forms.secondaryButton}
                  onClick={retry}
                >
                  Try again
                </button>
              </div>
            ) : null}

            {shared && share?.url ? (
              <div className={forms.field} data-testid="backtest-share-active">
                <label className={forms.label} htmlFor={linkId}>
                  Public link
                </label>
                <div className={styles.linkRow}>
                  <input
                    id={linkId}
                    className={forms.input}
                    data-testid="backtest-share-url"
                    value={share.url}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className={forms.primaryButton}
                    data-testid="backtest-share-copy"
                    data-autofocus
                    onClick={() => copy(share.url as string)}
                  >
                    {copied ? "Copied" : "Copy link"}
                  </button>
                </div>
                <p className={forms.hint}>
                  {share.sharedAt
                    ? `Shared since ${formatTimestamp(share.sharedAt)}. `
                    : ""}
                  <a
                    href={share.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="backtest-share-open"
                  >
                    Open the report
                  </a>
                </p>
              </div>
            ) : null}

            {failure ? (
              <p className={forms.error} role="alert">
                {failure}
              </p>
            ) : null}

            {shared && confirmingRevoke ? (
              <div
                className={styles.revokeConfirm}
                data-testid="backtest-share-revoke-confirm"
              >
                <p>
                  The link stops working immediately for everyone who has it.
                  Sharing again creates a new link. Apps that already showed a
                  preview of it may keep their own copy of that preview.
                </p>
                <div className={forms.actions}>
                  <button
                    type="button"
                    className={forms.secondaryButton}
                    onClick={() => setConfirmingRevoke(false)}
                    disabled={pending !== null}
                  >
                    Keep sharing
                  </button>
                  <button
                    type="button"
                    className={forms.dangerButton}
                    data-testid="backtest-share-revoke-confirm-button"
                    onClick={() => void run("revoke")}
                    disabled={pending !== null}
                  >
                    {pending === "revoke" ? "Stopping…" : "Stop sharing"}
                  </button>
                </div>
              </div>
            ) : (
              <div className={forms.actions}>
                <button
                  type="button"
                  className={forms.secondaryButton}
                  onClick={close}
                  disabled={pending !== null}
                >
                  Close
                </button>
                {shared ? (
                  <button
                    type="button"
                    className={forms.dangerButton}
                    data-testid="backtest-share-revoke"
                    onClick={() => setConfirmingRevoke(true)}
                    disabled={pending !== null}
                  >
                    Stop sharing
                  </button>
                ) : state.status === "ready" ? (
                  <button
                    type="button"
                    className={forms.primaryButton}
                    data-testid="backtest-share-enable"
                    onClick={() => void run("enable")}
                    disabled={pending !== null}
                  >
                    {pending === "enable"
                      ? "Creating link…"
                      : "Create public link"}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </Modal>
      ) : null}
    </>
  );
}

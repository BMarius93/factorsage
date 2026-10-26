"use client";

import { useId, useState } from "react";
import forms from "../../../components/ui/forms.module.css";
import { Modal } from "../../../components/ui/Modal";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import { useBacktestShare } from "../hooks/use-backtest-share";
import {
  definitionKindLabel,
  definitionOriginLabel,
  definitionPublicationText,
  type DefinitionKind,
} from "../sharing/definition-labels";
import { formatTimestamp } from "../utils/format";
import styles from "./BacktestShareControl.module.css";

const DEFINITION_KINDS: readonly DefinitionKind[] = ["strategy", "list"];

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
 * The dialog says what a link publishes before it creates one, because that is the decision being
 * made: the results; where the strategy and the list come from; a description of an official
 * built-in; and — only if the owner turns it on — a description of their own strategy and list
 * (`docs/decisions/canonical-definitions-v1.md`). The list's securities and the trades are never
 * published. Stopping is a second, explicit step: a revoked link can never be restored, only
 * replaced by a new one, so a single misplaced click must not cost a link somebody already sent.
 */
export function BacktestShareControl({ runId }: BacktestShareControlProps) {
  const { state, enable, revoke, retry } = useBacktestShare(runId, true);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<
    "enable" | "revoke" | "publish" | null
  >(null);
  // The owner's choice before the link exists; once it does, the link's own setting is the truth.
  const [publishChoice, setPublishChoice] = useState(false);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const linkId = useId();
  const publishId = useId();

  const share = state.status === "ready" ? state.share : null;
  const shared = share?.shared === true && share.url !== null;
  const definitions = share?.definitions;
  const publishDescriptions = shared
    ? share?.publishDescriptions === true
    : publishChoice;
  // The choice only matters for the owner's own content. A link from before definitions were
  // recorded has none to show, and turning the option on is how its owner records them.
  const offersPublishing =
    state.status === "ready" &&
    (definitions === undefined
      ? shared
      : DEFINITION_KINDS.some(
          (kind) => definitions[kind].publication === "opt_in",
        ));

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
        await enable({ publishDescriptions: publishChoice });
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

  const choosePublishing = async (next: boolean) => {
    if (!shared) {
      setPublishChoice(next);
      return;
    }
    setPending("publish");
    setFailure(null);
    try {
      await enable({ publishDescriptions: next });
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
                The securities in your list, the individual trades and the trade
                log always stay private. The report says where the strategy and
                the list come from — built-in, custom or derived — and how many
                rules and securities the run used.
              </p>
            </div>

            {definitions ? (
              <ul
                className={styles.definitions}
                data-testid="backtest-share-definitions"
              >
                {DEFINITION_KINDS.map((kind) => {
                  const definition = definitions[kind];
                  return (
                    <li
                      key={kind}
                      className={styles.definition}
                      data-testid={`backtest-share-definition-${kind}`}
                      data-origin={definition.origin}
                      data-publication={definition.publication}
                    >
                      <span className={styles.definitionHead}>
                        <span className={styles.definitionKind}>
                          {definitionKindLabel(kind)}
                        </span>
                        <span className={styles.definitionOrigin}>
                          {definitionOriginLabel(
                            kind,
                            definition.origin,
                            definition.builtInName,
                          )}
                        </span>
                      </span>
                      <span className={styles.definitionShort}>
                        {definition.short}
                      </span>
                      <span className={styles.definitionPublication}>
                        {definitionPublicationText(
                          kind,
                          definition.publication,
                          publishDescriptions,
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            {offersPublishing ? (
              <div className={styles.checkRow}>
                <input
                  id={publishId}
                  className={styles.checkbox}
                  type="checkbox"
                  data-testid="backtest-share-publish"
                  checked={publishDescriptions}
                  disabled={pending !== null}
                  onChange={(event) =>
                    void choosePublishing(event.target.checked)
                  }
                />
                <label className={styles.checkLabel} htmlFor={publishId}>
                  Publish descriptions of my strategy and list
                  <span
                    className={styles.checkHint}
                    data-testid="backtest-share-publish-warning"
                  >
                    This reveals your strategy&apos;s conditions — the metrics,
                    operators and thresholds it uses — and how your list&apos;s
                    membership works, to anyone with the link. The list&apos;s
                    securities and the trades stay private.
                  </span>
                </label>
              </div>
            ) : null}

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

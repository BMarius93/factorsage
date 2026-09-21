"use client";

import type {
  LegalRequestKind,
  LegalRequestReceipt,
} from "@intrinsic/contracts";
import { Notice } from "../../../components/ui/Notice";
import { SectionCard } from "../../../components/ui/SectionCard";
import styles from "./LegalRequestForm.module.css";

const KIND_LABEL: Record<LegalRequestKind, string> = {
  WITHDRAWAL: "Withdrawal request",
  PRIVACY_REQUEST: "Privacy and data request",
  NONCONFORMITY: "Report of a problem with the service",
  SUPPORT: "Support message",
};

/**
 * The durable receipt for a submitted request.
 *
 * "Durable" is the point, and it is met three ways rather than by one fragile one: the receipt is
 * on screen now, it can be saved as a file with one click, and it stays retrievable from the
 * account's own request list afterwards. No email is promised, because there is no approved
 * monitored mailbox to send one from — a confirmation that never arrives would be worse than
 * saying plainly where the confirmation is.
 *
 * The wording is deliberately careful about what it is. It confirms **receipt**: it is not a
 * decision, not a refund, and not a confirmation that anything has been erased. Overstating that
 * would be the product making a statement about a legal outcome nobody has made.
 */
export function LegalRequestReceiptPanel({
  receipt,
  onSubmitAnother,
}: {
  readonly receipt: LegalRequestReceipt;
  readonly onSubmitAnother?: () => void;
}) {
  return (
    <SectionCard
      title="Your request has been received"
      caption="Keep this receipt. Quote the reference if you follow up."
      testId="legal-request-receipt"
    >
      <Notice tone="success" announce="status" title="Receipt of your request">
        <p>
          This confirms that your request reached FactorSage at the time below.
          It is not a decision on the request: no refund has been made, nothing
          has been erased, and your subscription is unchanged.
        </p>
      </Notice>

      <dl className={styles.receipt}>
        <div>
          <dt>Reference</dt>
          <dd className={styles.reference} data-testid="receipt-reference">
            {receipt.reference}
          </dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>{KIND_LABEL[receipt.kind]}</dd>
        </div>
        <div>
          <dt>Submitted</dt>
          <dd data-testid="receipt-submitted-at">
            {formatInstant(receipt.submittedAt)}
          </dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>Received</dd>
        </div>
      </dl>

      <p className={styles.reviewLabel}>What you sent</p>
      <blockquote className={styles.quote}>{receipt.details}</blockquote>

      <div className={styles.actions}>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => downloadReceipt(receipt)}
          data-testid="receipt-download"
        >
          Save a copy
        </button>
        {onSubmitAnother ? (
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={onSubmitAnother}
          >
            Submit another request
          </button>
        ) : null}
      </div>
    </SectionCard>
  );
}

/** Server-clock instant, rendered in the reader's own timezone and labelled with it. */
function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return iso;
  }
  return parsed.toLocaleString(undefined, {
    dateStyle: "long",
    timeStyle: "long",
  });
}

/**
 * Saves the receipt as a plain-text file.
 *
 * Plain text on purpose: it is readable anywhere, forever, with no dependency on this
 * application still existing — which is what makes it a durable copy rather than a link that
 * may stop resolving. The ISO instant is included alongside the localised one so the record is
 * unambiguous.
 */
function downloadReceipt(receipt: LegalRequestReceipt): void {
  const body = [
    "FactorSage — receipt of a submitted request",
    "",
    `Reference:   ${receipt.reference}`,
    `Request:     ${KIND_LABEL[receipt.kind]}`,
    `Submitted:   ${receipt.submittedAt} (UTC, server clock)`,
    `Local time:  ${formatInstant(receipt.submittedAt)}`,
    `Status:      Received`,
    "",
    "What was sent:",
    receipt.details,
    "",
    "This confirms receipt only. It is not a decision on the request, not a refund, and not",
    "confirmation that any data has been erased.",
    "",
  ].join("\n");

  const url = URL.createObjectURL(
    new Blob([body], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `factorsage-receipt-${receipt.reference}.txt`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

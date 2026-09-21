"use client";

import {
  FIRST_PARTY_STORAGE_INVENTORY,
  STORAGE_INVENTORY,
  type StorageInventoryEntry,
} from "@intrinsic/contracts";
import { SectionCard } from "../../../components/ui/SectionCard";
import { Notice } from "../../../components/ui/Notice";
import { useStorageConsent } from "./use-storage-consent";
import styles from "./StorageSettings.module.css";

const CATEGORY_LABEL: Record<StorageInventoryEntry["category"], string> = {
  NECESSARY: "Necessary",
  PREFERENCES: "Optional — preference",
  OUT_OF_SCOPE: "Third party, own domain",
};

/**
 * The full inventory, and the control that changes the visitor's choice.
 *
 * Rendered on `/cookies`, and reachable from the footer's **Storage settings** link on every
 * page, so withdrawing permission is the same single action as giving it and is never harder to
 * find.
 *
 * The table is generated from `STORAGE_INVENTORY` in `@intrinsic/contracts` rather than written
 * as prose, which is the property that matters: the published policy is the application's own
 * inventory, so it cannot describe storage the code does not use or omit storage it does. Each
 * row names the evidence it comes from.
 *
 * Third-party rows are shown and explicitly marked out of scope. The local control cannot govern
 * what Google or Stripe do on their own domains, and a cookie policy that implied otherwise
 * would be making a claim about somebody else's site.
 */
export function StorageSettings() {
  const consent = useStorageConsent();

  return (
    <SectionCard
      id="storage-settings"
      title="Storage settings"
      caption="Change or withdraw your choice at any time. Withdrawing is the same single action as giving permission."
      testId="storage-settings"
    >
      <div className={styles.controls}>
        <p className={styles.state} data-testid="storage-consent-state">
          {!consent.decided
            ? "Reading your choice from this browser…"
            : consent.choice === null
              ? "You have not chosen yet. Nothing optional is being stored."
              : consent.preferencesAllowed
                ? `Optional storage is allowed on this device (chosen ${formatDecidedAt(consent.choice.decidedAt)}).`
                : `Optional storage is refused on this device (chosen ${formatDecidedAt(consent.choice.decidedAt)}).`}
        </p>
        <div className={styles.actions}>
          <button
            className={styles.button}
            type="button"
            onClick={consent.rejectPreferences}
            disabled={!consent.decided}
            aria-pressed={
              consent.decided &&
              consent.choice !== null &&
              !consent.preferencesAllowed
            }
            data-testid="storage-reject"
          >
            Reject optional storage
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={consent.allowPreferences}
            disabled={!consent.decided}
            aria-pressed={consent.preferencesAllowed}
            data-testid="storage-allow"
          >
            Allow optional storage
          </button>
        </div>
        <p className={styles.note}>
          Refusing stops FactorSage reading or writing the optional keys below
          and removes the ones it has already written on this device. It does
          not sign you out and does not touch anything else.
        </p>
      </div>

      {!consent.optionalStorageExists ? (
        <Notice tone="info" title="Nothing optional is in use">
          <p>
            Every entry below is strictly necessary to run the service you asked
            for, so there is nothing to consent to and no banner is shown.
          </p>
        </Notice>
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.table} data-testid="storage-inventory">
          <caption className={styles.caption}>
            Everything FactorSage reads from or writes to your browser.
            Generated from the application&rsquo;s own inventory.
          </caption>
          <thead>
            <tr>
              <th scope="col">What</th>
              <th scope="col">Purpose</th>
              <th scope="col">When</th>
              <th scope="col">How long</th>
              <th scope="col">Category</th>
            </tr>
          </thead>
          <tbody>
            {STORAGE_INVENTORY.map((entry) => (
              <tr key={entry.id} data-category={entry.category}>
                <th scope="row">
                  <span className={styles.name}>{entry.name}</span>
                  <span className={styles.provider}>{entry.provider}</span>
                </th>
                <td>{entry.purpose}</td>
                <td>{entry.trigger}</td>
                <td>{entry.duration}</td>
                <td>
                  <span className={styles.category}>
                    {CATEGORY_LABEL[entry.category]}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className={styles.note}>
        {FIRST_PARTY_STORAGE_INVENTORY.length} of these are set by FactorSage on
        this site. The rest are set by Google and by our payment provider on
        their own domains when you are sent there to sign in or to pay; those
        are operated by those companies under their own policies and are not
        controlled by the buttons above.
      </p>
      <p className={styles.note}>
        You can also clear everything from your browser&rsquo;s own site-data
        settings. FactorSage works without any of the optional storage above.
      </p>
    </SectionCard>
  );
}

/**
 * The decision's own timestamp, as a plain date.
 *
 * Rendered from the record rather than recomputed, and tolerant of a malformed value: this is a
 * reassurance line on a settings page, and it must never be the reason the page fails.
 */
function formatDecidedAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? "earlier"
    : parsed.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

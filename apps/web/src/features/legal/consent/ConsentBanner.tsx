"use client";

import Link from "next/link";
import { useStorageConsent } from "./use-storage-consent";
import styles from "./ConsentBanner.module.css";

/**
 * The first-layer storage choice.
 *
 * ## When it appears, and when it must not
 *
 * Only while the product genuinely has optional storage to ask about
 * (`OPTIONAL_STORAGE_EXISTS`, computed from the verified inventory) **and** the visitor has not
 * decided. If the inventory ever contains nothing but strictly necessary purposes, this renders
 * nothing at all rather than asking for permission it does not need — a banner that asks for
 * consent to exempt storage trains people to dismiss banners and is exactly what the EDPB
 * guidance is against.
 *
 * ## The rules it is shaped by
 *
 * - **Reject is as easy as Accept.** Two buttons, the same size, the same prominence, side by
 *   side. Not a link in the corner, and not a second click behind "Customize".
 * - **Nothing optional runs before a choice.** The banner itself loads no script and writes no
 *   storage; the only thing any button writes is the choice record.
 * - **No dark patterns.** No scroll-as-consent, no prechecked toggles, no countdown, and no
 *   blocking overlay: the product is fully usable while undecided, because everything optional is
 *   simply off.
 * - **It says what it is asking about**, in one sentence, with the full inventory a link away.
 *
 * It is a polite region rather than a modal dialog: it must not trap focus or stop somebody
 * reading the very policy it links to.
 */
export function ConsentBanner() {
  const consent = useStorageConsent();

  // `decided` is false until the first effect has read the store, so the banner never flashes for
  // a returning visitor who already answered.
  if (!consent.optionalStorageExists || !consent.decided || consent.choice) {
    return null;
  }

  return (
    <div
      className={styles.banner}
      role="region"
      aria-label="Browser storage choice"
      data-testid="consent-banner"
    >
      <div className={styles.inner}>
        <div className={styles.copy}>
          <p className={styles.title}>Optional storage on this device</p>
          <p className={styles.body}>
            FactorSage uses necessary storage to keep you signed in and to
            remember this choice. With your permission it also stores one
            preference on this device: the stocks you open while signed out, so
            the search box can offer them again. Nothing optional is stored
            until you allow it, and you can change your mind at any time.
          </p>
          <p className={styles.body}>
            <Link className={styles.link} href="/cookies">
              See exactly what is stored
            </Link>
          </p>
        </div>
        <div className={styles.actions}>
          {/* Equal weight, equal size, equal prominence. Reject is listed first so it is never
              the afterthought. */}
          <button
            className={styles.button}
            type="button"
            onClick={consent.rejectPreferences}
            data-testid="consent-reject"
          >
            Reject optional
          </button>
          <button
            className={styles.button}
            type="button"
            onClick={consent.allowPreferences}
            data-testid="consent-accept"
          >
            Allow optional
          </button>
        </div>
      </div>
    </div>
  );
}

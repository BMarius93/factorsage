import {
  STORAGE_CONSENT_KEY,
  STORAGE_CONSENT_VERSION,
  type StorageConsentChoice,
} from "@intrinsic/contracts";

/**
 * The visitor's storage choice, and the rules for reading and writing it.
 *
 * Pure browser mechanics, deliberately separate from React so the rules can be tested without
 * rendering anything, and so there is exactly one implementation of "may we use optional
 * storage".
 *
 * ## Three rules that are easy to get subtly wrong
 *
 * **Undecided is not permission.** Every read returns `null` for "no valid choice", and every
 * caller must treat `null` exactly as it treats a refusal. A boolean with a default of `false`
 * would look the same until somebody flipped the default.
 *
 * **A blocked store fails safely.** `localStorage` throws outright in a browser configured to
 * block site data, and can come back empty in a private window. Every access is wrapped, and a
 * failure resolves to "no choice recorded", which means nothing optional is used. The product
 * carries on; the visitor simply is not remembered between visits.
 *
 * **A material change to the purposes invalidates the choice.** A stored record for a different
 * `version` is not honoured and not silently migrated: it resolves to undecided and the visitor
 * is asked again. Consent to one set of purposes is not consent to another.
 *
 * The record itself is strictly necessary storage — it exists only to honour the visitor's own
 * decision — and is inventoried as such in `STORAGE_INVENTORY`.
 */

/** The current choice, or `null` when nothing valid is recorded. Never throws. */
export function readStorageConsent(): StorageConsentChoice | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_CONSENT_KEY);
  } catch {
    // A browser that blocks site data cannot remember a choice. Undecided, so nothing optional
    // runs — which is the safe direction.
    return null;
  }
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Partial<StorageConsentChoice>;
    if (
      record.version !== STORAGE_CONSENT_VERSION ||
      typeof record.preferences !== "boolean" ||
      typeof record.decidedAt !== "string"
    ) {
      // A record from an older question, or a hand-edited one. Ask again rather than guess.
      return null;
    }
    return {
      version: record.version,
      preferences: record.preferences,
      decidedAt: record.decidedAt,
    };
  } catch {
    return null;
  }
}

/** Records a decision. Returns the choice it tried to store, whether or not the store accepted. */
export function writeStorageConsent(
  preferences: boolean,
): StorageConsentChoice {
  const choice: StorageConsentChoice = {
    version: STORAGE_CONSENT_VERSION,
    preferences,
    decidedAt: new Date().toISOString(),
  };
  try {
    window.localStorage.setItem(STORAGE_CONSENT_KEY, JSON.stringify(choice));
  } catch {
    // A full or blocked store costs the visitor being remembered next time, nothing else. The
    // in-memory state for this page session still honours what they just chose.
  }
  return choice;
}

/**
 * Whether optional storage may be read or written **right now**.
 *
 * The one predicate. `null` — undecided — answers `false`, so nothing optional happens before a
 * decision, which is the ePrivacy article 5(3) requirement rather than a preference.
 */
export function preferencesAllowed(
  choice: StorageConsentChoice | null,
): boolean {
  return choice?.preferences === true;
}

/**
 * Cross-tab notification.
 *
 * `storage` fires in *other* tabs when this key changes, so withdrawing permission in one tab
 * stops optional behaviour in the others without a reload. It deliberately does not fire in the
 * tab that made the change; that one already knows.
 */
export function subscribeToStorageConsent(
  onChange: (choice: StorageConsentChoice | null) => void,
): () => void {
  function handle(event: StorageEvent) {
    if (event.key !== null && event.key !== STORAGE_CONSENT_KEY) {
      return;
    }
    // `key === null` means the whole store was cleared, which is also a change to this key.
    onChange(readStorageConsent());
  }

  window.addEventListener("storage", handle);
  return () => window.removeEventListener("storage", handle);
}

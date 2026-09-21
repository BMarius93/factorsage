"use client";

import {
  OPTIONAL_STORAGE_EXISTS,
  type StorageConsentChoice,
} from "@intrinsic/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { clearGuestRecentSecurityIds } from "../../stocks/recent/utils/guest-recent-securities";
import {
  preferencesAllowed,
  readStorageConsent,
  subscribeToStorageConsent,
  writeStorageConsent,
} from "./storage-consent";

export type StorageConsent = {
  /** `null` until the first client render has read the store — never treat it as permission. */
  readonly choice: StorageConsentChoice | null;
  /** True only once a decision has been read from this browser. */
  readonly decided: boolean;
  /** The one predicate feature code asks. False while undecided. */
  readonly preferencesAllowed: boolean;
  /** Whether the product has any optional storage at all to ask about. */
  readonly optionalStorageExists: boolean;
  readonly allowPreferences: () => void;
  readonly rejectPreferences: () => void;
};

/**
 * The default is "undecided, nothing allowed".
 *
 * A component rendered outside the provider — a test mounting one surface, a future shell that
 * does not carry it — must behave as if nothing has been permitted, not as if everything has.
 */
const UNDECIDED: StorageConsent = {
  choice: null,
  decided: false,
  preferencesAllowed: false,
  optionalStorageExists: OPTIONAL_STORAGE_EXISTS,
  allowPreferences: () => {},
  rejectPreferences: () => {},
};

const StorageConsentContext = createContext<StorageConsent>(UNDECIDED);

/**
 * Holds the visitor's browser-storage choice for the whole application.
 *
 * ## Why it starts undecided on every render
 *
 * The first client render deliberately reports `decided: false` even when a choice is stored:
 * the server rendered this markup without access to `localStorage`, so reading it during render
 * would make the client's first paint disagree with the server's and hydrate incorrectly. The
 * effect below reads the store immediately afterwards.
 *
 * That ordering is also the safe one. Between the server render and that effect, optional
 * storage is not permitted, so a race can only ever fail *closed* — there is no window in which
 * an optional key is touched before the choice is known.
 *
 * ## Withdrawal
 *
 * Refusing, or withdrawing a previous permission, stops future optional behaviour **and removes
 * the optional keys this application controls**. It deliberately touches nothing else: not the
 * session cookie, not the consent record itself, not anything another origin wrote. Withdrawal
 * is the same single action as granting, in the same place, which is what "as easy to withdraw
 * as to give" means.
 *
 * ## Cross-tab
 *
 * A change in another tab arrives through the `storage` event, so withdrawing in one tab stops
 * optional behaviour in the others without a reload.
 */
export function StorageConsentProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [choice, setChoice] = useState<StorageConsentChoice | null>(null);
  const [decided, setDecided] = useState(false);

  useEffect(() => {
    setChoice(readStorageConsent());
    setDecided(true);
    return subscribeToStorageConsent((next) => {
      setChoice(next);
      if (!preferencesAllowed(next)) {
        // Another tab withdrew permission. Stop using the optional keys here too, and clear the
        // ones this application wrote.
        clearGuestRecentSecurityIds();
      }
    });
  }, []);

  const allowPreferences = useCallback(() => {
    setChoice(writeStorageConsent(true));
    setDecided(true);
  }, []);

  const rejectPreferences = useCallback(() => {
    setChoice(writeStorageConsent(false));
    setDecided(true);
    // Removing what was already written is the other half of withdrawal: stopping future writes
    // while leaving yesterday's data in place would not be a withdrawal at all.
    clearGuestRecentSecurityIds();
  }, []);

  const value = useMemo<StorageConsent>(
    () => ({
      choice,
      decided,
      preferencesAllowed: preferencesAllowed(choice),
      optionalStorageExists: OPTIONAL_STORAGE_EXISTS,
      allowPreferences,
      rejectPreferences,
    }),
    [choice, decided, allowPreferences, rejectPreferences],
  );

  return (
    <StorageConsentContext.Provider value={value}>
      {children}
    </StorageConsentContext.Provider>
  );
}

export function useStorageConsent(): StorageConsent {
  return useContext(StorageConsentContext);
}

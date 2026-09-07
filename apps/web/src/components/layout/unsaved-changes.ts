"use client";

import { useEffect } from "react";

/**
 * Unsaved-changes guard for the application shell's navigation.
 *
 * A page with an unsaved draft registers a confirmation here; the shell's navigation asks before
 * it leaves. Only one page is mounted at a time, so this is a single slot rather than a registry,
 * and nothing is persisted: the draft lives in the page's own state and is discarded on leaving.
 *
 * Browser Back is deliberately not intercepted. The App Router exposes no supported way to cancel
 * a popstate navigation, and the usual workaround — pushing a sentinel history entry and
 * re-pushing it on every Back — corrupts the history stack: Forward gains a phantom entry and a
 * Back after saving silently does nothing. `beforeunload` still covers reload and tab close.
 */
let confirmLeaving: (() => boolean) | null = null;

/**
 * Registers `message` as the confirmation shown when navigation would discard unsaved work, and
 * keeps the native prompt for reload/tab close, for as long as `unsaved` is true.
 */
export function useUnsavedChangesGuard(
  unsaved: boolean,
  message: string,
): void {
  useEffect(() => {
    if (!unsaved) {
      return;
    }

    confirmLeaving = () => window.confirm(message);
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);

    return () => {
      confirmLeaving = null;
      window.removeEventListener("beforeunload", warn);
    };
  }, [unsaved, message]);
}

/**
 * Asks the guarded page's confirmation before an imperative navigation, such as the topbar
 * search's `router.push`. True means the caller may navigate; false means the user chose to stay.
 * With no guard registered nothing is asked and the answer is always true.
 */
export function canNavigate(): boolean {
  return confirmLeaving === null || confirmLeaving();
}

/**
 * `onNavigate` handler for the shell's links: cancels the client-side navigation when a guarded
 * page has unsaved work and the user chooses to stay. With no guard registered, navigation is
 * untouched.
 */
export function guardNavigation(event: { preventDefault: () => void }): void {
  if (!canNavigate()) {
    event.preventDefault();
  }
}

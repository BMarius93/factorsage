"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, kept current as it changes.
 *
 * Built on `useSyncExternalStore`, so every component reading the same query sees the same answer
 * in the same render, and with a **server snapshot of `false`**: the server and the hydrating
 * client both render the "does not match" branch, and React re-renders with the real answer right
 * after hydration. That is what lets a component be *not mounted at all* below a breakpoint —
 * rather than mounted and hidden with CSS — without a hydration mismatch. A component that must
 * not run on a phone (it would fetch, start timers or subscribe) is therefore rendered only when
 * this is `true`; anything that must not shift the layout when it appears reserves its space in
 * CSS at the same query.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") {
        return () => undefined;
      }
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  const matches = useCallback(
    () =>
      typeof window.matchMedia === "function" &&
      window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, matches, serverDoesNotMatch);
}

function serverDoesNotMatch(): boolean {
  return false;
}

function subscribeToVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

function documentVisible(): boolean {
  return document.visibilityState !== "hidden";
}

function serverVisible(): boolean {
  return true;
}

/**
 * Whether the page is visible: `false` while its tab is in the background or the window is
 * minimised. A timer that only changes what is on screen should not run while nobody can see it.
 */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeToVisibility,
    documentVisible,
    serverVisible,
  );
}

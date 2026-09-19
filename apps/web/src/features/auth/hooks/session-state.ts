"use client";

import { useAuthSession, type AuthState } from "./use-auth-session";

/**
 * The session state, or `null` where no `AuthSessionProvider` is mounted.
 *
 * The application always mounts one (`(app)/layout.tsx`). A component rendered in isolation — a
 * unit test of a dialog or a header — does not, and an account-dependent control there simply
 * behaves as "session still resolving": disabled, never a guess. `useContext` runs either way, so
 * the hook order never changes.
 */
export function useSessionStateIfProvided(): AuthState | null {
  try {
    return useAuthSession().state;
  } catch {
    return null;
  }
}

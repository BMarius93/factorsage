"use client";

import type { AuthUser } from "@intrinsic/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getAuthUser, logout as logoutRequest } from "../api/auth-api";

export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "error" };

export type AuthSession = {
  readonly state: AuthState;
  readonly signOut: () => Promise<void>;
};

const AuthSessionContext = createContext<AuthSession | null>(null);

/**
 * Resolves the current session once for a whole authenticated route tree.
 *
 * The API remains the authority: this is presentation state so the shell can render the right
 * chrome, never an authorization decision.
 */
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const signOut = useCallback(async () => {
    await logoutRequest();
    setState({ status: "unauthenticated" });
  }, []);

  useEffect(() => {
    let active = true;

    void getAuthUser()
      .then((user) => {
        if (!active) return;
        setState(
          user
            ? { status: "authenticated", user }
            : { status: "unauthenticated" },
        );
      })
      .catch(() => {
        if (active) setState({ status: "error" });
      });

    return () => {
      active = false;
    };
  }, []);

  const value = useMemo<AuthSession>(
    () => ({ state, signOut }),
    [state, signOut],
  );

  return (
    <AuthSessionContext.Provider value={value}>
      {children}
    </AuthSessionContext.Provider>
  );
}

export function useAuthSession(): AuthSession {
  const session = useContext(AuthSessionContext);
  if (!session) {
    throw new Error("useAuthSession must be used inside AuthSessionProvider");
  }
  return session;
}

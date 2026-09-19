"use client";

import type { AuthUser } from "@intrinsic/contracts";
import { ApiError } from "../../../lib/api/client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getAuthUser,
  logout as logoutRequest,
  logoutEverywhere as logoutEverywhereRequest,
} from "../api/auth-api";

export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser }
  | {
      status: "error";
      /**
       * Why the session could not be read (UI-029). `server`: the API answered with a failure, so
       * the network is fine and retrying later is the advice. `unreachable`: no answer at all.
       * Absent where a caller constructs the state without knowing.
       */
      reason?: "server" | "unreachable";
    };

export type AuthSession = {
  readonly state: AuthState;
  /**
   * Signs this browser out. With `everywhere`, first revokes every session of the account, so
   * every other device is signed out on its next request too.
   */
  readonly signOut: (options?: { everywhere?: boolean }) => Promise<void>;
  /** Asks for the session again after a failure. */
  readonly retry?: () => void;
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

  const signOut = useCallback(async (options?: { everywhere?: boolean }) => {
    await (options?.everywhere ? logoutEverywhereRequest() : logoutRequest());
    setState({ status: "unauthenticated" });
  }, []);

  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((current) => current + 1);
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
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "error",
            reason: error instanceof ApiError ? "server" : "unreachable",
          });
        }
      });

    return () => {
      active = false;
    };
  }, [attempt]);

  const value = useMemo<AuthSession>(
    () => ({ state, signOut, retry }),
    [state, signOut, retry],
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

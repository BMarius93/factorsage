"use client";

import type { AuthUser } from "@intrinsic/contracts";
import { useEffect, useState } from "react";
import { getAuthUser } from "./auth-api";

export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser }
  | { status: "error" };

export function useAuthUser(): AuthState {
  const [state, setState] = useState<AuthState>({ status: "loading" });

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

  return state;
}

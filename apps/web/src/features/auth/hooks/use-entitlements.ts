"use client";

import {
  GUEST_PRINCIPAL,
  authenticatedPrincipal,
  resolveEntitlements,
  type Entitlements,
  type UserPlan,
  type UserRole,
} from "@intrinsic/contracts";
import { useMemo } from "react";
import { useSessionStateIfProvided } from "./session-state";

export type EntitlementsView =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly entitlements: Entitlements;
      /** Absent for a Guest, who has no persisted plan. */
      readonly plan?: UserPlan;
      readonly role?: UserRole;
    };

/**
 * The viewer's resolved capacities, for showing a limit **before** it is hit (UI-020).
 *
 * Derived with the canonical resolver from `@intrinsic/contracts` over the plan and role the
 * server already put in the session — the same function every API guard calls — so no number is
 * re-declared in the browser and the page can never promise a capacity the guard would refuse.
 * It is presentation only: the API still decides every write, inside its own transaction.
 */
export function useEntitlements(): EntitlementsView {
  const state = useSessionStateIfProvided();
  return useMemo<EntitlementsView>(() => {
    if (state === null || state.status === "loading") {
      return { status: "loading" };
    }
    if (state.status === "authenticated") {
      return {
        status: "ready",
        entitlements: resolveEntitlements(authenticatedPrincipal(state.user)),
        plan: state.user.plan,
        role: state.user.role,
      };
    }
    // Signed out, or the session could not be read: the Guest capacities, which are the safe ones.
    return {
      status: "ready",
      entitlements: resolveEntitlements(GUEST_PRINCIPAL),
    };
  }, [state]);
}

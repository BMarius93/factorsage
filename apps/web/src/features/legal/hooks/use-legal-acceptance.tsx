"use client";

import type { LegalAcceptanceStatusResponse } from "@intrinsic/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { fetchLegalAcceptance } from "../api/legal-api";

export type LegalAcceptanceState =
  | { readonly status: "not-applicable" }
  | { readonly status: "loading" }
  | { readonly status: "outstanding" }
  | { readonly status: "accepted" }
  /** The probe failed. Deliberately distinct from "outstanding" — see below. */
  | { readonly status: "error" };

export type LegalAcceptance = {
  readonly state: LegalAcceptanceState;
  /** Re-reads the state after an acceptance, so the gate lifts without a reload. */
  readonly refresh: () => void;
};

const NOT_APPLICABLE: LegalAcceptance = {
  state: { status: "not-applicable" },
  refresh: () => {},
};

const LegalAcceptanceContext = createContext<LegalAcceptance>(NOT_APPLICABLE);

/**
 * Resolves whether the signed-in account still owes an acceptance.
 *
 * One probe for the whole shell, beside the session, rather than one per route.
 *
 * ## What it is, and what it is not
 *
 * This is **presentation**. The server gates every non-exempt route on its own and answers `403`
 * with `LEGAL_ACCEPTANCE_REQUIRED` regardless of what this component believes, which is what
 * makes the gate real. The purpose here is to send a user to the acceptance screen instead of
 * letting them walk into a wall of refusals.
 *
 * ## Why a failed probe does not gate
 *
 * A network failure resolves to `error`, and the gate treats it as "carry on". Failing closed
 * here would lock a user out of the product because a request timed out, while gaining nothing:
 * the server would still refuse every gated request, so a user whose acceptance really is
 * outstanding cannot get past it either way. The client fails open precisely because the server
 * fails closed.
 *
 * A Guest is `not-applicable`: there is no account, so there is nothing to have accepted.
 */
export function LegalAcceptanceProvider({
  children,
}: {
  readonly children: ReactNode;
}) {
  const { state: session } = useAuthSession();
  const [state, setState] = useState<LegalAcceptanceState>({
    status: "loading",
  });
  const [reloadToken, setReloadToken] = useState(0);
  const authenticated = session.status === "authenticated";

  useEffect(() => {
    if (session.status === "loading") {
      setState({ status: "loading" });
      return;
    }
    if (!authenticated) {
      setState({ status: "not-applicable" });
      return;
    }

    const controller = new AbortController();
    setState({ status: "loading" });
    fetchLegalAcceptance({ signal: controller.signal })
      .then((status: LegalAcceptanceStatusResponse) => {
        if (!controller.signal.aborted) {
          setState({
            status: status.outstanding ? "outstanding" : "accepted",
          });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ status: "error" });
        }
      });

    return () => controller.abort();
  }, [session.status, authenticated, reloadToken]);

  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);

  const value = useMemo<LegalAcceptance>(
    () => ({ state, refresh }),
    [state, refresh],
  );

  return (
    <LegalAcceptanceContext.Provider value={value}>
      {children}
    </LegalAcceptanceContext.Provider>
  );
}

export function useLegalAcceptance(): LegalAcceptance {
  return useContext(LegalAcceptanceContext);
}

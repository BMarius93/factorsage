"use client";

import type { UserRole } from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuthSession } from "../hooks/use-auth-session";
import { signInHref } from "../utils/guest-routes";
import { currentReturnPath } from "../utils/return-path";
import { PageContainer } from "../../../components/layout/PageContainer";
import { EmptyState } from "../../../components/ui/EmptyState";
import forms from "../../../components/ui/forms.module.css";
import styles from "./RequireAuth.module.css";

type RequireAuthProps = {
  readonly children: ReactNode;
  /** When set, the route additionally requires this role. */
  readonly role?: UserRole;
};

/**
 * Presentation-level route gate.
 *
 * The API is the authorization authority and rejects unauthorized calls on its own; this only
 * decides what the browser renders while that is true.
 */
export function RequireAuth({ children, role }: RequireAuthProps) {
  const router = useRouter();
  const { state, retry } = useAuthSession();

  useEffect(() => {
    if (state.status === "unauthenticated") {
      // Keep the URL they asked for — `/backtests/new?strategyId=…` included — so signing in
      // lands them on it rather than on the Dashboard (UX-003).
      router.replace(signInHref(currentReturnPath()));
    }
  }, [state.status, router]);

  if (state.status === "loading" || state.status === "unauthenticated") {
    return (
      <PageContainer>
        <p
          className={styles.checking}
          role="status"
          data-testid="auth-checking"
        >
          Checking your session…
        </p>
      </PageContainer>
    );
  }

  // Gate states are ordinary page states (UI-028, UI-029): the shared panel, inside the page's
  // gutters, with one h1 and a way forward.
  if (state.status === "error") {
    return (
      <PageContainer>
        <EmptyState
          as="h1"
          variant="error"
          testId="auth-error"
          title="Your session could not be checked"
          body={
            <p>
              {state.reason === "unreachable"
                ? "FactorSage could not be reached. Check your connection, then try again."
                : "FactorSage could not check your session right now. This is usually temporary — try again in a moment."}
            </p>
          }
          actions={
            <>
              <Link
                className={forms.secondaryButton}
                href={signInHref(currentReturnPath())}
              >
                Return to sign in
              </Link>
              {retry ? (
                <button
                  type="button"
                  className={forms.secondaryButton}
                  onClick={retry}
                >
                  Try again
                </button>
              ) : null}
            </>
          }
        />
      </PageContainer>
    );
  }

  if (role && state.user.role !== role) {
    return (
      <PageContainer>
        <EmptyState
          as="h1"
          testId="auth-forbidden"
          title="This page is not available to your account"
          body={
            <p>
              It needs {role.toLowerCase()} access, which this account does not
              have.
            </p>
          }
          actions={
            <Link className={forms.secondaryButton} href="/">
              Back to Dashboard
            </Link>
          }
        />
      </PageContainer>
    );
  }

  return <>{children}</>;
}

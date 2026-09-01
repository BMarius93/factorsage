"use client";

import type { UserRole } from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuthSession } from "../hooks/use-auth-session";
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
  const { state } = useAuthSession();

  useEffect(() => {
    if (state.status === "unauthenticated") {
      router.replace("/login");
    }
  }, [state.status, router]);

  if (state.status === "loading" || state.status === "unauthenticated") {
    return (
      <div className={styles.gate} role="status" data-testid="auth-checking">
        Checking your session...
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className={styles.gate} data-testid="auth-error">
        <h1 className={styles.title}>Unable to verify your session</h1>
        <p>The API could not be reached. Check your connection and retry.</p>
        <Link className={styles.link} href="/login">
          Return to sign in
        </Link>
      </div>
    );
  }

  if (role && state.user.role !== role) {
    return (
      <div className={styles.gate} data-testid="auth-forbidden">
        <h1 className={styles.title}>Access denied</h1>
        <p>This account does not have {role.toLowerCase()} access.</p>
        <Link className={styles.link} href="/dashboard">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}

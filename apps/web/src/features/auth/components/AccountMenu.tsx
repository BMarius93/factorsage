"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuthSession } from "../hooks/use-auth-session";
import styles from "./AccountMenu.module.css";

/**
 * Account control for the application topbar: identity, ADMIN entry point, sign out of this browser
 * and sign out everywhere — or, for a Guest on a public page, the way to sign in.
 */
export function AccountMenu() {
  const router = useRouter();
  const { state, signOut } = useAuthSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState<"here" | "everywhere" | null>(
    null,
  );
  const [error, setError] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function handlePointerDown(event: MouseEvent | TouchEvent) {
      if (!wrapper.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (state.status === "unauthenticated") {
    // A Guest browsing the public pages needs a way in.
    return (
      <Link className={styles.signIn} href="/login" data-testid="sign-in-link">
        Sign in
      </Link>
    );
  }
  if (state.status !== "authenticated") {
    return null;
  }

  const { user } = state;
  const isAdmin = user.role === "ADMIN";
  // The chrome carries a mark, not an address: a real customer's email is long enough to
  // dominate the topbar, and the full address is one click away inside the menu.
  const monogram = (user.email.match(/[a-z0-9]/i)?.[0] ?? "?").toUpperCase();

  async function handleSignOut(scope: "here" | "everywhere") {
    setSigningOut(scope);
    setError(false);

    try {
      await signOut({ everywhere: scope === "everywhere" });
      setOpen(false);
      router.replace("/login");
      router.refresh();
    } catch {
      setError(true);
      setSigningOut(null);
    }
  }

  return (
    <div className={styles.wrapper} ref={wrapper}>
      <button
        className={styles.trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account: ${user.email}`}
        data-testid="account-menu-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.monogram} aria-hidden="true">
          {monogram}
        </span>
      </button>

      {open ? (
        <div className={styles.menu} role="menu" data-testid="account-menu">
          <div className={styles.identity}>
            <span className={styles.email} data-testid="account-email">
              {user.email}
            </span>
            <span
              className={`${styles.roleBadge} ${isAdmin ? styles.roleAdmin : styles.roleUser}`}
              data-testid="account-role"
            >
              {user.role}
            </span>
          </div>

          {/*
            Billing lives here rather than in the primary navigation: it is an account setting, not
            one of the five product destinations, and `PRIMARY_NAV_ITEMS` is the single definition of
            those. Shown to everyone, because a Free user needs it more than a paying one does.
          */}
          <Link
            className={styles.menuLink}
            href="/billing"
            role="menuitem"
            data-testid="account-billing-link"
            onClick={() => setOpen(false)}
          >
            Plan and billing
          </Link>

          {isAdmin ? (
            <Link
              className={styles.menuLink}
              href="/admin"
              role="menuitem"
              onClick={() => setOpen(false)}
            >
              Admin
            </Link>
          ) : null}

          <button
            className={styles.signOut}
            type="button"
            role="menuitem"
            disabled={signingOut !== null}
            data-testid="sign-out"
            onClick={() => void handleSignOut("here")}
          >
            {signingOut === "here" ? "Signing out..." : "Sign out"}
          </button>

          {/* Ends every session of the account, on every device — the step after a lost device. */}
          <button
            className={styles.signOut}
            type="button"
            role="menuitem"
            disabled={signingOut !== null}
            data-testid="sign-out-everywhere"
            onClick={() => void handleSignOut("everywhere")}
          >
            {signingOut === "everywhere"
              ? "Signing out everywhere..."
              : "Sign out everywhere"}
          </button>

          {error ? (
            <p className={styles.error} role="alert">
              Sign out failed. Please try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

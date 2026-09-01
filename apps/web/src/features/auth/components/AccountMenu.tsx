"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AccountIcon } from "../../../components/layout/nav-icons";
import { useAuthSession } from "../hooks/use-auth-session";
import styles from "./AccountMenu.module.css";

/** Account control for the application topbar: identity, ADMIN entry point, and sign out. */
export function AccountMenu() {
  const router = useRouter();
  const { state, signOut } = useAuthSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
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

  if (state.status !== "authenticated") {
    return null;
  }

  const { user } = state;
  const isAdmin = user.role === "ADMIN";

  async function handleSignOut() {
    setSigningOut(true);
    setError(false);

    try {
      await signOut();
      setOpen(false);
      router.replace("/login");
      router.refresh();
    } catch {
      setError(true);
      setSigningOut(false);
    }
  }

  return (
    <div className={styles.wrapper} ref={wrapper}>
      <button
        className={styles.trigger}
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Account"
        data-testid="account-menu-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <AccountIcon className={styles.triggerIcon} />
        <span className={styles.triggerEmail}>{user.email}</span>
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
            disabled={signingOut}
            data-testid="sign-out"
            onClick={handleSignOut}
          >
            {signingOut ? "Signing out..." : "Sign out"}
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

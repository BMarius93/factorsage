"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useAuthSession } from "../hooks/use-auth-session";
import {
  canNavigate,
  guardNavigation,
} from "../../../components/layout/unsaved-changes";
import { signInHref } from "../utils/guest-routes";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { PLAN_LABEL } from "../../billing/utils/format";
import styles from "./AccountMenu.module.css";

/**
 * Account control for the application topbar: identity, plan, billing, the ADMIN entry point and
 * sign out — or, for a Guest on a public page, the way to sign in.
 *
 * There is deliberately **no "Sign out everywhere" item**. Revoking every session of an account is
 * a real capability and it still exists end to end — `signOut({ everywhere: true })` here,
 * `POST /auth/logout-everywhere` and the `sessionTokenVersion` bump behind it — but it is a
 * security recovery step taken once after losing a device, not one of the four things a customer
 * opens this menu to do. Sitting under the ordinary Sign out, in the same shape and wording, its
 * main effect was to make the ordinary one a choice. When it is given a surface again it belongs
 * with the account's other security settings, next to the sessions it ends.
 */
export function AccountMenu() {
  const router = useRouter();
  const pathname = usePathname();
  const { state, signOut } = useAuthSession();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

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
        trigger.current?.focus();
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
    // A Guest browsing the public pages needs a way in, and a way to see what an account costs
    // before making one (PRICING-001).
    return (
      <div className={styles.guestLinks}>
        <Link
          className={styles.pricing}
          href="/pricing"
          data-testid="pricing-link"
          onNavigate={guardNavigation}
        >
          Pricing
        </Link>
        <Link
          className={styles.signIn}
          // The page being read is where signing in returns to (UI-042). The pathname is the same
          // on the server and the client, so the link never causes a hydration mismatch.
          href={signInHref(pathname ?? undefined)}
          data-testid="sign-in-link"
          onNavigate={guardNavigation}
        >
          Sign in
        </Link>
      </div>
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

  async function handleSignOut() {
    // Signing out leaves the page too, so unsaved work gets the same say as any navigation.
    if (!canNavigate()) {
      return;
    }
    setSigningOut(true);
    setError(false);

    try {
      await signOut({ everywhere: false });
      setOpen(false);
      router.replace("/login");
      router.refresh();
    } catch {
      setError(true);
      setSigningOut(false);
    }
  }

  return (
    <div
      className={styles.wrapper}
      ref={wrapper}
      // Tabbing past the last item closes the panel, as the other dropdowns do, so it never stays
      // open over the page the keyboard has moved on to.
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (
          open &&
          !(next instanceof Node && wrapper.current?.contains(next))
        ) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={trigger}
        className={styles.trigger}
        type="button"
        aria-expanded={open}
        aria-controls="account-panel"
        aria-label={`Account: ${user.email}`}
        data-testid="account-menu-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.monogram} aria-hidden="true">
          {monogram}
        </span>
      </button>

      {open ? (
        // A disclosure, modelled as one (UI-053): a labelled group of ordinary links and buttons
        // that Tab walks through, not a `role="menu"` that promises arrow keys it does not have.
        <div
          className={styles.menu}
          id="account-panel"
          role="group"
          aria-label="Account"
          data-testid="account-menu"
        >
          <div className={styles.identity}>
            <span className={styles.email} data-testid="account-email">
              {user.email}
            </span>
            {/* The plan is what a customer bought and what every limit follows from, so it is the
                badge here (UI-024). The role is internal, and only an administrator's adds
                meaning. */}
            <span className={styles.badges}>
              <StatusBadge tone="active" testId="account-plan">
                {PLAN_LABEL[user.plan]}
              </StatusBadge>
              {isAdmin ? (
                <StatusBadge
                  tone="neutral"
                  variant="outline"
                  testId="account-role"
                >
                  Admin
                </StatusBadge>
              ) : null}
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
            data-testid="account-billing-link"
            onNavigate={guardNavigation}
            onClick={() => setOpen(false)}
          >
            Plan and billing
          </Link>

          {isAdmin ? (
            <Link
              className={styles.menuLink}
              href="/admin"
              onClick={() => setOpen(false)}
            >
              Admin
            </Link>
          ) : null}

          <button
            className={styles.signOut}
            type="button"
            disabled={signingOut}
            data-testid="sign-out"
            onClick={() => void handleSignOut()}
          >
            {signingOut ? "Signing out…" : "Sign out"}
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

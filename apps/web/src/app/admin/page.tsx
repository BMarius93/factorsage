"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { logout } from "../../lib/auth-api";
import { useAuthUser } from "../../lib/use-auth-user";

export default function AdminPage() {
  const router = useRouter();
  const auth = useAuthUser();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(false);

  useEffect(() => {
    if (auth.status === "unauthenticated") {
      router.replace("/login");
    }
  }, [auth.status, router]);

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(false);

    try {
      await logout();
      router.replace("/login");
      router.refresh();
    } catch {
      setLogoutError(true);
      setLoggingOut(false);
    }
  }

  if (auth.status === "loading" || auth.status === "unauthenticated") {
    return (
      <main className="auth-shell">
        <p className="status-message" role="status">
          Checking access...
        </p>
      </main>
    );
  }

  if (auth.status === "error") {
    return (
      <main className="auth-shell">
        <section className="auth-panel compact-panel">
          <p className="brand-mark">IntrinsicValue</p>
          <h1>Unable to verify access</h1>
          <a className="text-link" href="/login">
            Return to sign in
          </a>
        </section>
      </main>
    );
  }

  const isAdmin = auth.user.role === "ADMIN";

  return (
    <main className="admin-shell">
      <header className="admin-topbar">
        <p className="brand-mark">IntrinsicValue</p>
        <button
          className="secondary-button"
          onClick={handleLogout}
          disabled={loggingOut}
        >
          {loggingOut ? "Signing out..." : "Sign out"}
        </button>
      </header>

      <section className="admin-content" aria-labelledby="admin-heading">
        <p className="section-label">Account access</p>
        <h1 id="admin-heading">{isAdmin ? "Admin" : "Access denied"}</h1>
        {!isAdmin ? (
          <p className="muted">
            This account does not have administrator access.
          </p>
        ) : null}

        <dl className="identity-list">
          <div>
            <dt>Email</dt>
            <dd>{auth.user.email}</dd>
          </div>
          <div>
            <dt>Role</dt>
            <dd>
              <span
                className={`role-badge ${isAdmin ? "role-admin" : "role-user"}`}
              >
                {auth.user.role}
              </span>
            </dd>
          </div>
        </dl>

        {logoutError ? (
          <p className="form-error" role="alert">
            Sign out failed. Please try again.
          </p>
        ) : null}
      </section>
    </main>
  );
}

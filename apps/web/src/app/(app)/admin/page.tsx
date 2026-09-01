"use client";

import { PageContainer } from "../../../components/layout/PageContainer";
import { RequireAuth } from "../../../features/auth/components/RequireAuth";
import { useAuthSession } from "../../../features/auth/hooks/use-auth-session";
import styles from "./admin.module.css";

/** ADMIN-only surface. The API enforces the same boundary on every administrative endpoint. */
export default function AdminPage() {
  return (
    <RequireAuth role="ADMIN">
      <PageContainer>
        <AdminOverview />
      </PageContainer>
    </RequireAuth>
  );
}

function AdminOverview() {
  const { state } = useAuthSession();
  if (state.status !== "authenticated") {
    return null;
  }

  return (
    <section className={styles.page} data-testid="admin-page">
      <p className={styles.label}>Account access</p>
      <h1 className={styles.title}>Admin</h1>
      <p className={styles.lead}>
        You are signed in with administrator access.
      </p>

      <dl className={styles.identity}>
        <div>
          <dt>Email</dt>
          <dd>{state.user.email}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>
            <span className={styles.roleBadge}>{state.user.role}</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

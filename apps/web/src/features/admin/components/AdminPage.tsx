"use client";

import { PageContainer } from "../../../components/layout/PageContainer";
import { FactGrid } from "../../../components/ui/FactGrid";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import page from "../../../components/ui/page.module.css";
import { RequireAuth } from "../../auth/components/RequireAuth";
import { useAuthSession } from "../../auth/hooks/use-auth-session";
import { BuiltInContentPanel } from "./BuiltInContentPanel";

/**
 * ADMIN-only surface, built from the same primitives as every other page (UI-052). The API
 * enforces the same boundary on every administrative endpoint; this only decides what renders.
 */
export function AdminPage() {
  return (
    <RequireAuth role="ADMIN">
      <PageContainer>
        <div className={page.stack}>
          <AdminHeader />
          <BuiltInContentPanel />
        </div>
      </PageContainer>
    </RequireAuth>
  );
}

function AdminHeader() {
  const { state } = useAuthSession();
  if (state.status !== "authenticated") {
    return null;
  }
  return (
    <>
      <PageHeader
        testId="admin-page"
        title="Admin"
        badges={<StatusBadge tone="positive">Administrator</StatusBadge>}
        lead="Built-in content is shared by every account. Changes made here, or on a built-in's own page, apply to everyone."
      />
      <SectionCard title="Your access">
        <FactGrid
          facts={[
            { label: "Signed in as", value: state.user.email },
            { label: "Role", value: state.user.role },
          ]}
        />
      </SectionCard>
    </>
  );
}

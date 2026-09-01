import type { ReactNode } from "react";
import { AppShell } from "../../components/layout/AppShell";
import { AccountMenu } from "../../features/auth/components/AccountMenu";
import { RequireAuth } from "../../features/auth/components/RequireAuth";
import { AuthSessionProvider } from "../../features/auth/hooks/use-auth-session";

/**
 * Every product route runs inside one authenticated session: the provider resolves it once, the
 * topbar renders the account controls, and the gate decides what unauthenticated browsers see.
 */
export default function AppRoutesLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <AuthSessionProvider>
      <AppShell topbarActions={<AccountMenu />}>
        <RequireAuth>{children}</RequireAuth>
      </AppShell>
    </AuthSessionProvider>
  );
}

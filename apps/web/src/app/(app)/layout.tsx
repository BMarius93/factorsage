import type { ReactNode } from "react";
import { AppShell } from "../../components/layout/AppShell";
import { AccountMenu } from "../../features/auth/components/AccountMenu";
import { RequireAuth } from "../../features/auth/components/RequireAuth";
import { AuthSessionProvider } from "../../features/auth/hooks/use-auth-session";
import { RecentSecuritiesProvider } from "../../features/stocks/recent/hooks/use-recent-securities";

/**
 * Every product route runs inside one authenticated session: the provider resolves it once, the
 * topbar renders the account controls, and the gate decides what unauthenticated browsers see.
 *
 * Recently viewed securities are held one level in, because both ends of that feature live here:
 * the topbar's search dropdown reads the set and every Stock Details page under `RequireAuth`
 * writes to it.
 */
export default function AppRoutesLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <AuthSessionProvider>
      <RecentSecuritiesProvider>
        <AppShell topbarActions={<AccountMenu />}>
          <RequireAuth>{children}</RequireAuth>
        </AppShell>
      </RecentSecuritiesProvider>
    </AuthSessionProvider>
  );
}

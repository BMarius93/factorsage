import type { ReactNode } from "react";
import { AppShell } from "../../components/layout/AppShell";
import { AccountMenu } from "../../features/auth/components/AccountMenu";
import { RouteAccessGate } from "../../features/auth/components/RouteAccessGate";
import { AuthSessionProvider } from "../../features/auth/hooks/use-auth-session";
import { RecentSecuritiesProvider } from "../../features/stocks/recent/hooks/use-recent-securities";

/**
 * Every product route runs inside one session provider: it resolves the session once, the topbar
 * renders the account controls, and the gate decides per route whether a Guest may see the page —
 * the Dashboard, stock pages and built-in content are public; everything else needs an account.
 *
 * Recently viewed securities are held one level in, because both ends of that feature live here:
 * the topbar's search dropdown reads the set and every Stock Details page writes to it — to the
 * account for a signed-in user, to the browser for a Guest.
 */
export default function AppRoutesLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <AuthSessionProvider>
      <RecentSecuritiesProvider>
        <AppShell topbarActions={<AccountMenu />}>
          <RouteAccessGate>{children}</RouteAccessGate>
        </AppShell>
      </RecentSecuritiesProvider>
    </AuthSessionProvider>
  );
}

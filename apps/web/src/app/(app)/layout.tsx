import type { ReactNode } from "react";
import { AppShell } from "../../components/layout/AppShell";
import { AccountMenu } from "../../features/auth/components/AccountMenu";
import { RouteAccessGate } from "../../features/auth/components/RouteAccessGate";
import { AuthSessionProvider } from "../../features/auth/hooks/use-auth-session";
import { LegalAcceptanceGate } from "../../features/legal/components/LegalAcceptanceGate";
import { StorageConsentProvider } from "../../features/legal/consent/use-storage-consent";
import { LegalAcceptanceProvider } from "../../features/legal/hooks/use-legal-acceptance";
import { RecentSecuritiesProvider } from "../../features/stocks/recent/hooks/use-recent-securities";

/**
 * Every product route runs inside one session provider: it resolves the session once, the topbar
 * renders the account controls, and the gate decides per route whether a Guest may see the page —
 * the Dashboard, stock pages, the legal documents and built-in content are public; everything
 * else needs an account.
 *
 * The storage-consent provider sits **outside** the session, because it governs the browser and
 * not the account: a Guest's choice has to be known before anything reads `localStorage`, and
 * recently viewed securities are exactly that storage. Ordering it this way is what makes "no
 * optional storage before a choice" a structural property rather than a timing accident.
 *
 * Recently viewed securities are held one level in, because both ends of that feature live here:
 * the topbar's search dropdown reads the set and every Stock Details page writes to it — to the
 * account for a signed-in user, to the browser for a Guest who has allowed it.
 *
 * `LegalAcceptanceGate` is the innermost wrapper, inside the shell rather than around it. That is
 * deliberate: it replaces the *route* with the acceptance screen and leaves the topbar, the
 * account menu (so signing out always works), the footer and the legal links in place. The
 * server enforces the same rule on every request, so this is routing, not security.
 */
export default function AppRoutesLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <StorageConsentProvider>
      <AuthSessionProvider>
        <LegalAcceptanceProvider>
          <RecentSecuritiesProvider>
            <AppShell topbarActions={<AccountMenu />}>
              <RouteAccessGate>
                <LegalAcceptanceGate>{children}</LegalAcceptanceGate>
              </RouteAccessGate>
            </AppShell>
          </RecentSecuritiesProvider>
        </LegalAcceptanceProvider>
      </AuthSessionProvider>
    </StorageConsentProvider>
  );
}

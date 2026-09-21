import type { ReactNode } from "react";
import { ConsentBanner } from "../../features/legal/consent/ConsentBanner";
import { SiteFooter } from "../../features/legal/components/SiteFooter";
import styles from "./AppShell.module.css";
import { AppTopbar } from "./AppTopbar";
import { MobileBottomNav } from "./MobileBottomNav";

type AppShellProps = {
  readonly children: ReactNode;
  /** Optional account/user controls rendered in the topbar. */
  readonly topbarActions?: ReactNode;
};

/**
 * Application chrome shared by every product route: persistent topbar, scrollable content
 * region, the legal footer, mobile bottom navigation, and the storage-choice banner.
 *
 * The footer is here, once, rather than per route: a legal destination must be reachable from
 * every page, and one footer in the shell is what makes that true without a route being able to
 * forget it. The auth screens render the same component from `AuthCard`, because they sit
 * outside this shell and are exactly where a footer usually goes missing.
 *
 * The consent banner is rendered last and is `position: fixed` above the bottom navigation, so
 * it never covers the primary nav or a mobile action bar. It renders nothing at all unless the
 * product genuinely has optional storage and the visitor has not chosen.
 */
export function AppShell({ children, topbarActions }: AppShellProps) {
  return (
    <div className={styles.shell}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <AppTopbar actions={topbarActions} />
      <main id="main-content" className={styles.main}>
        {children}
      </main>
      <SiteFooter />
      <MobileBottomNav />
      <ConsentBanner />
    </div>
  );
}

import type { ReactNode } from "react";
import styles from "./AppShell.module.css";
import { AppTopbar } from "./AppTopbar";
import { MobileBottomNav } from "./MobileBottomNav";

type AppShellProps = {
  readonly children: ReactNode;
  /** Optional account/user controls rendered in the topbar. */
  readonly topbarActions?: ReactNode;
};

/**
 * Application chrome shared by every product route: persistent topbar,
 * scrollable content region, and mobile bottom navigation.
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
      <MobileBottomNav />
    </div>
  );
}

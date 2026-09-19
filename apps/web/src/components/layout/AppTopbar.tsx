"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { StockSearch } from "../../features/stocks/search/components/StockSearch";
import styles from "./AppTopbar.module.css";
import { BRAND_NAME, BrandMark } from "./BrandMark";
import { AccountIcon } from "./nav-icons";
import {
  APP_HOME_HREF,
  DESKTOP_NAV_ITEMS,
  isNavItemActive,
} from "./navigation";
import { guardNavigation } from "./unsaved-changes";

type AppTopbarProps = {
  /**
   * Account/user controls. Left as a slot so authentication work can supply
   * real controls without changing the shell.
   */
  readonly actions?: ReactNode;
};

export function AppTopbar({ actions }: AppTopbarProps) {
  const pathname = usePathname() ?? "/";

  return (
    <header className={styles.topbar}>
      <Link
        href={APP_HOME_HREF}
        className={styles.brandLink}
        aria-label={`${BRAND_NAME} home`}
        // The brand is the Dashboard's only link, so it is what says "you are here" there (UI-053).
        // Routes that are not navigation items (Stock Details, Billing) claim no active item.
        aria-current={pathname === APP_HOME_HREF ? "page" : undefined}
        onNavigate={guardNavigation}
      >
        <BrandMark />
      </Link>

      {/* The shell composes the search feature; it never owns search behaviour. */}
      <StockSearch />

      <nav className={styles.desktopNav} aria-label="Primary">
        <ul className={styles.navList}>
          {DESKTOP_NAV_ITEMS.map((item) => {
            const active = isNavItemActive(pathname, item);

            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className={styles.navLink}
                  data-active={active}
                  aria-current={active ? "page" : undefined}
                  onNavigate={guardNavigation}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className={styles.actions}>
        {actions ?? (
          <span className={styles.accountPlaceholder} aria-hidden="true">
            <AccountIcon className={styles.accountIcon} />
          </span>
        )}
      </div>
    </header>
  );
}

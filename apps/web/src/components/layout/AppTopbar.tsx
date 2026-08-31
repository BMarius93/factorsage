"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import styles from "./AppTopbar.module.css";
import { BRAND_NAME, BrandMark } from "./BrandMark";
import { AccountIcon } from "./nav-icons";
import {
  APP_HOME_HREF,
  PRIMARY_NAV_ITEMS,
  isNavItemActive,
} from "./navigation";

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
      >
        <BrandMark />
      </Link>

      <nav className={styles.desktopNav} aria-label="Primary">
        <ul className={styles.navList}>
          {PRIMARY_NAV_ITEMS.map((item) => {
            const active = isNavItemActive(pathname, item);

            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  className={styles.navLink}
                  data-active={active}
                  aria-current={active ? "page" : undefined}
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

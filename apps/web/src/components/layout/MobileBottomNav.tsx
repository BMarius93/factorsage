"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./MobileBottomNav.module.css";
import { NAV_ICONS } from "./nav-icons";
import { PRIMARY_NAV_ITEMS, isNavItemActive } from "./navigation";

/**
 * Fixed bottom navigation for the same primary destinations the desktop
 * topbar exposes. Hidden once the persistent topbar navigation is visible.
 */
export function MobileBottomNav() {
  const pathname = usePathname() ?? "/";

  return (
    <nav className={styles.bottomNav} aria-label="Primary mobile">
      {PRIMARY_NAV_ITEMS.map((item) => {
        const active = isNavItemActive(pathname, item);
        const Icon = NAV_ICONS[item.id];

        return (
          <Link
            key={item.id}
            href={item.href}
            className={styles.navLink}
            data-active={active}
            aria-current={active ? "page" : undefined}
          >
            <Icon className={styles.icon} />
            <span className={styles.label}>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

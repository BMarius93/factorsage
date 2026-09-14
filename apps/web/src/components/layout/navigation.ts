/**
 * Single source of truth for the application shell's primary destinations.
 *
 * One registry, two surfaces. The desktop topbar and the mobile bottom navigation order
 * the same destinations differently and show different subsets of them, so each item
 * carries explicit per-surface metadata rather than the layouts keeping duplicate lists.
 *
 * Desktop leads with the things a returning user came to work on — Strategies, Monitors,
 * Backtests, Lists — and omits Dashboard, because the brand mark already links there.
 * The phone's bottom bar leads with Dashboard, because it is the one destination a thumb
 * reaches for first and there is no brand mark to tap.
 */

export type NavItemId =
  "dashboard" | "lists" | "strategies" | "backtests" | "monitors";

export type NavItem = {
  readonly id: NavItemId;
  readonly label: string;
  readonly href: string;
  /** Position in the desktop topbar. `null` keeps the destination out of it. */
  readonly desktopOrder: number | null;
  /** Position in the phone's bottom navigation. */
  readonly mobileOrder: number;
};

export const PRIMARY_NAV_ITEMS = [
  {
    id: "dashboard",
    label: "Dashboard",
    href: "/dashboard",
    desktopOrder: null,
    mobileOrder: 1,
  },
  {
    id: "lists",
    label: "Lists",
    href: "/lists",
    desktopOrder: 4,
    mobileOrder: 2,
  },
  {
    id: "monitors",
    label: "Monitors",
    href: "/monitors",
    desktopOrder: 2,
    mobileOrder: 3,
  },
  {
    id: "strategies",
    label: "Strategies",
    href: "/strategies",
    desktopOrder: 1,
    mobileOrder: 4,
  },
  {
    id: "backtests",
    label: "Backtests",
    href: "/backtests",
    desktopOrder: 3,
    mobileOrder: 5,
  },
] as const satisfies readonly NavItem[];

/** The topbar's destinations, in their own order. */
export const DESKTOP_NAV_ITEMS: readonly NavItem[] = [...PRIMARY_NAV_ITEMS]
  .filter((item) => item.desktopOrder !== null)
  .sort((a, b) => (a.desktopOrder ?? 0) - (b.desktopOrder ?? 0));

/** The bottom bar's destinations, in their own order. */
export const MOBILE_NAV_ITEMS: readonly NavItem[] = [...PRIMARY_NAV_ITEMS].sort(
  (a, b) => a.mobileOrder - b.mobileOrder,
);

/** Application home; the brand mark links back to it. */
export const APP_HOME_HREF = "/dashboard";

function normalizePath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] ?? "";
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * A destination is active for its own route and for anything nested below it,
 * so `/lists/42` keeps "Lists" highlighted. Matching is segment-aware:
 * `/listings` must not activate `/lists`. Routes outside this list, such as
 * `/stocks`, simply leave every destination inactive.
 */
export function isNavItemActive(pathname: string, item: NavItem): boolean {
  const current = normalizePath(pathname);
  const target = normalizePath(item.href);

  if (target === "/") {
    return current === "/";
  }

  return current === target || current.startsWith(`${target}/`);
}

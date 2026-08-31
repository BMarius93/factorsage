/**
 * Single source of truth for the application shell's primary destinations.
 * Both the desktop topbar navigation and the mobile bottom navigation render
 * this list; do not restate links inside layout components.
 */

export type NavItemId =
  "dashboard" | "lists" | "strategies" | "backtests" | "monitors";

export type NavItem = {
  readonly id: NavItemId;
  readonly label: string;
  readonly href: string;
};

export const PRIMARY_NAV_ITEMS = [
  { id: "dashboard", label: "Dashboard", href: "/dashboard" },
  { id: "lists", label: "Lists", href: "/lists" },
  { id: "strategies", label: "Strategies", href: "/strategies" },
  { id: "backtests", label: "Backtests", href: "/backtests" },
  { id: "monitors", label: "Monitors", href: "/monitors" },
] as const satisfies readonly NavItem[];

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

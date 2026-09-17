/**
 * The product routes a Guest may open.
 *
 * `docs/decisions/entitlements-v1.md` lets every viewer search and read stocks and read built-in
 * content, and `docs/decisions/builtin-dashboard-signals-v1.md` makes the Dashboard the first thing
 * a visitor sees. Built-in content is public product content, so its **collections** are readable
 * too, not only a detail page whose id someone already knows: a visitor who cannot browse the
 * built-in Lists, Strategies and Monitors cannot discover what the product does. Those pages show
 * the built-in sections alone and ask for an account at the point of action, which is what
 * `SignInPrompt` is for — a Guest is never bounced to `/login` for navigating.
 *
 * Everything else in the application needs a session. A detail route is readable because it may
 * name a built-in; the API still answers `404` for anybody else's content.
 */
const GUEST_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/dashboard$/,
  /^\/stocks(\/[^/]+)?$/,
  /^\/lists(\/[^/]+)?$/,
  /^\/strategies(\/(?!new$)[^/]+)?$/,
  /^\/monitors(\/[^/]+)?$/,
];

export function isGuestReadableRoute(pathname: string): boolean {
  const path = pathname.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") ?? "";
  return GUEST_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

/** Where a Guest goes to sign in, and back to the page they were on afterwards. */
export function signInHref(): string {
  return "/login";
}

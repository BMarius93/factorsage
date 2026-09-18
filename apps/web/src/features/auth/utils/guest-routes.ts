import { DEFAULT_RETURN_PATH, safeReturnPath } from "./return-path";

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
 * `/pricing` is public too: a visitor deciding whether to sign up is entitled to see what it costs
 * (DEC-001). Its plan buttons ask for an account in place, like every other action here.
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
  // The public price list (PRICING-001, DEC-001). `/billing`, which acts on a subscription, is not.
  /^\/pricing$/,
];

export function isGuestReadableRoute(pathname: string): boolean {
  const path = pathname.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") ?? "";
  return GUEST_ROUTE_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Where a Guest goes to sign in, carrying the page to come back to afterwards (UX-003).
 *
 * `next` is validated here as well as where it is read, so a link this app renders can never carry
 * a destination the sign-in page would refuse. The Dashboard is the default either way, so it is
 * left out rather than spelled as `?next=%2Fdashboard`.
 */
export function signInHref(next?: string): string {
  return withReturnPath("/login", next);
}

/** The same, for creating an account instead. */
export function registerHref(next?: string): string {
  return withReturnPath("/register", next);
}

function withReturnPath(page: string, next: string | undefined): string {
  if (next === undefined) {
    return page;
  }
  const destination = safeReturnPath(next);
  return destination === DEFAULT_RETURN_PATH
    ? page
    : `${page}?next=${encodeURIComponent(destination)}`;
}

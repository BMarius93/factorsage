import { isGuestReadableRoute } from "./guest-routes";
import { DEFAULT_RETURN_PATH, safeReturnPath } from "./return-path";

/**
 * The one line the sign-in page shows about why it is asking (GL-7).
 *
 * A Guest who follows the topbar's Backtests link is bounced off a protected route to `/login`
 * with the page kept as `?next=` (UX-003), and used to land on a bare form that never said why.
 * Each line names what an account is for there, and nothing a plan does or does not include: an
 * account starts on Free, so a line that promised a capability would be a promise the plan might
 * not keep.
 */
export const SIGN_IN_REASONS = {
  backtests: "Sign in to run and review your backtests.",
  newStrategy: "Sign in to create and save a strategy.",
  newList: "Sign in to create and save a stock list.",
  billing: "Sign in to manage your plan and billing.",
  privacyRequests:
    "Sign in to make a privacy or data request from your account.",
  fallback: "Sign in to continue to that page.",
} as const;

/** A throwaway origin to read an app-relative path's parts with a real URL parser. */
const PROBE_ORIGIN = "http://sign-in-reason.invalid";

/** The sign-in screens themselves: a destination that is one of them needs no reason. */
const AUTH_PAGES: ReadonlySet<string> = new Set([
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
]);

/** `/backtests` and everything under it. */
function within(path: string, section: string): boolean {
  return path === section || path.startsWith(`${section}/`);
}

/**
 * Why signing in is needed for `next`, or `null` when there is nothing to say.
 *
 * The line is chosen, never composed: `next` goes through `safeReturnPath` first, and only the
 * accepted path is compared against fixed routes, so nothing from the query string — or anything
 * else a link can carry — is ever echoed onto the sign-in page.
 *
 * - No destination, or one that was refused, is the Dashboard: no line.
 * - A page a Guest may already read gets no line either. The topbar's own "Sign in" carries the
 *   page it was used on, and somebody who chose to sign in from a page they can read was not sent
 *   here for a reason. `/lists?new=1` is the exception: it is the "Create a stock list" action,
 *   which is what an account is for there.
 * - Any other app path gets its own line where one is written, and the generic one otherwise.
 */
export function signInReason(next: unknown): string | null {
  const destination = safeReturnPath(next);
  if (destination === DEFAULT_RETURN_PATH) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(destination, PROBE_ORIGIN);
  } catch {
    return null;
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/lists" && url.searchParams.get("new") === "1") {
    return SIGN_IN_REASONS.newList;
  }
  if (isGuestReadableRoute(path) || AUTH_PAGES.has(path)) {
    return null;
  }
  if (within(path, "/backtests")) {
    return SIGN_IN_REASONS.backtests;
  }
  if (path === "/strategies/new") {
    return SIGN_IN_REASONS.newStrategy;
  }
  if (within(path, "/billing")) {
    return SIGN_IN_REASONS.billing;
  }
  if (within(path, "/legal/requests")) {
    return SIGN_IN_REASONS.privacyRequests;
  }
  return SIGN_IN_REASONS.fallback;
}

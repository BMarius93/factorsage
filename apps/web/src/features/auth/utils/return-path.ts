/**
 * Where the browser goes after signing in (UX-003).
 *
 * A guest asked to sign in from a built-in strategy, or bounced from a protected URL, should land
 * back on that page — prefill query and all — rather than on the Dashboard. The destination
 * travels as `?next=` through the sign-in pages, and a value anybody can put in a link is the
 * textbook open redirect: `/login?next=//evil.example` must never send a freshly signed-in user
 * off-site. So a destination is accepted only when it is a bounded, app-relative path, and
 * everything else — including nothing — becomes the Dashboard.
 *
 * The API validates its own copy before the Google redirect (`apps/api/src/auth/return-path.ts`).
 * Neither side trusts the other, and one shared corpus in `@intrinsic/testing` keeps them agreeing.
 */

/** The post-sign-in default, and what every rejected value resolves to. */
export const DEFAULT_RETURN_PATH = "/dashboard";

/** Far above any real product URL, and small enough that a query string cannot be abused. */
export const MAX_RETURN_PATH_LENGTH = 2048;

/**
 * Percent-decoding rounds checked before a value is refused as too deeply encoded. One round is
 * what a browser applies; the rest catch a double-encoded `//` that some later hop might decode.
 */
const MAX_DECODE_ROUNDS = 3;

/** A throwaway origin: a path resolved against it must stay on it. */
const PROBE_ORIGIN = "http://return-path.invalid";

/**
 * The app-relative destination `value` names, or `/dashboard`.
 *
 * Accepted: one leading `/`, then any path, query and fragment, up to `MAX_RETURN_PATH_LENGTH`.
 * Refused: anything that is not a string, empty, too long, not starting with exactly one `/`,
 * containing a backslash or a control character — at every level of percent-decoding — or
 * resolving to another origin. The accepted value is returned unchanged, so a destination is never
 * re-encoded on its way through.
 */
export function safeReturnPath(value: unknown): string {
  return isSafeReturnPath(value) ? value : DEFAULT_RETURN_PATH;
}

function isSafeReturnPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RETURN_PATH_LENGTH
  ) {
    return false;
  }

  let current = value;
  for (let round = 0; ; round += 1) {
    if (!isPlainAppPath(current)) {
      return false;
    }
    const decoded = decodeOnce(current);
    if (decoded === null) {
      return false;
    }
    if (decoded === current) {
      break;
    }
    if (round === MAX_DECODE_ROUNDS) {
      return false;
    }
    current = decoded;
  }

  // The last word belongs to a real URL parser: whatever the string rules missed, a destination
  // that resolves off the probe origin is not app-relative.
  try {
    return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}

function isPlainAppPath(candidate: string): boolean {
  return (
    candidate.startsWith("/") &&
    !candidate.startsWith("//") &&
    !candidate.includes("\\") &&
    !hasControlCharacter(candidate)
  );
}

/** C0 controls, DEL and C1 controls. A URL parser strips some of them, which is how `/\t/x` becomes `//x`. */
function hasControlCharacter(candidate: string): boolean {
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function decodeOnce(candidate: string): string | null {
  try {
    return decodeURIComponent(candidate);
  } catch {
    return null;
  }
}

/**
 * The page the browser is on now, as a return destination: path plus query, never the origin.
 *
 * Read from `window.location` rather than the router hooks on purpose. Its callers are an effect
 * and a dialog that only exists after a click, both strictly client-side, and reading the search
 * params through `useSearchParams` would force every page behind the route gate out of static
 * rendering for a value only needed at that moment.
 */
export function currentReturnPath(): string {
  if (typeof window === "undefined") {
    return DEFAULT_RETURN_PATH;
  }
  return `${window.location.pathname}${window.location.search}`;
}

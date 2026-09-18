/**
 * Where a completed Google sign-in sends the browser (UX-003).
 *
 * `GET /auth/google?next=…` lets a sign-in started from a page return to that page. The value
 * comes from a query string anybody can write, and it ends up in a `302 Location` on the
 * session-holding API, which makes it the textbook open redirect. So the API validates it with its
 * own function — it never trusts the web app's check — once when the flow starts and again at the
 * callback, because the OAuth transaction cookie that carries it in between is not signed.
 *
 * The rules match the web app's `features/auth/utils/return-path.ts`; one shared corpus in
 * `@intrinsic/testing` keeps the two in step. Whatever passes is only ever appended to
 * `WEB_BASE_URL`, so the worst a tampered value can do is name another page of the app.
 */

/** The post-sign-in default, and what every rejected value resolves to. */
export const DEFAULT_RETURN_PATH = "/dashboard";

/** Far above any real product URL, and small enough that a cookie cannot be bloated with it. */
export const MAX_RETURN_PATH_LENGTH = 2048;

/** Percent-decoding rounds checked before a value is refused as too deeply encoded. */
const MAX_DECODE_ROUNDS = 3;

/** A throwaway origin: a path resolved against it must stay on it. */
const PROBE_ORIGIN = "http://return-path.invalid";

/**
 * The app-relative destination `value` names, or `/dashboard`.
 *
 * Accepted: one leading `/`, then any path, query and fragment, up to `MAX_RETURN_PATH_LENGTH`.
 * Refused: anything that is not a string (an absent or repeated query parameter included), empty,
 * too long, not starting with exactly one `/`, containing a backslash or a control character — at
 * every level of percent-decoding — or resolving to another origin.
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

/** C0 controls, DEL and C1 controls: header injection, and characters URL parsers strip. */
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

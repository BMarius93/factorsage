/**
 * Which incoming requests the Next.js development server keeps out of its request log.
 *
 * `next dev` writes one line per request it serves — method, path **and query string**, status,
 * timing. Two pages are opened from an emailed link whose query string is the credential itself:
 * `/verify-email?token=…` activates an account and `/reset-password?token=…` sets a new password
 * (`AuthEmailService` builds both links). The token is single-use and the API stores only its
 * hash, so that log line was the one place its plaintext outlived the email: a terminal
 * scrollback, a stack log file, a CI artifact — redeemable by whoever reads it before the link's
 * owner does.
 *
 * Next.js's own `logging.incomingRequests.ignore` drops those lines: an array of patterns tested
 * against the raw request URL, path plus query string. Nothing else is affected — the pages are
 * served exactly as before, and every other request is still logged. Only `next dev` logs
 * requests at all, so a production server (`next start`) never wrote these lines and still does
 * not; the API's logging is a separate system and is untouched.
 *
 * No other page receives a secret in its URL. `/login?next=…&error=…` and `/billing?checkout=…`
 * carry a destination and an outcome, and Google's `code` and `state` return to the API's
 * callback, not to the web app. A new page that does receive one must be added here;
 * `request-logging.test.ts` fails when a route that reads a `token` parameter is missing.
 *
 * Imported by `next.config.ts`, so it depends on nothing but the language.
 */

/** The `logging` section of the Next.js configuration, as far as this module sets it. */
export type RequestLoggingConfig = {
  readonly incomingRequests: { readonly ignore: RegExp[] };
};

/** Every web route whose URL carries a one-time authentication token in its query string. */
export const TOKEN_BEARING_ROUTE_PATHS = [
  "/verify-email",
  "/reset-password",
] as const;

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One pattern per token-bearing route, each matching that route and nothing else: the exact path,
 * an optional trailing slash, then a query string or the end of the URL. A longer first segment
 * (`/verify-emails`), a deeper path and a mention of the path inside another route's query string
 * all stay logged.
 *
 * Case-insensitive on purpose: a mis-cased link is answered `404`, and its query string is no
 * less a token. Never `g` or `y`: Next.js calls `test()` on the same pattern object for every
 * request, and either flag would make it remember where the previous match ended.
 */
export function incomingRequestLogIgnorePatterns(): RegExp[] {
  return TOKEN_BEARING_ROUTE_PATHS.map(
    (path) => new RegExp(`^${escapeForPattern(path)}/?(?:\\?|$)`, "i"),
  );
}

/** The request-logging configuration `next.config.ts` hands to Next.js. */
export function webRequestLoggingConfig(): RequestLoggingConfig {
  return { incomingRequests: { ignore: incomingRequestLogIgnorePatterns() } };
}

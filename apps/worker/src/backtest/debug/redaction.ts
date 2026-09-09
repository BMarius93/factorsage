/**
 * The one place an archive writes text it did not construct itself.
 *
 * Every other field in a forensic archive is built from an explicit allowlist, which is what keeps
 * secrets out of it: nothing is serialized wholesale and then cleaned up afterwards. An exception
 * message and its stack are the exception, and they are worth keeping — the failure they describe
 * is usually the reason the archive exists — so they are scrubbed on the way in.
 *
 * What can genuinely appear in one: a provider URL carrying `apikey=…`, a PostgreSQL or Redis URL
 * carrying a password, a bearer token echoed by an HTTP client. All three are replaced outright
 * rather than partially masked, because a partially masked credential is still a credential with a
 * hint attached.
 */

const PATTERNS: readonly [RegExp, string][] = [
  // Any URL at all. A provider URL is the common case; keeping the scheme and host would still
  // leak a userinfo credential, and neither is worth a special case in a diagnostic message.
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<redacted-url>"],
  // `Bearer <token>` / `Basic <token>` as they appear in a thrown HTTP error. Before the rule
  // below, which would otherwise consume the scheme word as the value and leave the token.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
  // A credential in a query string or a key/value pair, with or without a URL around it.
  [
    /\b(api[_-]?key|apikey|access[_-]?token|token|secret|password|passwd|pwd|authorization|auth)\b\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    "$1=<redacted>",
  ],
];

/** Applies every rule above. Returns the text unchanged when nothing matches. */
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const [pattern, replacement] of PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

/** Beside an email field left empty: sign-in (UI-041) and registration (AU-1) say the same thing. */
export const EMAIL_REQUIRED_MESSAGE = "Enter your email address.";

/** Beside an email field holding an address the API would refuse as malformed (AU-1). */
export const EMAIL_INVALID_MESSAGE =
  "Enter a valid email address, like name@example.com.";

/** The longest address the API accepts. */
export const MAX_EMAIL_ADDRESS_LENGTH = 320;

/** Something, `@`, something, `.`, something — and no whitespace anywhere. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether the API would accept `value` as an email address.
 *
 * The same rule as `isValidEmail` in `apps/api/src/auth/email.ts` — trimmed, 1 to 320 characters,
 * the same pattern — mirrored rather than imported because the web app reaches nothing but
 * `@intrinsic/contracts`. It must never be stricter than the API's: a form that refused an address
 * the server accepts would lock somebody out with no way round it. Casing is irrelevant to the
 * pattern, so the API's lower-casing is not repeated. The API still validates every request; this
 * only answers an obvious typo beside the field instead of with a round trip.
 */
export function isValidEmailAddress(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_EMAIL_ADDRESS_LENGTH &&
    EMAIL_PATTERN.test(trimmed)
  );
}

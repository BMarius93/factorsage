import type { GoogleIdentity } from "./google-identity";

/**
 * Mailbox domains Google itself operates.
 *
 * For an address here, Google is the mail provider: nobody can hold the mailbox without holding
 * the Google account, so `email_verified` and ownership are the same statement.
 * `googlemail.com` is the historical German/UK alias of `gmail.com` and is the same mail system.
 */
const GOOGLE_OPERATED_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
]);

/**
 * How far Google's word goes for one verified address.
 *
 * `email_verified` means Google checked that this account can receive mail at this address at
 * some point — not that Google runs the address. A consumer Google account can be created around
 * any third-party address, so the claim alone is a statement about the provider's records, not
 * proof that the person in front of Google still owns the mailbox today.
 */
export type GoogleEmailAuthority =
  /** Google operates the mailbox (`gmail.com`, `googlemail.com`). */
  | "GOOGLE_MAILBOX"
  /** A Workspace/Cloud organization Google verified owns the address's domain (`hd`). */
  | "WORKSPACE_DOMAIN"
  /** Verified at Google, but the domain belongs to somebody else. */
  | "EXTERNAL";

/** The domain half of an already-normalized address, or `null` when there is not exactly one. */
function emailDomain(email: string): string | null {
  const parts = email.split("@");
  if (parts.length !== 2) {
    return null;
  }
  const domain = normalizeDomain(parts[1] ?? "");
  return domain.length > 0 ? domain : null;
}

/** Domains are case-insensitive, and a fully qualified name may carry a trailing root dot. */
function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Classifies how authoritative Google is for this identity's email address.
 *
 * The `hd` claim is the only thing in a Google ID token that says an organization proved to Google
 * that it owns a domain, so it — not `email_verified` — is what makes a Workspace address as
 * trustworthy as a Gmail one. It is required to equal the address's own domain: a Workspace whose
 * primary domain differs from the address's domain proves ownership of the former, and this
 * function cannot tell a verified secondary domain apart from an unrelated one.
 *
 * Pure, so both the sign-in path and its tests decide this the same way.
 */
export function resolveGoogleEmailAuthority(
  identity: Pick<GoogleIdentity, "email" | "emailVerified" | "hostedDomain">,
): GoogleEmailAuthority {
  // Defence in depth: callers refuse an unverified address before reaching here, and an
  // unverified address can never be more than external whatever else the token carries.
  if (!identity.emailVerified || !identity.email) {
    return "EXTERNAL";
  }

  const domain = emailDomain(identity.email);
  if (!domain) {
    return "EXTERNAL";
  }

  if (GOOGLE_OPERATED_MAILBOX_DOMAINS.has(domain)) {
    return "GOOGLE_MAILBOX";
  }

  const hostedDomain = identity.hostedDomain
    ? normalizeDomain(identity.hostedDomain)
    : null;
  if (hostedDomain && hostedDomain === domain) {
    return "WORKSPACE_DOMAIN";
  }

  return "EXTERNAL";
}

/**
 * Whether this authority is enough to attach the identity to an account that already exists.
 *
 * Creating a brand-new account for an unclaimed address takes nothing from anybody, so it is
 * deliberately a weaker bar. Adopting an existing account is a takeover unless Google actually
 * speaks for the address.
 */
export function mayLinkToExistingAccount(
  authority: GoogleEmailAuthority,
): boolean {
  return authority === "GOOGLE_MAILBOX" || authority === "WORKSPACE_DOMAIN";
}

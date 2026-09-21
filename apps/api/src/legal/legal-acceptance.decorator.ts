import { SetMetadata } from "@nestjs/common";

export const LEGAL_ACCEPTANCE_EXEMPT_KEY = "legal:acceptance-exempt";

/**
 * Declares that a route stays reachable for a signed-in user who has **not** accepted the
 * required Terms version, and why.
 *
 * The default is the other way round: every mounted route is gated, so a new controller is
 * protected on the day it is written rather than on the day somebody remembers it.
 * `legal-acceptance-coverage.test.ts` prints this reason for every exemption, so the allowlist is
 * a set of decisions somebody wrote down.
 *
 * There are only three legitimate classes of exemption, and the first is the important one:
 *
 * - **the routes a declining user must still be able to reach.** A compliance gate that traps a
 *   paying customer is worse than no gate: cancelling a renewal, submitting a statutory
 *   withdrawal or a privacy request, contacting support, reading the documents themselves and
 *   signing out all have to work without accepting anything.
 * - **authentication itself**, because accepting requires being signed in, and signing out must
 *   never require accepting.
 * - **callers that are not a user**: orchestrator health probes and the Stripe webhook, whose
 *   caller is authenticated by a signature over the raw body and has no account at all.
 *
 * Anything that reads or writes product content is not on that list.
 */
export const LegalAcceptanceExempt = (reason: string) =>
  SetMetadata(LEGAL_ACCEPTANCE_EXEMPT_KEY, reason);

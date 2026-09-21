# Owner inputs, counsel review and release readiness

This is an explicit unknowns register, not a request to pause engineering. Complete reversible
implementation with draft configuration; never substitute plausible invented facts.

**Status after the 2026-09-21 implementation: every entry below is still open.** Nothing here was
guessed, defaulted or quietly resolved. What changed is that each one now has a mechanism waiting
for it and a build that refuses to publish without it:

- `O1`, `O2`, `O3`, `O8`, `O9`, `O12` are the ten `NEXT_PUBLIC_LEGAL_*` variables in
  `.env.example`. Unset, each renders on the page as a marker naming the fact and this register's
  entry; a declared release build fails and lists them.
- `O4`, `O5`, `O7`, `O10`, `O11` are marked in place in the draft copy as pending passages, so a
  reviewer sees the gap on the page rather than only in this table.
- `O6` is half done: the inventory was verified in a browser against this build
  ([storage-inventory.md](storage-inventory.md)) and found one optional purpose and no
  third-party request. It has **not** been verified against a production deployment.

`pnpm legal:check` prints the outstanding list at any time.

| ID | Needed decision/evidence | Responsible party | Release consequence |
| --- | --- | --- | --- |
| O1 | Contracting entity, country, registered address, registration/tax identifiers, required contact details | Owner/accountant | No public paid launch with unidentified seller. |
| O2 | Monitored support/privacy/complaint contacts and request-handling ownership | Owner | Rights and support pages cannot promise nonexistent channels. |
| O3 | Markets served, B2C/B2B scope, age policy, required policy languages | Owner/counsel | Determines law, wording and territorial limits. |
| O4 | Hosting, email, identity, billing, logging providers; regions; agreements and transfers | Owner/engineer/privacy counsel | Complete truthful Privacy Policy and supplier safeguards. |
| O5 | Data retention per category, dormant/pending accounts, logs, backups, billing/legal evidence | Owner/counsel/engineer | Implement and disclose actual durations/criteria; do not invent 30/90-day rules. |
| O6 | Full **deployed** cookie/storage inventory and category decisions | Engineer/privacy reviewer | Partly done: verified in a browser against this build (guest recents classified optional, one banner therefore required, no third-party request). Re-verify against production before publishing. |
| O7 | SaaS consumer classification, withdrawal rules, immediate service request, online function, model form, refund handling | Romanian consumer-law counsel | Unresolved financial outcomes must not be auto-decided by Copilot. |
| O8 | Taxes, display of tax-inclusive total, invoices and Stripe configuration | Owner/accountant | Stripe integration alone does not establish tax compliance. |
| O9 | Liability exclusion, any cap, termination, governing law, jurisdiction and ADR wording | Counsel | Draft clauses must not be represented as enforceable legal protection. |
| O10 | Financial-regulatory classification of valuations, built-in strategies and public BUY/SELL outputs | Financial-regulatory counsel | Evaluate actual product/marketing and applicable instruments/markets; disclaimer alone insufficient. |
| O11 | FMP contract permits commercial display/redistribution/derived data, retention and required attribution; other data/logo licenses | Owner/provider | An API subscription is not proof of display rights. |
| O12 | Accessibility obligations/exemptions, current ANPC/SAL requirements and current dispute links | Counsel | Validate requirements for this operator; do not reuse obsolete ODR boilerplate. |

## Decisions this package deliberately makes

- One public legal destination per subject, with consistent footer/auth access.
- Verified identity-bound Terms acceptance, separate from cookie/marketing consent.
- No blanket accuracy guarantee, investment-return promise or universal liability waiver.
- Preserve mandatory consumer rights and existing billing/financial-engine architecture.
- Use optional preference treatment for persistent guest recents unless a reviewed basis says otherwise.
- No new analytics, newsletter, paid plan or trial.
- Legal pages can be built and reviewed with placeholders in development; public release requires
  resolved facts and approved wording. Unresolved issues must appear in the implementation report.

## Evidence maintained outside the public repository

Executed supplier agreements, legal advice, identity documents, tax records, actual customer
requests and acceptance records belong in appropriate access-controlled systems. Store only
non-sensitive approval status, responsible role, date, document version and a safe reference here.

## Operational readiness

Assign an operator for privacy requests, withdrawal/refund requests, failed confirmation delivery,
data-quality corrections and incidents. Document identity verification, deadline tracking, escalation,
fulfillment, lawful retention exceptions and backup handling. For GDPR requests, plan for the
applicable one-month response deadline and lawful extensions/notifications rather than promising
instant erasure. No email channel is operational merely because a link exists.

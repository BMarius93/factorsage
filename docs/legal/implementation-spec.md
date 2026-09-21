# Legal UX and compliance implementation specification

> **Implemented 2026-09-21.** This stays the specification; `ai/architecture/legal-compliance.md`
> describes what was actually built, and where the two differ that document is the accurate one.
> Read it alongside this when changing any of the behaviour below.

Status: implemented, with draft copy; read [README](README.md) and
[open facts](owner-inputs-and-review.md).

## 1. Scope and boundaries

Build public legal pages, a compact shared footer, contextual research disclosures, auditable
Terms acceptance, honest storage controls, subscription disclosures and usable rights/request
paths. Preserve financial formulas, immutable backtest snapshots, canonical catalogs, Monitor
lifecycle and the existing billing transition matrix. Never claim that liability is fully waived.
Do not add analytics, newsletter subscriptions, trials or a new payment flow just for this work.

Separate three statuses in implementation notes: verified current fact, proposed behavior, owner/legal
decision outstanding. Unknown legal facts must not silently become production copy.

## 2. Public routes and layout

Proposed canonical routes (check for conflicts before adding):

| Route | Content |
| --- | --- |
| `/terms` | Contracting party, service scope, user obligations, subscription terms, lawful liability limits, termination, complaints and rights. |
| `/privacy` | Controller, purposes/grounds, categories, recipients, retention, transfers, rights and complaint contact. |
| `/cookies` | Actual cookie/storage inventory and category explanations. |
| `/risk-disclosure` | Research scope, strategy matches, model/data/backtest limits and investment risk. |
| `/contact` | Legal identity, address, registration/tax identifiers as applicable, working support/privacy contacts, complaint process. |
| `/cancellation-and-refunds` | Renewal cancellation versus statutory withdrawal versus defective-service remedies. |

Pages are readable as Guest, with expired/malformed sessions, and without optional storage consent.
No paywall, authentication redirect, modal-only document or tiny unreadable text. Show effective
date and immutable document version. Provide accessible heading structure and printable content.

Footer: Terms, Privacy, Cookies, Risk disclosure, Cancellation & refunds, Contact; Cookie settings
when optional purposes exist. Identify the legal operator, not only the product brand. Use shared
tokens and responsive wrapping; keep mobile action bars and chart controls unobstructed. Include
legal links in auth surfaces even where the application shell is absent. Render one footer per page.

## 3. Acceptance and verified identity

Terms acceptance is contractual acceptance. Privacy notice is information, not a blanket consent
to every processing purpose. Marketing and device-storage consent are separate choices.

### Email flow

Keep email-first registration and its enumeration-resistant response. Display Terms/Privacy links
at initial email entry. Require an unchecked Terms checkbox when the verified mailbox holder
activates the account and chooses a password. Atomically store the successful acceptance with
activation; reject missing/false/unknown or stale required versions server-side. Preserve one-use
activation tokens and existing error behavior. Do not let an anonymous registration request overwrite
another account's acceptance. If initial registration also collects a checkbox, it is not the final
identity-bound acceptance record.

### Google flow

Both Google buttons (sign-in and registration) must cover new accounts. After verified OAuth,
route a user lacking acceptance through legal onboarding before normal protected product use.
Use a restricted authenticated pending state or equivalent secure server design; enforce the gate
at protected API mutation boundaries, not only in React. Existing accepted users sign in normally.
Do not trust an arbitrary query parameter, localStorage flag or unsigned OAuth transaction cookie
as proof of acceptance. Preserve PKCE, state, nonce, identity-linking policy and return-path checks.
Never require reacceptance simply for linking a provider to an already compliant account.

### Existing accounts and updates

Do not backfill historical users as having accepted. Prompt once for the required Terms version,
with an honest migration notice. No repeated checkbox at every login. Retain access to legal pages,
support, logout, cancellation/withdrawal and privacy requests if Terms are declined. Define a narrow
allowlist so compliance gating cannot trap a paying user. Material changes use an explicit required
version and notice policy; a typo or Privacy update must not automatically force Terms acceptance.

### Persistence

Use PostgreSQL and an explicit migration. Minimum acceptance event: user id, document kind/version,
server timestamp and acceptance surface (`EMAIL_ACTIVATION`, `GOOGLE_ONBOARDING`, `EXISTING_ACCOUNT`).
Keep immutable versioned document text and a digest; an event must resolve to the exact accepted
text. Enforce idempotency per user/document/version. Do not collect IP/user-agent merely for this
record unless a purpose and retention policy are approved. Do not log credentials or full requests.
Retention/deletion of acceptance evidence needs the same privacy treatment as other account data.

Expose only necessary acceptance state in canonical contracts. Follow existing rate-limit,
authorization and OpenAPI requirements for any new/changed endpoint. Update QA seeders explicitly
for synthetic test acceptance, without marking real accounts as accepted.

## 4. Cookie and browser-storage controls

Inventory first-party, third-party and hosted-service behavior for Guest, email auth, Google auth,
pricing, Checkout and billing. Include cookies, local/session storage, pixels, external assets and
scripts. Record name/pattern, domain, provider, purpose, trigger, duration, category and evidence.

Known candidates: configured session cookie, 10-minute OAuth transaction cookie, guest-recents
localStorage key from README. Session name/TTL must match deployment. Guest recents are convenience
storage: do not declare them strictly necessary without review. Conservative implementation default:
persistent guest recents are optional preferences; before consent use memory only, on refusal stop
reads/writes and clear the application's optional key. Do not clear authentication or unrelated storage.

If verified inventory has only exempt strictly necessary purposes, do not show a fake Accept banner.
Otherwise offer equally accessible Accept all, Reject optional and Customize on the first layer;
optional categories default off. No scripts/storage for optional purposes before valid consent, no
scroll-as-consent, prechecked toggles or site access conditioned on optional consent. Do not load a
tracker merely to render the preference dialog. Store minimal versioned preferences and sufficient
evidence of the actual choice, with an approved expiry; do not invent a legally mandatory duration.

Cookie settings allows withdrawal as easily as acceptance. Stop future optional processing and
remove controlled optional identifiers where feasible. A material purpose change invalidates the
affected consent, not unrelated necessary session data. Storage-disabled, cross-tab and expired
choice behavior must fail safely. Hosted Stripe/Google pages have their own behavior: document the
boundary honestly and do not claim the local banner controls those pages.

## 5. Contextual financial disclosures

Use the draft in `public-copy-drafts.md`, subject to review. Short notice on dashboard/Monitor
results: automated strategy matches, not instructions to trade; link to full disclosure. Backtest
results: hypothetical results with model/data limitations. Stock valuation views: model-based
estimates, not guaranteed fair prices. Reuse one copy source rather than drifting strings.

BUY/SELL/FINAL EXIT remain valid domain labels. Explain them; do not change engine semantics or
blindly rename APIs. Preserve the distinction between active occurrences and pending setups:
an ACTIVE signal can be latched and is not necessarily a newly fired trigger at the current instant.
Avoid copy suggesting every displayed item is a fresh recommendation or executable quote.

Show available observation/as-of times truthfully. Distinguish quote time, scan time and end-of-day
series. Never label everything real-time. Where unavailable, say so rather than invent timestamps.
Describe actual fees, dividends, slippage, fill timing, benchmark treatment and data gaps using the
existing methodology. A static present-day stock universe may introduce survivorship/selection bias;
user-supplied membership windows do not prove historical constituent completeness. Do not claim
that a disclaimer permits knowingly inaccurate outputs or excuses fixing defects.

Built-in strategies/signals and public marketing need financial-regulatory review. Describing an
output as educational or a match is not, by itself, an exemption. Do not remove built-ins or declare
them legally approved on the agent's own initiative.

## 6. Paid subscriptions, cancellation and withdrawal

Use existing central plan/price definitions; do not duplicate amounts in legal text. Before the final
payment action show plan, currency, total payable including applicable taxes, interval, renewal,
cancellation effect and applicable withdrawal information. Annual billing must state annual amount,
not only a monthly equivalent. Hosted Checkout must actually display and collect what the flow claims.
Keep a durable confirmation of applicable contract terms and order details (e.g. email with attached
or included versioned terms, not only a mutable URL). Handle retries and failed delivery visibly.

Maintain three distinct operations:

1. Cancel renewal: existing period-end cancellation policy and access end date.
2. Statutory withdrawal: eligible distance-contract right; intake, acknowledgment and legal outcome.
3. Nonconformity/other refund claim: separate support path; not erased by withdrawal expiry.

No blanket No refunds, no waiver bundled with signup, and no assumption that a continuing SaaS is
downloadable digital content whose withdrawal right vanishes at first login. Any request to begin
service during the withdrawal period must use reviewed, separate wording/evidence. Legal review
decides classification, period calculation and lawful deductions. Never hand-code proration math.

Provide an online withdrawal function for applicable contracts: prominent accessible entry while
eligible, contract identification, review/confirmation step, immediate durable receipt with submission
time and content. Distinguish receipt of a request from approval/payment of a refund. Assess identity
without making password loss prevent timely submission. Provide support fallback for outages.
The 2026 EU requirement needs Romanian implementation review; do not equate the Stripe Portal
cancel-renewal button with statutory withdrawal.

If legal outcome/refund rules remain unresolved, implement secure request intake and operator
handling, report the launch blocker, and do not invent automated eligibility or refund amounts.
Any eventual refund/cancellation uses the existing Stripe gateway and canonical reconciliation;
never write `User.plan` directly or trust the browser return. Preserve idempotency, webhook safety,
the one-subscription rule, role independence and non-destructive downgrade behavior. Publish no
promised processing SLA or email receipt until its delivery mechanism exists and is tested.

## 7. Privacy rights and operational support

Publish a working, monitored contact for access, correction, erasure, portability and other applicable
rights. Explain applicable qualifications and retention. An authenticated request flow is useful;
a monitored contact route can be the initial fulfillment path if real operations exist. Do not label
a submitted deletion request as completed deletion. Avoid requesting identity documents by default.

Account deletion must consider active billing, sessions, queues/jobs, backups, linked provider data,
legal holds and statutory accounting records. Do not silently leave recurring charges behind or delete
mandatory records. Automated destructive deletion is not required by this documentation task; its
design needs an explicit reviewed retention and subscription handling policy.

Record supplier roles, agreements, regions and transfer safeguards from actual contracts. Stripe
and Google may have different roles for different processing; do not call every provider a processor.
Do not claim anonymous data, EU-only hosting, no sharing or fixed retention periods without evidence.

## 8. Release and maintenance

Implement safe mechanics even while owner facts are pending. Keep unresolved placeholders in draft
sources only, with explicit preview status. Add a narrowly scoped legal-readiness validation that fails
the intended public release when required operator/contact/policy facts are missing; do not break all
local development. No fake firm names, fake addresses, example mailboxes or unsupported legal claims
on a production legal page. Owner/counsel review is for factual/legal publication, not a reason to stop
reversible engineering work. Complete a traceable checklist and disclose remaining blockers.

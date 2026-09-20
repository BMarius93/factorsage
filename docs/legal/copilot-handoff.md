# Copilot implementation handoff

Work on the existing `docs/legal-compliance-v1` branch. Read `AGENTS.md`, `ai/README.md` and all
documents linked by `docs/legal/README.md` before implementation. Start by checking the working
tree and current branch; preserve unrelated work. Do not restart from main and lose this handoff.

Implement the legal UX and compliance mechanics specified in `implementation-spec.md`, using
`public-copy-drafts.md` as draft content and `acceptance-checklist.md` as evidence requirements.
The owner wants robust lawful limitation of investment/data liability, clear research positioning,
public legal pages, verified Terms acceptance and honest cookie/subscription/privacy flows.
Do not claim a disclaimer creates immunity or makes public financial recommendations unregulated.

Inspect the actual repository before editing. Read authentication and auth-testing documentation,
frontend/UI-system docs, billing ADR/architecture, observability and rate-limit rules as relevant.
Preserve email-first anti-enumeration registration and Google identity security. Acceptance belongs
to a verified account, not an anonymous email submission. Implement server enforcement and immutable
versioned evidence with a migration. Preserve cancellation and privacy access if Terms are declined.

Inventory real browser storage/network behavior before deciding whether a banner is necessary.
Known guest recent-securities localStorage must not be ignored. Do not add analytics or marketing.
Keep short financial disclosures accurate to latched ACTIVE signals, pending setups, market-data
timestamps and the actual backtest methodology. Do not change financial formulas or signal semantics.

For billing use existing Stripe gateway and reconciliation. Keep period-end renewal cancellation
distinct from statutory withdrawal and nonconformity remedies. Implement request intake/evidence
and durable acknowledgment where financial/legal rules remain unresolved; do not invent refund
amounts, waive rights automatically or write user plans directly. Read current official Stripe docs
for any SDK/configuration changes, using the available Stripe skills if present.

Complete all safe engineering without repeatedly asking permission. Owner facts and legal opinions
cannot be inferred: keep them explicit in `owner-inputs-and-review.md`, make draft pages reviewable
locally, and prevent placeholders/unapproved claims from reaching the intended public release.
Do not publish personal details, contracts, secrets or real customer data into this public repository.

Use meaningful tests for auth, consent and billing boundaries; inspect desktop/mobile in a browser.
Run the repository's required gates once after implementation settles and report exact failures or
unavailable prerequisites. Update canonical implementation docs only after the corresponding code
exists; do not turn proposed endpoints into supposedly current OpenAPI entries ahead of implementation.

Commit and push the completed implementation on this branch. Do not merge or deploy. Final report:
commit SHA, changed behavior, test/browser evidence, unresolved owner/counsel items and public-release
blockers. Do not label this work legally certified or production-ready while those blockers remain.

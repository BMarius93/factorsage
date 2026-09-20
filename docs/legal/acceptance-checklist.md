# Implementation acceptance checklist

Complete with evidence, commit and remaining limitations. All boxes below start unchecked because
this branch currently contains documentation only. Use existing persona registry and test fixtures.

## Documents and presentation

- [ ] Every proposed legal page is public, keyboard-accessible, readable/printable and versioned.
- [ ] Guest and expired-session access works; Terms/Privacy reachable from auth screens.
- [ ] One compact footer; desktop and 390px mobile screenshots show no overlap/horizontal overflow.
- [ ] Operator identity and contact facts are verified; no draft placeholders in release output.
- [ ] Policy text matches actual providers, storage, billing, methodology and rights-handling behavior.
- [ ] Dashboard, stock estimates and backtests show concise contextual disclosures with working links.
- [ ] Active versus pending and as-of timestamps are truthful; no domain/engine behavior changed.

## Authentication and acceptance

- [ ] Email activation requires unchecked-to-checked Terms acceptance and valid current version.
- [ ] Direct API omission/false/stale version cannot bypass acceptance; no activation committed on failure.
- [ ] Anonymous email submission cannot accept terms on behalf of the mailbox owner or mutate existing acceptance.
- [ ] Registration enumeration protection, token single-use and existing email responses remain intact.
- [ ] Google new-user flows from both buttons enforce onboarding at server boundaries.
- [ ] OAuth cookie/query tampering cannot manufacture acceptance; PKCE/state/nonce checks preserved.
- [ ] Existing accepted users sign in without recurring prompts; existing unaccepted users get one honest gate.
- [ ] Concurrent/repeated submissions create one event for the same document version.
- [ ] Exact historical Terms text remains retrievable; migration never forges prior acceptance.
- [ ] Declining Terms does not block cancellation, withdrawal, privacy requests, support or logout.
- [ ] QA persona changes are synthetic and centralized; no production bypass added.

## Cookies and storage

- [ ] Inventory verified in a browser before consent, after rejection, after granular consent and withdrawal.
- [ ] Optional scripts AND storage access absent before consent; no flash/loading race or route bypass.
- [ ] Guest recents follow chosen category and work without persistent storage when not permitted.
- [ ] Reject is as accessible as Accept; no optional purposes preselected.
- [ ] Settings persist the right version and handle expiry, cross-tab changes and storage errors safely.
- [ ] Withdrawal stops optional behavior and removes controlled optional keys without deleting auth state.
- [ ] Essential-only configuration shows no unnecessary consent banner.
- [ ] Hosted third-party behavior is described accurately; no unverified provider exemption claims.

## Subscription and rights flows

- [ ] Actual Checkout shows total/currency/taxes/interval/renewal and unambiguous payment obligation.
- [ ] Annual total visible; source-of-truth prices/limits reused; no trials or extra plans introduced.
- [ ] Durable contract confirmation references the exact purchased terms and handles delivery failure.
- [ ] Cancel renewal shows effective date and does not silently mean immediate statutory withdrawal.
- [ ] Applicable online withdrawal flow supports identification, review, confirmation and durable receipt.
- [ ] Repeat submissions/delivery retries are idempotent; no double refunds or duplicate money actions.
- [ ] No unsupported waiver or blanket No refunds; nonconformity complaints remain possible.
- [ ] Any Stripe changes preserve gateway/reconciliation ownership, signed webhooks and plan invariants.
- [ ] Privacy/erasure requests have a monitored fulfillment path, identity checks and retention exceptions.
- [ ] Failed login/declined terms does not prevent timely legal requests; support fallback exists.
- [ ] Owner-input register resolved or explicit launch blockers reported, not silently marked complete.

## Engineering validation

Read `ai/workflows/auth-testing.md`, `ai/workflows/validation.md` and relevant architecture docs.
Add meaningful boundary/integration tests for acceptance and consent, not tests that only mirror strings.
Run affected auth/registration/Google/billing tests and Playwright flows using repository personas.
Use the dedicated migrated test database, not development data. Check migration drift if schema changes.
Update contracts and OpenAPI alongside actual endpoints; document rate-limit and failure behavior.

Run the repository completion gate once after implementation settles: `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`, `pnpm openapi:validate`, plus affected E2E. Report exact unavailable
dependencies/configuration and failed commands; never claim unrun gates passed.

For the initial documentation-only commit: verify relative links, whitespace, changed-file scope and
base/parent ancestry. No application behavior or legal compliance can be validated by that docs check.

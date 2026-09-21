# Implementation acceptance checklist

Completed on `docs/legal-compliance-v1`, 2026-09-21, against the hermetic E2E stack
(`pnpm dev:fmp:e2e` / `dev:api:e2e` / `dev:worker:e2e` / `dev:web:e2e`) with a production
`next build`, in Chromium at 1440×900 and 390×844.

A ticked box means the behaviour was observed or asserted, and names where. It does **not** mean
the wording is approved: every document is `DRAFT`, every operator fact is a placeholder, and
section *Remaining limitations* below is the honest list of what that leaves outstanding.

## Documents and presentation

- [x] Every proposed legal page is public, keyboard-accessible, readable/printable and versioned.
      `/terms`, `/privacy`, `/cookies`, `/risk-disclosure`, `/cancellation-and-refunds`,
      `/contact`, each `200` for a Guest with its version and effective date on the page, real
      heading structure, and a print stylesheet that drops the chrome
      (`e2e/legal/legal-pages.guest.spec.ts`).
- [x] Guest and expired-session access works; Terms/Privacy reachable from auth screens.
      Verified with no cookie and with a malformed one; `AuthCard` renders the shared footer and
      `/register` links both documents (same spec).
- [x] One compact footer; desktop and 390px mobile screenshots show no overlap/horizontal
      overflow. `scrollWidth ≤ clientWidth` on every page at both widths; the consent banner is
      `sticky`, not `fixed`, after a real overlap defect was found and fixed — a fixed bar made
      the footer's own legal links unclickable.
- [ ] **Operator identity and contact facts are verified; no draft placeholders in release
      output.** Not done, and not doable here: `O1`, `O2`, `O3`, `O8`, `O9`, `O12` are unsupplied.
      What *is* done is the mechanism — each renders as a named draft marker, and a declared
      release build refuses to compile (verified: `FACTORSAGE_RELEASE_BUILD=true next build`
      fails, listing all 16 blockers).
- [ ] **Policy text matches actual providers, storage, billing, methodology and rights-handling
      behaviour.** Storage, billing mechanics, methodology and rights-handling: yes, and the
      cookie table is generated from the application's own inventory. **Providers are not named**
      at all, pending `O4`; retention is not stated, pending `O5`.
- [x] Dashboard, stock estimates and backtests show concise contextual disclosures with working
      links. From one copy source (`LEGAL_DISCLOSURES`), on the Dashboard signals, a Monitor's
      signals, the backtest outcome hero and the stock valuation card, each linking the Risk
      Disclosure (`e2e/legal/legal-disclosures.guest.spec.ts`).
- [x] Active versus pending and as-of timestamps are truthful; no domain/engine behaviour
      changed. The copy states that an active signal may be latched and that a pending setup is
      not a signal; no financial formula, signal semantic, plan limit or reconciliation path was
      touched.

## Authentication and acceptance

- [x] Email activation requires unchecked-to-checked Terms acceptance and valid current version.
      The box starts unchecked, the submit button is disabled until it is ticked, and a keyboard
      submit without it calls nothing (`VerifyEmailPanel.test.tsx`).
- [x] Direct API omission/false/stale version cannot bypass acceptance; no activation committed
      on failure. Missing, empty, non-string and superseded versions each answer `400` and leave
      the account pending with its link still redeemable
      (`legal-acceptance.integration.test.ts`, `email-verification.integration.test.ts`).
- [x] Anonymous email submission cannot accept terms on behalf of the mailbox owner or mutate
      existing acceptance. Registration writes no `LegalRecord`, and a `termsVersion` posted to
      `/auth/register` is ignored exactly like a `password` is.
- [x] Registration enumeration protection, token single-use and existing email responses remain
      intact. Status, body, headers and absence of `Set-Cookie` identical for a new, an existing
      and an unknown address; the AUTH-003 suite is unchanged and passing.
- [x] Google new-user flows from both buttons enforce onboarding at server boundaries. Both
      buttons are one `GoogleSignInButton` pointing at `GET /auth/google`, and the gate is on the
      account, not the entry point: a Google-created account with no acceptance is refused `403
      LEGAL_ACCEPTANCE_REQUIRED` on every gated route and routed to the acceptance screen.
- [x] OAuth cookie/query tampering cannot manufacture acceptance; PKCE/state/nonce checks
      preserved. Acceptance is a row keyed by the authenticated user id; nothing in the OAuth
      transaction, a query parameter or `localStorage` is read as proof. The Google flow was not
      modified.
- [x] Existing accepted users sign in without recurring prompts; existing unaccepted users get
      one honest gate. Verified in the browser both ways; the gate names the reason and offers
      alternatives.
- [x] Concurrent/repeated submissions create one event for the same document version. Three
      simultaneous `POST /legal/acceptance` calls produce one row per document and the first
      timestamp survives.
- [x] Exact historical Terms text remains retrievable; migration never forges prior acceptance.
      Each record stores the SHA-256 of the canonical text of that version, pinned by
      `legal-documents.test.ts`; the migration adds tables only and backfills nothing.
- [x] Declining Terms does not block cancellation, withdrawal, privacy requests, support or
      logout. Asserted route by route in the browser and endpoint by endpoint over HTTP, and the
      allowlist is pinned *exactly* in both directions by `legal-acceptance-coverage.test.ts` —
      an over-narrow allowlist fails the build just as an over-wide one does.
- [x] QA persona changes are synthetic and centralized; no production bypass added. `seedQaUsers`
      records acceptance with the `EXISTING_ACCOUNT` surface. There is no flag, header or route
      that skips the gate.

## Cookies and storage

- [x] Inventory verified in a browser before consent, after rejection, after granular consent and
      withdrawal. `docs/legal/storage-inventory.md` records the method and the observations.
- [x] Optional scripts AND storage access absent before consent; no flash/loading race or route
      bypass. `localStorage` is empty on a first visit and stays empty across a Stock Details
      view; the provider reports "undecided" until an effect has read the store, so the only
      possible race fails closed. No third-party origin was contacted at any point.
- [x] Guest recents follow chosen category and work without persistent storage when not
      permitted. Held in memory before a choice and after a refusal — the feature works, nothing
      reaches the device (`use-recent-securities.test.tsx`, `e2e/legal/storage-consent.guest.spec.ts`).
- [x] Reject is as accessible as Accept; no optional purposes preselected. Two buttons, the same
      size and treatment, Reject first; nothing is preselected and there is no "Customize" step
      hiding the refusal.
- [x] Settings persist the right version and handle expiry, cross-tab changes and storage errors
      safely. A record for another `STORAGE_CONSENT_VERSION` is not honoured; a throwing
      `localStorage` resolves to undecided; the `storage` event propagates a withdrawal across
      tabs (`storage-consent.test.ts`).
- [x] Withdrawal stops optional behaviour and removes controlled optional keys without deleting
      auth state. The recents key is removed, the consent record and the session cookie are not.
- [x] Essential-only configuration shows no unnecessary consent banner. `OPTIONAL_STORAGE_EXISTS`
      is derived from the inventory; with no optional entry the banner and the footer link do not
      render.
- [x] Hosted third-party behaviour is described accurately; no unverified provider exemption
      claims. Google and Stripe are listed as out of scope with the boundary stated, and nothing
      claims the local control governs them.

## Subscription and rights flows

- [ ] **Actual Checkout shows total/currency/taxes/interval/renewal and unambiguous payment
      obligation.** Not verified in this pass: it is Stripe's hosted page, and its tax
      configuration is `O8`. The product's own pre-purchase surfaces were verified.
- [x] Annual total visible; source-of-truth prices/limits reused; no trials or extra plans
      introduced. Amounts still come from `BILLING_CATALOG` through `plan-presentation.ts`; the
      disclosure states that an annual plan is charged as the annual amount, not twelve monthly
      ones, and restates no figure of its own.
- [ ] **Durable contract confirmation references the exact purchased terms and handles delivery
      failure.** Not implemented: there is no approved sender or monitored mailbox (`O2`), and a
      confirmation email that cannot be delivered is worse than none. The accepted Terms version
      and its digest *are* recorded per account and readable at `GET /legal/acceptance`.
- [x] Cancel renewal shows effective date and does not silently mean immediate statutory
      withdrawal. Billing shows the date; the cancellation page says in terms that cancelling a
      renewal is not a withdrawal and links to Billing rather than duplicating the control.
- [x] Applicable online withdrawal flow supports identification, review, confirmation and durable
      receipt. Identification from the session plus the live subscription summary; a review step;
      a confirmation; an immediate receipt with a reference, the server submission time and the
      submitted text, savable as a file and retrievable later.
- [x] Repeat submissions/delivery retries are idempotent; no double refunds or duplicate money
      actions. Nothing here moves money, so there is nothing to double. Each submission is its own
      record with its own reference, deliberately not merged.
- [x] No unsupported waiver or blanket No refunds; nonconformity complaints remain possible. A
      contracts test fails the build on those phrasings, and the nonconformity channel is its own
      form on the same page.
- [x] Any Stripe changes preserve gateway/reconciliation ownership, signed webhooks and plan
      invariants. No Stripe code was changed. Three billing routes are exempt from the acceptance
      gate — status, refresh and the portal — and checkout and plan change deliberately are not.
- [x] Privacy/erasure requests have a monitored fulfilment path, identity checks and retention
      exceptions. **Qualified:** the intake, identity binding and retention-exception wording
      exist; "monitored" does not, pending `O2`. The product says so rather than implying a
      response.
- [x] Failed login/declined terms does not prevent timely legal requests; support fallback
      exists. Declining leaves every channel open; a visitor who cannot sign in is pointed at the
      support address and told their request counts from when they sent it.
- [x] Owner-input register resolved or explicit launch blockers reported, not silently marked
      complete. See below and `owner-inputs-and-review.md`.

## Engineering validation

Gates run once after the implementation settled: `pnpm lint`, `pnpm typecheck`, `pnpm test`,
`pnpm build`, `pnpm openapi:validate`, plus the full Playwright suite. Results and any known-noise
failures are in the implementation report on the pull request, not asserted here.

New coverage:

| Suite | Subject |
| --- | --- |
| `packages/contracts/src/legal-documents.test.ts` | Digests, required version, acceptance bundle, no invented facts, no unlawful claim, readiness |
| `apps/api/src/legal/legal-acceptance.integration.test.ts` | Acceptance identity, the bypass, the escape hatches, idempotency, surfaces |
| `apps/api/src/legal/legal-acceptance-coverage.test.ts` | The exemption allowlist, exactly |
| `apps/web/src/features/legal/consent/storage-consent.test.ts` | Undecided, blocked storage, versioning, cross-tab |
| `apps/web/src/features/legal/owner-facts.test.ts` | No fact supplied; each reads the declared variable |
| `apps/web/src/features/legal/components/LegalAcceptanceGate.test.tsx` | The reachable-while-outstanding list |
| `apps/web/e2e/legal/` | Pages, consent journey, disclosures, request channels |

Schema: one migration, `20260921120000_add_legal_acceptance_and_requests`, adding
`LegalRecord`, `LegalRequest` and five enums. Additive only — no column changed, nothing
backfilled. Applied to the test and development databases; `pnpm db:status` reports no drift.

## Remaining limitations

Everything below is a **public-release blocker**, not a defect in the implementation.

1. **No operator fact is supplied** (`O1`, `O2`, `O3`, `O8`, `O9`, `O12`). Ten
   `NEXT_PUBLIC_LEGAL_*` variables are empty; a release build fails and lists them.
2. **No document is approved.** All six are `DRAFT`. Approving one means changing its status *and*
   its version, which changes its digest — the flag alone cannot satisfy the gate.
3. **No legal question has been answered**, and none was guessed: withdrawal applicability and
   period (`O7`), liability and governing law (`O9`), financial-regulatory classification of the
   built-in strategies and public BUY/SELL outputs (`O10`), data-licence display rights (`O11`),
   accessibility and ADR requirements (`O12`).
4. **No provider is named and no retention period is stated** (`O4`, `O5`).
5. **No mailbox is monitored** (`O2`), so no email is sent and no response time is promised.
6. **The storage inventory is verified against this build only**, not against a production
   deployment (`O6`).
7. **Hosted Stripe Checkout's own disclosure was not inspected** in this pass, and its tax
   configuration is unresolved (`O8`).
8. **A live Google consent-screen round trip was not performed**: it needs a real Google account
   and a human. The post-callback state was reproduced exactly and verified end to end.

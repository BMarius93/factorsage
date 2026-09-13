# Stripe Billing V1

Status: accepted product and integration decision for V1 implementation

This document is the source of truth for FactorSage Stripe Billing V1. It complements `docs/decisions/entitlements-v1.md`.

The fundamental boundary is:

```text
Stripe owns billing state and money movement.
FactorSage owns product entitlements.
```

Stripe may cause the persisted commercial plan of an authenticated FactorSage user to change, but Stripe must never contain or duplicate the application's entitlement matrix. The existing entitlement resolver remains the only authority for what `FREE`, `STARTER`, and `PRO` can do.

Official Stripe references relevant to this decision:

- Checkout subscriptions: https://docs.stripe.com/payments/checkout/build-subscriptions?payment-ui=stripe-hosted
- Customer Portal: https://docs.stripe.com/customer-management
- Customer Portal configuration: https://docs.stripe.com/customer-management/configure-portal
- Customer Portal API integration: https://docs.stripe.com/customer-management/integrate-customer-portal
- Scheduled Portal downgrades: https://docs.stripe.com/changelog/acacia/2024-10-28/customer-portal-schedule-downgrades
- Subscription prorations: https://docs.stripe.com/billing/subscriptions/prorations
- Changing subscription prices: https://docs.stripe.com/billing/subscriptions/change-price
- Subscription webhooks: https://docs.stripe.com/billing/subscriptions/webhooks
- Webhook handling: https://docs.stripe.com/webhooks
- Billing testing: https://docs.stripe.com/billing/testing

## 1. V1 commercial catalog

FactorSage V1 has exactly three authenticated commercial plans:

- `FREE`
- `STARTER`
- `PRO`

`GUEST` remains a derived unauthenticated access state and has no Stripe object.

`ADMIN` remains an internal authorization role, not a Stripe product or billing tier.

### Paid prices

V1 paid prices are USD flat-rate licensed subscriptions with quantity `1`:

| Logical price key | Plan | Interval | Amount |
| --- | --- | --- | ---: |
| `STARTER_MONTHLY` | STARTER | month | $9 |
| `STARTER_YEARLY` | STARTER | year | $99 |
| `PRO_MONTHLY` | PRO | month | $29 |
| `PRO_YEARLY` | PRO | year | $299 |

There is no Stripe Price for `FREE`.

There is no `PRO_PLUS` in V1.

There are no credits, top-ups, metered charges, usage-based prices, seat quantities, one-time purchases, or launch trials in V1.

Legacy `Credit Top-Ups` products/prices must not be used by application code. Archived legacy prices must never be accepted as valid purchase targets.

### Stripe products

The intended catalog contains two active subscription products:

```text
Starter
  $9 / month
  $99 / year

Pro
  $29 / month
  $299 / year
```

Sandbox and live mode are separate Stripe environments and must be configured independently with equivalent logical prices.

The application must never infer a plan from:

- product display name;
- amount alone;
- currency plus amount;
- Stripe Dashboard ordering.

The application uses an explicit server-side allowlist of logical price keys to environment-specific Stripe Price IDs.

Optional Stripe `lookup_key` values may be used operationally, but runtime authorization must still resolve through the application's explicit catalog mapping.

Suggested lookup keys:

```text
factorsage_starter_monthly
factorsage_starter_yearly
factorsage_pro_monthly
factorsage_pro_yearly
```

## 2. Environment separation

Stripe sandbox/test mode and live mode are hard-separated environments.

At minimum server configuration needs environment-appropriate values equivalent to:

```text
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PRICE_STARTER_MONTHLY
STRIPE_PRICE_STARTER_YEARLY
STRIPE_PRICE_PRO_MONTHLY
STRIPE_PRICE_PRO_YEARLY
```

Public UI code must not need the Stripe secret key.

No Stripe secret, webhook secret, payment method data, or other credential is committed to the repository.

Production must never boot with sandbox price IDs or sandbox secret material, and local/test environments must never accidentally charge live prices.

The implementation should provide startup/config validation for required billing configuration when billing is enabled.

A catalog verification helper/script is strongly preferred. It should be able to verify, against the selected Stripe environment, that configured prices are:

- active;
- recurring;
- USD;
- quantity-based/licensed rather than metered;
- attached to the expected Starter/Pro product;
- monthly or yearly as configured;
- exactly $9 / $99 / $29 / $299.

A mismatch must fail loudly rather than silently mapping the wrong price to a plan.

## 3. Core billing model

FactorSage persists product access as `User.plan`, already defined by Entitlements V1.

Stripe billing state must be modeled separately from the entitlement matrix.

Recommended conceptual persistence:

```text
User
  plan                       FREE | STARTER | PRO
  stripeCustomerId?          unique

BillingSubscription          zero-or-one per User
  userId                     unique
  stripeSubscriptionId       unique
  stripePriceId
  plan                       STARTER | PRO
  billingInterval            MONTH | YEAR
  status                     mirrored Stripe subscription status
  currentPeriodStart?
  currentPeriodEnd?
  cancelAtPeriodEnd
  cancelAt?
  canceledAt?
  pendingPlan?
  pendingPriceId?
  pendingEffectiveAt?
  latestInvoiceId?
  lastStripeEventCreatedAt?
  syncedAt

StripeWebhookEvent
  stripeEventId              unique
  type
  stripeCreatedAt
  processedAt
```

The exact schema may follow repository conventions, but the implementation must preserve the conceptual separation between:

1. product access (`User.plan`);
2. mirrored billing lifecycle state;
3. webhook idempotency/reconciliation state.

Do not overload `User.plan` with Stripe status such as `past_due` or `cancel_at_period_end`.

Do not store an `ADMIN` billing plan.

## 4. Identity and customer ownership

A Stripe Customer belongs to exactly one authenticated FactorSage User.

Rules:

- Guest users cannot initiate Checkout or Customer Portal sessions.
- `stripeCustomerId` is server-managed and never accepted from a client as authority.
- Email is not an identity key between Stripe and FactorSage.
- Customer metadata may include the FactorSage `userId` for support/reconciliation, but metadata is not trusted as the sole authorization mechanism.
- A User should have at most one canonical Stripe Customer.
- A User should have at most one active/scheduled paid subscription in V1.

Creating/reusing the Stripe Customer must be concurrency-safe and idempotent. Two simultaneous Checkout requests must not create two canonical customers or two paid subscriptions.

## 5. Checkout: FREE -> paid

Stripe-hosted Checkout is the V1 purchase surface for a user who does not already have a paid subscription.

The client submits a logical target such as:

```text
STARTER_MONTHLY
STARTER_YEARLY
PRO_MONTHLY
PRO_YEARLY
```

The client must not submit an arbitrary Stripe Price ID that is then trusted by the server.

The server:

1. requires an authenticated non-Guest user;
2. validates the logical target against the four-item catalog allowlist;
3. verifies the user does not already have a canonical paid subscription;
4. creates or reuses the canonical Stripe Customer;
5. creates a Stripe Checkout Session in subscription mode;
6. uses quantity `1`;
7. uses server-configured success/cancel URLs;
8. associates the session with the authenticated FactorSage user using server-controlled metadata/reference fields;
9. redirects the browser to Stripe-hosted Checkout.

No product entitlement is granted merely because a Checkout Session was created or because the browser returned to a success URL.

The browser redirect is UX only.

Paid access changes only after authoritative server-side billing reconciliation confirms that the paid subscription is effective under the rules in this document.

If an existing paid subscription is already present, the application must not create a second subscription through Checkout. The user should be directed to subscription management instead.

## 6. Subscription-management surface

V1 should minimize custom payment UI.

Stripe Customer Portal is the preferred surface for:

- payment method management;
- invoice/receipt history;
- cancellation;
- resuming a scheduled cancellation when supported;
- subscription management when Portal configuration can express the FactorSage transition policy exactly.

The application creates Customer Portal sessions server-side for the authenticated user's canonical Stripe Customer.

Portal return URLs are server-configured; do not accept an arbitrary client-provided redirect URL.

### Plan/interval changes

The product transition semantics in Sections 7-9 are mandatory regardless of UI surface.

Prefer Customer Portal configuration and Portal deep links if Stripe can express these semantics exactly.

If the configured Customer Portal cannot express the required asymmetric immediate-vs-scheduled transition policy for all four prices, implement a small FactorSage-owned subscription-change endpoint using Stripe's subscription APIs while retaining Customer Portal for payment methods, invoices, and cancellation.

Do not change the product semantics merely to fit a simpler UI.

## 7. Transition classification

Plan rank for transition purposes:

```text
FREE < STARTER < PRO
```

For an existing paid subscription, classify target changes as follows.

### Higher entitlement plan

Examples:

- Starter monthly -> Pro monthly
- Starter monthly -> Pro yearly
- Starter yearly -> Pro monthly
- Starter yearly -> Pro yearly

Policy: **immediate upgrade**.

Stripe owns the monetary proration calculation. FactorSage never computes prorated cents itself.

The higher entitlement is granted only after the immediate change is successfully billable under Section 10.

### Lower entitlement plan

Examples:

- Pro monthly -> Starter monthly
- Pro monthly -> Starter yearly
- Pro yearly -> Starter monthly
- Pro yearly -> Starter yearly

Policy: **scheduled at the end of the current paid period**.

The user keeps the higher current entitlement until the current paid period ends.

Do not refund the unused higher-tier period merely because the user requested a downgrade.

When the scheduled change actually becomes effective in Stripe, FactorSage changes `User.plan` to the lower tier and the existing Entitlements V1 downgrade behavior applies.

### Same plan: monthly -> yearly

Examples:

- Starter monthly -> Starter yearly
- Pro monthly -> Pro yearly

Policy: **immediate billing-cadence change**.

The entitlement plan itself does not change.

Stripe owns proration/billing-anchor behavior and charges/credits according to its subscription rules.

### Same plan: yearly -> monthly

Examples:

- Starter yearly -> Starter monthly
- Pro yearly -> Pro monthly

Policy: **scheduled at the end of the current annual period**.

The entitlement plan itself does not change.

### Paid -> FREE

There is no Stripe `FREE` price.

Moving to Free is represented by subscription cancellation at period end, not a price switch.

## 8. Upgrade proration and charging

For transitions that are immediate, use Stripe's native subscription proration behavior.

FactorSage must not manually calculate unused time, credits, differences between monthly amounts, annual amounts, or billing-cycle fractions.

The desired V1 behavior for an immediate paid transition is:

1. Stripe calculates the unused-time credit and new-price charge;
2. the change is billed immediately when money is due;
3. if the resulting invoice is successfully paid (or is a zero-amount invoice considered paid by Stripe), the higher entitlement may become effective;
4. if required payment fails, the user must not receive the higher paid entitlement merely because the requested price appeared in an intermediate Stripe object.

If implementing subscription changes through the Stripe API rather than Portal, choose Stripe update/payment behavior that preserves this rule and avoids applying a higher entitlement before payment confirmation.

The implementation should prefer Stripe's current recommended subscription billing mode for new integrations when compatible with the repository's pinned Stripe API version. Do not reimplement proration arithmetic.

## 9. Scheduled downgrade/cadence changes

A downgrade or yearly-to-monthly same-plan change must be represented in Stripe as a future change effective at the current period end using the Stripe-supported scheduling mechanism appropriate to the chosen management surface.

Until the effective timestamp:

- the current Stripe price remains the current billable entitlement where Stripe models it that way;
- `User.plan` remains the current higher plan for entitlement downgrades;
- the UI may show the pending target and effective date;
- cancellation/downgrade state must not be confused with an already-effective plan change.

At the effective timestamp, Stripe's webhook/reconciliation path applies the new state.

Pending change metadata may be mirrored locally for UX, but Stripe remains the billing source of truth.

## 10. Access-state policy by billing outcome

The following policy defines when Stripe billing state may affect `User.plan`.

### New purchase from FREE

- Checkout/session creation: remain `FREE`.
- Subscription `incomplete`: remain `FREE`.
- Payment succeeds and subscription is effective: become target paid plan.
- Payment never completes / `incomplete_expired`: remain `FREE`.

### Immediate upgrade from an existing paid plan

- Upgrade requested: remain on the previous plan until successful billing confirmation.
- Upgrade invoice/payment succeeds or is a valid zero-amount paid invoice: move to target higher plan.
- Upgrade payment fails: remain on the previous paid plan while Stripe recovers/rolls back/pends the requested change according to the chosen Stripe update flow.

The application must not grant the target higher plan solely from an unverified `customer.subscription.updated` payload if the corresponding immediate charge is still unpaid.

### Scheduled downgrade

Before the effective date: retain the higher existing plan.

When Stripe makes the lower plan current at the period boundary: switch to the lower plan even if the new renewal invoice enters payment recovery. The user's previous higher paid period has ended and must not be extended merely because the lower-tier renewal payment is late.

### Renewal payment failure

For a currently active paid plan whose renewal payment becomes `past_due`, FactorSage keeps the current plan during Stripe's configured recovery/retry window.

This avoids immediately destroying access for a temporary card failure.

If Stripe reaches a terminal non-paying state such as `unpaid` or the subscription is canceled, FactorSage becomes `FREE`.

Stripe Dashboard should use Smart Retries and standard customer payment-failure emails for V1. FactorSage does not implement a separate custom dunning engine in V1.

### Cancellation

`cancel_at_period_end = true` does not change the current entitlement.

The user keeps their current plan until the paid period actually ends.

When the subscription actually cancels at period end, `User.plan` becomes `FREE`.

If a scheduled cancellation is reversed before period end, no entitlement transition occurs.

An immediate administrative cancellation in Stripe becomes `FREE` when reconciled.

No automatic refund is issued by FactorSage when a user schedules cancellation.

### Unexpected statuses

V1 does not offer trials or pause functionality.

Unexpected Stripe statuses or unsupported billing configurations must not silently grant a paid plan. Log/observe the condition and reconcile conservatively.

The implementation must explicitly handle all Stripe subscription statuses exposed by the pinned Stripe SDK/API version rather than using a permissive default branch.

## 11. Stripe as billing source, FactorSage as entitlement source

The persisted `User.plan` is the hot-path input to the existing entitlement resolver.

Only the billing synchronization service (plus explicit existing internal QA/admin tooling) may write paid commercial plan changes.

No public endpoint may accept:

```text
plan=PRO
role=ADMIN
stripePriceId=<arbitrary>
```

and directly persist them.

Stripe must not be called on every entitlement check.

Normal product authorization remains:

```text
request
  -> authenticated user
  -> persisted User.plan + User.role
  -> existing entitlement resolver
  -> semantic entitlement guards
```

Billing asynchronously keeps `User.plan` correct.

## 12. Webhook authority

Stripe webhook processing is the authoritative asynchronous synchronization path.

The success/cancel browser redirects from Checkout or Customer Portal are not authoritative billing state transitions.

At minimum the implementation must consider and correctly reconcile the lifecycle represented by:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

Additional Stripe events required by the pinned API/version or chosen pending-update/scheduling mechanism should be added during implementation discovery.

Do not implement each event as an unrelated `User.plan = ...` assignment.

Events should feed one canonical reconciliation path that answers:

```text
Given the current Stripe customer/subscription/invoice state,
what billing mirror state and effective FactorSage plan should exist now?
```

For lifecycle events, prefer reconciling against the latest canonical Stripe resource state instead of trusting event arrival order.

## 13. Webhook correctness requirements

Stripe webhooks are external, retryable messages and must be handled accordingly.

### Signature verification

The webhook route is unauthenticated by FactorSage session cookies but must verify the Stripe signature using the environment-specific webhook secret and the raw request body as required by Stripe.

Invalid signatures are rejected.

### Idempotency

A Stripe event ID is processed at most once for side effects.

Persist a durable unique event marker such as `StripeWebhookEvent.stripeEventId`.

A duplicate delivery returns success after confirming the event was already durably processed.

### Event ordering

Do not assume Stripe events arrive in business order.

The reconciliation function must remain correct if, for example, invoice and subscription events are delivered in a different order or one is retried later.

Where possible, fetch/reconcile the current Stripe subscription state and compare it with durable local state rather than applying event payloads as an ordered event log.

### Atomicity

Changes to billing mirror state and `User.plan` caused by one reconciliation must be transactionally consistent.

Do not commit `User.plan = PRO` while failing to persist the subscription state that justified it.

### Failure/retry

Transient processing failures must produce a non-success webhook response so Stripe can retry.

Permanent unsupported/invariant conditions should be observable and should not silently grant access.

### Concurrency

Concurrent webhook deliveries for the same user/customer/subscription must serialize at a suitable canonical lock/transaction boundary.

The repository already has a pattern of per-user advisory locking for entitlement-sensitive state; implementation should reuse repository conventions where appropriate rather than inventing an incompatible lock hierarchy.

## 14. Stripe API write idempotency

Server-initiated Stripe writes that could be retried must use Stripe idempotency keys where appropriate, including operations such as:

- canonical Customer creation;
- Checkout Session creation when the same request may be retried;
- subscription change requests;
- Customer Portal session creation when useful/appropriate.

An application retry must not accidentally create a second paid subscription.

Idempotency-key design should include a stable FactorSage user/action identity and a request/change identity rather than using a constant key forever.

## 15. One-subscription invariant

V1 supports at most one canonical paid subscription per user.

The application must prevent creating a second subscription through its own flows.

If reconciliation discovers multiple simultaneously active/paying subscriptions for one user, this is a billing invariant violation.

Do not silently merge, choose a random subscription, or automatically issue refunds/cancellations without explicit product logic.

The system should:

- preserve a deterministic existing canonical subscription when safe;
- surface/log the conflict loudly;
- avoid granting more than the maximum valid paid entitlement;
- provide a repair/reconciliation path for an operator.

## 16. Reconciliation and repair

Webhook delivery is the normal sync mechanism, but V1 must have a deterministic repair seam.

Provide an internal service/CLI/script capable of reconciling one user/customer/subscription from current Stripe state without fabricating a webhook.

Recommended use cases:

- local/sandbox debugging;
- repairing a missed webhook after an outage;
- validating a user reported as having the wrong plan;
- migration/recovery;
- production support.

The reconciliation path must call the same canonical state transition logic used by webhooks.

Do not create a second implementation of billing rules only for repair tooling.

A scheduled global reconciliation job is optional for V1; a tested deterministic per-user repair path is required.

## 17. Minimal billing API surface

The exact route naming should follow repository conventions, but V1 needs conceptual endpoints equivalent to:

```text
GET  /billing/status
POST /billing/checkout
POST /billing/portal
POST /billing/change       # only if Portal cannot express transition policy
POST /webhooks/stripe      # public route, Stripe-signature authenticated
```

### `GET /billing/status`

Authenticated user only.

Returns UI-safe state such as:

- current plan;
- role-independent billing state;
- billing interval if paid;
- current period end;
- cancel-at-period-end;
- pending plan/price/interval change and effective timestamp when known;
- whether management is available.

Never return Stripe secrets.

### `POST /billing/checkout`

Authenticated user only.

Accepts a logical catalog target, not arbitrary Price ID.

Only for users without a canonical paid subscription.

Returns a Stripe-hosted Checkout URL/session reference suitable for redirect.

### `POST /billing/portal`

Authenticated paid/current Stripe Customer user only.

Creates a short-lived Customer Portal session.

### `POST /billing/change`

Implement only if required to enforce the transition matrix more precisely than Portal configuration can.

Accepts a logical target from the four-price allowlist.

The server classifies the transition as immediate or scheduled according to this document.

### `POST /webhooks/stripe`

No normal session auth.

Requires valid Stripe webhook signature.

Uses the canonical idempotent reconciliation path.

## 18. Customer Portal configuration requirements

Before production launch, the relevant Stripe Customer Portal configuration should expose only supported V1 behavior.

Desired capabilities:

- update payment method;
- view invoices/payment history;
- cancel subscription at period end;
- reverse scheduled cancellation if supported;
- switch among the four approved recurring prices only if Portal behavior matches Sections 7-10.

Do not expose archived legacy Credit Top-Up prices.

Do not expose archived $39/$399 Pro legacy prices.

Do not expose unrelated Stripe catalog products.

Do not enable trial creation.

Promotion codes/coupons are out of scope for V1 unless a later decision explicitly enables them.

## 19. Billing UI behavior

This implementation does not require a broad product UI redesign.

Minimal UX should support:

- Free user can choose Starter/Pro and monthly/yearly and enter Checkout;
- paid user can see current plan and billing interval;
- user can see current period/renewal date when available;
- user can see `Cancels on <date>` when cancellation is scheduled;
- user can see a scheduled downgrade/cadence change and its effective date when available;
- paid user can open billing management;
- failures show actionable billing messages rather than generic entitlement errors.

Do not optimistically show a higher plan as active before server-side billing reconciliation grants it.

After returning from Stripe, the UI should refresh/poll the application's billing status for a bounded period if necessary rather than mutating the plan from URL parameters.

## 20. Error semantics

Billing failures are distinct from entitlement failures.

Use machine-readable billing reason codes following repository conventions. Conceptual examples:

```text
BILLING_AUTH_REQUIRED
BILLING_INVALID_PRICE_KEY
BILLING_ALREADY_SUBSCRIBED
BILLING_CUSTOMER_CONFLICT
BILLING_SUBSCRIPTION_CONFLICT
BILLING_CHECKOUT_FAILED
BILLING_PORTAL_UNAVAILABLE
BILLING_CHANGE_NOT_ALLOWED
BILLING_PAYMENT_REQUIRED
BILLING_STRIPE_UNAVAILABLE
BILLING_WEBHOOK_INVALID_SIGNATURE
BILLING_WEBHOOK_UNSUPPORTED_STATE
BILLING_CATALOG_MISCONFIGURED
```

Presentation strings are not business logic.

Do not map Stripe's raw error objects directly into unfiltered client responses.

## 21. Security boundaries

Mandatory rules:

- Stripe secret key is server-only.
- Webhook secret is server-only.
- Webhook signature is verified against raw body.
- Client cannot choose arbitrary Stripe customer/subscription/price IDs as authority.
- Client cannot set `User.plan` or `User.role`.
- Redirect/return URLs come from trusted application config or a strict allowlist.
- Do not log card/payment credentials or full sensitive Stripe payloads unnecessarily.
- Use the official Stripe SDK rather than hand-rolled payment HTTP calls unless repository constraints require otherwise.
- Pin/use an explicit compatible Stripe API version according to existing dependency conventions.
- Stripe API/network failures must not accidentally grant paid access.

## 22. Tax and compliance boundary

Tax obligations, registrations, VAT/GST/sales-tax collection, and business verification are operational/legal concerns separate from the entitlement state machine.

Do not invent tax rules in application code.

The billing integration must be compatible with enabling Stripe Tax/automatic tax through explicit configuration later or before production launch without changing entitlement semantics.

Before enabling automatic tax in live mode, the operator must complete the necessary Stripe Tax/business configuration and registrations applicable to the business.

Product tax category configuration in Stripe is operational metadata and does not determine FactorSage plan entitlement.

## 23. Refunds, disputes, and manual Stripe actions

V1 subscription entitlement is driven by current canonical subscription lifecycle, not by individual charge history alone.

A manual refund does not automatically downgrade a user unless the subscription lifecycle is also changed according to an explicit support decision.

Dispute/chargeback-specific automatic entitlement revocation is out of scope for V1 unless later defined.

Manual Dashboard changes to subscriptions must still converge through webhooks/reconciliation.

Manual Dashboard edits that create unsupported catalog/subscription states should be surfaced as billing invariant violations rather than silently interpreted.

## 24. Revenue recovery

V1 relies on Stripe Billing's standard recovery configuration rather than implementing a FactorSage dunning engine.

Recommended operational configuration:

- Smart Retries enabled;
- Stripe failed-payment customer emails enabled;
- automatic card updates where Stripe supports them;
- terminal recovery policy configured intentionally in Stripe Dashboard.

During `past_due`, keep the currently earned paid entitlement as defined in Section 10.

When Stripe reaches the configured terminal non-paying/canceled state, reconcile to `FREE`.

## 25. Observability

Billing needs enough structured observability to investigate money/access mismatches.

Log/measure at least:

- Checkout session creation success/failure by logical target;
- Portal session creation success/failure;
- webhook event type + Stripe event ID + processing result;
- duplicate webhook detection;
- reconciliation old plan -> new plan;
- scheduled pending change detected/applied;
- payment failure/recovery state changes;
- subscription/customer invariant conflicts;
- Stripe API latency/failure category;
- catalog verification failures.

Do not include secrets or unnecessarily sensitive payloads in logs.

A support investigation should be able to answer:

```text
Which FactorSage user?
Which Stripe customer?
Which canonical subscription?
Which current price?
Which billing status?
Which effective plan?
Which event/reconciliation last changed it?
```

## 26. Testing strategy

Do not make normal CI depend on the public Stripe network.

Use layers.

### Pure/unit tests

Test without Stripe network access:

- four-price catalog mapping;
- price -> plan/interval mapping;
- transition classifier;
- higher/lower plan ranking;
- monthly -> yearly immediate rule;
- yearly -> monthly scheduled rule;
- cancellation semantics;
- billing-status -> entitlement-plan reconciliation decisions;
- unsupported/unknown status fail-safe behavior.

Expected transition cases must be literals in tests rather than imported from the implementation matrix where practical.

### API/service integration tests

Use a fake/mock Stripe gateway at the Stripe service boundary to prove:

- Guest cannot start Checkout/Portal;
- raw client price IDs are rejected;
- Free can create one valid Checkout flow;
- duplicate/concurrent Checkout attempts do not create duplicate subscriptions;
- already-paid users cannot accidentally create a second Checkout subscription;
- server-generated return URLs are used;
- portal session is tied to canonical customer;
- exact plan writes happen only through canonical billing reconciliation.

### Webhook tests

Use Stripe-compatible signed webhook fixtures/test helpers where possible.

Cover:

- invalid signature rejected;
- valid event processed;
- duplicate event delivery is idempotent;
- same customer events arriving concurrently serialize safely;
- event order variations converge to the same canonical state;
- processing failure is retryable;
- plan + billing mirror update atomically;
- unsupported price/status does not grant access.

### Lifecycle acceptance tests

At minimum prove:

1. FREE -> STARTER monthly after successful Checkout/payment.
2. FREE -> PRO yearly after successful Checkout/payment.
3. failed initial payment remains FREE.
4. Starter -> Pro immediate upgrade after successful proration payment.
5. failed Starter -> Pro upgrade does not grant Pro.
6. Starter monthly -> Starter yearly is immediate billing-cadence change.
7. Starter yearly -> Starter monthly schedules for period end.
8. Pro -> Starter schedules for period end while Pro entitlement remains active.
9. scheduled Pro -> Starter becomes Starter when effective.
10. cancel-at-period-end keeps current plan until end.
11. actual cancellation becomes FREE.
12. cancellation reversal before period end preserves current plan.
13. renewal `past_due` retains current paid plan during recovery.
14. terminal `unpaid`/canceled state becomes FREE.
15. scheduled downgrade renewal failure never resurrects/extends the old higher plan.
16. archived/unknown Price ID fails closed.
17. duplicate webhook does not duplicate state changes.
18. out-of-order webhook delivery converges correctly.
19. ADMIN role remains independent of Stripe subscription state.
20. existing Entitlements V1 downgrade resource semantics activate correctly after billing changes `User.plan`.

### Sandbox contract/smoke tests

Provide a manually/CI-optional Stripe sandbox smoke path, gated by sandbox secrets, for validating the real Stripe contract without making every unit test depend on Stripe.

Use Stripe test-mode payment methods and Stripe-supported billing testing/test-clock facilities where appropriate.

Smoke scenarios should include at least:

- hosted Checkout creation and completion;
- webhook delivery/signature handling;
- Customer Portal session creation;
- immediate upgrade/proration;
- scheduled downgrade;
- cancellation at period end;
- failed payment/recovery simulation if practical.

Never run these against live mode from automated CI.

## 27. Playwright scope

Playwright should verify FactorSage UX around billing without depending on Stripe-hosted pages for the entire normal suite.

Recommended approach:

- mock/fake billing gateway for deterministic local Playwright paths;
- assert correct redirect initiation and local post-return behavior;
- inject/replay signed webhook fixtures for plan transition UI cases;
- retain a separate manual/optional sandbox end-to-end smoke for real hosted Stripe pages.

Do not duplicate every Stripe SDK behavior in browser tests.

Do not put live Stripe credentials into Playwright configuration.

## 28. Interaction with Entitlements V1

Billing implementation must integrate with, not rewrite, Entitlements V1.

When billing changes `User.plan`:

- oversized Lists remain stored/readable;
- corrective reductions remain allowed;
- completed historical Backtests remain readable;
- invalid reruns remain blocked;
- Monitor persisted `enabled` intent remains stored;
- Monitor execution eligibility is recalculated;
- active Monitor overage remains deterministic;
- no destructive downgrade migration runs.

Stripe code does not directly decide List/Backtest/Monitor limits.

It only changes the internal commercial plan at the correct effective time.

## 29. Interaction with ADMIN

`ADMIN` remains a persisted internal role independent of billing.

Stripe subscription state must never add or remove ADMIN.

An ADMIN may have `plan=FREE` while receiving explicit `ADMIN_ENTITLEMENTS` through the existing entitlement resolver.

Billing UI for ADMIN may be hidden or treated normally depending on existing UX, but billing synchronization must not overwrite the role.

QA personas must continue to work without requiring real Stripe purchases.

## 30. Implementation boundaries

The implementation should provide a narrow Stripe adapter/gateway rather than importing the Stripe SDK across feature modules.

Conceptually:

```text
BillingController / WebhookController
        |
        v
BillingService / ReconciliationService
        |
        +--> StripeGateway
        |
        +--> Prisma / domain transaction
        |
        +--> existing User-plan write seam
```

This enables deterministic tests and prevents Stripe-specific objects from leaking into entitlement/business code.

Use the repository's existing dependency direction and module conventions discovered during implementation rather than forcing these exact file names.

## 31. Definition of done

Stripe Billing V1 is not complete merely because Checkout can charge a test card.

The implementation is complete only when:

- four logical prices are centrally allowlisted;
- sandbox/live configuration is separated and validated;
- authenticated Free user can subscribe via hosted Checkout;
- duplicate subscriptions are prevented;
- paid users can manage billing;
- transition policy is implemented exactly;
- Stripe, not application arithmetic, owns proration;
- higher entitlement is never granted before required upgrade payment succeeds;
- downgrades/cancellation occur at the correct effective time;
- past-due recovery policy is implemented;
- webhook signatures are verified;
- webhook deliveries are idempotent;
- out-of-order/concurrent webhook processing is safe;
- current Stripe state can be reconciled deterministically;
- `User.plan` updates atomically with billing mirror state;
- Entitlements V1 remains unchanged as the feature-access authority;
- all acceptance tests pass;
- real sandbox smoke flows are documented and pass;
- lint/typecheck/test/build gates are green;
- no Stripe secret or live payment credential is committed.

## 32. Explicitly out of scope for Stripe Billing V1

Do not add unless a later product decision explicitly changes scope:

- Pro+;
- credits;
- Credit Top-Ups;
- usage-based billing;
- metered billing;
- seat-based pricing;
- trials;
- daily usage billing;
- custom card form / Stripe Elements;
- custom invoice rendering;
- promotion-code UI;
- affiliate/referral billing;
- automatic dispute-driven entitlement revocation;
- destructive downgrade handling;
- per-feature Stripe authorization checks;
- broad application UI redesign;
- mobile in-app-purchase billing;
- multiple simultaneous paid subscriptions per FactorSage user.

## 33. Official product rules summary

The V1 state machine can be summarized as:

```text
FREE
  -- successful Starter checkout --> STARTER
  -- successful Pro checkout -----> PRO

STARTER
  -- successful immediate upgrade -> PRO
  -- cancel requested -------------> STARTER until period end
  -- actual cancellation ----------> FREE

PRO
  -- downgrade requested ----------> PRO until period end
  -- downgrade effective ----------> STARTER
  -- cancel requested -------------> PRO until period end
  -- actual cancellation ----------> FREE

same-tier monthly -> yearly
  -> immediate billing change, entitlement tier unchanged

same-tier yearly -> monthly
  -> scheduled billing change, entitlement tier unchanged

past_due
  -> retain currently earned tier during configured recovery

unpaid / actually canceled
  -> FREE
```

Money calculations, prorations, billing anchors, invoices, and payment-method authentication belong to Stripe.

Product limits and resource behavior belong to FactorSage Entitlements V1.

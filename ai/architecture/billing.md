# Billing Architecture

`docs/decisions/stripe-billing-v1.md` is the product decision. This document is how it is
implemented; it does not restate or reinterpret the rules, and where the two could disagree the
decision document wins. `entitlements.md` is its neighbour: billing moves the plan, entitlements
decide what a plan may do.

## The shape of it

```text
Stripe (billing state, money movement)
  |
  |  webhook (signed)          operator CLI            browser return
  v                            v                       v
StripeWebhookController   reconcile-billing.ts    POST /billing/refresh
  |                            |                       |
  +----------------------------+-----------------------+
                               |
                               v
              BillingReconciliationService.reconcileUser()
                               |
              per-user advisory lock + one transaction
                               |
              +----------------+-----------------+
              |                                  |
              v                                  v
   BillingSubscription (mirror)          changeUserPlan() -> User.plan
                                                 |
                                                 v
                                      resolveEntitlements(plan, role)
                                                 |
                                                 v
                                        semantic entitlement guards
```

Four properties hold that together.

1. **One plan decision.** `resolveEffectivePlan` in `packages/contracts/src/billing.ts` is the only
   function that turns billing state into a `UserPlan`. It is pure, it has no Stripe types, and the
   webhook path, the plan-change endpoint, the browser refresh and the repair CLI all reach the plan
   through it.
2. **One write path.** `BillingReconciliationService.reconcileUser` is the only thing that writes
   `BillingSubscription`, and it writes `User.plan` only through the pre-existing
   `changeUserPlan` seam. No controller, no route and no webhook handler issues its own
   `prisma.user.update({ data: { plan } })`.
3. **One Stripe adapter.** `apps/api/src/billing/stripe.gateway.ts` is the only file in the
   repository that imports `stripe`. Everything else speaks the FactorSage types in
   `stripe-gateway.ts`, which is what lets the deterministic suites swap in a fake and what keeps
   Stripe objects out of entitlement and feature code.
4. **One direction.** Billing depends on the plan enum and nothing else from entitlements;
   entitlements depend on nothing from billing. `BillingModule` does not import
   `EntitlementsModule`. `packages/contracts/src/billing.entitlements-boundary.test.ts` enforces
   both halves.

## State ownership

| State | Owner | Where it lives |
| --- | --- | --- |
| Money, invoices, proration, taxes, payment methods, dunning | **Stripe** | Stripe |
| Subscription lifecycle and status | **Stripe** | mirrored into `BillingSubscription` |
| Canonical customer/subscription identity | FactorSage (the link), Stripe (the object) | `User.stripeCustomerId`, `BillingSubscription.stripeSubscriptionId` |
| Which plan a user is on | **FactorSage** | `User.plan` |
| What a plan may do | **FactorSage** | `packages/contracts/src/entitlements.ts` |
| Whether an event was processed | FactorSage | `StripeWebhookEvent` |

`BillingSubscription` is a **mirror**, not a second source of truth. It exists so the application can
answer "which plan, which cadence, when does it renew, what is scheduled" without a Stripe round trip
per request, and so reconciliation has something to compare against. It holds no invoices, no payment
methods and no copied Stripe objects.

`User.plan` is persisted rather than derived from the mirror at query time, because it is the hot-path
input to every entitlement check and must not depend on a biller being reachable. Entitlements worked
before billing existed and still work with no Stripe configured at all.

## Persistence

`packages/database/prisma/migrations/20260912230000_add_stripe_billing`. Fully additive: two enums,
one nullable column on `User`, two new tables. Every existing user stays `FREE` with no Stripe object,
which is exactly the correct starting state.

```text
User.stripeCustomerId?   unique     the canonical customer link, server-managed
BillingSubscription                  zero-or-one per user (userId unique)
  stripeSubscriptionId   unique      never mirrored onto two accounts
  stripePriceId                      the price billed NOW, never a pending one
  plan / billingInterval             resolved through the allowlist; null = not in catalog
  status                             mirrored Stripe status (9 values incl. UNKNOWN)
  currentPeriodStart/End
  cancelAtPeriodEnd / cancelAt / canceledAt
  pendingPlan / pendingInterval / pendingPriceId / pendingEffectiveAt
  stripeScheduleId
  planReason                         why the last reconciliation resolved the plan it did
  syncedAt / lastStripeEventCreatedAt
StripeWebhookEvent
  stripeEventId          unique      the idempotency key for side effects
  type / stripeCreatedAt / userId? / outcome / processedAt
```

The two unique constraints are the one-subscription invariant as a constraint rather than a
convention: one user cannot hold two mirrored subscriptions, and one Stripe subscription cannot be
mirrored onto two users.

## Stripe vs FactorSage responsibilities

FactorSage never computes a prorated amount, an unused-time credit, a tax, an invoice total or a
billing anchor. `proration_behavior: "always_invoice"` hands all of it to Stripe. There is no billing
arithmetic anywhere in the implementation, and the UI shows no financial preview — Stripe's hosted
Checkout and Customer Portal show the numbers, on Stripe's own pages.

## Endpoints

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /billing/status` | session | UI-safe billing state. No Stripe ids, ever. |
| `POST /billing/refresh` | session | Reconciles from Stripe, then returns status. Used once after a hosted round trip. |
| `POST /billing/checkout` | session | Hosted Checkout for a user with no live subscription. Body: `{ priceKey }`. |
| `POST /billing/portal` | session | Customer Portal session for the caller's own customer. No body. |
| `POST /billing/change` | session | Moves a live subscription between the four prices. Body: `{ priceKey }`. |
| `POST /webhooks/stripe` | Stripe signature | The authoritative synchronization path. |

The only input the whole surface accepts is one of four logical catalog keys.
`billing-requests.ts` **refuses** — not ignores — a request carrying `priceId`, `customerId`,
`subscriptionId`, `plan`, `role`, `successUrl` or similar, because a silently dropped field looks to a
client exactly like an accepted one.

### Why `POST /billing/change` exists

Customer Portal cannot express FactorSage's transition matrix. Portal price switching applies **one**
proration policy per configuration, so it can be always-immediate or always-at-period-end — while
sections 7-9 of the decision document require immediate for a tier upgrade *and* for monthly→yearly,
and period-end for a tier downgrade *and* for yearly→monthly. No single Portal setting produces both.
Rather than weaken the product rule, plan/cadence changes go through this endpoint and Portal keeps
payment methods, invoices and cancellation — where its behaviour *is* what we want.

## Plan mapping

`BillingCatalog` (`billing-catalog.ts`) is the allowlist, built from configuration:

| Logical key | Plan | Interval | Amount | Env variable |
| --- | --- | --- | ---: | --- |
| `STARTER_MONTHLY` | STARTER | MONTH | $9 | `STRIPE_PRICE_STARTER_MONTHLY` |
| `STARTER_YEARLY` | STARTER | YEAR | $99 | `STRIPE_PRICE_STARTER_YEARLY` |
| `PRO_MONTHLY` | PRO | MONTH | $29 | `STRIPE_PRICE_PRO_MONTHLY` |
| `PRO_YEARLY` | PRO | YEAR | $299 | `STRIPE_PRICE_PRO_YEARLY` |

A price id outside those four resolves to `null`, which `resolveEffectivePlan` turns into `FREE` with
reason `PRICE_NOT_IN_CATALOG` and an anomaly flag. Nothing infers a plan from an amount, a product
name, client input or metadata. Environment separation falls out of the same structure: a sandbox
deployment physically cannot resolve a live price.

## Status → plan

| Mirrored status | Plan | Reason | Note |
| --- | --- | --- | --- |
| `ACTIVE` | the subscribed plan | `SUBSCRIPTION_ACTIVE` | |
| `PAST_DUE` | the subscribed plan | `SUBSCRIPTION_IN_RECOVERY` | Kept during Stripe's retry window |
| `INCOMPLETE` | `FREE` | `SUBSCRIPTION_INCOMPLETE` | A submitted payment is not a payment |
| `INCOMPLETE_EXPIRED` / `CANCELED` / `UNPAID` | `FREE` | `SUBSCRIPTION_TERMINATED` | |
| `TRIALING` / `PAUSED` / `UNKNOWN` | `FREE` | `SUBSCRIPTION_UNSUPPORTED_STATUS` | **Anomalous**, logged loudly |
| no subscription | `FREE` | `NO_SUBSCRIPTION` | |
| price not in catalog | `FREE` | `PRICE_NOT_IN_CATALOG` | **Anomalous**, logged loudly |

`trialing` and `paused` deliberately grant nothing. V1 sells neither, Portal has trials disabled, and
Checkout creates none — so seeing one means somebody edited the subscription in the Dashboard into a
state this product has no rules for, and section 10 requires that to be conservative and loud rather
than quietly generous. **Operational consequence:** manually starting a trial on a customer in the
Stripe Dashboard revokes their paid access until the trial ends. Do not do it; grant access through
`role`/fixtures instead.

## Customer lifecycle

Created lazily, on first billing need, inside the user's advisory lock:

1. Read `User.stripeCustomerId` under the lock.
2. If present, confirm Stripe still has it (a deleted customer, or a database restored against a
   different Stripe account, is replaced rather than reused — reusing one fails at Checkout where the
   user is watching).
3. Otherwise create one with idempotency key `factorsage:customer:<userId>` — stable for the life of
   the user — and persist the id in the same transaction.

Two protections, not one: the lock stops two simultaneous first-Checkout requests from each creating a
customer, and the stable idempotency key means even a retry that escaped the lock returns the *same*
customer. Identity is `User.stripeCustomerId`, never email. Stripe customer metadata carries
`factorsageUserId` for support, and it is a resolution aid, never an authorization.

## Transitions

`classifyBillingTransition` (pure, in contracts) decides, and the same function is used by the UI so
its labels cannot promise something the API will not do.

```text
tier rank: FREE < STARTER < PRO      (billing transitions only, never an entitlement comparison)

target tier higher   -> IMMEDIATE   (TIER_UPGRADE)
target tier lower    -> SCHEDULED   (TIER_DOWNGRADE)
same tier, ->YEAR    -> IMMEDIATE   (CADENCE_LENGTHENED)
same tier, ->MONTH   -> SCHEDULED   (CADENCE_SHORTENED)
same price           -> UNCHANGED
```

**Tier direction beats interval direction.** Starter yearly → Pro monthly is an immediate upgrade even
though the cadence shortens; Pro monthly → Starter yearly is a period-end downgrade even though it
lengthens. Classifying by monthly/yearly first gets both backwards.

### Immediate changes

`subscriptions.update` with `proration_behavior: "always_invoice"` and
`payment_behavior: "pending_if_incomplete"`.

`pending_if_incomplete` is the load-bearing choice. If the proration invoice cannot be paid, Stripe
holds the request as a `pending_update` and **leaves the subscription's items on the old price**.
Reconciliation reads the current item price, so the user keeps the tier they paid for, and the higher
tier appears only once Stripe reports the new price as current. With `always_invoice` alone the item
would flip immediately and an unpaid invoice would be all that stood between a declined card and a
free upgrade.

### Scheduled changes

A Subscription Schedule — the mechanism Stripe's own Portal uses for scheduled downgrades. The current
phase is pinned to end at `currentPeriodEnd`, a second phase carries the new price,
`proration_behavior: "none"` on the boundary (nothing is prorated; the user simply stops paying the
old price when it expires, and the unused higher-tier period is **not** refunded), and
`end_behavior: "release"` so the schedule detaches afterwards and leaves an ordinary subscription.

`pendingPlan` / `pendingEffectiveAt` mirror the next phase for the UI. They are never an entitlement:
until the phase begins the user keeps the current plan.

**The schedule must be released once it has applied its change, and that is a correctness
requirement rather than tidiness.** Stripe refuses to change *any* cancellation behaviour on a
subscription a schedule manages — *"The subscription is managed by the subscription schedule …, and
updating any cancelation behavior directly is not allowed"* — and Customer Portal's cancel button does
exactly that. `end_behavior: release` only fires when the schedule's **final** phase ends, and the
final phase here is open-ended, so it never fires on its own. Left alone, every user who ever changed
plan or cadence would permanently lose the ability to cancel.

`BillingReconciliationService.releaseSpentSchedule` therefore detaches a schedule whose pending change
is gone, **after** the transaction commits: it is an external mutation a rollback could not undo, and
doing it outside means a failure leaves local state correct and simply retries on the next
reconciliation. That also makes it self-healing — any webhook, refresh or `pnpm billing:reconcile` run
clears a stuck schedule, which is how an already-stuck subscription is repaired.

One narrow limitation remains, and it is Stripe's: **while a scheduled change is still pending, the
subscription cannot be cancelled** (in Portal or anywhere else), because the schedule is legitimately
still managing it. The pending change has to become effective first. V1 accepts this; the decision
document's Portal list does not require cancelling *through* a pending change.

A change is refused while `cancelAtPeriodEnd` is set — the user has asked to stop paying, and layering
a plan change over that produces a state neither they nor the schedule can express. Resume in Portal
first.

### Cancellation

Through Customer Portal, as `cancel_at_period_end`. The mirror records it and the plan does not move;
`customer.subscription.deleted` at the period boundary is what makes the user `FREE`. Reversing it
before the boundary is a no-op for entitlements.

## Webhooks

`POST /webhooks/stripe`. Signature verified against the **raw** body — `main.ts` sets
`rawBody: true` for this reason, and the handler reads `request.rawBody`. A parsed-and-reserialized
body verifies against nothing.

Handled events, all of which do the same thing (resolve the user, then reconcile):

```text
checkout.session.completed
customer.subscription.created / .updated / .deleted
customer.subscription.pending_update_applied / .pending_update_expired
invoice.paid / invoice.payment_failed
subscription_schedule.updated / .released / .aborted
```

Anything else is recorded as `IGNORED_UNHANDLED_TYPE` and acknowledged with `200`, because Stripe
retries non-2xx for days and retrying an event we will never act on hides the failures that matter.

| Response | Meaning |
| --- | --- |
| `200` | Durably handled (or deliberately ignored). Do not resend. |
| `400` | Invalid signature or malformed. Stripe does not retry. |
| `500` | Transient failure. Stripe's retry is the recovery mechanism. |
| `503` | Billing is not configured in this deployment. |

Guards before any state change: signature, then `livemode` against the configured key's mode (a
Dashboard endpoint pointed at the wrong environment would otherwise mirror live billing into a test
database), then the handled-type set, then user resolution.

### Ordering, duplication and concurrency

Reconciliation never applies an event payload. It refetches canonical Stripe state, so a stale event
carries no stale data. But two reconciliations could each fetch and then interleave their writes, with
the *earlier* fetch committing *last* — a stale snapshot overwriting a newer one.

The fix is structural rather than optimistic: **the user's advisory lock is taken first, and the Stripe
read happens after it, inside the same transaction.** There is then no window in which two fetches can
interleave. The cost is one database connection held across a Stripe call, bounded by
`STRIPE_TIMEOUT_MS` and a 30 s transaction timeout; billing volume is a few events per user per month.

Duplicate deliveries collide on `StripeWebhookEvent.stripeEventId`, which is inserted **inside** the
same transaction, before the Stripe call:

- a duplicate hits the unique index and is answered `DUPLICATE_EVENT`;
- two concurrent copies serialize on the advisory lock, so one applies and one is a duplicate;
- a failure or crash rolls the marker back with everything else, so Stripe's retry is a clean first
  attempt rather than a permanently burned event id.

### Which lock

`lockUserEntitlementScope` — the *same* per-user advisory lock every capacity-controlled write takes,
not a new billing lock. `User.plan` is the input to every entitlement decision, so a plan change and a
list add that counts against that plan genuinely must serialize. Reusing the key also preserves the
repository's acquisition order (entitlement lock first, before any row lock), so reconciliation cannot
deadlock against a backtest submission or a list mutation. See `entitlements.md`.

## The one-subscription invariant

Stripe can legitimately hold several subscriptions for one customer (a canceled one plus a new one).
Reconciliation picks the canonical one deterministically:

1. the already-mirrored subscription, if still live — stability matters, because flipping the canonical
   subscription changes somebody's plan;
2. otherwise the single live one;
3. otherwise, with several live, the **oldest** by Stripe's `created` — deterministic, and not gameable
   by starting another subscription. The conflict is logged at `error` as
   `billing.invariant.multiple-live-subscriptions` and flagged anomalous. Nothing is merged, nothing is
   canceled and no refund is issued: an operator decides;
4. with none live, the mirrored one if Stripe still has it, else the newest terminal one — so the UI can
   say *why* access ended.

Checkout refuses when a subscription holds the paid slot, and `occupiesPaidSlot` includes `INCOMPLETE`:
an unpaid Checkout grants nothing but still holds the slot, so a user retrying a declined payment
cannot end up paying twice when both eventually settle.

## Idempotency keys

Derived from stable operation identity, never regenerated per retry.

| Operation | Key | Why that identity |
| --- | --- | --- |
| Customer creation | `factorsage:customer:<userId>` | Stable forever. No retry, ever, creates a second canonical customer. |
| Checkout session | `factorsage:checkout:<userId>:<priceKey>:<requestId>` | Stable for one user action and its internal retries; a genuinely new attempt is a new request, because a user who abandoned Checkout must be able to start again. |
| Immediate change | `factorsage:sub-update:<subId>:<fromPriceId>:<toPriceId>` | The *change* is the identity, so a retry cannot bill a second proration. |
| Scheduled change | `factorsage:sub-schedule:<subId>:<toPriceId>:<effectiveAtEpoch>` | Guards the schedule **creation** only. |
| Schedule phases update | *(none, deliberately)* | It creates nothing and charges nothing — setting phases is already idempotent. Keying it actively broke the call: Stripe refuses a key replayed with different parameters, so a first attempt that failed and was retried with corrected parameters locked the user out of that transition for 24 hours with a `400` that looks nothing like its cause. Sandbox testing hit exactly that. |
| Portal session | `factorsage:portal:<customerId>:<requestId>` | Per user action. |

`<requestId>` is the id the observability middleware assigns, so it is shared by a request and its
internal retries and differs between user actions.

## Stripe SDK and API version

`stripe@22.6.2`, pinned API version **`2026-08-26.dahlia`**. The client is constructed without an
`apiVersion` override so the types and the wire format cannot disagree. Two behaviours of that version
shape the code:

1. **`current_period_start` / `current_period_end` are no longer on the Subscription** — they live on
   each subscription *item*. A V1 subscription has one item, so the gateway reads the period from it.
   Code written against an older version would silently mirror a null renewal date.
2. **`billing_mode` defaults to `flexible`**, Stripe's current recommended mode for new integrations,
   so it is not passed explicitly — passing it would pin today's default into the code and hide a
   future change.

`Subscription.status` is typed as a union *plus an open string*, which is why `toMirroredStatus` has an
`UNKNOWN` case and `resolveEffectivePlan` has no permissive default.

**The account's default API version and the SDK's pinned version can differ, and that is fine here.**
Sandbox testing ran with the account default at `2026-03-25.dahlia` while the SDK pinned
`2026-08-26.dahlia`: event *payloads* are serialized at the account default, SDK *reads* use the pinned
version. It is harmless precisely because reconciliation never interprets a payload beyond stable
identity fields (`id`, `type`, `created`, `livemode`, `customer`, `subscription`, Checkout metadata) and
refetches everything else. A design that read prices or periods out of event payloads would break on
exactly this mismatch.

## Configuration

Server-only, all in `getStripeBillingConfig` (`packages/config`). Optional as a whole, all-or-nothing
once touched: with every `STRIPE_*` variable empty the providers resolve to `null`, billing reports
itself unavailable, and no other package or suite needs a Stripe secret.

```text
STRIPE_SECRET_KEY                  sk_test_/rk_test_ (sandbox) or sk_live_/rk_live_ (live)
STRIPE_WEBHOOK_SECRET              whsec_...
STRIPE_PRICE_STARTER_MONTHLY       price_...
STRIPE_PRICE_STARTER_YEARLY        price_...
STRIPE_PRICE_PRO_MONTHLY           price_...
STRIPE_PRICE_PRO_YEARLY            price_...
STRIPE_CHECKOUT_SUCCESS_URL        optional; defaults from WEB_BASE_URL
STRIPE_CHECKOUT_CANCEL_URL         optional
STRIPE_PORTAL_RETURN_URL           optional
STRIPE_TIMEOUT_MS                  default 20000
STRIPE_MAX_NETWORK_RETRIES         default 2
```

Startup **fails** on: a partial configuration, a malformed key or price id, two logical prices sharing
one Stripe price, a live key outside `NODE_ENV=production`, or a sandbox key in production. The last
two are the concrete form of "production must never boot with sandbox material and local development
must never be able to charge a real card".

## Sandbox vs live

Separate Stripe environments with separate keys, separate webhook secrets and separate price ids.
Nothing is interchangeable. `stripe login` selects the sandbox account for the CLI; the config guards
above prevent the mismatches that actually happen.

**Never run implementation testing against live Stripe.** The sandbox smoke suite refuses to run
against a live key even when explicitly enabled.

## Local setup

### 1. Sandbox credentials

```bash
stripe login                      # choose the FactorSage sandbox account
stripe config --list              # confirm which profile is active
```

Put the sandbox secret key in `.env` as `STRIPE_SECRET_KEY` (from Dashboard → Developers → API keys,
in the sandbox).

### 2. Create the catalog

Either in the sandbox Dashboard (two products, two prices each) or with the CLI:

```bash
stripe products create --name "Starter" --description "FactorSage Starter"
stripe prices create --product prod_XXX --currency usd --unit-amount 900 \
  -d "recurring[interval]=month" --lookup-key factorsage_starter_monthly
stripe prices create --product prod_XXX --currency usd --unit-amount 9900 \
  -d "recurring[interval]=year"  --lookup-key factorsage_starter_yearly

stripe products create --name "Pro" --description "FactorSage Pro"
stripe prices create --product prod_YYY --currency usd --unit-amount 2900 \
  -d "recurring[interval]=month" --lookup-key factorsage_pro_monthly
stripe prices create --product prod_YYY --currency usd --unit-amount 29900 \
  -d "recurring[interval]=year"  --lookup-key factorsage_pro_yearly
```

Put the four `price_...` ids in `.env`, then verify them:

```bash
pnpm billing:verify-catalog
```

That command is the guard against the mistake runtime cannot see: a `STRIPE_PRICE_PRO_MONTHLY`
pointing at the $9 Starter price would sell Pro entitlements for nine dollars and never complain,
because runtime deliberately never reads an amount.

### 3. Webhook forwarding

```bash
stripe listen --forward-to localhost:3001/webhooks/stripe
```

It prints a `whsec_...` — put **that** in `STRIPE_WEBHOOK_SECRET` and restart the API. It is a
different secret from a deployed endpoint's; do not share one. Never commit it.

Optionally narrow the stream to the events FactorSage handles:

```bash
stripe listen --forward-to localhost:3001/webhooks/stripe \
  --events checkout.session.completed,customer.subscription.created,\
customer.subscription.updated,customer.subscription.deleted,\
customer.subscription.pending_update_applied,customer.subscription.pending_update_expired,\
invoice.paid,invoice.payment_failed,\
subscription_schedule.updated,subscription_schedule.released,subscription_schedule.aborted
```

### 4. Run the stack

```bash
pnpm infra:up
pnpm dev:api      # terminal 2
pnpm dev:web      # terminal 3
stripe listen --forward-to localhost:3001/webhooks/stripe   # terminal 4
```

Sign in as `PRO_USER` or any persona and open `/billing`.

## Manual sandbox runbook

Hosted Checkout and Customer Portal are browser flows, so these are manual. Test cards:
`4242 4242 4242 4242` succeeds, `4000 0000 0000 0341` **attaches but fails on charge** (the one to
use for a failed upgrade), `4000 0000 0000 9995` is declined outright. Any future expiry, any CVC.

### Purchase

1. `/billing` → choose a plan → hosted Checkout → pay with `4242…`.
2. Watch `stripe listen` show `checkout.session.completed` and `customer.subscription.created`.
3. `/billing` shows the plan, cadence and renewal date.
4. Verify the plan really moved:
   ```bash
   docker exec -e PGPASSWORD=intrinsic_dev_password factorsage-postgres-1 \
     psql -U intrinsic -d intrinsic_value -c \
     "SELECT u.email, u.plan, b.status, b.\"billingInterval\", b.\"planReason\"
        FROM \"User\" u LEFT JOIN \"BillingSubscription\" b ON b.\"userId\" = u.id
       WHERE u.email = 'you@example.com';"
   ```

### Upgrade, including a failed one

1. Starter → Pro from `/billing`. Expect an immediate change and `plan = PRO`.
2. For the failure case, first set the customer's default payment method to `4000 0000 0000 0341` in
   the sandbox Dashboard, then request the upgrade. Expect `plan` to stay `STARTER`,
   `stripePriceId` to stay the Starter price, and the subscription to carry a `pending_update` in
   Stripe. Paying the open invoice in the Dashboard then produces
   `customer.subscription.pending_update_applied` and `plan = PRO`.

### Downgrade and cadence

1. Pro → Starter. Expect `SCHEDULED`, `plan` still `PRO`, and `pendingPlan = STARTER` with an
   effective date.
2. Starter monthly → Starter yearly. Expect `IMMEDIATE` and `billingInterval = YEAR`.
3. Pro yearly → Pro monthly. Expect `SCHEDULED` with `pendingInterval = MONTH`.

### Cancellation

Cancel in Customer Portal. Expect `cancelAtPeriodEnd = true` and the plan unchanged. Resume it and
expect no entitlement transition.

### Advancing time — Test Clocks

Scheduled downgrades, renewals and the end of a cancelled period need the period boundary to arrive.
Stripe Test Clocks are the supported way to do that in sandbox:

```bash
# A clock, then a customer attached to it, then a subscription on that customer.
stripe test_helpers test_clocks create --frozen-time $(date +%s)
stripe customers create --test-clock clock_XXX --email clock@smoke.test
stripe subscriptions create --customer cus_XXX -d "items[0][price]=price_XXX"

# Advance past the period end and watch the events arrive.
# The clock id is POSITIONAL here — `--id` is rejected as an unknown flag.
stripe test_helpers test_clocks advance clock_XXX --frozen-time <epoch>

# Advancing is asynchronous. Poll until it is done before asserting anything:
stripe test_helpers test_clocks retrieve clock_XXX   # status: advancing -> ready
```

A clock is also deleted automatically about 30 days after creation (`deletes_after` on the object), so
a monthly boundary is reachable and a yearly one is not — schedule yearly-boundary scenarios from a
clock created at a date that puts the boundary inside that window, or verify them another way.

**The limitation, stated plainly:** a Test Clock customer must be created *with* the clock, and
FactorSage's Checkout flow creates its customer itself, so a clock cannot be attached to a customer
that arrived through hosted Checkout. Two consequences:

- For a clock-driven lifecycle test, create the clock customer with the CLI, then attach it to a
  FactorSage user by setting `User.stripeCustomerId` to it and running `pnpm billing:reconcile --user
  <email>`. From there every boundary event flows through the real webhook path.
- The deterministic suite already proves every time-boundary rule by advancing the fake's state
  directly (`applyScheduledPhase`, `endSubscription`, `applyPendingUpdate`), so clocks are a
  contract check on Stripe's side, not the primary proof.

Alternatively, without a clock: cancel a subscription immediately in the Dashboard
(`customer.subscription.deleted` arrives at once) to verify the FREE transition, and release a
schedule to verify the pending mirror clearing.

## Reconciliation and repair

Webhooks are the normal path; this is the deterministic repair seam. It calls the **same**
`reconcileUser`, under the same lock, in the same transaction — there is no second implementation of
billing rules for tooling.

```bash
# One user, by email or id.
pnpm billing:reconcile -- --user someone@example.com

# Everyone with any billing footprint.
pnpm billing:reconcile -- --all

# Report current state without writing.
pnpm billing:reconcile -- --all --dry-run
```

Safe to run while a webhook is being processed for the same user: one waits for the other and both
converge, because the operation is "make local state match Stripe", not "apply a delta".

Use it for: a missed webhook, a deployment outage, a database restore, a Stripe delivery failure, or a
user reporting the wrong plan. It prints `previous -> new` per user and marks anomalies
`*** NEEDS ATTENTION ***`.

## Common failure recovery

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Paid in Stripe, still FREE locally | webhook not delivered (`stripe listen` not running, wrong secret) | `pnpm billing:reconcile -- --user <email>` |
| Webhooks return 400 | `STRIPE_WEBHOOK_SECRET` is not the one `stripe listen` printed | copy the current `whsec_...`, restart the API |
| Webhooks return 503 | billing not configured in this process | set the `STRIPE_*` variables, restart |
| `IGNORED_ENVIRONMENT_MISMATCH` in logs | a live endpoint pointed at a sandbox deployment (or vice versa) | fix the Dashboard endpoint URL |
| `PRICE_NOT_IN_CATALOG` | subscription on an archived/legacy/foreign price | correct the subscription in Stripe, or fix `STRIPE_PRICE_*`, then reconcile |
| `SUBSCRIPTION_UNSUPPORTED_STATUS` | a Dashboard-created trial or pause | end the trial/pause; V1 supports neither |
| `billing.invariant.multiple-live-subscriptions` | two live subscriptions for one customer | decide which is canonical, cancel the other in Stripe, reconcile |
| Portal session creation fails | no Customer Portal configuration saved in this Stripe environment | save a configuration in the Dashboard (see checklist) |
| Cancelling fails: "managed by the subscription schedule" | a spent schedule is still attached | `pnpm billing:reconcile -- --user <email>` releases it; newer code releases it automatically |
| A scheduled change cannot be made | a previous attempt failed and its idempotency key is poisoned | no longer possible for the phases update (it carries no key); for an immediate change, wait out Stripe's 24-hour key window or change the target |
| Plan correct, catalog wrong | a Dashboard price edit | `pnpm billing:verify-catalog` |

## Inspecting a user's billing state

"Why is user X currently FREE/STARTER/PRO?" is answerable from three places:

1. **The database** — `User.plan`, plus `BillingSubscription.status`, `stripePriceId`, `planReason`
   and `syncedAt`. `planReason` is literally why the last reconciliation resolved what it did.
2. **The logs** — `billing.reconciliation.completed` carries `actorUserId`, `trigger`,
   `previousPlan`, `plan`, `planChanged`, `planReason` and `subscriptionStatus`.
   `billing.webhook.received` / `.processed` tie it to a Stripe event id.
3. **`pnpm billing:reconcile -- --user <email> --dry-run`** — the current picture in one line.

Structured events: `billing.checkout.created`, `billing.portal.created`, `billing.customer.created`,
`billing.customer.adopted`, `billing.change.requested`, `billing.change.completed`,
`billing.webhook.received`, `billing.webhook.processed`, `billing.webhook.duplicate`,
`billing.webhook.signature.invalid`, `billing.webhook.environment-mismatch`,
`billing.webhook.unknown-subject`, `billing.reconciliation.completed`,
`billing.reconciliation.failed`, `billing.invariant.multiple-live-subscriptions`,
`billing.invariant.customer-owned-by-another-user`, `billing.schedule.released`,
`billing.schedule.release-failed`, `billing.stripe.schedule.released`, `billing.stripe.call.completed`,
`billing.stripe.call.failed`, `billing.request.refused`.

No secret, no card detail and no full Stripe payload is ever logged.

## Stripe Dashboard configuration checklist

Do all of this in the **sandbox** first, then repeat in **live** before launch. None of it is assumed
by the code, and the code cannot create most of it.

### Products and prices

- [ ] Two active products: `Starter`, `Pro`.
- [ ] Four active recurring USD prices at $9 / $99 / $29 / $299, `interval_count = 1`, licensed.
- [ ] Lookup keys `factorsage_{starter,pro}_{monthly,yearly}` (optional, operationally useful).
- [ ] Archive every legacy Credit Top-Up price and the legacy $39/$399 Pro prices.
- [ ] `pnpm billing:verify-catalog` passes.

### Customer Portal (Settings → Billing → Customer portal)

A configuration **must be saved**, or session creation fails outright. The FactorSage sandbox was
verified to match every line below (configuration `bpc_…`, default, active); **live still needs the
same setup independently.**

- [ ] Payment method update: **on**.
- [ ] Invoice history: **on**.
- [ ] Cancel subscription: **on**, mode **at end of billing period**. Never immediately — immediate
      cancellation would revoke a paid period.
- [ ] Customers can resume a scheduled cancellation: **on**.
- [ ] **Switch plans / update subscriptions: OFF.** This is deliberate and load-bearing. Portal
      applies one proration policy to every switch, which cannot express the asymmetric
      immediate-vs-scheduled matrix; `POST /billing/change` owns plan changes instead. Leaving it on
      would give users a second path with the wrong semantics.
- [ ] Trials: **not offered**.
- [ ] Promotion codes: **off** (out of V1 scope).
- [ ] Only the two FactorSage products appear; no unrelated catalog items.

### Webhooks (Developers → Webhooks)

- [ ] Endpoint `https://<api-host>/webhooks/stripe` for each deployed environment.
- [ ] Events: the eleven listed under "Webhooks" above, and nothing else.
- [ ] Signing secret copied into that environment's `STRIPE_WEBHOOK_SECRET` — per environment, never
      shared.
- [ ] The live endpoint points only at production; the sandbox endpoint only at sandbox/local.

### Revenue recovery (Settings → Billing → Revenue recovery)

- [ ] Smart Retries: **on**.
- [ ] Failed-payment customer emails: **on**.
- [ ] Automatic card updates: **on** where supported.
- [ ] Terminal behaviour after retries: **cancel the subscription** (FactorSage then reconciles to
      `FREE`). Whatever is chosen must be deliberate — the mapping in "Status → plan" assumes a
      terminal state is reached rather than `past_due` forever.

### Payment methods and tax

- [ ] Card enabled. Add others deliberately; nothing in the integration depends on which.
- [ ] Stripe Tax: off for V1, and enabling it later needs no code change. Complete the tax/business
      registrations before turning it on in live.

### Deployment checklist

- [ ] `NODE_ENV=production` **and** live `sk_live_`/`rk_live_` key — either one alone fails startup.
- [ ] Live price ids, not sandbox ones.
- [ ] The production endpoint's own `STRIPE_WEBHOOK_SECRET`.
- [ ] `WEB_BASE_URL` correct, so Checkout/Portal return URLs resolve.
- [ ] `pnpm billing:verify-catalog` run against live configuration.
- [ ] `pnpm billing:reconcile -- --all --dry-run` after the first deploy, as a sanity read.

## What sandbox validation actually proved

Run against the FactorSage Stripe sandbox (test mode, `livemode: false` on every object) with
`stripe listen` forwarding to the local API. Four real defects surfaced here and nowhere else, which is
the argument for keeping this runbook alive:

| Scenario | Result |
| --- | --- |
| Catalog verification | four prices exact: $9 / $99 / $29 / $299, active, USD, licensed, one product per plan; legacy $39/$399 Pro prices confirmed archived |
| `FREE -> STARTER` via hosted Checkout (`4242…`) | 12 events forwarded, 3 handled; `invoice.paid` arrived **before** `customer.subscription.created` and all three converged on `STARTER` — out-of-order convergence, proved against real Stripe rather than a fake |
| Entitlements after purchase | `tier=STARTER`, 50 symbols / 15 years / 3 monitors, straight from `User.plan` |
| `STARTER -> PRO` immediate upgrade | Stripe invoiced −$9.00 unused + $29.00 = **$20.00 paid**; FactorSage computed nothing |
| Pro monthly -> Pro yearly | `IMMEDIATE` / `CADENCE_LENGTHENED`, tier unchanged, period end moved out a year |
| Pro yearly -> Pro monthly | `SCHEDULED` / `CADENCE_SHORTENED`, plan stays `PRO`, schedule attached |
| Pro yearly -> Starter yearly | `SCHEDULED` / `TIER_DOWNGRADE` — tier direction beat the lengthening cadence, and it *replaced* the pending cadence change |
| **Failed upgrade** (`pm_card_chargeCustomerFail`) | Stripe held a `pending_update` for the Pro price, left the item on Starter, left a **$20 open invoice** — `User.plan` stayed `STARTER` |
| Paying that invoice | `customer.subscription.pending_update_applied` moved `STARTER -> PRO`; later events no-ops |
| Scheduled downgrade at the boundary (Test Clock) | `customer.subscription.updated` moved `PRO -> STARTER`, pending cleared, entitlements dropped to 50/15/3 |
| Cancel at period end | `cancelAtPeriodEnd=true`, plan **kept** at `STARTER` |
| Actual cancellation (Test Clock) | `customer.subscription.deleted` moved `STARTER -> FREE`, entitlements dropped to 10/5/1 |
| Duplicate delivery (`stripe events resend`) | answered `DUPLICATE_EVENT`, event row stayed at 1, plan unchanged |
| Repair CLI on a user with no webhook ever delivered | `FREE -> STARTER (CHANGED)` from Stripe state alone |
| Customer Portal session | created against `billing.stripe.com`; config verified as cancel-at-period-end with `subscription_update` disabled |
| `GET /billing/status` | carries no `cus_`, `sub_`, `price_`, `sk_test` or `whsec_` |

### The four defects sandbox testing found

1. **Wrong schedule phase.** `phases.at(-1)` is the current phase only until a change is already
   scheduled; after that it is the *future* phase, and pinning it produced `start_date == end_date`,
   which Stripe rejects. Fixed by `selectCurrentPhase`, guarded by
   `stripe-schedule-phases.test.ts`.
2. **Poisoned idempotency key.** Keying the declarative phases update meant a corrected retry was
   refused for 24 hours. The key now guards only the schedule creation.
3. **Schedule never released.** `end_behavior: release` never fires on an open-ended final phase, and
   Stripe refuses to set cancellation behaviour while a schedule is attached — so cancellation was
   permanently broken for anyone who ever changed plan. Now released after the change applies, and
   self-healing through reconciliation.
4. **CLI argument handling.** pnpm forwards the `--` separator into the script, so the documented
   `pnpm billing:reconcile -- --user x` failed. Both forms now work.

## Tests

| Suite | What it proves |
| --- | --- |
| `packages/contracts/src/billing.test.ts` | The catalog, all sixteen ordered transition pairs, and every status→plan mapping, written as literals so the suite cannot agree with a wrong implementation. |
| `packages/contracts/src/billing.entitlements-boundary.test.ts` | Billing carries no entitlement value or vocabulary; entitlements have no billing dependency; billing's only output is a `UserPlan`. |
| `packages/config/src/index.test.ts` | All-or-nothing configuration, and the sandbox/live guards in both directions. |
| `apps/api/src/billing/billing.integration.test.ts` | HTTP → Nest → PostgreSQL with Stripe faked at the gateway: the twenty lifecycle acceptance cases, checkout allowlisting, customer reuse under concurrency, the one-subscription invariant, reconciliation/repair, and the webhook robustness list (duplicate, concurrent, stale, crash, unknown customer, unknown price, environment mismatch). |
| `apps/api/src/billing/billing.sandbox.smoke.test.ts` | The real Stripe contract. Opt-in via `STRIPE_SANDBOX_SMOKE=true`, excluded from `pnpm test`, and refuses to run against a live key. |
| `apps/web/src/features/billing/components/BillingPage.test.tsx` | What the page shows and refuses to show — notably that `?checkout=success` grants nothing. |
| `apps/web/e2e/billing/*.spec.ts` | The browser half, per persona: FREE sees the catalog, crafted requests are refused, returning from Checkout grants nothing, a paid-tier persona works with no Stripe subscription at all, and a guest is refused everywhere. |

`FakeStripeGateway` (`stripe-gateway.test-helper.ts`) models Stripe's observable behaviour — statuses,
current price versus held `pending_update`, schedules, idempotency keys, and real HMAC webhook
signatures. It models no money, because FactorSage computes none.

The Playwright persona matrix deliberately still works without Stripe: `PRO_USER` is `plan=PRO`
because it is seeded that way, and `billing.pro.spec.ts` asserts exactly that — the product works for
an account with no biller attached.

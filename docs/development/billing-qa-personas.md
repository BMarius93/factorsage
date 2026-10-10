# Billing QA personas

Five accounts whose billing state is **real**: each holds a subscription that exists in Stripe test
mode — active, scheduled to cancel, past due, or ended — and each got its `BillingSubscription`
mirror and its `User.plan` from the application's own reconciliation, not from a seeder.

They exist to answer one question the entitlement personas cannot: _what does FactorSage make of a
real Stripe subscription in this state?_

> Not to be confused with the **entitlement** personas (`FREE_USER`, `STARTER_USER`, `PRO_USER`,
> `ADMIN_USER`, `DOWNGRADED_USER`; `docs/development/qa-personas.md`,
> `ai/workflows/auth-testing.md`). Those are fixed points on a _plan_: the plan is written directly,
> there is no Stripe object behind it, and they must keep working with no Stripe configured at all
> (`docs/decisions/stripe-billing-v1.md` section 29). Nothing in this document changes them, and the
> two sets share no account, no registry and no command.

`docs/decisions/stripe-billing-v1.md` is the product decision and `ai/architecture/billing.md` is
how billing is implemented. This document does not restate their rules; section 2 only records how
the existing implementation behaves in the five states the personas cover, because the personas are
held to exactly that.

## 1. The personas

Defined once, in `packages/testing/src/billing-personas.ts`.

| Persona                    | Handle             | Catalog price     | Stripe state                                        | `BillingSubscription`                         | `User.plan` |
| -------------------------- | ------------------ | ----------------- | --------------------------------------------------- | --------------------------------------------- | ----------- |
| `BILLING_STARTER_ACTIVE`   | `starter-active`   | `STARTER_YEARLY`  | `active`                                            | `ACTIVE`, `SUBSCRIPTION_ACTIVE`               | `STARTER`   |
| `BILLING_PRO_ACTIVE`       | `pro-active`       | `PRO_MONTHLY`     | `active`                                            | `ACTIVE`, `SUBSCRIPTION_ACTIVE`               | `PRO`       |
| `BILLING_PRO_CANCELING`    | `pro-canceling`    | `PRO_YEARLY`      | `active`, cancellation scheduled for the period end | `ACTIVE`, `cancelAtPeriodEnd`, `cancelAt` set | `PRO`       |
| `BILLING_STARTER_PAST_DUE` | `starter-past-due` | `STARTER_MONTHLY` | `past_due` after a renewal that failed              | `PAST_DUE`, `SUBSCRIPTION_IN_RECOVERY`        | `STARTER`   |
| `BILLING_CANCELED`         | `canceled`         | `PRO_MONTHLY`     | `canceled` when its paid period ended               | `CANCELED`, `SUBSCRIPTION_TERMINATED`         | `FREE`      |

- Addresses are `qa-billing-<handle>@factorsage.test`. They are stated in the registry rather than
  read from the environment because they are also the identity the Stripe fixtures are tagged with.
  `.test` is a reserved domain and can never be a mailbox.
- `BILLING_STARTER_ACTIVE` is the baseline the brief left optional. It is included because it is the
  control for `BILLING_STARTER_PAST_DUE` (same plan, different Stripe status, same entitlements), and
  because with it the five personas bill **all four configured catalog prices**.
- `BILLING_CANCELED` was a Pro subscriber, so the retained mirror says `PRO` while the account is
  `FREE` — the most discriminating version of that state.
- The expectations in the registry are **literals** from the decision document.
  `billing-persona-registry.test.ts` then checks them against `resolveEffectivePlan`, so a persona
  cannot declare an outcome the product's one plan decision does not produce.

## 2. The existing behaviour the personas are held to

Read from the implementation before anything was built, and proven again by the suites in
section 9. Nothing here is new.

| State                                          | What reconciliation does (`BillingReconciliationService.reconcileUser`)                                                                                                                                                                                                                                                                                       | `GET /billing/status`                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **ACTIVE**                                     | Mirror upserted from the subscription's **current** item price through the configured allowlist. `resolveEffectivePlan` → the subscribed plan, `SUBSCRIPTION_ACTIVE`.                                                                                                                                                                                         | paid plan; `canStartCheckout: false`, `canChangePlan: true`                                                |
| **PAST_DUE**                                   | Mirror `PAST_DUE`. The plan is **kept** (`SUBSCRIPTION_IN_RECOVERY`): access survives Stripe's retry window by decision. `occupiesPaidSlot` stays true.                                                                                                                                                                                                       | paid plan; the page shows a warning, not a downgrade                                                       |
| **Scheduled cancellation**                     | Stripe has two representations; `hasScheduledCancellation` accepts either, and the pinned API version returns `cancel_at` set with `cancel_at_period_end: false`. Mirror `cancelAtPeriodEnd: true`, `cancelAt` = the period end, `canceledAt` = when it was asked for. Status stays `ACTIVE`, the plan does not move.                                         | paid plan; `cancelAtPeriodEnd: true`; `POST /billing/change` answers `409 BILLING_CHANGE_NOT_ALLOWED`      |
| **CANCELED** (Stripe's "deleted" subscription) | Stripe keeps listing the subscription with status `canceled`. With none live, `chooseCanonicalSubscription` keeps the mirrored one, so the mirror row is **retained**: status `CANCELED`, the plan of the price it was on, `SUBSCRIPTION_TERMINATED`, and its leftover `cancelAt`/`cancelAtPeriodEnd`. `User.plan` becomes `FREE`; the paid slot is released. | `plan: FREE` with the ended subscription still described; `canStartCheckout: true`, `canChangePlan: false` |
| **No subscription**                            | Two shapes, both `FREE` with reason `NO_SUBSCRIPTION` and **no mirror row**: no `stripeCustomerId` at all (outcome `NO_CUSTOMER`; a leftover mirror is deleted), or a customer for which Stripe lists no subscription.                                                                                                                                        | `subscription: null`                                                                                       |

Two consequences worth knowing:

- A `CANCELED` mirror keeps `cancelAtPeriodEnd: true` and a `cancelAt` in the past, because Stripe
  keeps `cancel_at` on an ended subscription. The billing page ignores both for a subscription that
  no longer holds the paid slot, and the browser suite asserts it shows no "Cancels on …", no
  renewal date and no cadence for `BILLING_CANCELED`.
- "No subscription" is what an entitlement persona is, and what a billing persona becomes after
  cleanup. It is deliberately not a sixth billing persona: there is no Stripe state to build.

## 3. How a persona's state is produced

```text
the tooling            real Stripe test mode                  the application
-----------            ---------------------                  ---------------
the account row   ->   Test Clock -> customer ->         ->   BillingReconciliationService.reconcileUser
and its customer       subscription -> lifecycle              writes BillingSubscription and User.plan
link
```

**In Stripe.** One Test Clock per persona, one customer on it, one subscription on the persona's
configured catalog price, paid with Stripe's `pm_card_visa` test payment method. Then:

| Lifecycle   | Steps after the first payment                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIVE`    | none                                                                                                                                                                                                |
| `CANCELING` | `cancel_at: "min_period_end"` — the request Customer Portal makes, so the result is in the representation a real customer produces                                                                  |
| `PAST_DUE`  | the subscription's payment method is replaced by `pm_card_chargeCustomerFail` (attaches, then fails every charge) and the clock is advanced past the period end, so Stripe itself fails the renewal |
| `CANCELED`  | the cancellation is scheduled as above and the clock is advanced past the period end, so Stripe itself ends the subscription                                                                        |

Nothing is fabricated: no status is set, no object is edited into a state.

- **Advancing a clock is asynchronous.** The tooling polls until Stripe reports the clock `ready`
  (every 2 s, for up to 5 minutes) before reading anything on it.
- **The boundary is not the moment of failure.** Stripe creates the renewal invoice at the period
  end as a draft, finalises it about an hour later and only then charges. The clock is therefore
  advanced to two hours past the period end, and up to four further hours if the status has not
  arrived; any status other than the wanted one or `active` is a failure, not something to advance
  through.
- **Boundary lifecycles start 35 days in the past**, so a month later is still before today. The
  subscription then reads as one whose renewal failed, or whose paid period ended, a few days ago.
- A clock is frozen once it stops advancing, so every persona is **stable**: an active subscription
  never renews and a scheduled cancellation never arrives, until the fixture is rebuilt.

**In FactorSage.** The tooling writes exactly two things in PostgreSQL, both identity:

1. the persona's `User` row — address, verification, `role = USER`, optionally a password — with
   its Terms acceptance. Never `plan`: a new row takes the column default and an existing row keeps
   whatever reconciliation last gave it;
2. `User.stripeCustomerId`, the link `ai/architecture/billing.md` already prescribes for a Test
   Clock customer, which cannot arrive through Checkout.

Then it calls `BillingReconciliationService.reconcileUser({ trigger: "MANUAL" })` — the same
function, advisory lock and transaction a webhook uses — and compares what was persisted against
the registry's literals. It never writes `BillingSubscription`, never writes `User.plan`, never
calls `changeUserPlan` and never calls `resolveEffectivePlan`;
`billing-persona-boundary.test.ts` reads the source to hold it to that.

**Webhooks.** The customer is linked before its subscription is created. Where a listener is
forwarding the sandbox's events (`scripts/cloud/stack.sh up dev --stripe`, or `stripe listen`
locally), every lifecycle event therefore resolves to the account and is reconciled through the
real webhook path as it happens; the final `reconcileUser` makes the result the same whether or not
a listener was running.

## 4. Commands

```bash
pnpm qa:billing:seed        # make the personas true: Stripe test mode, then reconciliation
pnpm qa:billing:status      # what each one is, in Stripe and in FactorSage; reads only
pnpm qa:billing:cleanup     # remove the fixtures and the billing state; preview, then confirm
```

Options (the `--` is optional, as elsewhere):

```bash
pnpm qa:billing:seed -- --database test             # the hermetic test database, not the dev one
pnpm qa:billing:seed -- --persona starter-past-due  # one persona; repeatable
pnpm qa:billing:status -- --check                   # exit non-zero unless every persona is CONVERGED
pnpm qa:billing:cleanup -- --dry-run                # print what would be removed and stop
pnpm qa:billing:cleanup -- --yes                    # no prompt; required in a non-interactive shell
pnpm qa:billing:cleanup -- --all-tagged             # every fixture this tooling ever created
```

**Which database.** `dev` (the default) is the database `pnpm dev:api` serves — for manual QA
against a stack that has Stripe configured. `test` is `TEST_DATABASE_URL` — what the opt-in
validation suite and the browser suite read. A fixture belongs to one account in one database, so
the same persona seeded into both is two independent fixtures.

**Environment.** Stripe must be configured with a test-mode key (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, the four `STRIPE_PRICE_*`); in a Claude cloud session run the commands
through `scripts/cloud/with-stripe.sh`. One optional variable:

| Variable              | Meaning                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QA_BILLING_PASSWORD` | A password, at least 12 characters, every billing persona can sign in with. Without it the accounts and their billing state are still created; nobody can sign in as them until it is set and the seed is run again. |

`pnpm qa:billing:status` verdicts: `CONVERGED`; `NOT_SEEDED`; `STRIPE_DRIFT` (a fixture exists but
is not the declared state — the seed rebuilds it); `LOCAL_DRIFT` (Stripe is right, the mirror or
plan is not — the seed reconciles it); `STALE_LINK` (the account points at a customer Stripe no
longer has); `AMBIGUOUS` (something claims to be the fixture and is not consistent — needs a
person). It also lists fixtures in the Stripe account that belong to other owners, and anything
that looks like a fixture without being one.

## 5. Safety

Every refusal happens before a Stripe or database client exists.

1. **Test mode only.** The key must _be_ `sk_test_`/`rk_test_` — not merely "not live", so a key of
   any other shape is refused too — and must also be the one `getStripeBillingConfig` judged test
   mode. `StripeTestModeFixtureGateway` cannot be constructed otherwise, and it checks every object
   Stripe returns for `livemode: false` before handing it back. `scripts/cloud/with-stripe.sh` is
   unchanged in what it refuses.
2. **Never production.** `NODE_ENV=production` is refused outright.
3. **A local database, chosen explicitly.** `dev` goes through the same guard as `pnpm qa:seed`;
   `test` requires `TEST_DATABASE_URL` on this machine, naming a database with a `test` segment,
   and not the development one.
4. **The catalog is verified first.** `pnpm qa:billing:seed` runs the same check as
   `pnpm billing:verify-catalog` in-process and creates nothing if it finds a problem.
5. **Only the four configured prices.** The seed resolves a price through `BillingCatalog`, and the
   fixture gateway independently refuses a subscription on any other price id.
6. **The shared catalog cannot be touched.** The fixture gateway has no product or price operation,
   and the one thing it can delete is a Test Clock. There is no "delete this customer" and no
   "cancel this subscription now".
7. **No credential is printed.** Not a key, not a webhook secret, not a password. No card data
   exists in the repository: payment methods are Stripe's two named test tokens. Stripe's own error
   text is passed through a redaction before an operator sees it. Object ids (`cus_`, `sub_`,
   `clock_`) are printed, because an operator needs them to find a fixture in the Dashboard.

### What marks a fixture as this tooling's

The unit of ownership is the **Test Clock**. A clock carries no metadata, so its name states the
ownership, and the customer and the subscription state it again as metadata:

```text
Test Clock name
    factorsage-qa/billing-persona/v1/<PERSONA>/<FactorSage user id>

metadata, on the customer and on the subscription
    factorsage_qa_fixture          billing-persona
    factorsage_qa_fixture_version  1
    factorsage_qa_persona          BILLING_PRO_ACTIVE
    factorsage_qa_owner_user_id    <FactorSage user id>
    factorsage_qa_created_by       pnpm qa:billing:seed
    factorsageUserId               <FactorSage user id>     (the product's own customer tag)
```

A user id is unique to one database, so two databases — or two developers — sharing a sandbox never
collide.

| A Test Clock whose…                                                                                                                                                              | is        | and is…                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------- |
| name is not ours                                                                                                                                                                 | foreign   | never read further, never touched, not reported |
| name is ours, and every customer and subscription on it carries the four ownership tags, agreeing with the name                                                                  | owned     | reused, rebuilt or deleted                      |
| name is ours but anything disagrees: a customer without the tags, a subscription added by hand, a second customer, another format version, an object Stripe reports as live mode | ambiguous | **refused**, named, and left exactly as it is   |

Ownership is decided purely, in `billing-persona-fixtures.ts`, and a fixture is re-read and
re-classified immediately before it is deleted.

## 6. Idempotency and recovery

`pnpm qa:billing:seed` is convergent, not additive.

- **A converged persona is left alone.** If exactly one owned fixture exists and it already is the
  declared state — the configured price, the declared status, the declared cancellation — the run
  makes **no Stripe write**. Reconciliation still runs, so a mirror or a plan changed by hand is
  repaired.
- **Anything else of that persona's is removed first, then rebuilt.** A fixture an interrupted run
  left half-built, one that drifted, two of them: each is found by its name, detached, deleted, and
  one new fixture is built. A lifecycle that stopped part-way is rebuilt from nothing rather than
  nudged forward, because a rebuild has one shape and a repair has many. No number of interrupted
  runs can accumulate customers or subscriptions.
- **A run that stopped while its clock was advancing** is waited for; if the lifecycle arrived, the
  fixture is reused.
- **An expired fixture is replaced.** Stripe deletes a Test Clock, and everything on it, about 30
  days after it was created (`pnpm qa:billing:status` prints the date). The account is then left
  pointing at a customer that no longer exists — `STALE_LINK` — and the next seed builds a new
  fixture and re-points it. Nothing breaks in between: Stripe cancels a deleted customer's
  subscription and goes on listing it, so an account in that state that is reconciled first simply
  becomes `FREE`, with a `CANCELED` mirror.
- **It refuses rather than guesses.** An ambiguous fixture claiming to be the persona's is neither
  reused nor replaced. An account linked to a live Stripe customer the tooling did not create — a
  billing persona somebody took through real Checkout — is not re-pointed.

**Idempotency keys.** Every create and every clock advance carries one:
`factorsage-qa:billing-persona:<persona>:<user id>:<attempt>:<step>`. The `<attempt>` is new for
each build, on purpose: a key stable across builds would make the second build of a persona replay
the first one's responses for the 24 hours Stripe remembers a key, handing back the id of a clock
that has since been deleted. What prevents duplicates across runs is the fixture's name; the key
covers what is left, a retried request inside one build.

## 7. Cleanup

`pnpm qa:billing:cleanup` previews, asks, then:

1. for each fixture in scope, re-proves ownership, clears the account's `stripeCustomerId` and
   reconciles — so the mirror is removed and the plan becomes `FREE` by the application's own path —
   and only then deletes the Test Clock, which takes its customer and subscription with it;
2. clears the link of any billing persona account pointing at a customer Stripe no longer has.

It deletes Test Clocks this tooling created and nothing else. By default the scope is the fixtures
of **this database's** billing persona accounts; `--all-tagged` widens it to every fixture the
tooling created in the Stripe account, which is how to clear what another database, a deleted
account or an interrupted run left. An ambiguous fixture is refused in every scope, the rest is
still removed, and the command exits non-zero.

It does not delete or change: the four catalog prices and their products; any customer,
subscription or clock it did not create; the persona `User` rows, which survive as ordinary `FREE`
accounts so a signed-in browser stays signed in; any other account.

## 8. Claude cloud

Stripe is reachable in a cloud session only through `scripts/cloud/with-stripe.sh`
(`docs/development/claude-cloud-environment.md`). The opt-in for the validation suite,
`STRIPE_BILLING_PERSONAS`, is neutralized for the session like `STRIPE_SANDBOX_SMOKE` and carried
through the wrapper only when given on the command line. Add `QA_BILLING_PASSWORD` to the
environment's variables if the browser suite is to run.

```bash
# 1. Provision and reconcile the billing personas (test database)
scripts/cloud/with-stripe.sh pnpm billing:verify-catalog
scripts/cloud/with-stripe.sh pnpm qa:billing:seed -- --database test

# 2. Inspect them
scripts/cloud/with-stripe.sh pnpm qa:billing:status -- --database test --check

# 3. Run the FactorSage tests
#    a. offline: the tooling against a fake Stripe (also part of `pnpm test`)
pnpm --filter @intrinsic/api exec vitest run src/billing-personas src/billing
#    b. real Stripe test mode: Stripe state, mirror, plan, HTTP status, entitlements, cleanup
STRIPE_BILLING_PERSONAS=true scripts/cloud/with-stripe.sh pnpm test:billing:personas
#    c. the browser, on the hermetic stack (no Stripe in it)
scripts/cloud/stack.sh up e2e
pnpm test:e2e:billing:personas
scripts/cloud/stack.sh down

# 4. Remove only the tagged Stripe test fixtures
scripts/cloud/with-stripe.sh pnpm qa:billing:cleanup -- --database test --dry-run
scripts/cloud/with-stripe.sh pnpm qa:billing:cleanup -- --database test --yes
```

For manual QA against a Stripe-connected stack, drop `--database test`: seed into the development
database, then `scripts/cloud/stack.sh up dev --stripe`.

## 9. Tests

| Suite                                                                            | Stripe           | What it proves                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `billing-personas/billing-persona-registry.test.ts`                              | none             | The five definitions, as literals; that every expectation is what `resolveEffectivePlan` produces; all four prices covered; separate from the entitlement personas.                                                                                                                                      |
| `billing-personas/billing-persona-fixtures.test.ts`                              | none             | The ownership rules: clock name format, metadata, owned / foreign / ambiguous, convergence in both of Stripe's cancellation representations, and what a cleanup may delete in each scope.                                                                                                                |
| `billing-personas/billing-persona-environment.test.ts`                           | none             | Every refusal: live and malformed keys, production, non-local and non-test databases, the password policy, unknown arguments.                                                                                                                                                                            |
| `billing-personas/billing-persona-boundary.test.ts`                              | none             | Read from the source: the tooling writes no mirror and no plan; the Stripe SDK is imported by one file; nothing can change the catalog or delete anything but a Test Clock; the entitlement personas do not depend on Stripe.                                                                            |
| `billing-personas/billing-persona-tooling.integration.test.ts`                   | fake             | Real PostgreSQL and the real reconciliation service. Each persona end to end; a rerun writes nothing to Stripe; an interrupted run leaves no duplicate; drift and tampering are repaired; clocks are polled; every refusal; cleanup scope, dry run and the re-check before a delete.                     |
| `billing/stripe-fixture-gateway.test.ts`, `billing/catalog-verification.test.ts` | none             | The fixture gateway cannot be constructed with a live key or used on a price outside the catalog; credentials are redacted; the catalog check.                                                                                                                                                           |
| `billing-personas/billing-personas.sandbox.test.ts`                              | **real**         | Opt-in (`STRIPE_BILLING_PERSONAS=true`), excluded from `pnpm test`. Per persona: Stripe status, catalog price, cancellation representation, tags, mirror, `User.plan`, `GET /billing/status`, `GET /entitlements`, and that a second run reuses the fixture. Then a real cleanup of a throwaway fixture. |
| `apps/web/e2e/billing-personas/` (`pnpm test:e2e:billing:personas`)              | none at run time | The billing page for each real state, on the hermetic stack, with no request to Stripe from the browser or the stack.                                                                                                                                                                                    |

`FakeStripeFixtureGateway` is built on the existing `FakeStripeGateway`, so a subscription the
tooling "creates" offline is read by the real reconciler through the product's own fake.

`pnpm test:e2e` is unaffected: `playwright.config.ts` has no project matching
`*.billing-persona.spec.ts`, and its `setup` project signs in the entitlement personas only.

## 10. Verified against the Stripe sandbox

Local FactorSage sandbox (test mode), 2026-10-10, pinned API version `2026-08-26.dahlia`.

| Persona                    | Stripe, observed                                                       | FactorSage, observed                                                                |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `BILLING_STARTER_ACTIVE`   | `active` on the Starter yearly price                                   | mirror `ACTIVE` `STARTER`/`YEAR`, `SUBSCRIPTION_ACTIVE`; plan `STARTER`             |
| `BILLING_PRO_ACTIVE`       | `active` on the Pro monthly price                                      | mirror `ACTIVE` `PRO`/`MONTH`; plan `PRO`                                           |
| `BILLING_PRO_CANCELING`    | `active`; `cancel_at` = the period end, `cancel_at_period_end: false`  | mirror `ACTIVE`, `cancelAtPeriodEnd: true`, `cancelAt` = the period end; plan `PRO` |
| `BILLING_STARTER_PAST_DUE` | `past_due` after one advance to two hours past the period end          | mirror `PAST_DUE`, `SUBSCRIPTION_IN_RECOVERY`; plan `STARTER`                       |
| `BILLING_CANCELED`         | `canceled` after one advance past the period end; `cancel_at` retained | mirror **kept**: `CANCELED` `PRO`/`MONTH`, `SUBSCRIPTION_TERMINATED`; plan `FREE`   |

Also observed: a Test Clock may be created with a frozen time in the past; deleting a clock deletes
its customer and cancels its subscription, which Stripe goes on listing as `canceled` under the
deleted customer's id; a clock's `deletes_after` is 30 days after its creation. A first seed of all
five takes about 45 seconds, a converged rerun under ten.

## 11. Where the code is

| Piece                                                        | File                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| The persona registry                                         | `packages/testing/src/billing-personas.ts`                                         |
| Ownership rules, convergence, cleanup planning (pure)        | `apps/api/src/billing-personas/billing-persona-fixtures.ts`                        |
| Seed, status, cleanup                                        | `apps/api/src/billing-personas/billing-persona-tooling.ts`                         |
| Which Stripe key and which database are allowed              | `apps/api/src/billing-personas/billing-persona-environment.ts`                     |
| The three commands                                           | `apps/api/src/qa-billing-personas-{seed,status,cleanup}.ts`                        |
| The fixture operations, as FactorSage types                  | `apps/api/src/billing/stripe-fixture-gateway.ts`                                   |
| Their Stripe implementation (the one file importing the SDK) | `StripeTestModeFixtureGateway` in `apps/api/src/billing/stripe.gateway.ts`         |
| Their fake, built on the product's fake gateway              | `apps/api/src/billing/stripe-fixture-gateway.test-helper.ts`                       |
| The catalog check shared with `pnpm billing:verify-catalog`  | `apps/api/src/billing/catalog-verification.ts`                                     |
| The browser suite                                            | `apps/web/playwright.billing-personas.config.ts`, `apps/web/e2e/billing-personas/` |

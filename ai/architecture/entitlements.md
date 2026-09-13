# Entitlements Architecture

`docs/decisions/entitlements-v1.md` is the product decision. This document is how it is
implemented; it does not restate or reinterpret the rules, and where the two could disagree the
decision document wins.

## The shape of it

```text
request
  -> authentication / session resolution        CookieAuthGuard | OptionalCookieAuthGuard
  -> principal                                  GUEST | { userId, plan, role } from PostgreSQL
  -> central resolver                           resolveEntitlements()  (@intrinsic/contracts)
  -> semantic guard at the mutation boundary    EntitlementsService.assert*
  -> business logic
```

Three properties hold that together:

1. **One definition.** `packages/contracts/src/entitlements.ts` holds every capability and limit,
   the resolver, the reason codes, the pure assertions and the derived-compliance helpers. Nothing
   anywhere compares a plan. Feature code asks `entitlements.backtests.maxSymbols`, never
   `plan === "PRO"`.
2. **One trusted source for plan and role.** Both are columns on `User`. `CookieAuthGuard` reloads
   them on every request, so `AuthUser` is server state rather than client input; the transactional
   guards re-read them again inside the caller's transaction.
3. **One mapping onto HTTP.** `EntitlementExceptionFilter` is registered globally by
   `EntitlementsModule`, so a refusal thrown from any service becomes the same response everywhere,
   and a new enforcement point cannot forget to map it.

Why `@intrinsic/contracts` rather than `@intrinsic/domain`: the browser may depend only on
`contracts`, the matrix has to be readable by the API, both worker kinds *and* the UI, and the
repository already keeps shared product bounds there (`BACKTEST_MAX_PERIOD_YEARS`,
`STOCK_LIST_MAX_SECURITIES_PER_ADD`). The module is pure — no I/O, no clock, no `process.env`.

## Persistence

`User.plan` is `FREE | STARTER | PRO`, non-null, defaulted to `FREE`
(`20260912190000_add_user_plan`). `User.role` is unchanged. `GUEST` is not a value and never
becomes one: it is derived from the absence of a session, so there is no anonymous row, no
temporary account and nothing to clean up.

Compliance is never persisted. A list's compliance and a Monitor's operational status are derived
on every read from current entitlements and current resource state, because a stored flag is
correct only until either side moves and then is silently wrong.

## Enforcement points

| Boundary | Guard |
| --- | --- |
| `POST /lists` | `assertCanCreateCustomList`, `assertListSymbolLimit` |
| `POST /lists/:id/items` | `assertListSymbolLimitIn` — transactional, inside the list row lock |
| `POST /strategies` | `assertCanCreateCustomStrategy` |
| `POST /backtests` | `assertCanRunLiveBacktest`, `assertBacktestHistoricalDepth`, `assertBacktestSymbolLimit`, `assertBacktestConcurrency` (transactional) |
| `POST /monitors`, `PATCH /monitors/:id` | `assertCanEnableMonitor` — transactional |
| backtest worker claim | `PrismaBacktestJobRepository.claimNextJob` |
| Monitor cycle | `PrismaMonitorRepository.listActiveMonitors` |

Reads are never refused for exceeding a plan. Renames, removals and every corrective mutation stay
open, because a downgrade must leave the user able to fix the violation.

Everything that would persist user-owned content or start live execution already sits behind
`CookieAuthGuard`, so a Guest is refused with `401` before any entitlement is consulted.

## Atomicity

Three limits are counted before a write and can therefore be raced: concurrent runs, active
Monitors and list membership. Each is decided inside the transaction that performs the write, and
each takes the caller's advisory lock first — `lockUserEntitlementScope` in `@intrinsic/database`,
so the API and both worker kinds serialize on the same key. Without it two simultaneous
submissions both read the same count, both pass, and a plan that runs one backtest runs two.

**Acquisition order is a rule, not an accident.** The entitlement lock is taken *first*, before any
row lock the transaction needs. Every writer that touches a capacity-controlled resource then
acquires in the same order — a list add that locked its `StockList` row first and reached for the
entitlement lock second would deadlock against a backtest submission, which holds the entitlement
lock and then takes the foreign-key share lock any insert referencing that list requires. Because
the per-user lock is already the serialization, none of these paths needs a row lock on the list
on top of it.

The backtest claim is the one place several owners' locks can be held at once. It waits for the
first owner it considers and never waits for any after it, so no transaction ever blocks while
already holding one of these locks — which is what makes the loop deadlock-free while still
letting a plan's full capacity be used when two workers poll in the same millisecond.

## Monitors: intent versus eligibility

`Monitor.enabled` is the user's intent and is never rewritten by a plan change. Execution
eligibility is derived per cycle by `resolveMonitorEligibility`: the first `maxActive` enabled
Monitors by `(createdAt, id)` hold the plan's slots, and a slot-holder whose List exceeds the
plan's symbol limit keeps its slot but cannot scan. The API projects the same function into
`operationalStatus` / `blockedReason`, so what the worker executes and what the user is shown
cannot disagree.

## The billing boundary

`apps/api/src/entitlements/user-plan.ts` is the only writer of `User.plan`, and no route reaches
it. The billing adapter maps provider price ids onto `UserPlan` at its own edge and calls
`changeUserPlan`; nothing downstream knows a biller exists, which is why entitlements work with no
billing configured. The role is never touched there.

That adapter is now built — Stripe Billing V1, documented in `billing.md`.
`BillingReconciliationService` is its single caller. Two of its properties matter from this side.

It takes **this** lock: `lockUserEntitlementScope`, the same per-user key every capacity check takes,
not a billing-specific one. A plan change and a list add that counts against that plan genuinely must
serialize, and reusing the key keeps the acquisition order above intact, so reconciliation cannot
deadlock against a backtest submission. It also means the `User.plan` write and the
`BillingSubscription` row justifying it commit together: the plan and the evidence for it can never
disagree.

And it is strictly one-directional. `resolveEntitlements` takes a plan and a role and nothing else —
no Stripe call, no subscription lookup, no billing state in any authorization answer.
`packages/contracts/src/billing.entitlements-boundary.test.ts` asserts both halves: that billing holds
no entitlement value or vocabulary, and that `entitlements.ts` imports nothing from `billing.ts`.

## Rate limiting is not here

Entitlements answer whether an identity may perform a class of operation and within what product
limits. How often an already-permitted caller may call is a separate mechanism, and this
repository has no HTTP rate limiter yet — only the outbound FMP provider gate, which throttles this
system's calls to a vendor, not callers. No request-rate value is invented here.
`packages/contracts/src/entitlements.rate-limiting-boundary.test.ts` is what keeps the two apart:
it asserts the entitlement surface carries no rate, throttle, quota or window concept, that plans
differ only in product capacity, and that the module has no dependency that could reach a request
or a counter.

## Tests

- `packages/contracts/src/entitlements.test.ts` — the matrix, number by number, plus the derived
  helpers. Values are written as literals so the suite cannot agree with a wrong implementation.
- `packages/contracts/src/entitlements.rate-limiting-boundary.test.ts` — the separation above.
- `apps/api/src/entitlements/entitlements.integration.test.ts` — HTTP through to PostgreSQL: every
  limit, guest behaviour, role escalation attempts, the concurrency race, and the downgrade rules.
- `apps/worker/src/backtest/claim-entitlements.integration.test.ts` — concurrency at the claim.
- `apps/worker/src/monitor/monitor-eligibility.integration.test.ts` — what a cycle may evaluate.
- `apps/web/e2e/entitlements/*.spec.ts` — the browser half: that a refusal reaches the user as
  something they can act on, and that the UI reflects backend enforcement rather than deciding
  anything. It deliberately does not re-prove the numeric matrix.

## Test personas

Entitlement behaviour is per-plan, so it is tested by signing in *as* a plan rather than by moving
one user between plans — which would make every test order-dependent and every parallel run a race.

`packages/testing/src/personas.ts` is the one definition: five accounts (`FREE_USER`,
`STARTER_USER`, `PRO_USER`, `ADMIN_USER`, `DOWNGRADED_USER`) with their plan, role, credential
variable prefix and Playwright storage-state path. `GUEST` is not in it, because it is not an
account. The seeders and the Playwright projects both read that table; the browser harness imports
it through the dependency-free `@intrinsic/testing/personas` subpath, so no engine or database code
reaches the web app.

`PRO_USER` is the default development and manual-testing account. `ADMIN_USER` is `plan=FREE`,
`role=ADMIN` — internal and QA only, never the development default, because developing against
entitlement overrides hides commercial capacity bugs.

Two seeds, both idempotent, and both reconciling so rerunning one is also the reset:

```bash
pnpm test:users:seed          # the personas
pnpm test:entitlements:seed   # the fixtures below
pnpm test:personas:seed       # all of it, in order
```

`apps/api/src/entitlements/seed-entitlement-fixtures.ts` declares the fixture state per persona:
boundary states reachable through the UI (a list exactly at its limit, an account at its monitor
capacity, a run pinned mid-flight) and **post-downgrade states that are not** — an 83-symbol list on
FREE, a completed twenty-year backtest, four monitors where one may be active. The second kind is
the whole reason a fixture exists rather than a click-through: a user reaches it by having been on
a higher plan. Everything it owns is named `ENT-`, and nothing outside that namespace is touched.

A run is pinned "in flight" by giving its job a `CLAIMED` status and a lease far in the future: the
real worker will neither claim it (not `QUEUED`) nor recover it (lease live), so "one run already
running" is a state rather than a race against a worker that might finish first.

## The QA matrix

The developer QA validation matrix submits through the real enforced path and therefore needs an
owner whose entitlements permit a thousand-case sweep. Its fixtures are owned by the `QA_ADMIN`
persona, and the preflight refuses a sweep whose configured concurrency the owner's plan does not
allow. See `../../docs/development/qa-matrix-fixtures.md`.

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
it. A future billing adapter maps provider price ids onto `UserPlan` at its own edge and calls
`changeUserPlan`; nothing downstream knows a biller exists, which is why entitlements work with no
billing configured. The role is never touched there.

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

## The QA matrix

The developer QA validation matrix submits through the real enforced path and therefore needs an
owner whose entitlements permit a thousand-case sweep. Its fixtures are owned by the `QA_ADMIN`
persona, and the preflight refuses a sweep whose configured concurrency the owner's plan does not
allow. See `../../docs/development/qa-matrix-fixtures.md`.

# Entitlements V1

Status: accepted product decision for V1 implementation

This document is the source of truth for FactorSage V1 commercial entitlements. Entitlements are an application-domain concern. Billing providers such as Stripe may change a user's commercial plan, but Stripe must not define application permissions or limits.

## 1. Core model

### Commercial plans

Persisted plans for authenticated users:

- `FREE`
- `STARTER`
- `PRO`

`GUEST` is **not** a persisted user plan and does not require an anonymous User row. It is a derived access state:

```text
no authenticated session => GUEST entitlements
```

There is no `PRO_PLUS` in V1. A possible future Pro+ tier is out of scope.

### Internal roles

Authorization roles are separate from commercial plans:

- `USER`
- `ADMIN`

A user may therefore be, for example, `plan=FREE` and `role=ADMIN`.

`ADMIN` must never be represented as a commercial plan and must never be controlled by Stripe. Admin access is resolved server-side from trusted persisted role data.

Admin-specific permissions should be expressed through explicit `ADMIN_ENTITLEMENTS` / admin authorization checks rather than scattered unconditional bypasses.

## 2. Pricing

V1 pricing:

| Plan | Monthly | Annual |
| --- | ---: | ---: |
| Free | $0 | $0 |
| Starter | $9 | $99 |
| Pro | $29 | $299 |

V1 explicitly has:

- no credits system;
- no launch trial;
- no daily backtest run cap.

## 3. Entitlement matrix

| Capability / limit | Guest | Free | Starter | Pro |
| --- | ---: | ---: | ---: | ---: |
| Stock search | Yes | Yes | Yes | Yes |
| Stock details | Yes | Yes | Yes | Yes |
| Stock Details historical data | Full | Full | Full | Full |
| View built-in Lists | Yes | Yes | Yes | Yes |
| View built-in Strategies | Yes | Yes | Yes | Yes |
| Create custom Lists | No | Yes | Yes | Yes |
| Saved custom List count | 0 | Unlimited | Unlimited | Unlimited |
| Symbols per custom List | N/A | 10 | 50 | 100 |
| Create custom Strategies | No | Yes | Yes | Yes |
| Saved custom Strategy count | 0 | Unlimited | Unlimited | Unlimited |
| Indicators / conditions / triggers available in Strategy Builder | Built-in content only | All | All | All |
| Run live Backtests | No | Yes | Yes | Yes |
| Demo/precomputed Backtests | Yes | Yes | Yes | Yes |
| Symbols per live Backtest | N/A | 10 | 50 | 100 |
| Backtest historical depth | N/A | 5 years | 15 years | 30 years |
| Concurrent live Backtests | 0 | 1 | 1 | 2 |
| Active Monitors | 0 | 1 | 3 | 10 |

There is no commercial restriction on which indicator, condition, trigger, calculated series, or intrinsic-value primitive an authenticated user may use. Monetization is based on product capacity, not on locking analytical primitives behind higher tiers.

## 4. Guest behavior

Guest access is stateless with respect to application users:

- do not create anonymous User rows;
- do not create temporary guest accounts;
- do not require account cleanup or guest-account merging;
- derive Guest entitlements from the absence of an authenticated session.

Guests may:

- search stocks;
- view stock details;
- access system built-in Lists;
- access system built-in Strategies;
- view demo Backtests that are precomputed/static.

Guests may not:

- create or persist custom Lists;
- create or persist custom Strategies;
- run live Backtests;
- create or enable Monitors;
- persist user-owned content that requires an account.

A Guest attempting an authenticated-only operation should be rejected by entitlement/authentication enforcement before expensive business logic executes.

## 5. Lists

### Ownership and count

Free, Starter, and Pro users may create an unlimited number of custom Lists. There is no commercial quota on the number of saved Lists.

### Symbol capacity

The maximum membership of a custom List is:

- Free: 10 symbols
- Starter: 50 symbols
- Pro: 100 symbols

Built-in Lists are system content and are not counted against a user's custom content.

The limit must be enforced server-side on mutations that would increase List membership.

## 6. Strategies

Free, Starter, and Pro users may create an unlimited number of custom Strategies. There is no commercial quota on the number of saved Strategies.

All authenticated tiers have access to all supported Strategy Builder analytical primitives, including indicators, conditions, triggers, calculated series, and intrinsic-value features. Do not implement tier checks such as `plan === PRO` around individual analytical primitives.

Built-in Strategies are system content and remain available independently of custom Strategy ownership.

## 7. Backtests

### Guest

Guests may only consume precomputed/static demo Backtests. They may not initiate live Backtest execution.

### Symbol limits

Maximum symbols in a live Backtest:

- Free: 10
- Starter: 50
- Pro: 100

### Historical depth

Maximum requested Backtest history:

- Free: 5 years
- Starter: 15 years
- Pro: 30 years

This restriction applies to Backtest execution only. Stock Details historical visibility remains full for all plans, including Guest.

### Concurrency

Maximum simultaneously executing live Backtests:

- Free: 1
- Starter: 1
- Pro: 2

There is no daily Backtest-count quota in V1.

Concurrency must be enforced atomically on the server/worker side; it must not rely only on UI state.

## 8. Monitors

Maximum active/enabled Monitor capacity:

- Guest: 0
- Free: 1
- Starter: 3
- Pro: 10

There is no separate per-Monitor symbol quota in V1. A Monitor inherits the compliance of its referenced List. If the List is over the current plan's List symbol limit, the Monitor cannot execute.

Monitor configuration intent and execution eligibility are separate concepts:

```text
enabled = user's persisted intent
execution eligibility = derived from entitlements + referenced resource compliance
```

A Monitor must not be silently deleted or have `enabled=false` persisted merely because a plan changed.

Recommended derived operational statuses include at least:

- `ACTIVE`
- `DISABLED`
- `BLOCKED_BY_ENTITLEMENT`

### Active-Monitor overage after downgrade

If a downgrade leaves more enabled Monitors than the new plan allows:

- preserve every Monitor;
- preserve every Monitor's persisted `enabled` value;
- do not delete Monitors;
- only the first `N` enabled Monitors are execution-eligible, where `N` is the plan's active Monitor limit;
- use a stable deterministic order (`createdAt`, then `id`) so behavior is reproducible;
- remaining enabled Monitors resolve to `BLOCKED_BY_ENTITLEMENT`;
- if an execution-eligible Monitor is disabled/deleted or the user upgrades, eligibility is recalculated and previously blocked Monitors can resume automatically.

This rule preserves user intent while still enforcing the commercial capacity limit.

## 9. Downgrades and grandfathered resources

Plan changes become effective when the commercial plan actually changes. For a paid subscription cancelled at period end, paid entitlements remain in effect until the paid period ends; pressing "cancel" must not immediately downgrade application access.

When a downgrade becomes effective, existing user content is never truncated or deleted solely because it exceeds the new plan.

General rule:

```text
existing over-limit content remains readable and preservable,
but new operations must comply with current entitlements
```

### Oversized Lists

Example: a Pro user has a List with 83 symbols and becomes Free (limit 10).

The List remains intact and readable. Its compliance is derived as over-limit.

Allowed:

- view the List;
- rename it;
- remove symbols;
- make changes that reduce the violation.

Not allowed:

- add symbols;
- perform membership mutations that increase the violation;
- use it for an operation whose current-plan entitlement requires List compliance.

Compliance should normally be derived from current entitlements and current resource state rather than persisted as a one-time boolean that can become stale.

### Existing Backtests

Completed Backtest runs and their historical results remain readable after downgrade even if their original configuration exceeds the new plan.

Re-running or starting a new Backtest must validate the configuration against the user's current plan, including symbol count, historical depth, and concurrency.

### Monitors after downgrade

A Monitor that references an oversized List remains stored and retains its `enabled` intent, but resolves to `BLOCKED_BY_ENTITLEMENT` and must not scan until the List becomes compliant or the user upgrades.

Monitor-count overage follows the deterministic active-Monitor rule in Section 8.

## 10. Entitlements versus rate limiting

Rate limiting and entitlements are separate mechanisms.

Entitlements answer:

> Is this identity/plan allowed to perform this class of operation, and within what product limits?

Rate limiting answers:

> Is this allowed caller making requests too frequently or abusively?

Do not model request rate as a commercial entitlement in V1.

For public Guest endpoints, rate limiting should primarily use caller IP. For authenticated endpoints, prefer user identity as the principal rate-limit key, with IP/device/network signals available as abuse-defense inputs when useful.

Conceptually:

```text
Request
  -> authentication/session resolution
  -> resolve role + commercial entitlements
  -> capability/resource-limit enforcement
  -> rate-limit / abuse protection where applicable
  -> business logic
```

An operation forbidden by entitlements should be rejected before expensive downstream work.

Public endpoints that can trigger external market-data calls or meaningful computation should use stricter rate-limit policies than cheap/read-only endpoints. Exact request-rate numbers are operational configuration, not part of the commercial entitlement matrix.

## 11. Stripe boundary

Stripe is not the authorization engine.

The intended direction is:

```text
Stripe subscription state
  -> internal persisted plan (FREE / STARTER / PRO)
  -> central entitlement resolver
  -> application guards and resource-limit checks
```

Stripe price/product IDs must map to internal plans at the billing boundary. Application services must not ask Stripe directly whether a feature is allowed.

Cancelling, renewing, upgrading, downgrading, webhook retry behavior, and billing-period timing may update the persisted plan/subscription state, but entitlement values live in application code/config as the source of truth.

`ADMIN` role is never assigned or removed by Stripe.

## 12. Implementation architecture requirements

The implementation should provide one central entitlement definition/resolver instead of scattering plan checks throughout the codebase.

Avoid application code like:

```ts
if (user.plan === "PRO") {
  // feature behavior
}
```

Prefer semantic capabilities and limits, for example:

```ts
entitlements.lists.canCreateCustom
entitlements.lists.maxSymbols
entitlements.strategies.canCreateCustom
entitlements.backtests.canRunLive
entitlements.backtests.maxSymbols
entitlements.backtests.maxHistoricalYears
entitlements.backtests.maxConcurrentRuns
entitlements.monitors.maxActive
```

And semantic enforcement functions such as:

```ts
assertCanCreateCustomList(...)
assertListSymbolLimit(...)
assertCanCreateCustomStrategy(...)
assertCanRunLiveBacktest(...)
assertBacktestSymbolLimit(...)
assertBacktestHistoricalDepth(...)
assertBacktestConcurrency(...)
assertCanEnableMonitor(...)
getListCompliance(...)
getMonitorExecutionEligibility(...)
```

The exact module layout should follow existing repository conventions discovered during implementation rather than introducing a parallel architecture unnecessarily.

## 13. Enforcement requirements

Entitlements are security/business invariants and must be enforced server-side at the canonical mutation/execution boundary.

UI checks are convenience only. The UI may later consume entitlement information to hide, disable, annotate, or upsell features, but a forged/direct API request must not bypass limits.

Enforcement must cover all canonical paths, including direct API calls, server actions, worker claims/execution, retry/re-run paths, and any internal mutation path that can change a quota-controlled resource.

Do not duplicate authoritative checks in multiple layers when one canonical domain/service boundary can enforce them safely.

## 14. Error semantics

Entitlement failures should be distinguishable from authentication, validation, conflict, and infrastructure failures.

Errors should carry machine-readable reason codes suitable for future UI mapping. Examples:

- `ENTITLEMENT_AUTH_REQUIRED`
- `ENTITLEMENT_FEATURE_UNAVAILABLE`
- `ENTITLEMENT_LIST_SYMBOL_LIMIT`
- `ENTITLEMENT_BACKTEST_SYMBOL_LIMIT`
- `ENTITLEMENT_BACKTEST_HISTORY_LIMIT`
- `ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT`
- `ENTITLEMENT_MONITOR_LIMIT`
- `ENTITLEMENT_RESOURCE_OVER_LIMIT`

Messages may include current usage and allowed values, but server logic must not depend on presentation strings.

## 15. Testing requirements

The implementation is not complete with only a static matrix. Tests must prove enforcement behavior.

At minimum cover:

1. Guest resolves without creating a User row.
2. Guest can use permitted public read paths but cannot persist custom content or run live Backtests/Monitors.
3. Free / Starter / Pro List symbol limits are exactly 10 / 50 / 100.
4. Custom List and Strategy counts are unlimited for authenticated tiers.
5. All authenticated tiers can use all Strategy analytical primitives.
6. Live Backtest symbol limits are exactly 10 / 50 / 100.
7. Backtest historical limits are exactly 5 / 15 / 30 years.
8. Concurrent Backtest limits are exactly 1 / 1 / 2.
9. Active Monitor limits are exactly 1 / 3 / 10.
10. Monitor execution is blocked when its List is over the current plan's symbol limit.
11. Downgrading never deletes/truncates oversized Lists, Strategies, Backtest results, or Monitors.
12. Existing completed Backtests remain readable after downgrade but cannot be rerun with a now-invalid configuration.
13. Oversized Lists allow corrective removals but reject additions/increasing violations.
14. Monitor `enabled` intent survives downgrade while execution eligibility can become blocked.
15. Monitor-count overage is resolved deterministically and resumes correctly when capacity becomes available.
16. Admin role is separate from plan and cannot be supplied/trusted from client input.
17. Canonical backend paths reject entitlement violations even when UI checks are bypassed.
18. Rate limiting remains independently testable from entitlement authorization.

## 16. Explicitly out of scope for this entitlement implementation

Do not add the following as part of V1 entitlements unless required only as a thin integration seam:

- Stripe Checkout / Customer Portal UI;
- Stripe webhook implementation;
- pricing-page redesign;
- broad Monitor UI redesign;
- Pro+;
- credits;
- launch trial;
- daily Backtest run quotas;
- per-indicator or per-condition paywalls;
- a separate per-Monitor symbol quota;
- destructive downgrade migrations.

The entitlement implementation should be independently usable before Stripe is connected. Stripe integration should later map billing state into the already-defined internal plan model.

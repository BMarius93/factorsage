# Entitlements V2 — the final subscription model

## Status

**Proposed for owner approval — 2026-10-23.** Implements the owner's final subscription
specification (Free, Starter, Pro, Pro+). Until it is approved and merged, `entitlements-v1.md`
remains the description of what is deployed. Once merged, this document **supersedes**
`entitlements-v1.md` §1 (plans), §2 (pricing), §3 (matrix), §4 and §7 (Guest Backtest boundary),
§7 (symbol, depth and concurrency limits) and §8 (Monitor capacity). Every other section of V1 —
the core model, downgrade semantics, the rate-limiting boundary, the Stripe boundary,
implementation, enforcement and error semantics — stands unchanged and is restated here only where
V2 adds to it.

`packages/contracts/src/entitlements.ts` (`PLAN_ENTITLEMENTS`) is the one executable definition;
`packages/contracts/src/billing.ts` (`BILLING_CATALOG`) is the one price list. Nothing else may
restate a number from either. Decisions marked **Owner decision** in §11 were taken during
implementation and need explicit confirmation.

## 1. Plans

Persisted plans: `FREE`, `STARTER`, `PRO`, `PRO_PLUS` (`UserPlan`; PostgreSQL enum value
`PRO_PLUS`, migration `20261024120000_pro_plus_plan_and_premium_builtins`). Plan and role stay
orthogonal; `GUEST` is still derived from the absence of a session and never creates a row. Plan
rank for billing transitions: FREE 0 < STARTER 1 < PRO 2 < PRO_PLUS 3.

## 2. Pricing

| Plan    | Monthly |
| ------- | ------: |
| Free    |      $0 |
| Starter |     $19 |
| Pro     |     $49 |
| Pro+    |    $199 |

The catalog is **monthly only**: logical price keys `STARTER_MONTHLY`, `PRO_MONTHLY`,
`PRO_PLUS_MONTHLY` (`STRIPE_PRICE_STARTER_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY`,
`STRIPE_PRICE_PRO_PLUS_MONTHLY`). The V1 yearly keys are retired: a deployment that still sets
`STRIPE_PRICE_STARTER_YEARLY` or `STRIPE_PRICE_PRO_YEARLY` refuses to start, so a stale price can
never be sold. Still no credits, trials, top-ups or daily run caps.

**Existing subscribers are grandfathered.** A subscriber billed on a V1 price ($9 / $29 monthly,
$99 / $299 yearly) keeps that plan at that price for as long as the subscription lasts, provided the
price is listed in `STRIPE_LEGACY_PRICES` (`price_…=PLAN/INTERVAL`); an unlisted one fails closed to
Free, as any unknown price does. A listed price is never sold. Moving from it is classified as from
the plan's current price: a higher tier is an immediate upgrade onto today's price, a lower tier is a
period-end downgrade, and the same plan is no change. Migrating grandfathered subscribers to the V2
prices is a Stripe-side price migration the owner may choose to run; nothing here does it.

## 3. Matrix

| Capability / limit                                       | Guest            |      Free |   Starter |         Pro |        Pro+ |
| -------------------------------------------------------- | ---------------- | --------: | --------: | ----------: | ----------: |
| Stock search, Stock Details (full history)               | Yes              |       Yes |       Yes |         Yes |         Yes |
| Read standard built-in Lists and Strategies              | Yes              |       Yes |       Yes |         Yes |         Yes |
| Demonstration backtests (precomputed, §4)                | Yes              |       Yes |       Yes |         Yes |         Yes |
| Custom Lists / Strategies (saved count)                  | No               | Unlimited | Unlimited |   Unlimited |   Unlimited |
| Symbols per List (`lists.maxSymbols`)                    | —                |        10 |        50 |         750 |       1,000 |
| Symbols per live Backtest (`backtests.maxSymbols`)       | —                |        10 |        50 |         750 |       1,000 |
| Full Strategy Builder, ETF and sector conditions         | Built-ins only   |       Yes |       Yes |         Yes |         Yes |
| Live Backtests (total)                                   | No               | Unlimited | Unlimited |   Unlimited |   Unlimited |
| Backtest period length (`backtests.maxHistoricalYears`)  | —                |  30 years |  30 years |    30 years |    30 years |
| Concurrent live Backtests per user                       | 0                |         1 |         1 |           1 |           2 |
| Active Monitors (`monitors.maxActive`)                   | 0                |         1 |         5 | Unlimited\* | Unlimited\* |
| Premium built-ins and point-in-time universes            | Names only       |        No |        No |         Yes |         Yes |
| S&P 500 Historical PIT: simultaneous members per run     | —                |         0 |         0 |         750 |       1,000 |

\* **Unlimited active monitors means no advertised numerical subscription cap, not unlimited
physical infrastructure.** A fair-use safeguard (§7) protects the shared end-of-day pass; it is not a
plan limit, is never shown as a plan number, and applies identically to every plan.

The 30-year window is **subject to data availability**: a security listed later, or a series whose
provider history starts later, yields a shorter simulated span. The limit is on the length of the
requested period; any plan may start thirty years back.

## 4. Guests and demonstration backtests

Supersedes V1's 2026-09-19 boundary, at the owner's request: Guests get read-only public access
**and precomputed demonstration backtests**, and still never trigger a computation.

- A demonstration is an operator-featured **shared report** (`docs/decisions/backtest-sharing-v1.md`):
  a completed run's allowlisted results, precomputed and stored. `DemoBacktest` rows (keyed by the
  share, cascade on revocation) name which shared reports are featured, with a title, a description
  and an order. `GET /demo-backtests` lists at most 12, publicly, `no-store`; the web shelf is
  `/demo-backtests`, linked from the Guest topbar.
- Reading the shelf or a report executes nothing — no job, no hydration, no provider request
  (`backtest-sharing.integration.test.ts`, "the demonstration shelf").
- Curation is an operator action: `pnpm --filter @intrinsic/api demo-backtests -- feature --run …`.
  A demo publishes exactly what its link publishes; feature only runs whose owner agreed (an
  operator's own runs are the expected source).
- `backtests.canViewDemo` is now `true` for Guests; `canRunLive` stays `false`. Every `/backtests`
  route, configuration and trade log still requires a session.

## 5. Concurrency, the global cap and fairness

Per-user concurrency (1/1/1/2) is enforced at submission (in flight: QUEUED or executing) under the
per-user entitlement lock, exactly as V1 required. V2 adds a **deployment-wide** execution cap and a
durable queue; `ai/architecture/backtest-execution.md` ("Global admission", "Cancellation") is the
implementation:

- At most `BACKTEST_GLOBAL_MAX_RUNNING` (production: **4**) backtests execute at once across the
  whole deployment, however many worker processes or hosts exist. Enforced inside the claim, under a
  PostgreSQL transaction-scoped advisory lock, so concurrent claims from any number of processes can
  never exceed it; a lapsed lease frees its slot through the existing stale recovery.
- The queue is bounded (`BACKTEST_QUEUE_MAX_QUEUED`, default 100): a submission beyond it is refused
  with `503 BACKTEST_QUEUE_FULL` and `Retry-After`, creating nothing.
- **Fair, not paid, scheduling.** The claim orders waiting runs by how many runs their owner already
  executes, then by queue time — a Pro+ user's second run waits behind every other user's first.
  No plan buys priority, speed, a reserved slot or a completion time, and no surface may say so.
- **Pro+'s two runs may execute simultaneously** when global capacity allows; they never take more
  than two of the four slots, and only when nobody with fewer running runs is waiting.
- Owners may cancel (`POST /backtests/{runId}/cancel`): a queued run is cancelled at once and frees
  the owner's concurrency; an executing run keeps its slot until its worker stops at the next
  checkpoint, so the cap stays strict.

## 6. Premium content

Premium is **access**, not capacity: a built-in List or Strategy marked `premium` (only `SYSTEM`
content can be — a CHECK constraint enforces it), and every point-in-time index universe. Pro and
Pro+ use it fully; Free and Starter see its name, description and size on the collection pages
(its detail page shows the lock and a way to the plans), and are refused
(`403 ENTITLEMENT_PREMIUM_CONTENT`) when reading its members or rules, duplicating it or backtesting
it. A customer's Monitor only ever watches the customer's own content, and a built-in Monitor never
references premium content (its Signals are public on every Dashboard). Responses carry `premium: true` and, for a plan without access,
`locked: true`. Today's only premium built-in is the S&P 500 Historical PIT universe; the catalog can
mark more (`builtin-catalog.ts`, `premium: true`).

## 7. Monitors

Free 1, Starter 5, Pro and Pro+ no plan cap. The V1 rules stand: execution eligibility is derived,
deterministic (`createdAt`, then `id`), and a downgrade never deletes or disables a Monitor.

**Fair use.** `MONITOR_FAIR_USE_MAX_ENABLED_PER_USER` (default 100) is the most Monitors one account
may have enabled at once, on any plan. It is infrastructure protection for the shared end-of-day
evaluation: enabling one more answers `409 MONITOR_FAIR_USE_LIMIT`. It never disables or blocks an
already-enabled Monitor, is not part of `Entitlements`, and is never advertised as a plan number.

## 8. Enforcement and bypass protection

Unchanged from V1 §12–§14, extended to the new limits:

- Every limit is decided server-side from persisted `User.plan`, re-read inside the writing
  transaction under `lockUserEntitlementScope`: a client-sent plan, a stale session, a retried or
  concurrent request cannot pass a limit. The worker re-reads the owner's plan at claim time.
- Symbol limits bind custom Lists (creation with members and bulk adds of up to 1,000 securities —
  the API has no separate import path), duplicated Lists (the copy is held to the copier's plan), backtest universes (checked before the engine's own ceiling,
  `BACKTEST_MAX_SECURITIES = 1,000`, so a customer always gets the plan error), Monitor universes
  (via List compliance) and predefined-list selection (premium and PIT allowance checks).
- **Storage versus execution.** A List larger than the current plan stays stored and readable; it
  is not execution-eligible (backtest `403 ENTITLEMENT_SYMBOL_LIMIT`, Monitor
  `BLOCKED_BY_ENTITLEMENT`) until it fits or the plan grows.
- Completed backtests stay readable after any downgrade; a re-run is checked against today's plan.

## 9. Billing synchronization

Unchanged direction (Stripe → `User.plan` → resolver → enforcement), now over three paid plans:
upgrades take effect immediately (Starter→Pro→Pro+, any jump), downgrades and cancellations at
period end, payment failure keeps the plan while Stripe retries (`past_due`) and ends at Free when
the subscription ends (`unpaid`/`canceled`), renewal re-confirms the plan. `classifyBillingTransition`
covers the 3×3 matrix.

## 10. What a pricing surface may say

Derived from `PLAN_ENTITLEMENTS` and `BILLING_CATALOG` only (`plan-presentation.ts`). Pro is the
emphasized plan ("Best Value"); Pro+ is positioned as "Advanced Research", never as the default.
Pro+ may say "Parallel Backtests" and must say "2 at a time". No surface may advertise priority
execution, faster compute or a guaranteed execution time.

## 11. Owner decisions taken during implementation (confirm or change)

1. **Monthly-only catalog** — the specification lists monthly prices only, so yearly prices were
   retired rather than invented. Re-adding yearly prices is a catalog change (`BILLING_PRICE_KEYS`).
   Existing V1 subscribers stay on their price and plan (§2, `STRIPE_LEGACY_PRICES`) — confirm that
   grandfathering, rather than a forced migration, is wanted.
2. **Monitor fair-use ceiling of 100 enabled Monitors per account** (§7), sized against the measured
   end-of-day pass (`docs/production/capacity-model.md`).
3. **Premium content today is one item** (the S&P 500 PIT universe). The pricing card advertises
   premium lists, strategies and universes; the owner should curate premium built-ins before launch.
4. **Queue bound of 100 waiting runs** deployment-wide (§5).
5. **Pro's universe allowance** for the PIT universe is its symbol limit (750 simultaneous members);
   V1 gave Pro 550 against a 100-symbol limit.
6. **A Pro+ QA persona** (`PRO_PLUS_USER`) is not yet in `packages/testing/src/personas.ts`, because
   every environment that seeds personas would then need `QA_PRO_PLUS_EMAIL`/`QA_PRO_PLUS_PASSWORD`
   secrets first. Integration tests use their own Pro+ fixtures; the billing persona
   `pro-plus-active` exists.

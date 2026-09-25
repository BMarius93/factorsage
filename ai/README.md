# AI Context

This directory is the canonical context for coding agents working on IntrinsicValue V2.

## Read order

For substantial work:

1. `../AGENTS.md`
2. `product/product-overview.md`
3. `architecture/system-overview.md`
4. Relevant product/domain document for the task.
5. `workflows/validation.md`
6. Relevant ADRs in `../docs/decisions/`.
7. `architecture/deep-discovery.md` when the question is "what does the system actually
   guarantee here?" — verified end-to-end behaviour, invariants, open product decisions, and the
   behaviours that look wrong but are deliberate.
8. `architecture/production-capacity.md` when the question is "what does this cost, where does it
   stop being cheap, what should an operator watch?" — measured on the production code path, with
   the benchmark harness and the environment the numbers came from.

For authentication and role authorization work, also read
`architecture/authentication.md`, and `workflows/auth-testing.md` for the test/QA-persona runbook.

For commercial plans, capacity limits, guest behaviour or downgrade semantics, read
`../docs/decisions/entitlements-v1.md` — the accepted product decision and the source of truth for
every value — then `architecture/entitlements.md`, which is how it is implemented: where the one
resolver lives, the enforcement point behind each canonical boundary, how the raceable limits are
made atomic, why Monitor intent and execution eligibility are separate, and where the billing
seam is. Plan (`FREE | STARTER | PRO`) and role (`USER | ADMIN`) are orthogonal columns on `User`;
`GUEST` is derived from the absence of a session and is never a persisted row. Do not add a plan
comparison in feature code, and do not model request rate as an entitlement.

For anything to do with Stripe, subscriptions, Checkout, the Customer Portal, webhooks or money,
read `../docs/decisions/stripe-billing-v1.md` — the accepted product decision and the source of truth
for the catalog, the transition matrix and the status policy — then `architecture/billing.md`, which is
how it is implemented: the one plan decision, the one write path, the one Stripe adapter, why the
Stripe read happens inside the per-user advisory lock, the idempotency-key design, the reconciliation
CLI, the local `stripe listen` runbook and the Dashboard configuration checklist. The direction is
one-way — `Stripe billing state -> User.plan -> resolveEntitlements() -> guards` — and it is enforced
by a test: billing may not hold an entitlement value, and entitlements may not depend on billing. Do
not ask Stripe a permission question, and do not write `User.plan` anywhere but `changeUserPlan`.

Entitlement behaviour is tested through fixed **test personas**, one per plan, defined once in
`packages/testing/src/personas.ts` and read by the seeders and the Playwright projects alike.
`PRO_USER` is the normal development and manual-testing account; `ADMIN_USER` is `plan=FREE`,
`role=ADMIN` and is for internal/QA scenarios only. Never change a persona's plan in a test — sign
in as the plan under test. `ai/workflows/auth-testing.md` is the runbook; seed with
`pnpm test:personas:seed`.

For strategy work, also read `product/strategies.md`. Two architecture documents sit beside it:
`architecture/strategy-builder.md` is the implementation plan for the Create/Edit Strategy vertical
slice — canonical types, the shared compatibility registry, validation, schema, contracts and the
desktop and mobile compositions. Its product questions are all closed. `architecture/strategy-evaluation.md`
is the technical design for evaluating those semantics over historical data, including the
reusable-component map and the open product questions that still block the backtest day loop.
Builder work needs the first; backtest-engine work needs the second.
For Stock Details or selectable-series work, also read `product/stock-details.md`,
`../docs/decisions/selectable-series-catalog.md`,
`../docs/decisions/viewport-driven-stock-details-history.md` for the chart's history window, its
30-year bound and how the viewport drives loading, and
`../docs/decisions/complete-price-coverage.md` for what a persisted price-coverage interval
means, how it is revisioned, and how the chart's boundary is reported.

For any work on calculated daily series — moving averages, oscillators (RSI), intrinsic-value
models and blends, the derived state, or adding a new series or family — read these in order:

1. `../docs/decisions/retain-wide-column-calculated-series-storage.md` — the accepted storage
   decision: explicit PostgreSQL columns, what is deferred, what is rejected, and the budgets and
   triggers that would re-open it.
2. `architecture/calculated-series.md` — the canonical architecture as implemented: identity,
   registries, calculation, persistence, revision, cache, API and web.
3. `../docs/development/adding-a-calculated-series.md` — the extension checklist. It says
   explicitly that repository search and the completeness tests, not the checklist alone, are what
   prove a series is fully wired.
4. `workflows/validation.md` for the test gate, and `product/stock-details.md` with
   `../docs/decisions/selectable-series-catalog.md` for the consuming product surface.

Do not propose JSONB, EAV, a Redis redesign or a generic series endpoint as the current direction:
the first document records why they are deferred or rejected.

`DERIVED_STATE_REVISION` governs only the derived state. Historical _price_ coverage has its own
revision, `PRICE_DATASET_VERSION`, documented in `../docs/decisions/complete-price-coverage.md`;
bumping one does not invalidate the other.

For the Dashboard's market-overview cards, the market-reference index series or anything that
touches which benchmarks a user may select, read `architecture/benchmark-data.md`: it owns the
`isActive` / `isBacktestSelectable` split, the `ETF_PROXY` / `INDEX` series semantics, why `SP500`
stays `SPY` for backtests, the `GET /market-overview` contract and its end-of-day honesty rules, and
the `pnpm benchmarks:prewarm` runbook for deeper history.

For backtest work — the engine, the worker, benchmark data or the run surfaces — read
`product/backtests.md` first, then `architecture/backtest-execution.md` (the built lifecycle,
progress model, durable job protocol, worker process model and the versioned execution
methodology), `architecture/benchmark-data.md` (why a Benchmark is not a `Security`, and what its
loading shares with stock loading), and `architecture/strategy-evaluation.md` for the design the
engine was built from. `../docs/decisions/backtest-run-persistence.md` records the storage
decision, and `../docs/development/backtest-debug-archive.md` documents the opt-in developer-only
forensic archive a worker can write for one attempt when a run's numbers have to be verified
independently. `../docs/development/qa-matrix-fixtures.md` documents the deterministic QA-MATRIX
Strategy/List/configuration fixtures the 1,000-run validation matrix is built from, and
`../docs/development/qa-matrix-runner.md` documents the developer-only runner that executes
them through the real application/worker path — its dedicated database, its preflight, the
forty invariants it validates independently, and which three of those need the debug archive. Strategy semantics stay owned by `product/strategies.md`; execution behaviour it leaves
open is engine methodology recorded in `architecture/backtest-execution.md`, never re-decided in
feature code.

For Monitor, Dashboard or built-in content work, read
`../docs/decisions/builtin-dashboard-signals-v1.md` (the accepted signal lifecycle, SYSTEM ownership,
the Dashboard and the built-in catalog), then `product/product-overview.md` (the domain map) and
`product/monitors.md`, then `architecture/monitor-engine.md`, `architecture/deep-discovery.md` (verified end-to-end behaviour, invariants and open product questions, one investigation per entry),
`product/strategies.md`, `architecture/strategy-evaluation.md`, and `architecture/calculated-series.md`.
Monitor reuses the canonical Strategy language but evaluates it against current data. The V1 architecture
loads/updates data and computes required series per symbol, evaluates per Monitor, uses process memory for
transient per-cycle reuse, and persists correctness-critical transition state durably. Do not add a new
Redis history/indicator cache or user-configurable scan cadence as part of Monitor V1. Monitor V1
shipped as API (`apps/api/src/monitors`), worker (`apps/worker/src/monitor`) and web
(`apps/web/src/features/monitors`). The web slice manages monitors and presents one: the collection
is a summary, and `/monitors/[monitorId]` carries the configuration, the current status of every
monitored security, and the newest Signals. A Monitor may also be **rebound** to a different
Strategy or Stock List — a configuration boundary, fenced against an in-flight cycle by
`Monitor.configVersion`; `product/monitors.md` and `architecture/monitor-engine.md` own the
semantics.

For insider activity, congressional trading, actor groups or anything that scopes a strategy rule to
a named actor, read `../docs/alternative-data-signals.md`: it is the accepted product decision **and**
the record of the implementation clarifications and provider limitations found while building it — why
a lookback is measured on the session a disclosure became observable rather than on the transaction
date, why a metric outside ingested coverage is `NOT_EVALUABLE` rather than zero, which FMP endpoints
accept no date range, and why Institutional Form 13F is out of V1 entirely (every
`institutional-ownership/*` endpoint is restricted on the current subscription). Then read
`product/strategies.md` for where the two metric families sit in the compatibility matrix, and
`AGENTS.md` invariant 23 for the rules a change must not break. The groups live in the Lists product
area rather than in new top-level navigation, and a backtest freezes a referenced group's membership
into its snapshot.

For anything to do with HTTP rate limiting, `429` responses, client-IP or proxy assumptions, the
Redis-failure policy, or outbound FMP provider throttling, read `architecture/rate-limiting.md`. It
owns the policy catalog's location and initial values, why enforcement is a global interceptor
rather than a guard, the actor/key rules, the `rate-limit:v1:*` namespace, the per-policy
fail-open/fail-closed decision, and how the OpenAPI document is kept in step with the `@RateLimit`
declarations. Rate limiting is never an entitlement: `../docs/decisions/entitlements-v1.md` section
10 keeps them apart and a test enforces it.

The HTTP API itself is specified in `../docs/openapi.yaml` (OpenAPI 3.1). Validate it with
`pnpm openapi:validate`; `apps/api/src/openapi/openapi.contract.test.ts` is what stops it drifting
from the routes that actually exist.

For anything touching the public legal pages, Terms acceptance, browser-storage consent, the
contextual research disclosures, or the privacy/withdrawal/support request channels, read
`../docs/legal/README.md` (the specification and the register of outstanding owner facts) and then
`architecture/legal-compliance.md` (how it is implemented: the hashed document registry, where
acceptance is bound to a verified account holder, the global acceptance gate and its pinned
allowlist, the verified storage inventory behind the consent control, and the release-readiness
guard). `../docs/legal/storage-inventory.md` records how the browser inventory was verified.
Do not invent an operator fact, a retention period, a provider name or a legal conclusion: those
are the `O`-numbered entries in `../docs/legal/owner-inputs-and-review.md`.

For frontend/UI work, also read `architecture/frontend.md`. For the V1 visual-parity pass, read
`architecture/v1-visual-parity.md` after it; that document defines the target surface hierarchy,
action placement and responsive acceptance criteria.

For server-side API, worker, stock-data, FMP, database, cache, queue, or integration work, also read
`architecture/observability.md`.

## Source-of-truth rule

The old repository is historical reference only.

For frontend work, the old repository may be used as a visual/behavioral oracle, but V2 architecture and product documents remain authoritative.

When old code or old documentation conflicts with V2 documents, V2 documents win unless the user explicitly changes the decision.

## Current V2 product model

```text
StockList (user-owned, or SYSTEM built-in: readable by all, changed by ADMIN only)
  |
  +-- StockListItem -> Security (canonical catalog identity)
       +-- BUY window = FULL
       or
       +-- BUY window = CUSTOM(one or more normalized date ranges; endDate null = open-ended)

SelectableSeriesCatalog
  |
  +-- daily/weekly moving averages
  +-- daily oscillators (RSI 7D/14D/21D, shared 0-100 chart pane)
  +-- intrinsic-value models/blends
  +-- Stock Details overlays
  +-- compatible Strategy Metric/Value selections

Strategy (user-owned, or SYSTEM built-in)
  |
  +-- ordered BUY levels
  +-- ordered SELL levels
  +-- optional FINAL EXIT
  +-- each level owns one Signal
  |    +-- zero or more Conditions, ANDed
  |    +-- zero or one optional Trigger, ANDed with the Conditions
  +-- Condition product grammar = Metric / Condition / Value
  +-- Trigger product grammar = Metric / Trigger / Value
  +-- no global valuation source
  +-- no Stock List
  +-- no capital/contributions/maximumPositions/date-range execution inputs

Backtest configuration
  |
  +-- Strategy + StockList + Benchmark
  +-- date range / capital / contributions / maximumPositions / execution assumptions

Benchmark (system-owned, never a Security)
  |
  +-- BenchmarkDailyPrice + its own coverage/state and Redis namespace

Backtest run
  |
  +-- immutable execution snapshot + asynchronous worker execution
  +-- durable PostgreSQL job claim, live progress checkpoints
  +-- deterministic results / diagnostics

Monitor (user-owned with `enabled`, or SYSTEM built-in with isPublished / isGloballyEnabled)
  |
  +-- live Strategy reference (no pinned version) + live StockList reference + enabled
  |   (both references may be rebound; doing so discards transition state, resolves active
  |    Signals, clears lastScanAt and keeps Signal history)
  +-- cadence, lease and retry are application configuration, never user input
  +-- deleting a referenced Strategy or StockList is refused while the Monitor exists
  +-- evaluates every BUY / SELL / FINAL EXIT level against current data (closed history
  |   plus the live quote as the provisional observation), BUY gated by the member's buy window
  |
  +-- durable (Monitor, Security, level) lifecycle: INACTIVE / PENDING_TRIGGER / ACTIVE / RESOLVED,
  |   keyed to the level's own canonical fingerprint (a Strategy edit resets only changed levels)
  |   +-- conditions only      = a state: ACTIVE while the Conditions hold
  |   +-- conditions + trigger = PENDING_TRIGGER until the Trigger fires, then ACTIVE (latched)
  |   |                          while the Conditions hold
  |   +-- trigger only         = an event: ACTIVE for its session, RESOLVED on a later session
  |   +-- a level with no state is reconstructed from history, never started blank
  +-- produces Signal occurrences (created on entering ACTIVE, resolved with a reason, never
  |   reopened) and a transition history of state changes only
  |
Dashboard = ACTIVE occurrences + PENDING_TRIGGER setups of every Monitor the viewer can see
  +-- Guest: published built-ins; signed-in: those not hidden (UserBuiltInMonitorPreference)
      plus the user's own enabled Monitors
```

`product/product-overview.md` holds the one-page map of how List, Strategy, Backtest, Monitor and
Signal relate, who owns what, and what each concept is _not_.

Historical market-derived Strategy predicates are conceptually evaluated as date-aligned logical
series. Missing/warm-up/PIT-unavailable data remains `NOT_EVALUABLE`; it is never replaced by zero
or future data. Position-dependent metrics such as Gain/Loss require simulated position state and
must not be forced into a static historical-series model merely for implementation convenience.

Catalog membership does not automatically define Strategy compatibility: a series becomes a usable
Metric or Value only when `product/strategies.md` says so, and its operators and value domains are
a product decision there. RSI and the moving averages have been through that step — both are now
first-class Strategy Metrics, with moving-average Values resolved through the catalog's own
`comparableMovingAverages` (same timeframe, never itself). Percentage domains are metric-specific:
Margin of Safety `<= 100`, Gain `>= -100`, Loss `0..100`.

Historical index-membership PIT is excluded.

Fundamental/intrinsic no-look-ahead correctness remains required.

# FactorSage — Production readiness report

Subscription enforcement, production infrastructure and full-scale performance validation, measured
2026-10-23 and 2026-10-24 on branch `claude/exciting-cray-qiecyk`
([BMarius93/factorsage#148](https://github.com/BMarius93/factorsage/pull/148)).

**How to read the numbers.** Every number below is a measurement with its source, or is marked
**NOT MEASURED** or as an estimate. Scale benchmarks ran against a **deterministic synthetic
provider and synthetic 34-year histories** on the 4 vCPU / 16 GB development container — half the
recommended production host — so they are the conservative end. Real FMP was sampled once, through
the guarded live command, for three securities (§B.4). How each number was produced is
`benchmarks.md`; the full tables are `benchmark-results.md`; raw reports are in
`benchmark-results/`; the capacity model is `capacity-model.md`; the deployment is
`architecture.md` and `RUNBOOK.md`.

**Summary.** The four plans' limits are one typed policy that the server enforces — in the API under
per-user locks, and again when a worker claims a run — and that no client input can raise. At most
four backtests execute at once across the deployment, behind a bounded, durable, fair queue that
recovers a crashed worker's run without executing it twice. Four simultaneous 1,000-security,
30-year backtests finish in 2.6 min with a warm cache and 21.3 min from an empty Redis, and peak at
11.9 GB of worker memory when 400 of their securities are downloaded for the first time. With the
two API processes now configured, the application keeps p95 under 1 s for 100 concurrent users. The
production stack was built and deployed on the development machine and passed every check. Finding
and fixing what would have failed in production was most of the value of this work:

- a list larger than the LRU rebuilt every member in every year window;
- a Redis restart failed every executing run;
- the worker memory limit was below the measured peak;
- one API process saturated;
- Redis refused its configuration;
- the API and the web image could not start from the committed templates and build.

What remains is outside the code: the V2 Stripe catalog — six prices since annual billing was
restored on 2026-10-24 — exists and passes every sandbox suite in the Stripe sandbox, but not yet in
live mode; the legal pages are not approved, so no release web image can be built; and nothing has
run on production hardware.

**Verdict: READY WITH LIMITATIONS** (§H).

---

## A. Subscription implementation

### Final entitlement matrix

`packages/contracts/src/entitlements.ts` (`PLAN_ENTITLEMENTS`) is the one executable definition;
`docs/decisions/entitlements-v2.md` §3 describes it.

| Limit                                       |   Free | Starter |         Pro |        Pro+ |
| ------------------------------------------- | -----: | ------: | ----------: | ----------: |
| Price, monthly                              |     $0 |     $19 |         $49 |        $199 |
| Price, yearly (charged upfront)             |      — |    $169 |        $439 |      $1,790 |
| Yearly, per month (Save 25%)                |      — |  $14.08 |      $36.58 |     $149.17 |
| Symbols per List and per Backtest           |     10 |      50 |         750 |       1,000 |
| Active Monitors                             |      1 |       5 | Unlimited\* | Unlimited\* |
| Concurrent Backtests (own runs in flight)   |      1 |       1 |           1 |           2 |
| Total Backtests                             |      ∞ |       ∞ |           ∞ |           ∞ |
| History per Backtest                        | 30 yrs |  30 yrs |      30 yrs |      30 yrs |
| Saved Lists / Strategies                    |      ∞ |       ∞ |           ∞ |           ∞ |
| Full Strategy Builder, ETF and sector rules |    Yes |     Yes |         Yes |         Yes |
| Premium Lists, Strategies, PIT universes    |     No |      No |         Yes |         Yes |

\* Unlimited active Monitors means no advertised numerical subscription cap, not unlimited physical
infrastructure: an operational fair-use ceiling of 100 enabled Monitors per account
(`MONITOR_FAIR_USE_MAX_ENABLED_PER_USER`, refused as `409 MONITOR_FAIR_USE_LIMIT`, never shown as a
plan number) protects the shared end-of-day pass. 30 years is subject to data availability. Guests
read public content and precomputed demonstration backtests, and never start a computation.

Pricing (`apps/web/src/features/billing`): four cards, re-priced in place by a Monthly/Yearly toggle
whose Yearly option says **Save 25%**. A yearly card leads with its effective monthly cost and states,
directly under it, the exact annual amount billed upfront ("Billed annually: $169 upfront"); the
saving is rounded down, so it never claims more than the prices give. Pro is marked **Best Value**,
Pro+ **Advanced Research**, in both cadences; Pro+ advertises **Parallel Backtests** and states the
limit of two at once. No
surface claims priority, faster or guaranteed execution — the queue has no paid priority
(`docs/decisions/entitlements-v2.md` §10).

### Enforcement locations

| What                | Where                                                                                                                                                                                          | How it resists bypass                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Plan resolution     | `resolveEntitlements` (contracts), `EntitlementsService` (API)                                                                                                                                 | the plan is read from `User.plan`, which only Stripe reconciliation writes (`changeUserPlan`); no route accepts a plan |
| Symbols per List    | list create and add (`EntitlementsService.assertListSymbolLimitIn`, under the per-user advisory lock)                                                                                          | counted in the same transaction as the write                                                                           |
| Backtest submission | `BacktestsService.submitRun`: symbols, history, premium/PIT content, concurrency (`assertBacktestConcurrency`: queued + running, under the user lock), queue bound (`503 BACKTEST_QUEUE_FULL`) | atomic per user; the immutable run snapshot records what was admitted                                                  |
| Execution           | worker claim (`job-repository.ts`): the deployment-wide cap under one advisory lock, the owner's plan **re-read** under the owner's lock, the owner's executing count from live leases         | a run queued under a higher plan executes under the current one; a client cannot raise its own concurrency             |
| Premium content     | `assertPremiumAccessible` (`apps/api/src/builtins/content-access.ts`) and `assertCanUsePremiumContent` (contracts) on List and Strategy reads, duplication, Monitors and backtests             | members and rules are withheld server-side (`403 ENTITLEMENT_PREMIUM_CONTENT`); names and sizes stay visible           |
| Monitors            | enable/update (`assertCanEnableMonitor` under the user lock) and derived execution eligibility each cycle                                                                                      | over-capacity Monitors after a downgrade stop being evaluated without being deleted                                    |
| Guests              | no backtest route without a session (`CookieAuthGuard`); the demonstration shelf is a read of stored shares                                                                                    | a forged session cookie is a Guest (live probe, §C)                                                                    |

### Stripe integration status

- Catalog: six prices — `STARTER_MONTHLY`, `STARTER_YEARLY`, `PRO_MONTHLY`, `PRO_YEARLY`,
  `PRO_PLUS_MONTHLY`, `PRO_PLUS_YEARLY` — both cadences of a plan on that plan's one product
  (`entitlements-v2.md` §2, annual billing restored 2026-10-24). `pnpm billing:verify-catalog`
  checks amounts, cadences and products; a V1 year left in a `*_YEARLY` variable is reported by its
  amount, and refused at startup once it is listed as retired.
- Subscribers on retired V1 prices are grandfathered through `STRIPE_LEGACY_PRICES` (otherwise they
  would fall to Free at their next reconciliation) — an owner action before deploy (§G, P0-2). The
  same plan and cadence keeps the retired price; any other change is the ordinary transition onto
  today's price. Nothing migrates or reprices a subscription.
- Reconciliation is the only writer of `User.plan`; webhooks are signature-checked and idempotent
  (duplicate and out-of-order deliveries are integration-tested).
- **Exercised against the Stripe sandbox (test mode) on 2026-10-24**, with the six V2 sandbox prices
  the owner created and the four V1 prices listed as retired: `verify-catalog` (six of six, and both
  stale-year guards); the smoke suite (13 / 13, hosted Checkout on each yearly price); the lifecycle
  suite on Test Clocks (12 / 12: each year charged in full upfront — $169, $439, $1,790 on one paid
  invoice covering 365 days; Pro monthly → yearly at once, $390 charged = $439 less the unused $49
  month; Pro yearly → monthly scheduled for the end of the paid year, then a $49 invoice; a failed
  yearly renewal kept the plan; a V1 subscriber stayed on the retired price until upgrading; BILL-01,
  BILL-02, past-due recovery, renewal); and the six billing personas. **Live mode was not touched.**

### Tests

| Layer                      | Suites (cases)                                                                                                                                                                                                                                                                                                                              | What they prove                                                                                                                                                                                                                                                                                                                                                                                                                                   | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts (unit)           | `entitlements.test.ts` (43), `billing.test.ts` (59), two boundary suites (12)                                                                                                                                                                                                                                                               | the matrix values, plan resolution, the six-price catalog and all 36 ordered transitions, pricing-copy rules                                                                                                                                                                                                                                                                                                                                      | pass — with the package's other suites, 568 / 568                                                                                                                                                                                                                                                                                                                                                                                                      |
| API (PostgreSQL + Redis)   | `entitlements.integration.test.ts` (55), `premium-content.integration.test.ts` (6), `backtest-admission.integration.test.ts` (8), `billing.integration.test.ts` (125), `catalog-verification.test.ts` (15)                                                                                                                                  | limits cannot be raced (simultaneous adds and submissions), downgrades delete nothing and block without truncating, no route accepts a plan or role, premium gates, cancellation, `503` + `Retry-After` at the queue bound, the Stripe lifecycle through the fixture gateway (duplicate and out-of-order webhooks, failed payments, scheduled downgrades, `past_due`, `unpaid` → Free, every monthly ↔ yearly move, grandfathered retired prices) | pass — the API's 3,017 / 3,017                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Worker (PostgreSQL)        | `claim-entitlements.integration.test.ts` (9), `global-admission.integration.test.ts` (10), `job-repository.integration.test.ts` (16)                                                                                                                                                                                                        | per-owner concurrency at the claim with the plan re-read under the owner's lock, the deployment-wide cap under simultaneous claims, first-runs-first fairness, cancellation of queued and executing runs, lease expiry without double execution                                                                                                                                                                                                   | pass — the worker's 461 / 461                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Web (unit)                 | `plan-presentation.test.ts` (25), `plan-actions.test.ts` (40), `queue.test.ts` (5)                                                                                                                                                                                                                                                          | the four cards' copy (Best Value, Advanced Research, "Parallel Backtests: 2 at a time", no speed claims; yearly: the effective monthly cost, the exact annual amount billed upfront, Save 25%), the actions each plan offers, queue position                                                                                                                                                                                                      | pass — the web app's 1,940 / 1,940                                                                                                                                                                                                                                                                                                                                                                                                                     |
| E2E (Playwright, hermetic) | the full suite: 75 spec files, 362 tests, one Chromium worker, against the hermetic stack (fixture provider, egress guard) — including `pricing.guest/free`, `billing.*`, `entitlements.{guest,free,starter,pro,downgraded}`, `backtests/*` (submission, live progress, cancellation-era run page, PIT membership, ETF conditions, sharing) | what a user meets on every plan: limits named next to the control that hit them, the pricing cards, the run lifecycle                                                                                                                                                                                                                                                                                                                             | **362 / 362 pass** at `64b19b0`, 0 outbound connections (after updating 19 fixtures and specs that still encoded the V1 limits, §G). Re-run for annual billing on 2026-10-24: 363 tests (the cadence toggle's keyboard test is back); 362 passed and one Stock Details test lost a race it has always had (it counted labels before the valuation summary loaded) — fixed in the test, then 25 / 25 on five repeats; the billing-persona pages 24 / 24 |
| Live probes (running API)  | `submission-probes.ts` (16)                                                                                                                                                                                                                                                                                                                 | Guest and forged-cookie submissions refused; six simultaneous submissions accept exactly the plan's concurrency; a client-declared plan is refused; another user's list is not found; the Free list limit; the queue bound's `503` + `Retry-After`                                                                                                                                                                                                | **16 / 16 pass** (§C)                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Stripe sandbox (test mode) | `billing:verify-catalog`, `test:billing:sandbox`, `billing-lifecycle.sandbox.test.ts`, `test:billing:personas`                                                                                                                                                                                                                              | the real Stripe API end to end, on the six V2 sandbox prices                                                                                                                                                                                                                                                                                                                                                                                      | **all pass** on 2026-10-24: catalog 6 / 6, smoke 13 / 13, lifecycle 12 / 12, personas 47 / 47 (§A)                                                                                                                                                                                                                                                                                                                                                     |

**The repository's validation gate** (CI's steps, `.github/workflows/ci.yml`), run once the work was
settled, on 2026-10-24: Prisma schema validation and migration drift, lint, typecheck, **8,141 tests
in 11 packages** (config 93, contracts 540, domain 158, observability 3, valuation 38, FMP 138,
strategy 351, web 1,915, stock-data 1,470, API 2,974, worker 461 — none failed or skipped), the
stock-data Redis suites (68), OpenAPI validation (73 paths) and the production build: **all pass**.

Re-run after annual billing was restored (2026-10-24, the same steps): **8,240 tests in 11 packages**
(config 96, contracts 568, domain 158, observability 3, valuation 38, FMP 138, strategy 351, web
1,940, stock-data 1,470, API 3,017, worker 461 — the 8,141 above plus 99 new, none failed or
skipped), the Redis suites (68), OpenAPI validation (73 paths) and the build: **all pass**; the PR's
`validate` check passes on the same head.
CI's own run on the pushed head is the PR's `validate` check.

---

## B. Backtest benchmark results

Machine: 4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, network block storage, PostgreSQL 16 and Redis 7
on the same machine. Four backtest worker processes, `BACKTEST_GLOBAL_MAX_RUNNING=4`,
`STOCK_LRU_MAX_SECURITIES=500`, 735 canonical-universe securities protected, 1,000 ordinary ones in
the LRU pool. 30-year runs (1996-10-23 → 2026-10-22). Lists are 60 % canonical-universe members and
40 % ordinary unless stated. Full tables: `benchmark-results.md` §3–§5.

### B.1 Per plan, warm (everything resident in Redis)

| Scenario          | Runs × securities   | Samples | Execution s (median · max)       | Bottleneck |
| ----------------- | ------------------- | ------: | -------------------------------- | ---------- |
| A Free            | 1 × 10              |       3 | 4.9 · 5.2                        | CPU        |
| B Starter         | 1 × 50              |       3 | 12 · 13                          | CPU        |
| C Pro             | 1 × 250             |       3 | 38 · 39                          | CPU        |
| D Pro             | 1 × 500             |       1 | 66                               | CPU        |
| E Pro             | 1 × 750             |       1 | 98                               | CPU        |
| F Pro+            | 1 × 1,000           |       2 | 132 · 133                        | CPU        |
| G Pro+ (one user) | 2 × 1,000 at once   |       2 | 137 · 137                        | CPU        |
| H four users      | 750+750+1,000+1,000 |       8 | 750: 122 · 124; 1,000: 153 · 155 | CPU        |
| I (sizing case)   | 4 × 1,000 at once   |       4 | 157 · 158                        | CPU        |

Execution grows linearly at ~0.13 s per security for 30 years: 80 % decoding frames from Redis, 15 %
simulation, ~3 s persisting. Queue waits were under 0.3 s (no run waited for a slot). Strategy
complexity at Pro × 500: simple 66 s, monthly contributions 66 s, fundamentals + oscillator +
valuation 86 s, sector-ETF conditions 94 s; four at once with the complex strategy 3.3 min.

### B.2 Four simultaneous executions

The global cap's worst case — four 1,000-security, 30-year runs at once (`I`) — completed in
**2.6 min**, 157 s per run against 132 s alone (**1.21×**), the machine 97 % busy, 1.9 GB of worker
memory in all, PostgreSQL ≤ 25 connections. Mixed sizes (`H`) behaved the same (2.6 min, twice).
Four slots on this machine complete ~92 such runs per hour.

### B.3 Cold Redis (PostgreSQL → Redis)

`H-cold-mixed-shared` (Redis emptied, the same four runs): **21.3 min** against 2.6 min warm.
Preparation rebuilt the 1,000 securities the four lists share from PostgreSQL (1,082 s median per
run; **4.3 s of slot time per security**, CPU-bound decoding and encoding; 608 one-day provider
reads), then executed exactly as warm. Worker memory peaked at 2.0 GB per process, 6.6 GB for the
four; event-loop delay p99 2.2 s inside the workers (no user request runs there). Results
byte-identical to the warm runs.

### B.4 True provider miss

First-time securities are hydrated inside the run's preparation, in its slot (`benchmark-results.md`
§5):

| Run                                                                 | First-time securities | Execution (warm)   | Per first-time security                                                                    | Worker memory            |
| ------------------------------------------------------------------- | --------------------: | ------------------ | ------------------------------------------------------------------------------------------ | ------------------------ |
| `C-miss-mixed` Pro × 250, synthetic provider                        |                   100 | 6.2 min (38 s)     | 3.3 s of slot time, 9.7 requests, 2.3 MB                                                   | 3.42 GB                  |
| `B-miss-mixed-latency250` Starter × 50, +250 ms per answer          |                    20 | 90 s (12 s)        | 3.9 s                                                                                      | 3.42 GB                  |
| `H-miss-mixed-shared` 750 + 750 + 1,000 + 1,000 at once, 400 shared |                   400 | **18.2 min** (2.6) | 2.4 s of wall time, four workers                                                           | **11.9 GB** for the four |
| **Real FMP** (`fmp-live.sh`, AAPL, MSFT, KO, one at a time)         |                     3 | —                  | 9.7–14.6 s full ingest; 7.5–9.0 s for prices, statements and derived state; 17–26 requests | —                        |

Real FMP was sampled for three securities only (the guarded command's ceiling); scale numbers are
the synthetic provider's, which answers instantly unless a latency is set — they measure
FactorSage's own miss path, not FMP's latency or quota. Estimate for real FMP inside a run:
3.5–4.5 s per first-time security (**not measured**). FMP consumption: ~9.7 requests per first-time
security for a backtest (~22 for the full ingest with insider and congressional data); the
deployment-wide gate (20 requests/s, 4 concurrent) bounds a first-time 1,000-security list to ≥ 8
minutes of provider time.

### B.5 The LRU's worst cases

A list whose ordinary (non-canonical) members exceed the 500-security LRU is the slowest workload
measured (`benchmark-results.md` §2):

| Run                                                           | Result                                                                                                                                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pro+ × 1,000 ordinary, 30 years, alone (`F-ordinary-30y`)     | **28.0 min**: preparation 978 s (600 rebuilds, 1.6 s each), 680 s of window reads (15,500 from PostgreSQL), 19 s simulation — ~13× the resident case                                                                       |
| the same list, one 48-session window, previous behaviour      | **1,418.7 s** — every window rebuilt all 1,000 histories; the same window takes 5.2 s with `STORE`, 2.3 s with nothing evicted                                                                                             |
| four users, lists spanning the pool (`H-warm-mixed-disjoint`) | **15.6 min** for 750 + 750 + 1,000 + 1,000 (2.6 min when the lists share members): 684 rebuilds, ~2.4 s of slot time each, 6,944 window reads from PostgreSQL; the two lists also run fully resident gave the same digests |

The fix (`STORE`, now the default) turned a run of hours into one of minutes, with identical results;
what remains is preparation's one rebuild per non-resident security (P1-1).

### B.6 Determinism

Every repeat of the same inputs produced the same result digest: A, B and C three times, F twice, the
1,000-security list across F, G, H and I, both lists across cold and warm H, and the 1,000-ordinary
list read through `STORE` and with nothing evicted — and every run that completed through a failure
test (a killed worker, a Redis restart, a Redis flush, a provider failing every seventh request)
produced its list's usual digest; 32 runs beside the Monitor benchmark did too.

---

## C. Application responsiveness

`benchmark-results.md` §6. Production builds of the API and web app on the benchmark database, 100
load accounts on every plan, weighted journeys over every page family (dashboard, Stock Details — 80 %
canonical, 20 % long-tail —, lists with edits, strategies, backtest history and results, Monitors,
billing), 2 s think time, percentiles over 150 s of steady state per level. The load generator was
a separate process on the same 4 vCPU machine (12 % of a core at 100 users). "Beside four
backtests": the H workload executing back to back, all four slots busy 72–93 % of the time.

|           Concurrent users | p50 · p95 · p99, API alone             | p50 · p95 · p99, beside four backtests | Errors |
| -------------------------: | -------------------------------------- | -------------------------------------- | -----: |
|                          5 | 14 ms · 0.50 s · 0.99 s                | 21 ms · 0.34 s · 0.63 s                |      0 |
|                         20 | 20 ms · 0.71 s · 1.5 s                 | 32 ms · 0.56 s · 0.99 s                |      0 |
|                         50 | 123 ms · 1.5 s · 3.6 s                 | 154 ms · 1.3 s · 2.1 s                 |      0 |
|                        100 | 0.86 s · 3.4 s · 6.9 s                 | 1.1 s · 3.6 s · 5.9 s                  |      0 |
| 100, **two API processes** | **58–61 ms · 0.80–0.85 s · 1.4–1.6 s** | not measured                           |      0 |

- **The API process is the interactive bottleneck, not the backtests.** One Node process tops out
  at ~40 requests/s; its event loop then queues everything (p99 delay 0.7–1.1 s at 100 users). Four
  executing backtests beside it barely move its percentiles. Two processes doubled throughput (77.8
  requests/s) and cut the 100-user p95 by three quarters, so **the production stack now runs two**
  (`api`, `api-2`, least-connections in Caddy).
- **Slowest page: Stock Details of a stock outside both cache tiers**, rebuilt from PostgreSQL inside
  the request (2–6 s under light load; p95 27.8 s at 100 users on one process), and the resident
  Stock Details payload (0.39 MB) is the heaviest response (§G, P1-3).
- **Browser:** 138 Chromium page loads over 13 pages, with and without four backtests: **0 failures,
  0 crashes, 0 page errors, 0 timeouts**; ready times 0.9–3.1 s (guest dashboard up to 5.2 s, its
  charts' long tasks up to 0.75 s).
- **Live probes against the running API: 16 of 16 pass** — Guest and forged-cookie submissions
  `401`; six simultaneous submissions from one account accept exactly the plan's concurrency (1; 2
  for Pro+) and refuse the rest with `403 ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT`; a body declaring
  `plan: "PRO_PLUS"` is refused (`400`); another user's list is indistinguishable from a missing one;
  a Free list past 10 symbols `403`; 110 simultaneous submissions fill the queue and the rest get
  **`503 BACKTEST_QUEUE_FULL` with `Retry-After: 60`** (the unlocked bound overshot by 2, as
  documented).
- **Through a Redis restart** the API answered `503` for ~11 s and recovered by itself within ~2 s of
  Redis returning.
- Polling: the result page polls `GET /backtests/:id/progress` while a run is live; it stayed at
  p50 37 ms and p95 0.56 s at 20 users beside four backtests.

**Verdict for the interactive tier:** responsive (p95 ≤ 1 s) to ~20–30 concurrent users per API
process on 4 vCPU; ~100 with two processes. NOT MEASURED on the production host.

---

## D. Cache analysis

All measured against the synthetic universe (735 protected, 1,000 ordinary in the pool; uniformly 34
years, the worst case per security). Details and raw reports: `benchmark-results.md` §1–§2.

### Protected residency

- 735 designated, 735 READY, 52,920 keys, **no key with a TTL**, no orphans, no dual residency, no
  violations — before and after LRU churn, a capacity change, a Redis restart and a Redis loss.
- Never touched by LRU capacity: through 536 LRU evictions and 1,080 concurrent reads the protected
  digest did not change.
- Rebuilt from PostgreSQL alone: 735 securities in 14.6–16.2 min at concurrency 4, with no provider
  request, every price and daily-state chunk byte-identical to before.

### LRU at 500

| Check                | Result                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exactness            | after each of 1,392 reads (fill, overflow, re-reads, re-admissions) the LRU matched a reference count-bounded LRU in membership and order; 0 deviations |
| Bound                | never above 500 in 29,758 samples under six concurrent readers; never above 400 after the capacity was lowered at runtime                               |
| Whole evictions      | 536 evictions, 0 keys left behind; 0 reads that differed from PostgreSQL (720 concurrent reads, 257 of them cold)                                       |
| Lowered capacity     | the first touch evicted 100 members in 21 ms                                                                                                            |
| Promotion / demotion | keys and bytes unchanged, no TTL; back in the LRU as its newest member within capacity                                                                  |
| Cost of a miss       | a cold LRU read rebuilds the whole history from PostgreSQL: median 1.86 s, p95 2.19 s alone, p95 4.2 s with six readers; a warm read 3 ms               |

**Contention found and fixed.** A run with more ordinary securities than the LRU holds rebuilt every
one of them in every calendar-year window: one 48-session window of a 1,000-security run took
**1,418.7 s**. Backtest windows now read non-resident LRU securities from PostgreSQL (the same
canonical rows, nothing admitted): the same window took **5.2 s**, with an identical result
(`docs/decisions/stock-cache-tiers-v1.md`, amendment of 2026-10-23; now the default,
`BACKTEST_NON_RESIDENT_FRAME_READ=STORE`). Preparation still rebuilds each such security once per run
(§G, P1-1).

### Memory and recovery

| Content                        | Synthetic (34 years)      | Real S&P 500 universe (`protected-stock-tier-v1.md`) |
| ------------------------------ | ------------------------- | ---------------------------------------------------- |
| Per security                   | 1.05 MB mean, 1.19 MB p95 | 0.74 MB mean, 0.94 MB p95                            |
| Protected tier (735)           | 770 MB                    | 544 MB                                               |
| Both tiers full, `used_memory` | **1.30 GB** (measured)    | ≈ 0.95 GB (estimate)                                 |

| Event                           | Result                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Redis restart with its snapshot | serving again in 15.5 s (warm disk), **112.7 s** after a container restart (cold disk, 1.24 GB); identical digest               |
| Redis loss                      | protected tier rebuilt from PostgreSQL in 14.6 min; the LRU refills on reads; nothing lost                                      |
| Redis restarted under four runs | before the fix, all four failed within a second; with the fix (workers wait ~2 min for Redis), all four completed, same digests |
| Redis flushed under four runs   | all four completed with the same digests, reading from PostgreSQL and rebuilding as they went (13.7–19.4 min)                   |
| Protected rebuild killed        | 184 READY and 4 abandoned HYDRATING generations (they expire); `protect` again: 12.5 min, 735 READY, audit clean                |

---

## E. Production infrastructure

Full design: `architecture.md`; operations: `RUNBOOK.md`; files: `deploy/production/`,
`docker/production.Dockerfile`.

### Diagram

```text
                 Internet
                    │ 80/443 (TCP), 443/UDP
              ┌─────▼─────┐
              │   Caddy   │  TLS (ACME), HTTP/2+3, compression, security headers, body limit
              └──┬─────┬──┘
   app.<domain>  │     │  api.<domain>
           ┌─────▼──┐ ┌▼──────────┐        outbound: FMP, Stripe, SMTP, Google OAuth
           │  web   │ │ api ×2    │◄──────────────────────────────────────────┐
           │ Next.js│ │ NestJS    │                                           │
           └────────┘ └──┬────┬───┘                                           │
                         │    │        ┌───────────────────────────────────┐  │
                         │    │        │ worker (supervisor)               │  │
                         │    │        │  backtest ×4 · monitor · market   │──┘
                         │    │        │  data · stock EOD                 │
                         │    │        └──────┬───────────────┬────────────┘
                    ┌────▼────▼──┐            │               │
                    │ PostgreSQL ├◄───────────┘               │
                    │     16     │   (data network: no route out, nothing published)
                    └────────────┘                     ┌──────▼─────┐
                                      api ────────────►│  Redis 7   │
                                                       └────────────┘
```

The queue is PostgreSQL (`BacktestJob`, advisory-lock admission, 60 s leases) — no broker; no
Kubernetes. Four backtest processes are the four global slots.

### Exact hardware

**One host: 8 dedicated vCPU, 32 GB RAM, ≥ 240 GB local NVMe** (e.g. Hetzner Cloud CCX33). Measured
basis (`architecture.md` §3): one core per executing backtest, flat out; per backtest process 0.5 GB
executing, 2.1 GB rebuilding, up to 3.4 GB hydrating first-time securities — **11.9 GB for four
hydrating at once**, the high-water mark; Redis 1.30 GB with both tiers full; PostgreSQL ≤ 39
connections and well under a core. Four cores serve the four slots and four serve everything else — two of them the two API processes
(one core each at saturation, §C).
On a 4 vCPU host the four backtests take every core: there, set `BACKTEST_GLOBAL_MAX_RUNNING=2`.

| Single host (recommended for launch)                         | Separated                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| cheapest; no network between API, workers, PostgreSQL, Redis | managed PostgreSQL adds backups/PITR/failover, isolates the database from backtest CPU     |
| one failure domain; recovery is a restore                    | ~2× the cost; network latency on every frame read (PostgreSQL `STORE` reads, rebuilds)     |
| fits the measured load with headroom                         | a second worker host adds availability, not throughput: the cap stays four deployment-wide |

### Deployment configuration

`deploy/production/docker-compose.yml` (limits from the measurements: worker 16 GB / 5 CPU with a
2 GB V8 heap per process, PostgreSQL 6 GB / 3, Redis 4 GB / 1 with `maxmemory 3gb` and `noeviction`,
two API processes at 2 GB / 2 each, web 1 GB / 1, Caddy 256 MB — 31.25 GB in all); tuned
`postgresql.conf` (`max_connections` 100 against an 84-connection budget, WAL for PITR,
`pg_stat_statements`); `redis.conf` (RDB `save 900 1 / 300 100000`); Caddy; per-service secrets in
`/etc/factorsage/*.env` from the committed templates; `deploy.sh` (dump, migrate, roll), health checks
on every service, graceful stop periods longer than each process's own (worker 45 s against the
supervisor's 30 s), read-only containers with `no-new-privileges`, an internal data network with no
route out. Key settings: `BACKTEST_GLOBAL_MAX_RUNNING=4`, `BACKTEST_WORKER_PROCESSES=4`,
`BACKTEST_QUEUE_MAX_QUEUED=100`, `STOCK_LRU_MAX_SECURITIES=500`,
`BACKTEST_NON_RESIDENT_FRAME_READ=STORE` (default).

**Built and deployed on the development machine** (`benchmark-results/compose-smoke.log`, driver
`drivers/compose-smoke.sh`), from a clean checkout's files, with throwaway secrets:

| Check                                   | Result                                                                                                                                                                                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Images                                  | api, worker, web 1.2 GB each, migrate 2.3 GB (the unpruned build stage); 2.3–2.9 min for the first, seconds for the rest (shared layers); all run as `node`; no `.env`, storage state or local stack state inside                                           |
| `deploy.sh`, first deploy and re-deploy | both **exit 0** (26 s, 6 s), each after its backup; the re-deploy recreated nothing                                                                                                                                                                         |
| Services                                | caddy, web, api, api-2, worker, PostgreSQL, Redis running and healthy; the migration job applied 55 migrations and exited 0; the worker started its seven children                                                                                          |
| Edge (Caddy)                            | `/health` 200; `/health/ready` 404 from outside; web 200; HTTP → HTTPS `308`; HSTS set, `Server` removed; a 2 MB body `413`                                                                                                                                 |
| API readiness (inside)                  | PostgreSQL ok, Redis ok, eviction policy `noeviction` (SAFE)                                                                                                                                                                                                |
| One API process stopped                 | 20 of 20 health checks answered by the other                                                                                                                                                                                                                |
| Graceful stops                          | worker exit 0 in 1 s; web exit 0; API in ~1 s, exit 143 (NestJS re-raises the signal after its shutdown hooks; a SIGKILL would be 137 after the 20 s grace); a request in flight during the API's stop was answered (HTTP 400), the stop waiting 8 s for it |
| Backup / restore scripts                | each deploy's backup taken and verified (`pg_restore --list`); `restore-postgres.sh` restored it into a new database (55 of 55 migrations) and refused to restore over an existing one                                                                      |
| Secrets                                 | none of the generated passwords or the JWT secret in any log                                                                                                                                                                                                |
| Idle memory                             | worker 338 MB (seven processes), PostgreSQL 182 MB, each API 77 MB, web 67 MB, Caddy 16 MB, Redis 4 MB                                                                                                                                                      |

The first three runs found three defects that would have stopped a real deploy — Redis refused
`redis.conf`, the `api.env` template made the API crash-loop, the web image could not start — and
the fourth passed with all three fixed. Two more were found beforehand by reading the scripts
(§G): a first deploy aborted (the fourth run's first deploy passed), and a release web build could
never receive the legal facts (a web test now checks that every fact is a build argument; no facts
were passed here).

**Not exercised:** public ACME certificates (Caddy served `*.localhost`
from its own CA); a **release** web image — the legal guard refuses it (16 blockers, P0-4), so the
web image was a non-release build of the same code; a backtest (the database was empty, and no
provider key was given); the worker's 5-CPU limit (Docker refuses more CPUs than this 4-CPU machine
has, so it was capped at 4 here).

**Nothing was provisioned or deployed** (not approved).

### Monthly costs

List prices checked 2026-10-23 through third-party trackers of the providers' pages (Hetzner repriced
on 2026-04-01 and 2026-06-15), excluding VAT — verify at order time.

| Option                                     | Components                                                                                | ≈ Monthly     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------- |
| **A. One host (recommended)**              | Hetzner CCX33 €138.49 + IPv4 + Storage Box BX11 (1 TB, off-host dumps) €3.20              | **≈ €145**    |
| A elsewhere                                | DigitalOcean General Purpose 8 vCPU/32 GB $252; AWS m7i.2xlarge ≈ $294 + 250 GB gp3 ≈ $20 | $260–330      |
| B. App host + managed PostgreSQL           | CCX33 + managed PostgreSQL 4 vCPU/16 GB (DigitalOcean ≈ $270)                             | ≈ €145 + $270 |
| C. B + a second worker host (availability) | B + a second CCX33                                                                        | ≈ €285 + $270 |

### Backup and recovery

| Layer                        | Mechanism                                                                                                                                                                     | RPO                                                         | RTO                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL (state of record) | nightly custom-format zstd dump verified with `pg_restore --list`, copied off-host (`deploy/production/scripts/backup-postgres.sh`); a dump before every deploy (`deploy.sh`) | 24 h; minutes once WAL archiving is added (recommended, P1) | measured on 4 vCPU: the 24.4 GB benchmark database dumped in **8.2 min to 3.2 GB**; its largest table (21.5 M rows, 4.0 GB) restored in **65 s** with four jobs, 0 errors; the whole database ≈ 7 min at that rate (estimate, not measured) (`benchmark-results.md` §9); `RUNBOOK.md` §7 is the drill on production data |
| Redis (disposable)           | RDB snapshot only to shorten restarts; never backed up                                                                                                                        | none needed                                                 | 15.5 s warm / 112.7 s cold restart for 1.24 GB; total loss: protected tier rebuilt in 14.6–16.2 min (4 vCPU) while reads are served from PostgreSQL                                                                                                                                                                      |
| Backtest queue               | rows in PostgreSQL, recovered by lease expiry (60 s)                                                                                                                          | 0                                                           | a killed worker's run was claimed again 81 s after the kill (60 s lease + the next claim) and re-executed from its first day with the same result, warm and mid-rebuild (§D)                                                                                                                                             |
| Secrets                      | `/etc/factorsage/*.env`, root-only, outside images and the repository                                                                                                         | —                                                           | from the operator's secret store                                                                                                                                                                                                                                                                                         |
| Code                         | images tagged per release                                                                                                                                                     | —                                                           | redeploy the previous release                                                                                                                                                                                                                                                                                            |

---

## F. Capacity planning

From `capacity-model.md` (computed by `capacity-model.ts` from the measured runs and the stated
assumptions A1–A10). The binding resource is the **four execution slots**, a product rule that does
not grow with hardware.

- **Service time** of a run = its measured warm time four-at-once + 4.31 s of slot time per member
  not resident in Redis (the conservative end: 2.4 s was measured when runs rebuild distinct
  members); the slots form an M/G/4 queue (Erlang C, Allen–Cunneen); a mix's capacity is the largest
  DAU whose peak hour stays at ≤ 70 % utilization and ≤ 15 min p95 wait.
- **The largest unknown is the share of cold (non-resident, non-canonical) members**, which depends on
  how many distinct non-S&P securities users' lists span against the 500-security LRU. It moves
  capacity 3–12×, so every result is given at 0 %, 25 %, 50 % and 100 % cold.

| Mix (Free/Starter/Pro/Pro+ of DAU) | Max DAU, cold 0 % | 25 % | 50 % | 100 % | MAU at 0 % / 50 % | Completed runs/h, all slots busy (0 % / 50 %) |
| ---------------------------------- | ----------------: | ---: | ---: | ----: | ----------------- | --------------------------------------------: |
| Mostly Free (85/10/4/1)            |             2,797 |  869 |  514 |   270 | ~11,200 / ~2,100  |                                     619 / 114 |
| Mostly Starter (30/60/8/2)         |             1,325 |  404 |  238 |   127 | ~5,300 / ~950     |                                      450 / 81 |
| Mostly Pro (20/20/55/5)            |               386 |  108 |   62 |    32 | ~1,500 / ~250     |                                      212 / 35 |
| **Mixed (60/25/12/3)**             |         **1,091** |  315 |  184 |    94 | ~4,400 / ~740     |                                      340 / 58 |
| High Pro+ (40/20/20/20)            |               302 |   82 |   47 |    22 | ~1,200 / ~190     |                                      166 / 26 |
| Market-close peak (mixed, 25 %/h)  |               523 |  151 |   88 |    45 | ~2,100 / ~350     |                                      340 / 58 |

- **Queue waits (mixed):** at 1,000 DAU with everything resident, utilization 64 %, p95 wait 1.1
  min; with half the non-canonical members cold, 100 DAU wait p95 1.0 min, 250 DAU 79 min.
- **All four slots occupied for an extended period:** the 100-run queue bound fills in 35–71 min at
  125–150 % of capacity (mixed, all resident); the 100th queued run waits 18 min (104 min at 50 %
  cold); further submissions get `503 BACKTEST_QUEUE_FULL` with `Retry-After` — measured in §C.
- **Concurrent browsing** at those DAU (A7, 3.75 % of DAU) is ~40 users for the mixed mix with
  everything resident, ~105 at most (mostly Free) — within the ~100 that two API processes serve at
  p95 ≤ 1 s (§C), so the slots bind first.
- **Active Monitors and FMP:** 300 enabled Monitors (9,000 members over 500 watched securities)
  cost 253–258 s of end-of-day preparation and a 19–20 s Monitor pass per session, ~1.5× both beside
  four backtests on 4 vCPU (`benchmark-results.md` §7) — ~0.5 s per watched security and ~2.2 ms per
  member, so 5,000 watched securities would need ~40 min after each close and the fair-use ceiling
  of 100 Monitors per account (3,000 members) ~7 s of a pass. FMP per security: a first-time
  security ~22 requests (real sample: 66 for 3), daily maintenance ~2 per session, a rebuild ~0.6;
  the 20 req/s gate makes a first-time 1,000-security list 7–18 min of provider time.
- **Cost per active subscriber:** ≈ €145/month for the host; at the mixed mix's capacity ≈ €0.08 per
  paying subscriber per month (all resident) to ≈ €0.47 (half cold). The queue, not the bill, is the
  constraint.
- **Confidence:** measured service times and memory: high (repeatable, identical digests); the
  production host's speed-up over this machine: not measured; usage assumptions (A1–A7, A10): low
  until real usage exists — the model is a script, re-run it with production numbers.

---

## G. Risks

### Fixed during this work (evidence of each fix in the section named)

| Found                                                                                                                                                                                            | Fix                                                                                                                                                 | Evidence after                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A list with more ordinary members than the LRU rebuilt every member in every year window (one window: 1,418.7 s)                                                                                 | windows read such members from PostgreSQL (`STORE`, default)                                                                                        | same window 5.2 s, same digest (§B.5, §D)                                    |
| A Redis restart failed every executing run within a second                                                                                                                                       | backtest workers wait ~2 min for Redis (`BACKTEST_REDIS_MAX_RETRIES_PER_REQUEST`), unit-tested                                                      | 15 s restart under four runs: all completed, same digests (§D)               |
| One API process kept p95 ≤ 1 s only to ~20–30 concurrent users                                                                                                                                   | two API processes behind Caddy                                                                                                                      | 100 users: p95 3.4 → 0.8 s (§C)                                              |
| Worker memory limit (12 GB) below the measured four-way first-time hydration (11.9 GB + the other children)                                                                                      | worker 16 GB, 2 GB V8 heap per process; limits rebalanced within 32 GB                                                                              | `architecture.md` §3.2                                                       |
| The load API refused to start (half-inherited SMTP settings); the live probes sent an invalid body                                                                                               | tooling fixes                                                                                                                                       | probes 16 / 16 (§C)                                                          |
| 19 E2E failures: fixtures and specs still encoding the V1 limits (a pinned run held Pro's now-only slot; Starter's three Monitors; plan-specific history depths)                                 | fixtures and specs brought to the final matrix                                                                                                      | full suite 362 / 362 (§A)                                                    |
| **Redis refused the production `redis.conf`** — a trailing comment on two lines reads as extra arguments — so Redis, and with it the whole stack, would never have started                       | comments on their own lines; the file loaded by `redis:7.4-alpine` before every run                                                                 | the Compose run (§E, `compose-smoke.log`)                                    |
| **The production web image could not start**: `next start` loads `next.config.ts`, which needs the `typescript` package, and the runtime image prunes development dependencies                   | `typescript` is a dependency of the web app (the lockfile moves the same 5.9.3 entry)                                                               | the Compose run (§E)                                                         |
| **The committed `api.env` template crash-looped the API**: it set `GOOGLE_CALLBACK_URL` with the optional Google id and secret empty, and the API accepts all three or none                      | the optional lines commented out                                                                                                                    | the Compose run (§E)                                                         |
| `deploy.sh` aborted on a first deploy (it backed up a database container that did not exist yet); `backup-postgres.sh` ignored `compose.env`'s `BACKUP_DIR`                                      | the database started before the backup; the directory read from `compose.env`                                                                       | two deploys with `deploy.sh` (§E)                                            |
| The production web image could not take the legal operator facts, so a release build could never pass its legal guard; building the api, worker and migrate images ran the web release build too | the ten facts are build arguments (a web test checks every registered fact is declared); `BUILD_WEB=false` for the other images, the web build last | the four images built (§E); `owner-facts.test.ts` checks the build arguments |
| A Monitor integration test depended on state the hermetic E2E stack leaves in the shared test database                                                                                           | the test starts from no recorded session                                                                                                            | the gate (§A)                                                                |

### P0 — before launch (owner actions; no code defect is open)

| #    | Risk                                                                                                                                                                                                                                                                     | Evidence                                                                                                               | Action                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | **The live V2 Stripe catalog does not exist yet.** The six V2 prices exist in the sandbox and pass every sandbox suite (§A); the cloud environment's `SANDBOX_STRIPE_PRICE_*` settings still name the V1 prices, so these runs passed the V2 ids on the command line     | §A, "Stripe integration status"; `docs/development/claude-cloud-environment.md`                                        | create the six live prices (two per product, the amounts in `entitlements-v2.md` §2), set the six `STRIPE_PRICE_*` in `api.env`, run the catalog check before deploying (`RUNBOOK.md` §4); point the cloud environment's six `SANDBOX_STRIPE_PRICE_*` at the V2 sandbox ids and move the V1 ids to `SANDBOX_STRIPE_LEGACY_PRICES` |
| P0-2 | **Existing subscribers on retired prices** fall to Free at their next reconciliation unless listed                                                                                                                                                                       | billing integration suite, "subscribers on a retired price" cases                                                      | list every V1 price id in `STRIPE_LEGACY_PRICES` before the first deploy                                                                                                                                                                                                                                                          |
| P0-3 | **Nothing has run on production hardware**: the real database's restore time, the host's speed-up and the alerts are unmeasured                                                                                                                                          | §E; `RUNBOOK.md` §7                                                                                                    | provision, deploy, run the restore drill and `bench:scale-backtests` on the host before opening sign-ups                                                                                                                                                                                                                          |
| P0-4 | **The legal pages are not approved**, so no release web image can be built: `pnpm legal:check` lists 16 blockers — ten operator facts (entity, address, identifiers, contacts, supervisory authority, governing law, dispute resolution) and six documents still `DRAFT` | `pnpm legal:check` (2026-10-24); a release web build stops on them by design (`apps/web/src/lib/legal-release.ts`, §E) | supply the ten `NEXT_PUBLIC_LEGAL_*` facts as build arguments and approve the six documents (`docs/legal/owner-inputs-and-review.md`); then build the release web image                                                                                                                                                           |

### P1 — fix soon after launch, or launch with the stated mitigation

| #    | Risk                                                                                                                                                                                                        | Evidence                                                                                                          | Mitigation / fix                                                                                                                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-1 | **Members outside both cache tiers are expensive**: preparation rebuilds each one's whole history into Redis, 2.4–4.3 s of slot time per member; a Pro+ run of 1,000 ordinary securities takes 28 min alone | §B.5; capacity moves 3–12× with the cold share (`capacity-model.md` §3.2)                                         | launched with `STORE` windows (done); next, read LRU-tier members' windows from PostgreSQL in preparation too (~1.2 s per security estimated from measured parts), or raise `STOCK_LRU_MAX_SECURITIES` (~0.74 MB per real security) |
| P1-2 | **First-time securities are downloaded inside an execution slot**, and a sustained provider rate limit fails the run                                                                                        | §B.4: 3.3 s of slot per security; four runs sharing 400: 18.2 min; a 90 s `429` outage failed a run 3.6 s in (§D) | hydrate before admission (outside the slots) or cap first-time securities per run; a clearer failure message than `EXECUTION_FAILED` for a provider limit                                                                           |
| P1-3 | **Long-tail Stock Details pages rebuild a whole history inside the API request** (2–6 s light, up to 28 s at 100 users on one process); the resident page is 0.39 MB                                        | §C, `benchmark-results.md` §6                                                                                     | two API processes (done); serve the page from PostgreSQL without the full rebuild (the `STORE` path), trim or cache the payload                                                                                                     |
| P1-4 | **Memory is the tightest resource**: ≈ 16 GB of workers in the worst measured coincidence on a 32 GB host                                                                                                   | §B.4, `architecture.md` §3.2                                                                                      | the 80 % worker-memory alert (`RUNBOOK.md` §5); a 64 GB host (CCX43, ≈ €276/month) if it fires                                                                                                                                      |
| P1-5 | **RPO is 24 h**: no WAL archiving                                                                                                                                                                           | `RUNBOOK.md` §6                                                                                                   | add WAL-G/pgBackRest to the off-host store (`wal_level = replica` is already set)                                                                                                                                                   |
| P1-6 | **The premium catalog is one item** (the S&P 500 PIT universe) while the pricing card advertises premium lists, strategies and universes                                                                    | `docs/decisions/entitlements-v2.md` §11.3                                                                         | curate premium built-ins before launch, or narrow the card's wording                                                                                                                                                                |
| P1-7 | **No metrics endpoint**: queue depth, LRU churn, provider-gate saturation and API event-loop delay are visible only in logs and database queries                                                            | `architecture.md` §6                                                                                              | log-based alerts at launch (`RUNBOOK.md` §5); `/metrics` as a follow-up                                                                                                                                                             |
| P1-8 | **Measured on synthetic data, on half the production host**                                                                                                                                                 | `benchmarks.md`                                                                                                   | re-run the harness on the production host with real data (P0-3)                                                                                                                                                                     |

### P2 — known, low impact

| #    | Risk                                                                                                                      | Evidence                                    | Note                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| P2-1 | PostgreSQL connection exhaustion fails executing runs (re-run)                                                            | §D: 85 outside connections, all four failed | by design; our own pools use 84 of 100; the > 80 % connection alert                                                          |
| P2-2 | A Redis restart makes the API answer `503` for its duration (~11 s measured)                                              | §C                                          | restart Redis only in a maintenance window; the snapshot keeps the cache                                                     |
| P2-3 | Worker event loops stall up to 6.9 s during preparation                                                                   | `benchmark-results.md` §2                   | no HTTP is served by workers; the 60 s lease tolerates it                                                                    |
| P2-4 | The queue bound overshoots by the number of simultaneous submissions racing it                                            | §C: 102 against 100                         | documented; it is backpressure, not an entitlement                                                                           |
| P2-5 | The Monitor end-of-day path takes ~1.5× as long beside four backtests on 4 vCPU                                           | `benchmark-results.md` §7                   | on 8 vCPU it has cores of its own; the 07:00 ET alert                                                                        |
| P2-6 | The usage assumptions (A1–A10) are guesses until real usage exists                                                        | `capacity-model.md` §2                      | the model is a script: re-run it with production numbers                                                                     |
| P2-7 | No Pro+ QA persona in `packages/testing/src/personas.ts`                                                                  | `entitlements-v2.md` §11.6                  | integration suites use their own Pro+ fixtures                                                                               |
| P2-8 | Images are large: api, worker and web 1.2 GB each (the whole pruned workspace), migrate 2.3 GB (the unpruned build stage) | §E                                          | size costs pull time, not correctness; per-process images (Next.js standalone output, a pruned migrate stage) as a follow-up |
| P2-9 | The API logs no shutdown event: a graceful stop shows only in its exit code and timing                                    | §E, `compose-smoke.log`                     | add `api.shutdown.*` events                                                                                                  |

---

## H. Final verdict

### READY WITH LIMITATIONS

The software and its deployment configuration are ready: every requirement below is implemented
and was measured or tested, the validation gate passes, and no code defect found by this work is
open. What stands between this branch and paying users are owner actions that no code change can
make (§G, P0), and operating limits to launch with knowingly (§G, P1).

| Requirement                                                                                             | Status                                                                                                                                                                                  | Evidence           |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Final entitlement matrix, one server-side policy, bypass-resistant, atomic                              | **met**                                                                                                                                                                                 | §A, probes 16 / 16 |
| Pricing (Best Value, Advanced Research, Parallel Backtests with its limit, no speed or priority claims) | **met**                                                                                                                                                                                 | §A                 |
| Stripe synchronisation, six prices (monthly and yearly)                                                 | **met in the Stripe sandbox**: catalog, smoke, lifecycle and persona suites pass on the V2 prices; the live catalog is not created yet                                                  | §A, P0-1           |
| At most four backtests executing deployment-wide; durable, cancellable, crash-safe, fair, bounded queue | **met**: a killed worker's run re-executed once, 81 s later, same result; `503` + `Retry-After` at the bound                                                                            | §B.2, §C, §D       |
| `STOCK_LRU_MAX_SECURITIES=500`                                                                          | **met**, after fixing the contention it caused (one window 1,418.7 s → 5.2 s)                                                                                                           | §D                 |
| Four simultaneous 1,000-security, 30-year backtests                                                     | **met**: 2.6 min warm, 21.3 min from an empty Redis, 18.2 min with 400 first-time securities at 11.9 GB of worker memory (16 GB limit)                                                  | §B                 |
| The application stays responsive beside four backtests (5–100 users)                                    | **met** with two API processes (p95 0.80–0.85 s at 100 users); one process keeps p95 ≤ 1 s only to ~20–30                                                                               | §C                 |
| Production architecture, configuration, health checks, graceful shutdown, limits                        | **met**: the images built and the stack deployed with `deploy.sh` on the development machine, every check passing after the fixes in §G; **not provisioned or deployed** (not approved) | §E                 |
| Capacity model                                                                                          | delivered as a script; usage assumptions unvalidated                                                                                                                                    | §F                 |
| Failure and recovery                                                                                    | **met**; PostgreSQL exhaustion and a sustained provider rate limit fail executing runs by design (re-run)                                                                               | §D                 |

**Before launch (P0):** create the live V2 Stripe catalog — six prices — and check it (P0-1); list the
retired prices in `STRIPE_LEGACY_PRICES` (P0-2); supply the legal facts and approve the legal
documents, without which no release web image can be built (P0-4); provision the host, deploy, and
run the restore drill and the benchmark harness on it (P0-3).

**Launch with, knowingly (P1):** capacity moves 3–12× with how many list members lie outside both
cache tiers, each costing 2.4–4.3 s of slot time (P1-1) — the first number to watch in production;
first-time securities are downloaded inside a slot (P1-2); memory is the tightest resource of the
32 GB host (P1-4); the RPO is 24 h until WAL archiving (P1-5); every scale number comes from
synthetic data on half the production host (P1-8). At the mixed plan mix the four slots serve
~1,100 daily active users with everything resident and ~180 with half of the non-canonical members
cold (§F), for ≈ €145 a month.

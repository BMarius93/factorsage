# Monitor EOD V2 — product and architecture proposal

**Status:** DRAFT FOR READ-ONLY AUDIT — NOT ACCEPTED, NOT IMPLEMENTED  
**Prepared:** 2026-10-14  
**Base:** `main` (branch `docs/monitor-eod-v2-audit`)  
**Scope:** Monitor semantics, stock EOD preparation, initialization/replay, Signal read models, Dashboard and Monitor UX. No code or migration changes in this documentation branch.

This is a **proposed V2 change**, not a restatement of what is already implemented. In particular, current V1 documents and code deliberately use 5-minute current-data scans, apply List Buy Windows to BUY only, and persist only the final result of initial historical reconstruction. An audit must identify and reconcile every conflict **before** V1 canonical documents are superseded.

## 1. Product intent and non-goals

A Monitor remains a live configuration binding one **Strategy** to one **Stock List**, with the same canonical BUY / SELL / FINAL EXIT levels and Conditions / Trigger state machine. It is **not** a portfolio, a broker, forward-testing performance, an independent discovery engine, or a new strategy language. `Gain` / `Loss` rules remain excluded when they require an unknown position cost basis.

**V2 intent:**
- Evaluate against finalized **end-of-day (EOD)** observations, once per exchange session, instead of repeatedly on provisional intraday quotes.
- Let users see both *what is active after the latest evaluated session* and *which important transitions happened recently*.
- Give a newly created Monitor a useful **90-calendar-day historical Signal/transition view** immediately.
- Reuse existing canonical PostgreSQL price/derived-data storage, Redis stock cache and LRU, benchmark/ETF residency, FMP traffic gate, Strategy evaluator, lifecycle reducer, durable worker ownership and error recovery.
- Keep the three developer entry points `pnpm run dev:api`, `pnpm run dev:web`, and `pnpm run dev:worker`. Additional child processes supervised inside `apps/worker` do **not** mean a fourth top-level service.

**Out of scope:** real-time quotes, user-configurable scan frequency, push/email notifications, portfolio positions/P&L, Discovery, daily condition-value snapshots, broad subscription/entitlement redesign, full-history backfill of every closed historical Signal, or rewriting the Backtest PIT semantics.

## 2. Monitored List eligibility — a deliberate breaking change

**Target V2 rule:** The **monitored universe** is the List members whose **current, ongoing membership** has `End = Present`; this gate applies to the **whole Strategy**, including BUY, SELL and FINAL EXIT, before evaluating any level.

Canonical representation (see `ai/product/lists.md`):
- `FULL` / "Always eligible": considered an ongoing member, eligible for current monitoring.
- `CUSTOM`: at least one range with `endDate = null` ("Present") **and** `startDate <= target session`. An open-ended range whose start is in the future is not eligible yet.
- Only bounded/ended ranges: **not** a current Monitor member, even if the end is a future fixed date. `Present` is a specific open-ended semantic, not a comparison with today's date.
- Where there are multiple ranges, find the **qualifying ongoing range** without flattening or losing older periods.
- The 90-day initialization for an eligible member must not evaluate sessions before its current open-ended membership began; handle gaps/re-entry deterministically. Audit whether older closed periods have any legitimate replay role for rule-local state without displaying them as V2 monitoring history.

An ineligible member must not emit a BUY, SELL, or FINAL EXIT. When an existing member becomes ineligible because a List was edited, close/drop affected persisted state by the existing administrative lifecycle rules, preserve audit history, and **never** label that change "Conditions ended". Similar care is required for member removal, strategy edits, rebind, enable/disable, entitlement blocking and built-in publication/visibility.

This differs from the **current accepted V1 implementation**, where `eligibleOn()` in `apps/worker/src/monitor/level-decision.ts` gates BUY only, and where SELL and FINAL EXIT are not buy-window-gated. Backtests **must continue to retain their current PIT BUY-window behavior**; V2 Monitor universe selection must not accidentally modify it.

## 3. EOD data readiness and evaluation

### 3.1 One session, not one timed scan

- Resolve the expected completed session using the canonical trading calendar, exchange/session identity and DST-aware close. Do not equate a UTC date with a market session.
- The existing ETF refresh uses a ~10-minute schedule, a close + 30-minute publication safety delay and >=30 minutes between provider re-reads of a not-yet-published series. **Reuse these conventions as defaults**, not the assumption that every series is guaranteed published at close + 30 minutes.
- A cheap scheduler check may run every ~10 minutes; it must mostly inspect durable **PostgreSQL readiness/watermarks**, not call FMP every check.
- Only query the provider for the **deduplicated union of symbols** required by currently eligible, effectively running Monitors, and only when canonical freshness/coverage says their EOD data needs a refresh. If 100 Monitors reference AAPL, there is only one AAPL data preparation for the session.
- Refresh bounded price tails through the existing stock-data/Redis/FMP coordination and global provider rate/concurrency limits, not a fresh provider client or a Monitor-specific cache.
- A stock's required EOD price bar must correspond to the target session and be verified after that session's accepted finalization threshold. "Latest cached date is today" alone is **not** adequate because FMP can expose provisional same-day bars.
- Conditions using benchmark ETFs / Stock's Sector need **same-session finalized** corresponding ETF data; never substitute yesterday's ETF observation for today's stock observation. The existing 20 ETF histories remain PostgreSQL-canonical and Redis-resident; stocks retain their bounded LRU.
- Distinguish **missing EOD price**, **provider unavailable**, **history/indicator warm-up**, and **intrinsically NOT_EVALUABLE operands**. Missing input must never be treated as Conditions false or resolve an active occurrence. The audit should decide the exact retry/finality rules for late fundamental/alternative data and mixed per-level evaluability.
- No work should re-download prices merely because Redis evicted an LRU stock; rehydrate from PostgreSQL when it contains the canonical required data.
- Provider corrections, stock split / price-basis generations and ETF generation changes must follow existing consistency fences and be explicitly addressed for already evaluated sessions.

### 3.2 Incremental, recoverable evaluation

- Reuse the canonical evaluator and `stepMonitorLevel` lifecycle, including triggers, FINAL EXIT OR rules and partial/unknown observations.
- Evaluate **each relevant Monitor × security × level × actual session at most once successfully**; ensure retries, restarts and overlapping leases do not duplicate transitions or occurrences. Do not reinterpret this as one scan per calendar day.
- Do **not** globally block all Monitors because a few symbols are late. Process ready securities and keep unready ones pending, using a durable per-session checkpoint granularity sufficient to retry gaps.
- Replay missed sessions **in chronological order** after outages; don't jump from Monday to Thursday and lose a Tuesday trigger. A successful evaluation must be based on the correct preceding session/lifecycle.
- A session with no trading, no published observation, or an unavailable dependency cannot move a signal to RESOLVED by itself. Mark progress honestly; do not mark a Monitor fully fresh if it is only partially processed.
- A user-facing readiness indicator can say `EOD 2026-10-13 · 497/500 evaluated` when appropriate; don't call the result "live market data".

### 3.3 Worker/process boundary

Keep exactly three developer services: API, Web and Worker. `apps/worker/src/index.ts` already supervises independent `backtest`, `monitor` and `market-data` **child processes**.

**Hard boundary:** Provider-intensive EOD stock preparation must be decoupled from Monitor evaluation. The Monitor evaluator should consume persisted, ready canonical EOD data and should not be the owner of bulk FMP refresh.

**Candidate design, subject to audit:** Add a `stock-eod` supervised child with its own durable claim/retry/checkpoint protocol, or extend the existing `market-data` child if the auditor demonstrates equal isolation, bounded scheduling and simpler operations. Do **not** create a fourth top-level service, new Redis queue, new microservice, or independent price cache. Favor existing PostgreSQL claim/lease conventions, and account for shared physical CPU, DB connections, Redis memory, and FMP budgets.

The audit must distinguish a new **process kind** from a new **instance/container/server** and quantify the simpler option.

## 4. Initial historical reconstruction: 90 calendar days

When a Monitor is **first created**, initialize the most recent **90 calendar days**, ending at the most recent finalized EOD session. The user sees actual historical activations and resolutions from those sessions rather than only the current reconstructed state.

Correctness requirements:
1. Establish the **exact lifecycle state at the start of the 90-day display window** using sufficient earlier closed-session history. Reuse the existing exact reconstruction approach (currently starts near 252 closed sessions and doubles until a resting point/full canonical history). **A 90-day cutoff cannot reset a longstanding latched Trigger or Active Signal.**
2. Reuse the same canonical Strategy evaluator, buy-window/monitor-membership policy and lifecycle reducer on every session in the 90-day window; do not implement a parallel "historical signal detector".
3. Load each symbol's required frame once per preparation/replay batch (with appropriate indicator/fundamental lookback), evaluate sessions in memory; do not hydrate/fetch once **per day**. Respect Redis LRU without permanently pinning all watched stocks.
4. Persist meaningful historical **Signal occurrences and state transitions** (activations and resolutions), plus the exact terminal current state. Do not persist repeated `ACTIVE -> ACTIVE` on every historical day.
5. Mark initial historical occurrences/transitions as **reconstructed** or equivalent verifiable origin. Their **session dates** stay true; processing timestamps are never substituted for when the events occurred.
6. Do **not** emit historical initialization activity as "new today" in the global Dashboard feed or future notifications. Historical rows are visible in the Monitor's own history, labeled `From history`.
7. Ensure an atomic/idempotent unit and resume/retry strategy: a crash halfway through the window must neither double insert transitions nor leave the lifecycle inconsistent with the history. Guard config/strategy versions and changed list membership while replaying.
8. If canonical PIT history or a required input is unavailable, report `NOT_EVALUABLE`/incomplete with a clear policy. No invented matches, no zero as a stand-in for unavailable intrinsic value, no future-known fundamentals.
9. Handle sessions where a qualifying open-ended List membership was not yet effective, including new listings and multi-period members.
10. Backfill **only on initial creation** in V2. Editing/rebinding/re-enabling should follow existing targeted lifecycle reset/reconstruction and reconciliation behavior **without regenerating 90 days of events**. Any mismatch in current semantics, especially missed-session replay on re-enable, is an explicit audit finding rather than an excuse to erase past evidence.

The existing V1 initial reconstruction **does not** persist every replayed transition. It persists the final state, at most one reconstructed active occurrence and a small set of transitions. Therefore this is real new persistence/read-model work, not a config change.

## 5. Dashboard and Monitor UX

### 5.1 Dashboard

- Preserve the compact existing **Market Overview**: Benchmarks, Macro & Alternatives, Sector Performance. No redundant large Dashboard/Market Overview header/card; keep row density compact.
- Replace current-match-centric Dashboard presentation with a **single unified Monitor Activity** feed of *important observed changes*, filtered by Monitor and sorted descending by the **actual exchange session date of the transition**, with a deterministic stable tie-breaker.
- Mix visible **built-in** and **user-owned** Monitors in one feed, keeping built-in global execution and user visibility overrides distinct; guests see appropriate published built-ins.
- Show concise new BUY / SELL / FINAL EXIT activations and market-driven resolutions; don't repeat an unchanged active Signal every day.
- Keep administrative endings (`LOGIC_CHANGED`, `MEMBER_REMOVED`, `MONITOR_REBOUND`, etc.) separate from market activity; do not mislabel them market-triggered changes.
- Exclude initial 90-day reconstructed event batches from "new activity". Historical-origin records may be visible only in the Monitor's own history.
- Default to roughly **10–15 compact rows**, with a route to further history; no large "Current Matches" block competing with Market Overview.

### 5.2 Monitor detail

- **One compact signal table, not Activity/Current Conditions tabs.**
- **ACTIVE signals first**, ordered most recent activation first; resolved occurrences follow, ordered most recent resolution first. Do not collapse multiple separate occurrences by the same stock/level.
- A row exposes **Stock | Signal/status | Date | Why**. Combine action + status (e.g. `BUY · Active`, `BUY · Conditions ended`) instead of spending a dedicated column on Status. Price and linked Strategy/List context may be compact secondary content, disclosure, or row details.
- Show the **real resolution reason**: `Conditions ended`, `Event ended`, strategy changed / member removed / rebind, etc. A bounded membership end is not a V2 market condition ending; the V2 universe restricts monitored members to an ongoing `Present` membership.
- **Why must work for both Active and Resolved**. For resolved events, explain what condition ceased to hold **using values from that historical decision** if those values can be accurately captured. Preserve general canonical `resolutionReason` if no numeric evidence is available; never recalculate from an edited Strategy or invent `RSI 39` without recorded evidence.
- Historical backfill appears here, marked `From history`. Include filtering for state/level and bounded pagination. `PENDING_TRIGGER` should remain accessible (e.g. filter), without turning every waiting setup into a noisy global Activity row.
- Display actual **last evaluated EOD session** and partial coverage, not "real-time/live" data. A small green Active indicator is fine; avoid continuously pulsing "live" as if prices stream intraday.
- Retain easy navigation to Stock, Strategy, List and Monitor, mobile card parity, and the existing read-only built-in/admin controls. Do not invent extra giant summary cards.

### 5.3 Data/read-model implications

The existing Dashboard rows are read from current durable state; V2 needs an **event/transition feed**. Audit API queries, access control, pagination, indices, built-in visibility, proper event ordering, signal origin, historical explanation persistence and response contracts.

## 6. Preservation and consistency constraints

- Reuse `@intrinsic/strategy` and `@intrinsic/stock-data` evaluation rules, exact signals, trigger latch and FINAL EXIT OR aggregation.
- Preserve Backtest Strategy semantics, immutable snapshots, price basis and PIT discipline.
- Preserve user/Built-in ownership, visibility, entitlements, enabled/paused semantics and security scope.
- Keep append-only Signal occurrence identity and ordered transition audit. Don't mutate past events on a Strategy/List edit; preserve logic fingerprint/configuration identity and explanations corresponding to their observation.
- Administrative closures must not become user-visible `Conditions ended` market events.
- Handle one stock in several Monitors separately at the **signal** level but share its input data acquisition; do not deduplicate distinct Monitor results.
- No Redis-only durability for events or checkpoints; PostgreSQL remains authoritative.
- Do not rewrite existing V1 decisions or migrate data until this design passes an evidence-based audit.

## 7. Audit-first request / unresolved design checks

The auditor must explicitly investigate and report:

1. **Current-to-target gap map**, with exact files/functions/schema/contracts/tests and evidence. Name contradictory accepted docs and proposed replacements.
2. **List `End = Present`**: `FULL`, CUSTOM/multi-period, future start, future bounded end, no currently open range, membership edited away, SELL/FINAL EXIT gating and historical start-date limits; distinguish this Monitor-only policy from Backtest.
3. **Per-session readiness**: stock price publication watermark vs cache latest date, ETF synchronization, exchange calendar and holidays, early close/DST, delayed/bad/no provider rows, late corrections and price basis. Assess whether the 10/30-minute defaults can be reused.
4. **Loader/Redis/FMP**: exact existing stock data read/refresh APIs, Redis LRU eviction behavior, provider gate, Redlock release failure recovery, unnecessary fetches, frame preparation and throughput with overlapping Monitors.
5. **Separate stock EOD ownership**: compare (A) an additional `stock-eod` child versus (B) extending `market-data`; evaluate supervisor wiring, durable checkpoint/lease recovery, scheduling, effect on Backtest and ETF refresh, DB/Redis/FMP contention and deployment commands. No fourth top-level service.
6. **Historical replay**: how to compute an exact state before the display window, persist a complete 90-day event chain, ensure origin separation and no duplicate writes on replay/retry/edits. Review current 252-session exact reconstruction algorithm and partial availability.
7. **Signal semantics**: trigger-only one-session lifecycle, condition-trigger latching, FINAL EXIT OR rules, `NOT_EVALUABLE`, membership changes, strategy version resets, disabled/re-enabled Monitors, user vs SYSTEM built-ins.
8. **Explanations**: how to capture truthful `Why` for a historical resolution and the event's actual observed price without massive daily snapshots or recalculating the wrong Strategy.
9. **UX/API**: unified Activity feed with built-in preferences and permissions, deterministic date sorting, compact single Monitor table with Active first, paginated history, stale/partial EOD freshness, mobile rendering.
10. **Capacity/cost**: provider calls/day, worst-case 100/500/1,000 distinct watched stocks, Redis LRU churn, incremental refresh run budget, 90-day creation bursts, memory and PostgreSQL connections.
11. **Migrations/rollout**: existing Monitor rows/Signals/transition history, existing V1 provisional quote-based signals, semantics/version boundary, historical provenance, a safe migration plan and rollback behavior.
12. **Test matrix**: hermetic unit, integration, E2E and failure-injection cases including FMP not published, missing date, cache eviction, provider throttling, lease takeover, restart during backfill, cross-Monitor dedupe, correction/re-base, weekend/holiday, and real-valued Why evidence.

**Required audit output (no code edits):**
- Verdict: `READY TO IMPLEMENT` / `READY WITH CHANGES` / `BLOCKED`.
- Findings ranked P0/P1/P2, each with concrete file references and consequences, not speculation.
- Proposed corrections/ambiguities and any explicit product decisions still needed.
- Minimal implementation plan as independent PRs (EOD source readiness/ownership; durable evaluation; 90-day replay; API/read models; compact UX; migrations/rollout).
- Clear acceptance tests and an approximate cost/capacity budget.
- **Do not implement, modify, commit, push, open PRs or silently resolve product trade-offs in the audit.**

## 8. Source-of-truth references for the auditor

- `ai/product/monitors.md` — canonical V1 Monitor lifecycle, edit/rebind and exclusions.
- `ai/product/lists.md` — `FULL` / `CUSTOM` and `Present = endDate:null`.
- `docs/decisions/builtin-dashboard-signals-v1.md` — V1 state machine, built-ins and Dashboard.
- `ai/architecture/monitor-engine.md` — current read/evaluate/replay/write path and Redis.
- `docs/decisions/etf-market-data-v1.md` — existing ETF EOD refresh and resident benchmark projection.
- `ai/architecture/api-worker.md` — process supervisor, durable claims and worker boundaries.
- `apps/worker/src/index.ts`, `apps/worker/src/monitor/*`, `apps/worker/src/market-data/*`.
- `packages/stock-data/src/service.ts`, `packages/stock-data/src/market-data-refresh.ts`, `packages/strategy/src/monitor-lifecycle.ts`.
- `apps/web/src/features/dashboard/components/DashboardPage.tsx`, `apps/web/src/features/monitors/components/MonitorDetail.tsx`, `apps/web/src/features/monitors/components/MonitorsPage.tsx`.

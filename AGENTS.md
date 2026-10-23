# IntrinsicValue Agent Rules

Read `ai/README.md` before substantial work.

## Product invariants

1. Historical index membership is reconstructed for **one** universe only: the S&P 500, into the
   built-in SYSTEM List `sp500-historical-pit` (`docs/decisions/sp500-historical-pit-v1.md`). Its
   canonical membership lives in PostgreSQL (`IndexConstituentChange`, `IndexConstituent`,
   `IndexMembershipPeriod`), reconstructed from the provider's index history and identity data,
   projected into CUSTOM buy windows by `pnpm data:index-universe -- project`, and never edited
   through the List routes. Membership is never invented and never substituted with today's
   constituents: a constituent the provider cannot price or identify is reported, not traded, and a
   boundary the provider's dates leave in doubt is placed so membership never starts early (§4 of
   the decision). No other index is synced or reconstructed. Point-in-time membership a user supplies is a different
   thing and is supported — see invariant 3.
2. Stock lists are static universes owned by a user or by the system (built-in content, see
   invariant 21); membership references the canonical `Security` catalog, never free-text symbols.
3. Each list membership defines buy eligibility:
   - `FULL` (no persisted ranges)
   - `CUSTOM` (one or more date ranges, persisted only in canonical normalized form —
     sorted, non-overlapping, non-adjacent, at most one open-ended; see `ai/product/lists.md`)

   A buy window is the period a member is eligible for **new BUY** actions; it never constrains a
   SELL or a FINAL EXIT, and nothing force-liquidates a position when one closes. The UI calls the
   concept **membership** and renders an open-ended window as `Present`; `buyWindow` remains the
   internal name everywhere else. Multiple periods are what make point-in-time index membership
   representable, and the single-period V1 editor must never silently discard the others.

4. Fundamental and intrinsic-value historical calculations must remain point-in-time correct and must not use future information.
5. Backtests are asynchronous long-running work.
6. API and worker are different processes, not different business implementations.
7. PostgreSQL is the durable source of truth.
8. Redis is disposable infrastructure and must not be the only store for completed/user-owned state.
9. Stock Details and Strategy conditions consume one canonical selectable-series catalog; do not
   duplicate indicator/model option lists in feature code. This includes labels and ordering: each
   series has exactly one product label, and no surface keeps a second label map or ordering array.
   Calculated series are stored as explicit PostgreSQL columns — see
   `docs/decisions/retain-wide-column-calculated-series-storage.md` for the accepted decision,
   `ai/architecture/calculated-series.md` for how it is implemented, and
   `docs/development/adding-a-calculated-series.md` to add one. The one scoped exception is the
   valuation ratios (P/E, P/S, P/B, P/FCF, EV/EBITDA): by the owner's decision they are never
   persisted per session and are projected when read, as Margin of Safety is, from stored prices,
   point-in-time statements, measured re-bases and the provider's split list
   (`docs/decisions/valuation-ratios-v1.md`).
10. `maximumPositions` belongs to a Backtest execution, not a Strategy. A full-position fraction is
    derived as `1 / maximumPositions`; do not introduce a user-entered max-allocation percentage.
11. Strategy signal semantics are defined in `ai/product/strategies.md`. Keep Strategy, Stock List,
    Backtest configuration and Backtest run as separate concepts. A Signal has zero or more
    Conditions plus at most one optional Trigger; Conditions are ANDed and the optional Trigger is
    ANDed with them for the same date. Do not silently add operators, metric/value compatibility,
    multiple triggers, or backtest execution parameters to the Strategy model. Strategy Builder and
    backend validation must share canonical compatibility definitions rather than maintaining
    separate matrices.
    **FINAL EXIT is the one level that may hold more than one Signal**: it is a single action
    reached by one or more alternative **Exit Rules**, ORed, each owning its own Signal and
    therefore its own optional Trigger. The supported grammar is exactly OR of AND groups, and only
    there — BUY and SELL keep one Signal each, there is no nesting, and there is no per-condition
    AND/OR choice. Whatever number of Exit Rules match on one date, FINAL EXIT is still **one**
    action, one level id, one trade and one Signal; it must never execute or emit twice. The
    persisted definition document is schema version 2; version 1 rows are upgraded at read time by
    `upgradeStrategyDefinitionDocument`, never rewritten, and a single-rule FINAL EXIT fingerprints
    identically to version 1 so no stored `definitionHash` or Monitor latch moves. A **frozen copy**
    of a definition — `BacktestRun.snapshot.strategy.definition` — is not covered by that read path
    and is projected at its own boundaries instead: the worker upcasts the document to execute it,
    the API canonicalizes it to answer its contract, and neither writes the row back.
12. A submitted `BacktestRun` snapshot is immutable and is the reproducibility authority. Nothing in
    a completed or running run may be re-derived from the current `Strategy`, `StrategyVersion`,
    `StockList` or `Benchmark` rows, and deleting any of them must never delete or reinterpret a
    run. Execution behaviour the product leaves open — candidate ordering, level firing, exits
    before entries, contribution timing, fees — is engine methodology with a version recorded in
    that snapshot; see `ai/architecture/backtest-execution.md`. Do not change one of those rules
    without bumping its version.
13. A Benchmark is a first-class concept, never a `Security` and never `Security.isBenchmark`. It is
    passive comparison data: never bought, never consuming cash or a position slot, and carrying no
    **stored** derived series — nothing derived from a benchmark is ever persisted, cached in a
    namespace of its own or requested from a provider. The one consumer of benchmark technicals, a
    Strategy Condition that names an ETF as its data source, computes them at evaluation time from
    the stored benchmark OHLCV through the stock calculation methodology, once per distinct ETF per
    backtest run or Monitor cycle, and discards them; see
    `ai/architecture/strategy-etf-conditions.md`. `BENCHMARK_CATALOG` in `@intrinsic/domain` is the
    one source of benchmark metadata, and a provider symbol never crosses an API contract. Benchmark loading reuses the
    canonical provider adapter, coverage reconciliation, hydration lock, provider gate and Redis
    projection principles under its own namespace; see `ai/architecture/benchmark-data.md`.
    **One infrastructure, several series.** `isActive` (does the system maintain it) and
    `isBacktestSelectable` (may a customer compare a portfolio against it) are different questions
    and are different columns: the market-reference indices the Dashboard cards used to show —
    `SP500_INDEX`/`^GSPC`, `DJIA_INDEX`/`^DJI`, `VIX_INDEX`/`^VIX` — are fully active system series
    that a user may never select, and a submission naming one is refused at the canonical boundary,
    not merely hidden from the picker. `seriesType` (`ETF_PROXY | INDEX`) says what the object _is_
    and belongs to the immutable `BenchmarkSeries` definition, so changing it appends a version
    rather than reinterpreting stored bars; `sourceKind` stays a statement about _how_ data is
    obtained. **`SP500` remains the SPY-backed ETF proxy for backtests and for the execution
    calendar** — a funded comparison must be able to buy what it is compared against, and completed
    runs pinned that meaning — so `SP500_INDEX` is a separate series, never a re-pointing of it. Do
    not add a second market cache, a second price table or a second hydration path for index data.
    The market-overview ETFs follow the same rule: `MARKET_OVERVIEW_ETF_GROUPS` is the one list of
    twenty, `SPY` is `SP500`, and the other nineteen are `ETF_*` series that are active and never
    selectable. `GET /market-overview` reads them through `BenchmarkHistoryReader` only and never
    asks the provider (`docs/decisions/etf-market-overview-v1.md`). Every `ETF_PROXY` series
    carries the re-base protection and generation of `docs/decisions/historical-price-basis-v1.md`;
    see `docs/decisions/etf-market-data-v1.md`.
14. Backtest work is claimed from PostgreSQL (`BacktestJob`, `FOR UPDATE SKIP LOCKED`, renewable
    lease, ownership-guarded writes). Do not add a queue library, and do not make Redis the queue.
    One backtest is never internally parallelized: its simulation stays sequential and
    single-process so it is deterministic. Concurrency comes from independent worker OS processes,
    configured by `BACKTEST_WORKER_PROCESSES`.
15. A Monitor is a live `Strategy` plus a `StockList` plus `enabled` — no pinned version, no
    execution parameters, no user-configurable cadence — and it produces Signals, which are
    durable occurrences distinct from the Monitor itself. Each evaluated level has one durable
    lifecycle (`INACTIVE | PENDING_TRIGGER | ACTIVE | RESOLVED`) decided only by the pure reducer in
    `@intrinsic/strategy` (`monitor-lifecycle.ts`); a Trigger controls entry into `ACTIVE` and is
    then latched, and a level with no state is reconstructed from history, never started blank
    (`docs/decisions/builtin-dashboard-signals-v1.md`). A Monitor evaluates **finalized end-of-day
    sessions only**, each at most once per member and in order, from the member's durable
    `MonitorEvaluationCheckpoint`, advanced in the same transaction as the Signals and transitions
    those sessions produced; its cycle reads PostgreSQL and makes no provider request, and every
    transition records whether it was observed, history or administrative
    (`docs/decisions/monitor-eod-v2.md` §3). Its universe is the List's **current** members only —
    `FULL`, or an open-ended period that has begun (`isOngoingListMember`) — gating BUY, SELL and
    FINAL EXIT alike; a member edited out ends administratively (`MEMBERSHIP_CHANGED`). Backtests keep
    `isBuyWindowEligible` and must never call the Monitor predicate (§4). Only a newly created
    Monitor replays its 90-day window, from the exact state before it, and every session-decided
    transition stores its `strategyVersionId` and operand `evidence` (§5). Do not reintroduce a
    live-quote observation or a quote endpoint (the FMP client has none, §8), a jump from a stale
    checkpoint to the newest session, or a Monitor-cycle provider read. A member is never stepped
    past a session its security or an ETF it reads has not printed while the bar may still arrive
    (`EOD_LATE_RECOVERY_MS`); a stock's session is given up only on a provider read issued at least
    that long after finalization (§10). Do not reintroduce a clock-only give-up.
    `ai/product/product-overview.md`
    fixes how List, Strategy, Backtest, Monitor and Signal relate; `ai/product/monitors.md` and
    `ai/architecture/monitor-engine.md` own the semantics. The scan cycle is claimed from
    PostgreSQL through the singleton `MonitorScanSchedule` row with the same `FOR UPDATE SKIP
LOCKED` + renewable-lease protocol as `BacktestJob`. That idiom has four instances — the third
    is the market-data refresh's `MarketDataRefreshSchedule` row `ETF_MARKET_DATA`, the fourth the
    stock EOD preparation's row `STOCK_EOD` in the same table, each owned by its own worker child so
    neither can delay the Monitor cycle — and any further durable claim must match them rather than
    add a queue, a cron or a Redis lock.
16. Redis is **required at runtime** — every stock-data read, hydration lock and provider gate goes
    through it and nothing degrades to PostgreSQL-only when it is down — but its **contents are
    disposable**: everything in it is a projection of PostgreSQL or transient coordination, keyed
    by security/series id under `stock-data:v2:*` (cache chunks, manifests, the resident LRU, the
    FMP gate and, beside it, a live hydration run's request counter), `stock-data:load:*` (Redlock
    hydration locks) and `benchmark:v1:*`, never by user.
    Do not add a user-scoped key, a second namespace convention, or Monitor/Signal state to it.
    Benchmark histories are **fully resident** under `benchmark:v1:*`: immutable content-addressed
    year chunks behind a compare-and-set head that always describes all durable coverage, with no
    TTL and outside the stock LRU, committed only on a generation fence that is written only under
    PostgreSQL's series write lock (`docs/decisions/etf-market-data-v1.md`). Redis's own
    `maxmemory-policy` must therefore never be an `allkeys-*` policy nobody accepted: readiness
    fails on one, and `REDIS_ACCEPTED_EVICTION_POLICY` is the only, explicit override.
    The stock cache has **two residency tiers over one key family**
    (`docs/decisions/stock-cache-tiers-v1.md`, `docs/decisions/protected-stock-tier-v1.md`): the
    **protected tier** — every security a built-in point-in-time universe admits in PostgreSQL,
    current and former members alike — resident outside the LRU, never a victim, and with no TTL on
    any key, in flight or READY; and the **LRU tier** for everything else, bounded by
    `STOCK_LRU_MAX_SECURITIES` distinct securities (a count, never bytes). Every admission routes
    in its Lua script by the canonical universe each composition root reads from PostgreSQL
    (`canonicalProtectedTierEligibility`); a process that writes the product's stock cache must
    pass it, and the Redis designation set `stock-data:v2:protected-stocks` is only its derived
    record (also reconciled by `pnpm data:index-universe -- protect` and added by every universe
    backtest). A touch never adds an LRU member. Do not add a second key family, namespace, loader
    or copy for either tier, do not let a user's List designate anything, and do not turn Redis
    memory into an admission or eviction criterion. Financial statements are not projected into
    Redis at all: statement reads go to PostgreSQL.
    `rate-limit:v1:*` is the one further namespace, and it is deliberately outside that rule: it
    holds HTTP rate-limit counters, which are neither a projection of PostgreSQL nor user-owned
    state — losing one grants allowance rather than destroying anything — so it is keyed by actor,
    including by user id. It shares the same Redis instance on its own connection and never a
    second provider. See `ai/architecture/rate-limiting.md`.

17. Commercial entitlements are an application-domain concern with one central definition in
    `@intrinsic/contracts`. `docs/decisions/entitlements-v1.md` is the source of truth for every
    plan, capability and limit; `ai/architecture/entitlements.md` is how it is implemented. Plan
    (`FREE | STARTER | PRO`) and role (`USER | ADMIN`) are orthogonal columns on `User`, both
    resolved server-side from persisted state and never from client input; `GUEST` is derived from
    the absence of a session and never creates a row. Do not write `plan === "PRO"` in feature
    code — ask for a named capability or limit and enforce it with a semantic guard at the
    canonical mutation or execution boundary. A limit that can be raced is decided inside the
    writing transaction under the shared per-user entitlement lock. A downgrade is never
    destructive: existing content stays readable and correctable, and compliance is derived rather
    than persisted. Billing may move the persisted plan and nothing else; it is never an input to
    entitlement resolution, and request rate is never modelled as an entitlement.

18. Stripe is a billing provider and nothing else. `docs/decisions/stripe-billing-v1.md` is the source
    of truth for the four-price catalog, the transition matrix and the billing-status policy;
    `ai/architecture/billing.md` is how it is implemented. The direction is one-way — Stripe billing
    state, then persisted `User.plan`, then the entitlement resolver, then enforcement — and never
    reversed: no entitlement question is ever answered by consulting Stripe, and no entitlement value
    lives in billing code. `apps/api/src/entitlements/user-plan.ts` remains the only writer of
    `User.plan`, reached by exactly one caller, `BillingReconciliationService`, which is also the only
    thing that writes the `BillingSubscription` mirror — in the same transaction, under the shared
    per-user entitlement lock, after fetching canonical Stripe state inside it. A plan is never granted
    from a browser redirect, from an unverified webhook payload, or from a subscription-update request
    whose payment has not succeeded. `apps/api/src/billing/stripe.gateway.ts` is the only file that may
    import the Stripe SDK, and no client input may name a Stripe price, customer or subscription: the
    whole accepted surface is one of four logical price keys. Stripe never touches `User.role`. Do not
    add credits, top-ups, trials, metered billing, a second paid subscription per user, or
    hand-written proration arithmetic.

19. API rate limiting is abuse and capacity protection, never a commercial entitlement
    (`docs/decisions/entitlements-v1.md` section 10, enforced by
    `packages/contracts/src/entitlements.rate-limiting-boundary.test.ts`). Every allowance lives in
    one catalog, `apps/api/src/rate-limit/rate-limit-policies.ts`; a route names a policy with
    `@RateLimit("…")` and never carries a number, a Redis call or a limiter. Enforcement is the one
    global `RateLimitInterceptor` — an interceptor rather than a guard because Nest runs global
    enhancers before controller guards, so a guard could not see the session it keys by. Every
    mounted route must declare a policy or an explicit `@RateLimitExempt(reason)`;
    `rate-limit-coverage.test.ts` fails the build otherwise. Counters are keyed by user id for
    authenticated traffic and by client IP otherwise — never by plan, and never by a submitted email
    address. `X-Forwarded-For` is trusted only as far as `RATE_LIMIT_TRUSTED_PROXY_HOPS` says a
    deployment really has proxies. A policy may carry a second, wider per-IP bucket; buckets are
    spent in order, stopping at the first refusal, and anything an earlier bucket took is handed
    back — so **a refused request never consumes usable allowance from another bucket** and one
    caller's doomed retries cannot drain a shared allowance their colleagues depend on. Every
    consume stays one atomic Redis script rather than a read-then-write. Redis-failure behaviour is a per-policy decision — capacity
    policies fail open, security and payment policies fail closed with `503` and
    `RATE_LIMIT_UNAVAILABLE` — and there is never a process-local fallback limiter, which would
    report a distributed guarantee the system does not have. Outbound provider throttling is a
    different mechanism with different semantics (wait, not reject) and stays
    `RedisFmpRequestGate`. `ai/architecture/rate-limiting.md` is how it is implemented.

20. `docs/openapi.yaml` is the HTTP API's specification and describes the API that exists.
    `apps/api/src/openapi/openapi.contract.test.ts` compiles the real application and requires the
    document to match it operation for operation — each route's rate-limit policy, its `429`, its
    `503` where the policy fails closed, its cookie authentication and its `401`/`403` — so a new
    or renamed route cannot land undocumented. `openapi.strategy-schema.test.ts` holds the Strategy
    schemas to `@intrinsic/contracts`, so a Strategy model change must update the document too.
    `pnpm openapi:validate` separately validates the document against the official OpenAPI 3.1
    schema. Do not document an endpoint that does not exist, and do not add a route without
    documenting it.

21. Built-in content is `SYSTEM`-owned, never owned by a special customer account:
    `ownership = SYSTEM`, `userId = null`, an immutable `systemKey` that is the only bootstrap
    identity (never the display name). Everybody may read it, Guests included; only `role = ADMIN`
    changes it, through the ordinary routes and editors; nobody deletes it. It never counts against a
    customer's capacity and is never cloned per user — a customer's Dashboard visibility of a
    built-in Monitor is the only per-user state (`UserBuiltInMonitorPreference`). A signed-in
    customer may still **duplicate** a built-in List or Strategy on purpose: the copy is ordinary
    USER content they own, detached from the built-in and held to their plan. Deploys run
    `pnpm builtins:bootstrap`, which creates missing built-ins and never overwrites an
    administrator's edits; `pnpm builtins:reset` is the explicit restore. `docs/decisions/builtin-dashboard-signals-v1.md`
    is the decision; `docs/development/builtin-content.md` holds the catalog's verified sources.

22. Legal acceptance, the public legal documents and the browser-storage consent control are one
    slice with one central definition. `docs/legal/` is the specification and the register of
    facts nobody may invent; `ai/architecture/legal-compliance.md` is how it is implemented.
    The versioned document text lives in `@intrinsic/contracts` and is **hashed**: an acceptance
    event stores the digest of the exact text, so editing copy without bumping the version and
    running `pnpm legal:hashes` fails the build. Acceptance is bound to a **verified account
    holder** and never to a submitted email address — registration records nothing, and the email
    path records its acceptance inside the transaction that activates the account. Every mounted
    route is gated on the required Terms version by the global `LegalAcceptanceInterceptor`;
    an exemption is declared with `@LegalAcceptanceExempt(reason)` and the allowlist is pinned
    _exactly_ by `legal-acceptance-coverage.test.ts`, because a missing exemption traps a paying
    customer — cancellation, statutory withdrawal, privacy requests, support and logout must stay
    reachable for a user who declines. Operator identity, contacts and legal conclusions are
    never committed or invented: they are `NEXT_PUBLIC_LEGAL_*` placeholders, and a release build
    refuses to compile while one is unresolved or any document is still `DRAFT`. Storage that is
    merely convenient is not strictly necessary: the guest recents key is gated on consent, and
    nothing optional is read or written before a choice. Nothing in this slice writes
    `User.plan`, calculates a refund, or decides a legal outcome.

23. Alternative data — insider activity and congressional trading — is two ordinary Strategy metric
    families over point-in-time disclosure history, never a parallel subsystem.
    `docs/alternative-data-signals.md` is the source of truth for every product decision and for the
    implementation clarifications and provider limitations found while building it. Institutional
    Form 13F is **out of V1** and has no schema, code, metric or setting: the provider subscription
    refuses every `institutional-ownership/*` endpoint, so nothing could be validated against a real
    payload. Do not reintroduce it as dormant or flagged code.
    **Every row keeps two dates**: the economic one (a trade, a report period) and the one the
    information became public, plus the derived `availableFromDate` — publication plus one day, the
    same convention `statementPublicAvailabilityDate` applies — which is the **only** date a query or
    a window ever filters on. A lookback is measured in trading sessions on the session a disclosure
    became _observable_, so one definition serves a historical backtest and a live Monitor; the
    observable session is the first session the evaluation frame's own axis holds on or after that
    date, which is what makes weekends and holidays correct without a second calendar. Outside the
    ingested coverage interval a metric is `NOT_EVALUABLE`, never zero: absence of data and absence of
    activity are different statements. Provider rows are content-addressed and never destructively
    overwritten, so reingestion is idempotent and an amendment is a new row. Actors are identified by
    stable external ids (a bioguide id) and never by display name.
    **A Congressional rule that narrows whose activity it counts selects the members itself**: its
    scope holds a canonical list of actor ids (`ACTORS` — between 1 and 250, sorted, de-duplicated),
    so the selection is part of the strategy version and nothing outside the strategy can change what
    the rule counts. A selection is a **membership filter over one pooled metric**, never an OR
    between separately evaluated rules: two selected members with one purchase each read as two
    purchases. A one-member selection serializes exactly as the legacy single `ACTOR` scope did, and
    a selection of several contributes a digest of its ids to the fingerprint rather than the ids, so
    no stored `definitionHash` or Monitor latch moved and a Monitor state row stays short; do not
    change either serialization. A scope kind the build does not define is **refused, never read as
    nobody** — by the validator, by the signature, by the loader and by the worker's snapshot parse —
    and a backtest snapshot holding a selection is written at snapshot version 2 so a worker built
    before the selection existed refuses it instead of completing the run on zero activity.
    **Congress groups are legacy (owner, 2026-10-11).** No surface manages them and the strategy
    write boundary refuses a `GROUP` scope, but a stored strategy version or run snapshot naming one
    must keep reading and executing: the validator keeps the shape, a backtest resolves it from the
    **membership frozen in its own snapshot** and never from the database, a Monitor from the group
    as it stands, and the tables and routes stay until nothing references them. Converting such a
    strategy is the operator's deliberate act (`pnpm strategies:convert-group-scopes`,
    `docs/development/congress-group-scope-conversion.md`), never a side effect of a deploy. Do not
    add reusable groups, presets or saved selections, insider person groups, a semantic or historical
    group, or a second FMP gate: ingestion goes through the one `RedisFmpRequestGate` like every
    other provider read.
    **The member catalog is an identity directory, synchronized with the provider's member
    directory** (`docs/development/congress-member-catalog.md`): `pnpm data:congress-members:sync`
    or `POST /admin/congress-members/sync` adds every member the directory lists, in office and
    former, whether or not a disclosure of theirs has been loaded. Identity is the bioguide id —
    never make an identity from a name — and a synchronization **never deletes, merges or re-keys**
    a member, because strategies, snapshots and Monitors hold canonical ids. It reads the whole
    directory before it writes and fails closed, writing nothing, when it cannot. It writes actor
    labels only: no disclosure, no coverage, no dataset state, and no metric may ever read the
    catalog — a member being listed says nothing about their trading. A member's label is their
    disclosures' once one has been loaded and the directory's until then; do not make the
    synchronization and ingestion both write one label. The picker never causes a provider request,
    and says whether the catalog it searches has been synchronized. A duplicate of a strategy that
    still names a group holds a selection of that group's members; the original is only read.
24. Valuation ratios (P/E, P/S, P/B, P/FCF, EV/EBITDA) are correct or unavailable, from FMP's data
    alone: V1 has no second market-data provider and no historical distribution factor `Φ`, and
    `docs/decisions/valuation-ratios-v1.md` is the source of truth. A known or detected unsafe
    price-basis period — from FMP's split list or a re-base the loader measured — is unavailable,
    and an unavailable ratio makes a Condition not match. **Accepted V1 limitation** (owner,
    2026-10-02): a basis-changing event that FMP does not report and FactorSage cannot otherwise
    detect escapes those rules, and the ratios before it are biased. MMM's Solventum spin-off
    (2024-04-01) is the known case: MMM's valuation history before it reads about 16.4 % low. It is
    accepted for V1, not correct. Do not special-case a security, add insider prices or another
    provider, reconstruct `Φ`, add a confidence framework, withhold history before verification, or
    build detection for it in unrelated work; independent detection of provider-unreported events
    is a later enhancement, not a V1 blocker.
25. Every market price FactorSage stores, computes from or shows is a **finalized end-of-day bar**
    (`docs/decisions/eod-finality-v1.md`). A session's bar is final at its 16:00 New York close plus
    `MARKET_DATA_EOD_PUBLICATION_DELAY_MS`; `eodCutoffDate` in `@intrinsic/domain` is the one clock.
    Every loader request, coverage interval, retention horizon and product read ends at that cutoff,
    never at the UTC day, and a provider row outside the requested range is dropped. A recent tail is
    re-read when the newest finalized session has not been read after it became final — a session
    question decided by `decideEodTailRefresh`, never a timer. A backtest period requested through
    an unfinished session ends at the newest finalized one. A week's weekly values become eligible at
    the finalized close of its last **scheduled** session, named by the venue schedule
    (`aggregateCompletedWeeks` with `resolveWeekSessionEnds`), so a session's derived row is the same
    whenever it is materialized (`docs/decisions/monitor-eod-v2.md` §9); never make weekly
    completion depend on the materialization date or hardcode Friday. Do not reintroduce a wall-clock price
    freshness window, a `today()` from the UTC date, or a read of a bar whose session was still
    trading; `EOD_TAIL_REFRESH=frozen` exists only for deterministic environments over a frozen
    dataset.

26. A shared backtest publishes **results only** (`docs/decisions/backtest-sharing-v1.md`). Its owner
    may give one completed run one unguessable link (256-bit token, never a database id), revoked by
    deleting it; anyone holding it reads `SharedBacktestReportResponse`, an explicit allowlist that
    is never a filtered private DTO. It never carries the strategy, its rules or identifiers, the
    list or its securities, trades, positions or the owner — only how many rules and securities the
    frozen run used — and every figure is the stored result through the owner page's own code. The
    public routes ask nobody who they are, so no plan, session or entitlement changes the answer, and
    they never start a run, read a stock history or ask the provider. A token is a working link: it
    stays out of logs and error messages.

## Dependency rules

Allowed direction:

```text
web -> contracts

api -> contracts/domain/strategy/stock-data/database/fmp/observability
worker -> contracts/domain/strategy/stock-data/database/fmp/observability

database -> Prisma
fmp -> domain/external FMP API
strategy -> contracts/domain
stock-data -> contracts/domain/strategy/database/fmp/observability/Redis
```

Forbidden:

- `web -> database`
- `web -> Prisma`
- `web -> fmp`
- `web -> worker`
- `web -> strategy`
- `domain -> database`
- `domain -> HTTP`
- `domain -> process.env`
- `valuation -> database`
- `valuation -> process.env`
- `stock-data -> process.env`
- `strategy -> database`
- `strategy -> HTTP`
- `strategy -> process.env`

`@intrinsic/strategy` is pure: Strategy evaluation, position state and the backtest day loop, with
no I/O and no clock. It is what keeps the API, the backtest worker and the Monitor engine on one
implementation of what a Strategy means. `stock-data` depends on it only to project the columnar evaluation frame the
engine consumes — which is also where the intrinsic-value provenance gate is applied, so a pure
evaluator physically cannot read an ungated value.

## Database rules

- One canonical Prisma schema.
- One migration history.
- API and worker each create their own process-local DB client/pool.
- Do not silently change schema.
- Schema changes require an explicit migration and a short migration note.

## Frontend rules

- Read `ai/architecture/frontend.md` for substantial frontend/UI work.
- The old repository is a visual/behavioral oracle only; do not copy its architecture wholesale.
- Preserve the established FactorSage visual identity where it still fits V2: a near-white canvas,
  flat light-bordered surfaces, a restrained blue accent used as ink more often than as fill,
  restrained financial state colors, and high information clarity. Geist is a **V2 choice, not
  something inherited from V1** — deployed V1 renders in the OS UI stack; V2 keeps Geist because it
  renders identically on every platform.
- `apps/web/src/styles/tokens.css` holds the product's shared visual language: the semantic palette,
  the radius and elevation scales, the type scale, the standard control sizes and the page spacing
  system. Ask for those by name rather than restating their values, and never redefine one locally.
  Geometry specific to a single component may stay in that component. `ai/architecture/ui-system.md`
  states the rule; `ai/architecture/v1-visual-parity.md` holds the measured V1 reference behind it.
- Use App Router only in V2; do not introduce Pages Router.
- Keep route files thin and organize product code by feature.
- Use `@intrinsic/contracts` as the canonical API shape; do not duplicate response types in the web app.
- Responsive desktop and mobile behavior is part of feature acceptance. Do not defer mobile behavior to a later cleanup task.
- Prefer dedicated mobile composition for dense data when a desktop table/layout would be hard to use on a phone.
- Do not put canonical financial/business calculations in React components.
- Use semantic design tokens before adding new hard-coded brand colors.
- For time-series market charts, prefer the established Lightweight Charts direction unless the task has a materially different visualization need.

## Code-change rules

- Prefer small reviewable changes.
- Do not bulk-copy the old repository.
- Treat old code as reference/oracle, not architecture.
- Preserve existing validated formulas unless the task explicitly changes them.
- Do not change financial formulas as part of infrastructure refactors.
- No `typescript.ignoreBuildErrors`.
- Do not commit generated build output.
- Do not introduce a generic `shared/utils.ts` dumping ground.
- Add dependencies only when there is a concrete use.
- Never commit secrets or real `.env` files.

## Agent efficiency

- Keep investigation and implementation within the explicit task scope.
- Search and read narrowly; do not repeatedly reread unchanged files or dump large files/logs without a concrete need.
- Prefer existing tests and logs over ad-hoc diagnostic scripts. Temporary probes must not remain in the final diff.
- During iteration, run targeted validation for the code being changed. Run the full repository validation gate once after the implementation is settled.
- Do not repeat successful command output; summarize pass/fail. On failure, preserve the relevant error evidence.
- For review/validate/commit/push-only tasks, do not modify implementation. If validation fails, stop and report unless the task explicitly includes fixing failures.
- If the task requires investigation before implementation, establish the root cause before changing code and stop exploring unrelated alternatives once it is confirmed.
- Keep status updates and final reports concise and non-repetitive.

## Observability rules

- Read `ai/architecture/observability.md` for server-side API, worker, stock-data, FMP, database, cache, queue, or integration work.
- Application runtime logging must use `@intrinsic/observability`; do not add ad-hoc `console.log`, `console.warn`, or `console.error` calls.
- Respect the configured `LOG_LEVEL`. Use `info` for meaningful lifecycle boundaries, `debug` for operational detail, and `trace` only for high-volume diagnostics.
- Important operations must emit stable searchable events for relevant `started`, `completed`, and `failed` boundaries. Include `durationMs` on completed/failed operations when meaningful.
- Preserve correlation context through the call chain. Standard fields are `requestId`, `correlationId`, `actorUserId`, `runId`, `jobId`, `symbol`, and `component` when applicable.
- Use the internal user ID as `actorUserId`; do not use email as the normal user correlation key.
- Crossing a process boundary is explicit: queue/job payloads must carry the relevant correlation fields, and the receiving worker must recreate the logging context.
- Never log passwords, cookies, authorization headers, JWTs, API keys, secrets, credentials, or complete sensitive request/response payloads.
- Do not swallow, replace, or change business errors merely to add logging. Log with context and preserve the original error semantics.
- When a caught exception is translated into a generic error, log the original error object before translation so its name, message, and stack are retained.
- New integrations and long-running flows must include enough structured logging to identify the operation, owner/caller when available, external dependency, outcome, and elapsed time without enabling `trace`.

## Authentication and E2E testing

- For authentication work or browser/E2E testing, read `ai/workflows/auth-testing.md`. It is the
  operational source of truth for test personas, seeding, auth test suites, Playwright, storage
  state, and the Google/email test policies.
- Test personas are defined once in `packages/testing/src/personas.ts` — one account per commercial
  plan, plus an administrator on the smallest plan. Do not add a persona email, password, plan or
  storage-state path anywhere else, and do not change a persona's plan inside a test: sign in as the
  plan under test. `PRO_USER` is the normal development and manual-testing account; `ADMIN_USER` is
  for internal/QA scenarios that intentionally need entitlement overrides.
- Manual release testing uses the same registry through `pnpm qa:seed` / `qa:reset` /
  `qa:personas`, against the development database. `docs/development/qa-personas.md` is the runbook.
  Those personas stay empty of product content on purpose; do not seed lists, strategies, monitors
  or backtests into them.
- Billing QA personas (`BILLING_*`, `packages/testing/src/billing-personas.ts`) are a separate set
  with a separate purpose: accounts whose subscription really exists in Stripe test mode and whose
  mirror and plan were produced by `BillingReconciliationService`. `pnpm qa:billing:seed` /
  `status` / `cleanup` own them; `docs/development/billing-qa-personas.md` is the runbook. Do not
  turn an entitlement persona into a Stripe-backed one, and do not write a `BillingSubscription`
  row or a paid `User.plan` for a billing persona — its tooling writes the account and its
  `stripeCustomerId` link only, and a test reads the source to keep it that way. The tooling is
  test-mode only and may delete nothing in Stripe but the Test Clocks it created.
- Test passwords have two readers: the seeders and the Playwright runner. No stack process may
  receive one. `next dev` records its whole environment in `apps/web/.next/dev/cache`, so it is
  started only by `apps/web/dev-server/next-dev.ts` (`pnpm dev:web`) with an allowlisted
  environment; do not start `next dev` any other way, do not add a credential to that allowlist,
  and never give a credential a `NEXT_PUBLIC_` name. A launcher builds a child's environment with
  `e2eChildEnvironment`, never by passing its own `process.env`.
- Never commit credentials, session cookies, tokens, Playwright storage state, or the `.qa/`
  browser profiles.

## Claude cloud sessions

- A Claude Code cloud session is provisioned by `scripts/cloud/` (the environment's setup script and
  the SessionStart hook in `.claude/settings.json`); `docs/development/claude-cloud-environment.md`
  is the runbook. Start application stacks there with `scripts/cloud/stack.sh`, not by hand.
- Provider credentials are never ambient in a cloud session: Stripe is reachable only through
  `scripts/cloud/with-stripe.sh` or `stack.sh up dev --stripe`, in sandbox mode, and FMP only
  through `scripts/cloud/fmp-live.sh`, which runs the guarded live hydration and nothing else, or
  `scripts/cloud/fmp-index-universe.sh`, which runs the owner-authorized point-in-time universe
  commands (`sync`, `resolve`, `ingest`, `benchmarks` with `RUN_INDEX_UNIVERSE_INGESTION=1`) under
  their own guard and budget, and `project`, `report` and `protect` without a key. Do not export
  `FMP_API_KEY`, `STRIPE_*` or the per-run opt-ins for a whole session.

## Live FMP hydration

- `pnpm fmp:live` (`docs/development/fmp-live-hydration.md`) is the guarded live hydration, and in
  a cloud session the only way real provider data is reached: the full supported history of **at
  most three securities**, into a local development database, through the canonical loaders,
  inside a total request budget. It needs `RUN_LIVE_FMP_HYDRATION=1` on that command and reads its
  key from `LIVE_FMP_API_KEY` only. A key being present authorizes nothing, and `FMP_API_KEY` is
  never a fallback.
- The limits live at the provider boundary, not in the command line. `FmpClient` takes an optional
  **guard** (`packages/fmp/src/request-guard.ts`) asked before every request: the live run's guard
  refuses anything that is not about one approved, catalog-resolved security, and anything beyond
  the budget. Do not pass a guard in any other composition root, do not give the scope a way to add
  a security, and do not raise `LIVE_FMP_MAX_SECURITIES` or the budget bounds without the owner.
- It is orchestration only. Do not add loading logic, a database write or a new provider dataset
  to `apps/api/src/fmp-live/`, and do not compose a benchmark loader, a trading calendar, quotes,
  the exchange-wide catalog sync or a worker into it — those are the paths that widen the symbol
  universe. A symbol the catalog lacks is admitted by `CanonicalSecurityCatalogService` fed that
  symbol's own profile, never by the screener and never by a direct insert.
- The run's child process is started with an allowlisted environment and does not load `.env`. Do
  not hand it the launcher's `process.env`, and do not make another process read
  `LIVE_FMP_API_KEY`. The allowlist passes `NODE_EXTRA_CA_CERTS` — a trust bundle's path, which a
  process can only inherit and which a TLS-inspected environment needs — and never proxy
  configuration or `NODE_TLS_REJECT_UNAUTHORIZED`; the child refuses to start with a proxy
  variable set. Never commit, log or copy provider payloads: the report prints names, counts and
  dates only.

## Validation

PostgreSQL-backed suites require `TEST_DATABASE_URL` pointing at a dedicated, migrated test database
(`pnpm db:test:prepare`); they never fall back to `DATABASE_URL`. `apps/api`, `apps/worker` and
`packages/stock-data` serialize their test files for that reason, and `pnpm test` runs the
workspace one package at a time for the same one: suites that share a database, a Redis and a
machine are not run beside each other. `apps/worker` is one supervisor with four child kinds —
backtest, Monitor, market-data and stock EOD children — so a worker change must be tested against the
kind it affects. See `ai/workflows/validation.md`.

During implementation, prefer the smallest relevant test/typecheck command. Once the implementation is settled, run the full validation gate once before marking the task complete:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm openapi:validate
```

When E2E exists for the changed flow, run it as well.

`pnpm legal:check` is a **release** readiness report, not part of the gate: it lists the operator
facts and document approvals still outstanding and exits non-zero. A draft legal page must stay
reviewable locally, so nothing in the gate fails because of one; `apps/web/src/lib/legal-release.ts`
is what stops a declared release build publishing it.

If a command cannot be run, report exactly why.

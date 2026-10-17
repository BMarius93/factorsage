# Stock-data concurrency audit — 2026-10-16

Remediation workstream 2 of the pre-release audit (`pre-release-audit-2026-10-16.md`): what happens
when several users, API instances and worker processes read or change the same market data at once.
Branch `fix/stock-data-concurrency`, from `main` @ `bc11cfed`.

- **Code read:** `packages/stock-data` (`service.ts`, `cache.ts`, `coordination.ts`, `prisma-store.ts`,
  `benchmark-service.ts`, `fmp-gate.ts`), the API Stock Details composition, the backtest worker's
  preparation and year-window reads, the stock EOD and market-data children, the Monitor evaluation's
  reads. Every claim below names the test or the code path that proves it.
- **Executed on real PostgreSQL 16 and Redis 7** (the local Docker pair, `noeviction`, no
  `maxmemory`), nothing faked but the market data provider. No live FMP request was made: every
  suite uses a deterministic synthetic market, and the QA-matrix runs go through its refusing
  provider guard (0 requests).
- **Redis isolation:** test suites use per-test key namespaces and delete them; the two cold matrix
  runs used logical databases 10 and 11, both empty before. No shared database was flushed.

## 1. Summary

The audit's OPS-06 was one instance of a broader pattern: lock-free actors (readers, the LRU, TTLs)
could remove what a lease holder was building, and the lease itself was neither lost nor won the way
the code assumed. Nine defects were confirmed and are fixed in this branch; one more (CONC-01) is
confirmed and pinned but needs its own change; the rest of the scenario space was exercised and held.

| ID | Severity | What happened | Fixed here |
| --- | --- | --- | --- |
| OPS-06 | P1 | A read that met another process's HYDRATING manifest deleted it; that hydration failed with "generation changed". 5 of 40 cold-cache backtests failed today on `main` (audit: 7 of 40). | yes |
| CONC-02 | P1 | A holder that **lost** its Redlock lease did not find out for up to two minutes: redlock retries an extension with the acquisition budget (`STOCK_DATA_LOCK_WAIT_MS`, 120 s at 100 ms), and `assertOwned()` passed all the while. Its `using` call then spent up to two more minutes releasing a lock it no longer held. | yes |
| CONC-03 | P1 | A caller that **waited** longer than one lease (30 s) for a stock's lock was handed a lock its own process already counted as expired — redlock dates expiry from when acquisition *began* — and failed its first ownership check with "Cannot extend an already-expired lock". 25 of 100 callers failed this way in the stress suite before the fix. | yes |
| OPS-02 | P1 | The stock EOD child skipped a security whose price tail was current even when its derived state was behind (the r8 bump, a crash between saves), stalling every Monitor until the next session. | yes |
| R2 | P2 | A lease holder whose READY manifest was invalidated or LRU-evicted between its read and its compare-and-set threw "generation changed" instead of retrying. | yes |
| R7 | P2 | A HYDRATING generation's 15-minute lifetime was extended only by key writes, the first of which comes after the profile read, whole-history verification, coverage download and price save: a slow hydration could expire under a lease it still held. | yes |
| OPS-04 | P2 | Every key written into a HYDRATING generation re-expired every registered key: K²/2 `PEXPIRE`s per hydration. | yes |
| OPS-07 | P2 | An empty derived-state window (a weekend, a pre-listing year) counted as a cache miss and rebuilt the whole stock on every such read. | yes |
| STMT-MIX | P2 | `readFinancialStatements` did not re-check the manifest after its `MGET`, so a read spanning a refresh could return statement years from two generations. | yes |
| OPS-03 (part) | P2 | The LRU's write after a successful read failed the read on a Redis refusing writes (`noeviction` at `maxmemory`). | yes (best-effort) |
| R9 | P3 | `getFinancialStatements` repaired a miss over its own range only, narrowing the resident stock. | yes |
| CONC-01 | P1 (data) | EMA and Wilder RSI are anchored at the earliest **stored** bar (AUD-02); a stock first hydrated by a narrow window and later widened is rebuilt from the new first bar, so values already served change — EMA 200W by ~1 % four years in on the test history. | **no** — pinned (`it.fails`); needs a load-policy change, §6 |

**Measured effect** (details in §4): the cold-cache matrix check went from **5 / 40 failed** to
**40 / 40 completed, gate GREEN, 30,044 trades** — the same trade count as the audit's warm sweep;
the 50-caller cold stress went from **573,684 Redis commands (540,281 `PEXPIRE`)** to **28,477
(1,434)**.

## 2. What was changed

**Redis projection (`cache.ts`).**
- `INVALIDATE_MANIFEST` removes only a **READY** generation, and removes it whole (manifest, every
  registered key, resident entry). A HYDRATING generation belongs to the lock holder; a reader that
  meets one waits for the lock instead (the service's existing repair path). The status check is in
  the script, so a generation that becomes HYDRATING between the reader's observation and the call is
  spared too. (OPS-06; also stops the registry leak an invalidation left behind.)
- `SET_REGISTERED` gives a new key the manifest's **remaining** lifetime and extends the whole
  generation only when it is less than half-way from expiry. The generation still expires together,
  so a READY publication can never find a chunk gone before its manifest. (OPS-04)
- `RENEW_HYDRATION` (`renewHydration`): confirms a HYDRATING generation is still current and restores
  its full lifetime. (R7)
- `readFinancialStatements` re-checks the manifest after its `MGET`, as prices and derived state
  already did. (STMT-MIX)
- The LRU `touch` after a successful read is best-effort, reported through the new
  `onTouchFailed` observer, which every production composition root logs as
  `stock-data.cache.touch-failed`. (OPS-03)

**Service (`service.ts`).**
- `beginHydrationUnderLease`: under a held lease, a failed compare-and-set re-observes the manifest
  and retries (up to four attempts) without narrowing the range. (R2)
- `assertGeneration` between phases of a hydration and a refresh (after the profile, after the
  coverage download, before the fundamentals, before the derived rebuild): renews the generation and
  **stops the holder before its remaining durable writes** when another holder has taken the stock
  over. (R7, and a narrower stale-writer window, §5)
- An empty derived-state answer is a hit. (OPS-07)
- `getFinancialStatements` repairs over `maintainedTarget(load, observed)`. (R9)
- `refreshStockTail` repairs a derived state that is behind a verified bar from PostgreSQL even when
  the projection reads as current; `derivedStateCaughtUp(state)` is exported for the stock EOD child.
  (OPS-02)

**Coordination (`coordination.ts`).**
- Acquisition is a loop of single-attempt acquisitions until the wait is spent, so each lock's
  expiry is dated from its own acquisition. (CONC-03)
- The redlock instance's retry settings — used by every extension and the release — cover half the
  extension window instead of the 120-second acquisition wait, so a lost lease aborts the holder's
  signal before the lease would have expired. (CONC-02)
- The automatic extension starts half a lease before expiry (15 s for the default 30 s lease)
  instead of `min(5 s, half)`, so an event-loop stall has half a lease, not five seconds, before the
  lease is lost.

**Stock EOD child (`refresh-run.ts`).** A security is "nothing to do" only when its price tail is
settled **and** `derivedStateCaughtUp(state)`; otherwise it takes the ordinary preparation, which
rebuilds from PostgreSQL and asks the provider for nothing it holds. (OPS-02)

## 3. Scenario matrix

`SC` = `packages/stock-data/src/stock-data-concurrency.integration.test.ts` (new; real PostgreSQL,
Redis and Redlock; a "process" is one service with its own Prisma client, Redis connection and
coordinator). `RI` = `redis.integration.test.ts`. `EOD` = `apps/worker/src/stock-eod/
stock-eod.integration.test.ts`. `MX` = QA matrix cold check (§4.1). "main" is the result with
`main`'s `cache.ts`, `service.ts` and `coordination.ts` swapped back in under the same tests.

### A. Several clients, one stock

| # | Scenario | Evidence | main | branch |
| --- | --- | --- | --- | --- |
| A1 | two users, cold | SC "cold: many readers…" (3 processes, 12 calls, every entry point) | pass | pass |
| A2 | 10–100 users | SC "bounded stress" 2/10/25/50/100 callers × 4 processes × 3 securities, seeded | 100: **25 failed** (CONC-03) | pass |
| A3 | 1Y and 30Y at once | SC cold + stress (narrow and widening ranges mixed) | pass for prices; **derived values move on widening** (CONC-01) | same (pinned) |
| A4 | partially overlapping prefixes | SC cold + stress | pass | pass |
| A5 | disjoint ranges | SC cold + stress | pass | pass |
| A6 | READY while another process widens | RI "OPS-06: a read never aborts another process's live hydration" | **fail** ("generation changed") | pass |
| A7 | a request arrives during HYDRATING | RI OPS-06; MX cold | MX **5/40 failed** | MX 40/40 |
| A8 | a caller gives up while another needs the data | code: no shared promise or cancellation — a caller that times out on the lock (120 s) throws to itself only; the holder continues | n/a | n/a |
| A9 | hydration fails after writing PostgreSQL | SC "a hydration that fails after writing PostgreSQL…": no READY, retry equals an uninterrupted run, no duplicate rows | pass | pass |
| A10 | retry after the first lease expired | SC "a generation abandoned by a crashed holder…" (takeover, not wait-out); SC "a holder that lost its lease…" | takeover pass; lost lease **hangs > 90 s** | pass (2.9 s) |
| A11 | different symbols do not serialize | SC "different securities hydrate side by side" (four-party barrier inside the provider) | pass | pass |
| A12 | one security, several entry points | SC cold (`getDailyPrices`, `getDailyDerivedState`, `getStockDetails`); locks and keys are by security id, never by ticker string | pass | pass |

### B. Several consumers sharing a stock

| Scenario | Evidence |
| --- | --- |
| two backtests on the same universe; overlapping universes | MX cold: 40 backtests at concurrency 3 over lists sharing members — main 5 failed, branch 40/40, identical to the audit's warm trades (30,044) |
| Stock Details while a backtest hydrates | the A6/A7 reader-versus-hydrator race (RI OPS-06, SC stress) |
| Monitor EOD preparing while the API reads | the Monitor reads PostgreSQL only (`readFinalizedEvaluationFrame`); the stock EOD child is a hydrator — SC "warm" (readers racing a tail refresh) |
| a new EOD bar while a backtest loads history | SC "warm: readers racing a new session's tail refresh see one session or the other, and the tail is read once" |
| Stock and ETF contexts at once; Monitor and backtest on the same ETF | benchmark path is separate: own lock namespace, content-addressed chunks behind a compare-and-set head with a generation fence, readers never invalidate and fall back to PostgreSQL after a 1 s wait (existing `benchmark-residency.integration.test.ts`); unchanged |
| two API processes / two worker processes | every SC case runs 2–4 independent "processes" |
| user isolation | no user-scoped key exists under `stock-data:v2:*` (invariant 16); user-owned snapshots and results live in PostgreSQL rows scoped by `userId`, never in the shared projection |

### C. Redis

| Scenario | Result |
| --- | --- |
| OPS-06 | fixed (A6, A7) |
| concurrent publication / generation fencing | every chunk write and READY publication compares the generation (`SET_REGISTERED`, `PUBLISH_READY`); RI "rejects writes and READY publication from a stale hydration generation" (`cache.test.ts`) |
| lock acquisition, renewal, release, expiry, takeover | CONC-02, CONC-03 fixed; SC "a caller that queued longer than a whole lease…" (main: fail) |
| stale writer after losing the lease | Redis: fenced by the generation (SC lost-lease: the successor's READY manifest and values stand). PostgreSQL: §5 |
| readers on HYDRATING vs READY | READY read; HYDRATING → wait for the lock; never deleted |
| chunks missing under a present manifest | a miss; a READY generation is removed whole and rebuilt (RI "treats a missing year as a miss", SC LRU) |
| eviction during reads | SC "with fewer resident slots than securities…": 4 securities, 2 slots, 40 random concurrent reads, values equal PostgreSQL, **no provider request after warm-up** |
| complete cache loss | SC "after losing the whole cache…": identical values, no provider request |
| restart / unavailable Redis | Redis is required at runtime (invariant 16): reads and hydrations fail with the Redis error and nothing degrades to PostgreSQL-only. Not exercised live — the shared container serves other work |
| read-only / OOM (`noeviction` at `maxmemory`) | a warm read now survives the refused LRU write (`cache.test.ts` "a Redis that refuses writes"); hydrations, the FMP gate, Redlock and fail-closed rate-limit policies still fail — by design, the remedy is sizing (§7) |
| LRU smaller than the working set | correct and provider-free (above); cost in §4.3 |
| ETF residency | separate namespace, no TTL, outside the stock LRU; unchanged |
| TTL registration overhead | OPS-04 fixed, §4.2 |
| revisions and re-bases | unchanged; RI re-base suites pass |

### D. PostgreSQL

| Scenario | Result |
| --- | --- |
| concurrent inserts for one security/session | every price, derived and statement write takes `pg_advisory_xact_lock('stock-data-write:'‖id)` and is idempotent by key (delete-by-dates + insert, `@@id([securityId, date])`); every SC case asserts **0 duplicate `DailyPrice` rows** |
| concurrent derived rebuilds; prefix extension during reads | serialized by the stock lease and the advisory lock; a READ COMMITTED reader sees all-old or all-new rows of one transaction |
| coverage watermarks | merged under the advisory lock; `latestDate`/`lastSuccessfulSyncAt` max-merged, intervals only unioned — monotonic |
| partial failure and retry | A9 |
| deadlocks / unique conflicts | one advisory lock per transaction, no row locks: no lock-ordering cycle found; no unique conflict observed under 100 callers |
| duplicate refresh of one session | SC "warm": fifteen callers cost the provider exactly what one does |
| transaction durations, pool | bulk transactions 120 s / 30 s wait; a hydration runs up to six statement operations in parallel, each holding a connection while it waits on the advisory lock — size `connection_limit` per process (OPS-09, §7) |
| crash mid-write | transactions are atomic; the HYDRATING generation is taken over by the next lease holder (A10) |

### E. Provider (FMP)

| Scenario | Result |
| --- | --- |
| de-duplication | SC: coverage downloads (`MISSING_COVERAGE`) never overlap for any security under any caller count; the new-session tail is read once for fifteen callers |
| provider-wide limits, 429 / timeout / 5xx | unchanged: one `RedisFmpRequestGate`, `FmpClient` retry policy (existing suites) |
| queue growth when saturated | unchanged: OPS-05 (30 s lease sleep) remains, §6 |
| repeated EOD bars | idempotent (delete-by-dates + insert) |
| split list | single-flight per process only; two processes may each read it once per freshness window — P3, §6 |

### F. Invariants

| Invariant | Held by |
| --- | --- |
| at most one valid publication generation | compare-and-set on the manifest for every write and publication |
| no stale writer overwrites a newer generation | Redis: generation fence; PostgreSQL: §5 |
| a failed hydration never advertises READY | A9 |
| readers never combine generations | prices, derived state and now statements re-check the manifest after `MGET` |
| a cache miss or eviction cannot change results | SC LRU and cache-loss cases — **except** CONC-01, where a widening (not a miss) does |
| concurrent ≡ serialized | SC compares every concurrent answer with PostgreSQL and the synthetic market |
| no duplicated persisted rows | SC: 0 duplicate rows in every case |
| lost leases cannot commit stale data | Redis yes; PostgreSQL narrowed, §5 |
| retries converge | A9, A10 |
| no user state in the shared cache | §B |
| temporary failures are surfaced, never turned into values | A9 (the error reaches the caller; nothing READY); OPS-02 repair never invents a bar |

## 4. Measurements

### 4.1 Cold-cache QA matrix (the audit's §3.5 check)

40 core cases (`S01`–`S10` × `L03-C05`, `L05-C07`, `L08-C10`, `L10-C01`), concurrency 3, `--no-warmup
--no-cleanup --no-determinism`, each run on an **empty** Redis logical database, provider guard on,
dataset as of 2026-10-15:

| Code | Redis db | Completed | Failed | Trades | Provider requests | Wall | Evidence |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `main` @ `bc11cfed` | 10 | 35 | **5** (`EXECUTION_FAILED` in `PREPARING_DATA`, "generation changed" ×5 in the worker log, all among the first 11 submitted) | 26,687 | 0 | 207.6 s | sweep `2026-10-15-20261016-161733` |
| this branch | 11 | **40** | **0** — gate GREEN | **30,044** | 0 | 204.8 s | sweep `2026-10-15-20261016-162148` |

30,044 is exactly the trade count of the audit's warm sweep of these 40 cases: cold and warm agree.

### 4.2 Redis command volume (SC "bounded stress", cold, 4 processes, 3 securities)

Server-wide `INFO commandstats` deltas, so Lua-internal commands are counted; nothing else used the
server during the runs. "main" swaps `main`'s three source files back in.

| Callers | Redis commands main → branch | `PEXPIRE` main → branch | Provider price requests main / branch | Wall main / branch |
| ---: | --- | --- | --- | --- |
| 2 | 47,395 → 4,756 | 45,449 → 474 | 1 / 2 | 4.0 s / 7.2 s |
| 10 | 269,775 → 9,724 | 257,354 → 952 | 5 / 5 | 8.6 s / 8.3 s |
| 25 | 330,625 → 14,730 | 313,015 → 960 | 4 / 4 | 12.6 s / 11.1 s |
| 50 | 573,684 → 28,477 | 540,281 → 1,434 | 4 / 7 | 14.0 s / 12.2 s |
| 100 | failed on main (CONC-03) → 37,095 | — → 948 | — / 4 | — / 12.6 s |

Event-loop delay in the single test process (four "processes" share it, so an upper bound): p99 85–201
ms, max 181–656 ms on the branch. Provider request counts differ only by the random order of narrow
and wide callers (each widening downloads the missing prefix once).

### 4.3 Memory per resident security

From the branch's cold matrix run (Redis db 11, 30 resident matrix securities, 34-year histories,
real derived state at r8 and statements), `MEMORY USAGE` per key summed by security: **median 3.94
MiB, mean 3.78 MiB, max 4.04 MiB** (prices 1.29, daily-state 1.53, statements 0.92 MiB on average).
The capacity document's earlier "~2 MB at 34 years" predates the statement and wide derived columns;
its "≈ 4.64 MiB at the catalog's widest row" (audit OPS-01) is the conservative figure used below.

## 5. PostgreSQL consistency guarantees, and the residual stale-writer window

What holds, from the code:
- PostgreSQL is written only by the lease holder of a stock, under a per-stock transaction advisory
  lock, with keyed, idempotent writes (no duplicate rows, ever, in any run here).
- A stock's values in Redis are a projection of PostgreSQL rows: every SC case compares served values
  with PostgreSQL directly, and a complete cache loss rebuilds identical values with no provider
  request.
- A re-base replacement is fenced by the price-basis generation (compare-and-set under the advisory
  lock).

What remains: there is **no fencing token tied to the lease in PostgreSQL**. A holder that loses its
lease between its last ownership check and a commit can still commit. This branch narrows that
window from minutes to milliseconds — the loss is now detected within half a lease (CONC-02), the
holder stops at the next phase boundary when another holder has taken its generation over
(`assertGeneration`), and the price, derived and replacement transactions check ownership as their
last statement — but does not close it. The consequence is bounded: the stale writer's data is the
same provider data the successor writes, except across a re-base, where the replacement's generation
check refuses it but a stale tail save (`saveDailyPriceSync`) or derived save would not. Closing it
needs a lease epoch persisted per security and checked inside each write transaction (a schema
change), as the benchmark path does for tail saves with `expectedGeneration`. Recommended as a
follow-up; not a release blocker given the window.

## 6. Open items

| ID | Severity | Item | Recommendation |
| --- | --- | --- | --- |
| CONC-01 | P1 (data) | derived EMA/RSI depend on the history loaded at materialization; a narrow first hydration then a widening changes served values (pinned: SC "KNOWN DEFECT CONC-01") | anchor every load canonically — always hydrate from the retention start (the stock EOD child and thirty-year backtests already do), so the anchor is the security's first bar; cost: a never-seen security's first narrow view loads 34 years (≈ 8 provider requests, a few seconds) instead of ≈ 5. Ship with the r8 rebuild so no further revision bump is needed. Separate PR; changes load cost, so it is the owner's call |
| — | P2 | lease epoch for PostgreSQL writes (§5) | follow-up PR with a migration |
| R5 | P2 | a backtest's year-window read that misses can hydrate to today, i.e. reach the provider mid-run | read PostgreSQL on a mid-run miss, as `readFinalizedEvaluationFrame` does (audit §6.3 item 4) |
| R8 | P3 | a reader that misses waits up to the full 120 s lock wait and then fails rather than reading PostgreSQL | a short wait and a PostgreSQL fallback for pure reads, as the benchmark readers do |
| OPS-05 | P2 | a saturated FMP gate sleeps for the oldest lease (30 s) | poll at ≤ 250 ms (audit) |
| — | P3 | split list single-flight is per process | acceptable; one extra read per process per day |
| — | P3 | `upsertDatasetState` (fundamentals dataset state) is a read-modify-write outside a transaction | reachable only by two holders of one stock (§5) |

## 7. Recommended production limits

**Rule.** `R = STOCK_CACHE_MAX_RESIDENT_STOCKS ≥` monitored universe `+` Σ securities of the backtests
that may run at once `+` the API's working set (stocks viewed within an LRU cycle). Below that every
miss is correct but rebuilds the stock from PostgreSQL (§3 C, "LRU smaller than the working set").

**Memory.** `maxmemory ≥ 1.25 × (R × 4.64 MiB + H × 4.64 MiB + 64 MiB)`:
- `H` = hydrations that can be in flight at once — a HYDRATING generation is outside the LRU count
  until it publishes. Per process: backtest children × `BACKTEST_FRAME_LOAD_CONCURRENCY` (4), stock
  EOD `STOCK_EOD_SECURITY_CONCURRENCY` (2), the API's concurrent first views;
- 64 MiB covers the twenty-three fully resident benchmark series (prices only, ≈ 1.3 MiB each), rate
  limiting, the FMP gate and locks;
- 1.25 is allocator and fragmentation headroom.

Keep `noeviction` (the accepted policy): with `maxmemory` sized by this rule the LRU, not Redis,
decides what leaves; a full Redis now degrades warm reads to "served, recency not recorded" but still
fails hydrations, the FMP gate and fail-closed rate limits.

| `maxmemory` | `R` (with `H` = 20) | Fits, for example |
| --- | ---: | --- |
| 2 GB | ≈ 320 | 100 monitored + 200 in concurrent backtests (one PRO user's two 100-security runs) + 20 viewed |
| 4 GB | ≈ 670 | 300 monitored + 300 in concurrent backtests + 70 viewed |
| 8 GB | ≈ 1,380 | 600 monitored + 600 in concurrent backtests + 180 viewed |

(`R = (maxmemory / 1.25 − 64 MiB − H × 4.64 MiB) / 4.64 MiB`.) Leave the instance itself a few hundred
MiB above `maxmemory` for Redis's own buffers.

Do not raise `R` without `maxmemory`, nor worker concurrency without `H`: an unbounded Redis turns a
sizing mistake into an OS-level kill. PostgreSQL: set Prisma `connection_limit` per process type so
that Σ over processes stays under `max_connections` with headroom — a backtest child needs about
`BACKTEST_FRAME_LOAD_CONCURRENCY × 6 + 2` connections during cold hydrations (six parallel statement
operations per hydration), an API instance its HTTP concurrency.

## 8. How to reproduce

```bash
# the suite (real PostgreSQL and Redis; TEST_DATABASE_URL and REDIS_URL from .env)
pnpm --filter @intrinsic/stock-data exec vitest run src/stock-data-concurrency.integration.test.ts
# with measurements
STOCK_DATA_CONCURRENCY_REPORT=/tmp/concurrency.ndjson pnpm --filter @intrinsic/stock-data exec vitest run src/stock-data-concurrency.integration.test.ts
# the cold matrix check on an empty Redis logical database (never flush a shared one)
QA_MATRIX_REDIS_DB=<empty db> pnpm qa:matrix:run --case <40 ids> --concurrency 3 --no-warmup --no-cleanup --no-determinism
```

# Protected Stock Tier V1

## Status

**Accepted** with the S&P 500 point-in-time universe (`sp500-historical-pit-v1.md`). It changes the
stock cache's residency rules and nothing about what any value is: PostgreSQL stays canonical, every
key keeps its name and encoding, and a flushed Redis costs a rebuild, never data.

`AGENTS.md` invariant 16 carries the rule; `ai/architecture/production-capacity.md` carries the
Redis budget, and the cache module (`packages/stock-data/src/cache.ts`) the mechanism.

## Context

The stock cache keeps whole securities resident in Redis behind a bounded LRU
(`STOCK_CACHE_MAX_RESIDENT_STOCKS`, 100 by default): a complete, yearly-chunked projection of each
security's retained price history and unified daily derived state, published under a manifest and
evicted whole. That is the right shape for Stock Details and for user Lists of at most 100 stocks.

The point-in-time universe is not. A thirty-year backtest over it prepares ~730 securities and then
reads every one of them once per calendar-year window. Behind a 100-slot LRU each preparation
publishes into the LRU and evicts another security, so by the first window most of the universe is
gone again: every window read misses, invalidates and rebuilds the security from PostgreSQL. The
universe would also evict the stocks people are reading at the same moment.

## Decision

### 1. One cache, one key family, two residency rules

A **protected designation** — the Redis set `stock-data:v2:protected-stocks` — names the securities
that are resident **outside** the LRU. Nothing else changes: a protected security's keys are the
same `stock-data:v2:security:<id>:*` keys, written by the same code, in the same encoding, under the
same manifest and generation fence. There is no second copy and no second namespace.

The LRU's scripts honour the designation atomically, in Lua:

| Script                 | Protected security                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `publish-ready`        | resident outside the LRU: removed from `resident-stocks`, never counted, never a victim                                     |
| `touch-ready`          | no LRU position to refresh                                                                                                  |
| `begin-refresh`        | admitted although it has no LRU position                                                                                    |
| `evict-resident-stock` | evicted when asked explicitly (tooling), **keeping** its designation                                                        |
| the capacity loop      | a protected victim (never present while designation keeps the sets disjoint) is dropped from the LRU without deleting a key |

`protect-stocks` adds designations and moves a designated security out of the LRU. `unprotect-stocks`
(through `reconcileProtectedStocks`) returns one to the LRU as its most recently used member, and
the LRU's capacity then applies to it like any other. Both are batched (500 ids per call).

A READY protected security carries **no TTL**. The only TTL any of its keys ever has is the one an
in-flight generation carries (`hydrationTtlMs`) so that an abandoned hydration or refresh expires
instead of stranding keys — exactly as for every other security.

### 2. Who is protected

Only the built-in point-in-time universe's securities: every security PostgreSQL admits to the
universe (`IndexConstituent` resolved `RESOLVED`/`RESOLVED_PARTIAL`), current and former alike.
Former constituents stay protected: a backtest over any period reads them.

The designation is **derived, never authored**:

- `pnpm data:index-universe -- protect` reconciles the set from PostgreSQL;
- every backtest over the universe designates its own frozen securities before preparing them
  (`BacktestProcessorDependencies.protectedTier`), so a Redis that lost the set regains it from the
  first such run, and a user's List — which never carries a universe — can never designate anything.

### 3. Publishing from PostgreSQL alone

`CanonicalStockDataService.publishDurableProjection` republishes one security's whole projection
from PostgreSQL: its retained price history and derived state over the retention target, cut at
the newest date PostgreSQL has synchronized. It never reaches the provider and never recalculates.
It refuses — leaving Redis as it was — what PostgreSQL cannot project completely:

| Refusal                     | Meaning                                  | Repair                         |
| --------------------------- | ---------------------------------------- | ------------------------------ |
| `NO_PRICE_COVERAGE`         | no synchronized prices inside the target | ingestion                      |
| `PRICE_COVERAGE_GAP`        | a hole with a stored bar after it        | ingestion                      |
| `DERIVED_STATE_INCOMPLETE`  | derived state does not cover the prices  | the canonical loader's rebuild |
| `FUNDAMENTALS_NOT_INGESTED` | a statement dataset never synchronized   | ingestion                      |

A hole that begins **after** the newest stored bar, with synchronized coverage after it, is not a
hole in a history: it is what the re-base hold (`historical-price-basis-v1.md`) leaves when a
security's final bar is a crash it cannot verify (First Republic and SVB, 2023). PostgreSQL holds
no bar inside it and the canonical loader serves none either, so the publisher accepts it.

A security already resident over its whole durable coverage is left untouched, so a second
`protect` costs reads only.

The tail after the newest synchronization stays a freshness question for the read path
(`ensureStockFresh`), exactly as after any hydration: incremental updates are the canonical
loader's refresh, which rewrites only the changed years of a resident (protected or not) security.

### 4. Windows a history does not reach

A backtest reads every prepared security for every calendar-year window, including the years
before it listed and after it was delisted. The derived-state read used to treat an empty answer as
a cache miss: it invalidated the manifest and rebuilt the whole security, then read nothing again.
Over the universe that is ~400 rebuilds per thirty-year run for the 93 securities whose history
ended, plus the years before a late listing. An empty read is now an answer when the projection
lies outside the manifest's stored history (`canonicalHistoryStart` … `canonicalHistoryEnd`) and
the manifest did not move during the read; anywhere else it is still a miss and still repaired.

### 5. Memory and safety

Measured on the development Redis 7.0.15 after `protect` (2026-10-17), `MEMORY USAGE` of every
registered key of the 734 securities:

| Family                                               | Keys       | Bytes        |
| ---------------------------------------------------- | ---------- | ------------ |
| `daily-state:v2` (yearly, zstd-3 + field dictionary) | 20,791     | 398.4 MB     |
| `prices:1D` (yearly, zstd-3)                         | 20,791     | 125.6 MB     |
| registries (`keys`)                                  | 733        | 5.7 MB       |
| manifests, identities                                | 1,466      | 0.8 MB       |
| **Tier**                                             | **43,818** | **530.9 MB** |

Per security: mean 723 KB, p50 877 KB, p95 940 KB, max 1.05 MB (35 yearly chunks of each family
for a full retention). Redis `used_memory` went from 104 MB to 534 MB.

Since retention targets became clock bounds (`main`'s DATA-02, merged 2026-10-17), the 372
securities listed after the retention start are published over the whole retention too, their
pre-listing years as empty chunks (~420 bytes of `MEMORY USAGE` per security-year): **53,582 keys,
544.0 MB**, per security mean 741 KB, p95 941 KB. `protect` republished them from PostgreSQL with no
provider request.

- **Eviction policy.** Redis's own `maxmemory-policy` must stay `noeviction` (or no `maxmemory`):
  an `allkeys-*` policy could evict a protected chunk. Readiness already refuses one
  (`REDIS_ACCEPTED_EVICTION_POLICY` is the only override).
- **Headroom.** `protect` projects the tier's footprint before writing — per-security p95 of the
  already resident securities, 1.5 MB otherwise — and refuses when Redis would pass 85 % of a
  configured `maxmemory`, or the operator's `--memory-budget-mb`. Production should set `maxmemory`
  with at least 1 GB for this tier beside the 100-stock LRU (~75 MB) and the benchmark tier.
- **Statement chunks** are no longer projected at all (`FINANCIAL_STATEMENT_VERSION` 2). They were
  three quarters of a resident security's keys and ~30 % of its bytes, and no read path consumed
  them; statement reads go to PostgreSQL.

### 6. Recovery

Measured on real data, 4 vCPU, 2026-10-17:

| Operation                                                                                                                                    | Result                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `protect` over 734 stale securities (first fill, old keys replaced), concurrency 4                                                           | 767 s, 731 published, 2 refused then fixed (§3), 0 provider requests                                              |
| `protect` again (idempotent)                                                                                                                 | 4.8 s, 732 already resident, 2 published, 0 provider requests                                                     |
| **Redis lost**: every `stock-data:v2:security:*` and `symbol:*` key, the LRU and the protected set deleted (534 MB → 2.5 MB), then `protect` | **775 s**, 734 published, 0 refused, 0 failed, **0 provider requests**; the tier back to 43,818 keys and 530.9 MB |
| the next thirty-year universe backtest                                                                                                       | completed in 72.6 s with the **identical result digest** of every run before the loss                             |
| integration: flush the namespace, reconcile, publish                                                                                         | byte-for-byte the same chunks, no provider, no recalculation                                                      |

Without `protect`, the first universe backtest after a loss designates its securities and
rebuilds each one through the canonical loader as it prepares it; that path reaches the provider
for a security whose PostgreSQL coverage has a held tail, so `protect` is the provider-free
recovery.

## Consequences

- A universe backtest's windows are answered from Redis without a PostgreSQL read.
- The LRU keeps its 100 slots for the stocks people read; the universe no longer competes for them.
- Redis needs ~0.55 GB more for the universe (544 MB measured). A larger universe (another index) is a budget
  decision, re-checked with `protect --dry-run` before it is designated.
- Losing Redis costs one `protect` (~13 minutes) or the first universe backtest's preparation.

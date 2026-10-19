# Stock Cache Tiers V1

## Status

**Accepted** (2026-10-19). Builds on `protected-stock-tier-v1.md` — whose key family, publisher,
measurements and recovery path stand — and changes three things about it: which securities are
protected is decided from PostgreSQL at every admission rather than by a Redis set alone; no key of
a protected security ever carries a TTL, in flight included; and the ordinary LRU is a count of
securities, `STOCK_LRU_MAX_SECURITIES`, enforced at every admission and every read. PostgreSQL stays
canonical and nothing about any value changes: a flushed Redis costs a rebuild, never data.

`AGENTS.md` invariant 16 carries the rule; the mechanism is `packages/stock-data/src/cache.ts` and
`protected-tier.ts`.

## Context

Protected Stock Tier V1 kept the S&P 500 point-in-time universe resident outside the LRU, named by
the Redis set `stock-data:v2:protected-stocks`, which `protect` and universe backtests filled from
PostgreSQL. Reviewing it for a deployment where both tiers carry production traffic found four
gaps:

1. **Routing lived in Redis.** A security was protected only if the set named it. After a Redis that
   lost the set (a flush, a restore from an older snapshot), every universe security a read or a
   hydration touched went into the LRU — 735 securities competing for 100 slots — until someone ran
   `protect` again.
2. **A touch could pass the capacity.** `touch-ready` added any READY security that was not
   protected to the LRU, without the capacity loop: a lost designation or a lost LRU turned every
   read into an unbounded insertion, and the next publication then evicted to the count in one go.
3. **Protected data could expire.** A refresh of a protected security gave every one of its keys the
   in-flight TTL (15 minutes). A refresh abandoned by a crashed worker expired the whole security's
   history; a `volatile-*` eviction policy could take it under memory pressure meanwhile.
4. **The capacity was named for something else.** `STOCK_CACHE_MAX_RESIDENT_STOCKS` read as a bound
   on everything resident; it bounded only the LRU, and nothing said it was a count of securities
   rather than of keys or bytes.

## Decision

### 1. Two tiers, one key family

|          | Protected tier                                                                                                                                                                                   | LRU tier                                                            |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Who      | every security a built-in point-in-time universe admits in PostgreSQL (`IndexConstituent` `RESOLVED`/`RESOLVED_PARTIAL`), current and former members alike, plus any `protectStocks` designation | every other security                                                |
| Bound    | none (the universe: 735 securities, 544 MB)                                                                                                                                                      | `STOCK_LRU_MAX_SECURITIES` distinct securities                      |
| Eviction | never by the LRU; only an explicit `evict` (tooling) or a demotion                                                                                                                               | least recently used first, whole, at every admission and read       |
| TTL      | none on any key, ever                                                                                                                                                                            | none once READY; an in-flight generation expires whole if abandoned |
| Record   | `stock-data:v2:protected-stocks` (derived)                                                                                                                                                       | `stock-data:v2:resident-stocks` (sorted by access)                  |

Both tiers are the same `stock-data:v2:security:<id>:*` keys — manifest, registry, yearly price and
daily-state chunks in the one versioned payload codec — written by the one canonical loader
(`CanonicalStockDataService`) under the same generation fence. A tier is only which residency rule
the Lua scripts apply; a security is never stored twice, and the two records are disjoint.

### 2. Configuration

`STOCK_LRU_MAX_SECURITIES` — the LRU's capacity, a **count of distinct securities**. Default **100**,
the V1 value, so nothing changes where it is unset. Each security counts once by its stable id,
however many keys or years it holds; Redis memory is never an admission or eviction criterion and
has no setting of its own. `STOCK_CACHE_MAX_RESIDENT_STOCKS` and `STOCK_CACHE_MAX_RESIDENT_SYMBOLS`
still configure it; naming two different values is refused at startup.

Sizing: an LRU security costs what its history costs — 0.4–1.0 MB at full retention (the 9
non-universe stocks measured below: 0.39 MB mean; universe securities 0.74 MB mean) — so 2,000
securities need about 0.8–2 GB beside the protected tier's 0.55 GB. Every process must be given the
same value: each one enforces its own at the admissions and reads it makes, so after a change the
new count is reached at the next access under it.

### 3. Routing

Every admission routes **inside its script**, atomically with what it writes:

| Admission                               | Script            | Protected (`P`)                          | LRU (`L`)                                                       |
| --------------------------------------- | ----------------- | ---------------------------------------- | --------------------------------------------------------------- |
| a hydration starts                      | `begin-hydration` | designated; the generation is persistent | the generation carries the in-flight TTL                        |
| a refresh starts                        | `begin-refresh`   | designated; keys stay persistent         | every key takes the in-flight TTL; leaves the LRU while it runs |
| a generation is published               | `publish-ready`   | designated; removed from the LRU         | newest LRU member; capacity enforced                            |
| a READY security no tier counts is read | `admit-resident`  | designated                               | newest LRU member; capacity enforced                            |

The tier is `P` when the canonical universe admits the security **or** Redis already designates it
(a backtest's own designation, `protectStocks`). The universe comes from PostgreSQL through
`CanonicalProtectedTierEligibility`: read once per process, then served from memory and re-read in
the background every 60 s, so no cache read waits for PostgreSQL. Every composition root that
writes the product's stock cache passes it — the API (Stock Details and every stock endpoint), the
backtest, Monitor and stock-EOD workers, `index-universe`, `fmp:live` and `resync` — so every
consumer routes a security the same way. Suites and tools in a namespace of their own pass nothing
(`REDIS_DESIGNATION_ONLY`) and route by the designation alone.

**Promotion.** A snapshot that admits a security the previous one did not is designated in Redis
before anything acts on it: `protect-stocks` adds the designation and removes the LRU membership, and
the data stays exactly as it is — no rewrite, no rehydration, its slot freed. The same step restores a
designation Redis lost, at the first admission of every process. **Demotion** is explicit: a
security that leaves the universe (a corrected identity) is returned to the LRU, under its count, by
`protect` (`reconcileProtectedStocks`) once every process has reloaded the universe.

Historical membership is enough: a former constituent stays protected after it left the index,
because a backtest over its years still reads it. Backtest snapshots and point-in-time membership
are untouched — the tiers decide residency, never what a run reads.

### 4. The LRU

- **Count, by id.** The LRU is a sorted set of security ids scored by a monotone access clock
  (`access-sequence`, never below the newest score, so a lost counter cannot rank new accesses behind
  old ones).
- **Atomic, whole eviction.** Admission and eviction are one script: while the set holds more than
  the count, its least recently used member is removed and every key its registry names is deleted,
  identity row included. A security is never half evicted, and no reader can count a victim as
  resident afterwards (its manifest is gone with its chunks). PostgreSQL is never touched.
- **Touch never adds.** A read's `touch-ready` moves an LRU member to most recent and enforces the
  count (one `ZCARD` when nothing is over it), so a capacity lowered by configuration is reached at
  the next LRU read; a protected read changes nothing in the LRU. A READY security neither tier counts is
  handed to `admit-resident` instead, under the same rules as a publication.
- **In flight.** A security being hydrated or refreshed is in neither record until it publishes; its
  generation is bounded by the hydration lock and, for the LRU tier, by its TTL.
- **Observable.** Every eviction is logged with its victims (`stock-data.cache.lru-evicted`).

### 5. Redis safety

**The actual policy.** This environment's Redis 7.0.15 runs `maxmemory 0`, `maxmemory-policy
noeviction`, RDB snapshots (`save 3600 1 300 100 60 10000`), no AOF. With no limit, Redis never
evicts; at a limit under `noeviction` it refuses writes, which the read path already survives
(OPS-03: the read is served, only its LRU access is lost).

**Under any policy.** No protected key ever has a TTL — not READY, not mid-hydration, not
mid-refresh — so no `volatile-*` policy can evict one. An `allkeys-*` policy could evict any key and
is the one thing that would silently break the tier: readiness already refuses it unless an
operator names it in `REDIS_ACCEPTED_EVICTION_POLICY`; `protect` now refuses to publish under it;
the API and every backtest worker log the verdict at startup (`redis.eviction-policy`). Key prefixes
are not relied on for anything. Infrastructure memory monitoring stays what it is — `protect`
projects the tier against `maxmemory` before writing — and is never an LRU input.

**Restart and loss.** Every script is atomic, so an RDB snapshot never holds half an admission or
half an eviction; a restart restores both tiers exactly. A Redis that lost everything is rebuilt by
`protect` from PostgreSQL alone, and in the meantime every read routes by the universe and rebuilds
what it needs through the canonical loader.

### 6. Audit

`pnpm data:index-universe -- tiers` (and `scripts/cloud/fmp-index-universe.sh tiers`) audits both
tiers against PostgreSQL's universe, read-only: designated, READY and in-flight protected securities,
any protected key with a TTL, LRU members against the count, members without a READY manifest,
READY securities in neither tier, securities in both, universe securities in the LRU or not
designated, exact bytes per tier (`MEMORY USAGE`), and the eviction-policy verdict. Its `violations`
must be empty.

## Validation

Measured on this environment's real PostgreSQL and Redis (4 vCPU, 16 GB, Redis 7.0.15), 2026-10-19.
Artifacts: `artifacts/sp500-historical-pit/tiers-*.json`, `protect-after-loss.json`,
`tiers-backtests.jsonl` (git-ignored). No step reached the provider unless stated.

**Population.** The three recovered constituents (`sp500-historical-pit-v1.md` §4.1) took the
universe to 735 securities; Cablevision's ingestion routed it straight into the protected tier.
Nine stocks no universe holds (SHOP, SNOW, ROKU, ZM, NET, RBLX, TM, ASML, MDB) were hydrated through
the guarded live command (141 provider requests) and landed in the LRU; the protected tier's bytes
did not move.

| Tier                | Securities                      | Keys   | Bytes (`MEMORY USAGE`)               |
| ------------------- | ------------------------------- | ------ | ------------------------------------ |
| Protected           | 735, all READY, none with a TTL | 53,655 | 544.3 MB (mean 0.74 MB, p95 0.94 MB) |
| LRU (the nine)      | 9                               | 657    | 3.5 MB (0.39 MB each)                |
| Redis `used_memory` |                                 | 54,073 | 549.4 MB                             |

**Exact LRU eviction** (`bench:stock-cache-tiers -- lru`, `STOCK_LRU_MAX_SECURITIES=5`): 32 Stock
Details reads — every ordinary security, re-reads, re-admissions after eviction, protected reads
between — each compared with a reference count-bounded LRU. **0 mismatches**: after every read the
LRU held exactly the model's members in the model's order, every victim had no key left, and every
read equalled PostgreSQL's rows. The first read under the lowered capacity evicted the 86 surplus
members at once. Hits took a median 4 ms; a miss rebuilt the security from PostgreSQL in 0.3–1.8 s
(median 0.48 s) and evicted exactly one victim; protected reads (3 ms) never changed the LRU. The
protected tier's digest (every designation, manifest and registry, plus every chunk byte of six
securities) was identical before and after.

**Concurrency** (`-- concurrency`, six OS processes, capacity 3): 720 random reads (511 LRU, 209
protected, 351 of them cold rebuilds) in 59 s. 0 mismatches against PostgreSQL, 0 errors, the LRU
never above 3 in 10,060 samples taken during the run, no key left behind by any evicted security,
protected digest unchanged, audit clean, 0 provider requests. Four processes at capacity 4: 480
reads (193 cold), 0 mismatches, 0 errors, never above 4 in 8,303 samples.

**Restart.** `SHUTDOWN SAVE` and a restart: 54,073 keys reloaded from the RDB snapshot; the tier
digest (designations, manifests, registries, chunk bytes, LRU order) was identical.

**Loss and rehydration.** Every `stock-data:v2` key deleted (549 MB → 1.9 MB), then `protect`:
735 published from PostgreSQL alone in **736 s**, 0 refused, 0 provider requests, 544.3 MB. Deleting
six securities again and republishing them reproduced their price and daily-state chunks byte for
byte. The nine LRU securities came back through ordinary reads.

**No duplication.** Every audit (before, after population, after each experiment, after the
backtests): 0 securities in both tiers, 0 universe securities in the LRU, 0 READY securities in
neither, 0 protected keys with a TTL.

**Backtests** (`bench:pit-backtests`, simple SMA-200 strategy, 1996-10-21 → 2026-10-16, isolated
configuration: no provider, frozen tails):

| Run                                                                     | Per run                          | Throughput                   | Result                                    |
| ----------------------------------------------------------------------- | -------------------------------- | ---------------------------- | ----------------------------------------- |
| Universe (735), 1 worker, 2 runs                                        | 71.7 s, 70.8 s (PR #124: 76.9 s) | 47.8 /h                      | identical digests, Redis hit rate 1.0     |
| Universe, 4 workers, 4 runs                                             | p50 92.9 s (PR #124: 97.1 s)     | 148.8 /h (PR #124: 142.6 /h) | identical digests (all six universe runs) |
| Mixed List (14 protected + 9 LRU), cold then warm                       | 9.3 s, 3.9 s                     | —                            | identical digests                         |
| Mixed List, `STOCK_LRU_MAX_SECURITIES=3` (289 evictions during the run) | 148 s                            | —                            | **the same digest**                       |

The routing and the count-enforcing touch cost nothing measurable on the universe runs (the period
is four days shorter than PR #124's, which it does not explain): a protected read is one
`SISMEMBER` more than before, an LRU read one `ZCARD`. A List whose ordinary securities exceed the
LRU's count stays correct and becomes slow — every year window rebuilds them from PostgreSQL —
which is what the count is sized against (§2).

## Consequences

- A lost designation, a lost LRU or a lost access counter no longer changes which tier a security is
  in, and no longer lets the LRU pass its count.
- A crashed refresh can no longer expire a protected security's history. An abandoned protected
  generation stays until the next lease holder takes it over (the first read, or `protect`).
- The LRU's capacity is a number of securities and nothing else; Redis memory is sized from it and
  from the protected tier, never the other way round.
- Every process that writes the stock cache reads the universe from PostgreSQL once a minute (one
  indexed query over ~1,250 rows).

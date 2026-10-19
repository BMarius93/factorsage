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

RESULTS_PLACEHOLDER

## Consequences

- A lost designation, a lost LRU or a lost access counter no longer changes which tier a security is
  in, and no longer lets the LRU pass its count.
- A crashed refresh can no longer expire a protected security's history. An abandoned protected
  generation stays until the next lease holder takes it over (the first read, or `protect`).
- The LRU's capacity is a number of securities and nothing else; Redis memory is sized from it and
  from the protected tier, never the other way round.
- Every process that writes the stock cache reads the universe from PostgreSQL once a minute (one
  indexed query over ~1,250 rows).

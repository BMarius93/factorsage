# S&P 500 Historical PIT, Redis residency and backtest throughput — engineering report, 2026-10-17

- **Branch:** `feat/sp500-historical-pit` (PR to `main`, not merged).
- **Environment:** Claude cloud VM — 4 vCPU Intel Xeon @ 2.80 GHz, 16 GB RAM, no swap; Node 22.23.2,
  PostgreSQL 16, Redis 7.0.15 (`noeviction`, no `maxmemory`), all local. Provider: the FMP plan
  configured for this environment, reached only through `scripts/cloud/fmp-index-universe.sh`.
- **Decision records:** `docs/decisions/sp500-historical-pit-v1.md`,
  `docs/decisions/protected-stock-tier-v1.md`, `docs/decisions/redis-payload-codec-v1.md`.
- **Evidence:** local and git-ignored (`artifacts/sp500-historical-pit/`): the coverage report,
  the `protect` outputs, the benchmark JSONL and per-worker logs. Every number below comes from
  them; no provider payload is committed.

## A. Point-in-time coverage

| Measure                                                           | Value                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Change-log entries / renames / current members (provider)         | 1,531 / 5,506 / 503                                                                                                       |
| Constituents reconstructed (all time) / in the 1996-01-02 horizon | 1,793 / 1,242                                                                                                             |
| Periods by quality                                                | 1,469 `CONFIRMED`, 303 `START_BEFORE_LOG`, 21 `END_UNKNOWN` (reported, never projected)                                   |
| Identity tier of each start                                       | 1,376 exact ticker, 92 ticker history, 1 name, 324 before the log                                                         |
| Resolution                                                        | 728 `RESOLVED`, 33 `RESOLVED_PARTIAL`, 428 `NO_PROVIDER_DATA`, 22 `IDENTITY_REJECTED`, 31 `NOT_ADMISSIBLE`                |
| Tradeable securities in the List / buy windows                    | **734** / 760                                                                                                             |
| Addition starts (reconstruction v2)                               | 311 on a refined effective date, 308 on a confirmed one, 871 the day after an unconfirmed log date                        |
| Lines per day, min / max                                          | 494 (1996-03-29) / 507 (2020-04-03)                                                                                       |
| Days inside the 500–506 band                                      | 7,846 of 11,247                                                                                                           |
| Anomalies recorded                                                | 183 (116 first-added mismatch, 25 ticker collision, 21 orphan addition, 18 ambiguous addition, 3 effective-date conflict) |

`NOT_ADMISSIBLE` = 25 without any provider listing, 3 OTC, 3 CBOE. `IDENTITY_REJECTED` = histories
belonging to another issuer (a current member's ticker, an implausible market capitalization).

**Effective dates.** The provider's change log dates a change either on its effective session or
on the rebalancing session before it (221 of the 291 log dates the current list can check). Where
nothing establishes which (624 log dates), reconstruction v2 starts an addition the day after the
log's date, so a membership never begins on a session the provider's records leave in doubt;
version 1 started them on the log's date. Checked against published effective dates (decision §7):
Yahoo 1999, NVIDIA/Enron 2001, Google 2006, Netflix 2010, Facebook 2013, Twitter 2018 and 2022,
Tesla 2020, Moderna 2021 and nine additions 2023–2025 are placed exactly (Yahoo, Google and Twitter
were one session early in v1); Monsanto's 2018 removal ends one session short; Amazon's 2005
addition starts one session early because both provider records date it on the rebalancing
session. Re-resolving the 681 constituents whose dates moved reproduced the same 734 securities
(3,060 provider requests).

**Priced share of member-days** (a stored price for the (member, session) pair):

| 1996   | 1999   | 2002   | 2005   | 2008   | 2010   | 2012   | 2014   | 2016   | 2018   | 2020   | 2022–2026 |
| ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | --------- |
| 41.9 % | 50.0 % | 56.2 % | 63.9 % | 73.0 % | 78.6 % | 82.1 % | 85.0 % | 91.4 % | 95.1 % | 98.2 % | ≥ 99.5 %  |

**Unreliable periods:** 1996–2009 for absolute performance (survivorship from the provider's
history, < 80 % of member-days priced); 2010–2015 usable with care; 2016 onward reliable. The
List's own description says so.

## B. Ingestion

| Dataset in PostgreSQL | Rows      | Securities | Span                           |
| --------------------- | --------- | ---------- | ------------------------------ |
| daily prices          | 4,994,827 | 734        | 1992-10-16 … 2026-10-16        |
| daily derived state   | 4,991,123 | 734        | 1992-10-16 … 2026-10-16        |
| financial statements  | 318,130   | 732        | fiscal 1989-10-31 … 2026-09-30 |
| insider transactions  | 2,569,857 | 729        | 2003-05-06 …                   |
| congressional trades  | 44,913    | 686        | 2014-02-01 …                   |
| stock splits          | 2,490     | 548        |                                |
| weekly prices         | 1,034,942 |            |                                |

- **Run:** 3 hash shards × concurrency 2, ~50 minutes, 731 securities in one pass (3 loaded
  earlier); 11,183 provider requests announced by the loaders, 11,931 HTTP attempts admitted by the
  guard (pages and retries included). Resumable progress per security in
  `IndexUniverseIngestion`; all 734 `SUCCEEDED`.
- **Provider limits, exactly as observed:** the default gate of 20 requests/s drew HTTP 429s; at
  `FMP_RATE_LIMIT_PER_WINDOW=8` (8 requests per 1 s window, shared across processes through Redis)
  there were **zero** 429s over ~12k requests — the plan's limit lies between 8 and 20 requests/s.
  `symbol-change` returns at most the requested 100,000 rows (5,506 used); the client refuses a
  full page rather than assume completeness. Alternative data was bounded at 40 pages per security.
- **Failures:** 1 (BNY — one statement row without a readable filing date); fixed in the mapper
  (such a row is left out, never dated by guess) and retried: 2 requests.
- **Interior price gaps:** 3 securities (FRO 597 sessions, CVG 17, SVU 10). Two failed banks (FRC,
  SVB) end one session early: the re-base hold keeps a terminal crash bar it cannot verify.

## C. Redis

**Audit** (`redis-payload-codec-v1.md`): yearly price and daily-state chunks and benchmark chunks are
the bulk; manifests, heads, registries, LRU, protected set, locks, gates and rate limits are
coordination state and are never encoded.

**Changes:**

1. One versioned, checksummed payload codec for every bulk family (zstd-3; daily-state primed with
   its field dictionary); legacy JSON still read; damaged or unknown payloads are misses that
   rebuild from PostgreSQL.
2. Financial statements removed from Redis (no reader; 22,800 of 30,124 keys and ~280 KB per
   resident security before).
3. A protected tier for the universe: same keys, outside the LRU, no TTL, published from
   PostgreSQL alone.

**Measured tier** (`MEMORY USAGE` of every registered key, 734 securities, 43,818 keys):
530.9 MB — daily state 398.4 MB, prices 125.6 MB, registries 5.7 MB, manifests and identities
0.8 MB; per security mean 723 KB, p95 940 KB, max 1.05 MB. Redis `used_memory` 104 MB → 534 MB.

Codec comparison on real stored histories (40 securities, 2,800 chunks; `redis-payload-codec-v1.md`
"Measured"): zstd-3 cuts `MEMORY USAGE` by 84 % for prices and 58 % for daily state; gzip and brotli
at comparable speed land within a few percent; zstd-19 would save a further ~95 MB of the tier at
~20× the encode CPU on every hydration and was not adopted. Decompression is ~6 s of a thirty-year
run's ~93 s CPU; parsing, not decompression, is the read cost.

**Recovery:** see `protected-stock-tier-v1.md` §6 (flush everything, rebuild from PostgreSQL,
identical result digest).

## D. Backtest performance

`sp500-historical-pit-v1.md` §10 has the full table. Thirty-year runs (1996-10-17 … 2026-10-16,
732 securities, peak 506 members), warm protected tier, real submission path and worker processes:

| Workers = runs          | Strategy                                                                                    | Per run p50 | Throughput   | Worker RSS total | CPU busy | Failed | Identical |
| ----------------------- | ------------------------------------------------------------------------------------------- | ----------- | ------------ | ---------------- | -------- | ------ | --------- |
| 1 (before optimization) | simple                                                                                      | 101.0 s     | 34.5 /h      | 0.41 GB          | 35 %     | 0      | —         |
| 1                       | simple                                                                                      | 76.9 s      | 44.8 /h      | 0.40 GB          | 35 %     | 0      | yes       |
| 1                       | complex (technical + fundamental, 5 conditions + trigger, 2 buy levels, sell, 2 exit rules) | 98.6 s      | 35.1 /h      | 0.44 GB          | 43 %     | 0      | yes       |
| 1                       | monthly contributions, max 10 positions                                                     | 81.3 s      | 43.2 /h      | 0.40 GB          | 46 %     | 0      | yes       |
| 2                       | simple                                                                                      | 81.4 s      | 85.1 /h      | 0.83 GB          | 68 %     | 0      | yes       |
| 4                       | simple                                                                                      | 97.1 s      | **142.6 /h** | 1.74 GB          | 97 %     | 0      | yes       |
| 8                       | simple                                                                                      | 199.6 s     | 137.8 /h     | 3.26 GB          | 99 %     | 0      | yes       |
| 16                      | simple                                                                                      | 406.3 s     | 136.9 /h     | 6.38 GB          | 99 %     | 0      | yes       |

Redis hit rate 1.0 and zero provider requests in every run; one result digest per strategy across
every concurrency level. Measured on the version-1 List; repeated on the version-2 List (simple
75.0 s at 2 workers, complex 94.7 s, monthly 77.8 s, again deterministic — new digests for simple
and complex, unchanged for monthly). **Bottleneck: worker CPU** (chunk decoding ~44 %, price chunks ~14 %,
simulation ~10 %); Redis and PostgreSQL far from saturation. 32/64/128 workers were not run: ~14 /
28 / 56 GB of worker memory against ~13 GB available, and no throughput to gain on 4 cores.

## E. Change set

- **Migration:** `20261017120000_sp500_historical_pit` (seven tables, enums; additive only).
- **Commits:** see the pull request.
- **Tests added:** reconstruction (14) and resolution (13) units; market-index (6); contracts
  entitlements (universe allowance); FMP mapper (undatable statement rows); payload codec (12);
  cache protected tier (4 unit, 1 real-Redis); integration: protected publication byte-for-byte,
  LRU isolation, flush recovery, refusals, empty windows, re-base-hold histories, window carry,
  statement-chunk migration; worker: universe designation (2), snapshot ceilings (5); API:
  universe submissions — Pro accepted, Starter refused, 602-member refusals by plan and engine,
  copies held to List rules — and the maintained List's read-only routes; web: the form's universe
  allowance (4) and the List detail (1).
- **Risks:** see `sp500-historical-pit-v1.md` §9; the first universe backtest after a Redis loss
  rebuilds the tier (~13 minutes) unless `protect` ran first; production freshness (6 h
  fundamentals, 30-minute session retries) costs provider requests for the universe's delisted
  securities that a frozen benchmark does not show.

## F. Completion status

| Objective                                                                                   | Status                                                                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1. Built-in S&P 500 Historical PIT List, identity-based, verified, Pro allowance end to end | **Done and verified** (data, API, worker, web, OpenAPI, tests)                                                   |
| 2. Full history in PostgreSQL for every resolvable constituent                              | **Populated and verified** (734/734); 428 constituents have no provider data (blocked by the provider, reported) |
| 3. Redis audit and codec                                                                    | **Done**; codec comparison measured on real payloads                                                             |
| 4. Whole universe resident in Redis                                                         | **Populated, verified, recovery measured**                                                                       |
| 5. Thirty-year backtests and concurrency scaling                                            | **Benchmarked** 1→16 workers; 32–128 not safe on this host (memory)                                              |
| 6. Validation gate                                                                          | see the pull request                                                                                             |

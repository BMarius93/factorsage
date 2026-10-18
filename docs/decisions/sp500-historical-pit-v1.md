# S&P 500 Historical Point-in-Time Universe V1

## Status

**Accepted** (owner request, 2026-10-17). Supersedes the earlier rule that no index membership is
synchronized or reconstructed (`AGENTS.md` invariant 1, now rewritten): exactly one universe — the
S&P 500 — is reconstructed into one built-in List. Everything else about Lists, buy windows and
backtests is unchanged.

Related records: `protected-stock-tier-v1.md` (keeping the universe resident in Redis),
`redis-payload-codec-v1.md` (how its chunks are stored), `entitlements-v1.md` (the Pro allowance).

## §1 Goal and non-goals

A built-in SYSTEM List, **S&P 500 — Historical PIT** (`systemKey` `sp500-historical-pit`), holding
every security that was an S&P 500 constituent since 1996-01-02, each eligible to **buy** only while
it was a member (CUSTOM buy windows, `AGENTS.md` invariant 3). A backtest over it trades the index
as it was on each date — former constituents included, today's constituents never substituted.

Non-goals: other indices; index weights; an announcement-date model (the provider publishes none);
forced liquidation at removal (a buy window never constrains a SELL or a FINAL EXIT).

## §2 Provider data

Measured on the FMP plan configured for this environment, 2026-10-17:

| Endpoint                                                              | Gives                                                              | Used for                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- |
| `sp500-constituent`                                                   | 503 current lines, with `dateFirstAdded`                           | the one fully known state; effective-date refinement |
| `historical-sp500-constituent`                                        | 1,531 changes since 1957 (added/removed ticker and name, one date) | the change log                                       |
| `symbol-change`                                                       | 5,506 renames (11 dropped as malformed)                            | ticker identity over time                            |
| `delisted-companies`                                                  | paginated directory                                                | identities and exchanges of gone issuers             |
| `historical-market-capitalization`                                    | daily market cap                                                   | identity plausibility                                |
| prices, statements, profile, splits, insider and congressional trades | per security                                                       | the history itself (§6)                              |

The provider records **no announcement dates**, and its change log gives one date per change that
is either the effective date or the rebalancing session before it — the session before for 221 of
the 291 log dates today's list can check (§4). The log is complete enough to reconstruct 494–499
lines per day before 2005, against the index's 500: the provider's history is the limit (§9).

## §3 Canonical model (PostgreSQL)

Migration `20261017120000_sp500_historical_pit`:

- `IndexConstituentChange` — the provider's change log, content-addressed (`contentHash`), kept as
  delivered;
- `SymbolChangeRecord` — the rename history;
- `IndexMembershipSync` — one row per synchronization: source digest, counts, anomalies, quality;
- `IndexConstituent` — one issuer line: origin (`CURRENT`, `REMOVAL`, `ORPHAN_ADDITION`), ticker
  history, resolution and the evidence for it, and the resolved `securityId`;
- `IndexMembershipPeriod` — `startDate`/`endDate` (inclusive), the log's own dates beside every
  boundary that moved away from them (`startLogDate`, `endLogDate`: refined or deferred, §4), the
  change hashes, the identity tier (`startMatch`) and a quality (`CONFIRMED`, `START_BEFORE_LOG`,
  `END_UNKNOWN`);
- `IndexUniverseIngestion` — per-security ingestion progress (§6).

A synchronization replaces the reconstruction transactionally and is idempotent: the same source
digest produces the same rows. The List is a **projection** of these tables, never edited directly.

## §4 Reconstruction and identity

`packages/stock-data/src/index-membership/reconstruction.ts` — pure, deterministic, versioned
(`INDEX_RECONSTRUCTION_ALGORITHM_VERSION` 2):

1. **Backward walk.** Start from the current list; walk the change log from newest to oldest,
   undoing each change. No period is assumed: a period exists only between a recorded addition and
   a recorded removal, or the current list.
2. **Identity, not tickers.** Each walked constituent carries its ticker history; renames are
   undone along the way (META is FB before 2022-06-09; AT&T Inc. was SBC until it took `T` from the
   AT&T Corp. it absorbed). Additions match a member in three recorded tiers: `EXACT_TICKER`
   (1,376 periods), `TICKER_HISTORY` (92), `NAME` ≥ 0.85 similarity (1).
3. **Effective dates, never early.** A log date is checked against the current list's
   `dateFirstAdded` of the members it adds (a ticker no current member holds is followed through
   later renames: Bank of New York was added as BK and is BNY today). One to four days later and
   uncontradicted, the date is **refined** — every change on it, additions and removals together,
   because a replacement's two sides take effect together; equal, it is **confirmed**. Measured over
   the 915 log dates that add an issuer: 221 refined (one day later 152, two 6, three 57, four 6),
   70 confirmed (two of them contradicted by another member's date — reported as
   `EFFECTIVE_DATE_CONFLICT` — and kept) and 624 unconfirmed: 623 with no current member to speak
   for them and one whose members disagree (Google's, 2006-03-31). On those 624 the log's date may
   name the effective session or the one before it, so an addition starts the **day after** it and a removal ends the day before it:
   membership is never claimed for a session the provider's records leave in doubt, at the price
   of one session where the log's date was already effective. A confirmed date is two provider
   records agreeing, not proof: both date Amazon's addition 2005-11-18, the rebalancing session
   before its 2005-11-21 effective date (§7), and nothing in the data tells such a date apart (28 of
   the 68 uncontradicted confirmed dates fall on a Monday, as effective dates mostly do). Of 1,490 applied additions, 311 start
   on a refined date, 308 on a confirmed one and 871 the day after their log date. A security that
   leaves and rejoins on one such date (a merger's survivor: DowDuPont becoming DuPont in 2019)
   keeps that day in the List — under either reading it was a member. Version 1 started those 871
   additions on the log's date, one session early in most cases (Twitter, Yahoo, Google in §7).
4. **Never invented.** An addition with no later removal that is not a member today is
   `END_UNKNOWN` (21) and is reported, never projected.

Resolution (`resolution.ts`) links a constituent to the catalog `Security` whose prices are its
history, refusing rather than guessing: candidates (own ticker, forward renames, tickers held
while a member); prices inside the membership; plausibility — market capitalization on the first
membership session against $500M ($100M for a member already in the index at the horizon), read
only when consistent with the stock's own traded value (the provider reports $0 and $6M for some
1990s large caps; a capitalization below two days of median traded value is ignored and a $2M
median daily traded value is required instead); one security per constituent at a time (the
current member keeps its own symbol). Admission to the catalog goes through
`CanonicalSecurityCatalogService` (NASDAQ, NYSE and AMEX only).

Outcome over the horizon (1,242 constituents): `RESOLVED` 728, `RESOLVED_PARTIAL` 33 (prices cover
under 90 % of the membership), `NO_PROVIDER_DATA` 428, `IDENTITY_REJECTED` 22, `NOT_ADMISSIBLE` 31
(exchange outside the catalog, e.g. CBOE- or OTC-listed, or no listing at all). **734 tradeable
securities**; 10 overlap conflicts resolved, all recorded.

## §5 The built-in List and backtests

`pnpm data:index-universe -- project` writes the List: 734 members, 759 buy windows (a security
that left and rejoined the index has two). Its `canEdit` is false for every caller, administrators
included, and every List write refuses it (`SystemContentMaintainedError`); duplicating it gives an
ordinary List held to ordinary limits.

A backtest over it is measured by **the most members eligible on any one date of the run's period**
(`peakSimultaneousMembers`), never its distinct count:

- plan allowance `backtests.maxIndexUniverseConstituents`: Pro 550 (the index's ~500 lines plus
  dual share classes, at most 507 observed), Free and Starter 0, administrators unlimited;
- engine ceilings `BACKTEST_MAX_INDEX_UNIVERSE_SECURITIES` 2,000 and
  `BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS` 600, checked at submission and again by the worker
  against the frozen snapshot (`refuseOversizedUniverse`);
- the snapshot records `stockList.universe` (`kind`, `indexKey`, `peakSimultaneousMembers`), and
  members that were never members during the period are left out of the run.

The universe is the **only** List measured this way; the 100-symbol limit still binds every other
List, including a customer's copy of this one. The web form and the OpenAPI document
(`StockListUniverse`, `maxIndexUniverseConstituents`) show the same rule.

## §6 Ingestion

`pnpm data:index-universe -- ingest` loads every universe security's full history through the
canonical loaders — prices over the raw retention (1992-10-16 onward for a 30-year product
horizon), the six statement datasets, the derived state, splits, profile, insider and
congressional trades — exactly as a page read would, so an ingested security is indistinguishable
from one the product hydrated.

- **Guard and budget.** The client carries an `IndexUniverseRequestGuard`: the index's directory
  endpoints, the exchange calendar, and per-security requests only for the symbols PostgreSQL's
  membership names, fixed before the client exists; every attempt spends one unit of a Redis budget
  and the guard closes when it is spent. Requests go through the shared `RedisFmpRequestGate`.
- **Resumable and idempotent.** `IndexUniverseIngestion` keeps per-security status and attempts;
  a rerun does only what is missing, `--retry-failed` retries failures, `--shard i/n` splits the
  universe by a hash of the security id, `SIGINT` stops cleanly.
- **Rate.** Three shards at concurrency 2 under `FMP_RATE_LIMIT_PER_WINDOW=8` ran without a single
  429: 731 securities in ~50 minutes, 11,183 announced provider requests, 11,931 HTTP attempts.
- **Errors found and fixed.** One BNY statement row with no readable filing date failed the whole
  security; the mapper now leaves out only that row (it cannot be placed in time) — the rule
  alternative-data rows already followed. All 734 securities then succeeded.
- In a Claude cloud session the key is mapped for these commands only by
  `scripts/cloud/fmp-index-universe.sh`, behind `RUN_INDEX_UNIVERSE_INGESTION=1`.

## §7 Verification

`pnpm data:index-universe -- report` measures PostgreSQL alone (2026-10-17):

| Dataset              | Rows      | Securities | Span                           |
| -------------------- | --------- | ---------- | ------------------------------ |
| daily prices         | 4,994,827 | 734        | 1992-10-16 … 2026-10-16        |
| daily derived state  | 4,994,826 | 734        | 1992-10-16 … 2026-10-16        |
| financial statements | 318,130   | 732        | fiscal 1989-10-31 … 2026-09-30 |
| insider transactions | 2,569,857 | 729        | available 2003-05-06 …         |
| congressional trades | 44,913    | 686        | available 2014-02-01 …         |
| stock splits         | 2,490     | 548        |                                |

Membership lines per day: 494 (1996-03-29) to 507 (2020-04-03); within the 500–506 band on 7,846
of 11,247 days (the deferred starts of §4 leave a replacement's day one line short where neither
side can be placed); yearly checkpoints 496–499 until 2004, 499–500 from 2005 to 2014, 502–505
after. Interior price gaps: 3 securities (FRO 597 sessions, CVG 17, SVU 10).

**Against published index changes** (S&P Dow Jones Indices' effective dates, the first session as
a member; the provider's log date in brackets where it differs):

| Change                                                        | Effective                                      | Reconstructed (v2)                                                                             |
| ------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Yahoo added [1999-12-07]                                      | 1999-12-08                                     | 1999-12-08 — deferred (v1: 1999-12-07)                                                         |
| NVIDIA for Enron [2001-11-29]                                 | 2001-11-30                                     | NVIDIA from 2001-11-30, Enron through 2001-11-29 — refined                                     |
| Amazon added [2005-11-18]                                     | 2005-11-21                                     | 2005-11-18 — confirmed by both provider records; one session early                             |
| Google added [2006-03-31]                                     | 2006-04-03                                     | 2006-04-01, first session 2006-04-03 — deferred (v1: 03-31)                                    |
| Netflix added [2010-12-17]                                    | 2010-12-20                                     | 2010-12-20 — refined                                                                           |
| Facebook added [2013-12-20]                                   | 2013-12-23                                     | 2013-12-23 — refined                                                                           |
| Twitter for Monsanto [2018-06-06]                             | 2018-06-07                                     | Twitter from 2018-06-07 — deferred (v1: 06-06); Monsanto through 2018-06-05, one session short |
| Tesla added [2020-12-18]                                      | 2020-12-21                                     | 2020-12-21 — refined                                                                           |
| Moderna added [2021-07-20]                                    | 2021-07-21                                     | 2021-07-21 — refined                                                                           |
| Arch Capital for Twitter [2022-10-31]                         | 2022-11-01                                     | Twitter through 2022-10-31 — refined                                                           |
| Airbnb, Uber, Super Micro                                     | 2023-09-18, 2023-12-18, 2024-03-18             | the same — refined                                                                             |
| Palantir and Dell, DoorDash, Coinbase, AppLovin and Robinhood | 2024-09-23, 2025-03-24, 2025-05-19, 2025-09-22 | the same — confirmed                                                                           |

Sources for the four dates the provider places on the rebalancing session: S&P Dow Jones Indices'
release of 2018-06-04 (Twitter "prior to the open on Thursday, June 7"), CNN Money 1999-11-30
(Yahoo "effective at the close of trading Dec. 7"), the March 2006 reports of Google replacing
Burlington Resources "after the close of trading on March 31", and S&P's 2005-11-14 announcement of
Amazon replacing AT&T Corp. "after the close on November 18".

**Priced share of member-sessions** — the share of (member, session) pairs with a stored price:

| 1996   | 1999   | 2002   | 2005   | 2008   | 2010   | 2012   | 2014   | 2016   | 2018   | 2020   | 2022+    |
| ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | -------- |
| 41.9 % | 50.0 % | 56.2 % | 63.9 % | 73.0 % | 78.6 % | 82.1 % | 85.0 % | 91.4 % | 95.1 % | 98.2 % | ≥ 99.5 % |

## §8 Engine ceilings, worker footprint and throughput

The ceilings in §5 are sized from the measured universe (734 securities, peak 507) with headroom:
a thirty-year run over the whole universe holds ~0.44 GB in one worker process (§10), so the
2,000-security ceiling bounds a run at roughly 1.2 GB. The benchmark — throughput, concurrency,
resources and cache modes — is in §10.

## §9 Known limitations (unreliable periods)

- **Survivorship in the provider's history.** 428 constituents in the horizon have no provider
  prices — mostly issuers that left before ~2010 (bankruptcies, acquisitions, delistings). The
  List keeps them out, never substitutes, and says so; but results over early years lean toward
  survivors. Treat 1996–2009 as **unreliable for absolute performance** (under 80 % of member-days
  priced), 2010–2015 as usable with care, 2016 onward as reliable.
- **Pre-2005 line count.** The log reconstructs 496–499 lines before 2005.
- **No announcement dates**, and a log date names either the effective session or the one before
  it; where today's list cannot tell which (624 log dates, mostly before 2015), membership starts
  the day after the log's date and ends the day before it (§4) — at such a boundary up to one
  session short, never early. Where both provider records agree on the session before (Amazon,
  2005), the start is one session early and cannot be detected.
- **Terminal crashes.** The re-base hold keeps a final crash bar the provider cannot confirm out of
  PostgreSQL (First Republic, SVB), so those histories end one session early; the canonical loader
  asks the provider for the hold's dates again on every hydration.
- **Identity tie-breaks** are recorded (`AMBIGUOUS_ADDITION` 18, `TICKER_COLLISION` 25,
  `FIRST_ADDED_MISMATCH` 115) and reviewable in the sync summary.

## §10 Benchmark

`pnpm --filter @intrinsic/api bench:pit-backtests` (2026-10-17): thirty-year runs (1996-10-17 …
2026-10-16) over the universe — 732 securities in the period, peak 506 at once — submitted through
`BacktestsService.submitRun` and executed by real backtest worker processes, warm protected tier.
Isolated configuration of the benchmark's own processes only: no provider key,
`EOD_TAIL_REFRESH=frozen`, fundamentals and alternative-data freshness 30 days, the operator
(`ADMIN`) fixture as owner, a per-worker PostgreSQL pool cap at 8+ workers. No product limit changed.

**Machine:** 4 vCPU Intel Xeon @ 2.80 GHz, 16 GB RAM, no swap; Node 22.23.2, PostgreSQL 16,
Redis 7.0.15, all on the one VM.

| Run                 | Strategy                              | Workers = runs | Wall    | Per run p50 / p95 | Throughput   | Prep   | Frame reads | Worker CPU / run | CPU busy | Worker RSS total (per process) | Redis out | PG tx  | Failed | Identical |
| ------------------- | ------------------------------------- | -------------- | ------- | ----------------- | ------------ | ------ | ----------- | ---------------- | -------- | ------------------------------ | --------- | ------ | ------ | --------- |
| before optimization | simple                                | 1              | 104.5 s | 101.0 s           | 34.5 /h      | 1.4 s  | 86.1 s      | 118.2 s          | 35 %     | 0.41 GB                        | 948 MB    | 19.8 k | 0      | —         |
| single              | simple                                | 1              | 80.4 s  | 76.9 s            | 44.8 /h      | 1.5 s  | 63.1 s      | 92.7 s           | 35 %     | 0.40 GB                        | 511 MB    | 18.7 k | 0      | yes       |
| single              | complex                               | 1              | 102.4 s | 98.6 s            | 35.1 /h      | 1.3 s  | 69.6 s      | 114.3 s          | 43 %     | 0.44 GB                        | 511 MB    | 18.4 k | 0      | yes       |
| single              | monthly (contributions, 10 positions) | 1              | 83.4 s  | 81.3 s            | 43.2 /h      | 1.6 s  | 66.1 s      | 93.6 s           | 46 %     | 0.40 GB                        | 511 MB    | 18.6 k | 0      | yes       |
| scaling             | simple                                | 2              | 84.6 s  | 81.4 s            | 85.1 /h      | 2.4 s  | 65.5 s      | 87.4 s           | 68 %     | 0.83 GB (0.42)                 | 1.0 GB    | 37.1 k | 0      | yes       |
| scaling             | simple                                | 4              | 101.0 s | 97.1 / 97.4 s     | **142.6 /h** | 4.0 s  | 78.9 s      | 82.6 s           | 97 %     | 1.74 GB (0.44)                 | 2.0 GB    | 71.1 k | 0      | yes       |
| scaling             | simple                                | 8              | 209.0 s | 199.6 / 203.6 s   | 137.8 /h     | 6.6 s  | 162.7 s     | 88.8 s           | 99 %     | 3.26 GB (0.44)                 | 4.1 GB    | 142 k  | 0      | yes       |
| scaling             | simple                                | 16             | 420.9 s | 406.3 / 414.7 s   | 136.9 /h     | 12.2 s | 326.4 s     | 91.4 s           | 99 %     | 6.38 GB (0.44)                 | 8.2 GB    | 287 k  | 0      | yes       |

Every run hit Redis for every chunk (hit rate 1.0, zero misses), reached the provider zero times,
and failed zero times. Results are deterministic: the 32 simple runs across every level share one
result digest (summary and every trade), as do the complex and the monthly runs.

The table was measured on the List of reconstruction version 1. After version 2 (§4: 169 windows
start a day later) the runs were repeated: simple at 2 workers 75.0 s per run (two runs, one
digest), complex 94.7 s, monthly 77.8 s; hit rate 1.0, no provider request, no failure. The simple
and complex results changed with the windows (digests `1b5fb2c1…` and `03349aed…`, from
`1b746559…` and `904d5c07…`); the monthly strategy's did not (`80e02b39…`). After merging `main`
(DATA-02 repaired BNY's derived history before 2007): simple at 2 workers 78.6 s, one digest
(`9ac57a4f…`), no provider request.

- **Bottleneck: worker CPU.** Throughput rises linearly to 4 workers (one per core) and is flat
  after — 143 runs/hour at 4, 137 at 16 — while per-run latency doubles with each doubling past 4.
  Redis spent 91 CPU-seconds and PostgreSQL peaked at 24 active connections at 16 workers; neither
  is close to saturation. A CPU profile of one run attributes 44 % of worker CPU to decoding
  daily-state chunks (JSON parse 12 %, row materialization 15 %, column expansion 5 %, zstd 12 %),
  14 % to price chunks, ~10 % to the simulation and 6 % to GC.
- **Optimization applied** (identical digests before and after): each window read its own year
  _and_ the previous one for ten days of leading context the simulation then drops; a per-run
  carry now hands those rows from one window to the next. One run: 101.0 s → 76.9 s, Redis bytes
  948 → 511 MB. Lua scripts are sent by `EVALSHA` (commands sent to Redis 43 → 25 MB per run).
- **Next optimization, not applied:** decode only the columns a strategy reads from the columnar
  chunk instead of materializing ~100-field rows (~20 % of worker CPU by the profile).
- **Not run: 32, 64 and 128 workers.** Each worker peaks at ~0.44 GB; 32 workers would need ~14 GB
  against ~13 GB available with PostgreSQL and Redis on the same VM (64: ~28 GB, 128: ~56 GB), and
  on 4 cores they would add no throughput — only latency. Stopped at 16 as the last safe level.
- **Production setting.** `BACKTEST_WORKER_PROCESSES` should be about the core count of the worker
  host (each run is single-threaded); a Pro user's two concurrent runs then see single-run latency.

**Cache modes.** Warm protected tier: above. Without the tier — a 100-slot LRU over 732 securities —
each window would miss for most securities and rebuild each one from PostgreSQL: at the measured
~4 s per security rebuild (`protect`, 4 lanes), ~19,600 rebuilds per run, i.e. **many hours per
run**; the tier is what makes the universe runnable at all. Redis lost: see the recovery
measurement in `protected-stock-tier-v1.md` §6.

## Operations

```bash
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh sync
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh resolve
scripts/cloud/fmp-index-universe.sh project
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh ingest --shard 0/3 --concurrency 2
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh ingest --retry-failed
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh benchmarks
scripts/cloud/fmp-index-universe.sh report --out artifacts/sp500-historical-pit/report.json
scripts/cloud/fmp-index-universe.sh protect --concurrency 4
```

Outside a cloud session the same commands are `pnpm data:index-universe -- <command>` with
`FMP_API_KEY` configured. Every step is idempotent; incremental updates are the same commands run
again (`sync` then `resolve`, `project`, `ingest` for new securities, `protect`).

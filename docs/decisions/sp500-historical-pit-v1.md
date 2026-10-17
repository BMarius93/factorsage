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

The provider records **effective dates only** — no announcement dates — and its log date is often
the session _before_ the effective date (§3). The log is complete enough to reconstruct 496–499
lines per day before 2005, against the index's 500: the provider's history is the limit (§9).

## §3 Canonical model (PostgreSQL)

Migration `20261017120000_sp500_historical_pit`:

- `IndexConstituentChange` — the provider's change log, content-addressed (`contentHash`), kept as
  delivered;
- `SymbolChangeRecord` — the rename history;
- `IndexMembershipSync` — one row per synchronization: source digest, counts, anomalies, quality;
- `IndexConstituent` — one issuer line: origin (`CURRENT`, `REMOVAL`, `ORPHAN_ADDITION`), ticker
  history, resolution and the evidence for it, and the resolved `securityId`;
- `IndexMembershipPeriod` — `startDate`/`endDate` (inclusive), the log's own dates beside refined
  ones (`startLogDate`, `endLogDate`), the change hashes, the identity tier (`startMatch`) and a
  quality (`CONFIRMED`, `START_BEFORE_LOG`, `END_UNKNOWN`);
- `IndexUniverseIngestion` — per-security ingestion progress (§6).

A synchronization replaces the reconstruction transactionally and is idempotent: the same source
digest produces the same rows. The List is a **projection** of these tables, never edited directly.

## §4 Reconstruction and identity

`packages/stock-data/src/index-membership/reconstruction.ts` — pure, deterministic, versioned
(`INDEX_RECONSTRUCTION_ALGORITHM_VERSION` 1):

1. **Backward walk.** Start from the current list; walk the change log from newest to oldest,
   undoing each change. No period is assumed: a period exists only between a recorded addition and
   a recorded removal, or the current list.
2. **Identity, not tickers.** Each walked constituent carries its ticker history; renames are
   undone along the way (META is FB before 2022-06-09; AT&T Inc. was SBC until it took `T` from the
   AT&T Corp. it absorbed). Additions match a member in three recorded tiers: `EXACT_TICKER`
   (1,376 periods), `TICKER_HISTORY` (92), `NAME` ≥ 0.85 similarity (1).
3. **Effective dates.** Where the current list's `dateFirstAdded` falls one to four days after a
   log date and nothing contradicts it, every change on that log date takes the refined date —
   additions and removals together, because a replacement's two sides take effect together.
   Measured: of 223 such log dates, 222 agree on one date. Contradictions are reported
   (`EFFECTIVE_DATE_CONFLICT`, 3) and keep the log's date.
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
| daily derived state  | 4,991,123 | 734        | 1992-10-16 … 2026-10-16        |
| financial statements | 318,130   | 732        | fiscal 1989-10-31 … 2026-09-30 |
| insider transactions | 2,569,857 | 729        | available 2003-05-06 …         |
| congressional trades | 44,913    | 686        | available 2014-02-01 …         |
| stock splits         | 2,490     | 548        |                                |

Membership lines per day: 496 (1996-01-02) to 507 (2020-04-03); within the 500–506 band on 7,955
of 11,247 days; yearly checkpoints 496–499 until 2004, 500 from 2005 to 2014, 502–505 after.
Interior price gaps: 3 securities (FRO 597 sessions, CVG 17, SVU 10).

**Priced share of member-sessions** — the share of (member, session) pairs with a stored price:

| 1996   | 1999   | 2002   | 2005   | 2008   | 2010   | 2012   | 2014   | 2016   | 2018   | 2020   | 2022+    |
| ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | ------ | -------- |
| 41.9 % | 50.0 % | 56.2 % | 63.9 % | 73.0 % | 78.6 % | 82.1 % | 85.0 % | 91.4 % | 95.1 % | 98.2 % | ≥ 99.5 % |

## §8 Engine ceilings, worker footprint and throughput

The ceilings in §5 are sized from the measured universe (734 securities, peak 507) with headroom.
The benchmark of thirty-year runs over the universe — throughput, concurrency, resources and cache
modes — is in §10.

## §9 Known limitations (unreliable periods)

- **Survivorship in the provider's history.** 428 constituents in the horizon have no provider
  prices — mostly issuers that left before ~2010 (bankruptcies, acquisitions, delistings). The
  List keeps them out, never substitutes, and says so; but results over early years lean toward
  survivors. Treat 1996–2009 as **unreliable for absolute performance** (under 80 % of member-days
  priced), 2010–2015 as usable with care, 2016 onward as reliable.
- **Pre-2005 line count.** The log reconstructs 496–499 lines before 2005.
- **No announcement dates**; effective dates only, refined as in §4.
- **Terminal crashes.** The re-base hold keeps a final crash bar the provider cannot confirm out of
  PostgreSQL (First Republic, SVB), so those histories end one session early; the canonical loader
  asks the provider for the hold's dates again on every hydration.
- **Identity tie-breaks** are recorded (`AMBIGUOUS_ADDITION` 18, `TICKER_COLLISION` 25,
  `FIRST_ADDED_MISMATCH` 116) and reviewable in the sync summary.

## §10 Benchmark

See the results section appended below.

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

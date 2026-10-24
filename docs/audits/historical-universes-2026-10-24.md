# Historical PIT universes — engineering report, 2026-10-24

- **Decision record:** `docs/decisions/historical-universes-v1.md`.
- **Environment:** Claude cloud VM — 4 vCPU Intel Xeon @ 2.80 GHz, 16 GB RAM; Node 22, PostgreSQL 16,
  Redis 7 (`noeviction`), all local. Provider reached only through
  `scripts/cloud/fmp-index-universe.sh`, at 8 requests a second.
- **Evidence:** local and git-ignored — `artifacts/historical-universes/report.json` and
  `report.md` (`pnpm data:historical-universes -- report`), `backtests.jsonl`, the command logs. Every
  number below comes from them or from aggregate queries; no provider payload is committed.

## A. Data inventory and restore

The container started with **no historical data persisted** — PostgreSQL, Redis and disk held none
of the S&P 500 dataset an earlier session had built. As the owner directed, the generators were
first built and proven on deterministic fixtures, then the dataset was restored with the existing
authorized commands and budgets, and the two approved additions were loaded under their own caps.

| Provider requests                        | Sync | Resolve | Ingest | Other          | Total  | Cap     |
| ---------------------------------------- | ---- | ------- | ------ | -------------- | ------ | ------- |
| S&P 500 restore (existing budgets)       | 3    | 3,482   | 11,751 | 3 (benchmarks) | 15,239 | 120,000 |
| Nasdaq-100 + Dow (approved 2026-10-24)   | 12   | 1,490   | 1,127  | 4 (probes)     | 2,633  | 6,000   |
| Dividend histories (approved 2026-10-24) | —    | —       | 735    | 1 (probe)      | 736    | 750     |

Zero rate-limit refusals at 8 requests a second; 24 resolution probes that hit the provider's rate
limit at the default 20 a second were retried at 8 and resolved. Every security's data is stored once:
the Dow's 50 tradeable securities are all S&P 500 securities and cost **no** ingestion request; the
Nasdaq-100's 254 cost 75 (its members outside the S&P 500). Dividends were loaded for the 735 S&P 500
securities (65,289 rows; 136 pay none), which covers every Dow member.

## B. Index memberships and the earliest trustworthy PIT dates

| Index      | Constituents reconstructed / tradeable  | Lines within the expected band (since 1996) | Earliest trustworthy PIT date |
| ---------- | --------------------------------------- | ------------------------------------------- | ----------------------------- |
| S&P 500    | 1,242 in horizon / 764 (735 securities) | 7,853 of 11,254 days (500–506)              | **2016-01-29**                |
| Nasdaq-100 | 501 in horizon / 311 (254 securities)   | 11,246 of 11,254 days (100–112)             | **2015-12-31**                |
| Dow 30     | 61 / 53 (50 securities)                 | 11,248 of 11,254 days (exactly 30)          | **1999-11-30**                |

"Trustworthy" is measured, not asserted: the first month-end after which **every** month-end has a
stored close for at least 90 % of the index's lines, unresolved constituents counting against it
(`historical-universes-v1.md` §6). Lowest monthly share of lines priced, by year:

| Index      | 1996 | 2000 | 2004 | 2008 | 2010  | 2012  | 2014  | 2016  | 2018  | 2020  | 2022+ |
| ---------- | ---- | ---- | ---- | ---- | ----- | ----- | ----- | ----- | ----- | ----- | ----- |
| S&P 500    | 42 % | 52 % | 62 % | 72 % | 77 %  | 81 %  | 85 %  | 90 %  | 94 %  | 98 %  | ≥99 % |
| Nasdaq-100 | 34 % | 31 % | 60 % | 73 % | 77 %  | 81 %  | 83 %  | 91 %  | 95 %  | 99 %  | ≥99 % |
| Dow 30     | 77 % | 90 % | 90 % | 97 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % | 100 % |

**What is missing before those dates.** The memberships themselves are complete: the S&P 500's as
reported in `sp500-historical-pit-v1.md`; the Nasdaq-100's within its band on all but eight single
days; the Dow's exactly 30 lines after the two documented change-log corrections (Travelers Group
1997, Dow Inc. 2019). What is missing is **prices for former members**: 425 S&P 500 constituents and
181 Nasdaq-100 constituents have no provider prices for their membership (mostly companies delisted
before about 2010), and 22 and 4 more have prices that belong to another issuer. For the Dow, seven
early members have none — Union Carbide, Westinghouse, Kodak (to 2004), the old General Motors (to
2009), Sears, Bethlehem Steel, Texaco — and SBC's 1999–2004 history is rejected as another issuer's.
From 1999-11 three of the Dow's thirty lines are unpriced (90 %), from 2004-04 one (GM) and from 2009-06
none.

**Published Lists:** the S&P 500's keeps its 1996 floor and survivorship disclosure, unchanged
(735 members, 761 windows, re-projected byte-identical). The Nasdaq-100's starts 2016-01-01
(193 securities), the Dow's 1999-12-01 (48).

## C. The 23 catalog universes

| Universe                       | Status    | Published from | Securities in the List | Peak at once |
| ------------------------------ | --------- | -------------- | ---------------------- | ------------ |
| S&P 500 — Historical PIT       | PUBLISHED | 1996-01-02     | 735                    | 504          |
| Nasdaq-100 — Historical PIT    | PUBLISHED | 2016-01-01     | 193                    | 103          |
| Dow Jones 30 — Historical PIT  | PUBLISHED | 1999-12-01     | 48                     | 30           |
| S&P 500 sectors (11)           | BLOCKED   | —              | —                      | —            |
| S&P 500 Top 100 by Market Cap  | PUBLISHED | 2016-01-30     | 189                    | 100          |
| S&P 500 Top 250 by Market Cap  | PUBLISHED | 2016-01-30     | 434                    | 250          |
| S&P 500 Growth                 | PUBLISHED | 2016-04-01     | 602                    | 167          |
| S&P 500 Value                  | PUBLISHED | 2016-04-01     | 381                    | 165          |
| S&P 500 High Dividend          | PUBLISHED | 2016-07-01     | 230                    | 80           |
| S&P 500 Top 50 Momentum (12-1) | PUBLISHED | 2016-01-30     | 555                    | 50           |
| S&P 500 Top 100 by Liquidity   | PUBLISHED | 2016-01-30     | 268                    | 100          |
| Dogs of the Dow                | PUBLISHED | 2000-01-01     | 34                     | 10           |
| Small Dogs of the Dow          | PUBLISHED | 2000-01-01     | 27                     | 5            |

Every derived universe starts where its own reconstitutions first pass all three criteria, which for
S&P 500 universes is where the index's coverage reaches 90 %. Before that, metric availability was
already high (91–97 % for market cap, momentum, liquidity and Growth; 63 % for Value; 75 % for High
Dividend): what fails is data coverage — the 1996–2015 rankings would be rankings of survivors.

**External checks.** The generated Dogs of the Dow for 2024 (selected 2023-12-29) — WBA, VZ, MMM, DOW,
IBM, CVX, KO, CSCO, JNJ, AMGN — and for 2023 and 2020 are exactly the published lists, as are the
Small Dogs for 2023 (INTC, WBA, VZ, CSCO, DOW) and 2024 (WBA, VZ, CSCO, DOW, KO). The Top 100 by
market cap on 2024-12-31 starts AAPL $3.82T, NVDA $3.33T, MSFT $3.15T; on 2016-01-29 AAPL $545B,
GOOGL $529B, MSFT $444B — within about 1 % of public figures. Alphabet's two share classes each
carry the company's whole capitalization (a documented V1 rule).

**The sectors are blocked**, not approximated: the provider has only today's, non-GICS sector, and
GICS itself changed in 2016 and 2018. The Lists page shows them as "Historical data unavailable".

## D. Top N discovery (internal research candidates)

All 28 candidates were generated and validated from data already in PostgreSQL — **no provider
request**, no Redis entry, ~80 s of generation for the S&P 500 group — and none is published.
Look-ahead: every value reads data available at the reconstitution date's close (prices on or before
`T`; statements by filing date with the listing floor; dividends by ex-date); selections take effect
the next session.

| Candidate (parent, metric, N, frequency)         | Data           | Reliable from | Availability since    | Limitations                                                   | Recommendation                                    |
| ------------------------------------------------ | -------------- | ------------- | --------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| S&P 500 top 25 / 50 by market cap, monthly       | prices, shares | 2016-01-29    | ≥ 97 %                | two-class companies take two lines                            | **Publish next** (Top 50 Mega Cap)                |
| S&P 500 bottom 50 / 100 by market cap, monthly   | prices, shares | 2016-01-29    | ≥ 97 %                | the smallest members are the likeliest to be unpriced earlier | Keep internal: most survivorship-sensitive        |
| S&P 500 top 25 / 100 momentum 12-1, monthly      | prices         | 2016-01-29    | ≥ 98 %                | high turnover (612–703 securities)                            | Keep internal: Top 50 covers it                   |
| S&P 500 top 50 by 6M / 12M return, monthly       | prices         | 2016-01-29    | ≥ 98 %                | overlaps 12-1 momentum; no skip month                         | Do not publish: redundant                         |
| S&P 500 top 50 risk-adjusted momentum, monthly   | prices         | 2016-01-29    | ≥ 98 %                | needs 220 returns                                             | Candidate after a turnover review                 |
| S&P 500 lowest volatility 50 / 100, monthly      | prices         | 2016-01-29    | ≥ 98 %                | 252-session window                                            | **Publish next** (Low Volatility 100)             |
| S&P 500 highest volatility 50 / 100, monthly     | prices         | 2016-01-29    | ≥ 98 %                | speculative; high turnover                                    | Keep internal                                     |
| S&P 500 top 50 by liquidity, monthly             | prices, volume | 2016-01-29    | 100 %                 | overlaps Top 100 Liquidity and mega caps                      | Do not publish: redundant                         |
| S&P 500 top 50 earnings / FCF yield, quarterly   | statements     | 2016-03-31    | ≥ 79 % / ≥ 76 %       | positive denominators only; ~41–58 % availability before 2016 | Keep internal: Value covers it                    |
| S&P 500 top 50 book-to-price, quarterly          | statements     | 2016-03-31    | ≥ 84 %                | negative equity excluded                                      | Keep internal                                     |
| S&P 500 top 50 revenue / EPS / FCF growth, qtrly | fundamentals   | 2016-03-31    | ≥ 97 / 81 / 82 %      | noisy base effects (EPS, FCF)                                 | Revenue growth: candidate; EPS/FCF: keep internal |
| S&P 500 top 50 ROIC / ROE, quarterly             | fundamentals   | 2016-03-31    | ≥ 91 % / ≥ 92 %       | ROE inflated by buybacks and negative equity                  | **ROIC: publish next** (Quality 50); ROE internal |
| S&P 500 top 50 gross margin, quarterly           | fundamentals   | 2016-03-31    | ≥ 98 %                | sector-driven (software, pharma)                              | Keep internal                                     |
| S&P 500 top 50 interest coverage, quarterly      | fundamentals   | 2016-03-31    | ≥ 93 % (18 % earlier) | undefined without interest expense                            | Keep internal                                     |
| S&P 500 50 lowest net debt / EBITDA, quarterly   | fundamentals   | 2016-03-31    | ≥ 92 %                | net-cash companies rank first; negative EBITDA has no value   | Candidate (Financial Strength 50) after review    |
| Nasdaq-100 top 25 by market cap, monthly         | prices, shares | 2015-12-31    | ≥ 94 %                | concentrated in a dozen names                                 | Candidate                                         |
| Nasdaq-100 top 20 momentum, monthly              | prices         | 2015-12-31    | ≥ 96 %                | 225 securities through it                                     | Keep internal                                     |
| Dow top 10 momentum, monthly                     | prices         | 1999-11-30    | ≥ 97 %                | ten names from thirty                                         | Keep internal                                     |

Cost of any of them in production: no provider request (they read the shared dataset), one
generation per reconstitution (seconds), and PostgreSQL rows for its selections and periods —
620,325 selection rows (190 MB) for all 40 generated universes; each universe keeps only its latest
and published generations.

## E. Product, capacity and backtests

**Real backtests** over every published universe, through the product's own submission path (real
validation, Pro entitlement, frozen snapshot, one durable job) and real backtest worker processes,
as the Pro fixture user (`bench:pit-backtests -- run --list <key> --owner pro`), one at a time:

| Universe              | Period start | Securities | Peak | Wall time | Worker RSS | Redis hits |
| --------------------- | ------------ | ---------- | ---- | --------- | ---------- | ---------- |
| Top 100 by Market Cap | 2016-02-01   | 189        | 100  | 9.8 s     | 280 MB     | 100 %      |
| Top 250 by Market Cap | 2016-02-01   | 434        | 250  | 22.4 s    | 318 MB     | 100 %      |
| Growth                | 2016-04-01   | 602        | 167  | 28.9 s    | 356 MB     | 100 %      |
| Value                 | 2016-04-01   | 381        | 165  | 18.4 s    | 357 MB     | 100 %      |
| High Dividend         | 2016-07-01   | 230        | 80   | 11.2 s    | 285 MB     | 100 %      |
| Top 50 Momentum       | 2016-02-01   | 555        | 50   | 23.9 s    | 366 MB     | 100 %      |
| Top 100 by Liquidity  | 2016-02-01   | 268        | 100  | 13.2 s    | 320 MB     | 100 %      |
| Nasdaq-100            | 2016-01-04   | 193        | 103  | 10.2 s    | 277 MB     | 100 %      |
| Dow Jones 30          | 2000-01-03   | 48         | 30   | 8.4 s     | 333 MB     | 100 %      |
| Dogs of the Dow       | 2000-01-03   | 34         | 10   | 6.5 s     | 286 MB     | 100 %      |
| Small Dogs of the Dow | 2000-01-03   | 27         | 5    | 5.2 s     | 263 MB     | 100 %      |

All eleven completed with no failure. Each snapshot records the root index and, for a derived
universe, its key (`{"indexKey":"SP500","universeKey":"sp500-top100-market-cap","peakSimultaneousMembers":100}`);
the S&P 500's own snapshots are unchanged. Every peak is far inside Pro's 550 simultaneous members and
the engine's 600 / 2,000; no limit was raised.

**Redis.** The protected tier is the S&P 500's 735 securities (545 MB, all resident) before and after
every run above, the Nasdaq-100 and Dow runs included: they designated nothing, and the set stayed at 735. Total Redis memory 563.7 MB before and after the runs. Derived universes add no stock-cache data.

**PostgreSQL.** Dividends 37 MB; universe selections 190 MB and periods 20 MB for all 40 generated
universes (catalog and research). A rerun over unchanged data wrote nothing (40 of 40 `UNCHANGED`,
144 s).

## F. Licensing and limitations

The index names are trademarks (S&P Dow Jones Indices; Nasdaq, Inc.) and the memberships are
FactorSage reconstructions from a market-data provider's records, not licensed index data. Whether
the provider's licence covers displaying reconstructed constituents and derived rankings in a
commercial product, and whether the index names may be used, **has not been reviewed by counsel and
must be before launch** (decision §10). Further limitations: survivorship before the reliable dates
(§B), the reconstruction's one-session effective-date uncertainty, two-class companies counted
twice in market-cap rankings, fundamentals' later coverage, and the blocked sectors.

## G. Reproduction

```bash
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh sync|resolve|ingest [--index SP500|NASDAQ100|DOW30]
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh dividends --index SP500
RUN_INDEX_UNIVERSE_INGESTION=1 scripts/cloud/fmp-index-universe.sh benchmarks
scripts/cloud/fmp-index-universe.sh project && scripts/cloud/fmp-index-universe.sh protect
pnpm data:historical-universes -- generate --all
pnpm data:historical-universes -- publish <catalog keys>
pnpm data:historical-universes -- report --out artifacts/historical-universes/report.json --markdown artifacts/historical-universes/report.md
pnpm --filter @intrinsic/api bench:pit-backtests -- run --list <key> --owner pro --start-date <publishFrom>
```

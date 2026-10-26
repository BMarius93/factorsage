# Historical PIT universes — engineering report, 2026-10-24 (supersectors added 2026-10-26)

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

## C. The 26 catalog universes

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
| S&P 500 Cyclical (§H)          | PUBLISHED | 1996-01-02     | 272                    | 192          |
| S&P 500 Defensive (§H)         | PUBLISHED | 1996-01-02     | 162                    | 134          |
| S&P 500 Sensitive (§H)         | PUBLISHED | 1996-01-02     | 299                    | 206          |

Every ranked universe starts where its own reconstitutions first pass all three criteria, which for
S&P 500 universes is where the index's coverage reaches 90 %; the supersectors follow the S&P 500's
own List from 1996 with that coverage disclosed (§H). Before that, metric availability was
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
# Economic supersectors (§H): PostgreSQL only
pnpm data:historical-universes -- generate --keys sp500-cyclical,sp500-defensive,sp500-sensitive
pnpm data:historical-universes -- publish sp500-cyclical sp500-defensive sp500-sensitive
```

## H. Economic supersectors, 2026-10-26

Three universes added by owner decision (decision §2.1): the S&P 500's point-in-time membership
grouped by each company's **current** FMP sector — retrospective classification, disclosed on every
surface. Generated, validated and published on the same restored dataset as above, with **no
provider request** (the generation CLI builds no provider client and ran with the FMP key blanked;
each backtest reported 0 provider events).

**Classification.** Of the S&P 500's 735 catalog securities, 733 carry an FMP company-profile sector
(profiles synchronized 2026-10-23 18:23 to 2026-10-24 12:17 UTC); mapping version 1. All eleven FMP
sectors occur, every one maps to exactly one supersector, and the three universes are disjoint:

| Universe          | Sectors (securities)                                                              | Distinct | Windows | Peak at once (date) | Status, from          |
| ----------------- | --------------------------------------------------------------------------------- | -------- | ------- | ------------------- | --------------------- |
| S&P 500 Cyclical  | Financials 94, Consumer Discretionary 101, Materials 37, Real Estate 40           | 272      | 280     | 192 (2019-12-05)    | PUBLISHED, 1996-01-02 |
| S&P 500 Defensive | Consumer Staples 47, Health Care 82, Utilities 33                                 | 162      | 165     | 134 (2023-08-25)    | PUBLISHED, 1996-01-02 |
| S&P 500 Sensitive | Information Technology 116, Communication Services 36, Industrials 107, Energy 40 | 299      | 314     | 206 (2026-09-21)    | PUBLISHED, 1996-01-02 |

272 + 162 + 299 = 733: every classified security is in exactly one universe. Each member's buy
windows are **identical** to its windows in the S&P 500's own List (733 of 733 compared); the extra
windows are the index's re-entries (8, 3 and 15). **Unclassified:** CELG (Celgene Corporation) and
XEC (Cimarex Energy Co.), both former members, have no sector in any stored record (no profile, no
catalog sector); they are in no universe and are listed in every generation's audit. No sector was
inferred from a name, ticker or industry. Classified share 733 / 735 = 99.7 %, above the 95 % gate.

**Coverage by year** (the year's last monthly checkpoint; "with a stored company" is the share of the
S&P 500's lines resolved to a catalog security — a line without one has neither a price nor a
sector; each universe's figure is its members, with those priced in brackets; the last column is the
year's lowest share of each universe's members with a close):

| Year | S&P 500 lines | With a stored company | Classified | Unclassified | Cyclical (priced) | Defensive (priced) | Sensitive (priced) | Lowest group price coverage C / D / S |
| ---- | ------------- | --------------------- | ---------- | ------------ | ----------------- | ------------------ | ------------------ | ------------------------------------- |
| 1996 | 496           | 223 (45.0 %)          | 223        | 0            | 83 (80)           | 61 (59)            | 79 (71)            | 96.2 % / 96.7 % / 89.9 %              |
| 1997 | 497           | 242 (48.7 %)          | 242        | 0            | 93 (91)           | 64 (62)            | 85 (76)            | 96.4 % / 96.8 % / 88.8 %              |
| 1998 | 494           | 253 (51.2 %)          | 253        | 0            | 98 (97)           | 68 (66)            | 87 (78)            | 97.9 % / 96.9 % / 89.4 %              |
| 1999 | 496           | 270 (54.4 %)          | 270        | 0            | 106 (105)         | 71 (69)            | 93 (83)            | 99.0 % / 97.1 % / 89.2 %              |
| 2000 | 498           | 287 (57.6 %)          | 287        | 0            | 105 (103)         | 74 (71)            | 108 (94)           | 98.1 % / 95.8 % / 87.0 %              |
| 2001 | 498           | 296 (59.4 %)          | 296        | 0            | 107 (105)         | 76 (74)            | 113 (97)           | 98.1 % / 96.0 % / 85.7 %              |
| 2002 | 498           | 308 (61.9 %)          | 308        | 0            | 112 (110)         | 80 (76)            | 116 (100)          | 98.1 % / 94.9 % / 85.8 %              |
| 2003 | 499           | 315 (63.1 %)          | 315        | 0            | 116 (115)         | 82 (81)            | 117 (114)          | 98.2 % / 95.0 % / 86.2 %              |
| 2004 | 500           | 319 (63.8 %)          | 319        | 0            | 118 (117)         | 85 (85)            | 116 (113)          | 99.1 % / 98.8 % / 97.4 %              |
| 2005 | 498           | 332 (66.7 %)          | 332        | 0            | 125 (124)         | 88 (88)            | 119 (117)          | 99.2 % / 100.0 % / 97.4 %             |
| 2006 | 499           | 347 (69.5 %)          | 346        | 1            | 131 (129)         | 90 (89)            | 125 (123)          | 98.5 % / 98.9 % / 98.3 %              |
| 2007 | 499           | 365 (73.2 %)          | 364        | 1            | 142 (140)         | 91 (90)            | 131 (129)          | 98.5 % / 98.9 % / 98.4 %              |
| 2008 | 497           | 379 (76.3 %)          | 378        | 1            | 143 (141)         | 98 (97)            | 137 (135)          | 98.6 % / 98.9 % / 98.5 %              |
| 2009 | 500           | 391 (78.2 %)          | 390        | 1            | 149 (147)         | 102 (101)          | 139 (137)          | 98.6 % / 99.0 % / 98.5 %              |
| 2010 | 500           | 401 (80.2 %)          | 400        | 1            | 152 (151)         | 104 (103)          | 144 (142)          | 98.7 % / 99.0 % / 98.6 %              |
| 2011 | 499           | 410 (82.2 %)          | 409        | 1            | 157 (156)         | 106 (106)          | 146 (144)          | 99.3 % / 99.0 % / 97.9 %              |
| 2012 | 500           | 419 (83.8 %)          | 418        | 1            | 161 (160)         | 108 (107)          | 149 (148)          | 99.4 % / 99.1 % / 98.6 %              |
| 2013 | 500           | 427 (85.4 %)          | 426        | 1            | 164 (163)         | 110 (109)          | 152 (150)          | 99.4 % / 99.1 % / 98.7 %              |
| 2014 | 502           | 434 (86.5 %)          | 432        | 2            | 165 (164)         | 112 (111)          | 155 (153)          | 99.4 % / 99.1 % / 98.7 %              |
| 2015 | 504           | 453 (89.9 %)          | 451        | 2            | 172 (172)         | 117 (117)          | 162 (161)          | 99.4 % / 99.1 % / 98.7 %              |
| 2016 | 505           | 470 (93.1 %)          | 468        | 2            | 181 (181)         | 123 (123)          | 164 (163)          | 100.0 % / 100.0 % / 99.4 %            |
| 2017 | 504           | 476 (94.4 %)          | 474        | 2            | 189 (189)         | 123 (123)          | 162 (161)          | 100.0 % / 100.0 % / 99.4 %            |
| 2018 | 504           | 485 (96.2 %)          | 483        | 2            | 189 (189)         | 122 (122)          | 172 (171)          | 100.0 % / 99.2 % / 98.8 %             |
| 2019 | 505           | 493 (97.6 %)          | 492        | 1            | 189 (189)         | 123 (123)          | 180 (180)          | 100.0 % / 100.0 % / 99.4 %            |
| 2020 | 505           | 498 (98.6 %)          | 498        | 0            | 184 (184)         | 126 (126)          | 188 (188)          | 100.0 % / 100.0 % / 100.0 %           |
| 2021 | 505           | 501 (99.2 %)          | 501        | 0            | 183 (183)         | 128 (128)          | 190 (190)          | 100.0 % / 100.0 % / 100.0 %           |
| 2022 | 503           | 501 (99.6 %)          | 501        | 0            | 182 (182)         | 130 (130)          | 189 (189)          | 100.0 % / 100.0 % / 99.5 %            |
| 2023 | 503           | 502 (99.8 %)          | 502        | 0            | 180 (180)         | 132 (132)          | 190 (190)          | 99.4 % / 100.0 % / 100.0 %            |
| 2024 | 503           | 502 (99.8 %)          | 502        | 0            | 178 (178)         | 130 (130)          | 194 (194)          | 100.0 % / 100.0 % / 100.0 %           |
| 2025 | 503           | 502 (99.8 %)          | 502        | 0            | 175 (175)         | 127 (127)          | 200 (200)          | 100.0 % / 100.0 % / 100.0 %           |
| 2026 | 503           | 502 (99.8 %)          | 502        | 0            | 174 (174)         | 122 (122)          | 206 (206)          | 100.0 % / 100.0 % / 100.0 %           |

- **Survivorship.** The index's data coverage (lines with a close over all lines) reaches 90 % on
  2016-01-29, the S&P 500's own earliest trustworthy date (§B). In 1996 only 223 of 496 lines (45 %)
  resolve to a company with stored data; the other 273 have no price and no sector, and companies
  that left the index without price history are missing from all three universes. Early results lean
  toward survivors — the Sensitive universe's 30-year return below is the clearest example.
- **Missing prices** among resolved members are small: Cyclical and Defensive keep at least 90 % of
  their members priced on every checkpoint from 1996; Sensitive from 2003-09-30 (86–90 % in
  1996–2003).
- **Unknown sector** is therefore mostly the unresolved lines above, plus CELG and XEC (1–2 members a
  year in 2006–2019).
- The universes are published from the 1996 floor with this coverage disclosed, not shifted to 2016
  (owner decision). The 11 strict sector universes remain BLOCKED.

**Real backtests**, one per universe, as the Pro fixture user through the product's submission path
and real worker processes (`bench:pit-backtests -- run --list <key> --owner pro --start-date
1996-10-25`): the benchmark's simple SMA-200 cross strategy, $100,000, 1996-10-25 to 2026-10-23 —
the longest period the product's 30-year limit admits on 2026-10-26.

| Universe  | Securities in the run | Peak | Wall time | Trades | Final value | Return    | CAGR    | Max drawdown | S&P 500 return |
| --------- | --------------------- | ---- | --------- | ------ | ----------- | --------- | ------- | ------------ | -------------- |
| Cyclical  | 271                   | 192  | 33.2 s    | 8,622  | $301,326    | 201.3 %   | 3.75 %  | 64.3 %       | 980.9 %        |
| Defensive | 162                   | 134  | 22.1 s    | 7,320  | $483,153    | 383.2 %   | 5.39 %  | 51.7 %       | 980.9 %        |
| Sensitive | 298                   | 206  | 35.2 s    | 7,362  | $3,387,652  | 3,287.7 % | 12.46 % | 44.1 %       | 980.9 %        |

All three COMPLETED on the first attempt; each snapshot froze
`{"kind":"POINT_IN_TIME_INDEX","indexKey":"SP500","universeKey":"sp500-<group>","peakSimultaneousMembers":…}`.
One Cyclical and one Sensitive member's windows end before 1996-10-25, so the runs hold 271 and 298.
Redis: 100 % hit rate, 0 misses; the protected tier stayed at the S&P 500's 735 securities and the
key count at 61,154 before and after; memory 531.2 MB → 531.4 MB. These results exercise the product
path; they are not investment results, and the survivorship above inflates the early years.

**Idempotency.** A rerun of the three wrote nothing (3 `UNCHANGED`). A full catalog regeneration
(3 min 12 s) left every universe unchanged except the Nasdaq-100 index universe, whose membership
sync had completed after its last generation on 2026-10-24: a new generation with an identical
output digest, so its List did not change. The 11 sectors stayed BLOCKED.

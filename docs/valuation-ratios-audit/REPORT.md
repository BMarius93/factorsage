# Valuation Ratios V1 — independent audit

**2026-10-02 to 2026-10-06.** Branch `audit/valuation-ratios-v1` (PR #81), from `main` at
`d3a06e8814e018b69143849c31371a4dc677d252` (PR #80 merged). The first verdict (2026-10-03) is in
§1–§35 as first written; §0 is the owner's rulings of 2026-10-06 and everything re-run on them, and
the sections it names are updated to that evidence.

**Verdict (2026-10-06): not passed yet. Valuation Ratios V1 is not closed, and
`valuation-ratios-v1.md` is not marked Accepted.**

- **The owner's rulings are implemented and hold everywhere the comparisons reach.** Rule 3
  compares a count with its anchor; rule 2 confirms a walk's first count; interpretation 1 is
  ratified; the undated-event comments say what the writer persists (§0). The clean-room oracle —
  changed from the decision text by an engineer who never read the product — agrees with the
  product on 95,074,870 generated cells, 1,816,465 real cells (62 securities, every stored
  session), 3,950,655 real cells through the Strategy frame, the backtest's pinned windows, the
  Monitor and the Stock Details service, 2,203,780 cells through the same layers over generated
  stores, 1,282,770 HTTP rows and 30 browser checks: **0 false available, 0 false unavailable, 0
  value mismatches**. All 23 mutants of the ruled rules are killed.
- **The rulings close G1–G3.** The 408 listing-quarter P/B readings that read 21–54 % low are
  withheld; in all 3,789 readings in 3,441 sessions of 29 securities go from available to withheld,
  all through rule 2's first level; nothing becomes available and no value changes.
  `VALUATION_RATIO_REVISION` is 3.
- **It is not passed because the second clean-room review keeps two MAJOR findings against the
  methodology** (§30, §31). Both are shapes the ruled rules still read wrong, product and oracle
  alike, and neither occurs in the store: a count still in the old units observed after an event's
  month — a restatement the provider takes back after the event among them (MAJOR-1), and a count
  first observed already restated ahead of an ex-date (MAJOR-3). A third (MAJOR-2, ordering) was a
  reading of the ruling and is fixed. MAJOR-1 and MAJOR-3 need the owner's ruling — a rule or an
  accepted V1 limitation, as MMM is (§35).
- **MMM's Solventum distribution is the accepted V1 limitation**, confirmed exactly as documented
  and reported as accepted, not as correct (§28).

The evidence summaries are in [`evidence/`](evidence/); the audit's code is under
`apps/api/src/data-correctness-audit/oracle/` (the reference) and
`apps/api/src/data-correctness-audit/valuation/` (the comparisons and the command,
`pnpm audit:valuation`). Nothing in this report is "correct" because a test passes: each claim
names the comparison that supports it, and §33 lists what no comparison here can show.

## Contents

0. [The owner's rulings of 2026-10-06](#0-the-owners-rulings-of-2026-10-06)
1. [Scope](#1-scope)
2. [Base and final commits](#2-base-and-final-commits)
3. [The methodology audited](#3-the-methodology-audited)
4. [Oracle architecture](#4-oracle-architecture)
5. [Independence](#5-independence)
6. [Hand-computed matrix](#6-hand-computed-matrix)
7. [Formulas](#7-formulas)
8. [Point in time](#8-point-in-time)
9. [Share basis](#9-share-basis)
10. [Corporate actions and price basis](#10-corporate-actions-and-price-basis)
11. [Generated histories](#11-generated-histories)
12. [Real data, full scale](#12-real-data-full-scale)
13. [Comparisons per ratio](#13-comparisons-per-ratio)
14. [Available and unavailable counts](#14-available-and-unavailable-counts)
15. [Unavailable reasons](#15-unavailable-reasons)
16. [False available](#16-false-available)
17. [False unavailable](#17-false-unavailable)
18. [Value mismatches](#18-value-mismatches)
19. [Numeric differences](#19-numeric-differences)
20. [Strategy parity](#20-strategy-parity)
21. [Backtests](#21-backtests)
22. [Monitors](#22-monitors)
23. [Stock Details](#23-stock-details)
24. [Redis and PostgreSQL](#24-redis-and-postgresql)
25. [Provider and egress](#25-provider-and-egress)
26. [Generation and re-base](#26-generation-and-re-base)
27. [Real events](#27-real-events)
28. [MMM, the accepted limitation](#28-mmm-the-accepted-limitation)
29. [Mutations](#29-mutations)
30. [Clean-room review](#30-clean-room-review)
31. [Defects found](#31-defects-found)
32. [Fixes](#32-fixes)
33. [Residual limitations](#33-residual-limitations)
34. [Performance](#34-performance)
35. [Recommendation](#35-recommendation)

Appendices: [A. Coverage by rule](#appendix-a-coverage-by-rule) ·
[B. Regression gates](#appendix-b-regression-gates)

## 0. The owner's rulings of 2026-10-06

### The first verdict

On 2026-10-03 the audit did not pass (§1–§35 as first written). The implementation was the accepted
rules on every compared cell, three implementation defects (D1–D3) were fixed, and 88 of 90 mutants
were killed. But the clean-room review showed the rules themselves let wrong readings through: rule
3 compared a count only with the revision before it (G1, G2), and rule 2 accepted a walk's first
count unconfirmed (G3; 408 P/B readings in the store, 21–54 % low). Those were left to the owner
(§31, §35).

### The rulings

| Ruling (owner, 2026-10-06)                   | What it says                                                                                                                                                                               | Commits                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| G1 + G2: rule 3's anchor (option a)          | compare `R` with the latest earlier revision of its quarter that rule 3 itself accepted and that has a usable count; a restated count stays withheld until a matching re-base explains one | decision `6a29eddc`; product `bc969288`; oracle `a180f532` |
| G3: rule 2's first level (option a)          | the walk's first count is confirmed like any new level, on the third consecutive agreeing quarter; no ticker special-cased                                                                 | decision `6a29eddc`; product `6c056d57`; oracle `a180f532` |
| Interpretation 1 ratified                    | an unexplained change withholds only for a revision observed before its detection (both sides already read it so)                                                                          | `6a29eddc` (decision only)                                 |
| Undated events: docs aligned with the writer | `effectiveTo` is always set; every interval end the writer persists is described                                                                                                           | `6a29eddc`, `dd96cc0b`                                     |

`VALUATION_RATIO_REVISION` 2 → 3; a backtest queued under revision 2 is refused (§21).

**One reading of the ruling, for the owner to confirm.** "Earlier" in rule 3 is the order of
observation, among the revisions public on the statement date (§5, interpretation 5): ordered by
availability, a late-observed amendment dated from an earlier filing anchored a restatement
observed before it (the second review's MAJOR-2). Fixed in `dd96cc0b`, `154235eb` and `a0628b8e`.

### How it was implemented and checked

- **Decision first.** The rulings were written into `valuation-ratios-v1.md` rules 2, 3 and 6 and
  `historical-price-basis-v1.md` §10 and "Data model" before either implementation changed.
- **Product** (`packages/stock-data/src/valuation-ratios.ts`): `holdsShareLevel` confirms the first
  level; `passesRestatementRule` walks a quarter's revisions in the order of observation and judges
  each against the anchor its predecessors leave (`acceptedAgainst`).
- **Oracle** (`oracle/valuation-ratios.ts`): changed by an engineer who read only the decisions, the
  report and the oracle's folder — never the product — from the text (`shareLevel`,
  `restatementWalk`, `observationOrder`). It still imports nothing.
- **Hand cases** re-derived from the text: G1a, G1b, G2 and G3 flipped (each comment records the
  reading before the ruling); G1c, G1d, G1e, G1f, G1g, G1h and G3b added; every share-level walk
  withholds its first two quarters. The oracle reproduces every literal (116 tests) and the product
  is held to them (95 tests).
- **Regression tests** (`valuation-ratios.test.ts`, 46 tests): six fail on the previous head
  `65a05594`; the late-amendment test also fails on the rulings' first commit `ec67731f`.
- **The generator** draws the rulings' shapes — revisions observed after the re-base, restatements
  taken back, late-observed amendments — and the CI asserts each path is reached.

### Readings changed in the store

The product before (`65a05594`) and after the rulings, on every stored session of the audit copy
(62 securities, 363,293 sessions, five ratios):

| Change                           | Readings | Sessions | Securities |
| -------------------------------- | -------- | -------- | ---------- |
| available → withheld             | 3,789    | 3,441    | 29         |
| withheld → available             | 0        | 0        | 0          |
| value changed                    | 0        | 0        | 0          |
| of which rule 3's anchor (G1/G2) | 0        | 0        | 0          |

- **All through rule 2's first level:** P/B 3,441 readings; P/E, P/S and EV/EBITDA 116 each
  (AXON, 2002-11-14 to 2003-05-02, whose first counts kept disagreeing until 2003). Rule 3's anchor
  and the order of observation change nothing: no stored revision changes a count.
- **The 408 G3 readings** (AMZN, CAVA, CRCL, META, PLTR, RIVN, UBER) are all among them: none is
  available now (`retention-scope.json`, `firstCountExposure.availableCells` 0), and retention no
  longer makes any cell available that every stored row would withhold (1,409 → 0).
- **The cost the owner accepted:** the first two quarters of every walk that starts inside the
  stored sessions lose P/B, and the other ratios have no trailing window yet there. In the store
  those are the listing quarters of 22 more securities listed since 1989: ABNB, ALAB, ARM, AXON,
  CRM, CRWD, CRWV, DDOG, FANG, FIG, FTNT, GS, HOOD, MBLY, MPWR, MRNA, MSTR, NVDA, PANW, RDDT, ROP
  and V.

### Evidence re-run on the rulings

| Comparison                                       | Cells or checks                           | False available | False unavailable | Mismatch |
| ------------------------------------------------ | ----------------------------------------- | --------------- | ----------------- | -------- |
| Generated, seeds 1–5000 of both families (§11)   | 95,074,870                                | 0               | 0                 | 0        |
| Real, `pure` (§12)                               | 1,816,465                                 | 0               | 0                 | 0        |
| Real, Strategy, backtest, Monitor, Stock Details | 3,950,655, bit-identical to `pure`        | 0               | 0                 | 0        |
| Generated stores, every layer, seeds 1–40 (§12)  | 2,203,780, bit-identical to `pure`        | 0               | 0                 | 0        |
| HTTP, pinned clock (§23)                         | 1,282,770 rows; 300 × 200, 10 × 503       | 0               | 0                 | 0        |
| Browser (§23)                                    | 30 of 30                                  | —               | —                 | —        |
| Cache parity (§24)                               | 365 reads, 0 mismatches, 0 provider calls | —               | —                 | —        |
| Worker backtest and Monitor audits (§21, §22)    | 21 tests; revision 3 pinned               | —               | —                 | —        |

The 10 answers of 503 are BRK-A and GOOG, never verified. The maximum relative difference is
3.7e-16 on real data and 1.15e-12 on generated data, inside its bound (§19).

**The rulings' own paths, both ways.** In the generated run rule 3 compares a count with an
anchor past a withheld or count-less revision on 65,037 available cells — 25,907 of them a
restatement a re-base explains against the anchor — and 216,368 withheld ones. Rule 2 withholds
15,371,440 cells before a walk's first level. The CI-sized run (seeds 1–150) asserts each.

**Mutation pass** (§29): 23 of 23 killed. These are ten mutants of the rulings and the thirteen
earlier rule 2 and rule 3 mutants re-expressed on the ruled code. The MAJOR-2 revert (N10) is killed
by G1e and by the generated comparison.

### The second clean-room review

A fresh reviewer reviewed the implementation read-only. It used its own probes, a fuzzer of revision
chains (8.5 M cells, 0 product–oracle disagreements) and 11.4 M fresh generated cells (§30). Its
follow-up held no BLOCKER or MAJOR against the product, the oracle or the hand cases. MAJOR-2,
MINOR-4, MINOR-5 and the nits are fixed.

It keeps two MAJOR findings against the methodology. They are open questions for the owner,
recorded in the decision under "What rule 3 cannot tell apart":

- **MAJOR-1: a count still in the old units observed after an event's month.**
  - It agrees with its anchor and reads off by the event's ratio.
  - The reproduction is a 2:1 split whose restatement the provider takes back after the event:
    P/E 1.5 against a coherent 3.
  - Comparing with the withheld revision before it used to withhold this case. Anchoring to the
    last accepted count is what lets it through.
- **MAJOR-3: a count first observed already restated ahead of an ex-date.**
  - It has no anchor and rule 2 sees no step.
  - The reproduction reads P/E 6 against a coherent 3 before the event.
  - This shape is older than the rulings.

Neither occurs in the store. §35 lists the options.

## 1. Scope

Audited: the five ratios of Valuation Ratios V1 — P/E (`PRICE_TO_EARNINGS_TTM`), P/S
(`PRICE_TO_SALES_TTM`), P/B (`PRICE_TO_BOOK`), P/FCF (`PRICE_TO_FCF_TTM`) and EV/EBITDA
(`EV_TO_EBITDA_TTM`) — as the one calculation computes them
(`packages/stock-data/src/valuation-ratios.ts`: `buildValuationTimeline`, `valuationRatioColumns`,
with `basisFactorAt` from `price-basis.ts`), and every consumer of it: the Strategy evaluation
frame, a backtest's preparation and its pinned per-year window reads, the real
`BacktestProcessor`, the Monitor frame and cycle, the Stock Details service, the HTTP route
`GET /stocks/:symbol/valuation-ratios/daily`, and the browser chart and hover legend; their
Redis and PostgreSQL paths, their provider traffic, and the price-basis generation that every read
pins.

Both halves of the product rule ("correct or unavailable") are audited: a reading the product
shows where the rules withhold it is a **false available**; a reading it withholds where the rules
give one is a **false unavailable**. Each is counted separately everywhere below.

The specification is the accepted design, not the implementation:
`docs/decisions/valuation-ratios-v1.md` (formulas, inputs, rules 0–8, consumers),
`docs/decisions/historical-price-basis-v1.md` (events, `verifiedAt`, `K`, the generation),
`fundamental-metrics-v1.md` and `fundamental-metrics-storage-and-evaluation.md` (the inherited
statement rules), `docs/architecture/fundamentals-loader.md` (retention), and
`complete-price-coverage.md` (the Stock Details window).

Not in scope, and why:

- **Margin of Safety.** It shares `basisFactorAt` with the ratios; nothing here changed it, and
  its own historical problem is not addressed (`historical-price-basis-v1.md` §13).
- **How PR 1 measures a re-base.** The audit takes `SecurityPriceBasis` and `PriceBasisEvent`
  rows as inputs and checks how the ratios use them. Whether a measured event is the right
  measurement of a provider re-base is PR 1's own suite (`price-basis.test.ts`,
  `price-basis.integration.test.ts`); §10 lists which of the brief's corporate-action cases rest
  on it.
- **Events FMP does not report.** By the owner's decision these are an accepted V1 limitation
  (§28). The audit confirms the limitation is exactly as documented; it does not fix it.
- **The live provider.** No comparison reached FMP (§25).

## 2. Base and final commits

| Commit                                                     | What                                                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `d3a06e88`                                                 | `main`, the audited base (PR #80, Stock Details valuation ratios, merged)                                                         |
| `6edd1d24`                                                 | `test(valuation): add independent valuation oracle`                                                                               |
| `02bd1643`                                                 | `fix(valuation): read an undated re-base only on the days it may lie on` (D1)                                                     |
| `2cafa3af`                                                 | `fix(valuation): judge a 2 % share restatement exactly` (D2)                                                                      |
| `98048609`                                                 | `fix(valuation): judge the 25 % share level exactly` (D3)                                                                         |
| `2a06a113`                                                 | `test(valuation): audit valuation ratios at full scale`                                                                           |
| `62f40d50`                                                 | `test(valuation): audit valuation consumers and price basis`                                                                      |
| `b6703048`                                                 | `test(valuation): file the audit's product rows a day before availability`                                                        |
| `9b9d4404`                                                 | `test(valuation): pin the rules' reading where the review found it wrong` (G1–G3 hand cases, oracle diagnostics)                  |
| `0e29fc14`                                                 | `test(valuation): generate share-basis restatements and their chains` (the second family)                                         |
| `c0f882fe`                                                 | `test(valuation): hold every layer to the stored sessions, over generated stores too`                                             |
| `8c45b791`, `33e653b3`, `b5a92f90`, `a96fa0e5`             | hand cases for the boundaries the mutation passes found unpinned                                                                  |
| `5daaf3a5`, `32388357`, `41efde02`, `89fdc1b2`, `d8c3b6f8` | audit tooling: histogram percentiles, the Monitor quote's precision, progress logging, the HTTP refusal criterion, lock durations |
| `cfe3305a`                                                 | `docs(valuation): record independent valuation audit`: this report and its evidence                                               |
| `65a05594`                                                 | `docs(valuation): compare the gate's flakes with clean main`: Appendix B, and three table rows of §31–§32 repaired                |
| `6a29eddc`                                                 | `docs(valuation): write the owner's rulings on rules 2 and 3 into the decisions` (§0)                                             |
| `bc969288`                                                 | `fix(valuation): compare a restated count with its rule 3 anchor` (G1, G2; revision 3)                                            |
| `6c056d57`                                                 | `fix(valuation): confirm the walk's first share count like any new level` (G3)                                                    |
| `a180f532`                                                 | `test(valuation): hold the oracle and the hand matrix to the owner's rulings`                                                     |
| `ec67731f`                                                 | `test(valuation): generate revisions after the re-base and restatements taken back`                                               |
| `dd96cc0b`                                                 | `docs(valuation): answer the second clean-room review in the decisions`                                                           |
| `154235eb`                                                 | `fix(valuation): judge rule 3 against what was observed before the revision` (the second review's MAJOR-2)                        |
| `a0628b8e`                                                 | `test(valuation): hold the oracle to rule 3's order of observation`                                                               |
| `51b67ab3`, `6ee55a7e`                                     | the generator reaches rule 3's explained path in CI and late-observed amendments; the HTTP run's pinned clock                     |
| `919f58c5`, `8acdbd61`                                     | the browser audit's pinned page clock; a constant no ruled hand case reads, removed                                               |
| `ea589494`, `4bd0feea`                                     | wording from the follow-up review; "Measured coverage" marked as measured before revision 3                                       |
| (this commit)                                              | this report and its evidence, re-run on the rulings                                                                               |

## 3. The methodology audited

From `valuation-ratios-v1.md`, as the owner's rulings of 2026-10-06 (§0) left it; the audit itself
changed no rule:

- `MC = close × K × dilutedShares`. P/E = MC / NetIncome TTM; P/S = MC / Revenue TTM; P/B = MC /
  totalStockholdersEquity; P/FCF = MC / FCF TTM with FCF = operating cash flow + capital
  expenditure per quarter; EV/EBITDA = (MC + netDebt) / EBITDA TTM.
- **Inputs.** TTM sums are exactly four consecutive standalone fiscal quarters of one family, the
  latest point-in-time revision of each; an FY row never fills a quarter; no older complete window
  stands in for a newer incomplete one. The share count is the latest point-in-time Income
  quarter's `weightedAverageShsOutDil`; equity and net debt are the latest point-in-time balance
  sheet's. Every statement a ratio reads, the share count's included, is in the security's trading
  currency. Denominators and the share count must be positive; the close must be a positive price;
  a result must be finite and `|value| < 10^12`. Otherwise the reading is unavailable — never 0,
  never a carried value.
- **Point in time.** A revision is eligible on a session `t` when `availableFromDate <= t`; among
  eligible revisions of one fiscal quarter the representing one is the latest by
  `availableFromDate`, then `observedAt`, then — only between rows of one observation — the later
  `fiscalDate`, then `contentHash`.
- **Rules 2 and 3 as ruled** (owner, 2026-10-06). Rule 2 confirms the walk's first count like any
  new level, on the third consecutive agreeing quarter. Rule 3 compares `R` with its anchor: the
  latest revision of the quarter observed before `R`, among those public on the statement date,
  that rule 3 itself accepted and that has a usable count. A restatement nothing explains is
  withheld and anchors nothing; one a measured re-base explains — new to the anchor, known when `R`
  was observed — is accepted and anchors the revisions after it. (Before the rulings rule 2
  accepted a walk's first count and rule 3 compared `R` with the revision just before it: G1–G3,
  §31.)
- **Price-basis rules 0–8** ("The rules"): 0 verified history; 1 the inputs; 2 the share-count
  level (25 %, a new level — the first one too — on its third consecutive agreeing quarter); 3 an
  unexplained restatement of more than 2 % from the anchor; 4.1 a non-plain listed history entry masks until each family
  covers it, 4.2 a count observed before a listed entry; 5 a count observed in `[E, E + 30)` for a
  quarter ended before `E`; 6 the basis factor `K` (`historical-price-basis-v1.md` §10); 7 after
  a measured non-plain re-base, until coverage; 8 a forward entry holds `[E, E + 30]` unless a
  re-base is measured within seven days of it; the plain-share predicate.
- **Consumers.** A Strategy Condition on an unavailable ratio is `NOT_EVALUABLE`: a backtest never
  acts on it and a Monitor never raises a Signal on it. A Monitor's provisional session reads the
  newest closed session's statements at the live quote. A backtest pins the price-basis generation
  and `valuationRatioRevision`; Stock Details reads the same calculation.
- **Retention.** Statement revisions are retained for fiscal period ends in
  `[max(today − 37 years, listing date), today]` (`fundamentals-loader.md`, "Valuation warm-up
  retention"); the calculation reads exactly that range.

## 4. Oracle architecture

`apps/api/src/data-correctness-audit/oracle/valuation-ratios.ts` (1,333 lines), written from the
decisions above.

- **Exact arithmetic.** Every stored decimal (statement values, the close, measured price ratios,
  split numerators and denominators) is parsed from its text into a `bigint` rational. Sums,
  products, `K` and every ratio are exact rationals; thresholds (25 %, 2 %, 0.5 %, the plain
  ratios, `10^12`) are compared exactly. A double appears only at the very end, as the nearest
  double of the exact value, for reporting.
- **Its own statement reading.** Eligibility, the representing-revision order, quarter ranks
  (`fiscalYear · 4 + quarter`), the four-quarter windows, FY exclusion, field presence and the
  currency rule are implemented in the file; nothing is taken from `selectFinancialStatements` or
  the product's window helpers.
- **Its own rules.** The share-level walk (rule 2), the restatement check (rule 3), rules 4–8, the
  plain-share predicate and `K` with §10's cases are implemented once each, in the order the
  decision states them.
- **One reading per session.** `createValuationOracle(security).reading(session, close,
{ statementDate })` returns, per ratio, either an exact value with its terms (`MC`, the
  addend, the denominator, the number of basis factors) or "unavailable" with a **primary reason**
  and every failing rule (§15's reason model). `statementDate` is the Monitor's provisional row:
  statements as of the newest closed session, every session rule on the row's own date.
- **Comparison** (`valuation/compare.ts`). A product double is compared with the exact value as an
  exact rational (the double's own exact value), against an error bound derived from the
  product's float operations (§19). Each cell is one of `AVAILABLE_MATCH`,
  `EXPECTED_UNAVAILABLE`, `FALSE_AVAILABLE`, `FALSE_UNAVAILABLE` or `VALUE_MISMATCH`.
- **Real-data inputs** (`valuation/real-data.ts`, `readOracleRows`) are read with the audit's own
  SQL from the raw tables: no product read path, no store method.

## 5. Independence

- **No imports.** The oracle file imports nothing at all; `valuation-ratios.test.ts` asserts that
  its import list is empty and that the names `buildValuationTimeline`, `valuationRatioColumns`,
  `basisFactorAt`, `isPlainShareRatio`, `selectFinancialStatements` and `@intrinsic` never occur
  in it. ESLint (`eslint.config.mjs`) forbids `@intrinsic/*`, `@prisma/*` and any parent-directory
  import in `apps/api/src/data-correctness-audit/oracle/**`.
- **One bridge, no decisions.** `valuation/production-adapter.ts` is the only place that converts
  the oracle's input rows into the product's input types (decimal text to doubles, as the product's
  store reads them) and calls `buildValuationTimeline` and `valuationRatioColumns`. It decides
  nothing. Since `b6703048` it files each row a day before its availability, as the store does,
  so a calculation that read the filing date would differ (it did not; the mutation in §29 proves
  the comparison would see it).
- **Hand values are literals.** Every expectation in `valuation-ratios.hand-matrix.ts` was worked
  out by hand from the decision, with the arithmetic in comments, and is a literal fraction or a
  literal reason. None is produced by code.
- **What the oracle shares with the product:** the stored rows, the ISO date format, the
  decision, and the readings and conventions below — the clean-room review found that the oracle
  resolves every ambiguous point the product's way, three of them permissively (G1–G3, §31).
- **The rulings, implemented apart.** For the owner's rulings of 2026-10-06 (§0) the decision text
  was written first; the oracle was then changed by an engineer who read only the decisions, the
  report and the oracle's own folder — never the product — and the product separately. Both sides
  were held to hand cases re-derived from the text, and the second clean-room review fuzzed them
  against each other (§30).
- **Interpretations, recorded as made.** Four places needed a reading of the decision:
  1. **An `UNEXPLAINED` event** withholds sessions only for a share-count revision observed
     before its detection (**ratified by the owner on 2026-10-06**; `historical-price-basis-v1.md`
     §10 now says so). `historical-price-basis-v1.md` §10 introduces every case "by when `R`
     was observed", states the unbounded case "for a revision observed before its detection",
     and §13 says "everything for older revisions"; the bounded case ("withholds only the
     sessions it changed") is the same rule restricted to the changed sessions — a reading in which
     a bounded change withheld more, for a later revision, than an unbounded one would be
     incoherent. The first draft withheld a bounded change's sessions for every revision. It was
     revised to this reading **after reading the product's `basisFactorAt`**, before the first
     comparison was run; the hand cases C41, C41b and C41c were re-derived and added then. This
     is the one place the product's code was read before the oracle's rule was final, and the
     clean-room reviewer was asked to judge it (§30).
  2. **Two hand derivations were wrong** in the first draft and were caught by re-deriving them
     before any comparison ran: C09 (a capital expenditure gap still inside the 2025Q2 cash-flow
     window) and C20b (the 2024Q4 Income row in EUR still inside the 2025Q2 Income window).
  3. **Real-data scope.** The oracle reads the **retained** statement revisions only (§3,
     "Retention"), as the accepted Fundamental Metrics audit does. The first real-data run fed
     every stored row and reported 6,664 false-unavailable and 124 false-available cells, all on
     1,135 stored revisions outside retention (pre-listing and predecessor quarters, 240 of them
     AAL's and 173 HON's), and classified them as the accepted retention policy. The 6,664 are;
     the 124 turned out to be G3 (§31), which the review found.
  4. **Numeric conventions.** A provider number (a JSON double) is valued at its shortest
     round-trip decimal — the figure the provider reported — which is also how the fixed product
     judges rules 2 and 3 (D2, D3); and a result or market capitalisation beyond the largest double
     is withheld, as a product computing in doubles must. Neither is in the decision; both are the
     product's conventions, adopted so the comparison measures logic rather than representation.
     Two further readings the oracle shares with the product turned out to matter: a walk's first
     count is accepted, and rule 3 compares only the revision before `R` (and passes when it has no
     count). The review showed both to be permissive: G1–G3, §31; the owner ruled both away on
     2026-10-06 (§0).
  5. **"Earlier" in the ruled rule 3** is the order of observation, among the revisions public on
     the statement date: a revision observed after `R` is never its anchor, however early the
     loader dates it. Ordered by availability, a late-observed amendment anchored a restatement
     observed before it (the second review's MAJOR-2, §30). It is recorded in the decision as a
     reading of the owner's "latest earlier revision", for the owner to confirm.

## 6. Hand-computed matrix

`apps/api/src/data-correctness-audit/oracle/valuation-ratios.hand-matrix.ts`: one base company
(ten calendar quarters 2023Q1–2025Q2, every statement observed on 2026-08-31, history verified
2026-10-02, close 12 and 10 diluted shares, so `MC = 120`) and its readings as of each quarter,
then 74 cases that vary it (184 session observations, each with all five ratios), 14 share-level
walks and 5 restatement thresholds. Every expected reading is a literal fraction, or the rule that
withholds it. 57 cases were written before the first comparison; C25b, C18d, C31d, C39e, C39f, C40c
and the non-integer walk were added for boundaries the mutation passes found unpinned. G1a, G1b, G2
and G3 first pinned the methodology gaps (§31) and now hold the owner's rulings, each comment
recording the reading before them; G1c, G1d, G1e, G1f, G1g, G1h and G3b were added with the rulings
(§0), and every share-level walk now withholds its first two quarters.

| Brief case                                           | Matrix cases                                        |
| ---------------------------------------------------- | --------------------------------------------------- |
| 1–5 ordinary P/E, P/S, P/B, P/FCF, EV/EBITDA         | C01 (every statement state 2023Q3–2025Q2)           |
| 6 negative EV/EBITDA                                 | C06, C06b (EV exactly 0), C06c (−1/10⁸)             |
| 7 denominator exactly zero                           | C07                                                 |
| 8 negative denominator                               | C08                                                 |
| 9 missing denominator                                | C09                                                 |
| 10–12 missing, zero, negative diluted shares         | C10, C11, C12                                       |
| 13 incomplete TTM window                             | C01 (before 2024-03-01), C14                        |
| 14 a missing quarter inside the window               | C14                                                 |
| 15 FY never fills a quarter                          | C15, C15b                                           |
| 16 available on a weekend                            | C16                                                 |
| 17 available on a holiday                            | C17                                                 |
| 18 available on a trading day                        | C18, C18b (revision order), C18c (moved period end) |
| 19, 20 currency                                      | C19, C20, C20b                                      |
| 21 share-count anomaly                               | C21                                                 |
| 22 accepted after three confirmations                | C22                                                 |
| 23 a missing quarter resets the confirmation         | C23 (missing count), C23b (missing quarter)         |
| 24 unexplained restatement                           | C24                                                 |
| 25 explained restatement                             | C25                                                 |
| 26 explanation outside the timing window             | C26, C27b                                           |
| 27 an old re-base of the same ratio explains nothing | C27, C27b                                           |
| 28 historical distribution-like entry                | C28, C30b                                           |
| 29 ordinary split                                    | C29                                                 |
| 30 reverse split                                     | C30, C30b                                           |
| 31 forward listed event not re-based                 | C31, C31b, C31c                                     |
| 32 measured possible distribution                    | C32                                                 |
| 33, 34 coverage not yet sufficient, then sufficient  | C32, C32b                                           |
| 35, 36 basis factor withheld, available              | C25, C31b, C35, C35b                                |
| 37 never verified                                    | C37                                                 |
| 38 generation changes during a read                  | C38a, C38b (§26 for the read itself)                |
| 39 same-day corporate-action boundary                | C25, C31, C35, C39, C39b, C39c, C39d                |
| 40 undated event interval                            | C40, C40b; unexplained changes C41, C41b, C41c      |
| Monitor provisional row                              | C42                                                 |
| numeric edges                                        | C43, C43b, C43c                                     |
| the owner's rulings (2026-10-06)                     | G1a–G1h, G2 (rule 3's anchor), G3, G3b (rule 2)     |

The share-level walks (`SHARE_LEVEL_WALKS`) hold rule 2 at 12 sequences: steady counts, a
one-quarter and a two-quarter artefact, a merger-like step accepted on its third quarter, a step
whose agreement a missing or zero count restarts, an alternating ±40 % block, the agreement with
the count that left the level, and the 25 % band just inside, exactly on and just outside it in
both directions — once more on non-integer counts (1.1 to 0.825) whose doubles disagree with them. The restatement thresholds
(`RESTATEMENT_THRESHOLDS`) hold rule 3 at 10 → 10.19999, 10.2, 10.20001, 9.8 and 9.79999.

**Results.** The oracle reproduces every literal exactly (`oracle/valuation-ratios.test.ts`, 116
tests: every case, walk and threshold, the primary reason and every failing rule, the exact
fraction, the import check, and the oracle engineer's own tests of the rulings' diagnostics,
ordering ties and public-only walks). The product is held to the same literals
(`valuation/valuation-hand-matrix.test.ts`, 95 tests; the product reports absence only, so its
reasons are not compared, and a count-less quarter of a walk must have no reading): all pass on
this branch. On `main` the 10 → 10.2 threshold fails (D2) and so does the non-integer 25 % walk
(D3); the defect reverts in §29 (M39–M41) are killed by these tests.

## 7. Formulas

- **Hand.** C01 holds all five ratios at every statement state of the base company, e.g. as of
  2024Q4: P/E 3 (120/40), P/S 3/10 (120/400), P/B 1/2 (120/240), P/FCF 12/5 (120/50, FCF = 4 ·
  OCF + CapEx sums 12 + 12 + 13 + 13), EV/EBITDA 17/10 ((120 + 50)/100). C06 (net cash above
  `MC`: a negative EV/EBITDA), C06b (EV exactly 0 is a reading of 0), C06c (−1/10⁸), C08
  (negative EBITDA, equity, FCF: unavailable), C09 (a missing capital expenditure withholds
  P/FCF while its quarter is in the window; the stored `freeCashFlow` is never used), C10–C12 (no
  basic-share fallback; zero and negative counts withheld) and C14 (no older complete window).
- **Generated.** 33,710,720 available readings across the five ratios match the exact value
  within the bound (§11), 0 mismatches.
- **Real data.** 1,392,386 available readings over 62 securities match, 0 mismatches (§12).
- **Mutations.** P/E on Revenue, P/S on Net Income, P/B on `totalEquity`, P/FCF on the provider's
  `freeCashFlow`, EV/EBITDA without net debt or on total debt, basic shares, an annualised
  quarter and an EPS-based P/E: all killed by the audit's own suites (§29).

Every formula has an independent mapping proof: the oracle derives each from its own field names
(`netIncome`, `revenue`, `ebitda`, `operatingCashFlow` + `capitalExpenditure`,
`totalStockholdersEquity`, `netDebt`, `weightedAverageShsOutDil`), and the hand matrix's
per-ratio literals differ for every pair of ratios at C01, so a ratio identity mapped to another's
inputs cannot match (R in §30).

## 8. Point in time

- **Hand.** C16: a filing available on Saturday 2025-02-22 reads first on Monday 2025-02-24, the
  Friday before keeps the older state. C17: a restatement available on Christmas 2024 reads first
  on 2024-12-26. C18: one available on a trading day (2024-12-17) reads on that very session.
  C18b: two revisions available the same day — the later observation wins; two from one
  observation — the later period end wins. C18c: a moved period end is the same quarter (the window
  stays four quarters). C15/C15b: FY rows never fill a quarter or supply the share count. Every
  case has a session before, on and after its boundary.
- **Generated.** Every session of every history is compared, so every availability boundary in
  51.7 M cells is checked: revisions with moved period ends (1,705 histories), same-day later
  observations (1,701), restated values (1,683), removed fields (1,736), restated counts, currency
  changes, and lagging balance sheets (496) and cash flows (508). Each session is read twice: as
  a closed session (its own statements) and as a Monitor's provisional row (the previous session's
  statements, §22).
- **Real data.** Every stored session of 62 securities: every availability boundary of the 18,170
  retained quarterly revisions (of 18,987 stored). Every one becomes available after its filing
  date — the day after a real one, a day after the statutory deadline for a placeholder — so a
  calculation that read the filing date would differ on each.
- **Mutations.** Statements one day early, one session early, the filing date for the
  availability date, the previous revision reused, a later revision leaked backward, an FY row as
  Q4, an older complete window, a later period end over a later observation: all killed by the
  audit's own suites (§29).

## 9. Share basis

- **Rule 2.** Hand C21 (a one-quarter artefact withheld, the level resumes), C22 (a new level on
  its third consecutive quarter), C23/C23b (a missing count or quarter restarts the agreement),
  G3 and G3b (the first level, as ruled) and the 14 walks. Generated: steady, drifting, artefact,
  two-quarter artefact, alternating, level-jump, exact-boundary up and down, missing and
  non-positive counts (408–885 histories each); rule 2 withholds 15,371,440 cells before a walk's
  first level. Real data: rule 2 is the first failing rule on 3,614 (P/E) to 8,715 (P/B) sessions,
  in 42 securities (24 before the rulings) — among them NKE's ×2.03 quarter of 2002 (85 sessions),
  MSTR's 1999 counts and Visa's alternating 2010–2012 blocks (three withheld half-years), the
  decision's own examples, and now the first two quarters of every walk that starts inside the
  stored sessions (§0).
- **Rule 3.** Hand C24 (unexplained), C25 (explained by a 5:4 re-base), C26 (dated 30 or more days
  before the previous observation), C27 and C27b (an old re-base of the same ratio, known before
  the previous revision or measured only after it), the 2 % thresholds, and the ruled anchor:
  G1a–G1h and G2 (§0). Generated: exact-2 %,
  just-over-2 %, split-sized and random restatements (1,667–1,735 histories each), and explained
  restatements with the re-base at −31, −30, −29, −1, 0, +1 and +5 days around the previous
  observation, the restated observation and between them (38–75 histories per combination); the
  restatement family reaches the anchor past a withheld or count-less revision on 65,037 available
  cells (25,907 of them explained by a re-base against the anchor) and 209,563 withheld ones.
  Real data: rule 3 never applies — the copy holds 11 revisions with a previous revision of the
  same quarter and none changes the count — so it is proven synthetically only.
- **Defects.** D2 (rule 3's 2 % in doubles) and D3 (rule 2's 25 % in doubles), §31.

## 10. Corporate actions and price basis

Every session is compared in the generated and the real-data runs, so every unavailable
interval's first withheld session, last withheld session and first resumed session is checked
exactly; the real ones are listed per security and ratio in `evidence/real-data.json`
(`intervals`) and summarised in §27.

| Brief case                                            | Evidence                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. never verified                                     | C37; generated `verified-null` (1,002 histories); real BRK-A and GOOG, 14,126 sessions per ratio, all withheld by both sides                                                                                                                                           |
| B. historical plain split                             | C29; generated `plain-entry` (2,270); real AAPL, NVDA, AMZN, WMT and every other 2:1-style entry: no mask                                                                                                                                                              |
| C. historical reverse split                           | C30; generated (1:k entries); real MSTR 1:10 (2002): no mask                                                                                                                                                                                                           |
| D. a non-plain entry                                  | C28; generated `non-plain-entry` (2,708); real IBM 523:500, MRK 131:125, WDC 1323:1000, AXP 10000:8753 and 400:353, HON 1011:1000, GOOGL 999:500, GOOG 1001:500, DIS 2000:1973, stock dividends                                                                        |
| E. a mislabelled entry                                | C30b (a plain ratio with another label); real HON 1907:2000 labelled `spin-off`                                                                                                                                                                                        |
| F. a malformed ratio                                  | C30b (an unreadable 0:1 entry is a possible distribution); the mapper keeps it (`packages/fmp` mapping test; mutation M46)                                                                                                                                             |
| G, H. listed upcoming, not yet re-based               | C31; generated `forward-entry` (1,228). Real: none — the only forward entries on 2026-10-01 (GPMT, DXJ) belong to securities without statements                                                                                                                        |
| I. re-base measured later                             | C31b (measured within seven days: the hold stops, `K` takes over), C31c (eight days: no match)                                                                                                                                                                         |
| J. measured ordinary split                            | C35, C35b; generated `plain-measured` (1,968)                                                                                                                                                                                                                          |
| K. measured non-plain                                 | C32, C32b; generated `non-plain-measured` (1,788), `near-plain-measured` (700)                                                                                                                                                                                         |
| L. `UNEXPLAINED`                                      | C41, C41b, C41c; generated `unexplained-bounded` (243), `unexplained-unbounded` (264)                                                                                                                                                                                  |
| M. dated event                                        | C25, C35; generated `dated-measured` (2,266)                                                                                                                                                                                                                           |
| N. undated interval                                   | C40, C40b; generated `undated-measured` (1,357); D1 (§31)                                                                                                                                                                                                              |
| O, P. distribution then old, then covering statements | C32 (withheld until each family covers it), C32b (a lagging balance sheet keeps P/B and EV/EBITDA withheld); generated `lagging-BALANCE_SHEET`, `lagging-CASH_FLOW`; real WDC, IBM                                                                                     |
| Q. several actions in one quarter                     | generated `several-events-one-quarter` (711)                                                                                                                                                                                                                           |
| R. two events with similar ratios                     | C27, C27b (an old re-base of the same ratio); generated `event-near-entry` (1,121), `near-plain-measured`                                                                                                                                                              |
| S. re-base during a read                              | C38a/C38b; §26                                                                                                                                                                                                                                                         |
| T. re-base replacement refused                        | PR 1's suite (`price-basis.integration.test.ts`); the ratios read only committed generations (§26)                                                                                                                                                                     |
| U. provider history missing beyond 1 %                | rule 0: such a history stays unverified, which is case A                                                                                                                                                                                                               |
| V, W. split-list refresh failure, stale list          | the product's suite (`valuation-history.integration.test.ts`, `stocks.integration.test.ts`: a day-old list is re-read, a failed read refuses); the calculation reads whatever list is stored, so a stale list is case G or "an entry the provider does not list" (§28) |
| X. event on a range's first or last session           | the backtest-window layer reads each security one calendar year at a time (§12), so every event near a year boundary is read at a window's first or last session; generated events fall on every day of the calendar                                                   |

Rules that never apply in the real data — 3, 4.2, 5, 6, 7 and 8, and the currency rule — are
proven synthetically: the copy holds no measured re-base (`PriceBasisEvent` is empty), every
statement was observed more than 30 days after every listed event, and no retained statement is in
another currency. §15 gives the cells each rule alone withholds in the generated run.

## 11. Generated histories

Two families of seeded histories (mulberry32), every one compared session by session, both read
twice by `differential.ts` — as a closed session (its own statements) and as a Monitor's
provisional row (the previous session's statements, the session's own price-basis rules) — through
the oracle and through the product, all five ratios classified. Neither generator encodes a rule.

- **Adversarial** (`valuation/generator.ts`): one seed is one security of 8–20 fiscal quarters of
  the three families, with revisions, delayed and lagging availability, missing quarters and
  fields, FY rows, currency changes, signed and zero denominators, share-count levels, artefacts
  and one-quarter restatements, a weekday calendar with holidays and a close series, a provider
  split list (plain, non-plain, mislabelled, unreadable, history and forward), measured re-bases
  (dated, undated, plain, near-plain, possible distributions), unexplained changes and
  `verifiedAt` placements. Features aim at the decision's boundaries: an observation on an event's
  date or an interval's first day, a re-base exactly 6, 7 and 8 days from an entry either side, a
  2 % restatement exactly and just over, a 25 % share move exactly, a ratio at the
  representability limit.
- **Share-basis restatements** (`valuation/generator-restatements.ts`, added after the
  clean-room review): one share-basis event per security and the provider's restatement of every
  earlier count by its ratio at once, from 25 days before it to 90 after; revision chains after
  the restatement (another field, the same count, a 1 % or an exactly 2 % move, no count);
  count-less predecessors; a re-base of another ratio; listed or unlisted entries; verification
  before or after the event; re-bases measured dated, undated, at the first verification or not
  yet, with the stored closes re-based exactly when they are. Since the rulings (§0) it also draws,
  last, a revision of the newest restated quarter observed once the re-base is known (before the
  next filing when there is room), the provider taking a restatement back, and a late-observed
  amendment dated before the restatement.

| Family                                     | Seeds                | Histories  | Sessions      | Comparisons    | Available match | Expected unavailable | False available | False unavailable | Value mismatch |
| ------------------------------------------ | -------------------- | ---------- | ------------- | -------------- | --------------- | -------------------- | --------------- | ----------------- | -------------- |
| adversarial                                | 1–5000               | 5,000      | 5,173,597     | 51,735,970     | 10,355,502      | 41,380,468           | 0               | 0                 | 0              |
| restatements                               | 1–5000               | 5,000      | 4,333,890     | 43,338,900     | 23,355,218      | 19,983,682           | 0               | 0                 | 0              |
| **report run** (`evidence/generated.json`) | 1–5000               | **10,000** | **9,507,487** | **95,074,870** | **33,710,720**  | **61,364,150**       | **0**           | **0**             | **0**          |
| CI (`valuation-differential.test.ts`)      | 1–150, both families | 300        | 289,869       | 2,898,690      | —               | —                    | 0               | 0                 | 0              |

The report run (revision 3, 2026-10-06) took 35 minutes on a loaded machine. What the cells reach:

- **Rule 3 both ways.** 53,903 available cells read a restatement that a measured re-base
  explains — 51,527 in the restatement family, 2,376 in the first — and rule 3 alone withholds
  228,428 cells. The CI asserts both.
- **The rulings' paths, both ways.** In the restatement family rule 3 compares `R` with an anchor
  past a withheld or count-less revision on 65,037 available cells — 25,907 of them a restatement
  a re-base explains against the anchor, the rest agreeing with it (a restatement taken back,
  among them; §0, MAJOR-1) — and on 209,563 withheld ones; 6,805 more are withheld in the first
  family. Rule 2 withholds 15,371,440 cells before a walk's first level. The CI asserts each.
  (Before the rulings the same diagnostics counted the gaps: at least 52,191 cells read through a
  restated or count-less predecessor, and 716,639 on a walk's first count.)
- **Every rule alone.** Each reason in §15 is the sole reason for some cells, from
  1,121 (`INVALID_CLOSE`) to 4,365,040 (`SHARE_LEVEL_UNSAFE`).
- **Features** (histories carrying each, `generated.json` → `features`): for example
  `undated-measured` 1,357, `unexplained-bounded` 243, `forward-entry` 1,228,
  `revision-moved-period-end` 1,705, `shares-exact-boundary-down` 486; and in the second family
  `restatement:chain-no-count` 806, `restatement:count-less-predecessor` 495,
  `restatement:mismatched-rebase` 587, `restatement:measured-undated` 752,
  `restatement:late-revision-after-rebase` 1,265, `restatement:restatement-taken-back` 574 and
  `restatement:late-observed-amendment` 1,073.

## 12. Real data, full scale

### The development store

A copy of the development store, `intrinsic_value_valaudit` (`pnpm audit:valuation --
provision-copy` refuses the development, test and QA-matrix databases), with FMP's split lists as
read on 2026-10-01 frozen into it. Nothing in the source database was written. 62 securities with
statements and 363,293 stored sessions. What each layer covers is stated per layer, because it is
not the same:

| Layer                 | What it is                                                                                                              | Sessions it covers                | Comparisons | False available | False unavailable | Mismatch | Bit-identical to `pure` |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------- | --------------- | ----------------- | -------- | ----------------------- |
| `pure`                | `valuationRatioColumns` over the timeline the service prepares (the store's own read for the two unverified securities) | every stored session of all 62    | 1,816,465   | 0               | 0                 | 0        | —                       |
| `strategy-frame`      | `getDailyEvaluationFrame`, the Strategy frame                                                                           | the served range of 60 securities | 1,282,770   | 0               | 0                 | 0        | yes                     |
| `backtest-window`     | `readDailyEvaluationFrame`, one calendar year at a time, pinned to the prepared generation                              | the same                          | 1,282,770   | 0               | 0                 | 0        | yes                     |
| `monitor-closed`      | `readMonitorEvaluationFrame`'s closed sessions, up to 400 per security                                                  | the newest ≤ 400 of 60 securities | 102,045     | 0               | 0                 | 0        | yes                     |
| `monitor-provisional` | its provisional row, at a live quote 1 % above the newest close                                                         | one per security                  | 300         | 0               | 0                 | 0        | n/a                     |
| `stock-details`       | `getDailyValuationRatio`, one ratio at a time                                                                           | the served range of 60 securities | 1,282,770   | 0               | 0                 | 0        | yes                     |

- **The served range** is what is durably covered without the provider: the whole 30-year horizon
  where the stored coverage reaches the retention start or the listing date, otherwise from the
  first session whose warm-up it holds. 44 securities are served over their whole horizon; 16 whose
  stored coverage starts in 2021 (ABNB, AMD, AXON, CRWD, DDOG, FANG, FTNT, META, MPWR, MSTR, ODFL,
  PANW, PLTR, RIVN, ROP, UBER) from 2025-09-13 or 2025-12-07. In all the service layers cover
  256,554 of the 332,484 horizon sessions (77 %); the `pure` layer covers every stored session.
- **Refused:** GOOG and BRK-A have never been verified; a service read would verify them first,
  which reaches the provider, so the audit refused it. They are compared in the `pure` layer only,
  every session withheld by rule 0 on both sides. A refusal of any verified security fails the run,
  and so does a read that leaves out or adds a stored session (none did).
- **Rules exercised:** the real data reaches the inputs, rule 0, rule 2 and rule 4.1 only (§15).
  The rules it never reaches are run through every layer on generated stores below.
- **Divergences:** none.

### Generated stores, through every layer

`pnpm audit:valuation -- synthetic-store` writes generated histories of both families (§11) into
an empty, migrated throwaway database (`intrinsic_value_valaudit_synth`) as ordinary securities —
their statement rows with their availability and observation instants, closes, price basis and
events, split lists, every dataset synced — and runs the comparison above over them. Each history
is stored twice: whole, and truncated the session before a date it holds (an availability, an
event, a re-base's detection, an entry), so the Monitor's provisional observation lands on that
date and must read the statements of the session before it. Seeds 1-40, re-run on the rulings
(2026-10-06): 142 securities (71 truncated copies; 9 unverified histories are left to the `pure`
audit, since their first verification needs the provider), 97,418 stored sessions
(`evidence/synthetic-store.json`):

| Layer                 | Comparisons | Available match | Expected unavailable | False available | False unavailable | Mismatch | Bit-identical to `pure` |
| --------------------- | ----------- | --------------- | -------------------- | --------------- | ----------------- | -------- | ----------------------- |
| `pure`                | 487,090     | 156,552         | 330,538              | 0               | 0                 | 0        | —                       |
| `strategy-frame`      | 487,090     | 156,552         | 330,538              | 0               | 0                 | 0        | yes                     |
| `backtest-window`     | 487,090     | 156,552         | 330,538              | 0               | 0                 | 0        | yes                     |
| `monitor-closed`      | 254,710     | 110,548         | 144,162              | 0               | 0                 | 0        | yes                     |
| `monitor-provisional` | 710         | 359             | 351                  | 0               | 0                 | 0        | n/a                     |
| `stock-details`       | 487,090     | 156,552         | 330,538              | 0               | 0                 | 0        | yes                     |

2,203,780 cells in all. Every rule reaches every service layer here — among the cells the `pure`
layer withholds, by primary reason: `BASIS_WITHHELD` 20,089, `COUNT_PREDATES_HISTORICAL_ENTRY`
21,216, `EVENT_SETTLING` 9,006, `SHARE_RESTATEMENT_UNEXPLAINED` 1,795,
`POST_DISTRIBUTION_STATEMENTS_STALE` 1,706, `FORWARD_EVENT_UNMEASURED` 549, `CURRENCY_MISMATCH`
9,321, `HISTORICAL_DISTRIBUTION_ENTRY` 16,052, `SHARE_LEVEL_UNSAFE` 40,216 (`stock-details` carries
the same counts). No layer left out or added a session, none reached the provider, and no read of a
verified security was refused: the 8 refusals of the first run — the audit's own Monitor quote
rounded to 0 for four histories whose newest close is `0.00000001` — are gone with the quote that
keeps the stored precision (`32388357`).

## 13. Comparisons per ratio

| Ratio     | Generated      | Real `pure`   | Strategy frame | Backtest windows | Monitor closed | Monitor provisional | Stock Details service | HTTP          |
| --------- | -------------- | ------------- | -------------- | ---------------- | -------------- | ------------------- | --------------------- | ------------- |
| P/E       | 19,014,974     | 363,293       | 256,554        | 256,554          | 20,409         | 60                  | 256,554               | 256,554       |
| P/S       | 19,014,974     | 363,293       | 256,554        | 256,554          | 20,409         | 60                  | 256,554               | 256,554       |
| P/B       | 19,014,974     | 363,293       | 256,554        | 256,554          | 20,409         | 60                  | 256,554               | 256,554       |
| P/FCF     | 19,014,974     | 363,293       | 256,554        | 256,554          | 20,409         | 60                  | 256,554               | 256,554       |
| EV/EBITDA | 19,014,974     | 363,293       | 256,554        | 256,554          | 20,409         | 60                  | 256,554               | 256,554       |
| **all**   | **95,074,870** | **1,816,465** | **1,282,770**  | **1,282,770**    | **102,045**    | **300**             | **1,282,770**         | **1,282,770** |

Every one of these cells was classified; none was sampled. Across all of them: 0 false available, 0 false
unavailable, 0 value mismatches.

## 14. Available and unavailable counts

| Ratio     | Generated: available | Generated: withheld | Real `pure`: available | Real `pure`: withheld | Real service layers: available | Real service layers: withheld |
| --------- | -------------------- | ------------------- | ---------------------- | --------------------- | ------------------------------ | ----------------------------- |
| P/E       | 6,160,720            | 12,854,254          | 268,698                | 94,595                | 202,170                        | 54,384                        |
| P/S       | 7,107,055            | 11,907,919          | 297,832                | 65,461                | 216,006                        | 40,548                        |
| P/B       | 7,825,387            | 11,189,587          | 288,092                | 75,201                | 207,378                        | 49,176                        |
| P/FCF     | 6,040,075            | 12,974,899          | 257,245                | 106,048               | 194,662                        | 61,892                        |
| EV/EBITDA | 6,577,483            | 12,437,491          | 280,519                | 82,774                | 208,877                        | 47,677                        |

The counts are the oracle's; the product's equal them cell for cell. The generated histories are
adversarial by construction, so most of their cells are withheld (65 %), and 33.7 M are still
available and compared by value. In the real data 77 % of the `pure` cells are available; the
service layers serve fewer sessions (§12) and the same share. P/FCF is withheld most (negative free
cash flow is common), P/S least (revenue is never negative).

## 15. Unavailable reasons

The audit's reason model (oracle only; the product reports absence, never a reason):
`UNVERIFIED_PRICE_BASIS`, `INVALID_CLOSE`, `MISSING_SHARE_COUNT`, `NON_POSITIVE_SHARE_COUNT`,
`INCOMPLETE_WINDOW`, `MISSING_INPUT`, `CURRENCY_MISMATCH`, `NON_POSITIVE_DENOMINATOR`,
`SHARE_LEVEL_UNSAFE`, `SHARE_RESTATEMENT_UNEXPLAINED`, `HISTORICAL_DISTRIBUTION_ENTRY` (4.1),
`COUNT_PREDATES_HISTORICAL_ENTRY` (4.2), `EVENT_SETTLING` (5), `BASIS_WITHHELD` (6),
`POST_DISTRIBUTION_STATEMENTS_STALE` (7), `FORWARD_EVENT_UNMEASURED` (8) and
`UNREPRESENTABLE_RESULT`. The **primary** reason is the first failing rule in that order; a cell
also records every failing rule, and the **sole-rule** count is the cells withheld by one rule and
nothing else — what that rule alone decides, and so what a broken rule would turn into false
availability.

**Generated** (seeds 1–5000, both families, revision 3):

| Primary reason                       | P/E       | P/S       | P/B       | P/FCF     | EV/EBITDA | Sole rule, all ratios |
| ------------------------------------ | --------- | --------- | --------- | --------- | --------- | --------------------- |
| `UNVERIFIED_PRICE_BASIS`             | 2,078,936 | 2,078,936 | 2,078,936 | 2,078,936 | 2,078,936 | 3,226,154             |
| `INVALID_CLOSE`                      | 514       | 514       | 514       | 514       | 514       | 1,121                 |
| `MISSING_SHARE_COUNT`                | 1,455,604 | 1,455,604 | 1,455,604 | 1,455,604 | 1,455,604 | 285,553               |
| `NON_POSITIVE_SHARE_COUNT`           | 48,036    | 48,036    | 48,036    | 48,036    | 48,036    | 81,448                |
| `INCOMPLETE_WINDOW`                  | 3,900,498 | 3,900,498 | 11,024    | 3,911,370 | 3,900,498 | 3,935,639             |
| `MISSING_INPUT`                      | 371,894   | 371,888   | 121,243   | 727,206   | 476,533   | 954,686               |
| `CURRENCY_MISMATCH`                  | 496,225   | 496,055   | 551,854   | 556,968   | 603,132   | 1,105,243             |
| `NON_POSITIVE_DENOMINATOR`           | 1,806,266 | 0         | 964,331   | 1,563,878 | 804,754   | 2,632,555             |
| `SHARE_LEVEL_UNSAFE`                 | 776,529   | 1,054,545 | 3,203,842 | 772,060   | 897,142   | 4,365,040             |
| `SHARE_RESTATEMENT_UNEXPLAINED`      | 96,660    | 101,798   | 102,569   | 94,879    | 96,911    | 228,428               |
| `HISTORICAL_DISTRIBUTION_ENTRY`      | 412,736   | 596,515   | 704,030   | 410,342   | 500,299   | 583,740               |
| `COUNT_PREDATES_HISTORICAL_ENTRY`    | 270,140   | 326,913   | 399,046   | 261,441   | 287,362   | 1,421,614             |
| `EVENT_SETTLING`                     | 292,074   | 404,385   | 415,222   | 281,649   | 346,278   | 433,415               |
| `BASIS_WITHHELD`                     | 740,833   | 949,250   | 1,008,777 | 718,191   | 831,571   | 3,872,803             |
| `POST_DISTRIBUTION_STATEMENTS_STALE` | 65,135    | 85,262    | 86,114    | 64,758    | 77,140    | 376,679               |
| `FORWARD_EVENT_UNMEASURED`           | 31,400    | 37,720    | 38,445    | 28,501    | 32,781    | 168,847               |
| `UNREPRESENTABLE_RESULT`             | 10,774    | 0         | 0         | 566       | 0         | 11,340                |

**Real data** (`pure` layer, every stored session, revision 3):

| Primary reason                       | P/E    | P/S    | P/B    | P/FCF  | EV/EBITDA | Sole rule, all ratios |
| ------------------------------------ | ------ | ------ | ------ | ------ | --------- | --------------------- |
| `UNVERIFIED_PRICE_BASIS`             | 14,126 | 14,126 | 14,126 | 14,126 | 14,126    | 68,151                |
| `INVALID_CLOSE`                      | 0      | 0      | 0      | 0      | 0         | 0                     |
| `MISSING_SHARE_COUNT`                | 1,947  | 1,947  | 1,947  | 1,947  | 1,947     | 5                     |
| `NON_POSITIVE_SHARE_COUNT`           | 48     | 48     | 48     | 48     | 48        | 48                    |
| `INCOMPLETE_WINDOW`                  | 6,658  | 6,658  | 221    | 6,932  | 6,658     | 6,992                 |
| `MISSING_INPUT`                      | 0      | 0      | 0      | 0      | 0         | 0                     |
| `CURRENCY_MISMATCH`                  | 0      | 0      | 0      | 0      | 0         | 0                     |
| `NON_POSITIVE_DENOMINATOR`           | 33,387 | 0      | 12,284 | 44,715 | 18,822    | 97,967                |
| `SHARE_LEVEL_UNSAFE`                 | 3,614  | 4,809  | 8,715  | 2,600  | 4,336     | 21,976                |
| `SHARE_RESTATEMENT_UNEXPLAINED`      | 0      | 0      | 0      | 0      | 0         | 0                     |
| `HISTORICAL_DISTRIBUTION_ENTRY`      | 34,815 | 37,873 | 37,860 | 35,680 | 36,837    | 183,065               |
| `COUNT_PREDATES_HISTORICAL_ENTRY`    | 0      | 0      | 0      | 0      | 0         | 0                     |
| `EVENT_SETTLING`                     | 0      | 0      | 0      | 0      | 0         | 0                     |
| `BASIS_WITHHELD`                     | 0      | 0      | 0      | 0      | 0         | 0                     |
| `POST_DISTRIBUTION_STATEMENTS_STALE` | 0      | 0      | 0      | 0      | 0         | 0                     |
| `FORWARD_EVENT_UNMEASURED`           | 0      | 0      | 0      | 0      | 0         | 0                     |
| `UNREPRESENTABLE_RESULT`             | 0      | 0      | 0      | 0      | 0         | 0                     |

What they show:

- **No rule masks everything.** In the generated run every rule is the sole reason for a cell —
  from 1,121 (a non-positive close) to 4.4 M (the share level) — so breaking any one rule
  would turn its sole-rule cells into false availability, and the comparison would count them
  (§29 shows it does).
- **In the real data, four rules carry the masking:** the inputs (losses, negative cash flow,
  the first trailing year, missing counts), rule 0 (BRK-A and GOOG, never verified), rule 2 (42
  securities since the rulings) and rule 4.1 (the eight securities with a non-plain listed entry).
  The rest never apply (§10).
- **Primary reasons are not exclusive.** WDC's 1999–2000 negative equity, for instance, is the
  primary reason for 444 P/B sessions that rule 4.1 also withholds.

## 16. False available

**0** in every comparison: 95,074,870 generated cells, 1,816,465 real `pure` cells, every
service layer (§12), the generated stores (§12), the HTTP rows (§23) and the browser (§23). Every
mutation that makes the product show a reading the rules withhold — from a removed mask to an
inverted factor — is caught (§29). False availability the rules themselves allow is not
in these counts: G1–G3 (§31), on which the product and the oracle agree.

## 17. False unavailable

**0** in the same comparisons. The audit's first version of the oracle produced 6,664 in the real
data, all on statement revisions outside the fundamentals retention (§5, interpretation 3;
`evidence/retention-scope.json`); the comparison has read the retained revisions since, as the
product does. The product's own false unavailability, found before the fixes, was D1 (rule 5) and
D2 (§31).

## 18. Value mismatches

**0**: every available reading is within its error bound of the exact value.

## 19. Numeric differences

The bound (`valuation/compare.ts`) is 32 times the first-order rounding error of the product's own
operations — the conversions of the close, the count, net debt and each basis factor to doubles,
the multiplications of `K` and `MC`, the addition and the division —
`2^-48 · ((m + 6) · (|MC| + |addend|) / denominator + 2 · |value|)`, with `m` basis factors. Without
net cash that is `(m + 8) · 2^-48` of the value, under `1e-13`; only an enterprise value whose net
cash nearly cancels the market capitalisation has more, and how much is counted:

|                                              | Generated                     | Real (`pure`)                 |
| -------------------------------------------- | ----------------------------- | ----------------------------- |
| available cells compared                     | 33,710,720                    | 1,392,386                     |
| tolerance ≤ `1e-13` of the value             | 33,684,175                    | 1,392,386                     |
| tolerance in (`1e-13`, `1e-9`]               | 26,545                        | 0                             |
| tolerance above `1e-9`                       | 0                             | 0                             |
| largest share of its bound a difference used | 1.57 %                        | 1.10 %                        |
| maximum relative difference                  | 1.15e-12                      | 3.67e-16                      |
| maximum absolute difference                  | 0.000187                      | 7.05e-12                      |
| relative difference p50 / p95 / p99          | 6.05e-17 / 1.74e-16 / 2.3e-16 | 4.4e-17 / 1.38e-16 / 1.98e-16 |
| exactly the exact value                      | 713                           | 427                           |

(Percentiles are read from 1 %-wide logarithmic bins, reported at a bin's upper edge.)

- **What the differences are.** Storage and float quantisation only: the oracle reads every
  stored decimal exactly (statement values at their shortest decimal, the close as `DECIMAL(20,8)`
  text, a measured ratio as `DECIMAL(24,12)` text) and the product its doubles; the largest
  relative difference in the real data is 3.7e-16, under two units in the last place. The
  generated maximum, 1.15e-12, is a nearly cancelling enterprise value, inside its bound.
- **No error can hide in the bound.** A wrong field, window, count, close or factor moves a value by
  far more than `1e-13` of it; the 26,545 generated cells with a looser bound are nearly-cancelling
  enterprise values, still bounded by `1e-9` of the value.
- **Edges, by hand:** a denominator of `1.2e-10` making P/E exactly `10^12` (withheld) and one of
  `1.3e-10` just inside (C43, C43b); `1e10` shares (C43c); enterprise value exactly 0 (a reading of
  0, C06b) and −1e-8 (C06c); net cash above the market capitalisation (C06); a close of 0 and of −1
  (withheld, C43). Generated: tiny closes (825 histories), near-zero denominators (249), and
  `UNREPRESENTABLE_RESULT` alone in 11,762 cells.
- **Never 0, NaN or infinity on the wire.** A withheld reading is `NaN` in a frame and an omitted
  `value` in a response (§23); a zero denominator gives ±∞ or NaN, which the finiteness check
  withholds (M14 is equivalent for that reason); −0 cannot arise (M62).

## 20. Strategy parity

The Strategy evaluation frame (`getDailyEvaluationFrame`, the frame a backtest and a Strategy
Condition read through `valuationRatioOperand`) was compared with the oracle on every real
session the service serves: 1,282,770 cells, 0 false available, 0 false unavailable, 0 mismatches,
and bit for bit identical to the `pure` calculation on every cell (§12). A Condition on an
unavailable ratio is `NOT_EVALUABLE` and never matches: the reference backtester's predicates
(`oracle/predicates.ts`, written independently) treat an absent ratio that way, and the backtests
in §21 trade exactly where they predict; the strategy package's own predicate is mutated in §29
(M35, a Condition that reads an unavailable ratio as 0).

## 21. Backtests

The real `BacktestProcessor` (`apps/worker`), over one shared anchor security stored in
PostgreSQL (`packages/testing/src/valuation-audit.ts`): five years of sessions with a listed
131:125 distribution (rule 4.1 until 2021-08-11), a loss year (no P/E), net cash above the market
capitalisation (negative EV/EBITDA, 2023-11-13 to 2024-03-01), a measured 2:1 split on 2024-09-16
with the last eight quarters' counts restated four days later (`K` before it, rule 5 after it), a
one-quarter share artefact (rule 2, 2025-05-12 to 2025-08-08) and a listed upcoming 1:2 reverse
split after the verification (rule 8, then rule 5).

The expected trades are derived on the API side only, by the oracle and the audit's reference
backtester (`oracle/reference-backtester.ts`, `oracle/predicates.ts`, extended for valuation,
Fundamental Metric and Relative Volume operands), and written once as literals
(`VALUATION_AUDIT_EXPECTED_TRADES`). `valuation-backtest-reference.test.ts` holds the reference to
them (4 tests, two of them worked by hand); `backtest-valuation-audit.integration.test.ts` holds
the product to them (16 tests). Neither app imports the other.

| Strategy | What it exercises                                                      | Trades (oracle = product)  |
| -------- | ---------------------------------------------------------------------- | -------------------------- |
| V01      | P/E below 9 buys, above 12 exits (BUY and FINAL EXIT)                  | 7                          |
| V02      | P/S below 0.9 buys, above 1.2 exits                                    | 9                          |
| V03      | P/B below 0.55 buys, above 0.8 exits                                   | 10                         |
| V04      | P/FCF below 7 buys, above 10 exits                                     | 10                         |
| V05      | EV/EBITDA below 0 buys (net cash only), above 4 exits                  | 2 (2023-11-13, 2024-03-04) |
| V06      | P/E below 1,000,000: buys on the first available session               | 1 (2021-08-11)             |
| V07      | P/E below 10 AND P/B below 0.7                                         | 7                          |
| V08      | P/S below 1 AND Net Margin TTM above 5 % (valuation + Fundamental)     | 9                          |
| V09      | P/E below 11 AND close above SMA 50D (valuation + moving average)      | 7                          |
| V10      | P/B below 0.75 AND RVOL 20 above 2 (valuation + Relative Volume)       | 10                         |
| V11      | V01 inside a CUSTOM buy window 2023-01-01 to 2024-06-30                | 4                          |
| V12      | P/S below 0.95 buys 50 %, above 1.1 sells 50 % (SELL), above 1.3 exits | 5                          |

- **Trades on exactly the oracle's sessions:** 12 of 12 strategies, every trade's date, action
  and level.
- **An unavailable ratio never matches:** no trade of any strategy falls on a session where a
  valuation Condition's ratio is withheld (checked against the oracle's rows); V06, whose
  Condition is true whenever P/E exists, buys on 2021-08-11, the first session after the listed
  distribution's mask, and not before.
- **Deterministic:** a rerun reproduces every trade, every equity row and the summary.
- **Revision pinned:** a run records `valuationRatioRevision` 3, and a run queued under revision 2
  is refused with `ENGINE_VERSION_MISMATCH`.
- **Generation pinned:** when the price-basis generation moves after the run's first window read,
  the run fails (`EXECUTION_FAILED`, `PRICE_BASIS_CHANGED`, expected generation 1, actual 2)
  instead of mixing two bases.
- **No provider:** the fake provider records no call.

## 22. Monitors

- **Hand.** C42: the provisional row reads the newest closed session's statements at the live
  close, while every session rule (rules 0, 5, 6, 7 and 8) is read on the row's own date.
- **Generated.** Every session of every history is read a second time as a provisional row, with
  the previous session's statements: half of the 51.7 M comparisons.
- **Real data.** For every security the service serves, `readMonitorEvaluationFrame` with up to
  400 closed observations and a provisional observation at a quote 1 % above the newest close:
  102,045 closed cells and 300 provisional cells, 0 failed, the closed cells bit-identical to
  `pure`.
- **The real cycle** (`monitor-valuation-audit.integration.test.ts`, the worker's
  `MonitorCycle` over the anchor security):
  - a withheld ratio never opens a Signal, although 0 would match "P/E is below 9": the
    observation is not evaluable and nothing is written;
  - a Signal opens on 2024-03-14, the first session the oracle puts P/E below 9; a split-sized
    quote the next session is not evaluable and holds it; the measured split's date and a
    settling count (rules 6 and 5) are not evaluable and hold it; it resolves on 2024-11-19,
    the first available session above 9;
  - a provisional observation on 2024-11-11 reads 2024-11-08's statements (still withheld),
    never the statements public that day, and the next observation agrees with the backtest;
  - a valuation read whose price-basis generation moves during it returns no frame for the
    Monitor and refuses the backtest window and the Stock Details read
    (`PriceBasisChangedError`): never mixed data;
  - no provider call.

## 23. Stock Details

- **Service.** `getDailyValuationRatio`, one ratio per read, compared with the oracle on every
  session it serves: 1,282,770 cells, 0 failed, bit-identical to `pure` (§12).
- **HTTP.** `GET /stocks/:symbol/valuation-ratios/daily` on the hermetic API stack pointed at the
  copy (`TEST_DATABASE_URL=<copy> pnpm dev:api:e2e`: fixture provider, egress guard), all five
  ratios of every security over the range §12 served (`evidence/http.json`). Re-run on the
  rulings on 2026-10-06 with the API's clock pinned to the copy's day
  (`pinned-clock.cjs`, `VALUATION_AUDIT_NOW=2026-10-02T14:00:00Z`): 300 answers 200 and 10 answer
  503 — BRK-A and GOOG, never verified, whose first verification needs the provider; 1,282,770
  rows, every one valued as the oracle values it: 0 false available, 0 false unavailable, 0
  mismatches, maximum relative difference 3.7e-16; no response left out or added a stored session
  except CAVA's 2023-06-15, a day before its stored listing date, which every Stock Details read
  starts at and the command counts apart (`preListing`). The run fails on any other difference and
  on a refusal of a verified security; it passes. (The first run, on 2026-10-02, passed the same
  way. On 2026-10-03 the copy, frozen on 2026-10-02, was a day behind the API's wall clock: the API
  asked the fixture provider for the newest price tail and answered 503 for 52 securities. The
  pinned clock is what removes that.)
- **Browser.** `apps/web/e2e/audit/valuation-oracle.audit.spec.ts` (its own Playwright config,
  outside the regular suite), for HON, WDC, IBM, MMM, CRWD and FIG × all five ratios — chosen for
  HON's 2026-07-24 resumption, WDC's 2025-08-15 balance-sheet resumption, MMM's 2025 P/FCF gap,
  CRWD's 2026 P/E gap and FIG's first two quarters, withheld by the ruled rule 2, inside the page's
  window: the page's own response must hold every stored session with the oracle's value (or
  none) and leave out none between its first and last rows, and a pointer sweep across the chart
  must print, on every session it reaches, exactly the product's `formatMultiple` of the oracle's
  value, or `Unavailable`. **30 of 30 passed** on 2026-10-06 against the same copy, the page's
  clock pinned to the API's (the first run, 25 of 25 on 2026-10-02, predated the omission check).
- **The rest of the brief's Stock Details list** is the product's own suite from PR #80, which
  this audit ran (Appendix B) and did not rewrite: exactly five identities, malformed and repeated
  identities refused with 400 (`stocks.integration.test.ts`, `openapi.valuation-history.test.ts`);
  unavailable values omitted, never 0; dates exactly the stored sessions; a re-base between reads
  refused; a warm read without the provider; a day-old split list re-read
  (`valuation-history.integration.test.ts`); an ordinary line, not a step, broken at every gap;
  negative EV/EBITDA drawn; multiples printed raw; `Unavailable` in a gap and on a newest
  withheld session; loading, failure and retry distinct from unavailability; the all-unavailable
  state; incremental older history; the newest choice winning a race; pane order with volume,
  RSI and a Fundamental Metric; the phone layout (`StockPriceChart.test.tsx`,
  `valuation.user.spec.ts`).

## 24. Redis and PostgreSQL

`valuation/cache-parity.ts` (`evidence/cache-parity.json`): AAPL, AXP, DIS, GOOGL, HON, IBM, MMM,
MRK, MSFT and WDC, all five ratios each, read through the Stock Details service cold (an empty
namespace, hydrated from PostgreSQL), warm, after an explicit eviction of the security, after a
flush of the namespace, by three cold readers at once from separate service instances, and (AAPL)
after an LRU eviction by a cache that holds one security: 365 reads, one SHA-256 digest per
security across every state, 0 mismatches, 0 provider calls (the provider refused every request),
and no Redis key holding a valuation (`valuationKeys` empty: the key families are prices, daily
state, statements, manifests and the LRU bookkeeping).

This is layer parity only: it shows that Redis loss does not change an answer. That the answer is
right is §12's comparison of the same service with the oracle.

The ratios keep no Redis state of their own: they are projected from the statements, prices, split
list and price basis on every read. The price-basis work's Redis interaction is the projection of
the re-based prices: PR 1's end-to-end test (`price-basis.integration.test.ts`, "replaces a
re-based history, records the split, and refuses a read pinned to the old basis") reads the
re-based closes back through Redis after a replacement and refuses a window pinned to the old
generation.

## 25. Provider and egress

- **Comparisons.** Every oracle comparison reads stored rows. The real-data and cache-parity runs
  give the product a provider that refuses and records every call: the real-data run recorded 2
  (the first verifications GOOG and BRK-A would need, refused; §12), the cache-parity run 0.
- **Backtests and Monitors.** The worker audits' fake provider recorded no call.
- **HTTP and browser.** Run on the hermetic stack (`pnpm dev:fmp:e2e`, the egress guard). The
  fixture provider's journal for the HTTP run holds 10 requests — on 2026-10-02 and again on the
  rulings' re-run of 2026-10-06 — all `historical-price-eod/full` for BRK-A (5) and GOOG (5): their
  first verification, answered 404; nothing for the 60 verified securities. The egress guard
  (`.e2e-stack/egress.jsonl`) has blocked 6 connections since 2026-09-30, every one the web dev
  server reaching `registry.npmjs.org` — the sixth when the gate's Playwright stack started on
  2026-10-06 — none during the audit's re-run and none from the API or the worker.
- **No ratio endpoint, no per-session request.** The FMP client (`packages/fmp/src/client.ts`)
  has no ratio, key-metrics or enterprise-value endpoint at all: it reads `profile`,
  `company-screener`, `historical-price-eod/full`, `batch-quote`, `holidays-by-exchange`, `splits`,
  the three statements, `insider-trading/search` and the house and senate trades. The valuation
  inputs are statements, prices and the split list, read per security when a dataset is stale;
  nothing is requested per session or per ratio — the 365 warm, evicted and flushed reads of §24
  made no request, and neither did the backtests' and Monitors' day loops (§21, §22).
- **Fake-provider paths** for first verification, a stale split list, a failed split-list read, a
  re-base and a refused replacement are the product's own suites (`price-basis.integration.test.ts`,
  `valuation-history.integration.test.ts`, `stocks.integration.test.ts`), run in the gates; this
  audit added none.

## 26. Generation and re-base

- **Hand.** C38a and C38b: one store before and after a re-base measured on 2026-10-02 — the
  2024Q4 readings on each side. A reader that combined the two (a new close with an old `K`, or
  the reverse) would produce neither.
- **Reads.** Every valuation read brackets its inputs with the price-basis generation and
  refuses one that moved: the Monitor read returns no frame, the backtest window read and the
  Stock Details read throw `PriceBasisChangedError` (§22), and a backtest whose generation moves
  between its window reads fails rather than mixing bases (§21). The Stock Details route answers
  503 with no rows in that case (`stocks.integration.test.ts`).
- **Pin.** `BACKTEST_DATA_REVISIONS.valuationRatioRevision` is part of a run's engine stamp; a
  run queued under another revision is refused (§21). This audit moved `VALUATION_RATIO_REVISION`
  from 1 to 2 with D1 (§32), and the owner's rulings from 2 to 3 (§0).

## 27. Real events

Every interval below is the same in the oracle and in every product layer (§12); the dates are
from `evidence/real-data.json`.

| Security | Event (ex-date)                       | FMP entry                       | Withheld (all five ratios unless noted)                         | First available        |
| -------- | ------------------------------------- | ------------------------------- | --------------------------------------------------------------- | ---------------------- |
| WDC      | Sandisk (2025-02-24)                  | 1323:1000 `stock-split`         | to 2025-05-02 (P/E, P/S, P/FCF); to 2025-08-14 (P/B, EV/EBITDA) | 2025-05-05; 2025-08-15 |
| IBM      | Kyndryl (2021-11-04)                  | 523:500 `stock-split`           | 1996-10-02 to 2022-02-22                                        | 2022-02-23             |
| MRK      | Organon (2021-06-03)                  | 131:125 `stock-split`           | 1996-10-02 to 2021-08-09                                        | 2021-08-10             |
| AXP      | Ameriprise (2005-10-03)               | 10000:8753 `stock-split`        | 1996-10-02 to 2006-03-06                                        | 2006-03-07             |
| HON      | 2018 spin-offs; 2025 Solstice; 2026   | 1011:1000; 1907:2000 `spin-off` | 2001-02-21 to 2026-07-23 (the unlisted 2025 event lies inside)  | 2026-07-24             |
| DIS      | ABC Radio (2007-06-13)                | 2000:1973 `stock-split`         | 1996-10-02 to 2007-08-14                                        | 2007-08-15             |
| GOOGL    | class C (2014-04-03)                  | 999:500 `stock-split`           | to 2014-08-14                                                   | 2014-08-15             |
| **MMM**  | **Solventum (2024-04-01)**            | **none**                        | **nothing for the event — accepted limitation (§28)**           | —                      |
| AAPL     | 4:1 (2020-08-31), earlier 2:1 and 7:1 | plain                           | nothing for the splits (loss and negative-FCF years only)       | —                      |
| NVDA     | 10:1 (2024-06-10), 4:1, 3:2, 2:1      | plain                           | nothing for the splits                                          | —                      |
| AMZN     | 20:1 (2022-06-06), 1998–1999          | plain                           | nothing for the splits (1997–1998 share levels, losses)         | —                      |
| WMT      | 3:1 (2024-02-26), 2:1 (1999)          | plain                           | nothing for the splits                                          | —                      |
| CRWD     | 4:1 (2026-07-02)                      | plain                           | nothing for the split (losses: P/E 2025-03-11 to 2026-08-27)    | —                      |
| MSTR     | 1:10 reverse (2002-07-31)             | plain                           | nothing for the split (1999–2002 share levels)                  | —                      |

These match the decision's own table ("The six known securities") to the day. There is no
Strategy-only or Stock Details-only treatment of any security: every layer is bit-identical to
the one calculation on all 62 securities, and the product code names no security (the only
occurrences of `MMM` outside tests are the QA fixture lists in `packages/testing`).

## 28. MMM, the accepted limitation

**This is a known accepted limitation, not a correct reading.** FMP folded Solventum's
distribution (2024-04-01) into MMM's adjusted close and lists no entry for it; the product has
measured no re-base of MMM's stored history. The rules therefore cannot see it, by design
(`valuation-ratios-v1.md`, "Accepted V1 limitation").

What the audit confirms, exactly as documented:

- MMM's ratios before 2024-04-01 are available: 6,918 sessions in the audited horizon
  (1996-10-02 to 2024-03-28; the decision's 6,920 counts from 1996-09-30) for P/S, P/B and P/FCF,
  and 6,747 for P/E and EV/EBITDA (171 of those sessions are withheld for a negative trailing net
  income and EBITDA, 2023-07-26 onwards). Oracle and product agree on every one, because both
  read the same accepted rules; the agreement says nothing about the readings' accuracy, which the
  decision puts at about 16.4 % low.
- No mask hides it partly: MMM has no withheld session for any price-basis rule.
- No other known event escapes: of the events the decision and its investigation name (WDC, IBM,
  MRK, AXP, HON 2018/2025/2026, MMM), every one but MMM is masked (§27), and HON's unlisted 2025
  event lies inside the 2026 entry's mask. Among the 62 securities the audit found no other listed
  or measured event the rules leave unmasked. The audit has no independent source of unlisted
  events (the decision forbids adding one), so this is the limit of what it can show (§33).
- No special case: nothing in the product names MMM or any other security.

## 29. Mutations

Each mutant was applied in an isolated worktree of this branch (`git worktree`, its own
dependencies and builds, the main checkout untouched), the affected packages rebuilt, and two kinds
of suite run against it:

- **the audit's own:** the hand matrix and the generated differential (`A-api`), the worker's
  backtest and Monitor audits over the anchor (`A-worker`), and the real-data comparison on seven
  securities with real events — HON, IBM, WDC, MMM, MRK, AAPL, NVDA (`A-real`);
- **the product's pre-existing suites** for the same code (`P-*`: stock-data, worker, api, web,
  strategy, fmp, domain).

A suite counts as killing a mutant only when it failed on an assertion or a failed comparison: on
the loaded machine a few suites failed only by a timeout, a crash or a real-data refusal (lock and
statement timeouts), and those are not counted (the classifier and its verdicts are kept with the
runner). An unmutated baseline passed every suite before the first two passes; the later passes
ran on commits that only added hand cases, which pass unmutated (§6). Ninety mutants: the brief's
thirty-eight (several in more than one variant), the defect reverts, the reviewer's twenty
(M63–M82), and the discoveries in between.

| Id   | Mutant                                                                 | Killed by the audit     | Killed by the product's suites | Result   |
| ---- | ---------------------------------------------------------------------- | ----------------------- | ------------------------------ | -------- |
| M01  | P/E uses Revenue                                                       | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M02  | P/S uses Net Income                                                    | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M03  | P/B uses totalEquity                                                   | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M04  | P/FCF uses the provider's freeCashFlow                                 | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M05  | EV/EBITDA omits net debt                                               | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M06  | EV/EBITDA uses total debt instead of net debt                          | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M07  | basic shares instead of diluted                                        | A-api, A-real           | P-stockdata, P-api             | KILLED   |
| M08  | current quarter annualized instead of TTM (P/E)                        | A-api, A-worker, A-real | P-stockdata                    | KILLED   |
| M09  | EPS-based P/E                                                          | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M10  | statements read one day early                                          | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M10b | statements read one session early                                      | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M10c | the filing date read as the availability date                          | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M10d | the previous revision reused                                           | A-api, A-worker         | P-domain, P-stockdata          | KILLED   |
| M11  | an FY row fills a missing Q4                                           | A-api                   | —                              | KILLED   |
| M12  | falls back to an older complete TTM window                             | A-api                   | —                              | KILLED   |
| M13  | a later revision leaks backward                                        | A-api, A-worker         | —                              | KILLED   |
| M14  | a zero denominator accepted                                            | —                       | —                              | SURVIVED |
| M15  | a negative denominator accepted                                        | A-api, A-worker, A-real | P-stockdata                    | KILLED   |
| M16  | currency check removed                                                 | A-api                   | P-stockdata                    | KILLED   |
| M17  | a missing quarter ignored (four newest quarters)                       | A-api                   | —                              | KILLED   |
| M18  | share level tolerance 25 % -> 20 %                                     | A-api                   | P-stockdata                    | KILLED   |
| M19  | confirmations 3 -> 2                                                   | A-api                   | P-stockdata                    | KILLED   |
| M20  | non-consecutive quarters keep the agreement                            | A-api                   | P-stockdata                    | KILLED   |
| M21  | 2 % restatement threshold removed                                      | A-api                   | P-stockdata                    | KILLED   |
| M22  | an old re-base explains a new restatement (newness and month removed)  | A-api                   | P-stockdata                    | KILLED   |
| M23  | rule 3 timing window removed                                           | A-api                   | P-stockdata                    | KILLED   |
| M45  | any re-base ratio explains a restatement                               | A-api                   | P-stockdata                    | KILLED   |
| M49  | the level does not follow accepted counts                              | A-api, A-worker, A-real | P-stockdata                    | KILLED   |
| M24  | an unverified security allowed                                         | A-api                   | P-stockdata                    | KILLED   |
| M25  | historical distribution mask removed (rule 4.1)                        | A-api, A-real           | P-stockdata                    | KILLED   |
| M26  | a non-plain ratio labelled stock-split read as plain                   | A-api, A-real           | P-stockdata                    | KILLED   |
| M26b | the label ignored by the plain predicate                               | A-api                   | P-stockdata                    | KILLED   |
| M27  | forward-event hold removed (rule 8)                                    | A-api                   | P-stockdata                    | KILLED   |
| M28  | a withheld basis factor read as 1                                      | A-api, A-worker         | P-stockdata                    | KILLED   |
| M29  | distribution coverage removed (rule 7)                                 | A-api                   | P-stockdata                    | KILLED   |
| M30a | forward window off by one at the event date                            | A-api                   | P-stockdata                    | KILLED   |
| M30b | basis factor off by one at a dated event                               | A-api, A-worker         | P-stockdata                    | KILLED   |
| M42  | rule 4.2 removed                                                       | A-api                   | P-stockdata                    | KILLED   |
| M43  | rule 5 removed                                                         | A-api, A-worker         | P-stockdata                    | KILLED   |
| M51  | rule 4.1 covers the earliest entry, not the latest                     | A-api, A-real           | —                              | KILLED   |
| M52  | rule 8 holds 7 days, not 30                                            | A-api                   | P-stockdata                    | KILLED   |
| M53  | an entry matched by a re-base within 30 days, not 7                    | A-api                   | P-stockdata                    | KILLED   |
| M54  | rule 7 at an undated re-base's earliest date                           | A-api                   | P-stockdata                    | KILLED   |
| M55  | the basis factor inverted                                              | A-api, A-worker         | P-stockdata                    | KILLED   |
| M56  | a count observed between an event and its detection read as before it  | A-api                   | P-stockdata                    | KILLED   |
| M39  | revert D1: an undated re-base's exclusive start read as a possible day | A-api                   | P-stockdata                    | KILLED   |
| M40  | revert D2: rule 3's 2 % judged in doubles                              | A-api                   | P-stockdata                    | KILLED   |
| M41  | revert D3: rule 2's 25 % judged in doubles                             | A-api                   | P-stockdata                    | KILLED   |
| M47  | a non-positive close accepted                                          | A-api                   | —                              | KILLED   |
| M48  | representability bound removed                                         | A-api                   | —                              | KILLED   |
| M50  | P/B does not check the share count's currency                          | A-api                   | P-stockdata                    | KILLED   |
| M31  | unavailable -> zero                                                    | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M32  | unavailable -> the previous value carried                              | A-api, A-worker, A-real | P-stockdata                    | KILLED   |
| M33  | Stock Details line bridges a gap                                       | —                       | P-web                          | KILLED   |
| M33b | Stock Details draws a step instead of an ordinary line                 | —                       | P-web                          | KILLED   |
| M34  | Monitor treats not evaluable as matched                                | A-worker                | P-worker                       | KILLED   |
| M35  | a Condition matches an unavailable value (read as zero)                | A-worker                | P-strategy                     | KILLED   |
| M36a | generation check removed from the backtest window read                 | A-worker                | P-stockdata                    | KILLED   |
| M36b | generation bracket removed from the Monitor read                       | A-worker                | P-stockdata                    | KILLED   |
| M36c | generation check removed from the Stock Details read                   | A-worker                | P-stockdata, P-api             | KILLED   |
| M37  | valuationRatioRevision not pinned                                      | A-worker                | P-stockdata                    | KILLED   |
| M38a | P/B and P/FCF swapped in the calculation                               | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M38b | Stock Details answers the next ratio's column                          | A-real                  | P-stockdata, P-api             | KILLED   |
| M44  | the Monitor's provisional row reads its own date's statements          | A-worker                | P-stockdata                    | KILLED   |
| M46  | the split mapper drops an unreadable entry                             | —                       | P-fmp                          | KILLED   |
| M57  | every ratio unavailable                                                | A-api, A-worker, A-real | P-stockdata, P-api             | KILLED   |
| M58  | rule 3: a re-base detected after the count was observed explains it    | A-api                   | P-stockdata                    | KILLED   |
| M59  | rule 5 also withholds a quarter that ended after the event             | A-api                   | P-stockdata                    | KILLED   |
| M61  | a later period end outranks a later observation                        | A-api                   | —                              | KILLED   |
| M62  | negative zero not normalised                                           | —                       | —                              | SURVIVED |
| M63  | rule 3 never explains a restatement                                    | A-api                   | P-stockdata                    | KILLED   |
| M64  | unexplained changes ignored                                            | A-api                   | P-stockdata                    | KILLED   |
| M65  | a bounded unexplained change treated as unbounded                      | A-api                   | P-stockdata                    | KILLED   |
| M66  | undated: the last session before the interval read as inside it        | A-api                   | P-stockdata                    | KILLED   |
| M67  | undated: the interval's last session read as before its after-side     | A-api                   | P-stockdata                    | KILLED   |
| M68  | a measured ratio's plain tolerance 0.5 % -> 1 %                        | A-api                   | P-stockdata                    | KILLED   |
| M69  | rule 8 ends a day early                                                | A-api                   | P-stockdata                    | KILLED   |
| M70  | an entry on the verification day read as forward                       | A-api                   | P-stockdata                    | KILLED   |
| M71  | rule 4.2 on the entry's own date                                       | A-api                   | P-stockdata                    | KILLED   |
| M72  | rule 5's month one day longer                                          | A-api                   | —                              | KILLED   |
| M73  | P/B's coverage reads the Income end only (rules 4.1, 7)                | A-api, A-real           | —                              | KILLED   |
| M74  | P/FCF's coverage ignores the Cash Flow end                             | A-api                   | —                              | KILLED   |
| M75  | net debt scaled by the basis factor                                    | A-api                   | P-stockdata                    | KILLED   |
| M76  | the Strategy operand for P/B reads P/FCF                               | A-worker, A-real        | P-stockdata                    | KILLED   |
| M77  | IS_BELOW admits equality                                               | —                       | P-strategy                     | KILLED   |
| M78  | the HTTP answer sends an unavailable value as 0                        | —                       | P-api                          | KILLED   |
| M79  | the timeline read drops the measured re-bases                          | A-worker                | P-stockdata                    | KILLED   |
| M80  | the timeline read drops the split list                                 | A-worker, A-real        | P-stockdata                    | KILLED   |
| M81  | the timeline read starts its retention a year late                     | A-real                  | —                              | KILLED   |
| M82  | rule 2 agrees with the newest candidate, not the first                 | A-api, A-worker         | —                              | KILLED   |

**Result: 88 of 90 killed, 2 survivors, both equivalent.**

- **M14** (a zero denominator accepted): the value is then ±∞ or NaN, which the finiteness check
  withholds — the same reading.
- **M62** (−0 not normalised): the market capitalisation is positive, so a zero numerator is
  `x + (−x) = +0` and the denominator is positive; −0 cannot arise.
- **Killed by the audit's suites: 83; only by them: 13** — among them an FY row filling Q4 (M11),
  an older complete window (M12), a non-positive close (M47), the representability bound (M48),
  and the retention range of the timeline read (M81), none of which the product's own suites
  noticed.
- **Killed only by the product's suites: 5**, each outside what the per-mutant audit suites run:
  the chart's drawing (M33, M33b), the FMP split mapper (M46), `IS_BELOW` at exact equality, which
  no anchor reading hits (M77), and the HTTP mapping of an unavailable value (M78) — the audit's
  HTTP comparison would see that one as false availability, but it needs the API running and is not
  part of the per-mutant suites.
- **Found by the passes and pinned:** seven mutants first survived the audit's suites or were caught
  only by the product's — M45 (a re-base of another ratio), M41 (D3's revert), M61 (a later period
  end over a later observation), M59, M67, M70 and M71 (rule 5's quarter end, an undated interval's
  last session, an entry on the verification day, rule 4.2's day). Each now has a hand case (C25b,
  the non-integer walk, C18d, C39e, C40c, C31d, C39f) that kills it on an assertion.
- **By category:** formulas 10/10, point in time 8/8, input rules 6/7 (M14 equivalent), share rules
  11/11, corporate actions 29/29, defect reverts 3/3, integration 21/21, numeric 0/1 (M62
  equivalent).

### The rulings' pass (2026-10-06)

The same runner, in a worktree of `6ee55a7e`, against an unmutated baseline that passed every
suite: ten mutants of the ruled rules 2 and 3 (N01–N11; N09 was dropped as identical to N01) and
the thirteen earlier rule 2 and rule 3 mutants re-expressed on the ruled code. Kills were classified
as before; every one is an assertion or a failed comparison.

| Id  | Mutant                                                                                  | Killed by the audit     | Killed by the product's suites |
| --- | --------------------------------------------------------------------------------------- | ----------------------- | ------------------------------ |
| N01 | rule 3: any earlier counted revision anchors, accepted or not (G1 reverted)             | A-api                   | P-stockdata                    |
| N02 | rule 3: a count-less previous revision lets `R` pass (G2 reverted)                      | A-api                   | P-stockdata                    |
| N03 | rule 2: the walk's first count accepted unconfirmed (G3 reverted)                       | A-api, A-real           | P-stockdata                    |
| N04 | rule 2: the first level confirmed on its second quarter                                 | A-api, A-real           | P-stockdata                    |
| N05 | rule 3: an explained restatement never anchors                                          | A-api                   | —                              |
| N06 | rule 3: a revision with no anchor is withheld                                           | A-api, A-worker, A-real | P-stockdata                    |
| N07 | rule 3: the explanation timed from the previous revision, not the anchor                | A-api                   | P-stockdata                    |
| N08 | rule 3: the anchor is the earliest accepted revision, not the latest                    | A-api                   | —                              |
| N10 | rule 3 walks in the representing order, not the order of observation (MAJOR-2 reverted) | A-api                   | P-stockdata                    |
| N11 | rule 3 walks revisions not yet public on the statement date                             | A-api                   | —                              |
| M18 | share level tolerance 25 % → 20 %                                                       | A-api                   | P-stockdata                    |
| M19 | confirmations 3 → 2                                                                     | A-api, A-real           | P-stockdata                    |
| M20 | non-consecutive quarters keep the agreement                                             | A-api                   | P-stockdata                    |
| M21 | 2 % restatement threshold removed                                                       | A-api                   | P-stockdata                    |
| M22 | an old re-base explains a new restatement (newness and month removed)                   | A-api                   | P-stockdata                    |
| M23 | rule 3 timing window removed                                                            | A-api                   | P-stockdata                    |
| M45 | any re-base ratio explains a restatement                                                | A-api                   | P-stockdata                    |
| M49 | the level does not follow accepted counts                                               | A-api, A-worker, A-real | P-stockdata                    |
| M40 | revert D2: rule 3's 2 % judged in doubles                                               | A-api                   | P-stockdata                    |
| M41 | revert D3: rule 2's 25 % judged in doubles                                              | A-api                   | P-stockdata                    |
| M58 | rule 3: a re-base detected after the count was observed explains it                     | A-api                   | P-stockdata                    |
| M63 | rule 3 never explains a restatement                                                     | A-api                   | P-stockdata                    |
| M82 | rule 2 agrees with the newest candidate, not the first                                  | A-api                   | —                              |

**Result: 23 of 23 killed**, all by the audit's suites, 4 by nothing else (N05, N08, N11, M82).
N07 survived the first run of this pass, on `ec67731f` — the second review's MINOR-4 — and is
killed since G1f and its product test. N10 and N11 are killed by their hand cases (G1e, G1g) and by
the generated comparison, which reaches them through the late-observed amendments; N05 and N08 by
the generated comparison alone.

## 30. Clean-room review

A fresh reviewer — an agent that did not write the oracle — was given the decisions, the product
code, the audit's code and evidence and the brief's questions A–S, read-only. It re-derived about
thirty hand literals, re-ran the pure suites and ran 2,000 fresh seeds (5001–7000: 20,689,440 cells,
0 failed), and wrote throwaway probes. Its answers, and what changed because of them:

| Q                                                 | Reviewer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Disposition                                                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Is the oracle independent?                     | **Partly.** Independent in code (no import, its own exact arithmetic and day model, its own decomposition of rules 2, 5, 6 and 7); not in three readings, which it resolves as the product does: a walk's first count is accepted; rule 3 compares only the immediately previous revision; rule 3 is skipped when that revision has no count. Two numeric conventions are the product's: a provider number valued at its shortest round-trip decimal, and a result beyond the largest double withheld. | The three readings are G1–G3 (§31), reported as methodology gaps. The conventions are recorded (§5, interpretation 4).                                                |
| B. Did a production helper leak in?               | **No** — imports, code shapes and constants checked; the adapter converts types only.                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                     |
| C. Are expectations hand-derived?                 | **Yes** for the hand matrix. Not for the backtest literals (oracle and reference backtester; V05 and V06 by hand) or the Monitor test's table. The product's walk test ignored count-less quarters.                                                                                                                                                                                                                                                                                                    | The walk test now requires a count-less quarter to have no reading.                                                                                                   |
| D. Are false unavailables detectable?             | **Partly.** Every comparison classifies them, but the Stock Details service layer and the browser spec iterated only the rows the product returned, so an omitted session was invisible.                                                                                                                                                                                                                                                                                                               | Every service layer's sessions are now checked against the stored sessions of its range (a mismatch fails the run), and the browser spec fails on an omitted session. |
| E. Could a broad mask look green?                 | **No** overall (21 % of generated and 77 % of real cells are available; every rule has sole-rule cells). But real data, HTTP and the service layers exercise only rules 0, 1, 2 and 4.1.                                                                                                                                                                                                                                                                                                               | The synthetic store (§12) puts every rule through every service layer.                                                                                                |
| F. PIT boundaries independent?                    | **Yes.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                     |
| G. Corporate-action boundaries independent?       | **Yes, with gaps:** open-ended undated intervals (allowed by the schema comment, never written; the product and the oracle read them differently), an entry on the verification day, rule 5's day 30.                                                                                                                                                                                                                                                                                                  | Gaps recorded (§33); mutants M70 and M72 hold the two boundaries.                                                                                                     |
| H. Share rules reimplemented?                     | **Structurally yes; not on the readings that matter.**                                                                                                                                                                                                                                                                                                                                                                                                                                                 | G1–G3 (§31).                                                                                                                                                          |
| I. All five formulas derived?                     | **Yes.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                     |
| J. Monitor validated separately?                  | **Partly:** the generated provisional mode tests the statement-date plumbing; real data had 60 provisional observations, all decided by the inputs.                                                                                                                                                                                                                                                                                                                                                    | The synthetic store adds a truncated copy of each history whose provisional observation lands on an availability, event or restatement day.                           |
| K. Stock Details against the oracle?              | **Yes** (service, HTTP, browser), over a narrowed range.                                                                                                                                                                                                                                                                                                                                                                                                                                               | Scope stated (§12).                                                                                                                                                   |
| L. Redis parity only parity?                      | **Yes**, and said so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                     |
| M. Accepted limitation called correct?            | **Partly:** MMM's sessions count as matches in the evidence; the disclosure was only in the draft.                                                                                                                                                                                                                                                                                                                                                                                                     | §28 lands with the evidence; G1–G3 are reported as gaps, not matches.                                                                                                 |
| N. No provider in the inner loop?                 | **Yes.** The pass criteria ignored refusals.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A refusal now fails a run unless the security was never verified (rule 0).                                                                                            |
| O. Generated histories adversarial enough?        | **Partly:** restatements one quarter at a time, no revision chains; rule 3's explained path decided 382 sessions in 3 of 5,000 histories, none in the CI's 150 seeds.                                                                                                                                                                                                                                                                                                                                  | A second family (§11): whole-history restatements, chains, count-less predecessors; the CI runs both families and asserts both paths of rule 3.                       |
| P. Are survivors explained?                       | Catalog meaningful; twenty more mutants proposed.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | All twenty added (M63–M82) and run (§29).                                                                                                                             |
| Q. Could tests pass with every ratio unavailable? | **No.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Mutant M57 confirms.                                                                                                                                                  |
| R. …with one ratio mapped to another?             | **Partly:** a calculation swap is caught everywhere; a service swap only by the real-data and HTTP runs; a label-to-identity swap only by the product's own tests.                                                                                                                                                                                                                                                                                                                                     | Mutants M38a, M38b and M76 (§29).                                                                                                                                     |
| S. Could the tolerance hide an error?             | **No.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Tolerance buckets reported (§19).                                                                                                                                     |

Its findings:

- **BLOCKER 1 — rule 3 can be bypassed, and the oracle shares the bypass.** Reproduced
  independently (a probe, then hand cases G1a, G1b and G2): G1/G2 in §31. **Not fixed: a
  methodology gap, the owner's decision.** It blocks closing V1.
- **MAJOR 1 — rule 2 accepts every walk's first count, and the listing-date retention makes that
  the listing quarter.** Reproduced (hand case G3) and found in the store: G3 in §31. **Not fixed:
  a methodology gap, the owner's decision.** It blocks closing V1.
- **MAJOR 2 — the generator cannot exercise rule 3 where it matters.** Fixed: the second family
  (§11).
- **MAJOR 3 — real-data and consumer claims broader than the evidence.** Fixed in the code, and
  the evidence regenerated under it, with two stated exceptions: the scope is stated per layer
  (§12); the synthetic store runs every service layer over the rules the store never exercises;
  a session left out or added, a refusal of a verified security and a bit disagreement now fail
  the real-data, synthetic and HTTP runs. The real-data run was regenerated under the final code
  (three securities re-run alone after lock timeouts, §12). The HTTP and browser runs were then
  the 2026-10-02 ones, which could not be repeated against the frozen copy a day later, and of the
  four generated-store seeds the audit's own quote failed only seed 12 was re-run. Both exceptions
  are gone since 2026-10-06: the HTTP and browser runs were repeated with the clock pinned to the
  copy's day, and the whole generated store with the fixed quote (§0, §12, §23). The reviewer's
  follow-up agreed the method holds and that this closes MAJOR 3 once the evidence is committed.
- **MAJOR 4 — the evidence package was incomplete.** Fixed by `cfe3305a`: this report, with the
  MMM disclosure, the interpretation log and the per-layer scope, and the evidence —
  `retention-scope.json` (including the 124 first-run cells the review asked about),
  `synthetic-store.json` and its seed-12 re-run, the regenerated `generated.json` and
  `real-data.json` with the re-runs of GS, JPM and TRV.
- **Minors.** Open-ended undated intervals (recorded, §33); interpretation 1 to be ratified in
  the decision (§35); the worker audits and the browser spec skip without Redis or their
  expectations file, so the gate run is checked for them (Appendix B); thin Monitor provisional
  evidence (the synthetic store's truncated copies); the borrowed numeric conventions (§5); the
  counter `exactBitMatches` renamed `exactValueMatches`; an unexplained change unbounded below
  withholds nothing for revisions observed after its detection, though it may hide a folded
  distribution (a note for the owner, §35); the provider-entry predicate's `1e-12` slack (§31).

### The second clean-room review (2026-10-06)

After the owner's rulings, a second fresh reviewer — not the engineer who changed the product, nor
the one who changed the oracle — reviewed the rulings' implementation read-only, against the
decision text, with its own probes, a fuzzer of revision chains (two runs of 3,000 cases, 4.26 M
cells each, closed and provisional rows) and fresh seeds (5001–5300 and 9001–9300: 11.4 M cells,
0 failed). Its findings and what became of them:

| Finding                                                                                                                                                      | Severity | Disposition                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------- |
| MAJOR-1: a count in the old units observed after an event's month, a taken-back restatement among them, reads off by the event's ratio (new with the ruling) | Major    | open: a methodology question for the owner, recorded in the decision ("What rule 3 cannot tell apart"), §0, §31 |
| MAJOR-2: rule 3 ordered by availability let a late-observed amendment anchor a restatement observed before it                                                | Major    | fixed: the order of observation (`154235eb`, `a0628b8e`); hand cases G1e–G1h; the reviewer confirmed it closed  |
| MAJOR-3: a count first observed already restated ahead of the ex-date passes rule 3 with no anchor (older than the ruling)                                   | Major    | open: a methodology question for the owner, recorded in the decision                                            |
| MINOR-4: no test told "new to the anchor" from "new to the previous revision"                                                                                | Minor    | fixed: G1f and a product test; the mutant is killed (§29)                                                       |
| MINOR-5: the undated-interval comments named one of three interval ends the writer persists                                                                  | Minor    | fixed in `schema.prisma`, `price-basis.ts` and the price-basis decision                                         |
| The CI evidence for rule 3's anchor was only taken-back restatements; no generated history held a late-observed amendment                                    | Minor    | fixed: the explained path is counted and asserted on its own (270 cells in CI); amendments are generated        |
| Wording: rule 3's timing clauses, "observed after" against an inclusive detection, the statement date, "Measured coverage" predating revision 3              | Nit      | fixed                                                                                                           |

In its follow-up the reviewer held **no BLOCKER or MAJOR against the product's implementation of
the rulings, the oracle or the hand cases** — product and oracle agree on every input it could
build, and it re-derived every new hand case — and kept MAJOR-1 and MAJOR-3 as methodology
questions: "the decision should not be marked Accepted while these are open, unless the owner
explicitly accepts them as V1 limitations, as was done for MMM."

## 31. Defects found

### Implementation defects

Three, all in the one calculation, so all four consumers had them; each was reproduced by the
oracle comparison and again by a hand-written regression test before it was fixed. None changes a
reading in the development store.

| Id  | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Class                                                           | Severity                               | Evidence before the fix                                                                                                      | In the store                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| D1  | An undated re-base's interval `(effectiveFrom, effectiveTo]` was read as starting on `effectiveFrom`, the last session certainly **before** the event (`historical-price-basis-v1.md` §8, as `basisFactorAt` already read it). Rules 4 and 8 then matched a provider entry to a re-base whose every possible day is eight or more days away, dropping the entry's history mask or forward hold; rule 5 settled a count observed on `effectiveFrom` as if after the event. | false available (rules 4.1, 4.2, 8); false unavailable (rule 5) | major: false availability              | 2,000 generated histories: 22,664 false-available and 1,735 false-unavailable cells, all this one cause                      | none: the copy holds no measured re-base                                       |
| D2  | Rule 3's 2 % was judged on doubles: `abs(shares / previous − 1) > 0.02`. A restatement of exactly +2 % — 10 to 10.2, or the integers 1,000,000,000 to 1,020,000,000 — computes to 0.020000000000000018 and was treated as more than 2 % (and the explanation's 2 % likewise).                                                                                                                                                                                             | false unavailable                                               | minor: conservative                    | the hand thresholds (10 → 10.2); 2,000 histories: 11,995 false-unavailable cells                                             | none: no stored revision changes a count                                       |
| D3  | Rule 2's 25 % was judged on doubles: `abs(count / level − 1) <= 0.25`. For non-integer counts an exact 25 % move can compute outside the band (1.1 to 0.825 gives 0.2500000000000001), withholding a count the rule accepts, moving the level differently and so, later, accepting a count the rule withholds.                                                                                                                                                            | false unavailable, then false available                         | minor: unreachable with integer counts | a product regression test at 1.1 → 0.825; no generated failure (the generator's counts at exactly 25 % are exact in doubles) | none: all 6,403 stored counts are integers, for which the double test is exact |

### Methodology gaps (ruled by the owner on 2026-10-06, §0)

The clean-room review showed that the accepted rules, read as written, make three shapes of
reading available that are wrong by the very share basis the rules protect. The product and the
oracle agree on all three — both implement the rules as written — so no comparison above could
see them. They were reproduced as hand cases pinning the reading before the ruling (`G1a`, `G1b`, `G2`, `G3` in
`valuation-ratios.hand-matrix.ts`), the oracle flags their cells as diagnostics, and §35 lists the
owner's options. They are not implementation defects: fixing them changes rule 2 or rule 3. **The
owner ruled on all three on 2026-10-06 (§0)**: rule 3's anchor closes G1 and G2, rule 2's first
level closes G3; the hand cases now hold the ruled readings, and the 408 readings below are
withheld.

| Id  | Shape                                                                                                                                                                                                                                                                                                                                                                                        | Hand case                                                                | What the rules show                                                                                    | A coherent basis gives | Reach                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | The provider restates every count by a split's ratio ahead of the ex-date (rule 3 withholds that revision, unexplained), then revises the newest quarter again — another field, the same restated count. Rule 3 compares the new revision only with the previous one: no change, so it passes; rule 2's level is the restated one. The count is in the new units against an old-basis close. | G1a (live), G1b (after the re-base is measured: `K` keeps it in history) | P/E 24/5 and every ratio doubled, on 2025-09-10 to 2025-09-30; after measurement the same, permanently | P/E 12/5               | none in the store (no stored revision changes a count); generated: §11 (`restatedPredecessorGapCells`)                                                                                                                                                                                                          |
| G2  | The same with a count-less revision before the restatement: rule 3 compares nothing and passes.                                                                                                                                                                                                                                                                                              | G2                                                                       | P/E 24/5                                                                                               | P/E 12/5               | as G1                                                                                                                                                                                                                                                                                                           |
| G3  | Rule 2 accepts the first count of a walk unconfirmed, and the listing-date retention starts every recent listing's walk at its listing quarter, whose weighted-average count is lower than the shares outstanding after it.                                                                                                                                                                  | G3                                                                       | P/B 9/25 on the first quarter's sessions; the next two quarters' correct counts withheld               | P/B 3/5                | **in the store:** 408 P/B readings in 7 securities (AMZN 1997, CAVA 2023, CRCL 2025, META 2012, PLTR 2020, RIVN 2022, UBER 2019), each on a listing-quarter count that the next quarter exceeds by 27–118 %, so the readings are 21–54 % low against it (`evidence/retention-scope.json`, `firstCountExposure`) |

G3 is also what the first real-data run's 124 false-available cells were (CAVA 59, CRCL 65): read
with every stored row, the pre-listing quarters make the listing quarter a level change and rule 2
withholds it; read with the retained rows, it is the walk's first count and is accepted. They were
dismissed then as the retention policy; they are the same gap. In all, retention makes 1,409 cells
available that every stored row would withhold, all by rule 2 (`retention-scope.json`). The two
sets overlap on only 213 cells (CAVA, CRCL, RIVN and UBER): the other 195 of G3's 408 (AMZN, META,
PLTR) have no pre-listing quarters stored at all, so keeping pre-listing quarters in the walk would
not close G3 — only confirming the first count would (§35). Since the ruling, retention makes no
cell available that every stored row would withhold (`retention-scope.json`: 0, and 0 of the 408).

### Shapes the second clean-room review found (2026-10-06)

| Id      | Shape                                                                                                                                                                                                                              | Status                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| MAJOR-2 | Rule 3 ordered by availability: a late-observed amendment, dated from an earlier filing and explained by a re-base detected before it was observed, anchored a restatement observed before the detection, read at `K = 2` (P/E ×2) | **Fixed** (`154235eb`, `a0628b8e`): rule 3 walks in the order of observation; hand cases G1e–G1h    |
| MAJOR-1 | A count still in the old units observed after an event's month — the provider never restating it, or taking back a restatement it published ahead of the ex-date — agrees with its anchor and reads off by the event's ratio       | **Open, the owner's**: a methodology question (O-2 beyond rule 5's month); recorded in the decision |
| MAJOR-3 | A count first observed already restated ahead of the ex-date has no anchor and passes rule 3; rule 2 sees no step                                                                                                                  | **Open, the owner's**: a methodology question older than the rulings; recorded in the decision      |

Both open shapes reproduce, in the product and the oracle alike: MAJOR-1 reads P/E 1.5 against a
coherent 3 (a 2:1 split, the restatement taken back after it); MAJOR-3 reads P/E 6 against a
coherent 3 before the event. Neither occurs in the store, which holds no measured re-base and no
count observed in the month before a listed event. §0 lists the owner's options.

### Not defects, after reproduction

- **Pre-listing rows outside retention** (interpretation 3, §5): the product reads only retained
  revisions, as its decision says.
- **CAVA's first stored session (2023-06-15)** lies a day before its stored listing date
  (2023-06-16), and every Stock Details read starts at the listing date
  (`complete-price-coverage.md`, `LISTING`), so the HTTP answer omits it, as the price series does.
  The oracle withholds every ratio there anyway. Counted apart in `evidence/http.json`
  (`preListing`).
- **The plain-share predicate's `1e-12` slack** on a provider entry (`isPlainShareRatio(…, 0)`)
  cannot admit a non-plain integer ratio below `10^12`; and a currency of only spaces is treated as
  missing (stricter than the decision, unreachable in stored rows).
- **A zero denominator `>= 0` mutation is equivalent** (§29): the finiteness check withholds the
  infinite result.

## 32. Fixes

| Commit     | Fix                                                                                                                                                                                                                                  | Regression test (fails on `main`)                                                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `02bd1643` | `possibleDays(event)`: an undated re-base lies on `(effectiveFrom, effectiveTo]`; rules 4, 5 and 8 read it through that one helper                                                                                                   | `valuation-ratios.test.ts`: "matches an undated re-base to an entry by the days it may lie on, never its interval's exclusive start", "rule 5: a count observed on an undated re-base's exclusive start was observed before it" |
| `2cafa3af` | `exactlyWithinFraction(value, reference, tolerance)` (`exact-decimal-sum.ts`): `abs(value − Π reference) <= tolerance · abs(Π reference)` exactly, on the figures' shortest decimal forms; rule 3's threshold and explanation use it | "is a restatement only beyond 2 %, judged on the reported figures, not their doubles"; `exact-decimal-sum.test.ts`                                                                                                              |
| `98048609` | rule 2's band uses `exactlyWithinFraction`                                                                                                                                                                                           | "rule 2: judges the 25 % band on the reported counts, not their doubles"                                                                                                                                                        |

- **`VALUATION_RATIO_REVISION` 1 → 2** (with D1; its note names all three). A backtest queued
  under revision 1 is refused rather than run under a different reading (§21). No stored data
  depends on it: ratios are computed when read.
- **The owner's rulings (2026-10-06), `VALUATION_RATIO_REVISION` 2 → 3:**

  | Commit     | Change                                                                                                                                              | Regression test (fails on `65a05594`)                                                                                                                                          |
  | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
  | `bc969288` | rule 3 compares `R` with its anchor, the latest earlier revision rule 3 accepted with a usable count (`passesRestatementRule`, `acceptedAgainst`)   | "keeps a restatement withheld through a later revision repeating it…", "compares a restatement after a revision with no count…", "reads a restatement the provider took back…" |
  | `6c056d57` | rule 2 confirms the walk's first count like any new level (`holdsShareLevel`); the QA valuation fixture's P/B starts on its third quarter (week 32) | "rule 2: confirms the walk's first count like any new level"; the QA seed's per-session check                                                                                  |
  | `154235eb` | rule 3 walks in the order of observation among revisions public on the statement date (`observedBefore`) — the second review's MAJOR-2              | "never takes as its anchor a revision observed after it…" (fails on `ec67731f` too); "judges a re-base new to the anchor…" pins MINOR-4                                        |

  Six of the 46 product tests fail on the previous head; every one passes on this branch.

- **No schema change, no migration, no new endpoint.** D1–D3 make the product do what the
  decision already said; the rulings change the methodology as the owner decided, and the schema
  comment on undated events now says what the writer persists.
- **Affected historical rows.** The ratios are not stored. D1–D3 change no reading of the
  development store (it holds no measured re-base, no restated count and only integer counts).
  The rulings change 3,789 readings in 3,441 sessions of 29 securities, every one from available to
  withheld, all through rule 2's first level (§0).

## 33. Residual limitations

What this audit cannot show, or chose not to:

- **Events FMP does not report** (MMM, §28): accepted for V1; the audit has no independent source
  of such events by design.
- **Rules the real data never exercises** — 3, 4.2, 5, 6, 7, 8 and the currency rule — are proven
  on generated and hand-written histories only (§10, §15).
- **PR 1's measurement** of re-bases is taken as input, not audited (§1).
- **A shared misreading** of the decision by the oracle and the product would be invisible to
  every comparison. The hand matrix, written before any comparison, and the clean-room review are
  the defences; interpretation 1 (§5) is the one reading made after seeing the product's code.
- **The second restatement by the same ratio** within one quarter is explained by the first
  re-base: a limit the decision states ("What rule 3 cannot tell apart").
- **Two shapes open for the owner** (the second review's MAJOR-1 and MAJOR-3, §31): a count still
  in the old units observed after an event's month, and a count first observed already restated
  ahead of the ex-date. Both are recorded in the decision; neither occurs in the store.
- **Numeric:** the comparison's bound is analytic (§19); in the few cells whose enterprise value
  nearly cancels, a logic error smaller than the bound would pass, and the bound there is up to
  `1e-9` of the value.
- **Browser parity** covers 5 securities × 5 ratios over the page's loaded window; the HTTP and
  service comparisons cover every session.
- **Restatement lag** after a re-base (open measurement O-2) is unmeasured; rule 5's month is the
  accepted guard.

## 34. Performance

**The product.** The fixes add exact comparisons to rules 2 and 3 (`exactlyWithinFraction`, on
each count's shortest decimal form). Measured over the whole store copy — `buildValuationTimeline`
for all 62 securities (22,720 retained statement revisions), then `valuationRatioColumns` over all
363,293 stored sessions and five ratios — median of seven runs, back to back on the same (heavily
loaded) machine:

|                                      | `main` (`d3a06e88`) | this branch |
| ------------------------------------ | ------------------- | ----------- |
| timelines, all 62 securities         | 712 ms              | 1,067 ms    |
| columns, every session × five ratios | 107 ms              | 122 ms      |

About 6 ms more per security per timeline, built once per backtest preparation, Stock Details read
or Monitor frame; the per-session columns did not change. Nothing else in the product changed. The
rulings' rule 3 walk adds no measurable cost: timed the same way on 2026-10-06, interleaved, with
the machine busy with the audit's other runs, the timelines took 1,971–2,299 ms at `65a05594` and
2,036–2,374 ms with the rulings; the columns 226–227 and 229–283 ms.

**The audit.** On a machine loaded far beyond its memory for most of the run (load average 6–12,
swap nearly full, other software holding the CPU):

- the 5,000-seed generated run, both families: 30 minutes (95 M cells);
- the full real-data run: 56 minutes on the final run, 3 minutes on an idle machine earlier the
  same day (1.8 M pure and 3.95 M service-layer cells); three securities' service layers were refused
  on the final run by Redis lock timeouts (a lock quorum not reached, a lock expiring during a slow
  hydration) and were re-run alone with 0 failed (`real-data-retried-*.json`); the audit's own
  service now holds its locks for up to fifteen minutes;
- the generated stores: about 25 seconds per security when the machine was quieter;
- the mutation passes: about 2 minutes per mutant at first and up to 15 minutes later on the same
  machine; suites that failed only by a timeout there are not counted as kills (§29).

## 35. Recommendation

**Do not close Valuation Ratios V1 yet, and do not mark its decision Accepted yet.** The owner's
rulings on G1–G3 are implemented on both sides and hold everywhere the comparisons reach (§0): 0
false available, 0 false unavailable, 0 value mismatches, every mutant of the rulings killed. What
remains is the owner's again: the second clean-room review found two shapes the rules, as ruled,
still read wrong (§31), and its acceptance bar — no BLOCKER or MAJOR — is not met while they are
open.

1. **MAJOR-1, a count in the old units observed after an event's month.** Options:
   - (a) make rule 6's assumption a check: a revision of a quarter that ended before an event,
     observed after its detection (or after a listed entry's date), whose anchor was observed before
     the event, must be explained by the event's ratio — agreeing with the anchor is no longer
     enough. It withholds the never-restated count and the taken-back restatement alike, until a
     quarter that ended after the event is the latest;
   - (b) withhold only a revision whose step back from a withheld restatement is the inverse of a
     known event's ratio (the taken-back restatement, nothing more);
   - (c) accept and document it as a V1 limitation tied to open measurement O-2, as MMM is.
2. **MAJOR-3, a count first observed already restated ahead of the ex-date.** Options:
   - (a) mirror rule 5 before the event: a count first observed in the 30 days before a listed or
     measured event, for a quarter that ended before it, is withheld on the sessions before the
     event;
   - (b) accept and document it as a V1 limitation (a first load, or a quarter first observed,
     while the provider has pre-restated the history).
3. **Confirm the reading of "earlier"** in the ruled rule 3: the order of observation, among the
   revisions public on the statement date (§5, interpretation 5).

Neither open shape occurs in the store today: it holds no measured re-base, and no count was first
observed in the month before a listed event. Options 1(a) and 2(a) are therefore expected to change
no stored reading, and 1(c) and 2(b) none by definition. After the rulings, implement them in the
calculation and the oracle independently, add their hand cases, re-run `pnpm audit:valuation`
(generated, real, synthetic-store, http) and the mutation pass, and have the clean-room reviewer
confirm no BLOCKER or MAJOR remains; then mark `valuation-ratios-v1.md` Accepted with this report
and PR #81 as its evidence.

The earlier recommendations are done: the owner ruled on G1–G3 (rule 3's anchor, option (a); rule
2's first level, option (a)), ratified interpretation 1, and the undated-event comments now say what
the writer persists.

## Appendix A. Coverage by rule

For every accepted rule: the hand-written case, the generated features and the cells the rule
alone withholds there, its occurrence in the real data, the product's own tests, the mutations
that break it, and the consumers that read it. No rule is covered only by a test derived from its
implementation: every row has a hand case and an oracle comparison.

| Rule                                                          | Hand cases                                                | Generated                                                                                                               | Real data                                            | Product tests                                                                                     | Mutations                                                      | Consumers                              |
| ------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------- |
| Formulas: `MC`, the five ratios                               | C01, C06–C06c, C43c                                       | every available cell (§11)                                                                                              | 1,392,386 available cells                            | `valuation-ratios.test.ts`, `valuation-history.integration.test.ts`, `stocks.integration.test.ts` | M01–M09, M38a, M75                                             | all (§20–§23)                          |
| TTM: four consecutive quarters, no FY, no fallback            | C01, C14, C15, C15b                                       | `missing-quarter`, `fy-rows`; `INCOMPLETE_WINDOW` alone 10,077,689 cells                                                | `INCOMPLETE_WINDOW` (P/E 6,658)                      | `valuation-ratios.test.ts`, `fiscal-quarters`                                                     | M08, M11, M12, M17                                             | all                                    |
| Inputs: positive denominator, share count, close              | C07–C12, C43                                              | `near-zero-denominator`, `zero-close`, `shares-non-positive-count`                                                      | `NON_POSITIVE_DENOMINATOR`, `MISSING_SHARE_COUNT`    | `valuation-ratios.test.ts`                                                                        | M14 (equivalent), M15, M47                                     | all                                    |
| Currency                                                      | C19, C20, C20b                                            | `one-family-other-currency`, `all-statements-other-currency`, `empty-currency`                                          | none (proven synthetically)                          | `valuation-ratios.test.ts`                                                                        | M16, M50                                                       | all                                    |
| Representability                                              | C43, C43b                                                 | `UNREPRESENTABLE_RESULT` alone                                                                                          | none (synthetic)                                     | `valuation-ratios.test.ts`                                                                        | M48                                                            | all                                    |
| Point in time: availability, revision order, moved period end | C16, C17, C18, C18b, C18c                                 | `revision-*`, `observation-*`                                                                                           | every session                                        | `valuation-ratios.test.ts`, `financial-statements.test.ts`                                        | M10, M10b, M10c, M10d, M13, M61                                | all                                    |
| Monitor provisional row                                       | C42                                                       | every session read twice                                                                                                | 300 provisional cells; synthetic truncated copies    | `monitor-frame.test.ts`                                                                           | M44                                                            | Monitor                                |
| Rule 0: verified history                                      | C37                                                       | `verified-null`                                                                                                         | BRK-A, GOOG                                          | `valuation-ratios.test.ts`                                                                        | M24                                                            | all                                    |
| Rule 2: share level                                           | C21, C22, C23, C23b, G3, G3b, 14 walks                    | `shares-*`; 15.4 M cells before a first level                                                                           | 42 securities                                        | `valuation-ratios.test.ts`                                                                        | M18, M19, M20, M41, M49, M82, N03, N04                         | all                                    |
| Rule 3: restatement                                           | C24, C25, C25b, C26, C27, C27b, G1a–G1h, G2, 5 thresholds | `revision-shares-*`, `explained-restatement-*`, the restatement family (anchor past a withheld revision: 274,600 cells) | none: no stored revision changes a count             | `valuation-ratios.test.ts`, `exact-decimal-sum.test.ts`                                           | M21, M22, M23, M40, M45, M58, M63, N01, N02, N05–N08, N10, N11 | all                                    |
| Rule 4.1: non-plain history entry                             | C28, C30b                                                 | `non-plain-entry`; `HISTORICAL_DISTRIBUTION_ENTRY` alone                                                                | 8 securities (§27)                                   | `valuation-ratios.test.ts`, `valuation-history.integration.test.ts`                               | M25, M26, M26b, M51, M73, M74                                  | all                                    |
| Rule 4.2: count before an entry                               | C39, C39b                                                 | `COUNT_PREDATES_HISTORICAL_ENTRY` alone                                                                                 | none (synthetic)                                     | `valuation-ratios.test.ts`                                                                        | M42, M71                                                       | all                                    |
| Rule 5: count soon after an event                             | C39b, C39c, C39d                                          | `observed-on-event-day`, `EVENT_SETTLING` alone                                                                         | none (synthetic)                                     | `valuation-ratios.test.ts`                                                                        | M39, M43, M59, M72                                             | all                                    |
| Rule 6: `K` and its withheld windows                          | C25, C35, C35b, C40, C41, C41b, C41c                      | `dated-measured`, `undated-measured`, `unexplained-*`; `BASIS_WITHHELD` alone                                           | none: no measured re-base                            | `price-basis.test.ts`, `valuation-ratios.test.ts`                                                 | M28, M30b, M55, M56, M64, M65, M66, M67                        | all; the worker anchor's 2024 split    |
| Rule 7: after a measured distribution                         | C32, C32b, C40b                                           | `non-plain-measured`, `POST_DISTRIBUTION_STATEMENTS_STALE` alone                                                        | none (synthetic)                                     | `valuation-ratios.test.ts`                                                                        | M29, M54                                                       | all                                    |
| Rule 8: forward entry                                         | C31, C31b, C31c                                           | `forward-entry`, `entry-match-*`; `FORWARD_EVENT_UNMEASURED` alone                                                      | none: no forward entry of a security with statements | `valuation-ratios.test.ts`                                                                        | M27, M30a, M52, M53, M69, M70                                  | all; the worker anchor's 1:2           |
| Plain-share predicate                                         | C29, C30, C30b                                            | `plain-entry`, `near-plain-measured`                                                                                    | every listed entry (§27)                             | `price-basis.test.ts`                                                                             | M26, M26b, M68                                                 | all                                    |
| Generation bracket and revision pin                           | C38a, C38b                                                | —                                                                                                                       | —                                                    | `stocks.integration.test.ts`, `price-basis.integration.test.ts`                                   | M36a, M36b, M36c, M37                                          | backtest, Monitor, Stock Details (§26) |
| Unavailable never matches                                     | —                                                         | —                                                                                                                       | —                                                    | `predicates.test.ts`, `monitor-transitions.fixture.test.ts`                                       | M34, M35, M77                                                  | backtest, Monitor (§21, §22)           |
| Stock Details answer and chart                                | —                                                         | —                                                                                                                       | every served session; HTTP; browser                  | `StockPriceChart.test.tsx`, `valuation.user.spec.ts`                                              | M33, M33b, M38b, M78                                           | Stock Details (§23)                    |
| Statement, event and split read                               | —                                                         | the synthetic store                                                                                                     | every served session                                 | `valuation-history.integration.test.ts`                                                           | M79, M80, M81                                                  | all                                    |

## Appendix B. Regression gates

### On the rulings (2026-10-06)

| Gate                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:validate`, `pnpm db:check-drift`                                   | passed (the schema change is a comment; no migration)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm lint`                                                                 | passed (`--max-warnings=0`), after `8acdbd61` removed a constant no ruled hand case reads                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `pnpm typecheck`                                                            | passed in all 13 workspaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm openapi:validate`                                                     | passed (62 paths)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pnpm build`                                                                | passed in all 13 workspaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm -r --no-bail --if-present test`                                       | every package passed and every file ran (stock-data 49 of 49) except stock-data's two "cross-process canonical hydration" 5 s timeouts (5,053 and 5,037 ms), the known flakes of that file under parallel load, on clean `main` too (below); api 2,057 of 2,057, worker 293 of 293                                                                                                                                                                                                                                                                                                                                                       |
| `pnpm --filter @intrinsic/stock-data test:redis`                            | passed, 49 tests; the two cross-process cases in 2,206 and 4,609 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `pnpm test:e2e` (full hermetic Playwright, personas seeded, worker running) | 269 passed, 2 failed in 10.5 minutes, none in a valuation spec. A Monitor card showed "Last checked" where step 11 of `monitors.user.spec.ts:217` expects "Not checked yet": the worker's cycle had already scanned the new Monitor (a price Condition over an empty list). It passed on `--last-failed` and 3 of 3 alone, and nothing on this branch touches that path. `entitlements.admin.spec.ts:38` failed again because of the test-data leak found on clean `main` (below): the administrator persona now holds 103 lists, 92 of them `Forged role attempt …`, so its fixture list is off the 100-row page. It fails on any code. |
| `pnpm audit:valuation`                                                      | `generated`, `real`, `synthetic-store`, `cache-parity`, `retention-scope`, `http` (pinned clock) and the browser audit all passed: §0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### The first run (2026-10-03)

Run on this branch on 2026-10-03, on a machine loaded far beyond its memory (swap nearly full,
load average 6–12 from other software), which is what the failures below have in common:

| Gate                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:validate`                                                          | passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `pnpm db:check-drift`                                                       | passed: the schema matches the migration history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm lint`                                                                 | passed (`--max-warnings=0`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm typecheck`                                                            | passed in all 13 workspaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm openapi:validate`                                                     | passed (62 paths)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `pnpm -r --no-bail --if-present test`                                       | contracts, config, domain, valuation, fmp, strategy, observability and web passed; stock-data, worker and api each had failures, every one a timeout or a 15-minute wait on an abandoned hydration lease under the load, and every failing file passed when re-run alone; one stock-data file never ran and passed alone; clean `main` fails the same way under the same load (below)                                                                                                                                                                          |
| `pnpm --filter @intrinsic/stock-data test:redis`                            | passed, 49 tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `pnpm test:e2e` (full hermetic Playwright, personas seeded, worker running) | 264 passed, 7 failed in 1.5 hours; none in a valuation spec (`valuation.user.spec.ts` and `indicators.user.spec.ts` passed). Six of the seven ran 5 to 17 minutes before failing, the hydration-lease waits above; the seventh, a guest Dashboard check, failed in 6 seconds on "Stale · last scan 16 min ago": the worker's Monitor scan was itself in such a wait. After `pnpm test:entitlements:seed`, `playwright test --last-failed` passed all of them (12 of 12 with the sign-in setup); clean `main` under the same load: 268 passed, 3 failed (below) |
| `pnpm build`                                                                | passed in all 13 workspaces                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `pnpm audit:valuation`                                                      | `generated` passed (95,074,870 cells, 0 failed); `real` 0 failed cells with three lock refusals re-run alone (§12); `retention-scope` written; `synthetic-store` 0 failed cells (§12)                                                                                                                                                                                                                                                                                                                                                                          |

The failing files in the full parallel run, each re-run alone on the branch:

| File                                                   | Full run                                                                                                                                                                                                  | Alone                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `stock-data` `redis.integration.test.ts`               | 4 of 30 failed: the two known "cross-process canonical hydration" 5 s timeouts, and two Fundamental Metrics cases that waited 37 s and 16 minutes                                                         | passed (with `daily-state-cache` and `price-retention`: 67 of 67) |
| `stock-data` `daily-state-cache.integration.test.ts`   | 1 failed, 5 s timeout                                                                                                                                                                                     | passed                                                            |
| `stock-data` `price-retention.integration.test.ts`     | 1 failed after 4 minutes                                                                                                                                                                                  | passed                                                            |
| `api` `stocks.infrastructure.integration.test.ts`      | 1 failed after 16 minutes                                                                                                                                                                                 | passed, 22 of 22                                                  |
| `worker` `monitor-valuation-audit.integration.test.ts` | 1 failed after 16 minutes                                                                                                                                                                                 | passed, with the backtest audit 21 of 21                          |
| `stock-data` `provider-reuse.integration.test.ts`      | did not run: a vitest worker timed out loading a module (`[vitest-worker]: Timeout calling "fetch"`, reported as an unhandled error), and the file was never collected (48 of the package's 49 files ran) | passed, 12 of 12                                                  |

The 15- to 16-minute waits are the stock-data cache's abandoned-hydration expiry
(`DEFAULT_HYDRATION_TTL_MS`): a hydration whose lease expired on the starved machine leaves its
`HYDRATING` manifest, and the next reader waits it out (or finds its generation changed). That is
the cache's documented behaviour, not a valuation question, and none of these files touches a
valuation rule that this branch changed.

**Compared with clean `main`.** The same command on a detached worktree of `main` (`d3a06e88`: its
own dependencies and builds, the same `.env`, PostgreSQL and Redis), run on 2026-10-03 from 09:29 to
10:45 on the same machine under the same load (load average 7–20):

| Package    | This branch (the run above)                                                                                                                                                                                                            | Clean `main`                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| stock-data | 6 of 1,075 tests failed (48 of 49 files ran): the two cross-process 5 s timeouts, a `daily-state-cache` 5 s timeout, `price-retention` after 4 minutes, and two Fundamental Metrics cases after 37 s (a Redlock quorum) and 16 minutes | 3 of 1,079 failed and 7 skipped: the same two cross-process 5 s timeouts, and `price-retention`, whose 120 s setup hook timed out (7 skipped) and whose backtest case failed with "Stock cache hydration generation changed", the file taking 17 minutes |
| api        | 1 of 2,018 failed: `stocks.infrastructure`, after 15.8 minutes                                                                                                                                                                         | 3 of 1,838 failed: `stocks.infrastructure`, after 7 minutes, 2 minutes and 15.7 minutes                                                                                                                                                                  |
| worker     | 1 of 293 failed: the new Monitor audit, after 15.9 minutes                                                                                                                                                                             | 272 of 272 passed (`main` has neither audit file)                                                                                                                                                                                                        |
| the rest   | passed                                                                                                                                                                                                                                 | passed                                                                                                                                                                                                                                                   |

Every failure on either side is a timeout in the shared hydration path, and clean `main` fails the
same files the same way — `stocks.infrastructure` on a 15.7-minute wait past its 120 s limit,
`price-retention` on a lost hydration generation, the two cross-process cases at 5 s. This branch
changes none of that code (its product changes are the three fixes in `valuation-ratios.ts` and
`exact-decimal-sum.ts`, pure computations), and every file that failed, or did not run, passed
alone. These are pre-existing load flakes of `main`, not regressions of this branch. No timeout was
raised.

**Playwright, compared with clean `main`.** The full hermetic suite from the same `main` worktree
(its own fixture provider, API, worker and web on the same test database, personas re-seeded), on
2026-10-03 from 11:03 to 11:50 under the same load: 268 passed and 3 failed. A backtest waited 7.8
minutes, a Stock Details metric pane waited 16 minutes, and an administrator entitlement check
failed after 15.5 minutes. After `pnpm test:entitlements:seed`, `--last-failed` passed the first two.
It failed the third again, in 21 seconds, for a reason that has nothing to do with either tree:

- The administrator persona now holds 102 lists. 91 of them are `Forged role attempt …` lists,
  which `entitlements.admin.spec.ts` creates on every run and never removes.
- Its fixture list `ENT-Admin Wide` is the oldest, so it has fallen off the 100-row page that the
  helper widens to: row 101 after this branch's run, row 102 after `main`'s.

That check now fails on any code until the test database is cleaned. It is a pre-existing
test-isolation problem, not this branch's.

Apart from that check, the branch's seven failures and `main`'s other two are different tests
failing for one reason, the long hydration waits under the load, and every one of them passed when
re-run.

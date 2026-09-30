# Fundamental Metrics V1: independent audit

Branch `audit/fundamental-metrics-v1`, cut from `main` at `df2ae7c5` (the merge of PR #71), audited
2026-09-29 to 2026-09-30.

This is a verification record, not a feature. It covers the whole Fundamental Metrics V1 flow and
all fifteen metrics, one layer at a time:

1. `FinancialStatement` point-in-time revisions;
2. the metric calculations;
3. `DailyDerivedState` in PostgreSQL and Redis;
4. the consumers: Strategy Conditions, Backtest, Monitor and the Stock Details chart.

The evidence is written as tests and audit sections that stay in the repository, so every number
below can be reproduced. Section numbers such as §20 refer to the audit brief.

## Verdict

- **One real defect was found and fixed.** It sits in the statement loader's point-in-time dating,
  and nothing currently stored is affected. It has its own commit (see
  [Defect found and fixed](#defect-found-and-fixed)).
- **No correctness uncertainty remains open.** Every value checked against the independent oracle,
  on synthetic histories and on the matrix's real histories, matched on availability and value.
- **No layer disagrees with another.** PostgreSQL, Redis, the Strategy frame, Backtest, Monitor, the
  Stock Details API and the chart's preparation all show the same persisted truth on every session
  of the anchor history.
- **The Redis per-security budget is still exceeded,** which was already known. The layout trigger
  in the storage decision still holds (see [Performance and Redis budget](#performance-and-redis-budget)).

## Method and oracle independence

Every stored value is compared at least once with something production did not compute: the
independent oracle, or a literal table derived by hand. The audit also has layer-parity legs that
compare production with production — Redis against PostgreSQL, a production re-run against the
stored text, projected frames against stored rows. Those are consistency checks, and the audit
summary labels them `independentOracle: false`.

**The oracle.** `apps/api/src/data-correctness-audit/oracle/fundamentals.ts` is an independent
implementation of `docs/decisions/fundamental-metrics-v1.md`, written clean-room from the decision
documents without reading the engine.

- Its arithmetic is exact: bigint rationals, with the tax rate as 21/100. It converts to a double
  only at the end.
- It lives in the audit's `oracle/` directory, where ESLint forbids any `@intrinsic/*`, Prisma or
  parent-directory import.
- `oracle/fundamentals.test.ts` pins it with 216 tests. Their expected values are computed by hand
  from the decision record.

**The anchor history.** `FUNDAMENTAL_AUDIT_ANCHOR_SYNCS` in `packages/testing/src/fundamental-audit.ts`
is one security's history. It has 16 statement syncs over 752 sessions from 2023-01-03 to
2025-12-31, and includes:

- restatements and invalidations;
- a switch of reporting currency and back;
- a moved period end and a period-end placeholder;
- a filing on New Year's Day;
- a value outside the storage range;
- exact zeros and negative readings.

Its expected readings (`FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED`) are literal stretches derived by hand.
The oracle reproduces all 11,280 cells from the revisions the real loader dated.

**The hand edge matrix.** `edge-matrix.test.ts` states statements and expected readings by hand. It
checks them against both the oracle and production. In four places the hand statement was wrong: the
oracle caught it, production agreed with the oracle, and the hand statement was corrected.

**The persistence model.** `oracle/decimal.ts` (`prismaFloatBoundAtScale`) states how a double
reaches `DECIMAL(20,8)`: Prisma renders 16 significant digits, then PostgreSQL rounds half away from
zero. That model was measured against the live column, and it is the expected text in the
persistence tests.

## Evidence

Tests added by this audit are in `apps/api/src/data-correctness-audit/fundamentals/` unless another
path is given.

### Identity, validation and fingerprints (§3, §4, §18, §19, §28)

| Area                     | Evidence                                                                                                                                                                                          | Result                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and unit parity | `identity-parity.test.ts` checks every surface: domain registry, product catalog, Strategy registry, operand family, OpenAPI enum, Prisma columns, oracle, frame provenance and the QA dimension. | Each surface has the same 15 identities with the same units and the ADR's storage fields. No alias is accepted: not a lower-cased or spaced identity, a storage field or a label. A 16th metric fails with "new Fundamental metric is not covered by audit tooling".        |
| Strategy validation      | `strategy-audit.test.ts`                                                                                                                                                                          | Only `is above` and `is below` are accepted, in the metric's own unit. `is close to`, every Trigger operator, the other unit, other Value kinds and malformed identities are refused.                                                                                       |
| Fingerprints             | `strategy-audit.test.ts`                                                                                                                                                                          | Each of the 15 metrics has its own fingerprint in every level kind. The identity is serialized byte for byte. The fingerprints of 5,760 non-Fundamental definitions × 6 fingerprint kinds are identical to main before the Strategy slice (`e0045acd`, digest `b09d25a9…`). |

### Formulas and statement selection (§5, §6, §9, §10, §11, §35)

| Area                                                               | Evidence                                                                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formulas, all 15                                                   | `edge-matrix.test.ts`, 96 cases: missing fields, zero and negative denominators, zero readings, net cash, negative EBIT, provider FCF never substituted | Every availability and value is as stated by hand. Production equals the oracle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Fiscal sequencing                                                  | `edge-matrix.test.ts` and the differential                                                                                                              | Quarters are placed by `(fiscalYear, period)`, never by date. 52/53-week years and years ending in January, March, June and September are covered. An FY row is never a quarter. Windows anchor at the newest quarter, with no stale fallback.                                                                                                                                                                                                                                                                                                                                                                                                |
| Currency                                                           | `edge-matrix.test.ts`                                                                                                                                   | Only the currencies of the statements a metric reads are compared. `USD` and `usd` are two currencies, and a missing currency makes the metric unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Storage range                                                      | `edge-matrix.test.ts`, `persistence.integration.test.ts`                                                                                                | A value with `abs(v) >= 1e12` is absent and never clamped, and one overflowing metric leaves its siblings intact.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Differential: production materializer vs oracle, every trading day | `differential.test.ts`, 8 generated histories with fixed seeds 20260929–20260936 and hostile revisions, currencies, gaps and extremes                   | 66,397 days and 995,955 metric-day comparisons: 625,772 available, 370,183 unavailable, **0 mismatches**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Real data: stored values vs oracle                                 | The `fundamentals` audit section on the matrix copy (33 securities, full retained history)                                                              | 259,410 rows and 3,891,150 comparisons: 3,678,786 available, 212,364 unavailable, **0 failed**. The oracle is exact and the column holds eight decimals, so available values compare within the section's stated storage tolerance; the largest difference is 5.0000040e-9, half a quantum plus the sixteen-digit binding of observation 1. No stored revision is public before the day after its own filing, or before the day after its statutory deadline when it carries none (0 violations). That rule cannot tell a restatement dated from its filing from one dated from its observation; the moved-period-end tests cover that class. |

### Point-in-time dating (§7, §8, §12)

| Area                                 | Evidence                                                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Availability through the real loader | `pit-availability.integration.test.ts`, which states every expected date by hand                                                                            | A filing is public the day after it is filed, whatever the weekday. A placeholder is public the day after its 45- or 90-day deadline, with a weekend deadline moved to Monday. A restatement is dated from its own filing when that is newer, otherwise from its observation. Each date maps to the first session on or after it, so weekends and holidays never get a row, and two weekend revisions take effect together on Monday. |
| Moved period end (§8)                | `pit-rebuild.integration.test.ts` runs the real refresh with four variants: moved later, moved earlier, earlier with a real newer filing, and a placeholder | **0 rows before the observation boundary changed** in any variant. The boundary is the observation or the new filing, never the original filing date.                                                                                                                                                                                                                                                                                 |
| Carry-forward and invalidation       | `edge-matrix.test.ts` and the anchor                                                                                                                        | An invalidating revision makes the metric absent from its own session onward and never carries the older value. A later revision restores it.                                                                                                                                                                                                                                                                                         |

### Storage, rebuild and read costs (§13, §14, §15, §16, §31, §36)

| Area                        | Evidence                                                                                                                                        | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                  | `persistence.integration.test.ts`, anchor                                                                                                       | The stored text matches the binding model, including half-quantum and 1e12 boundaries. Absence is `NULL`, and `NULL` reads back as absent, never zero or -0. With the same prices and no statements, every other derived column is identical row for row.                                                                                                                                                                                                                                                                                                                     |
| Redis                       | Anchor                                                                                                                                          | The yearly `daily-state` chunks carry the same numbers. Absence is an omitted key, never a JSON null. There is no Fundamentals key family. After a flush, the history rebuilt from PostgreSQL alone is identical.                                                                                                                                                                                                                                                                                                                                                             |
| Eviction                    | Anchor                                                                                                                                          | An explicit eviction, and a least-recently-used eviction caused by another security's publication, each remove the security's whole key registry, Fundamentals included. The next read reconstructs identical values with no rebuild.                                                                                                                                                                                                                                                                                                                                         |
| Rebuild boundary            | `pit-rebuild.integration.test.ts`                                                                                                               | A refresh rewrites derived rows only from the earliest availability among the revisions of the fiscal years it changed (2026-05-11 in the test), never before. The new revision itself is public from 2026-09-14, and no row before that changes value.                                                                                                                                                                                                                                                                                                                       |
| Shared statement read       | `pit-rebuild.integration.test.ts`, `read-counters.integration.test.ts`                                                                          | Each rebuild reads the statements once for both the Fundamental and the intrinsic materializers. The number of reads does not depend on the length of the history.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Stock Details read costs    | `read-counters.integration.test.ts`, counted from Prisma query events, Redis commands and rebuild calls                                         | **Warm request:** 0 SQL statements, 0 statement queries, 0 rebuilds, and one `MGET` of the yearly chunks. The cost is identical for one month and for three years, and for all 15 metrics. **After a Redis flush:** 0 rebuilds, 0 derived writes and exactly one derived `SELECT`. The flushed path also reads statements once per statement family and cadence (6 queries) to republish the statement cache. That is not a calculation, and the count is the same for any range.                                                                                             |
| Backtest loop read costs    | `backtest-fundamentals-audit.integration.test.ts`: 752 sessions, all 15 Fundamentals                                                            | One SQL statement for the whole run (the period's price bounds), 0 statement queries, 0 derived-state SQL, 0 rebuilds, one derived chunk read per calendar-year window (3 in total), and fewer than 50 Redis reads.                                                                                                                                                                                                                                                                                                                                                           |
| Full historical scale (§36) | The `fundamental-scale` audit section (`--fundamental-frames`): all 33 matrix securities over their full retention, up to 35 yearly chunks each | 7,784,455 comparisons, **0 failed**. Redis matches PostgreSQL on all 3,891,150 metric-days. Re-running the production materializer on the rebuild's own inputs reproduces the stored text on all 3,891,150, so the stored state is deterministic across runs. All 1,061 yearly chunks are present with no missing or extra row, 1,028 year boundaries are covered, and all 1,061 chunks republished after an eviction are byte-identical. The slowest full-history materialization of one security took 168 ms, the slowest cold hydration 3.8 s, and no provider was called. |

### Consumers (§17, §20–§25, §29)

| Area                         | Evidence                                                                                                                                          | Result                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strategy projection          | `strategy-audit.test.ts`, anchor                                                                                                                  | Each of the 15 metrics reads its own stored value: a value stays the value, 0 stays 0, a negative stays negative, and absence is `NaN`. Nothing is scaled. Equality is `FALSE`, and absence is `NOT_EVALUABLE`, never zero.                                                                                                             |
| Backtest                     | `apps/worker/src/backtest/backtest-fundamentals-audit.integration.test.ts`, the real `BacktestProcessor` over the real service                    | The trade dates are the ones read off the anchor by hand. See [Backtest cases](#backtest-cases).                                                                                                                                                                                                                                        |
| Monitor                      | Anchor                                                                                                                                            | The provisional session carries the newest closed session's value, which is the documented one-session framing. The Monitor lifecycle opens on 2024-08-05 and holds through the whole unavailable stretch (2024-08-21 … 2024-09-16). It resolves on 2025-08-18, on a decidable `FALSE`.                                                 |
| Stock Details API            | Anchor, over HTTP                                                                                                                                 | Every session carries exactly the persisted value, and `value` is omitted when the metric is unavailable. A storage field, label or lower-cased identity gets 400.                                                                                                                                                                      |
| Chart preparation            | `apps/web/src/features/stocks/details/utils/fundamental-series.audit.test.ts`; the Stock Details Playwright spec (14 cases) on the hermetic stack | The anchor table is prepared on the price axis. Steps change only where the table changes, and gaps are never bridged or carried. A session off the price axis is never drawn. In the browser, the chart's DOM contract, units, gaps and loading behave as documented.                                                                  |
| Single source of truth (§29) | Anchor, all 15 metrics × 752 sessions per layer                                                                                                   | [The layer table below](#single-source-of-truth-29) shows the four headline metrics.                                                                                                                                                                                                                                                    |
| Mutations of the chain       | `backtests/frame-provenance.fundamentals.test.ts`                                                                                                 | The frame-provenance audit fails on each of 9 injected faults: ROIC read from ROE; D/E read from Current Ratio; absence read as zero; a percentage divided by 100; a percentage multiplied by 100; a multiple scaled like a percentage; a value one session late; a referenced Fundamental missing from the frame; an unknown identity. |

#### Backtest cases

| Case                                                | Result                                                          |
| --------------------------------------------------- | --------------------------------------------------------------- |
| Percent (ROIC > 15%)                                | BUY on 2024-08-02, FINAL EXIT on 2025-08-15                     |
| Multiple (D/E < 0.7x)                               | BUY on 2024-10-15                                               |
| Two Fundamentals, ANDed                             | BUY on 2024-10-15                                               |
| Mixed with a technical                              | BUY on the date an independent SMA20 gives                      |
| Strict comparison at zero (Revenue Growth above 0%) | BUY on 2023-02-13, not on the exact-zero sessions before it     |
| Signed multiple (Net Debt / EBITDA)                 | BUY on 2023-07-05, SELL on 2024-10-15                           |
| Unavailable is never zero (ROE < 1%)                | No trade                                                        |
| Buy window opening inside a gap                     | BUY on 2024-09-16                                               |
| Determinism                                         | The same run twice is byte-identical, and no provider is called |

### Single source of truth (§29)

These readings are from the anchor history. Every layer holds the same number on every session, or
is absent on every session:

- **Oracle and PostgreSQL:** the literal text shown, or `NULL`.
- **Redis:** the same number, or the key omitted.
- **Strategy frame, Backtest predicate and Monitor frame:** the same number, or `NaN` /
  `NOT_EVALUABLE`.
- **Stock Details API:** the same number, or `value` omitted.
- **Chart:** the same step, or a gap.

| Metric (unit, families)                           | Stretches (first session → reading)                                                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ROIC TTM (%, income + balance sheet)              | 2023-01-03 → 12 · 2024-08-02 → 18 · 2024-08-20 → absent · 2024-09-16 → 16 · 2024-12-16 → 27.18279570 · 2025-01-02 → 16 · 2025-08-15 → 12                                    |
| Revenue Growth TTM YoY (%, income)                | 2023-01-03 → 0 · 2023-02-13 → 10 · 2024-02-09 → -9.09090909 · 2024-08-20 → absent · 2024-09-16 → -9.09090909 · 2025-01-02 → 0                                               |
| Debt / Equity (x, balance sheet)                  | 2023-01-03 → 1.2 · 2023-07-05 → 0.8 · 2024-10-15 → 0.6 · 2024-12-16 → absent · 2025-01-02 → 0.6                                                                             |
| Net Debt / EBITDA TTM (x, balance sheet + income) | 2023-01-03 → 0.5 · 2023-07-05 → -0.33333333 · 2024-08-02 → -0.25 · 2024-08-20 → absent · 2024-09-16 → -0.25 · 2024-10-15 → 0 · 2024-11-08 → -0.1 · 2025-08-15 → -0.13333333 |

The same holds for the other eleven metrics. The tests compare all 15 on every session, not only
these four.

### Egress (§30)

No provider was reached from persisted data.

- **Audit runs:** the real-data audit section, the frame leg, the performance runs and the
  full-scale run all ran under `packages/testing/egress-guard.cjs`. Every process was armed, and
  **0 outbound attempts** were blocked.
- **Test providers:** the integration tests use a counting or refusing provider, and it recorded
  **0 calls** after the intentional first hydration.
- **Browser suites:** the full Playwright suite ran on the hermetic E2E stack, where every process
  is guarded. No application process attempted an outbound connection. In one branch run and one
  `main` run the guard blocked, as a tolerated framework request, the Next.js dev server's own call to
  `registry.npmjs.org`. The fixture provider answered 4 requests per branch run (3 batch quotes and 1
  end-of-day history): intentional hydration or quotes, none a read of persisted Fundamentals.

## Defect found and fixed

**`fix(stock-data): judge a sync's filings oldest first, whatever the provider's order` (e8e78ad3).**

`saveFinancialStatements` judged each row against the filings known for its identity, including
rows planned earlier in the same sync. When one provider response held an original filing and its
amendment, and listed the amendment first, the original looked like a correction first observed
now.

- **Effect:** the original was dated from the sync instead of the day after its own filing. Its
  value disappeared from every session between the two filings.
- **Reproduction:** against the real store, a quarter filed on 2020-04-20 and amended on 2020-05-20,
  both delivered in one sync on 2026-09-01.
  - Listed oldest first: public on 2020-04-21 and 2020-05-21.
  - Listed newest first: public on 2020-05-21 and 2026-09-01.
- **Severity:** the error only ever dates a filing later, so there is no look-ahead. It still breaks
  the loader decision, under which the order of rows within a sync never decides which was public
  first.
- **Fix:** rows are judged in ascending filing-date order, with a stable sort. The deliberate
  same-filing-date rule is unchanged.
- **Stored data:** neither database holds such a pair (0 of 23,853 development statements and 0 of
  16,797 matrix statements), so no stored availability changes.
- **Tests:** `packages/stock-data/src/financial-statements.test.ts` covers both provider orders and
  the same-filing correction.
- **Documentation:** the rule is recorded in `docs/decisions/fundamentals-loader.md`.

## Observations (not defects)

1. **Sixteen-digit binding.** All derived columns, not only the Fundamentals, bind a double that
   Prisma renders with 16 significant digits before PostgreSQL rounds it to 8 decimals. In a
   15-value probe, 5 values landed one quantum away from a single correct rounding of the double.
   Every consumer reads the stored decimal, so all layers agree; this is technical debt, not a
   Fundamentals issue.
2. **Listing clamp.** Statements dated before a listing date are retained but never read, because
   the documented statement horizon is clamped to `ipoDate`. Seven of the 33 matrix securities hold
   such statements: HON 173, V 32, GOOGL 30, MRNA 25, CRM 18, AMZN 11 and GS 2. The effect is that
   Fundamentals begin only once four or eight post-listing quarters exist. This is the documented
   rule, so it is a methodology question, not a defect.
3. **Residual rows.** 325 derived rows older than today's retention start remain from an earlier
   revision. All their Fundamentals are `NULL`, no surface reads them, and a coverage-aware rebuild
   never touches them.
4. **Flush cost.** A Redis flush makes the next read republish the security's statement cache, which
   is 6 statement queries. No calculation or rebuild follows (see the read costs above).

## Mutation audit (§34)

Each mutant changed production or tooling source, rebuilt the dependent packages, ran the audit
test set, and then restored the exact bytes (hash-verified). The baseline was green: 382 API tests,
9 worker, 20 web and 15 stock-data.

| #   | Mutant                                                          | Result                             |
| --- | --------------------------------------------------------------- | ---------------------------------- |
| 1   | Revenue Growth reads EPS Growth's field (projector)             | Killed                             |
| 2   | ROIC reads ROE (projector)                                      | Killed                             |
| 3   | Debt / Equity history served from Current Ratio (Stock Details) | Killed                             |
| 4   | A missing Fundamental projected as zero                         | Killed                             |
| 5   | Percentages stored divided by 100                               | Killed                             |
| 6   | A margin multiplied by 100 twice                                | Killed                             |
| 7   | MULTIPLE metrics scaled as percentages                          | Killed                             |
| 8   | Stale fallback to an older complete window                      | Killed                             |
| 9   | An FY row fills a missing Q4 (index guard only)                 | **Survived: equivalent**           |
| 10  | The newest quarter ignored                                      | Killed                             |
| 11  | A currency mismatch accepted                                    | Killed                             |
| 12  | A missing currency accepted                                     | Killed                             |
| 13  | A revision visible one day early                                | Killed                             |
| 14  | The chart draws a weekend session                               | Killed                             |
| 15  | A moved period end backdated to the original filing             | Killed                             |
| 16  | An out-of-range value clamped and stored                        | Killed                             |
| 17  | One overflowing metric takes its siblings                       | Killed                             |
| 18  | Redis chunks drop ROIC                                          | Killed                             |
| 19  | The fingerprint ignores the metric identity                     | Killed                             |
| 20  | A Fundamental Trigger accepted                                  | Killed                             |
| 21  | The chart carries a value across a gap                          | Killed                             |
| 22  | The chart shows an off-axis session                             | Killed                             |
| 23  | QA tooling silently ignores `fundamental:*`                     | Killed                             |
| 24  | Frame provenance maps ROIC to ROE's column                      | Killed                             |
| 25  | The API accepts a storage field as the public identity          | Killed                             |
| 9b  | An FY row fills a missing Q4, with all three FY guards removed  | Killed (16 API and 2 worker tests) |

**Result:** of the 25 listed mutants, 24 were killed and 1 survived as an equivalent mutant. With the
strengthened 9b, 26 were attempted and 25 killed.

The survivor, #9, removes only one of three independent guards. The other two still drop FY rows
before the index sees them: the materializer's `isFiscalQuarterPeriod` filter and the selector's
`cadence: "QUARTERLY"`. The mutant is therefore equivalent in the composed product. The
implementation's own unit test (`fiscal-quarters.test.ts`, "ignores FY rows…") kills it, and
mutant 9b, which removes all three guards, is killed by the audit set.

## Performance and Redis budget

All measurements were taken on the matrix copy with the clock pinned to 2026-09-28 and the provider
refused. Each timing is the median of repeated runs on this development Mac.

**Stock Details, one metric over 30 years** (AAPL, ROIC TTM):

| Measurement                                                   | Value                      |
| ------------------------------------------------------------- | -------------------------- |
| Sessions in the response                                      | 7,545 (5,950 with a value) |
| Warm service read                                             | 123 ms                     |
| Read after a Redis flush                                      | 2.5 s (a full hydration)   |
| JSON payload                                                  | 286,019 B                  |
| Browser preparation (`buildFundamentalSeries` + runs + steps) | 2.5 ms                     |

**Strategy frames over 30 years** (31 calendar-year windows, 7,736 frame rows, the real
`BacktestProcessor`):

| Fundamentals in the Strategy | Project | Simulate | Total  | Largest window frame |
| ---------------------------- | ------- | -------- | ------ | -------------------- |
| 0                            | 287 ms  | 64 ms    | 355 ms | 4.1 KB               |
| 1                            | 285 ms  | 60 ms    | 349 ms | 6.2 KB               |
| 5                            | 359 ms  | 65 ms    | 429 ms | 14.5 KB              |
| 15                           | 301 ms  | 74 ms    | 379 ms | 35.2 KB              |

Each Fundamental adds one `Float64Array` column per window. The run's time is dominated by the
projection read, not by the number of Fundamentals.

**Redis memory** is measured with `MEMORY USAGE` over all of a security's registered keys, after a
cold hydration of its full retained history. In the table, MiB is 1024 × 1024 bytes and GB is 10⁹
bytes.

| Measurement                                                                                                     | Value                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Real matrix securities (33)                                                                                     | Largest: WMT, 15,462,800 B (14.75 MiB). Mean 12.72 MiB, smallest 2.36 MiB (MRNA).                |
| Largest real security by family                                                                                 | Daily-state 12.38 MiB, prices 1.34, statements 0.98, other 0.05                                  |
| Synthetic worst-case daily state: all 42 value columns non-null on every weekday of full retention (8,871 rows) | 13,407,432 B (12.79 MiB). The fifteen Fundamentals are 4.27 MiB of it. Over 30 years: 11.19 MiB. |
| Worst case per security (synthetic daily state + the largest real price and statement families)                 | ≈ 16.08 MB (15.33 MiB)                                                                           |
| Default resident limit                                                                                          | 100 (`getStockDataConfig`, `.env.example`; not overridden locally)                               |
| Worst-case aggregate at 100 residents                                                                           | ≈ 1.61 GB (1.50 GiB)                                                                             |
| Budget                                                                                                          | 2 GB. This is the storage decision's documented budget; local Redis sets no `maxmemory`.         |
| Residents before the budget is exceeded                                                                         | About 124 at 2×10⁹ B, or 133 at 2 GiB. At the real maximum: 129 or 138.                          |
| `DailyDerivedState` row size                                                                                    | 466 B real (`pg_column_size`), 498 B synthetic. The 1 KB budget holds.                           |

**Recommendation:** leave the storage decision's trigger as it is.

- The per-security budget (12 MB) is exceeded, as the decision already records. The resident-set
  budget holds at the default of 100.
- The trigger stays valid: move to a column-oriented Redis chunk before the next series family (the
  valuation ratios), or before `STOCK_CACHE_MAX_RESIDENT_STOCKS` is raised above about 120.
- This is a capacity item. No correctness issue makes it urgent, and this audit does not implement
  it.

## Tooling added

- **Data-correctness audit:**
  - a `fundamentals` section: stored values against the oracle on real data, the revision
    availability rule, and the eight synthetic histories;
  - `--fundamental-frames`: traces every `fundamental:*` column through the production projector per
    calendar-year window, and adds the `fundamental-scale` checks over each security's full retained
    history (Redis chunks against PostgreSQL, a production re-run against the stored text, and a
    republish after eviction);
  - `FrameProvenance` now traces `fundamental:*` columns to the stored value, instead of skipping
    them.
- **QA matrix:** a third strategy dimension, Fundamentals (`Fxx`, F01–F10), covering:
  - PERCENT and MULTIPLE Fundamentals;
  - an unavailable Fundamental;
  - several Fundamentals together;
  - a Fundamental mixed with a technical;
  - every metric at least once.

  Behaviour tags classify a Fundamental by its unit. Unknown identities fail loudly
  (`docs/development/qa-matrix-fixtures.md`).

- **Structural guards:** the oracle, frame provenance, the QA dimension, the Stock Details chart
  audit and the storage schema must each know exactly the ADR's fifteen identities. A new metric
  fails the tests with "new Fundamental metric is not covered by audit tooling".

## Validation

The gates ran on the branch's code (through `c07671b5`; the last commit adds only this report and
the evidence files). The browser runs predate the review fixes, which changed tests, tooling and
documentation only, so they ran against the same product code.

| Gate                                                                   | Result                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:validate`, `pnpm db:check-drift`                              | Pass. The committed migrations, replayed into a throwaway database, match the schema.                                                                                                                                           |
| `pnpm lint`, `pnpm typecheck`                                          | Pass.                                                                                                                                                                                                                           |
| `pnpm -r --no-bail --if-present test`                                  | config 67, domain 127, contracts 376, valuation 38, fmp 80, strategy 310, web 1,264, worker 265 and api 1,815 all pass. stock-data passes 795 of 797; the two failures are the cross-process hydration timeouts below.          |
| `pnpm --filter @intrinsic/stock-data test:redis`                       | 30/30 in each of six standalone runs, three before the review fixes and three on the final code.                                                                                                                                |
| `pnpm build`                                                           | Pass: all fourteen workspace projects, the web build included.                                                                                                                                                                  |
| `pnpm openapi:validate`                                                | Pass (61 paths).                                                                                                                                                                                                                |
| Playwright, hermetic stack                                             | Branch: 260/260, then 259/260 (the reset-zoom flake below). `main`: 260/260 twice. The Stock Details Fundamentals spec passed 14/14 in every run. No application process attempted egress.                                      |
| Data-correctness audit, `--sections=fundamentals --fundamental-frames` | `fundamentals` 4,887,105 comparisons, 0 failed, 25 skipped (the 325 out-of-coverage rows of observation 3, one skip per security). `fundamental-frame-provenance` 3,511,275, 0 failed. `fundamental-scale` 7,784,455, 0 failed. |

`artifacts/data-correctness-audit/SUMMARY.md` still reads FAIL overall. The one failure is the stored
`source-data` result of an earlier run (a provider volume revision), which this audit did not rerun.
Its "data as of" date is the matrix copy's last stored S&P 500 benchmark session.

**Flakes, classified by the repository's protocol.**

- **Two cross-process hydration timeouts.** `redis.integration.test.ts` › "cross-process canonical
  hydration" (two cases) timed out at 5 s inside both full parallel runs. Standalone, both cases
  passed 6/6 on the branch (2,090–2,206 ms and 4,454–4,770 ms) and 3/3 on `main` (1,959–2,069 ms
  and 4,428–4,574 ms). The second case contains a deliberate 3.5 s provider delay. This is pre-existing
  and load-sensitive. The branch does not touch that path, and the timeout was not raised.
- **Backtest reset-zoom (§39).** `backtests.user.spec.ts:719` failed once in two full runs on the
  branch: after the double-click reset, `reset.to` was `2026-09-25` where the earlier full-zoom sample
  `full.to` read `2024-12-31`.
  - It passed 3/3 standalone on the branch and 3/3 standalone on `main`, and both full runs on
    `main`.
  - The same signature failed once in three full runs on 2026-09-29, on the branch that became
    `main`, before this audit branch existed.
  - The branch changes no web, backtest or chart product code. Its one product change, the loader's order,
    cannot move a chart's viewport; the spec's strategy reads only price and EMA 200D.
  - In both observed failures the expected value was a calendar-year end and the received value
    the period's last session. That points to the `full` sample being taken before the chart
    settles after completion.
  - **Classification:** pre-existing timing flake, not branch-induced. It is not fixed here.

## Clean-room review (§42)

A fresh reviewer with no implementation context read the whole branch and was barred from writing.
It reported no blocker and no major finding, and confirmed:

- the production fix is correct and narrow;
- the oracle imports nothing and matches the ADR;
- the anchor table, the edge-matrix values and the artifact figures are right;
- the drift guard, frame provenance and the documented Monitor lag behave as claimed.

It raised three minor findings and nine nits, and every one was addressed:

- **Frame provenance gaps.** A frame session inside the stored history with no stored row, and a
  security with no stored reference, now fail instead of being skipped. Two tests cover this.
- **Reference backtester.** It refuses an A or F sweep by name. The Fundamentals fixtures and
  `docs/development/qa-matrix-fixtures.md` now say how that dimension is really audited.
- **Independence claim.** This report now states it precisely: the layer-parity legs are
  production-against-production consistency checks.
- **Read-cost tests.** They assert the exact counts quoted above, and no longer print.
- **Stock Details API.** The alias test also refuses each metric's catalog label.
- **Weak assertions.** Two were made meaningful: the edge matrix's "available at least once", and
  the moved-period-end case whose new row lands on T2.
- **References only when requested.** The backtests section no longer builds the Fundamental
  references unless the fundamentals section is requested.
- **Oracle strictness documented.** A comment in the oracle states where its storage-bound and
  overflow checks are stricter than the engine's; that can only ever surface as a mismatch.
- **Wording in this report and the test-matrix document.** The rebuild boundary, the mutation
  totals, the scope of the point-in-time rule and which apparatus runs in the ordinary gate are
  now stated accurately.

## Limitations

- **The F01–F10 sweep was not run live.** The Fundamentals dimension's 1,000 runs were not executed
  here, because the matrix copy was frozen on 2026-09-28 and re-freezing it needs a fresh provider
  sync. What was checked instead:
  - The fixtures are held by tests to validation, enumeration, fingerprints and behaviour tags.
  - The provenance leg those runs' archives would feed traced 1,023 real-data frames for exactly
    their operands.
  - The worker's real backtest path is held to hand-derived trades.
- **The reference backtester does not model Fundamental or Relative Volume metrics.** Extending it is
  a follow-up.
- **Performance figures come from one development machine**, not production hardware.

## Reproducing

```bash
# Unit and integration evidence (needs pnpm infra:up; uses TEST_DATABASE_URL)
pnpm --filter @intrinsic/api exec vitest run src/data-correctness-audit src/qa-matrix
pnpm --filter @intrinsic/worker exec vitest run src/backtest/backtest-fundamentals-audit.integration.test.ts
pnpm --filter @intrinsic/web exec vitest run src/features/stocks/details/utils/fundamental-series.audit.test.ts

# Real-data section and frame leg, on a provisioned matrix copy
QA_MATRIX_AS_OF_DATE=<as-of> pnpm audit:data-correctness -- --sections=fundamentals --fundamental-frames
```

The evidence files are `summary.json`, `frame-provenance.json` and `scale.json` in
`artifacts/data-correctness-audit/fundamentals/`, with one file per security.

## ADR status

`docs/decisions/fundamental-metrics-v1.md` and `fundamental-metrics-storage-and-evaluation.md` still
read **Proposed**.

The repository has no written rule for when a decision becomes Accepted. The decisions marked
Accepted so far were marked in the change that implemented them, and none ties acceptance to an
independent audit. This audit therefore leaves the status unchanged and leaves the decision to the
maintainer.

Recommendation: **ready to mark Accepted.**

- The implementation is complete.
- It matches an independent oracle on every compared metric-day.
- Every consumer agrees with the persisted truth.
- The only defect found is fixed and has no effect on stored data.

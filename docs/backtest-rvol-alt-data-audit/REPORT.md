# Backtest re-validation — Relative Volume and Alternative Data

Branch `audit/backtest-rvol-alternative-data`, from `439f634a`. Clock `2026-09-26`.

An end-to-end re-validation of the Backtest V1 engine after the Relative Volume period-identity fix
(`d4ce4aa2`) and the alternative-data slice (`0adf5610`, `d8f1dc36`). `FINDINGS.md` holds every
finding with the evidence it rests on and is the document to read for detail; this is the narrative.

Institutional / Form 13F is out of V1 and nothing here reintroduces it.

## 1. Audit scope

| Area | Re-validated |
| --- | --- |
| Relative Volume | the calculation, the materialization, warm-up boundaries, the period-aware semantic identity, several periods in one Strategy, frame projection, Monitor parity |
| Insider Activity | FMP payload, mapper, persisted row, `availableFromDate`, coverage, rolling projection, role filtering, distinct-buyer counting, purchase and sale value, Strategy evaluation |
| Congressional Trading | House and Senate ingestion, actor identity, owner and chamber filters, amount ranges, transaction vs disclosure date, `availableFromDate`, stock-only behaviour, Congress Groups, group snapshot freezing, rolling projection, Strategy evaluation |
| Engine | source data, point-in-time correctness, derived series, strategy evaluation, trade generation, ledger, results, determinism, no look-ahead, no silent NOT_EVALUABLE → 0, no cross-period RVOL collisions, no scope or group leakage |

## 2. Matrix dimensions discovered

The existing infrastructure was found and reused, not re-invented.

```text
10 Strategies  ×  10 Stock Lists  ×  10 Backtest configurations  =  1,000 runs
                identified as  QA-MATRIX-Sxx-Lxx-Cxx
```

- **Inputs** — `docs/development/qa-matrix-fixtures.md`, defined in `packages/testing/src/qa-matrix/`.
  `S01`–`S10` (Price/SMA, golden cross, weekly ladder, RSI ladder, high-turnover RSI 7D, sparse
  confluence, DCA ladder, EMA reversion, Margin of Safety, same-day rotation); `L01`–`L10` (one
  security through a thirty-name universe; FULL, CUSTOM, later listings, overlapping and boundary
  windows); `C01`–`C10` (30y/10y/3y/1y; contributions 0/500/1,000/25,000; capital
  1/10,000/100,000/250,000/1,000,000,000; `maximumPositions` 1/5/10/20/30).
- **Runner** — `docs/development/qa-matrix-runner.md`, `apps/api/src/qa-matrix/`. A dedicated
  `intrinsic_value_matrix` database and Redis db 3; a 17-check preflight; submission through the real
  `BacktestsService.submitRun`; execution by the real worker supervisor; **40 invariants** re-derived
  from persisted evidence (37 database, 3 forensic archive); a determinism rerun over 6 golden
  combinations comparing every persisted column; one gate with 15 stable failure codes.
- Every date is a pure function of one declared clock; the execution calendar is the pinned `SP500`
  benchmark's own bars and nothing else.

### The audit variant

`S01`–`S10` were **not edited**. A second strategy dimension was added — `A01`–`A10`, selected with
`--strategies audit` — over the same ten Lists and ten configurations, so either sweep is 1,000 runs
and the two are comparable. Core Price/SMA/RSI/fundamental/valuation coverage is therefore not reduced
by one condition. The ten are documented in `qa-matrix-fixtures.md`; between them they cover all three
RVOL periods alone, in pairs and all three at once, at the same and at different thresholds; every
insider and congressional measure; both chamber filters; an owner filter; a named member; an actor
group; and a deliberate NOT_EVALUABLE probe.

## 3. Original matrix results

Sweep `2026-09-26-20260925-223445`, concurrency 3, `--archive`.

| | |
| --- | --- |
| Expected / submitted / completed | 1,000 / 1,000 / **999** |
| Failed | **1** — `S08-L04-C08` (F-06) |
| Trades | **184,836** (largest run 10,898) |
| Daily equity rows | **3,612,556** |
| Invariant checks passed / failed / indeterminate | **37,962** / 2 / **0** |
| Archive frame-level invariants | 6 of 6 archives, **3/3 proven each** |
| Determinism | **0 differences**, 6 golden reruns, every persisted column |
| Provider requests | **0** |
| Zero-trade cases | 107 (`S06` 47, `S09` 26) — the expected sparse/valuation shape |
| Duration | 9,377 s at 6.40 runs/min; median case 20.9 s |
| Gate | NOT GREEN — three codes, all from the one failed case |

Both failed invariant checks are "reaches COMPLETED" and "no failure metadata" on that case. **No
engine invariant failed anywhere in the sweep.** Re-executed alone the case is green in seven seconds
with ten trades and every invariant passing, which places the failure on F-06's checkpoint
transaction and not on the combination.

## 4. Extended RVOL / Insider / Congress matrix results

Sweep `2026-09-26-20260926-014140`, `--strategies audit --archive`, concurrency 3.

| | Sweep A (core) | Sweep B (audit) |
| --- | --- | --- |
| Expected / submitted / completed | 1,000 / 1,000 / **999** | 1,000 / 1,000 / **999** |
| Failed | 1 — `S08-L04-C08` | 1 — `A08-L05-C10` |
| Trades | 184,836 | **360,896** |
| Daily equity rows | 3,612,556 | **3,612,556** |
| Invariants passed / failed / indeterminate | 37,962 / 2 / 0 | 37,962 / 2 / 0 |
| Archives | 6 of 6, 3/3 each | 6 of 6, 3/3 each |
| Determinism | **0 differences** | **0 differences** |
| Provider requests | **0** | **0** |
| Zero-trade cases | 107 | 116 |
| Duration | 9,377 s (6.40/min) | 4,428 s (13.55/min) |

Both failures are F-06 and both reproduce **green in isolation**. Both sweeps' two failed invariant
checks are the `reaches COMPLETED` / `no failure metadata` pair on that one case; **no engine
invariant failed in either sweep**.

Equity rows are identical across the two sweeps, which is the consistency check it looks like: a
daily equity curve's length is a function of the period and the list, not of the strategy, and both
covered the same hundred list × configuration pairs.

Per audit strategy:

| | runs | trades | zero-trade | invariants OK | failed |
| --- | --- | --- | --- | --- | --- |
| `A01` RVOL 10, buy-and-hold | 100 | 1,145 | 3 | 3,800 | 0 |
| `A02` RVOL 10 ∧ 20 ∧ 50 ladder | 100 | 2,460 | 3 | 3,800 | 0 |
| `A03` RVOL 50 ∧ SMA 200D | 100 | 8,014 | 4 | 3,800 | 0 |
| `A04` RVOL ∧ RSI three-level ladder | 100 | 23,648 | 3 | 3,800 | 0 |
| `A05` insider buyer ladder | 100 | 22,936 | 22 | 3,800 | 0 |
| `A06` insider value ∧ CEO/CFO ∧ SMA 50D | 100 | 4,882 | 36 | 3,800 | 0 |
| `A07` congress purchases ∧ buyers | 100 | **286,488** | 2 | 3,800 | 0 |
| `A08` chamber / owner / named-member scopes | 100 | 3,754 | 3 | 3,762 | 2 |
| `A09` actor group ∧ RVOL 20 | 100 | 6,827 | 3 | 3,800 | 0 |
| `A10` valuation ∧ RVOL ∧ 250-session windows | 100 | **39** | **92** | 3,800 | 0 |

`A02` is the one to note: its strongest BUY is `RVOL 10 above 2 AND RVOL 20 above 2 AND RVOL 50 above
1.5`, two rows at the same threshold differing only by period. Before `d4ce4aa2` that definition was
refused at validation as a duplicate condition and could not have been submitted at all. It now runs
1,000 times.

## 5. Data-correctness findings

Two product defects, three test-infrastructure defects, one hardening. Full detail in `FINDINGS.md`.

- **F-01 (high, product).** Insider ingestion stopped after page 0 whenever a page held rows the
  mapper drops. AAPL: **956 rows and a 2018-08-18 coverage floor** where the provider holds **5,956
  back to 2003-05-28**. Fixed by paging on the provider's own row count; both dataset variants bumped
  to `v2` so wrong coverage self-heals.
- **F-02 (high, matrix).** Retention could not see 1,006 runs from a previous fixture owner; the
  resulting 1,982 MB of bloat expired progress-checkpoint transactions and failed four correct
  backtests in 59 cases. Fixed, plus one `VACUUM (ANALYZE)` after cleanup.
- **F-03, F-04 (matrix).** `ALT_DATA_FRESHNESS_MS` unpinned, and no alternative-data tables
  provisioned — together these would have produced a thousand green runs that tested nothing.
- **F-05 (hardening).** Provider rows bound to the requested security without checking the payload's
  symbol. Probed live pages 0–60 on both domains: never observed. Now dropped and reported.
- **F-06 (medium, product, not changed here).** A progress checkpoint runs inside Prisma's **default**
  5,000 ms interactive transaction; when it expires the whole run fails. Diagnosed and quantified;
  the fix is a durability-semantics change to the job-claim protocol and belongs in its own change.

Verified clean across the persisted universe:

| Check | Rows | Result |
| --- | --- | --- |
| `availableFromDate` = publication + 1 day | 188,969 | **0 violations** |
| Zero or absent price producing a transaction value | 179,782 | **0** |
| Amount lower bound equal to the band's midpoint | 9,187 | **0** |
| Amount band with no readable figure | 9,187 | **0** |
| Asset class / chamber / owner / kind partitions | 9,187 | all sum exactly |

## 6. PIT / look-ahead findings

**No look-ahead was found.** The evidence is of four kinds.

1. **Every row.** `availableFromDate` is publication + 1 day on all 188,969 persisted rows, and the
   store filters on that column alone — the transaction and disclosure dates never appear in a
   `where` clause.
2. **Every projected value.** 4,221,571 column comparisons against an independent oracle that places
   each disclosure at the first session on or after its availability date: **0 failures**.
3. **Leave-one-out.** Rebuilding the engine's column with one disclosure removed must leave every
   session *before* its observable session identical: **0 violations**.
4. **Hand-checked on real filings.** AAPL, two filings, read session by session — the filing date
   uncredited on its own day; a Saturday availability rolling to **Tuesday** across Labor Day with no
   holiday calendar in the evaluator; eight fills counting as two buyers; and three purchases made in
   2006 and early 2007 counted on 2007-10-29, twenty months later, because that is when the filing
   appeared.

The chunk boundary is covered by its own property test: a calendar-year window widened by
`requiredAlternativeDataLeadingSessions` produces values identical to a whole-period frame for every
aggregation at lookbacks 20, 90 and 250, and reports NOT_EVALUABLE when the widening is two sessions
short — so the agreement is a property of the widening rather than of the data.

**Why the rule matters, measured.** Across 8,782 congressional stock disclosures the mean
transaction → disclosure lag is **78 days** and **3,482 (39.6%) exceed 30 days**. The default lookback
is 30 sessions, so a metric windowed on the transaction date would never see two-fifths of the data
while looking correct.

## 7. RVOL correctness

**Two independent recomputations, both exact.**

PostgreSQL window functions over every persisted row of the 33 matrix securities:

| | rows compared | absence mismatches | value mismatches | max abs difference |
| --- | --- | --- | --- | --- |
| `rvol10` | 259,735 | 50 (O-02) | **0** | 5.0e-9 |
| `rvol20` | 259,735 | **0** | **0** | 5.0e-9 |
| `rvol50` | 259,735 | **0** | **0** | 5.0e-9 |

The TypeScript oracle inside the audit harness, over the product horizon:

| | compared | failed | max abs difference |
| --- | --- | --- | --- |
| `rvol10` / `rvol20` / `rvol50` | 234,435 each | **0** each | 5.0e-9 |

5.0e-9 is exactly half a unit in the eighth decimal, which is what `Decimal(20,8)` quantizes to. **0
period collisions.**

**Warm-up is exact**, counted from each security's own first bar: `MRNA` produces its first
`rvol10`/`rvol20`/`rvol50` on sessions **11 / 21 / 51** — ten, twenty and fifty prior sessions and
then a value, never one fewer.

**The data had to be repaired first.** Only 44,292 of 259,696 derived rows carried RVOL and three
securities had none, because the r6 revision is rebuilt lazily and the last read for most securities
was a bounded Monitor window. `pnpm data:resync --matrix --from 1992-01-01` — the canonical
self-healing path — took it to 259,355. The 50 remaining `rvol10` absences are O-02: two rows per
long-history security on 1992-09-23/24, before the 34-year retention boundary and 3.5 years outside
the 30-year product horizon, which `projectionRange` clips every read to.

**Period identity** is exercised directly by `A02`, whose strongest BUY names all three periods with
two of them at the same threshold — a definition the pre-fix code refused as a duplicate condition —
and whose two BUY levels differ only by period. Fixture tests require distinct Signal fingerprints
within a Strategy and distinct definition fingerprints across the whole matrix.

## 8. Insider correctness

| | |
| --- | --- |
| Rows ingested | **179,782** across 33 securities |
| Coverage floor | 2003-05-28 for most securities — Form 4 electronic filing became mandatory in June 2003 |
| Open-market purchases | **1,431** |
| Awards / option exercises / dispositions / gifts / conversions | 45,962 / 44,336 / 16,941 / 5,503 / 1,060 |
| Rows classified `OTHER` | 2,459 (1.4%) |

The classification is load-bearing: **only 0.8% of rows are discretionary purchases**, so an
implementation reading "acquisition" as "buy" would inflate an insider-buying signal by two orders of
magnitude. `P` and `S` alone are open-market; everything else is excluded.

Roles: 91,699 rows carry **more than one** role, so the multi-role model is necessary rather than
theoretical; only 248 rows (0.14%) state nothing recognizable. Directors are 1,147 of the 1,431
open-market purchases.

Identity is the reporting CIK, never the name — and the data proves why: one CIK carries several
display names, including `SMITH JOSHUA T` / `Smith Joshua I`, a typo in the provider's own field.
O-04 records the converse risk: one of 2,158 CIKs is unpadded, which would count one person as two.
It is a single `AWARD` row and no measure counts an award, so the blast radius today is zero counted
rows.

Value: a zero or absent price yields **no** value rather than a $0 purchase, verified on every row.
O-05 records 11 stored values one unit in the last place low from float64 multiplication before
`Decimal(24,4)` quantization — always low, never high, maximum error $0.0001.

## 9. Congress correctness

| | |
| --- | --- |
| Rows ingested | **9,187** (8,782 stock) across 33 securities and 217 actors |
| Coverage floor | 2014, the STOCK Act disclosure era |
| Chambers | HOUSE 6,878 · SENATE 1,904 — partitions exactly |
| Owners | UNSPECIFIED 3,566 · SPOUSE 2,890 · JOINT 1,876 · SELF 313 · DEPENDENT 137 — partitions exactly |
| Kinds | SALE 4,399 · PURCHASE 4,364 · EXCHANGE 19 — partitions exactly |
| Non-stock rows kept and never counted | 405 |

Chamber and owner filters compose without leaking: on a real MSFT session an unfiltered
`Congress purchases 30D` of 6 splits into House 4 + Senate 2, with 4 distinct buyers. Amount bands
store their own bounds and never a midpoint; every band parsed. `EXCHANGE` is counted by no measure.

Actors are identified by bioguide id; no two of the 217 share a display name, and a rename cannot move
a group's membership.

**R-01**: only 3.6% of disclosures name `Self` and 40.6% name no owner, so an owner filter of `SELF`
is near-empty on this provider's data. Correct semantics — a filing that names no owner has not said
the member holds it personally — but invisible from the condition row and worth help text.

## 10. Backtest / ledger invariants

Sweep A: **37,962 invariant checks passed, 0 indeterminate**, and the only two failures are the
"reaches COMPLETED" / "no failure metadata" pair on the F-06 case. The 37 database invariants cover
cash never negative, positions within `maximumPositions`, one symbol one slot, `cash + positions ==
total`, `amount == shares × price`, BUY only inside the buy window, contribution schedule, benchmark
funding and reconciliation, BUY sizing, strongest eligible level, SELL fraction and lifecycle, FINAL
EXIT closure, no same-date re-entry, average-cost basis, realized and unrealized P&L, final positions,
summary reconciliation, trade and position counts, no trading before listing, and no warm-up date
simulated.

Invariants 36–38 — the three a database cannot answer — were proven from the forensic archive on all
6 golden combinations, **3/3 each**. The verifier now resolves Relative Volume and alternative-data
operands through the canonical operand builders; before this branch it returned no series for the
alternative-data metrics, which would have reported every BUY an audit strategy made as unjustified.

## 11. Determinism results

- Sweep A: **0 differences** across 6 golden re-executions, comparing every persisted column of every
  trade, equity row, position and summary.
- Provider requests: **0** in warm-up, sweep and rerun ledgers alike — so the two executions read the
  same data by construction, not by luck.
- Re-ingesting the same alternative-data history is a no-op: rows are content-addressed, and a second
  `ensureIngested` made **0 provider requests** and inserted nothing.

## 12. Monitor parity

The Monitor recomputes the daily families over a bounded window while a backtest reads persisted
values, so the two are genuinely different code paths and parity is a real question.

- Relative Volume: a frame holding all three periods reproduces each period's canonical materialized
  value to 12 decimal places, the three columns are required to differ from one another, and the
  provisional session's value equals the live volume over each period's own baseline.
- Alternative data: one shared implementation. `buildAlternativeDataColumn` is the only thing that
  turns disclosures into a column, and the Monitor frame projects through the same
  `projectEvaluationFrame` as a backtest window; the existing suite pins that a provisional session
  reads what a backtest would and that the window widens to fit the lookback.

**O-03** records a coupling worth knowing: `coverage.to` is the calendar date of the last ingest and
the freshness window is twelve hours, so a Monitor cycle running before that window elapses finds
today's provisional session outside coverage and reports NOT_EVALUABLE. Correct by the stated rule;
undocumented as an interaction.

## 13. Bugs found

| | Severity | Area | Status |
| --- | --- | --- | --- |
| F-01 insider ingestion truncated at page 0 | High | Product — data completeness | **Fixed** |
| F-02 matrix retention blind to a previous owner; bloat failed live runs | High | Test infrastructure | **Fixed** |
| F-03 `ALT_DATA_FRESHNESS_MS` unpinned in the matrix | High (audit validity) | Test infrastructure | **Fixed** |
| F-04 alternative-data tables not provisioned | Medium | Test infrastructure | **Fixed** |
| F-05 provider rows bound without a symbol check | Low (latent) | Product — hardening | **Fixed** |
| F-06 checkpoint transaction can fail a correct run | Medium | Product — reliability | **Documented, not changed** |
| Case identity dropped the strategy dimension | Medium | Test infrastructure | **Fixed** |
| Archive verifier could not resolve alternative-data operands | Medium | Test infrastructure | **Fixed** |

## 14. Fixes made

`FmpProviderPage` carries the payload's own row count and both ingest walks page on it; the insider
and congress dataset variants are `v2`. The matrix retention predicate names the set of test personas
and the whole reserved prefix, and cleanup is followed by `VACUUM (ANALYZE)`.
`ALT_DATA_FRESHNESS_MS` is pinned wherever the other dataset freshnesses are. Provisioning mirrors
`AlternativeDataActor`, `InsiderTransaction` and `CongressTrade`. The ingest drops and reports rows
carrying a foreign symbol. Case identities carry their strategy letter and the golden set re-letters
onto the selected dimension. The archive verifier resolves the new metric families through the
canonical operand builders.

## 15. Tests added

- `alternative-data.integration.test.ts` — a full provider page with unmappable rows keeps paging; a
  genuinely short page still stops; the same for congressional disclosures; a foreign symbol is never
  bound to this security and never moves its coverage floor.
- `alternative-data.test.ts` — chunked calendar-year windows agree with a whole-period frame for every
  aggregation at lookbacks 20/90/250; NOT_EVALUABLE when the widening is short; a disclosure counted
  once across overlapping windows.
- `monitor-frame.test.ts` — all three RVOL periods in one frame, each equal to its own canonical value
  and required to differ from the others, closed and provisional.
- `backtest-actor-group-resolver.test.ts` — the worker resolves a group from the snapshot, answers an
  unknown group with no members rather than a database read, and never lets one group answer for
  another.
- `matrix-cleanup.integration.test.ts` — a previous owner's run is selected only when that owner is
  named; an audit-variant run is retained.
- `matrix-case.test.ts` — the audit dimension enumerates its own thousand, disjoint from the core's;
  an audit case identity keeps its letter; the golden set re-letters.
- `matrix-archive.test.ts` — Relative Volume reads its own period's column and not another's; insider
  and group-scoped congressional Conditions resolve; absence is never a TRUE; a missing column fails.
- `qa-matrix-audit-fixtures.test.ts` — the ten audit fixtures validate, normalize, carry distinct
  fingerprints, hold two same-threshold RVOL rows in one Signal, and cover every metric family.
- `oracle.test.ts` — hand-computed vectors for the Relative Volume reference (including AAPL's first
  stored value from its own persisted volumes) and for availability, observable session, window
  aggregation, coverage, classification and amount bands.

## 16. Exact gate results

| Command | Result |
| --- | --- |
| `pnpm lint` | **PASS** |
| `pnpm typecheck` | **PASS** — every package and app |
| `pnpm db:validate` | **PASS** |
| `pnpm db:test:prepare` | **PASS** — no pending migrations |
| `pnpm build` | **PASS** |
| `pnpm openapi:validate` | **PASS** — 60 paths, OpenAPI 3.1 valid |
| `pnpm test` | **4,165 of 4,166 passed**, 284 files, **1 failure** |

Per package:

| | files | tests |
| --- | --- | --- |
| `config` | 2 | 67 |
| `domain` | 7 | 118 |
| `contracts` | 13 | 316 |
| `valuation` | 9 | 38 |
| `fmp` | 3 | 80 |
| `strategy` | 13 | 270 |
| `stock-data` | 30 | 523 (1 flake) |
| `web` | 106 | 1,139 |
| `api` | 86 | 1,378 |
| `worker` | 15 | 237 |

**The one failure and how it was classified.**
`redis.integration.test.ts > cross-process canonical hydration > uses one FMP delta for two service
instances with different projections`, `Error: Test timed out in 5000ms`.

- It is a **timeout**, not a wrong value and not a failed assertion.
- Run **standalone** with its sibling file: `2 files, 37 tests, all passing`.
- Across two full-suite runs the failing subset **moved** — the first run also failed
  `provider-reuse.integration.test.ts`, which passed in the second. A defect does not alternate;
  contention does.
- The timeout was **not raised**, the test was **not skipped**, and nothing was weakened to make the
  gate green.

`pnpm lint` also caught one real problem during the audit, and the guard deserves naming:
`fmp-gate-coverage.test.ts` pins the exact set of files permitted to construct the shared
`RedisFmpRequestGate`, "listed rather than counted, so adding a process is a deliberate edit here".
The new `data:alt-data:ingest` command is a legitimate sixth root — paging a decade of Form 4 filings
for thirty-three securities is exactly the job most likely to starve a live read — so it was added to
the list rather than exempted.

The matrix is not part of `pnpm test` and was run explicitly; its results are sections 3 and 4.

## 17. Remaining risks and provider limitations

- **F-06** is unfixed and can fail roughly one run in a thousand under concurrency.
- **O-03**: a Monitor cannot evaluate an alternative-data metric on a session newer than the last
  ingest, and the twelve-hour freshness window makes that a real interval each morning.
- **R-01**: an owner filter of `SELF` selects 3.6% of disclosures.
- **Coverage is a floor, not history.** `ALT_DATA_MAX_PAGES_PER_INGEST` bounds a cold ingest at twelve
  pages; `CRM` reaches 2019 and `GOOGL` 2018 where most securities reach 2003. Earlier sessions are
  NOT_EVALUABLE, never zero.
- **Provider anomalies**: 12 rows dated as filed before the transaction they report, including a
  transaction dated 2027-01-25; one unpadded reporting CIK (O-04); end-of-day volumes revised after
  the session (O-06).
- **O-02**: derived rows outside the current retention window keep whatever methodology last wrote
  them. Coverage, not the row, is the guard, and `projectionRange` keeps them unreachable.
- Two same-day disclosures by one actor identical in every meaningful field collapse into one row.
  Deliberate and documented; the alternative is a row count that grows on every reingest.

## 18. Merge-ready

**YES for this branch**, with F-06 recorded as a pre-existing defect that should be fixed next and is
not a reason to hold this work.

The verdict rests on independent verification of the data and the outputs, not on the gate:

- **Relative Volume is exact.** Two independent recomputations — PostgreSQL window functions and a
  decimal-arithmetic oracle — over every persisted row of all 33 securities. 259,735 rows × 3 periods,
  **zero value mismatches**, maximum difference 5.0e-9, which is exactly the storage quantum. Zero
  period collisions. Warm-up exact at sessions 11 / 21 / 51.
- **Point-in-time correctness holds.** Availability is publication + 1 day on all **188,969** rows;
  **4,221,571** projected column comparisons against an independent oracle with **zero** failures,
  absence compared exactly on both sides; a leave-one-out test finds **zero** disclosures affecting
  any session before they were observable; and two real filings trace correctly by hand, including a
  Saturday availability rolling across Labor Day and a purchase counted twenty months after the trade.
- **The engine is sound under both matrices.** 2,000 runs, **75,924 invariant checks passed, zero
  engine-invariant failures, zero indeterminate**, 12 archives with all 36 frame-level invariants
  proven, **zero determinism differences**, **zero provider requests**.
- **The group freeze is real.** Emptying the live group takes a run from 328 trades to zero;
  restoring it reproduces the result byte for byte.

What merging changes for the better is concrete: F-01 alone recovers fifteen years of insider history
per security that the product previously reported as NOT_EVALUABLE, and the variant bump makes every
already-ingested security self-heal.

**F-06 is the one open defect and it is not this branch's.** A progress checkpoint runs inside
Prisma's *default* 5,000 ms interactive transaction; under concurrency it can expire and fail a run
that computed everything correctly. It fired twice in 2,000 runs (0.1%), on `S08` and on `A08` —
different strategy dimensions, lists and configurations, one shared bookkeeping write — and both cases
reproduce green in isolation. It predates this work and is unrelated to Relative Volume and
alternative data. It is left unfixed deliberately: the remedy is a change to the worker's durability
semantics and the durable job-claim protocol `AGENTS.md` invariant 14 fixes, which deserves its own
change with its own tests, and the audit's own rule is not to move a timeout to make a gate green.

Both matrix gates therefore read NOT GREEN, and in both cases every unmet condition traces to that
single case. That is the honest state: the engine is correct, and one non-correctness-critical write
is fragile under load.

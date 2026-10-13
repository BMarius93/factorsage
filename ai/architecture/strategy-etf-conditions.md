# Strategy ETF Conditions — Architecture Audit and Implementation Plan

## Status

**Phase 1 architecture audit, revised with the owner's final decisions (2026-10-13). Ready to
implement; no application code has changed on this branch.**

`docs/decisions/strategy-etf-conditions-v1.md` is the accepted product decision and acceptance gate;
this document is the technical design derived from it, in the role `strategy-builder.md` played for
the Create/Edit Strategy slice. The owner's rulings incorporated here, verbatim in intent:

| # | Decision | Ruling |
| --- | --- | --- |
| 1 | Monitor intraday behaviour | **Strict same-session alignment.** An ETF condition for the current session is `NOT_EVALUABLE` until the ETF's EOD bar has genuinely finalized **and been refreshed** — a publication-delay clock alone is not evidence. No carry-forward of yesterday's value. |
| 2 | ETF data acquisition | **Provider-free during evaluation.** Backtest and Monitor read through `BenchmarkHistoryReader` only; Redis loss rehydrates from PostgreSQL; missing coverage is unavailability with useful diagnostics, never fake data. Bootstrap and the market-data refresh child own hydration. |
| 3 | Source identity | **Stable internal benchmark codes** (`SP500`, `ETF_XLK`, …); ticker is display only. A drift-tested contracts projection of the existing catalog; the immutable `benchmarkSeriesId` is resolved and pinned where reproducibility needs it. |
| 4 | Source location | **Optional `source` on the four compatible technical metric variants.** Absent = Stock, byte-identical to today. Survives normalization, serialization, duplication, versioning, descriptions and execution; rejected on every incompatible metric; source-aware identities and fingerprints with Stock-only fingerprints unchanged. |
| 5 | Snapshot versioning | **Revised: FactorSage is pre-launch, no mixed worker deployments.** No snapshot version bump for old-worker compatibility. §6 below records what *is* required for correctness and why a version bump is not. |
| 6 | Numeric precision | **Reuse the existing methodology; do not invent an 8-decimal quantization convention.** Prove parity on identical OHLCV inputs; include comparison/crossing boundary tests. |
| 7 | Weekly historical calculations | **Conservative design**, investigating both catalog inception metadata and durable coverage; no inference from the earliest bar alone; no global disabling of weekly metrics; deterministic boundary fixtures. §5.4. |
| 8 | Picker naming | Canonical catalog names and display metadata; the accepted popup regrouping; no duplicate dictionaries. |
| 9 | Unavailability diagnostics | **Revised:** no per-date persisted reason rows, but ETF evaluation failures must be user-visible as actionable aggregates, not log-only. Tri-state semantics unchanged; no large new persistence model. §7. |

Everything in §2–§4 below is **verified codebase fact** (file references are to `main` at
`3ff81cae`); §5–§9 are the architectural proposals built on those facts. Assumptions still open are
marked as such in §11.

---

## 1. What is being built

A Strategy Condition may name one of the twenty Dashboard ETFs as its evaluation source. The
condition is then evaluated against that ETF's own historical OHLCV — the actual fund's data (SPY
the ETF, via the existing `SP500` series; never `^GSPC`) — identically for every candidate stock on
the same eligible session. Exactly 21 existing technical metric identities are compatible per ETF
(Price; 7 daily + 7 weekly moving averages; RSI 7/14/21D; RVOL 10/20/50), with their existing
operators, value domains, warm-up and methodology. Every other metric family is rejected for ETF
sources. ETF-sourced **Triggers are excluded**. BUY, SELL and FINAL EXIT all accept ETF Conditions
under the unchanged grammar. No ETF positions, no sector matching, no new operators or families, no
new provider traffic, no second storage.

## 2. Verified current state (the audit)

### 2.1 Strategy model and registry — `packages/contracts/src/strategies.ts`

- One canonical model and compatibility registry shared by Builder, API, Monitor and worker
  (invariant 11). Metrics are a kind + parameter union (`strategies.ts:160-177`); conditions are
  `{id, metric, operator, value}` (`:255-267`). **No source dimension exists anywhere** — not on
  metrics, predicates, `SERIES` values, operand keys, fingerprints or OpenAPI schemas.
- Validation is hand-written and strict: `PREDICATE_KEYS` (`:2328`) and per-kind `METRIC_KEYS`
  (`:2330-2350`) refuse unknown fields, so a forged `source` fails today with `UNKNOWN_FIELD`.
- Normalization **rebuilds** documents field by field: `buildSignal` (`:3706-3724`) and
  `buildMetric` (`:3655-3684`) would silently drop any unhandled field on every create, read,
  duplicate, Monitor cycle and backtest submit.
- Fingerprints (`signalFingerprintValue`, `:3896-3958`) serialize each metric as a fixed tuple and
  append extra elements only for the kinds that need them; the stability rule is documented in the
  code, golden literals are pinned in tests
  (`strategies.alternative-data.test.ts:701-739, 1402-1530`; the 5,760-case
  `fingerprint-corpus.ts`), and `definitionHashOf` and every Monitor latch hang off them.
- Duplicate detection (`predicateIdentity`, `:3059-3091`) and the picker key (`strategyMetricKey`,
  `:833-854`) are source-blind today.
- PRICE's Value spec is `PRICE_COMPARABLE_SERIES` — the 14 moving averages **plus the 7
  intrinsic-value series** (`selectable-series.ts:487-490`), which must narrow for ETF sources.
  `comparableMovingAverages` (`:522-536`) already encodes same-timeframe/never-itself.
- The ACTORS precedent (commit `4e8a0fa7`): an optional identity extension shipped without a schema
  bump, serialized so legacy shapes stay byte-identical, with the strict key sets and a conditional
  snapshot version as the fences.

### 2.2 Evaluation engine — `packages/strategy` + `packages/stock-data`

- The engine is positional over a per-security `EvaluationFrame` (`frame.ts:17-27`): the stock's
  own session axis, `Float64Array` columns keyed by operand strings (`price`, `series:<id>`,
  `relative-volume:<p>`), NaN the only absence, strong-Kleene AND/OR (`evaluability.ts:27-81`).
- `PRICE` is hard-wired to `frame.closes` (`frame.ts:38-40`) and `valueOperand` always emits a
  stock `series:` key (`operands.ts:201-203`). `metricOperand` (`operands.ts:174-198`) is an
  exhaustive switch **with no default**: an unknown kind yields `undefined`, the column read yields
  NaN, and the rule silently never matches — the worker does not revalidate snapshots
  (`run-snapshot.ts:45-51`), refusing only unknown snapshot versions, undefined operators and
  undefined congress scopes.
- The stock frame projector throws on an unknown operand key (`evaluation-frame.ts:273`), and the
  Monitor's warm-up sizing decodes only stock key families (`monitor-frame.ts:137-175`) — safe,
  explicit failure points, not silent ones.
- Alternative data and valuation ratios are the precedent for frame columns built from separately
  loaded inputs and joined onto the stock's date axis (`evaluation-frame.ts:165-204`).
- Gates are precomputed per level per security (`gates.ts`), year windows copy every column across
  the boundary (`window.ts:99-181`), and `openWindow` checks `frame.securityId === setup.securityId`
  (`simulation.ts:426`).

### 2.3 Technical calculation — `packages/stock-data`

- The kernels are pure and reusable as they stand: `movingAverage` (`technicals.ts:9-54`),
  `calculateWilderRsi` (`oscillators.ts:26-64`), `calculateRelativeVolume`
  (`relative-volume.ts:31-82`), `aggregateCompletedWeeks` + `calculateWeeklyTechnicalValues`
  (`weekly.ts:50-148`), composed by the pure `buildDailyDerivedState` (`derived-state.ts:114-170`),
  which with prices + weekly bars alone produces exactly the 21 ETF-eligible fields.
- The coupling is orchestration, not formulas: the bar type carries `securityId`, the weekly
  LISTING/HORIZON rule reads `Security.ipoDate` (`service.ts:3309-3317`), and persistence/cache are
  Security-keyed with foreign keys and the `stock-data:v2` namespace.
- The stock methodology anchors every calculation at the **earliest persisted bar** (AUD-02,
  `service.ts:2042-2081`); EMA, Wilder RSI and the first weekly bar are anchor-sensitive.
- Independent oracles already exist (`moving-average-oracle.test-helper.ts`,
  `wilder-rsi-oracle.test-helper.ts`, `apps/api/src/data-correctness-audit/oracle/`).
- Stock frames read `DECIMAL(20,8)`-quantized persisted values; the Monitor already evaluates
  **unquantized in-memory** daily recomputations beside them (`monitor-frame.ts:413-437`) — the
  established precedent for evaluation-time calculation precision.

### 2.4 Benchmark data — storage, reader, refresh

- `BenchmarkDailyPrice` stores full OHLCV **including volume** end to end (FMP `finiteNumber`
  check → `BigInt` column → the Redis chunk's `x` column), so RVOL needs no new dataset.
- `BenchmarkHistoryReader` (`benchmark-ports.ts:341-364`) is the provider-free read boundary:
  rows + `basisGeneration` + `missing`, resident `benchmark:v1:*` head/chunks, rebuild-under-lock
  from PostgreSQL on Redis loss, PostgreSQL fallback. `BenchmarkDataService` adds
  `benchmarkRefreshState` (coverage, latest bar, `lastTailSyncAt`) and the hydrating methods.
- **No derived, weekly or technical storage exists for benchmarks at any layer**, and the policy is
  stated in seven places (§8). The benchmark series has no listing-date column; the catalog carries
  `listedIn` (month granularity) per ETF (`market-overview-etfs.ts:40-54`).
- The bootstrap loads each ETF from `MARKET_OVERVIEW_HISTORY_FLOOR` (1993-01-01), so pre-inception
  is recorded as **covered and empty**; `missing` never flags pre-inception, and a floor-anchored
  coverage interval is durable proof that the first stored bar is the genuine start of the
  provider's history.
- The provider lists the in-progress session, and provisional same-day bars **can be stored**
  (`market-data-refresh.ts:14-16`; `benchmark-service.ts:504-535, 581-594`). Only
  `GET /market-overview` filters them, via the finalized-session + `lastTailSyncAt` rule
  (`market-overview.ts:82-115`); the reader itself does not.
- Tail corrections overwrite bars **without** a generation bump (`etf-market-data-v1.md` §7);
  re-bases replace the whole history under generation+1 with the Redis fence raised first.
- The backtest worker's benchmark port (`backtest-processor.ts:122-139`) is **hydrating** (can
  reach FMP) and reads exactly the run period; the Monitor worker composes **no** benchmark service
  at all; benchmarks are end-of-day only — there is no live ETF quote path, and today's bar lands
  ~16:30–16:40 ET at the earliest.

### 2.5 Backtest and Monitor engines

- Snapshot versions: `backtestSnapshotVersionFor` writes the lowest version able to express a
  definition (2 only for `ACTORS`); `canonicalBacktestSnapshotDocument` deep-sorts and drops
  `undefined`, so an absent optional section leaves `snapshotHash` byte-identical. Adding a key to
  `BACKTEST_DATA_REVISIONS` or `BACKTEST_METHODOLOGY` refuses **every** queued run in both
  directions (`revisionMismatches`, `backtests.ts:989-1028`) — not an option for an ETF-only
  feature.
- Monitor: one cycle-scoped quote batch, per-security operand aggregation, per-symbol snapshots,
  the pure lifecycle reducer; `NOT_EVALUABLE` moves nothing (an ACTIVE Signal stays latched;
  nothing opens), only a real observation advances a trigger-only event; fingerprint change =
  logic-change reset + reconstruction for exactly that level. Reconstruction replays from the
  latest *resting* session with doubling history reads; `NOT_EVALUABLE` sessions are not resting
  (`monitor-lifecycle.ts:451-459`), so long undecidable stretches deepen reconstruction reads.
- Trade reasons and Dashboard reasons are derived at read time from the definition through
  `describeCondition`/`strategyMetricLabel` — one label function serves every surface.
- `BenchmarkCursor` carries the last close forward for valuation (`benchmark.ts:15-45`); it must
  **not** be reused for conditions.

### 2.6 Builder UI and API

- The Metric picker is `OperandPicker`/`MetricPicker` (PR #93): one component, desktop popover +
  phone bottom sheet; `tallestHeight()` sizing causes the oversized blank panel §4.4 of the
  decision bans; resets on metric change are silent; keyboard support is Tab-only. The alt-data
  Configure dialog and `ActorCombobox` are the precedents for per-condition configuration UI.
- Web may import only `@intrinsic/contracts`; the 20-ETF vocabulary lives in `@intrinsic/domain`
  and reaches the browser today only through the `/market-overview` payload — a returns read model
  that can be partial or unavailable, unusable as the validator's static vocabulary.
- `openapi.strategy-schema.test.ts` walks every offered metric option against `docs/openapi.yaml`
  (closed objects), so new ETF options are exercised automatically once the document is updated.
- Hermetic E2E exists with Builder helpers (`apps/web/e2e/utils/strategy-builder.ts`); the desktop
  spec pins exact category tile counts that the regrouping will change. QA/E2E ETF fixtures seed
  only **64 weeks** for the 19 `ETF_*` series — insufficient for the 100W/200W metrics.

## 3. Required narrow amendments (documentation and stated policy)

The decision's anticipated conflict, resolved as: **benchmark technicals are computed at evaluation
time from stored benchmark OHLCV through the one stock calculation methodology, and are never
persisted, never cached in a new namespace, never a new provider path, and never make a benchmark a
`Security`.** The storage half of every statement stays true. Amend, in the implementation branch:

1. `AGENTS.md` invariant 13 — "carrying no derived series" gains the evaluation-time clause.
2. `ai/architecture/benchmark-data.md` (lines 7–13) — same clause.
3. `packages/domain/src/benchmarks.ts:3-14` and `:116` doc comments.
4. `packages/database/prisma/schema.prisma:793-803` dataset/model comments.
5. `packages/stock-data/src/benchmark-service.ts:201-203` and `benchmark-ports.ts:42-49` comments.
6. `apps/worker/src/backtest/composition.ts:177-181` comment.
7. `ai/product/strategies.md` — the compatibility table gains the ETF-source column/row rules, and
   § "Authoring a rule" is updated for the accepted picker regrouping (the 2026-10-13 decision
   supersedes the 2026-10-11 nine-category picker, for Stock and ETF alike).
8. `docs/openapi.yaml` — Strategy metric schemas, new validation codes, backtest
   response additions (§7).

## 4. Final architectural design — how ETF data flows

```text
MARKET_OVERVIEW_ETF_GROUPS (@intrinsic/domain)          [existing]
   │  drift-guard test (apps/api)
   ▼
STRATEGY_ETF_SOURCES (@intrinsic/contracts)             [new: code, ticker, label, group]
   │  names a source in a Condition's metric: { kind, …, source: { kind:"ETF", code } }
   ▼
API submission (backtests)                              resolve code → current benchmarkSeriesId,
   │                                                    pin {code, seriesId, basisGeneration} in the
   ▼                                                    snapshot's optional etfSeries section
Worker (backtest prepare / Monitor cycle)
   │  one read per distinct ETF per run/cycle:
   │  BenchmarkHistoryReader.readFullBenchmarkHistory   [existing, provider-free]
   │  + benchmarkRefreshState                           [existing]
   ▼
benchmark-technicals.ts (@intrinsic/stock-data)         [new, read-only adapter]
   │  finalized-session truncation → anchored kernels   (same movingAverage / calculateWilderRsi /
   │  (daily + completed-week aggregation + RVOL)        calculateRelativeVolume / weekly path,
   │  → EtfTechnicalContext: per ETF,                    via buildDailyDerivedState)
   │    date → {close + 20 indicator values}, Float64
   ▼
Frame projection                                        ETF columns joined onto EACH stock frame's
   │  own session axis by exact date (etf:<code>:…      operand keys; absent session = NaN)
   ▼
@intrinsic/strategy evaluator                           unchanged: positional reads, strong-Kleene
                                                        AND, gates, windows, Monitor reducer
```

Key properties:

- **One methodology, two sources.** The adapter feeds benchmark bars (via a bar adapter over
  `seriesId`) through the exact kernels and the exact weekly completed-bar path stocks use. No
  second formula, no new rounding convention (Decision 6): values are the kernels' doubles, the
  same convention the Monitor's in-memory recomputation already established.
- **Computed once per distinct ETF per backtest run / Monitor cycle** — never per candidate stock,
  never per condition. The context is process memory for the run/cycle; nothing is persisted or
  cached across runs, so there is no new invalidation surface: a re-base or tail correction is
  simply picked up by the next run/cycle's read, and one `readFullBenchmarkHistory` is internally
  consistent (one publication or one `REPEATABLE READ` snapshot, with its `basisGeneration`).
- **Finalized sessions only** (Decisions 1 and 2): the context builder truncates each ETF's bars to
  the latest session whose NYSE close + `MARKET_DATA_EOD_PUBLICATION_DELAY_MS` has passed **and**
  whose series tail was read at or after that instant (`lastTailSyncAt`) — the market overview's
  `completedSessions` convention, which is real synchronization evidence, not a clock. A stored
  provisional bar is therefore never evaluated.
- **Exact-date join, NaN otherwise.** A stock session the ETF has no (finalized) bar for reads NaN →
  `NOT_EVALUABLE` under the unchanged Kleene semantics. No carry-forward, no fall-forward; the
  comparison-benchmark `BenchmarkCursor` is not reused. This covers pre-inception (XLRE 2015-10,
  XLC 2018-06), gaps, warm-up and the intraday Monitor case uniformly.
- **ETF operand keys are their own family** (`etf:<code>:price`, `etf:<code>:series:<id>`,
  `etf:<code>:relative-volume:<p>`), split out of per-security operand collection so they never
  reach stock loading, Monitor warm-up sizing or the stock projector's strict key switch. A `SERIES`
  Value under an ETF-sourced metric resolves against the **same ETF** by construction, since the
  value key is derived from the metric's source.
- **Injection is column injection into each stock frame** (the alternative-data/valuation
  precedent), not a second frame parameter: gates, year windows, context rows, the Monitor reducer
  and the simulation's identity check all work unchanged. The per-window cost is one Float64Array
  per ETF operand per security (~2 KB/year-window/column).

### 4.1 Where it plugs in

- **Backtest** (`backtest-processor.ts`): in `prepare`, after `loadExecutionCalendar` and beside
  `loadBenchmark` — collect distinct ETF sources from the parsed definition, read + compute each
  once, store the context on `PreparedRun`; `loadWindowFrames` passes the per-window ETF column
  slices into frame projection. The worker gains a narrow read-only port
  (`Pick<BenchmarkDataService, "getSeries" | "readFullBenchmarkHistory" | "benchmarkRefreshState">`,
  the `MarketOverviewDataPort` pattern) so the condition path **cannot** hydrate — the existing
  hydrating `BacktestBenchmarkLoader` stays what it is, for the comparison benchmark and calendar
  only.
- **Monitor** (`monitor-cycle.ts`): a cycle-scoped phase after `resolveTradingSessions` and before
  the per-symbol fan-out — aggregate ETF sources across all prepared definitions, read + compute
  once, splice the columns into every symbol snapshot frame (live and reconstruction paths). The
  Monitor composition gains the same narrow port (it has no benchmark service today). A failed ETF
  read degrades those conditions to `NOT_EVALUABLE` with a diagnostic — contained like a symbol
  failure, never a cycle failure like the quote batch, because a quote outage invalidates every
  evaluation while a missing ETF invalidates only the conditions naming it.
- **Monitor intraday consequence (accepted, Decision 1):** during a trading session the current
  observation has no finalized ETF bar, so a mixed Stock+ETF signal is undecidable until the
  evening refresh lands; an ACTIVE occurrence stays latched (existing reducer rule), nothing opens
  intraday, and activation happens on the post-finalization scans. Reconstruction evaluates
  completed sessions and is unaffected. Note: long `NOT_EVALUABLE` stretches are not "resting", so
  ETF levels can deepen reconstruction's doubling reads — bounded by the coverage-floor rule below
  and measured in Phase D.
- **Backtest ending today:** the stock side may evaluate the provider's in-progress last bar (the
  accepted limitation in `ai/product/backtests.md`); the ETF side of a condition is withheld on an
  unfinalized session. The asymmetry is deliberate and follows Decision 1's strictness; it is
  documented and tested rather than smoothed over.

## 5. Contracts design

### 5.1 Source vocabulary

`STRATEGY_ETF_SOURCES` in `@intrinsic/contracts`: twenty entries
`{code, ticker, label, group: {id, label}}` projected from `MARKET_OVERVIEW_ETF_GROUPS` (names and
grouping are the catalog's own display metadata — Decision 8), pinned by a drift test beside
`apps/api/src/stocks/selectable-series-catalog.test.ts` (the `RELATIVE_VOLUME_PERIODS` precedent).
The stored identity is the **benchmark code**; the ticker renders.

### 5.2 The metric field

`source?: { kind: "ETF"; code: StrategyEtfSourceCode }` on exactly `PRICE`, `MOVING_AVERAGE`,
`OSCILLATOR` and `RELATIVE_VOLUME`. Absent means Stock and serializes byte-identically to today.
`METRIC_KEYS` admits the key on those four kinds only, so every other kind — and any forged payload —
is refused structurally; `parseMetric` validates the code against the catalog; `validatePredicate`
refuses an ETF source in a Trigger slot with a dedicated code. New validation codes (names final at
implementation): `SOURCE_NOT_SUPPORTED` (wrong metric kind / Trigger part), `SOURCE_UNKNOWN`
(unknown code). `buildMetric`/`buildSignal` carry the field; `rekeyStrategyDefinition` and duplicate
flow inherit it.

### 5.3 Identity, compatibility, rendering

- `strategyMetricKey` gains a source segment; `predicateIdentity` and `exitRuleIdentity` follow
  (the latter automatically, via the fingerprint serializer) — so `RSI 14D > 50` and
  `XLK · RSI 14D > 50` are distinct conditions and AND-able in one Signal.
- **Fingerprints:** `signalFingerprintValue` appends the source element **only when present**
  (the documented append-only tuple rule), so every stored stock `definitionHash`, Monitor latch
  and the golden corpus stay byte-identical; new ETF literals get pinned beside the existing ones.
- `valueSpecFor(metric)`: ETF Price narrows to the 14 moving averages (no intrinsic series); MA
  values stay `comparableMovingAverages` (same timeframe, never itself) resolved against the same
  ETF; RSI keeps `NUMBER 1..100`; RVOL keeps `MULTIPLE >= 0` and empty `triggerOperators`.
  `checkStrategyValue` becomes source-aware so a source change re-validates the Value.
- `strategyMetricLabel` renders `XLK · RSI 14D` when a source is present — one composition, no
  second label map — so `describePredicate`, trade reasons, Dashboard reasons, the logic preview,
  the collapsed control and validator messages all carry the ETF visibly for free. Help text is
  reworded source-neutrally ("the stock's end-of-day close" → source-aware).
- Menu building (`instancesOf`/`buildMetricOptions`/`METRIC_MENU_BY_LEVEL`) gains the source
  dimension for the picker, and the category metadata gains the accepted regrouping (Technical with
  Price/Moving averages/Oscillators/Volume subgroups; Fundamentals; Valuation; Activity; Position
  where the level admits it) — presentation metadata only, since a category is derived from the
  kind and never stored.

### 5.4 Weekly and anchoring — the conservative rule (Decision 7)

One uniform, verifiable gate: **an ETF's technicals evaluate only over a floor-anchored history** —
the series' durable coverage must begin at or before `MARKET_OVERVIEW_HISTORY_FLOOR`, which is
exactly what the bootstrap establishes and what proves (a) the first stored bar is the provider's
genuine first bar (pre-inception was asked and found empty) and (b) the calculation anchor can never
move backwards later (the AUD-02 instability class). A series without that coverage yields
`NOT_EVALUABLE` for all its technicals, with a diagnostic naming the missing bootstrap — a gate on a
verifiable property, not a disabling of weekly metrics.

Within an anchored history, the weekly path is the stock path: ISO completed weeks, the current week
excluded, `eligibleDate` = the week's own last trading day, carry-forward onto later sessions.
The first stored week is kept as a genuine listing week (`WeeklyHistoryContext` LISTING) because
floor-anchored coverage proves nothing precedes it; the catalog's `listedIn` month corroborates and
a first bar far after it is logged (the bootstrap's `lateStart` convention), never silently
reinterpreted. Deterministic fixtures prove: a mid-week listing week kept; a holiday-shortened week;
an interior gap; 100W/200W warm-up counting completed weeks; prefix no-look-ahead; and a
non-anchored series refusing to evaluate.

RVOL follows the stock rules exactly: prior-session baseline, zero baseline → absent, non-finite
volume poisons its window, `0` is a real reading.

### 5.5 Precision (Decision 6)

ETF values are the kernels' raw doubles — the Monitor's established in-memory convention — with
**no** new quantization. Parity evidence: identical OHLCV histories fed to the stock calculators and
through the benchmark adapter produce bit-identical 21-series output (same functions, proven, not
assumed), plus boundary tests at thresholds (strict `is above`/`is below` at equality, `is close to`
at exactly 2%, warm-up first-value indices). The storage-quantization difference between persisted
stock values and in-memory values is pre-existing (Monitor vs backtest) and documented, not new.

## 6. Backwards compatibility and snapshot strategy (Decision 5)

Pre-launch, no mixed deployments — so no version fence for hypothetical old workers. What **is**
required, and how each guarantee is met without a snapshot version bump:

| Guarantee | Mechanism |
| --- | --- |
| Existing saved strategies stay valid, hashes and latches unchanged | absent `source` = Stock, byte-identical serialization; golden fingerprint tests pin it |
| Existing snapshots retain meaning | no shape change for stock-only runs; `canonicalBacktestSnapshotDocument` drops the absent optional section, so `snapshotHash` is unchanged |
| An ETF condition never silently evaluates against the Stock | the one deployed worker build understands `source`; **and** `metricOperand` keeps no silent fallback for it — the projector throws on an unknown key family it was not given |
| Unknown or unsupported sources fail closed | `refuseUndefinedSources` in `parseRunSnapshot` (the `refuseUndefinedScopes` pattern): any source kind or code the build does not define → `BacktestSnapshotError` before data work; the Monitor already fails closed through full per-cycle normalization (`UNKNOWN_FIELD` → monitor skipped) |
| Snapshot internal consistency | parse asserts: definition names ETF sources ⇔ the snapshot's `etfSeries` section pins each of them; mismatch is refused |
| Reproducibility / series pinning | the snapshot gains an **optional** `etfSeries: [{code, seriesId, basisGeneration}]` section, written at submission (the benchmark/calendar pinning precedent): the worker resolves by pinned `seriesId`, so catalog re-versioning cannot reinterpret a queued or completed run |

**Why no snapshot v3:** the version's only function is refusing a snapshot an older *build* cannot
interpret, and no older build will ever run (owner ruling). `refuseUndefinedSources` is strictly
more precise than a blanket version for any future divergence, and `backtestSnapshotVersionFor`
stays untouched (1, or 2 for ACTORS). Deliberately **no** new `BACKTEST_DATA_REVISIONS` or
`BACKTEST_METHODOLOGY` key either: `revisionMismatches` requires exact key-set equality in both
directions, so a global key would refuse every queued stock-only run at deploy — disproportionate
for a feature whose runs are self-describing through the `etfSeries` section.

**Reproducibility boundary (documented, matching stock semantics):** ETF bars are replace-not-
version. A tail correction (no generation bump) or a re-base (generation bump) between two
executions of one snapshot can change results, exactly as `DERIVED_STATE_REVISION`/
`PRICE_DATASET_VERSION` already can for stocks; the snapshot records the submission-time
`basisGeneration` and the run's diagnostics record the generation actually read, so a difference is
explainable rather than mysterious. Exact re-execution from retained data is not guaranteed today
for stocks and is not claimed for ETF conditions; a run never mixes bases *within* itself (one
consistent read per ETF).

## 7. Unavailability diagnostics (Decision 9)

Tri-state semantics unchanged; no per-date persistence. Aggregates, user-visible:

- **Backtest:** per run, per referenced ETF, counters bucketed by cause — `NOT_BOOTSTRAPPED`
  (coverage floor unmet), `PRE_LISTING`/`NO_BAR` (no session), `WARM_UP`, `NOT_FINALIZED` — plus
  `firstEvaluableDate` per used metric family. Carried in the run's results/diagnostics contract
  (shape finalized with the OpenAPI change) and rendered on the run page, so "why did this rule
  never fire?" has a visible answer. Structured `backtest.etf-context.*` observability events
  alongside.
- **Monitor:** the per-security status already reports `NOT_EVALUABLE`; the detail response gains a
  compact per-ETF availability note for ETF-sourced levels (e.g. awaiting today's finalized XLK
  session / series not bootstrapped), derived from the cycle's context, never persisted. Structured
  `monitor.etf-context.*` events.
- **Builder:** no runtime data in the picker; the metric help explains end-of-day evaluation and
  warm-up in words.

## 8. Module/file impact map

**`packages/contracts`** — `strategies.ts` (types `:160-177`; `METRIC_KEYS` `:2330-2350`;
`parseMetric` `:2728`; `validatePredicate` `:3128`; codes `:2222-2261`; `valueSpecFor` `:892`;
`checkStrategyValue` `:2919`; defaults `:939-1007`; menus `:1076-1265`; keys `:833`, `:3059`;
normalizers `:3655-3724`; fingerprints `:3896-3958`; labels/describe `:1321-1796`; help
`:1833-2040`), new `strategy-etf-sources.ts`, `backtests.ts` (optional `etfSeries` snapshot
section), index exports.
**`packages/strategy`** — `operands.ts` (key family, source-aware `metricOperand`/`valueOperand`,
split `collectOperands`); no evaluator/reducer changes.
**`packages/stock-data`** — new `benchmark-technicals.ts` (bar adapter, finalized-session filter,
coverage-floor gate, weekly context, context builder); `evaluation-frame.ts` +
`monitor-frame.ts` take prepared ETF columns (the alternative-data input pattern); no reader
changes.
**`apps/api`** — `backtests.service.ts` (resolve + pin `etfSeries` at submission),
`strategies.service.ts` (no DB check needed — the catalog is static; confirm in implementation),
drift-guard test, OpenAPI document, run-diagnostics contract.
**`apps/worker`** — backtest: `composition.ts` (narrow read-only ETF port),
`backtest-processor.ts` (prepare-phase context, window slices, diagnostics),
`run-snapshot.ts` (`refuseUndefinedSources`, `etfSeries` consistency); monitor: `composition.ts`
(port), `monitor-cycle.ts` (cycle context phase, splice into snapshots + reconstruction),
detail-response availability note; QA fixtures (`seed-qa-benchmark-data.ts` — extend the 19 ETFs to
≥ 208 synthetic weeks + floor-anchored coverage), `qa-matrix/matrix-archive.ts`,
`data-correctness-audit/oracle/{strategy-model,predicates}.ts` (exhaustive switches).
**`apps/web`** — `MetricPicker`/`OperandPicker` (Data Source step, ETF selector, regrouped
families with expandable Technical subgroups, content-sized height, keyboard/focus),
`strategy-draft.ts` (source transitions, deterministic resets **with visible feedback**),
`PredicateRow`/`ValueControl`/`LogicPreview`/`ExplanationPanel` (labels flow from contracts),
E2E helpers + specs (tile-count assertions updated).
**Docs** — §3 list.

## 9. Performance and caching rationale

No new cache, store or namespace: the context is per-run/per-cycle process memory over the already-
resident `benchmark:v1:*` projection (one `GET` + one `MGET` per ETF when warm), which is the
bounded, restart-correct, revision-correct mechanism the decision requires — correctness under
re-bases and Redis restarts is inherited from the reader rather than re-implemented. Estimated
scale (to be **measured**, not assumed, per the owner's instruction): ≤ 20 ETFs × ~8,300 bars ×
(close + 20 indicator columns) ≈ ~1.4 MB per ETF context; kernels are linear. Phase D delivers
measured evidence: full-history computation time and bytes per ETF, a multi-ETF × multi-stock ×
repeated-conditions run profile, and an assertion that reader calls and computation count scale
with **unique ETFs**, never stocks × conditions. If measurement contradicts the estimate, the
fallback (a per-process memoization keyed by `(seriesId, basisGeneration, lastDate)`) is noted but
not built speculatively.

## 10. Implementation phases and acceptance criteria

All phases land on one implementation branch (stacked, reviewable commits; one PR; never merged
automatically). Pre-launch there are no intermediate deploys, so "saveable before evaluable" cannot
occur in production; the branch is only gated as a whole.

- **Phase A — vocabulary, contracts, calculation adapter (pure; the safest first phase).**
  `STRATEGY_ETF_SOURCES` + drift guard; the `source` field end to end through contracts
  (validation, normalization, identity, fingerprints, labels, menus, help); `benchmark-technicals.ts`
  with oracle, parity, finalized-session, coverage-floor and weekly-boundary tests.
  **Acceptance to proceed:** `pnpm --filter @intrinsic/contracts test` and
  `--filter @intrinsic/stock-data test` green; every pre-existing golden fingerprint literal
  byte-identical; stock-only documents round-trip unchanged through normalize/duplicate/rekey;
  kernel-parity bit-identical on shared fixtures; 20×21 enumeration and every forbidden
  kind/operator/value/trigger/forged-source case refused.
- **Phase B — engine + workers + API.** Operand key family; frame column injection; backtest
  prepare context, `etfSeries` pinning, `refuseUndefinedSources`, diagnostics; Monitor port, cycle
  context, strict finalization, availability note; QA-matrix/audit-oracle switches; OpenAPI.
  **Acceptance:** deterministic mixed Stock+SPY+XLK+GLD backtest matches independently derived
  trades; stock-only `snapshotHash` unchanged; Monitor/backtest parity on completed sessions;
  no provider call during evaluation proven by spy.
- **Phase C — Builder UI + E2E.** Picker redesign, reducer, visible reset feedback, a11y, desktop +
  mobile Playwright, stock-only Builder regression.
- **Phase D — docs amendments (§3), fixture extension, performance evidence, full gate**
  (`pnpm lint` / `typecheck` / `test` / `build` / `openapi:validate` + hermetic E2E), with
  command/environment/pass-fail/skip evidence reported.

## 11. Test matrix with expected evidence

| Area | Suites (new or extended) | Expected evidence |
| --- | --- | --- |
| Contracts & compatibility | `strategies.etf-sources.test.ts` beside the existing registry suites; drift guard in `apps/api` | 20 identities and 21 metrics enumerated **from the registries**; every other kind, every operator/value violation, ETF Triggers, forged/malformed codes and cross-source MA comparisons refused with named codes; source-aware duplicates accepted, true duplicates refused; golden stock fingerprints byte-identical; new ETF fingerprint literals pinned; v1→v2 upgrade untouched; normalize/duplicate/version round-trips preserve source |
| Indicator correctness | `benchmark-technicals.test.ts` using the existing MA/RSI oracles + an RVOL oracle | oracle agreement on deterministic inputs; **stock/ETF bit-parity on identical bars**; threshold and 2% boundary cases; warm-up first-value indices per period; missing sessions; unfinalized bar excluded; listing boundary (XLRE/XLC fixtures); 200W long-window fixtures; prefix no-look-ahead |
| Backtest | engine fixture tests in `packages/strategy`; worker integration in `apps/worker` (incl. extending `backtest-legacy-snapshot.test.ts`) | deterministic mixed-source run with independently expected signals/trades; AND semantics; SELL/FINAL EXIT unaffected; one-ETF-unavailable negative; no look-ahead at listing/warm-up/gap edges; no accidental stock-technical read for an ETF condition (distinct fixture values per source); snapshot pin/consistency refusals; generation recorded; stock-only snapshots and hashes unchanged |
| Monitor | `monitor-cycle.integration.test.ts` extensions; lifecycle fixtures | parity with backtest on completed sessions; intraday `NOT_EVALUABLE` until finalization **and** tail-sync (clock alone insufficient — a test holds `lastTailSyncAt` back); source-specific fingerprints reset only ETF levels; no duplicate Signals on retry/restart; stock-only Monitor regression suite untouched and green |
| Infrastructure | `packages/stock-data` integration (PostgreSQL + Redis) | Redis flush → rebuild-under-lock → identical context; PostgreSQL fallback; provider spy proves zero FMP calls on the evaluation path; generation bump mid-sequence handled; reader-call count scales with unique ETFs; measured time/memory figures reported |
| UI | web unit (`strategy-draft`, picker) + hermetic Playwright desktop 1440×900 and phone 390×844 | Stock↔ETF switching edits only its row; all 3 groups and 20 ETFs selectable; only Technical (21 metrics) for ETF; Position/Fundamentals/Valuation/Activity intact for Stock; compact content-sized popup, internal scroll, keyboard/focus; save/reload/edit/duplicate/version keep the source; validation messages; updated tile-count assertions; stock-only Builder journey regression |
| Gate | full repository gate + relevant integration/E2E | command, environment, total/pass/fail/skip reported; any untested scenario named; no render-only assertions |

## 12. Remaining open items (none blocking)

- **Production ETF bootstrap status is unrecorded in the repo** (`etf-market-data-v1.md` §6 is
  unchecked). Operational precondition for the feature being *useful* in an environment, not an
  implementation blocker: evaluation degrades to the specified diagnostics without it. The local
  development database is bootstrapped.
- Exact names of the new validation codes, diagnostic contract fields and the Monitor availability
  note's shape are finalized during Phases A/B inside the constraints above.
- Whether a write-boundary database check is needed for ETF sources: expected **no** (the catalog is
  static in contracts, unlike actor ids); confirmed during Phase B.

## Conclusion

**READY TO IMPLEMENT.** First phase: **Phase A** (contracts vocabulary + `source` field +
calculation adapter with oracle/parity tests) — pure, user-unreachable until later phases, and the
place every correctness property is cheapest to prove. Its objective acceptance criteria are listed
in §10.

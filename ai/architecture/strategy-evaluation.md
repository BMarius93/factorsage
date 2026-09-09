# Strategy Evaluation and Backtest Engine — Technical Design

## Status

**Built.** This design is implemented. `ai/architecture/backtest-execution.md` describes what was
actually built and is the document to read for current behaviour; this one is retained as the
reasoning behind it — the reusable-component map, the memory analysis, the tri-state algebra and
the alternatives that were rejected.

What landed, and where it differs:

- **Phases 2 and 3 as designed**, in the new pure `@intrinsic/strategy` package: the tri-state
  algebra, operand resolution, the columnar `EvaluationFrame`, precomputed per-level market gates,
  `PositionState` with the position epoch and the as-computed previous value, and `AVERAGE_COST`.
- **`getDailyEvaluationFrame` in `@intrinsic/stock-data`** (§2.7), `Security`-keyed, applying the
  intrinsic provenance gate during projection with `TRIGGER_CONTEXT_CALENDAR_DAYS = 10`.
- **Phase 4's day loop and residency model** as designed. Its *union calendar* was not built: the
  pinned execution calendar is authoritative
  (`CALENDAR_METHODOLOGY_VERSION = execution-calendar-authoritative@2`), and execution consumes it
  one calendar year at a time. See `backtest-execution.md`, which describes what exists.
- **Divergence — the durable-work substrate.** §4.2 recommended claiming the `BacktestRun` row
  itself. A separate `BacktestJob` row is used instead, created in the same transaction as the run,
  so queue mechanics stay off the user-facing execution record while remaining one transactional
  truth. `docs/decisions/backtest-run-persistence.md` records the reasoning.
- **Not built: the §2.9 per-predicate diagnostic counters.** They were a recommendation, not
  product behaviour, and nothing consumes them yet.

**The open product questions below are answered — as engine methodology, not as Strategy
semantics.** `ai/architecture/backtest-execution.md` § "Execution methodology" is the canonical
table; each rule carries a version recorded in every run snapshot, so changing one is a deliberate,
traceable act rather than a silent reinterpretation. Questions 9 (currency) and the diagnostics
representation remain genuinely open.

This document is the technical design for evaluating `ai/product/strategies.md` semantics over
historical data and for the backtest engine that consumes that evaluation. It does **not** define
product semantics: `ai/product/strategies.md` and `ai/product/backtests.md` remain authoritative,
and anything this document cannot answer from them is recorded under
[Open product questions](#open-product-questions) rather than invented.

Written in bounded phases so the work survives context loss:

| Phase | Scope                                         | State    |
| ----- | --------------------------------------------- | -------- |
| 1     | Existing architecture and reusable components | Complete |
| 2     | Historical market-derived signal evaluation   | Complete |
| 3     | Position-dependent Gain/Loss evaluation       | Complete |
| 4     | How the backtest engine combines them         | Complete |

---

## Phase 1 — Existing architecture and reusable components

### 1.1 What exists, and what does not

Verified by direct inspection of the repository, not inferred from documentation.

> **Superseded in part.** The Create/Edit Strategy slice has since been implemented, so three
> items in the list below are no longer true: `Strategy` and `StrategyVersion` **do** exist in
> `packages/database/prisma/schema.prisma`, `@intrinsic/contracts` **does** export a Strategy
> model, registry and validator from `strategies.ts`, and `/strategies` is a real product surface
> rather than a placeholder. Everything else in this section still holds: there is still no
> evaluator, no position model, no portfolio simulation, and no backtest schema, contract or
> worker processor. The list is kept as written because the rest of the design reasons from it.

**Did not exist when this design was written:**

- no `Strategy`, `StrategyVersion`, `BacktestConfiguration`, `BacktestRun` or job/queue model in
  `packages/database/prisma/schema.prisma`. Its complete model list is `User`, `OAuthAccount`,
  `EmailVerificationToken`, `Security`, `StockList`, `StockListItem`, `StockListBuyWindow`,
  `SecurityProfile`, `FinancialStatement`, `StockDatasetState`, `StockDatasetCoverage`,
  `DailyPrice`, `WeeklyPrice`, `DailyDerivedState`;
- no Strategy or Backtest types in `@intrinsic/contracts` (`packages/contracts/src/index.ts`
  re-exports only `selectable-series`, `stock-data`, `stock-lists`);
- no signal/predicate evaluator, no position model, no portfolio simulation, in any package;
- no queue library in the workspace. `bullmq`, `bull`, `pg-boss` and `graphile-worker` appear in no
  `package.json`. There is no durable job table either, so **the durable-work mechanism itself is
  unbuilt**, not merely unwired;
- no multi-security read port. Every stock-data read is single-security
  (`symbol` or `securityId` + range), as `ai/architecture/calculated-series.md` already records.

**Exists as a foundation only:**

- `apps/worker/src/index.ts` is 34 lines: it loads config, creates a logger, emits
  `worker.started` ("no job processors are registered yet"), heartbeats on a 60s interval and
  handles `SIGINT`/`SIGTERM`. `apps/worker/package.json` depends only on `@intrinsic/config` and
  `@intrinsic/observability` — **not** on `@intrinsic/stock-data`, `@intrinsic/database`,
  `@intrinsic/domain` or `@intrinsic/contracts`;
- `apps/web/src/app/(app)/backtests/page.tsx` and `.../monitors/page.tsx` are `RoutePlaceholder`
  components. The navigation entries already exist.

**Exists and is production-complete** — the stock-data foundation the whole design rests on. That
is the subject of the rest of this phase.

### 1.2 Reusable components

#### Operand identity — `@intrinsic/contracts`

`packages/contracts/src/selectable-series.ts` is the single canonical catalog and is the only
legitimate source of Strategy operand identity (product invariant 9 in `AGENTS.md`).

| Export                                                                                     | What a Strategy needs it for                                                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `SELECTABLE_SERIES_CATALOG` / `SelectableSeriesId`                                         | the 24 stable operand ids a persisted Condition/Trigger references                                                       |
| `SelectableSeriesSource` (discriminated union)                                             | structured identity — `kind`, `type`, `period`, `timeframe`, `field`, `blendId`, `model`. Never parse the id             |
| `findSelectableSeries(id)`                                                                 | the one lookup/validation entry point, shared by API validation and the builder                                          |
| `MOVING_AVERAGE_SERIES`, `OSCILLATOR_SERIES`, `INTRINSIC_VALUE_SERIES`, `TECHNICAL_SERIES` | consumer-filtered views; the price-valued operand set for `Price` is the 14 moving averages plus the 7 intrinsic entries |
| `comparableMovingAverages(id)`                                                             | already encodes the same-timeframe / not-itself rule                                                                     |
| `label`, `SELECTABLE_SERIES_GROUPED`, `DEFAULT_SELECTED_SERIES_IDS`                        | the one product label and ordering; no second label map is permitted                                                     |

`@intrinsic/contracts` is the only package `apps/web` may depend on and is equally available to API
and worker, so a Strategy compatibility matrix placed here is automatically shared by Strategy
Builder, API validation and the evaluator — which is what `AGENTS.md` invariant 11 requires.

#### Data shape — `@intrinsic/domain`

`packages/domain/src/stock-data.ts`:

- **`DailyDerivedState`** — one row per security per trading day, and the single backtest-facing
  derived representation. It carries every market-derived operand a V1 Signal can name:
  7 daily MAs, 7 weekly MAs (carried forward), 3 daily RSI, `intrinsicValues` (4 models),
  `intrinsicValueBlends` (3 blends), the four per-model provenance instants, `intrinsicCurrency`
  and `weeklySourceWeekStart`. **It does not carry the close price** — `DailyPrice.close` does.
- Registries the evaluator reads instead of restating periods: `MATERIALIZED_MOVING_AVERAGES`
  (`DAILY_MOVING_AVERAGES` + `WEEKLY_MOVING_AVERAGES`), `DAILY_OSCILLATORS`,
  `TECHNICAL_SERIES_FIELDS`, `INTRINSIC_VALUE_MODELS`, `INTRINSIC_VALUE_BLENDS`,
  `INTRINSIC_VALUE_BLEND_IDS`, `RSI_VALUE_RANGE`.
- `WEEKLY_TECHNICAL_BACKTEST_POLICY = "COMPLETED_PERIODS_ONLY"` — the published domain name for
  weekly eligibility, retained explicitly so Strategy evaluation reads one constant rather than
  restating the rule.
- `StockDataService` — the canonical read boundary shared by API Stock Details and worker
  backtests. **Every method is keyed by `symbol`, not `securityId`.**
- `LocalDate`, `Instant`, `SecurityId`, `DateRange`, `Security` (`ipoDate`, `currency`).

`packages/domain/src/stock-lists.ts` — `BuyWindowMode`, `BuyWindowRange`,
`BuyWindowConfiguration`, `normalizeBuyWindowRanges`, `normalizeBuyWindowConfiguration`. This is
the per-symbol BUY eligibility a backtest must honour, already canonical (sorted, non-overlapping,
non-adjacent, at most one open-ended range). `endDate: null` means open-ended.

`packages/domain/src/financial-statements.ts` and `security-universe.ts` are not on the evaluation
path.

#### Loading and point-in-time correctness — `@intrinsic/stock-data`

`packages/stock-data/src/service.ts`, `CanonicalStockDataService`:

- `ensureStockHydrated(security, required)` / `ensureStockFresh(security, required)` — the
  caller-scoped materialization contract (`docs/decisions/caller-scoped-history-materialization.md`).
  The range is a parameter: "a caller that wants decades of history says so."
- `getDailyDerivedState(symbol, range)` → resolve symbol, `loadTarget`, hydrate, freshen, then read
  the projection (Redis yearly chunks → PostgreSQL fallback).
- `getDailyPrices(symbol, range)` — same shape; the source of `Price` and of the eligible-trading-day
  axis.
- `getIntrinsicValues` / `getIntrinsicValueBlends` — apply `asOf` per model and per blend
  independently. `DailyDerivedState` reads return the raw row, so **an evaluator reading the row
  directly must apply provenance gating itself**.
- `DERIVED_SERIES_WARMUP_DAYS` — 1456 calendar days (208 weeks: the 200-week weekly MA plus an
  8-week margin), derived from the registries. `loadTarget` widens every requested `from` by this
  amount, clamped to `priceRetentionTarget`.
- `PRICE_RETENTION_WARMUP_YEARS = 4` — `ceil(DERIVED_SERIES_WARMUP_DAYS / 365.25)`. Extra years of
  raw `DailyPrice` retained *behind* the product horizon so the same warm-up guarantee holds at the
  boundary itself, where the clamp used to cancel it out.
- `VALUATION_FUNDAMENTALS_WARMUP_YEARS = 7` — extra fiscal years of statements retained before the
  visible price history so the earliest visible day already has PIT-eligible intrinsic values.
  Independent of the price warm-up; the two never compound.
- `productTarget(security)` = `[max(today - productHistoryYears, ipoDate), today]`,
  `productHistoryYears` default **30**. This is the outer bound of everything readable.
- `priceRetentionTarget(security)` = the same shape at `productHistoryYears + 4` = **34**. This is
  the outer bound of everything *held*. `projectionRange` cuts every read back to `productTarget`,
  so no retained warm-up row can reach a caller or a backtest frame. See
  `../../docs/decisions/price-retention-warmup-horizon.md`.

Supporting modules:

| File                                           | Reusable for the engine                                                                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dates.ts`                                     | `isLocalDate`, `addDays`, `subtractYears`, `compareDates`, `assertDateRange`, `missingCoverageRanges`, `endOfLocalDate` — the one date arithmetic; do not add a second                              |
| `coordination.ts`                              | `LoadCoordinator`, `RedlockLoadCoordinator` (per-security Redis lock `stock-data:load:hydrate:<securityId>`), `InMemoryLoadCoordinator` for tests                                                   |
| `cache.ts`                                     | `StockDataCache`, `StockManifest`, yearly Redis chunk reads/writes, `NullStockDataCache`                                                                                                            |
| `ports.ts`                                     | `StockDataStore`, `PRICE_DATASET_VERSION`, dataset variants                                                                                                                                         |
| `prisma-store.ts`                              | the Prisma `StockDataStore`; `getDailyDerivedState(securityId, range)` is **securityId-keyed** here, unlike the service                                                                             |
| `derived-state.ts`                             | `DERIVED_STATE_REVISION` (currently 4), `DAILY_DERIVED_STATE_VARIANT`, `buildDailyDerivedState`, `assertOneRowPerTradingDay`                                                                        |
| `intrinsic-values.ts`                          | `INTRINSIC_MODEL_SOURCE_FIELDS`, `intrinsicModelSourceAsOf(row, model)`, `blendComponentModels(blendId)`, `blendSourceDataAsOf(row, blendId)` — **the provenance gate Margin of Safety must reuse** |
| `fmp-gate.ts`                                  | provider-wide Redis concurrency/rate gate with shared 429 cooldown, already cross-process                                                                                                           |
| `technicals.ts`, `oscillators.ts`, `weekly.ts` | pure calculators; the model for how a pure, registry-driven calculator is written and oracle-tested                                                                                                 |

`@intrinsic/valuation` is pure valuation mathematics and is consumed by the intrinsic-value
materializer, not by Strategy evaluation: a Signal reads already-materialized model/blend values
off the daily row.

#### Cross-cutting

- `@intrinsic/observability` — the only permitted runtime logging. Correlation fields relevant
  here: `runId`, `jobId`, `symbol`, `component`, `actorUserId`, `correlationId`. Queue/job payloads
  must carry correlation fields explicitly and the worker must recreate the logging context
  (`ai/architecture/observability.md`).
- `@intrinsic/testing` — `test-database.ts`, `live-fmp.ts`.
- `apps/api` is NestJS (controllers, guards, modules, `@intrinsic/database` `PrismaService`), with
  `logged-stock-data.service.ts` as the decoration pattern for instrumenting a domain service.

### 1.3 Boundaries the design must respect

From `AGENTS.md`:

- allowed direction is `api|worker -> contracts/domain/stock-data/database/fmp/observability`;
  `domain` may not reach `database`, HTTP or `process.env`; `web -> contracts` only;
- API and worker are different processes, **not different business implementations**;
- PostgreSQL is the source of truth; Redis is disposable and must never be the only store for a
  completed run;
- `maximumPositions` belongs to a Backtest execution, never to a Strategy;
- Strategy Builder and backend validation must share canonical compatibility definitions;
- schema changes require an explicit migration plus a migration note.

Consequences that follow directly, and constrain Phases 2–4:

1. Pure signal evaluation — the predicate algebra, the three-valued logic, level composition and
   the position model — belongs in a **pure package** (`@intrinsic/domain`, or a new pure
   `@intrinsic/strategy` that depends only on `contracts` + `domain`). It may not load data.
2. All historical loading goes through `@intrinsic/stock-data`. The worker must not reimplement
   Redis lookup, coverage reconciliation, FMP loading or derived calculation.
3. The compatibility matrix (Metric × operator × Value type × allowed level family) must live in
   `@intrinsic/contracts` so the builder and the API validator read one definition.

### 1.4 Facts that shape the later phases

Established by inspection; each is a constraint the design must answer, not a decision.

1. **The eligible-date axis is per security, not global.** `buildDailyDerivedState` maps over the
   security's `DailyPrice` rows, so exactly one derived row exists per trading day _that security
   traded_. There is no trading-calendar table and no market-wide date axis anywhere in the
   repository. A per-security predicate series is naturally aligned; a portfolio-level day loop over
   many securities is not, and Phase 4 must define how the union calendar is formed.
2. **`Price` is not on `DailyDerivedState`.** Every predicate naming `Price` needs the aligned
   `DailyPrice.close` as well, so market-derived evaluation reads two aligned series, not one.
3. **Provenance gating is the reader's job.** `getDailyDerivedState` returns the raw row.
   `toIntrinsicValuePoints` / `toIntrinsicValueBlendPoints` in `service.ts` apply the per-model and
   per-blend provenance rules only on the intrinsic-value endpoints. An evaluator reading rows must
   reuse `intrinsicModelSourceAsOf` / `blendSourceDataAsOf` or it will silently read a model value
   whose provenance is absent — a no-look-ahead violation.
4. **`NOT_EVALUABLE` has no persisted reason.** Absence is the single representation of "no value"
   at every layer, and `ai/architecture/calculated-series.md` records that the evaluator's rich
   reasons (`ASSEMBLY`/`VALUATION` phases, 17 codes) are collapsed to field absence before
   persistence. A Strategy diagnostic can therefore say _that_ a day was not evaluable and which
   operand was missing, but not _why_ the underlying series was missing.
5. **The read boundary is symbol-keyed; the engine is security-keyed.** `StockDataService` takes
   `symbol` on every method and re-resolves it through cache/PostgreSQL per call, while
   `StockListItem`, `DailyDerivedState` and the store port are all `securityId`-keyed, and
   `AGENTS.md` forbids symbol as durable identity. A backtest over a list resolves securities once
   and then wants `securityId` reads.
6. **`loadTarget.to` is always `today`.** A backtest ending in 2015 still materializes and freshens
   through the present day for every security. Hydration is also per security behind its own Redis
   lock, and rebuild after a `DERIVED_STATE_REVISION` bump is lazy and global — so the first
   backtest after a bump pays a full rebuild for every security in its list.
7. **30 years is the outer bound of what is readable.** `productTarget` clamps to
   `today - productHistoryYears` (default 30) and to `ipoDate`; a requested period older than that
   yields no rows, and `projectionRange` returns `null` rather than erroring. Raw prices are
   retained to 34 years, but that is what the loader holds, not what any caller can read.
8. **Warm-up is already paid for, including at the boundary.** `DERIVED_SERIES_WARMUP_DAYS`
   guarantees every catalog series is warmed up on the first requested trading day, and the
   four-year price-retention horizon is what makes that true even when the request starts exactly
   on the 30-year boundary — where the clamp previously cancelled the widening out and left
   `SMA/EMA 200W` absent for the first four years of a maximum-length run. What it does **not**
   cover is the Trigger's `t-1` requirement at the very start of a backtest period (a period
   starting on the product boundary has no earlier readable row, by design), or Gain/Loss, which
   has no market warm-up at all.
9. **There is no durable-work substrate.** Neither a queue library nor a job table exists, so
   "backtests are asynchronous long-running work" (`AGENTS.md` invariant 5) is entirely
   unimplemented. Phase 4 must design it, and `AGENTS.md` invariant 8 forbids Redis being the only
   store for a completed run.

---

## Phase 2 — Historical market-derived signal evaluation

Scope: every predicate that can be decided from market history alone — `Price`, the catalog moving
averages and oscillators, the catalog intrinsic-value models and blends, and `Margin of Safety`.
`Gain` and `Loss` are deliberately excluded and are Phase 3.

### 2.1 Where the code lives

Three placements, following the `AGENTS.md` dependency rules:

| Concern                                                                                    | Package                       | Why there                                                                                                                                                                |
| ------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Strategy DTOs + the canonical compatibility matrix                                         | `@intrinsic/contracts`        | `apps/web` may depend on nothing else, and Strategy Builder and API validation must read **one** matrix (invariant 11). The selectable-series catalog already lives here |
| Pure evaluation: operand resolution, tri-state algebra, frame projection, predicate series | **new `@intrinsic/strategy`** | needs both the catalog (`contracts`) and the row shapes (`domain`); must stay free of DB, HTTP and `process.env`                                                         |
| Frame loading (`securityId`-keyed, aligned prices + derived rows)                          | `@intrinsic/stock-data`       | infrastructure-aware: Redis, coverage, hydration lock, FMP                                                                                                               |

`packages/domain/package.json` and `packages/contracts/package.json` currently declare **no
dependencies**; both are standalone. Putting the evaluator in `@intrinsic/domain` would force
`domain -> contracts`, i.e. the pure business layer depending on the wire layer, so a new pure
package is the cleaner boundary.

> Adding `@intrinsic/strategy` requires an explicit edit to the **Dependency rules** block in
> `AGENTS.md`: `strategy -> contracts/domain`, and `api|worker -> strategy`. Forbidden:
> `strategy -> database`, `strategy -> HTTP`, `strategy -> process.env`, `web -> strategy`.

### 2.2 Canonical predicate vocabulary

One registry in `@intrinsic/contracts`, replacing any per-surface matrix. Metric and Value stay
structured; nothing is parsed out of an id or a label.

```ts
type StrategyMetric =
  | { kind: "PRICE" }
  | { kind: "MOVING_AVERAGE"; seriesId: SelectableSeriesId } // any of the 14 catalog averages
  | { kind: "OSCILLATOR"; seriesId: SelectableSeriesId } // RSI_7D | RSI_14D | RSI_21D
  | { kind: "MARGIN_OF_SAFETY"; sourceId: SelectableSeriesId } // one of the 7 intrinsic entries
  | { kind: "GAIN" }
  | { kind: "LOSS" };

type StrategyValue =
  | { kind: "SERIES"; seriesId: SelectableSeriesId } // price-scaled entries only
  | { kind: "NUMBER"; value: number } // RSI threshold, 1..100
  | { kind: "PERCENT"; value: number }; // MOS / Gain / Loss, in percent units

type ConditionOperator = "IS_ABOVE" | "IS_BELOW" | "IS_CLOSE_TO";
type TriggerOperator = "CROSSES_ABOVE" | "CROSSES_BELOW";
```

Moving averages and RSI are addressed through their **catalog ids**, not parallel enums, because
`ai/product/strategies.md` makes both first-class Strategy metrics. A moving-average Metric's
permitted Values resolve through `comparableMovingAverages(seriesId)` — same timeframe, never
itself — which is the same helper the operand resolver already had available. `Price` is
deliberately _not_ a catalog entry, so it is its own metric kind. `Margin of Safety` is a derived
metric parameterized by a catalog intrinsic source — never a comparison operator.

The registry answers, for one metric: permitted condition operators, permitted trigger operators,
the permitted `StrategyValue` kind and its constraints (`1..100` for RSI; the price-scaled catalog
subset for `Price`), and the permitted level families (`GAIN`/`LOSS` → `SELL`, `FINAL_EXIT` only).
`comparableMovingAverages` already encodes the same-timeframe/not-itself rule and is reused rather
than restated. **The registry is the only place compatibility is expressed**; the API validator and
Strategy Builder both call it.

### 2.3 Operand resolution

An _operand_ is anything that resolves to `number | absent` on one eligible trading day. Five
resolvers cover the whole V1 vocabulary:

| Operand                             | Source                                                                  | Availability rule                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Price`                             | `DailyPrice.close` on that date                                         | absent if no price row                                                                                                      |
| Catalog moving average / oscillator | `DailyDerivedState[source.field]`                                       | absent = warm-up not complete. Weekly fields are already carried forward under `WEEKLY_TECHNICAL_BACKTEST_POLICY`           |
| Catalog intrinsic **model**         | `row.intrinsicValues[model]`                                            | present **and** `intrinsicModelSourceAsOf(row, model) !== undefined`                                                        |
| Catalog intrinsic **blend**         | `row.intrinsicValueBlends[blendId]`                                     | present **and** `blendSourceDataAsOf(row, blendId) !== undefined`                                                           |
| `Margin of Safety (source)`         | `(iv - close) / iv * 100` — denominator is intrinsic value, never price | requires the gated `iv` **and** `close`; `iv <= 0` is `NOT_EVALUABLE`, now stated canonically in `ai/product/strategies.md` |

The provenance gate is not optional. `getDailyDerivedState` returns the raw row without applying
it (Phase 1, fact 3), so the evaluator must call `intrinsicModelSourceAsOf` /
`blendSourceDataAsOf` from `@intrinsic/stock-data`. Because those helpers live in an
infrastructure-aware package while the evaluator is pure, the gate is applied **during frame
projection** (§2.5), which happens in `@intrinsic/stock-data`. The pure evaluator then only ever
sees already-gated values, and cannot forget the rule.

Constants (`NUMBER`, `PERCENT`) resolve to themselves on every date and are always available.

### 2.4 Tri-state algebra

```ts
const enum Evaluability {
  NOT_EVALUABLE = 0,
  FALSE = 1,
  TRUE = 2,
}
```

**Conditions** (both operands available, else `NOT_EVALUABLE`):

- `IS_ABOVE` → `m > v` — strict, as the product states;
- `IS_BELOW` → `m < v` — strict;
- `IS_CLOSE_TO` → `abs(m - v) / abs(v) <= CLOSE_TO_TOLERANCE` with `CLOSE_TO_TOLERANCE = 0.02` as a
  product constant exported from `@intrinsic/contracts` so the builder's help text and the
  evaluator read one value. `v === 0` makes the ratio undefined → `NOT_EVALUABLE`.

**Triggers** need `t` and `t - 1`:

- `CROSSES_ABOVE` → `m[t] > v[t] && m[t-1] <= v[t-1]`;
- `CROSSES_BELOW` → `m[t] < v[t] && m[t-1] >= v[t-1]`;
- `NOT_EVALUABLE` if **any** of the four values is unavailable.

`t - 1` means the **immediately preceding eligible trading day of that security in the frame** — not
the most recent day on which the operand happened to have a value. The product states a Trigger is
not evaluable when either the current or previous required value is unavailable, so the evaluator
must never search backwards for a substitute. At frame index 0 there is no `t - 1`, so every
Trigger there is `NOT_EVALUABLE`.

**Conjunction — Kleene strong AND, `FALSE` absorbing:**

|                   | TRUE          | FALSE     | NOT_EVALUABLE |
| ----------------- | ------------- | --------- | ------------- |
| **TRUE**          | TRUE          | FALSE     | NOT_EVALUABLE |
| **FALSE**         | FALSE         | FALSE     | **FALSE**     |
| **NOT_EVALUABLE** | NOT_EVALUABLE | **FALSE** | NOT_EVALUABLE |

This is a technical choice, not a change to product semantics: under either strong or strict AND a
signal fires only when every part is `TRUE`, so no trading behaviour differs. The difference is
diagnostic honesty — on a day where one Condition is definitively `FALSE`, the signal genuinely
cannot fire no matter what the missing operand was, and reporting `NOT_EVALUABLE` there would
overstate the data gap. An **empty conjunction is `TRUE`**: a Signal with zero Conditions and one
Trigger is valid, and so is a SELL level whose only predicates are position-dependent, whose
market-derived part is therefore vacuously true.

### 2.5 Frame projection — the memory decision

Loading raw `DailyDerivedState` objects for a whole run does not scale. Thirty years is about
**7,560 trading days**; a row object carrying ~25 fields plus the intrinsic maps costs roughly
0.7–1 KB, so one security is 5–8 MB and a 100-symbol list is 500–800 MB of live objects.

Instead, **project once per security into a compact columnar frame holding only the operands the
strategy version actually references**, and discard the rows:

```
EvaluationFrame {
  securityId: SecurityId
  dates:  LocalDate[]          // ascending, one entry per eligible trading day
  values: Map<OperandKey, Float64Array>   // NaN = absent
  periodStartIndex: number     // first index inside the backtest period
}
```

- `NaN` as the absent sentinel is safe: every calculator rejects non-finite inputs, and
  `prisma-store.ts` already converts `Decimal(20,8)` to a JS `number` via `.toNumber()`, so a
  `Float64Array` introduces **no precision loss the system does not already have**.
- A typical strategy references ≤ 5 distinct operands: `5 × 7560 × 8 B ≈ 302 KB` per security,
  ~30 MB for 100 securities. Two to three orders of magnitude better than raw rows.
- `Margin of Safety` is materialized as its own column during projection, so the `iv > 0` and
  provenance rules are applied exactly once.
- The projection is where the intrinsic provenance gate is applied (§2.3), so it belongs to
  `@intrinsic/stock-data`, which already owns those helpers.

### 2.6 Precomputed per-level market gate

For each level, AND its market-derived Conditions and — when the Trigger is market-derived — its
Trigger, into one tri-state series over the frame:

```
marketGate[levelId]: Uint8Array   // one Evaluability per frame index, 7.5 KB per level per security
```

This is exactly the product's "logical daily result series". Position-dependent predicates are
**excluded** from the gate and evaluated live (Phase 3); a level with no market-derived predicates
gets an all-`TRUE` gate by the empty-conjunction rule.

Precomputing is worth it because the gate is read once per date per security by the portfolio loop
and would otherwise be recomputed whenever the loop revisits a date. At 7.5 KB per level per
security, a 5-level strategy over 100 securities costs under 4 MB.

### 2.7 Reading the frame — required stock-data extension

`StockDataService` is symbol-keyed on every method and re-resolves the symbol per call (Phase 1,
fact 5). The engine holds resolved `Security` values from the run snapshot. Extend the canonical
loader rather than working around it:

```ts
// @intrinsic/stock-data — Security-keyed, so nothing re-resolves a symbol per read
getDailyEvaluationFrame(
  security: Security,
  range: Required<DateRange>,
  operands: readonly OperandKey[],
): Promise<EvaluationFrame>
```

It performs one `ensureStockHydrated` + `ensureStockFresh` for the security, reads prices and
derived state over the same range, joins them by exact date, applies the provenance gate, and emits
only the requested operand columns. Joining inside `stock-data` means the price/derived alignment
is asserted in one place; a date present in one and not the other is a data-integrity failure, not
something the evaluator silently tolerates.

**Context read for `t - 1`.** The frame must begin at least one eligible trading day **before** the
backtest period start, or every Trigger on the first day is `NOT_EVALUABLE`. Read from
`addDays(periodStart, -TRIGGER_CONTEXT_CALENDAR_DAYS)` with `TRIGGER_CONTEXT_CALENDAR_DAYS = 10`,
and set `periodStartIndex` to the first index at or after `periodStart`. Ten calendar days clears
any weekend-plus-holiday closure in the covered history. When no earlier row exists the security's
own history simply begins there, and `NOT_EVALUABLE` on the first day is the correct answer. This
costs nothing extra to materialize: `loadTarget` already widens the load by
`DERIVED_SERIES_WARMUP_DAYS` (1,456 days) and the load is clamped to the 34-year price-retention
horizon, so the context days are always already resident — except at the product boundary itself,
where `projectionRange` legitimately cuts them off.

### 2.8 Determinism and point-in-time correctness

- No clock is read during evaluation. Every date comes from the frame; `today` never appears.
- An operand at index `i` is read only from the row at `dates[i]`. There is no backward search and
  no forward fill beyond the carry-forward the derived state already materializes, which is itself
  PIT-correct.
- Weekly operands inherit `COMPLETED_PERIODS_ONLY`; the in-progress week is never represented.
- Intrinsic operands are gated on their **own** provenance instant, per model and per blend, never
  on the newest instant on the row.
- Identical inputs give identical outputs: the frame is ordered, the level order comes from the
  strategy version, and no iteration order depends on a hash map.

### 2.9 Diagnostics

`NOT_EVALUABLE` days must be explainable without storing a per-date array per predicate. Per
`(levelId, predicateIndex)` accumulate bounded counters:

```
{ trueDays, falseDays, notEvaluableDays,
  firstEvaluableDate?, lastNotEvaluableDate?,
  missingOperands: Record<OperandKey, number> }
```

This is deterministic, fixed-size, and answers the question users actually ask ("why did this rule
never fire?"). Its resolution is bounded by Phase 1 fact 4: the engine can report _which operand_
was missing, but not _why_ the underlying series was missing, because absence is the only persisted
representation. `ai/product/strategies.md` explicitly leaves the diagnostics representation
undecided, so this is a recommendation, not product behaviour.

### 2.10 Cost notes carried into Phase 4

- `loadTarget.to` is always `today`, so a backtest ending in 2015 still hydrates and freshens every
  security through the present. Hydrating **once per security per run** amortizes this; it is not a
  reason to add a bounded-`to` variant, which would change cache and coverage semantics.
- Hydration is serialized per security by the Redis lock `stock-data:load:hydrate:<securityId>`, so
  frame loading across securities parallelizes, bounded by the FMP gate.
- A `DERIVED_STATE_REVISION` bump makes the first run after it rebuild every security in the list.

---

## Phase 3 — Position-dependent Gain/Loss evaluation

Scope: `Gain` and `Loss`, the only V1 metrics that cannot be decided from market history alone.
`ai/product/strategies.md` requires the technical design to "treat this difference explicitly
rather than forcing Gain/Loss into a static historical array".

### 3.1 Why a static series is impossible

`Gain[t]` needs a cost basis. The cost basis exists only if a BUY executed, which required the BUY
signal _and_ available cash _and_ a free position slot — both portfolio-level facts that depend on
every decision taken for every other security before `t`. The dependency runs
`date -> portfolio state -> position -> Gain -> SELL signal -> portfolio state`, so the value at
`t` is a function of the simulation, not of the market. Precomputing it would require already
knowing the answer.

The consequence is structural, not merely an implementation detail:

| Level family             | Composition                                                             | When it can be computed                                                                      |
| ------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **BUY**                  | market-derived predicates only (product forbids Gain/Loss in BUY rules) | **fully precomputable** as a Phase 2 market gate, before the simulation starts               |
| **SELL**, **FINAL EXIT** | market gate `AND` position-dependent predicates                         | market gate precomputed; the position part evaluated live, and only while a position is open |

This asymmetry is what makes the engine cheap: scanning BUY candidates on a date is an indexed read
of a `Uint8Array`, and the live work is bounded by the number of open positions, which
`maximumPositions` caps.

### 3.2 Definition

Both metrics are percentages against the position's cost basis, evaluated on the canonical
end-of-day close of the same trading day the rest of the Signal is evaluated on:

```
Gain[t] = (close[t] - averageCost) / averageCost * 100
Loss[t] = max(0, (averageCost - close[t]) / averageCost * 100)
```

These are now canonical product definitions in `ai/product/strategies.md`, which also fixes the
basis as **average cost**. `Gain` is signed and unbounded above, never below `-100`. `Loss` is
non-negative and clamped at zero, bounded by `100` — deliberately **not** an unclamped mirror of
`Gain`, so `Loss is above 10%` reads exactly as "the price is more than 10% below average cost".

The clamp is invisible to every strictly positive threshold: for `v > 0` the clamped and unclamped
forms agree on all four operators, because a clamped value can only differ from the signed one on
the side of zero the threshold does not reach. They diverge only at `v = 0`, where the clamp makes
`Loss crosses below 0%` unreachable — which is correct, since `Loss` never goes below zero. An
earlier revision of this section argued the opposite from a `-4% -> -2%` example that in fact fires
under neither form; the canonical definitions above supersede it.

Execution assumptions (open question 7) determine the _entry_ price and therefore the basis; they
do not change the evaluation price, which stays the close of `t`, consistent with the product rule
that `Price` means canonical end-of-day close.

### 3.3 Cost basis behind a policy interface

`ai/product/strategies.md` now fixes the Strategy-facing basis as **average cost**, so
`AVERAGE_COST` is the implementation, not a preference. The policy interface is kept because how
average cost _evolves_ across repeated BUYs and partial SELLs is still execution behaviour (open
question 5, now narrowed), and because fees would enter through it if they are ever added:

```ts
interface CostBasisPolicy {
  readonly id: string; // recorded in the run snapshot as a methodology version
  onBuy(
    state: PositionState,
    shares: number,
    price: number,
    fees: number,
  ): PositionState;
  onSell(
    state: PositionState,
    shares: number,
    price: number,
    fees: number,
  ): PositionState;
  basisPerShare(state: PositionState): number;
}
```

Two implementations cover the plausible answers:

- **`AVERAGE_COST` (recommended default)** — `costTotal` and `shares` accumulate on BUY; a partial
  SELL reduces both proportionally, so `basisPerShare` is unchanged by partial sells. State is two
  numbers, and the whole policy is O(1).
- **`FIFO_LOTS`** — an ordered lot list; a partial SELL consumes the oldest lots, so `basisPerShare`
  of the remainder moves. State is O(number of BUY levels fired), which the strategy bounds.

`AVERAGE_COST` is recommended because a strategy's partial SELL percentage is expressed as a
fraction of the _remaining position_ (product), which is inherently proportional rather than
lot-oriented, and because it makes `Gain` after a partial sell continue to describe the same
position rather than jumping when a lot is consumed. `ai/product/backtests.md` already requires the
snapshot to carry methodology versions, so `CostBasisPolicy.id` belongs there.

### 3.4 Position state and the position epoch

```ts
type PositionState = {
  securityId: SecurityId;
  epoch: number; // increments each time a new position is opened for this security
  openedDate: LocalDate;
  shares: number;
  costTotal: number; // or lots, per policy
  buyLevelsFired: ReadonlySet<LevelId>;
  sellLevelsFired: ReadonlySet<LevelId>;
  previousSignedReturnPercent?: number; // the value as computed on the previous trading day
  previousValueDate?: LocalDate;
};
```

`epoch` is the mechanism that keeps a closed-and-reopened position from inheriting the previous
position's history. `buyLevelsFired` / `sellLevelsFired` exist to answer open questions 1 and 2
once they are decided; they are carried in state now so the answer does not require reshaping the
model later.

### 3.5 Availability rules

`Gain`/`Loss` are `NOT_EVALUABLE`, never `FALSE`, whenever:

- **no position is open** for that security on `t`. The product lists position state explicitly as a
  `NOT_EVALUABLE` cause. In practice SELL and FINAL EXIT levels are only evaluated for open
  positions, so this is structural rather than a per-date check;
- `close[t]` is unavailable (no price row for that eligible date);
- `basisPerShare <= 0`, which a positive execution price makes unreachable but which is guarded
  rather than assumed.

### 3.6 Triggers on a position-dependent metric

A Trigger needs `t` and `t - 1`. For a position-dependent metric the previous value exists only if
**the same position** was open on the previous eligible trading day:

```
positionTriggerEvaluable(t) =
  position is open at t
  AND previousValueDate == dates[i - 1]
  AND previousEpoch == currentEpoch
```

Three consequences, all deliberate:

1. On the **entry date** every position-dependent Trigger is `NOT_EVALUABLE`: there is no previous
   value for this position, and reaching back to a market-derived day before entry would compare
   against a basis that did not exist.
2. A position closed and reopened starts a fresh epoch, so no Trigger straddles the gap. Without the
   epoch check a `Loss crosses above 10%` could fire on the first day of a new position by comparing
   against the _old_ position's loss.
3. The previous value is the one that **actually held** during the simulation — recorded when it was
   computed, not recomputed from the current basis. Under `FIFO_LOTS` a partial sell changes
   `basisPerShare`, and recomputing yesterday's value under today's basis would fabricate or erase
   a crossing that the simulation never experienced.

Storage is one number and one date per open position — O(`maximumPositions`), not O(days).

### 3.7 Combining with the market gate

For one open position on frame index `i`, a SELL or FINAL EXIT level resolves as:

```
level[i] = marketGate[levelId][i]  AND  positionPredicates(level, position, i)
```

using the same Kleene strong AND of §2.4. `positionPredicates` evaluates **every** position-dependent
Condition and the Trigger if it is position-dependent — it does not short-circuit on a `FALSE` gate.
Short-circuiting would give the same level result (FALSE absorbs) but would leave the per-predicate
diagnostic counters of §2.9 counting different day sets for market and position predicates, which
makes the "why did this rule never fire?" report incoherent. The cost of not short-circuiting is a
subtraction and a comparison per predicate per open position per day, bounded by `maximumPositions`.

A level mixing both kinds needs no special case: the market half comes from the precomputed gate,
the position half from live state, and one AND joins them.

### 3.8 Placement

All of Phase 3 is pure and belongs in `@intrinsic/strategy` beside the Phase 2 evaluator:
`PositionState`, the `CostBasisPolicy` implementations, the position-metric resolver and the level
combiner. It takes prices and the precomputed gate as inputs and performs no I/O, so the same code
serves the worker's backtest and a future monitor evaluating current data — the product requires
monitoring to reuse canonical Strategy logic rather than define a second language.

### 3.9 Determinism

Position state changes only through executed actions applied in ascending date order; the epoch
counter is a per-security integer advanced on open; no clock, no hash-order iteration, and no
floating-point accumulation that depends on evaluation order beyond the executed sequence itself.
Two runs of the same snapshot produce identical position histories.

---

## Phase 4 — How the backtest engine combines them

### 4.1 Run lifecycle across the process boundary

```
apps/api                                  apps/worker
--------                                  -----------
validate strategy + list ownership
resolve StockList -> Security[]
normalize per-symbol buy windows
freeze immutable run snapshot
INSERT BacktestRun (status QUEUED)  --->  claim (FOR UPDATE SKIP LOCKED)
                                          load frames  (@intrinsic/stock-data)
                                          precompute gates (@intrinsic/strategy)
                                          simulate day loop
                                          persist trades / equity / summary
                                          status COMPLETED | FAILED
expose run state + results         <---
```

Both processes call the same `@intrinsic/strategy` and `@intrinsic/stock-data`; neither owns a
second business implementation. `apps/worker/package.json` must gain
`@intrinsic/contracts`, `@intrinsic/domain`, `@intrinsic/database`, `@intrinsic/fmp`,
`@intrinsic/stock-data` and `@intrinsic/strategy` — today it depends only on `config` and
`observability`.

### 4.2 The durable-work substrate

Nothing exists (Phase 1, fact 9), so this must be designed rather than wired.

**Recommendation: claim the `BacktestRun` row itself in PostgreSQL with
`SELECT ... FOR UPDATE SKIP LOCKED` plus a renewable lease.** No queue library.

```
status         QUEUED | CLAIMED | RUNNING | COMPLETED | FAILED | CANCELLED
claimedBy      worker instance id
leaseExpiresAt timestamp, renewed on the progress cadence
attempts       int, bounds retries
```

Why not the alternatives:

- **BullMQ / Redis queue** — `AGENTS.md` invariant 8 forbids Redis being the only store for
  completed or user-owned state, so PostgreSQL would hold the run anyway and the two could
  disagree. A Redis flush would strand `QUEUED` runs and require a reconciler whose only job is to
  repair a split truth.
- **pg-boss** — manages its own schema and migrations, against "One canonical Prisma schema. One
  migration history."
- A new dependency also has to clear "Add dependencies only when there is a concrete use."

With the claim on the run row, the durable record _is_ the queue, so they cannot diverge; a Redis
flush is harmless; and an expired lease is self-healing — another worker reclaims. Backtests run for
minutes, so a 1–5s poll costs nothing; `LISTEN`/`NOTIFY` can remove submission latency later without
changing the model.

### 4.3 Schema sketch

Requires an explicit migration and a migration note, and — because it is a storage-shape decision —
an ADR under `docs/decisions/`.

| Model                 | Shape                                                                                                                                                               | Note                                                                                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Strategy`            | user-owned identity, name, description                                                                                                                              | editing creates a new version, never mutates one                                                                                                                                                           |
| `StrategyVersion`     | `versionNumber`, `definition` JSONB, `definitionHash`, immutable                                                                                                    | one column that is never updated is the cheapest way to make "immutable version" true; the shape is owned and validated by `@intrinsic/contracts`, and nothing needs to query _inside_ a definition in SQL |
| `BacktestRun`         | ownership, `strategyVersionId`, `stockListId`, period, capital, contribution, `maximumPositions`, `snapshot` JSONB, claim/lease/progress columns, timestamps, error | the snapshot must be frozen, which is exactly what a normalized child table is bad at                                                                                                                      |
| `BacktestTrade`       | run, date, security, action (`BUY`/`SELL`/`FINAL_EXIT`), level id, shares, price, fees, cash after                                                                  | the audit trail                                                                                                                                                                                            |
| `BacktestDailyEquity` | run, date, cash, positionsValue, totalValue                                                                                                                         | ~7,560 rows for a 30-year run                                                                                                                                                                              |
| `BacktestRunSummary`  | aggregate metrics                                                                                                                                                   | one row per run                                                                                                                                                                                            |

`BacktestRun.snapshot` carries everything `ai/product/backtests.md` requires — strategy identity and
normalized configuration, resolved securities with their per-symbol buy windows, requested period,
capital and contribution assumptions, `maximumPositions` and the derived full-position policy, and
the candidate-ordering and execution-engine methodology versions — plus `CostBasisPolicy.id` from
§3.3.

**Record `DERIVED_STATE_REVISION` and `PRICE_DATASET_VERSION` in the snapshot too.** A completed
run's stored results are immutable, but the derived state it read is _replaced_, not versioned, on a
methodology bump. Re-executing the same snapshot later can therefore produce different numbers.
Recording the revisions does not make that reproducible — it makes the difference explainable
instead of mysterious.

### 4.4 The union calendar — superseded

> **Not what was built.** This section is kept as design history. The portfolio's axis is the pinned
> execution calendar alone, and security dates never add to it; a single anomalous provider bar
> would otherwise have decided the run's first simulated date, its return-index base and a month's
> contribution date. See `backtest-execution.md` and
> `docs/decisions/backtest-year-window-execution-and-absolute-comparison.md`.


There is no trading-calendar table and each security has its own eligible dates (Phase 1, fact 1),
so the portfolio needs one axis. **Use the ascending union of the eligible dates of every security
in the run and of the run's pinned execution calendar**, restricted to the period. The intersection
would silently drop dates.

The execution calendar is a required system input taken from a reference series the engine
designates — never from the comparison benchmark the user selected, which contributes no dates at
all. Without it a run whose securities all list after its start would not exist until the first of
them began trading, and every monthly contribution before that date would be skipped. It is decided
and versioned in `backtest-execution.md`; there is no securities-only fallback.

Two rules keep the union honest:

- **Predicates are never carried forward.** A security with no row on a union date has every
  operand absent, so its levels are `NOT_EVALUABLE` and it simply takes no action that day.
- **Valuation is carried forward.** Portfolio value on date `d` is
  `cash + Σ(shares × mostRecentCloseAtOrBefore(d))`. A position must be valued every day the
  portfolio is valued, and its last known close is the only PIT-correct value available. This is
  valuation only and never feeds a predicate.

### 4.5 The day loop

For each date `d` in the union calendar, in fixed phase order:

1. **Cash in** — apply the monthly contribution if `d` is the contribution date (open question 8).
2. **Value** the portfolio using §4.4.
3. **Exits**, for each open position in deterministic order: evaluate FINAL EXIT, then SELL levels
   in definition order, each as `marketGate AND positionPredicates` (§3.7). Execute per open
   questions 2, 3 and 4.
4. **Entries**: for each list security whose `BuyWindowConfiguration` admits `d`, read the
   precomputed BUY gate (§3.1) — an indexed `Uint8Array` read, not an evaluation. Collect matching
   levels per open questions 1 and 4.
5. **Allocate**: order candidates (open question 6), then size each under the derived policy —
   `fullPositionFraction = 1 / maximumPositions`, full-position budget =
   `portfolioValue(d) × fullPositionFraction`, target = `budget × levelPercentage`. An open symbol
   occupies one slot regardless of fill percentage; cash and slot capacity are enforced here.
6. **Execute**, update position state and the `previousSignedReturnPercent` of §3.4, append trades.
7. **Record** the daily equity row.

Exits run before entries so that a slot and the cash a sale frees are available on the same date.
That is an inference, not a stated rule, and it changes results — open question 13.

### 4.6 Residency and the memory budget

The day loop is portfolio-wide, so every security's frame must be readable on every date. With the
§2.5 projection the cost is `securities × tradingDays × operands × 8 bytes` plus
`securities × levels × tradingDays` bytes for the gates:

| Run                                    | Frames  | Gates  |
| -------------------------------------- | ------- | ------ |
| 100 symbols, 30y, 6 operands, 5 levels | ~36 MB  | ~4 MB  |
| 500 symbols, 30y, 6 operands, 5 levels | ~181 MB | ~19 MB |

Loading raw `DailyDerivedState` objects instead would be 2.5–4 GB for the same 500-symbol run, which
is why the projection is a design requirement and not an optimization.

Two protections:

1. **Reject at submission, never OOM mid-run.** Validate
   `securities × estimatedTradingDays × operands` against a configured budget and fail the
   submission with a clear message. A worker killed by the OS after twenty minutes is the worst
   possible failure mode for long-running durable work.
2. **Keep a time-sliced mode possible.** The loop is strictly ascending in time, so frames can be
   loaded per year slice while position state carries across slices. Define the frame accessor as an
   interface now so a windowed implementation can replace the resident one without touching the
   engine. Do not build it in V1.

### 4.7 Progress, lease and cancellation

One cadence — every N dates or M seconds — does three things: renew `leaseExpiresAt`, write durable
progress to PostgreSQL, and re-read the cancellation flag. Redis may mirror progress for cheap
polling (`ai/architecture/system-overview.md` explicitly permits ephemeral progress there), but
PostgreSQL stays the truth. A crashed worker's lease expires and the run is reclaimed;
`attempts` bounds the retries before `FAILED`.

### 4.8 Frame loading and provider pressure

Frames load per security through `getDailyEvaluationFrame` (§2.7): one `ensureStockHydrated` +
`ensureStockFresh` each, serialized per security by `stock-data:load:hydrate:<securityId>` and
throttled across processes by the shared FMP gate. Load with bounded concurrency; the gate already
shares 429 cooldown between API and worker, so a large backtest must not starve Stock Details.
Emit `backtest.frames.loaded` with `durationMs` and the security count — the first run after a
`DERIVED_STATE_REVISION` bump rebuilds every security in the list and will be visibly slower.

### 4.9 Observability

Stable events with `runId`, `actorUserId`, `component`, and `symbol` where applicable:
`backtest.run.submitted` (API), `backtest.run.claimed`, `backtest.frames.loaded`,
`backtest.run.progress` (debug), `backtest.run.completed` (`durationMs`, trade count),
`backtest.run.failed`, `backtest.run.lease_expired`. The job is the run row, so the claim itself
carries the correlation fields across the process boundary; the worker recreates the logging context
from them, as `ai/architecture/observability.md` requires.

### 4.10 How this is proven correct

- **Tri-state tables** for every operator, in the oracle style of
  `wilder-rsi-oracle.test-helper.ts`.
- **No-lookahead prefix test at engine level**, mirroring the existing calculator tests: running
  `[start, T]` and `[start, T + k]` must produce identical trades up to `T`. This is the single
  strongest guard on the whole design.
- **Determinism test**: the same snapshot executed twice yields byte-identical trades and equity.
- **Epoch test**: close and reopen a position and assert no position-dependent Trigger straddles the
  gap (§3.6).
- **Claim/lease integration test** against a real PostgreSQL via `@intrinsic/testing`: concurrent
  claims take disjoint runs, an expired lease is reclaimed, `attempts` bounds retries.

### 4.11 Monitors

A monitor evaluates the same levels on the latest eligible date using the same
`@intrinsic/strategy` code with a frame of one or two dates. Nothing in Phases 2–4 is
backtest-specific except the day loop and the portfolio state, which a monitor does not use — which
is what keeps the product's "monitoring must not define a second strategy language" rule true by
construction rather than by discipline.

---

## Open product questions

Recorded, not answered. Each blocks a specific engine rule; work that does not depend on it
continues. Items 1–5 are flagged as open by `ai/product/strategies.md` itself; items 10–11
came out of the Phase 2 design, 12 out of Phase 3 and 13 out of Phase 4.

**Items 10, 11 and 12 are now RESOLVED** as product decisions and are canonical in
`ai/product/strategies.md`; item 5 is narrowed. They are kept here with their answers rather than
deleted, so the reasoning that produced them stays legible. Everything else remains open and
untouched, and is not to be resolved as part of Strategy Builder work.

1. **Repeated BUY levels against an already-open position.** May a BUY level fire again while a
   position is open? May a _different_ BUY level add to it? (`strategies.md` § BUY levels.)
2. **SELL level repetition.** May one SELL level fire more than once per position lifecycle?
   (`strategies.md` § SELL levels.)
3. **SELL vs FINAL EXIT precedence on the same date.** (`strategies.md` § FINAL EXIT.)
4. **Multiple matching levels of the same family on one date.** Deterministic resolution — highest
   percentage, definition order, or all in order. (`strategies.md` § Level composition.)
5. **Gain/Loss cost-basis semantics.** **Narrowed.** `ai/product/strategies.md` now defines both
   metrics against **average cost**, so the choice between average cost, FIFO lots and first-entry
   price is settled. What remains open is execution behaviour: how average cost evolves across
   repeated BUY levels and partial SELLs within one position lifecycle, and whether fees enter the
   basis if they are ever added (question 7).
6. **Candidate ordering across securities.** `ai/product/backtests.md` requires the snapshot to
   record a "candidate-ordering methodology version" but never defines the ordering used when cash
   or position slots cannot satisfy every matching symbol on a date.
7. **Execution assumptions.** `backtests.md` lists "execution assumptions" as a submission input
   without defining them: signal-date close vs next-day open, slippage, and whether fees exist at
   all (`strategies.md` mentions fees, `backtests.md`'s input list does not).
8. **Monthly contribution timing.** Which date of the month, and behaviour when it is not a trading
   day.
9. **Currency.** `DailyDerivedState.intrinsicCurrency` and `Security.currency` exist; whether a
   backtest may mix currencies in one portfolio, and at what rate, is undecided.
10. **Margin of Safety when the intrinsic value is not positive.** **RESOLVED: `NOT_EVALUABLE`.**
    Now stated canonically in `ai/product/strategies.md` § Margin of Safety, together with the
    formula (denominator is intrinsic value, never price), the distinction from upside, and the rule
    that each MOS metric reads only its own explicitly selected intrinsic-value series.
11. **May a moving average be a Metric?** **RESOLVED: yes, in V1.** MA-vs-MA Conditions and
    Triggers are supported, with Values resolved through `comparableMovingAverages(seriesId)` —
    same timeframe, never itself, never inferred from numeric similarity. See
    `ai/product/strategies.md` § Moving averages and the updated § Consumer filtering in
    `docs/decisions/selectable-series-catalog.md`. §2.2's registry expresses it as predicted.
12. **Is `Loss` the unclamped mirror of `Gain`?** **RESOLVED: no.** `Gain` is signed;
    `Loss = max(0, (AverageCost - Price) / AverageCost * 100)` is non-negative and clamped at zero,
    with the domain `0…100`. §3.2 has been corrected to match. `ai/product/strategies.md` § Gain and
    Loss is canonical.
13. **Do exits run before entries on the same date?** §4.5 evaluates FINAL EXIT and SELL before BUY
    so a freed slot and freed cash are usable the same day. The opposite order produces different
    results. `ai/product/backtests.md` does not state an order.

---

## Consolidated technical recommendation

**Build one pure evaluator that produces date-aligned tri-state series, keep every operand value in
compact typed arrays projected from the existing `DailyDerivedState`, precompute BUY signals
entirely, and evaluate only the position-dependent half live inside a PostgreSQL-claimed worker
run.**

Five decisions carry the design; everything else follows from them.

1. **A new pure `@intrinsic/strategy` package, with the compatibility matrix in
   `@intrinsic/contracts`.** The matrix must be reachable from `apps/web`, which may depend on
   contracts alone; the evaluator needs both the catalog and the domain row shapes, and neither
   `domain` nor `contracts` may depend on the other. This split is what makes "Strategy Builder and
   backend validation share canonical definitions" structural rather than aspirational. It requires
   one explicit addition to the **Dependency rules** in `AGENTS.md`.

2. **Project, do not carry rows.** Reduce each security to a columnar frame of only the operands the
   strategy version references (`Float64Array`, `NaN` = absent). It is the difference between ~36 MB
   and ~3 GB for a large run, and it costs nothing in precision because `prisma-store.ts` already
   hands out doubles. Apply the intrinsic per-model and per-blend provenance gate _during
   projection_, inside `@intrinsic/stock-data`, so the pure evaluator physically cannot read an
   ungated value.

3. **Exploit the BUY/SELL asymmetry.** The product forbids Gain/Loss in BUY rules, so every BUY
   signal is fully precomputable into a `Uint8Array` gate before the simulation starts, and the live
   per-date work is bounded by `maximumPositions` rather than by the size of the stock list. Model
   position-dependent metrics with an explicit `PositionState` carrying a **position epoch** and the
   _as-computed_ previous value, so a Trigger can never straddle a closed-and-reopened position or
   compare against a basis that has since changed.

4. **Claim the `BacktestRun` row in PostgreSQL; add no queue library.** The durable record and the
   queue become the same row, so they cannot disagree, a Redis flush is harmless, and an expired
   lease self-heals — which is exactly what `AGENTS.md` invariants 7 and 8 ask for, without a new
   dependency or a second migration history.

5. **Guard correctness with a no-lookahead prefix test at engine level.** Running `[start, T]` and
   `[start, T + k]` must yield identical trades through `T`. The calculators already use this
   pattern; applied to the whole engine it is the one test that can catch a future-information leak
   anywhere in the chain.

### Suggested build order

Each step is independently reviewable and leaves the repository working.

| #   | Step                                                                                                                   | Blocked by                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | Strategy DTOs + compatibility registry + `CLOSE_TO_TOLERANCE` in `@intrinsic/contracts`                                | question 11 (may a moving average be a Metric) |
| 2   | `@intrinsic/strategy`: tri-state algebra, operand resolution, condition/trigger evaluation, unit-tested against tables | —                                              |
| 3   | `Strategy` / `StrategyVersion` schema + migration + ADR; API CRUD and validation reusing step 1                        | —                                              |
| 4   | Strategy Builder UI against the same registry (`ai/product/strategies.md` § Builder UX)                                | step 1                                         |
| 5   | `getDailyEvaluationFrame` in `@intrinsic/stock-data` (`Security`-keyed, gated, joined)                                 | —                                              |
| 6   | Per-level market gates + diagnostics counters                                                                          | steps 2, 5                                     |
| 7   | `PositionState`, `CostBasisPolicy`, position-metric evaluation                                                         | question 5, question 12                        |
| 8   | `BacktestRun` schema, claim/lease, worker process wiring                                                               | —                                              |
| 9   | The day loop, allocation and execution                                                                                 | questions 1, 2, 3, 4, 6, 7, 8, 13              |
| 10  | Results persistence, API read surface, Backtests UI                                                                    | step 9                                         |

Steps 1–8 can proceed now. **Step 9 is the one that genuinely blocks**: it needs eight of the
thirteen open questions answered, because each is a rule the day loop must apply and none can be
inferred without inventing product behaviour. Resolving questions 1–8 and 13 is therefore the
highest-value thing to do before implementation starts.

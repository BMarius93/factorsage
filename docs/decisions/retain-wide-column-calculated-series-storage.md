# Retain Wide-Column Calculated-Series Storage

## Status

**Accepted.**

Supersedes nothing. It records the storage decision that the unified daily derived state in
`stock-data-foundation.md` left implicit, and it constrains how every future calculated series is
added. All point-in-time, completed-week, materialization and provenance rules in
`stock-data-foundation.md`, `intrinsic-value-engine.md` and `selectable-series-catalog.md` remain
authoritative and unchanged.

`ai/architecture/calculated-series.md` describes how the accepted model is implemented.
`docs/development/adding-a-calculated-series.md` is the checklist for adding one.

## Decision

FactorSage stores each calculated daily series as its **own explicit nullable PostgreSQL column**
on `DailyDerivedState`.

1. **Explicit columns.** Every scalar series is one nullable `DECIMAL(20,8)` column
   (`packages/database/prisma/schema.prisma`, model `DailyDerivedState`). `NULL` means the value is
   not eligible on that trading day; it is never zero and is never back-filled before the value's
   first eligible day.
2. **One logical row per `(securityId, date)`** remains an invariant. The composite primary key is
   the identity. No calculation-version column ever participates in it, no derived family gets its
   own daily table, and no per-series cache key is introduced.
3. **PostgreSQL remains the persistent source of truth.** Derived values are reproducible from
   canonical `DailyPrice` and point-in-time `FinancialStatement` revisions under the current
   methodology, but PostgreSQL is what is read back and what survives.
4. **Redis remains a disposable acceleration layer.** A flush costs latency, never data. It caches
   the same daily rows as yearly chunks and participates in complete-stock LRU residency.
5. **Stable catalog ID, product label and storage field name are three separate concepts.** The
   catalog ID (`SMA_20D`) is the durable machine identity that selection state, API filters and
   future Strategy persistence use. The label (`SMA 20D`) is product presentation and is never an
   identity. The storage field (`sma20d`) is the persistence name. They are related by convention
   and pinned by tests, not by string parsing at runtime.
6. **New scalar series are added with additive Prisma migrations** — a nullable column, existing
   rows left `NULL`, no SQL back-fill. The canonical rebuild is the only calculation path.
7. **JSONB is deferred**, not the current target. It is a documented future option with explicit
   triggers below, not a direction this codebase is moving toward by default.
8. **PostgreSQL EAV (`(security, date, series_id, value)`) is rejected** for this workload.

## Scope of validity

This model is accepted for the **expected range of approximately 40–100 explicitly defined,
product-owned series**. Below roughly 40 the cost is trivially acceptable; toward 100 the
constraints below begin to bind and the triggers should be re-examined rather than ignored.

The model assumes series are **explicitly defined by the product and known at build time**. It does
not accommodate user-defined or runtime-defined series at all — that is a trigger, not a
limitation to work around.

## Evidence

Measured on the development PostgreSQL and Redis instances (7 hydrated securities, 30,792
`DailyDerivedState` rows, 21 series):

| Measurement | Value |
| --- | --- |
| `DailyDerivedState` heap size / rows | 7,120 kB / 30,792 = **236.8 B per row** |
| `avg(pg_column_size(row))` | **212.6 B** |
| `DailyDerivedState` total relation (incl. primary key) | **10 MB** |
| `DailyPrice` per-row size, for comparison | 110.7 B |
| Redis `daily-state:<year>` chunk (one security, one year) | **169,617 B** (~652 B per trading day) |
| Redis footprint, whole cache | **32.78 MB** for 7 resident stocks (2,489 keys) |
| One fully warmed 21-series row, serialized | **772 B**, of which **434 B (56%)** are JSON field names and syntax |
| Full 20-year derived rebuild (technicals + weekly + carry-forward) | **~240 ms** of CPU per security |

Estimated by projection from those measurements (script, not measured against a live system):

| Projection | 21 series | 50 series | 100 series |
| --- | --- | --- | --- |
| Redis year chunk per security | 190 KB | 383 KB | 715 KB |
| Redis 30-year footprint per security | 5.6 MB | 11.2 MB | 21 MB |
| Redis resident set at `maxResidentStocks = 100` | ~0.56 GB | ~1.1 GB | ~2.1 GB |
| EAV rows, 1,000 securities × 30 years | 159 M | 378 M | 756 M |

Judgment, stated as judgment: the binding constraint at the top of the accepted range is **not**
PostgreSQL — a 100-series wide row remains comfortably inside the 1 KB budget below — but the
**row-oriented Redis chunk**, whose 56 % field-name overhead is paid per row per year. If the range
is pushed toward 100 series, changing the Redis chunk layout is the cheaper intervention, and it is
independent of this decision because Redis is disposable.

## Budgets

These are the thresholds this decision is accepted against. Exceeding one is a trigger to
re-open it, not something to absorb silently.

| Budget | Threshold | Measured today |
| --- | --- | --- |
| Average `DailyDerivedState` heap row size | ≤ 1 KB | 236.8 B |
| Redis footprint per security, 30-year history | ≤ 12 MB | ~4.7 MB |
| Redis resident set at configured `maxResidentStocks` | ≤ 2 GB | 32.78 MB (7 stocks) |
| Series-adding migrations | ≤ ~1 per sprint, sustained | well below |

## Triggers for reconsidering JSONB

Re-open this decision when **any** of the following becomes true:

1. **Hundreds of series.** The catalog credibly heads beyond ~100 explicitly defined series.
2. **User-defined or runtime-defined series.** Any requirement for a series whose existence,
   parameters or formula is chosen at runtime rather than committed to the repository. The
   wide-column model cannot express this at all: a column cannot be created per user.
3. **Unacceptable migration frequency.** Adding series requires migrations more often than roughly
   once per sprint on a sustained basis, or migrations start being batched purely to avoid the
   per-series cost.
4. **Measured budget breach.** Any budget in the table above is exceeded by measurement, not by
   estimate.

Until then, JSONB stays out of the schema and out of the architecture documents except under an
explicit Deferred/Future heading.

## Why EAV is rejected

- **Row explosion.** 159 M rows today's series count, 756 M at 100 series, for 1,000 securities
  over 30 years — before indexes, and for a workload whose only access pattern is a contiguous
  range scan the existing composite primary key already serves.
- **It is a regression, not a novelty.** Migration `20260830210000_unify_daily_derived_state`
  deliberately replaced per-family derived tables and calculation versions with the single unified
  row. Long-form rows would reintroduce the shape that decision removed.
- **Read cost.** Every consumer would pivot sparse rows back into a daily state, which is exactly
  the sparse-event reconstruction `stock-data-foundation.md` forbids backtests from doing.

The API's intrinsic-value endpoints already return long-form points
(`IntrinsicValueResponse` in `packages/contracts/src/stock-data.ts`). That is a wire projection and
is unaffected by this decision; it is not storage.

## Consequences and accepted tradeoffs

Accepted costs:

- **Adding a series touches ~12 files**, including three hand-written mappings in
  `packages/stock-data/src/prisma-store.ts` (`DailyDerivedStateRow`, `dailyDerivedStateFromRow`,
  `dailyDerivedStateToRow`). This is the price of the model and is documented rather than hidden.
- **A partially wired series fails silently.** Absence is how unavailability is represented, so a
  missing column or a missing mapper reads back exactly like a warm-up gap. This is mitigated by
  registry-driven completeness tests, not by discipline: `derived-state.integration.test.ts`
  asserts every registered field has a real column via `information_schema`, and the round-trip and
  Redis parity suites iterate the registries.
- **Schema evolution is a migration**, so series cannot be added by configuration.

Accepted benefits:

- The schema is self-describing and debuggable directly in `psql`.
- Type safety is real: `DailyMovingAverageField`/`WeeklyMovingAverageField` make an unregistered
  field a compile error.
- No pivot, no JSON extraction and no query planning surprises on the only hot access path,
  `securityId + date range ascending`.
- Numeric behaviour is unchanged and explicit.

### Accepted limitation: the global derived-state revision

`DERIVED_STATE_REVISION` (`packages/stock-data/src/derived-state.ts`) is a single global number.
Bumping it for one series invalidates the coverage and cache manifests of **every** series for
every security, and the affected history is rebuilt lazily on next access.

This is **accepted for now**. It is observable in production data: after the r2 → r3 bump that
added the weekly moving averages, the hydrated securities carry `NULL` weekly columns until each is
next accessed — 701 of 30,792 rows had weekly values at the time of measurement.

Per-family or per-series revisions are a **deferred** design, not part of this decision. Revisit
when rebuild cost becomes user-visible or when a family's rebuild frequency diverges materially
from the others.

### Deferred: NOT_EVALUABLE reason persistence

The evaluator produces rich unavailability reasons — `EvaluatedIntrinsicModel` carries
`phase: "ASSEMBLY" | "VALUATION"` plus a reason code from
`IntrinsicValueAssemblyReason` or `VALUATION_NOT_APPLICABLE_REASONS`. `toSnapshot` in
`packages/stock-data/src/intrinsic-value-materializer.ts` collapses all of them to field absence
before persistence, so storage cannot distinguish "not yet eligible" from "not applicable" from
"invalidated by a later revision".

Whether Strategy's `NOT_EVALUABLE` requires those reasons to be **persisted**, or whether deriving
them at evaluation time is sufficient, is a **deferred Strategy decision**. It is deliberately not
settled here: persisting a reason per series per trading day is a storage-shape change that should
be decided together with the Strategy engine that would consume it, not in advance of it.

## Non-goals

This decision does **not**:

- migrate calculated values to JSONB, now or on a schedule;
- introduce EAV or any long-form storage table;
- redesign the Redis layout, introduce a v3 namespace, or change to column-oriented chunks;
- introduce a generic `/series` API endpoint;
- introduce per-family or per-series revisions;
- change any financial formula, warm-up convention or point-in-time rule;
- add RSI, MACD, growth or ratio series;
- make `WeeklyPrice` a generic derived-series value — it remains completed-week OHLCV source data;
- claim the wide-column model is correct beyond the stated range and budgets.

## References

- `ai/architecture/calculated-series.md` — how this is implemented.
- `docs/development/adding-a-calculated-series.md` — the extension checklist.
- `docs/decisions/stock-data-foundation.md` — unified daily derived state, PIT and weekly rules.
- `docs/decisions/selectable-series-catalog.md` — the product catalog and its identities.
- `docs/decisions/intrinsic-value-engine.md` — model formulas, provenance and availability rules.

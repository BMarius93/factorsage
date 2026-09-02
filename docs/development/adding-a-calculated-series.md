# Adding a Calculated Series

How to add one new daily-materialized calculated series to FactorSage, under the architecture the
project deliberately keeps: **one explicit PostgreSQL column per series**.

Read `AGENTS.md` and `ai/README.md` first. This guide is the operational checklist; the product and
architecture invariants live in `docs/decisions/stock-data-foundation.md`,
`docs/decisions/selectable-series-catalog.md` and `docs/decisions/intrinsic-value-engine.md`, and
they win wherever this guide is less specific.

## Read this before trusting the checklist

**The checklist below is a starting point, not an oracle.** It was accurate when written and will
drift. If you are an AI agent, or a human working quickly:

1. **Search before you edit.** `rg 'sma200w'` (or any existing field name) across the repository
   finds every place a series is currently mentioned. That search is the real checklist. If it
   returns a file this guide does not name, this guide is stale — update it.
2. **Let the completeness tests find what you missed.** Several tests iterate the registries rather
   than naming series, so a half-wired series fails them without anyone remembering to add an
   assertion:
   - `packages/stock-data/src/daily-technicals.test.ts` and `weekly-technicals.test.ts` — every
     registered period is calculated, with the documented warm-up.
   - `packages/stock-data/src/derived-state.integration.test.ts` — every registered field has a
     real PostgreSQL column (checked against `information_schema`) and survives a round trip.
   - `packages/stock-data/src/redis.integration.test.ts` — every registered field survives Redis
     and is rebuilt identically after eviction.
   - `apps/api/src/stocks/stocks.integration.test.ts` — every catalog moving-average id is
     addressable through `series=` and projects its own field.
   - `packages/contracts/src/selectable-series.test.ts` — the one deliberate catalog snapshot.
   Run them and read the failures; they are more reliable than this document.
3. **Do not delete a step because it looks unnecessary.** Absence is how this system represents
   unavailability, so a forgotten step usually produces silence, not an error: a column that is
   never written reads back exactly like an indicator that has not warmed up.

## Why the wide-column model is kept

One nullable `DECIMAL(20,8)` column per series per trading day, `PRIMARY KEY (securityId, date)`.
JSONB, EAV and per-series cache keys were evaluated and rejected: the only historical access
pattern is `securityId + date range, ascending`, which the composite primary key already serves,
and the explicit columns keep the schema self-describing and debuggable in `psql`. The cost is that
adding a series touches several files. This guide makes that cost predictable rather than removing
it.

Consequences worth internalising:

- **A series is not real until its column exists.** The registry, the calculator and the mapper can
  all be correct while the migration is missing, and nothing raises: the value is dropped on write
  and reads as absent.
- **Absent never means zero.** Never write `0`, never `COALESCE`, never back-fill a value before
  its first eligible trading day.
- **There is one current methodology.** No calculation-version column, ever. A methodology change
  is a rebuild driven by `DERIVED_STATE_REVISION`.

## Decide these before writing code

| Decision | Where it is recorded |
| --- | --- |
| Stable catalog ID (e.g. `SMA_100W`) — permanent; future Strategy conditions persist it | `packages/contracts/src/selectable-series.ts` |
| Family and timeframe (daily bars vs completed weekly bars vs fundamentals-driven) | domain registry |
| Product label, and a `shortLabel` only if a dense surface genuinely renders something different | catalog entry |
| Group and position in canonical order (drives picker grouping and overlay colour) | catalog entry |
| Unit and comparability (price-like? ratio? unitless oscillator?) — decides which Strategy operands it may face | product decision doc |
| Persisted field name, with its explicit timeframe suffix (`d` / `w`) | domain registry + Prisma column |
| Warm-up rule and seeding convention | calculator + its test |
| Point-in-time rule: what must be public by the trading day's cutoff | calculator + no-lookahead test |
| Whether it carries provenance (fundamentals-driven series do; price-derived ones do not) | schema, if applicable |

A series whose value has meaningful provenance needs its own provenance column and mapping, the way
each intrinsic model does — see `INTRINSIC_MODEL_SOURCE_FIELDS` in
`packages/stock-data/src/intrinsic-values.ts`. Do not attach a value to another series' provenance.

## Checklist: a new period in an existing family

The cheapest case — for example adding `SMA 100W` if it did not exist. The calculators are
registry-driven, so they need no edit.

1. **Catalog entry** — `packages/contracts/src/selectable-series.ts`: add to
   `SELECTABLE_SERIES_CATALOG` in canonical order, with `id`, `group`, `label` and the structured
   `source`.
2. **Catalog snapshot** — `packages/contracts/src/selectable-series.test.ts`: add the row to
   `EXPECTED_CATALOG`. This is the one place a count or membership is intentionally hardcoded;
   every other assertion derives from the catalog.
3. **Domain registry** — `packages/domain/src/stock-data.ts`: add to `DAILY_MOVING_AVERAGES` or
   `WEEKLY_MOVING_AVERAGES`. `MATERIALIZED_MOVING_AVERAGES` and the field types follow.
4. **Domain shapes** — same file: add the optional field to `DailyTechnical` and
   `DailyDerivedState`.
5. **Domain registry test** — `packages/domain/src/stock-data.test.ts`: add the entry to the pinned
   registry table.
6. **Wire contract** — `packages/contracts/src/stock-data.ts`: add the optional field to
   `DailyTechnicalResponse`. Keep the timeframe suffix; never introduce an ambiguous `sma20`.
7. **Prisma column** — `packages/database/prisma/schema.prisma`: nullable `Decimal @db.Decimal(20,8)`.
8. **Migration** — additive, nullable, leaving existing rows `NULL`. Never back-fill in SQL: the
   canonical rebuild is the only calculation path. Include a short migration note explaining that
   the revision bump is what repopulates the rows.
9. **Persistence mapping** — `packages/stock-data/src/prisma-store.ts`, three places:
   `DailyDerivedStateRow`, `dailyDerivedStateFromRow`, `dailyDerivedStateToRow`. Omitting the row
   type is a compile error; omitting either mapper is not, which is what the round-trip test is
   for.
10. **Revision** — `packages/stock-data/src/derived-state.ts`: bump `DERIVED_STATE_REVISION` and
    extend its revision-history comment. This changes the dataset variant, so existing coverage and
    cache manifests report nothing for the current variant and the canonical history is rebuilt and
    replaced. Skipping this leaves old rows serving `NULL` for the new series indefinitely.
11. **Product decision doc** — `docs/decisions/selectable-series-catalog.md`: add to the catalog
    table.
12. **Run the completeness tests**, then the full gate.

The calculator, the API projection, the Indicators picker, the chart overlay, the legend and the
colour assignment all follow the registry and the catalog. They need no edit.

## Checklist: a new family (RSI, MACD, growth, ratios)

Everything above, plus the parts that assume "every series is a moving average":

1. **A new `SelectableSeriesSource` kind** — `packages/contracts/src/selectable-series.ts`. Do not
   disguise a non-average as `kind: "MOVING_AVERAGE"`; parameters (RSI period, MACD 12/26/9) belong
   in the structured source, not parsed out of the id.
2. **`MovingAverageFieldResponse`** — `packages/contracts/src/stock-data.ts` derives it as
   `Exclude<keyof DailyTechnicalResponse, "date">`. Adding a non-average field to that response
   silently widens the moving-average field type; restructure the derivation instead.
3. **A registry for the family** and its own calculator, following
   `calculateDailyTechnicals`/`calculateWeeklyTechnicalValues`: iterate the registry, return
   `Partial<Record<Field, number>>`, leave warm-up absent.
4. **`buildDailyDerivedState`** — `packages/stock-data/src/derived-state.ts`: merge the new family
   into the daily row. Keep merging by exact trading date; never invent a row.
5. **API projection and validation** — `apps/api/src/stocks/stocks.controller.ts`:
   `technicalResponse` projects `MATERIALIZED_MOVING_AVERAGES` and `technicalFields` rejects any
   `source.kind !== "MOVING_AVERAGE"`. Both need widening, and `series=` must accept the new ids.
6. **Web dispatch** — `apps/web/src/features/stocks/details/utils/series-catalog.ts`: add the case
   to the `seriesPoints` switch. It is exhaustive over the union, so TypeScript points at it.
7. **Multi-output families (MACD)** — a scalar column per output, one catalog entry each, or an
   explicit product decision on how the picker groups them. `ChartPoint` is `{date, value}`: a
   composite value is not representable today.
8. **Provenance and units** — a fundamentals-driven series needs a provenance column, must be
   excluded from the shared `intrinsicCurrency` rule if it is unitless, and needs its evaluation
   events planned the way `planIntrinsicEvaluationDates` does.
9. **QA fixture** — `apps/api/src/stocks/seed-qa-stock-data.ts` and its test, if the browser
   journey should cover the new family.
10. **Coverage** — component test, Playwright expectations, and the docs below.

## Validation

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

`pnpm test` includes the PostgreSQL and Redis integration suites and needs `pnpm infra:up`,
`TEST_DATABASE_URL` and `REDIS_URL` (see `ai/workflows/validation.md`). Run Playwright when catalog
rendering changed:

```bash
pnpm test:securities:seed && pnpm test:e2e
```

Live FMP suites stay opt-in and are not part of this workflow.

## Documentation to update

- `docs/decisions/selectable-series-catalog.md` — the catalog table.
- `docs/decisions/stock-data-foundation.md` — if the persisted derived families changed.
- `ai/architecture/database.md` — the migration note.
- This guide — whenever a step here turns out to be wrong or incomplete.

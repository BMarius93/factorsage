# Selectable Series Catalog

## Status

Product decision for the single series catalog shared by Stock Details chart overlays and strategy
condition operands. This decision supersedes only the previously-undecided weekly period catalog
in `stock-data-foundation.md`; all completed-week, point-in-time, materialization, and provenance
rules remain unchanged.

## Invariant

There is exactly one canonical product catalog of selectable technical and intrinsic-value series.
Stock Details consumes the full catalog as a multi-select overlay picker. Strategy predicates
consume filtered single-select views according to operand compatibility. Neither consumer owns or
duplicates the catalog.

Price is canonical daily close and is always present as the chart's base series; it is not a
selectable catalog entry.

## Catalog

### Moving averages — Daily

| Identity | Label |
| --- | --- |
| `SMA(20, 1D)` | SMA 20D |
| `SMA(50, 1D)` | SMA 50D |
| `SMA(100, 1D)` | SMA 100D |
| `SMA(200, 1D)` | SMA 200D |
| `EMA(20, 1D)` | EMA 20D |
| `EMA(50, 1D)` | EMA 50D |
| `EMA(200, 1D)` | EMA 200D |

### Moving averages — Weekly

| Identity | Label |
| --- | --- |
| `SMA(20, 1W)` | SMA 20W |
| `SMA(50, 1W)` | SMA 50W |
| `SMA(100, 1W)` | SMA 100W |
| `SMA(200, 1W)` | SMA 200W |
| `EMA(20, 1W)` | EMA 20W |
| `EMA(50, 1W)` | EMA 50W |
| `EMA(200, 1W)` | EMA 200W |

### Oscillators

| Identity | Label |
| --- | --- |
| `RSI(7, 1D)` | RSI 7D |
| `RSI(14, 1D)` | RSI 14D |
| `RSI(21, 1D)` | RSI 21D |

Oscillators are a separate technical family, not moving averages. Every RSI entry carries its
structured metadata on the catalog source: family `RSI` (which is also the pane-compatibility
group), daily timeframe, period in trading-bar observations, the fixed `0-100` unit range, and
`SEPARATE_PANE` placement — RSI is unitless and is never drawn over the price scale. All three
periods share one Wilder methodology parameterized by period, calculated from the same canonical
completed daily closes as the daily moving averages; `RSI 14D` needs fifteen closes before its
first value. Default selection is off for every oscillator, recorded as catalog metadata
(`defaultSelected` / `DEFAULT_SELECTED_SERIES_IDS`) rather than a web-side list.

### Intrinsic Value — Blends

| Identity | Label |
| --- | --- |
| `BALANCED` | Balanced |
| `CONSERVATIVE` | Conservative |
| `DIVIDEND` | Dividend |

### Intrinsic Value — Models

| Identity | Label |
| --- | --- |
| `DCF_FCFF` | DCF (FCFF) |
| `RESIDUAL_INCOME` | Residual Income |
| `DDM` | Dividend Discount (DDM) |
| `GRAHAM` | Graham |

The catalog therefore contains exactly 24 selectable series: 14 moving averages, 3 oscillators
and 7 intrinsic-value sources.

## Weekly implementation requirements

The existing weekly pipeline remains authoritative:

```text
DailyPrice
  -> completed WeeklyPrice aggregation
  -> weekly SMA/EMA calculation
  -> latest eligible weekly value materialized on every DailyDerivedState trading day
```

Implementation must add the seven `w`-suffixed weekly values to domain state, persistence,
migrations, cache serialization, API contracts, tests, and chart-series projections. Weekly
values are calculated from weekly closes, never by averaging daily indicators. The current
incomplete ISO week is excluded. A completed value becomes eligible only at its actual final
trading-day close.

Unavailable warm-up values remain absent. No consumer may substitute zero, another period, another
model, or a future completed-week value.

## Consumer filtering

- Stock Details: all 24 entries, multi-select.
- Price-versus-series strategy predicate: the price-scaled entries only — the 14 moving averages
  and the 7 intrinsic-value sources. An oscillator is unitless and is never comparable with a
  price.
- Discount/premium strategy predicates: the 7 intrinsic-value entries only.
- Moving-average-versus-moving-average predicate: the 14 moving-average entries only, filtered to
  the left operand's timeframe and excluding the same identity.
- Future oscillator predicates: an RSI operand is comparable with a numeric threshold inside its
  own `0-100` range (for example `RSI 14D < 30`) or with another oscillator of the same type and
  timeframe — never with price, a moving average or an intrinsic value. The conventional 30/70
  oversold/overbought levels are chart orientation, not persisted strategy state.

Catalog ordering and labels are product metadata. Backend/domain identities remain structured
(moving-average type, period, timeframe; or intrinsic source identity) rather than UI labels.

## Implementation

Package ownership follows the dependency rules in `AGENTS.md`:

- `@intrinsic/contracts` owns the catalog itself (`packages/contracts/src/selectable-series.ts`):
  the 24 entries with their stable id, group, label, canonical order, default-selection flag, and a
  structured `source` discriminator. It is the only package the web app may depend on and is equally available to the
  API and worker, so Stock Details, the API's selection validation and future Strategy operand
  pickers all read the same list. The consumer filters from this decision (`MOVING_AVERAGE_SERIES`,
  `INTRINSIC_VALUE_SERIES`, `comparableMovingAverages`) live beside it rather than in feature code,
  as do `INTRINSIC_VALUE_BLEND_OPTIONS` and `INTRINSIC_VALUE_MODEL_OPTIONS`, which project the
  catalog into the `blendId`/`model` vocabulary the intrinsic-value endpoints speak so a consumer
  of those responses never needs its own ordered list. `OSCILLATOR_SERIES` and `TECHNICAL_SERIES`
  (moving averages plus oscillators — the set the daily technical endpoint's `series=` filter
  accepts) live beside them.
- Each series has exactly **one** product label, used by the dropdown, the chart legend and the
  valuation summary alike. A feature must never keep its own label map: the valuation summary's
  did, and had silently drifted to `Residual income` and `Dividend discount`. A short-lived
  `shortLabel` property was considered and removed once browser measurement showed no presentation
  need for it — see `ai/architecture/calculated-series.md` for the measured widths.
- `@intrinsic/domain` owns the structured backend identities that are calculated and persisted:
  `DAILY_MOVING_AVERAGES`, `WEEKLY_MOVING_AVERAGES` and their union
  `MATERIALIZED_MOVING_AVERAGES`, each pairing `{type, period, timeframe}` with the `d`/`w`-suffixed
  field it materializes into; `DAILY_OSCILLATORS` with `RSI_VALUE_RANGE`, pairing each RSI period
  with its `rsi<period>d` field; plus `INTRINSIC_VALUE_MODELS` and `INTRINSIC_VALUE_BLENDS`.
- `apps/api/src/stocks/selectable-series-catalog.test.ts` is the drift guard: the API is the
  closest package depending on both, and the suite fails if either side gains, loses, renames or
  reorders a series.
- `packages/contracts/src/selectable-series.test.ts` holds the one deliberate snapshot of the
  catalog — stable id, canonical order, group, label, compact label and the structured source
  metadata. It is the only place the catalog's membership is intentionally hardcoded; every other
  assertion in the repository derives counts and ordering from the catalog, so adding a series
  means editing that snapshot rather than hunting for the literals `24`, `14` and `[7, 7, 3, 3, 4]`.
  `docs/development/adding-a-calculated-series.md` is the checklist for doing so.

How a catalog entry becomes a calculated, persisted and cached value — and why each series is an
explicit PostgreSQL column — is described once in `ai/architecture/calculated-series.md` and
decided in `retain-wide-column-calculated-series-storage.md`; this decision stays about the product
catalog itself.

The seven weekly values are carried on `DailyDerivedState` as `sma20w`/`sma50w`/`sma100w`/
`sma200w` and `ema20w`/`ema50w`/`ema200w`, beside the existing `weeklySourceWeekStart`. Adding them
changed the materialized methodology, so `DERIVED_STATE_REVISION` moved 2 -> 3: an r2 row recorded
which completed week was effective but never its values, and must not read as complete weekly
coverage. Migration `20260901234500_add_weekly_moving_averages` adds the nullable columns and leaves
them NULL, because the revision bump makes r2 coverage and r2 cache manifests report nothing for the
current variant and the existing rebuild mechanism recalculates and replaces the affected rows.

Overlay colour is deliberately not part of series identity: 21 permanently distinct, legible hues
do not exist. `apps/web/src/features/stocks/details/utils/chart-theme.ts` owns one palette and
assigns a colour by an enabled series' position in canonical catalog order, so a given selection
always paints the same way and simultaneously enabled series stay distinguishable.

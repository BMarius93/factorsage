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

The catalog therefore contains exactly 21 selectable series: 14 moving averages and 7
intrinsic-value sources.

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

- Stock Details: all 21 entries, multi-select.
- Price-versus-series strategy predicate: all 21 entries.
- Discount/premium strategy predicates: the 7 intrinsic-value entries only.
- Moving-average-versus-moving-average predicate: the 14 moving-average entries only, filtered to
  the left operand's timeframe and excluding the same identity.

Catalog ordering and labels are product metadata. Backend/domain identities remain structured
(moving-average type, period, timeframe; or intrinsic source identity) rather than UI labels.

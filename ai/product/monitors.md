# Monitors

This document is the canonical product definition for FactorSage monitoring.

## Purpose

A Monitor evaluates the existing canonical Strategy logic against current market data and produces Signals for symbols that match.

Monitoring is not a second strategy language. Strategy semantics remain owned by `ai/product/strategies.md`; the Monitor consumes those semantics.

A Monitor combines a Strategy with a monitored symbol universe/source. It must not move List/source membership, capital, backtest execution inputs, or market-data formulas into Strategy itself.

## User controls

For V1, the user controls whether a Monitor is `enabled` or `disabled`.

The user does **not** configure the monitoring interval/cadence. Cadence is an application/infrastructure decision.

Disabling a Monitor stops future evaluations. Re-enabling it resumes evaluations using the persisted Monitor state required for correct trigger semantics.

## Signals

`Signal` is the product term for a Monitor result.

A Signal means that a symbol matched one of the Strategy's canonical signals/levels under the current Monitor evaluation context.

Do not introduce separate user-facing concepts solely to distinguish condition-only matches from trigger-based matches. The UI may explain why a Signal exists, but both remain Signals.

### Condition-only Strategy signal

A Strategy signal containing conditions but no trigger represents a state that may remain true across multiple Monitor evaluations.

Example:

```text
Price is below Intrinsic Value
```

If it is true on several consecutive evaluations, the product should treat that as the same continuing matched state rather than fabricating a new event on every scan.

### Trigger-based Strategy signal

A Strategy signal with a trigger represents a transition/event and depends on the prior evaluable state.

Example:

```text
Price crosses above EMA50D
```

The Signal is emitted when the canonical trigger transition occurs. Remaining above EMA50D on the next evaluation is not another `crosses above` event.

The implementation must preserve enough durable prior-evaluation state to distinguish a genuine transition from a process restart or cache miss.

## Current-data semantics

A Monitor uses current market data, while backtests remain deterministic historical evaluations.

For daily market-derived series, Monitor evaluation uses:

```text
persisted closed daily history
+ current live FMP price as the provisional current daily observation
```

Therefore daily indicators used by a Monitor (for example EMA, SMA, RSI) may include the provisional current-day observation and can move intraday.

Backtests continue to use closed historical observations according to the canonical backtest methodology. Do not silently change backtest semantics to make them match Monitor execution.

Missing/warm-up/PIT-unavailable inputs remain `NOT_EVALUABLE`; monitoring must not replace them with zero, future data, or fabricated values.

## Intrinsic value and price-dependent metrics

Do not rerun expensive fundamental/intrinsic calculations merely because the live price changed if their underlying inputs have not changed.

Where a derived metric depends on a persisted intrinsic value plus current price (for example Margin of Safety), reuse the valid intrinsic value and recompute only the price-dependent result.

The canonical formulas and PIT rules remain owned by the existing calculated-series / intrinsic-value architecture.

## V1 simplicity constraints

V1 intentionally avoids user-configurable scan frequency and avoids extra user-facing state-machine terminology.

Do not add new Redis-backed product semantics merely for monitoring. Redis may still be used by existing infrastructure where already justified (for example queueing/coordination), but Monitor product correctness must not depend on an ephemeral cache.

## Source-of-truth boundaries

- Strategy defines investment/evaluation logic.
- The Monitor decides what current universe/source is evaluated and whether monitoring is enabled.
- The Monitor produces Signals.
- PostgreSQL/durable storage owns persisted Monitor/Signal state required for correctness.
- Backtest configuration remains separate from Monitor configuration.
- Redis/in-memory caches are implementation accelerators, never the semantic source of truth.

## Out of scope / do not invent

Unless another canonical product document explicitly decides otherwise, do not add during V1:

- user-configurable monitoring cadence;
- separate user-facing names for persistent condition matches versus trigger events;
- a second Monitor-specific Strategy DSL;
- a requirement to recompute every available series for every symbol;
- correctness that depends on Redis surviving a restart.

If implementation exposes an unresolved product question outside this document, stop and surface the question rather than silently defining new product behavior.

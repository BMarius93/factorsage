# Product Overview

IntrinsicValue is a stock research, intrinsic valuation, strategy, backtesting, and monitoring product.

## Core workflows

1. Search and inspect a stock.
2. View price, fundamentals, financial statements, and intrinsic value.
3. Create a static list of symbols.
4. Optionally restrict the BUY period independently for each symbol in a list.
5. Define a strategy.
6. Run an asynchronous historical backtest.
7. Monitor a list using the same strategy-evaluation rules.
8. Apply plan entitlements consistently.

## Explicitly removed from V2

Historical index-constituent membership logic for S&P 500 / Dow universes.

This removal does **not** remove:
- historical fundamentals,
- historical intrinsic values,
- no-look-ahead rules,
- benchmarks such as SPY where useful.

## Rewrite principle

Preserve validated behavior; replace unclear ownership and coupling.

# Backtest Year-Window Execution and Absolute Comparison Curves

## Status

**Accepted.**

This decision refines Backtest V1 without changing the existing Strategy, BUY/SELL, allocation, cost-basis, position-slot, execution-price, fee/slippage, BUY-window, or monthly-contribution rules.

It is the product/architecture authority for the changes below until the canonical product and architecture documents are folded forward during implementation. Where older prose in `ai/architecture/backtest-execution.md` says that security dates are unioned into the portfolio calendar, this decision follows the implementation that already exists: the pinned execution calendar is authoritative.

## Context

Backtest V1 currently prepares every security's evaluation frame for the whole requested period before simulation starts. Canonical stock data itself is already persisted and cached in year-sized chunks, but a multi-decade run then reads/projects the whole period into memory at once.

The V1 comparison chart is also return-index based. The product now needs a more intuitive absolute-value comparison between three scenarios that receive the same external capital:

1. the Strategy portfolio;
2. the S&P 500 benchmark;
3. keeping the money as Cash.

The storage/hydration model is intentionally not being narrowed. A cold security may still hydrate its canonical price history, fundamentals, intrinsic values, blends and all materialized derived series according to the existing stock-data rules. The optimization belongs after canonical data is ready: execution should load only the next calendar-year window it is about to simulate.

## Decision

### 1. The selected period and the execution calendar remain separate concepts

The user-selected Backtest period defines the requested start and end dates.

Inside that period, the portfolio simulates only dates from the pinned canonical US-equity execution calendar. Security rows do **not** add dates to that calendar. A security can act only on execution-calendar dates for which its own evaluation frame has an eligible row; otherwise its predicates are `NOT_EVALUABLE`, while an already-open holding continues to be valued using the existing most-recent-close rule.

V2 may continue to source the US-equity execution calendar from the currently pinned `SP500` series / SPY provider data. That is an implementation source, not the product meaning of the calendar. The execution calendar stays independent of the user's comparison choice so changing a benchmark can never change Strategy trades, contribution dates, or portfolio results.

### 2. Canonical hydration stays broad and completes before simulation

`PREPARING_DATA` must make the canonical data required by the run ready before the first simulated year starts.

This change does **not** make hydration strategy-operand-specific and does **not** hydrate one year at a time. Keep the current canonical stock-data behavior, including persistent PostgreSQL coverage, Redis projections, fundamentals/intrinsic materialization, derived-state revisioning, freshness, warm-up, provider-gap loading, and complete-history reuse.

The one-year boundary is an **execution read/projection boundary after hydration**, not a provider-fetch boundary.

Once `PREPARING_DATA` has succeeded, `RUNNING` should consume canonical data from Redis/PostgreSQL and should not intentionally re-enter provider hydration for each year. A missing disposable Redis projection may be repaired from PostgreSQL under the existing source-of-truth rules.

### 3. Simulation loads calendar-year windows

A single Backtest run is processed as consecutive calendar-year windows:

```text
requested: 2000-05-10 -> 2010-08-15

window 1: 2000-05-10 -> 2000-12-31
window 2: 2001-01-01 -> 2001-12-31
...
window N: 2010-01-01 -> 2010-08-15
```

For each window, only that window's execution projection is loaded for every security, plus the minimum preceding context already required by Strategy Trigger semantics. Derived indicators are **not** recalculated from the year-local data: they were already materialized canonically with the required warm-up.

The Redis layout already aligns with this decision (`prices:1D:<year>` and `daily-state:<year>`). An implementation may read a small adjacent-year context chunk when the first dates of a window require it.

### 4. It is one continuous simulation, never one Backtest per year

Year windows are memory/loading boundaries only. Financial state must flow unchanged from one window into the next.

At minimum the continuation state includes everything that can affect a future result, including:

- Strategy cash and open positions;
- shares, average cost / cost basis and last observed prices;
- position epochs;
- BUY levels settled and SELL levels fired;
- position-dependent previous values needed by Triggers;
- realized P&L and trade sequence/order state;
- return and drawdown accumulators used by existing summary metrics;
- contribution progression;
- S&P comparison-portfolio state introduced below;
- Cash-baseline contributed capital.

A year boundary must be economically invisible. Splitting a deterministic input into annual windows must not change any Strategy trade, fill, contribution, position, or portfolio valuation compared with processing the same dates as one continuous sequence.

Trigger context before a window is read-only context. It may establish `t - 1`, but it must never be simulated a second time, receive a second contribution, execute a second trade, or emit a duplicate equity point.

### 5. The primary chart is absolute portfolio value

The Backtest chart's primary V2 presentation has three lines on the same currency-valued Y axis:

```text
Strategy
S&P 500
Cash
```

All three scenarios receive the **same external cash flows on the same contribution dates**: the same initial capital and the same configured monthly contributions.

#### Strategy

`Strategy` is the total Strategy portfolio value:

```text
strategyValue(date) = strategyUninvestedCash(date) + marketValueOfOpenPositions(date)
```

It is not positions-only.

The existing internal/user-facing notion of uninvested Strategy cash remains distinct. Do not overload or rename that value to mean the new `Cash` comparison line.

#### S&P 500

`S&P 500` is a hypothetical passive comparison portfolio funded with the same external cash flows as the Strategy.

For the current V2 `SP500` benchmark:

- initial capital is invested in the pinned S&P 500 comparison series on the first simulated date;
- every monthly contribution is invested in the same comparison series on the same contribution date used by the Strategy;
- fractional benchmark shares are allowed, consistent with the Strategy's continuous-share V1 assumption;
- no separate benchmark fees/slippage are introduced;
- its absolute value is the marked value of accumulated benchmark shares.

Conceptually:

```text
benchmarkShares += contribution / benchmarkPriceOnContributionDate
benchmarkValue   = benchmarkShares * benchmarkPriceOnDate
```

This replaces the simple `close / openingClose` growth index **for the absolute chart line**. Existing percentage-return, alpha, CAGR, and drawdown summary semantics are not silently redefined by this decision; if implementation changes those persisted metrics, that is a separate explicit methodology decision/version.

Semantics for future comparison benchmarks that start later than the run or cannot be priced on a contribution date remain out of scope and must be decided before such a benchmark is presented as an absolute comparable portfolio.

#### Cash

`Cash` is **not** the Strategy's uninvested cash balance.

It is the no-investment baseline:

```text
cashBaselineValue(date) = initialCapital + cumulativeExternalContributionsThrough(date)
```

Under the current `zero-interest@1` assumption it earns no return. It rises only when external capital is added.

Example:

```text
initial capital      = $100,000
monthly contribution = $1,000

start                 $100,000
first contribution    $101,000
second contribution   $102,000
...
```

Use an unambiguous internal/API name such as `cashBaselineValue`; the UI label remains `Cash`.

### 6. Daily economics, annual loading/progress boundary

The engine still simulates the actual execution calendar day by day. The one-year window changes how much source/projection data is resident in the execution path at once; it does not reduce financial calculation to one point per year.

After a calendar-year window is completed, enough of that completed window's curve/result data is persisted and exposed for the running Backtest page to extend the chart before the next year finishes. The frontend should therefore be able to show the computed prefix while the remaining requested period is still empty.

The exact transport/downsampling representation may reuse the existing live-progress machinery or evolve it, but it must preserve the underlying daily financial result. Downsampling is a presentation/payload concern, not a change in execution semantics.

Existing intra-year progress/checkpoint updates may remain. Year completion is the natural durable boundary for exposing the newly completed result window.

### 7. A partially simulated run is still not a completed Backtest

If years 2000-2007 completed and the run fails while processing 2008, the Backtest is `FAILED`, not partially `COMPLETED`.

Previously persisted running progress may remain visible according to the existing progress model, but only successful completion of all requested windows produces a completed result.

### 8. Existing BUY/SELL/allocation methodology remains unchanged

This decision does not reopen Backtest V1 execution rules. Preserve the current behavior, including:

- exits before entries;
- BUY percentage as a target tier of `portfolioValue * (1 / maximumPositions)`;
- one position slot per open symbol;
- settled BUY-level lifecycle semantics and contribution-date top-up behavior;
- partial fill with available cash and the current insufficient-cash settlement behavior;
- SELL percentage as a fraction of the position remaining at execution time;
- FINAL EXIT priority;
- no same-date re-entry;
- `AVERAGE_COST`;
- current deterministic candidate ordering;
- current BUY-window rules;
- current monthly-contribution timing;
- zero fees/slippage and continuous shares unless changed by a separate decision.

The refactor from whole-period frames to annual windows must be behavior-preserving for these rules.

## Required implementation invariants / regression coverage

Implementation should prove at least the following:

1. **Window equivalence:** for the same canonical inputs, chunked annual execution produces the same Strategy trades, fills, positions, Strategy cash, Strategy total value and existing summary metrics as an equivalent continuous reference execution.
2. **Year-boundary Trigger:** a crossing/Trigger on the first eligible trading day of a new year can use the preceding eligible value from the prior year without re-simulating that prior date.
3. **Open-position continuity:** shares, average cost, fired/settled levels, position epoch and position-dependent Trigger history survive a year boundary exactly.
4. **Contribution continuity:** a year boundary never duplicates or skips the contribution methodology's first-eligible-trading-day rule.
5. **Comparison cash-flow parity:** Strategy, S&P 500 and Cash receive the same initial capital and monthly external contributions on the same dates.
6. **Cash meaning:** the chart's `Cash` line equals cumulative contributed capital under zero interest and is independent from Strategy uninvested cash.
7. **S&P absolute value:** benchmark contributions purchase additional fractional comparison shares and the line marks their total absolute value, rather than scaling one opening-price index by current contributed capital.
8. **Progressive exposure:** completing a year makes that completed prefix available to the running UI without waiting for later years to be simulated.
9. **Failure semantics:** failure in a later year leaves the run terminally `FAILED`; an earlier computed prefix cannot be mistaken for a completed result.
10. **Provider separation:** after full `PREPARING_DATA` readiness, stepping through yearly execution windows does not create one provider hydration cycle per year.
11. **Authoritative calendar:** an anomalous security date outside the pinned execution calendar never becomes a portfolio simulation date.

## Versioning and documentation

The annual-window refactor is intended to be an execution implementation change with no change to existing Strategy/BUY/SELL methodology. If exact equivalence cannot be preserved, stop and treat the difference as a methodology change rather than silently accepting it.

The new persisted/displayed absolute comparison series changes result semantics and must be represented explicitly in the run/result contract and versioned consistently with the repository's immutable-run/revision rules. Do not rewrite or reinterpret completed V1 runs.

During implementation, fold this accepted decision into the canonical backtest product/architecture documents and remove or correct stale contradictory prose, especially the old description that unions security dates into the portfolio calendar.

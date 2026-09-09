# Backtests

Backtests are durable asynchronous executions. Strategy logic and portfolio execution settings
have separate ownership.

## Submission inputs

A submitted run selects:

- one immutable strategy version;
- one stock list resolved to canonical security identities and per-symbol BUY windows;
- requested historical period, up to 30 years — the **MAX** control on the form asks for exactly
  that horizon back from today, using the same calendar arithmetic the API validates with;
- initial capital;
- optional monthly contribution;
- `maximumPositions`;
- a benchmark to compare against.

There is no user-entered maximum-allocation percentage. The full-position portfolio fraction is
derived at execution:

```text
fullPositionFraction = 1 / maximumPositions
```

For example, `maximumPositions = 10` makes one full position 10% of portfolio value. A strategy
BUY action of 25% then targets 25% of that full-position budget, or 2.5% of portfolio value.
`maximumPositions = 5` makes the same strategy action target 5% of portfolio value.

An open symbol occupies one position slot regardless of whether the strategy entered 25%, 50%,
75%, or 100% of its full-position budget. Cash and position-capacity constraints are enforced by
the execution engine.

## Execution assumptions in V1

- **Fees and slippage are zero.** There is no editable field for either, and the assumption is
  recorded in every run snapshot as a methodology version so introducing costs later cannot
  reinterpret a historical run.
- **Orders fill at the canonical end-of-day close of the signal date.**
- **Share quantities are continuous.** A 2.5% target in an expensive stock must not silently round
  to zero shares.
- **The monthly contribution, when configured, is added on the first eligible trading day of each
  calendar month** — except the run's very first simulated day, which already receives the initial
  capital. A calendar month with no simulated trading day receives no contribution, and nothing is
  carried forward.
- **New contributed capital can reach a position whose BUY levels have already fired.** On a date
  that actually deposits a contribution, a fired BUY level is reconsidered against the larger
  portfolio and buys only the shortfall to its recalculated target — while its Signal is still true,
  the stock's buy window is open, and cash allows. This is dollar-cost averaging into a plan the
  strategy already began, not a rebalance: a position that merely drifted below target on an
  ordinary day is left alone, and a level whose Trigger did not fire on the contribution date does
  not top up.

### What V1 does not model

These are the assumptions a reader must not mistake for modelling. None of them is a bug, and none
is implemented in V1.

- **Uninvested cash earns nothing** (`cashYield: zero-interest@1`). A portfolio sitting in cash —
  before its first security lists, or between exits — grows by exactly zero, where a real one would
  have earned a money-market or T-bill yield.
- **Dividends are not modelled.** Market data comes from the provider's end-of-day price series,
  and the engine applies no cash dividend, no reinvestment and no adjustment for one. **A V1 result
  is therefore a price return, not a total return.** The same applies to the comparison: `SP500` is
  sourced from the `SPY` ETF's price history, so it is a price-return proxy for the index and
  **must not be described as an S&P 500 total-return index**. Comparing a price-return portfolio to
  a price-return proxy is at least consistent, but neither figure includes the income a holder
  would actually have received.
- **A stock list is a static, present-day set.** Membership is frozen at submission as the exact
  securities the list held then. A list a user calls "Dow Jones" and runs for thirty years means
  _today's chosen securities, evaluated historically as their data becomes available_ — **not** the
  index's constituents as they stood on each historical date. Choosing today's members introduces
  survivorship and current-membership bias: the companies that failed or were removed are simply
  absent. Point-in-time membership is a future capability, not a V1 one.
- **Same-day close execution is a simplification, not a realistic fill.** An order fills at the
  close of the date whose signal produced it — but that close is also what the signal was computed
  from, so the decision uses a price that is only known once the session has ended. It is a
  deliberate, versioned simplification (`same-day-close/…`), and it must not be described as
  behaviour a trader could reproduce. Evaluating "signal at D's close, execute at D+1's open" is a
  separate decision, not a V1 one.
- **An ended price history is not a delisting.** See below.

The remaining execution rules — exits before entries, a BUY level as a target fill, one firing per
level per position lifecycle plus the contribution-date top-up above, FINAL EXIT outranking a
partial SELL, no same-date re-entry, and the candidate ordering used when cash or slots cannot
satisfy every match — are engine methodology, not Strategy semantics. They are decided and versioned
in `../architecture/backtest-execution.md`, and every run records the versions it executed under.

## Benchmark

A run compares its portfolio against exactly one benchmark. A benchmark is passive comparison data:
it is never bought, never consumes cash, never occupies a position slot, and is not a portfolio
`Security` (see `../architecture/benchmark-data.md`).

V1 ships one selectable benchmark, which is also the default:

```text
SP500 — "S&P 500"
```

Its data is currently sourced from the `SPY` ETF. That is an implementation detail of the benchmark's
source, not a product identity: the browser selects `SP500`, and the provider symbol never appears in
an API contract. The catalog is built to grow — broad-market, sector, industry and global-equity
benchmarks, and eventually direct index or composite sources.

Portfolio and benchmark are reported as percentage growth from the run's first simulated date, so the
two curves are directly comparable, and `alpha` is their difference. A date on which the benchmark
has no value at or before it reports no benchmark value; a gap is never fabricated.

**Changing the benchmark cannot change the portfolio.** The same strategy, stock list, period,
capital and allocation produce the same trades and the same portfolio return whichever benchmark is
selected; only the benchmark return, alpha and the benchmark's own drawdown differ. The dates a run
simulates come from an execution calendar the engine owns, not from the comparison — a passive
benchmark that decided when contributions landed would decide the result.

A portfolio exists from the first day of the requested period even while it holds nothing but cash,
so a run whose securities all list later than its start still simulates from the start — flat at 0%
until the first position is opened. See `../architecture/backtest-execution.md`.

A run also pins the exact immutable **series version** of its benchmark at submission. Re-sourcing a
benchmark later — a different provider, a different methodology — creates a new version and leaves
every completed and queued run reading the one it was submitted against.

## Securities whose history does not span the run

A stock list is a list of securities, not a guarantee that each one traded across the whole period.

- **A security that listed after the run's start** simply has no rows before its first close. Every
  predicate is `NOT_EVALUABLE` there, so nothing can be bought before the data exists. It becomes
  tradeable on its own first eligible date and no earlier — the no-lookahead rule, not a special
  case.
- **A security whose history ends before the run's end** stops producing prices. An open position in
  it is carried at its most recent real close for the rest of the run: the last price that was
  actually quoted, never a mark that was never observed. The holdings panel shows that close's date
  whenever it is earlier than the run's own last simulated date, so a stale valuation is visible
  rather than silent.

**This is not a delisting or corporate-action model.** A holding whose history ends is carried at
its last observed close and reported with that close's date; the engine never claims the company was
liquidated, acquired, or that a holder received anything. It has simply stopped observing prices.

**Open methodology question — delisting is not modelled.** FactorSage cannot currently tell a
delisting from a data gap point-in-time. The provider's profile carries a listing date and a
_current_ `isActivelyTrading` flag, but no delisting date; reading today's flag inside a historical
simulation would be look-ahead. So V1 neither liquidates a position at a delisting price nor writes
it down: it carries the last observed close, which is a knowable number, and makes the staleness
visible. Modelling delisting properly needs a point-in-time delisting date and a decided treatment
(final proceeds, write-down, or exclusion). Until both exist, there is no delisting rule to follow —
the behaviour above is what a run does, and it is pinned by tests rather than presented as a
financial decision.

## Reproducibility

A submitted run must snapshot every input that can affect results, including at least:

- strategy identity, immutable version, and normalized configuration;
- resolved securities and per-symbol BUY windows;
- requested period;
- initial capital and monthly-contribution assumptions;
- `maximumPositions` and the derived full-position policy;
- benchmark identity, source kind, provider identifier and methodology version;
- candidate-ordering and execution-engine methodology versions.

Changing a Strategy, a StockList or the benchmark catalog after submission never changes a completed
or running backtest. Deleting a Strategy or a StockList never deletes or reinterprets a run.

A run also never _executes_ under rules it did not record. If the engine's execution methodology,
its Strategy-evaluation semantics or the way canonical data is interpreted changes between a run
being queued and a worker claiming it, the run is refused and the user is asked to run it again —
rather than being handed numbers produced under one set of rules and stamped with another.

**What reproducibility does not mean here.** V1 does not keep raw provider responses. If the data
provider later corrects a historical price, a _new_ backtest of the same period can produce a
different answer; the completed run's stored results never change. The product does not offer
bit-for-bit replay of arbitrary future re-executions, and must not be described as if it did.

## Progress and live results

A run is not a spinner. It reports an explicit phase — `QUEUED`, `PREPARING_DATA`, `RUNNING`,
`FINALIZING`, `COMPLETED`, `FAILED` — with a percentage and a human-readable message, and while it
simulates it persists a live snapshot every few simulated trading days: the simulated-through date,
the portfolio and benchmark curves so far, current value, cash, returns, alpha, max drawdown,
holdings, trade count and recent trades.

Alongside that replaceable snapshot, a run records one durable **milestone** per calendar year it
finishes: the year, the date it was simulated through, and that year's scalar state. Milestones are
append-only and never carry a curve, so a thirty-year run adds thirty small rows rather than thirty
copies of a daily series. They are what makes long-run progress legible — the page shows the years
already behind the run, and keeps showing them after it finishes.

The running page shows the curve as it grows and transitions to the completed view in place. Its
horizontal axis is the **requested period**, fixed from the first render: the not-yet-simulated part
of a run is empty rather than the chart reframing itself around whatever has been computed. 100%
means successfully completed and nothing else.

A failed run is terminal and never leaks provider or internal detail. It keeps a reason a user can
act on, and shows the phase it failed in, a stable failure code and its own run id, so a user can
report it precisely. Developer diagnostics — the original error, its stack, and the identifiers of
the worker and attempt that produced it — stay in the run's server-side detail and in the worker's
logs; they never cross the HTTP boundary.

V1 has no cancellation; the reasoning is recorded in `../architecture/backtest-execution.md`.

## Process boundary

The API validates and creates durable work. The worker claims and executes durable work. API and
worker consume the same canonical strategy/domain implementation; they are separate processes,
not separate business engines. The frontend never starts worker runtime code.

One backtest is never split across CPU cores: its simulation is sequential in time and stays
deterministic. Independent runs use independent worker processes.

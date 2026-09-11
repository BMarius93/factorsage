# Product Overview

IntrinsicValue is a stock research, intrinsic valuation, strategy, backtesting, and monitoring product.

## Core workflows

1. Search and inspect a stock.
2. View price, fundamentals, financial statements, and selectable technical/intrinsic-value overlays.
3. Create a static list of symbols.
4. Optionally restrict the BUY period independently for each symbol in a list.
5. Define reusable BUY, SELL, and FINAL EXIT logic against compatible selectable series.
6. Run an asynchronous historical backtest with capital, contributions, and maximum positions.
7. Monitor a list with a strategy, using the same strategy-evaluation rules, and review the Signals it produces (API and worker shipped; the web surface is the open slice).
8. Apply plan entitlements consistently.

## Domain model

The five user-facing concepts and how they relate. Each has one owner document; this section is the
map, not a second definition.

| Concept | What it is | What it is not | Owner document |
| --- | --- | --- | --- |
| **List** (`StockList`) | A user-owned universe: catalog `Security` members, each with a BUY eligibility window (`FULL` or normalized `CUSTOM` ranges). | Investment logic. A List never says *when* or *why* to buy, only *what* may be bought and on which dates. | `lists.md` |
| **Strategy** | User-owned investment logic: ordered BUY / SELL / optional FINAL EXIT levels, each carrying one Strategy signal (Conditions ANDed with at most one Trigger). Versioned append-only. | A List, capital, contributions, `maximumPositions`, a date range, or any execution assumption. One Strategy is reused against any List. | `strategies.md` |
| **Backtest** (`BacktestRun`) | Strategy + List + Benchmark + date range + capital + contributions + `maximumPositions` + methodology versions, frozen into an immutable snapshot and executed asynchronously once. | A live view of its inputs. Editing or deleting the Strategy or List afterwards changes nothing about the run. | `backtests.md` |
| **Monitor** | A live Strategy reference + a live List reference + `enabled`. Evaluates the Strategy against current market data over the List on a platform-owned cadence. | A pinned snapshot, a portfolio, a second Strategy language, or a user-scheduled job. The user can only name, enable, disable and delete it. | `monitors.md` |
| **Signal** (`MonitorSignal`) | The durable, append-only record that one List member matched one Strategy level under one Monitor evaluation, with the observation it was decided on. Resolved when the match ends; never deleted. | The Monitor itself, and not a Strategy signal (the rule). A Signal is an *outcome* of monitoring. | `monitors.md` |

Relationships:

```text
User 1..* List          (List has no Strategy)
User 1..* Strategy      (Strategy has no List)
Backtest  = snapshot(Strategy version, List membership, Benchmark, execution parameters)
Monitor   = live(Strategy) x live(List) + enabled
Monitor 1..* Signal     (Signal = Monitor x Security x Strategy level x observation)
```

Ownership boundaries and invariants:

- Every List, Strategy, Backtest, Monitor and Signal belongs to exactly one user, and every API read
  or write is scoped by that user at the query. A Monitor or Backtest may only reference a Strategy
  and List of the **same** user, checked in the transaction that creates it.
- A Backtest keeps working after its Strategy or List is deleted (the references are nullable and
  the snapshot is the authority). A Monitor does not: deleting a Strategy or List a Monitor still
  references is **refused**, because a Monitor owns Signal history that must not silently vanish.
  Deleting the user removes all of it.
- Editing a Strategy changes what every Monitor referencing it watches from the next cycle on;
  only the levels whose logic actually changed have their durable state reset. Editing a List
  changes the monitored universe from the next cycle on; a removed member's active Signals are
  resolved by that cycle.
- Disabling a Monitor stops future evaluations and leaves its persisted state and active Signals
  exactly as they were, so re-enabling resumes rather than re-emits.
- Monitoring cadence, lease and retry are application configuration, never user input, and the
  scan is claimed from PostgreSQL like a backtest job: one cycle at a time across every worker.
- PostgreSQL is the only source of truth for all five concepts. Redis is required infrastructure
  for market-data reads and provider coordination, but holds nothing user-owned and nothing a
  Monitor's correctness depends on.

Two terms deliberately share a word. A **Strategy signal** is a rule inside a Strategy level. A
**Signal** on its own, capitalized, is the Monitor outcome record above.

## Explicitly removed from V2

Historical index-constituent membership logic for S&P 500 / Dow universes.

This removal does **not** remove:
- historical fundamentals,
- historical intrinsic values,
- no-look-ahead rules,
- benchmarks such as SPY where useful.

## Rewrite principle

Preserve validated behavior; replace unclear ownership and coupling.

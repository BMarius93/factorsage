# AI Context

This directory is the canonical context for coding agents working on IntrinsicValue V2.

## Read order

For substantial work:

1. `../AGENTS.md`
2. `product/product-overview.md`
3. `architecture/system-overview.md`
4. Relevant product/domain document for the task.
5. `workflows/validation.md`
6. Relevant ADRs in `../docs/decisions/`.

For authentication and role authorization work, also read
`architecture/authentication.md`, and `workflows/auth-testing.md` for the test/QA-persona runbook.

For strategy work, also read `product/strategies.md`.
For Stock Details or selectable-series work, also read `product/stock-details.md` and
`../docs/decisions/selectable-series-catalog.md`.

For any work on calculated daily series — moving averages, oscillators (RSI), intrinsic-value
models and blends, the derived state, or adding a new series or family — read these in order:

1. `../docs/decisions/retain-wide-column-calculated-series-storage.md` — the accepted storage
   decision: explicit PostgreSQL columns, what is deferred, what is rejected, and the budgets and
   triggers that would re-open it.
2. `architecture/calculated-series.md` — the canonical architecture as implemented: identity,
   registries, calculation, persistence, revision, cache, API and web.
3. `../docs/development/adding-a-calculated-series.md` — the extension checklist. It says
   explicitly that repository search and the completeness tests, not the checklist alone, are what
   prove a series is fully wired.
4. `workflows/validation.md` for the test gate, and `product/stock-details.md` with
   `../docs/decisions/selectable-series-catalog.md` for the consuming product surface.

Do not propose JSONB, EAV, a Redis redesign or a generic series endpoint as the current direction:
the first document records why they are deferred or rejected.

For frontend/UI work, also read
`architecture/frontend.md`.

For server-side API, worker, stock-data, FMP, database, cache, queue, or integration work, also read
`architecture/observability.md`.

## Source-of-truth rule

The old repository is historical reference only.

For frontend work, the old repository may be used as a visual/behavioral oracle, but V2 architecture and product documents remain authoritative.

When old code or old documentation conflicts with V2 documents, V2 documents win unless the user explicitly changes the decision.

## Current V2 product model

```text
StockList (user-owned)
  |
  +-- StockListItem -> Security (canonical catalog identity)
       +-- BUY window = FULL
       or
       +-- BUY window = CUSTOM(one or more normalized date ranges; endDate null = open-ended)

SelectableSeriesCatalog
  |
  +-- daily/weekly moving averages
  +-- daily oscillators (RSI 7D/14D/21D, shared 0-100 chart pane)
  +-- intrinsic-value models/blends
  +-- Stock Details overlays
  +-- compatible Strategy condition operands

Strategy
  |
  +-- ordered BUY/SELL/FINAL EXIT predicates
  +-- entry fraction of one full position
  +-- exit fraction of the remaining position
  +-- no global valuation source
  +-- no portfolio-position limit

Backtest
  |
  +-- immutable execution snapshot + asynchronous worker execution
  +-- capital/contributions/maximumPositions
  +-- full position fraction = 1 / maximumPositions

Monitor = current-data evaluation using the same canonical strategy logic
```

Historical index-membership PIT is excluded.

Fundamental/intrinsic no-look-ahead correctness remains required.

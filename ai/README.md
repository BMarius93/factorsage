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
`architecture/authentication.md`.

For server-side API, worker, stock-data, FMP, database, cache, queue, or integration work, also read
`architecture/observability.md`.

## Source-of-truth rule

The old repository is historical reference only.

When old code or old documentation conflicts with V2 documents, V2 documents win unless the user explicitly changes the decision.

## Current V2 product model

```text
Static List
  |
  +-- Symbol
       +-- BUY window = FULL
       or
       +-- BUY window = CUSTOM(start, end)

Strategy
  |
  +-- valuation rules
  +-- margin-of-safety rules
  +-- technical rules
  +-- entry/exit rules
  +-- allocation rules

Backtest = immutable execution snapshot + asynchronous worker execution
Monitor = current-data evaluation using the same canonical strategy logic
```

Historical index-membership PIT is excluded.

Fundamental/intrinsic no-look-ahead correctness remains required.

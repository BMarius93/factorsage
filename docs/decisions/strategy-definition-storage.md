# Strategy Definition Storage

## Status

Accepted. Implemented by migration `20260907072239_add_strategies`.

## Decision

A strategy's BUY / SELL / FINAL EXIT logic is persisted as **one immutable JSON document per
version**, in `StrategyVersion.definition`, carrying its own `schemaVersion`. Editing a strategy
appends a version; it never updates one. Name and description live on the `Strategy` identity row
and never create a version.

## Why a document rather than normalized tables

A normalized shape would need four or five tables — level, signal, condition, trigger — joined on
every read, and would be mutable by accident, which is the opposite of what an immutable version
needs. Nothing queries inside a definition in SQL: a strategy is a small user-authored document
read whole by primary key, and the only predicates the product runs against it are the Strategy
Builder's, which operate on the parsed object.

One never-updated `Json` column makes immutability structural rather than a rule someone has to
remember. `schemaVersion: 1` inside the document is the migration handle, and the API parses every
definition through `normalizeStrategyDefinition` from `@intrinsic/contracts` on read, so a drifted
or hand-edited row fails loudly instead of reaching the Builder as a definition no control can
represent.

## Why versioning now

`ai/product/backtests.md` requires that changing a strategy after submission never changes a
completed or running backtest. Building Create/Edit against a single mutable row would make that
invariant impossible to honour without later rewriting the save path *and* migrating existing user
data. One extra table now costs a `@@unique([strategyId, versionNumber])` and an insert;
retrofitting later costs a migration plus a change to every read path. The Builder itself only ever
reads the highest version.

There is no pointer column and no circular relation: the current version is the highest
`versionNumber`, which the unique constraint keeps unambiguous.

## Why a version is appended only on a real change

`definitionHash` is a SHA-256 over `strategyDefinitionFingerprint(definition)` — a canonical
serialization of the normalized document with the level, condition and trigger **ids stripped**.
Those ids are client-generated and exist so diagnostics can address a row, so re-keying a row does
not change what the strategy does and must not churn the history. Genuine reordering does change
the strategy, which is why the fingerprint preserves order rather than sorting: level order is
product-meaningful.

The fingerprint lives in `@intrinsic/contracts` beside the model, because knowing which fields
carry meaning is model knowledge; the hashing itself lives in the API, which has `node:crypto` and
which the browser bundle must not grow.

## What this does not reopen

`retain-wide-column-calculated-series-storage.md` decided that *calculated series* are explicit
PostgreSQL columns rather than JSON. That decision is about data queried by date range, numeric,
rebuilt by revision and read in bulk by the loader and the chart. A strategy definition shares none
of those properties. Storing it as a document is not a precedent for storing series as documents,
and this decision does not weaken or revisit that one.

## Consequences

- A strategy always has at least one version: `POST /strategies` validates the submitted definition
  (an omitted one is treated as empty and rejected for having no BUY level), so no persisted
  document ever fails to normalize on the way back out.
- Version rows are never updated or deleted individually; they cascade with the strategy.
- Nothing indexes into the document. If a future feature needs to query strategies *by* their
  content — "every strategy using RSI 14D" — that is a new decision, and a derived index table is
  the likely answer rather than making the document queryable.

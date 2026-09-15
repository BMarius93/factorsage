# Strategy Definition Storage

## Status

Accepted. Implemented by migration `20260907072239_add_strategies`. Extended by document schema
version 2 (FINAL EXIT Exit Rules), which needed **no** migration — see "Schema version 2" below.

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

## Schema version 2: FINAL EXIT Exit Rules

Version 1 gave FINAL EXIT a single flat `signal`. Version 2 replaces it with `rules`, the ordered
list of alternatives that FINAL EXIT occurs when *any* of matches. This is the first time the
`schemaVersion` handle has actually been used, and it is what that handle was reserved for.

**No data migration was written, and none is needed.** The document is read whole through
`normalizeStrategyDefinition`, so the version boundary is a function, not a `UPDATE`:
`upgradeStrategyDefinitionDocument` upcasts a version 1 document to the equivalent single-rule
version 2 one before anything validates it. Every read path — the API, the Monitor worker, a
backtest snapshot read years from now — is already funnelled through that one parse, so all of them
gained compatibility at once. Rows are rewritten only when a user next saves the strategy, by the
ordinary save path.

Three properties make that safe, and each is covered by a test:

- **Deterministic.** The single Exit Rule reuses FINAL EXIT's own id rather than inventing one, so
  reading one immutable row twice yields byte-identical documents. Exit Rule ids are a separate id
  namespace from level ids, so the reuse is not a collision.
- **Semantics-preserving.** Only `schemaVersion` and the FINAL EXIT slot move. Every other field
  passes through untouched, including an invalid one, so validation still reports it against the row
  that carries it rather than the upgrade swallowing it.
- **Fingerprint-stable.** An OR of one alternative *is* that alternative, so a single-rule FINAL
  EXIT serializes identically to the same logic under version 1. See the next section for why that
  is load-bearing rather than cosmetic.

Rewriting every row in a migration was rejected for the reason the document format exists: a
`StrategyVersion` is immutable and is the reproducibility authority behind completed backtests. A
migration that rewrote historical versions would be editing the record of what already executed, to
buy nothing — the upgrade is free at read time and provably lossless.

A submitted version 1 payload is also still accepted and answered with a version 2 document, so a
stale client is served rather than refused.

## Why a version is appended only on a real change

`definitionHash` is a SHA-256 over `strategyDefinitionFingerprint(definition)` — a canonical
serialization of the normalized document with the level, condition and trigger **ids stripped**.
Those ids are client-generated, so re-keying a row does not change what the strategy does and must
not churn the history. Genuine reordering does change the strategy, which is why the fingerprint
preserves order rather than sorting: level order is product-meaningful.

Since Monitor V1 a **level id is also durable identity across versions**: `MonitorSignalState` and
`MonitorSignal` are keyed by `(monitorId, securityId, levelId)`, and a level whose id changes in a
newly appended version is indistinguishable from one removed and another added — its active
Signals are resolved and a still-true match is re-emitted. A client editing a Strategy must carry
existing level ids forward (the web Builder does; `draftFrom` keeps the saved document's ids), and a
re-keyed submission with unchanged logic returns the persisted document with its **original** ids,
not the client's. See `ai/architecture/deep-discovery.md`, investigation 1.

The fingerprint lives in `@intrinsic/contracts` beside the model, because knowing which fields
carry meaning is model knowledge; the hashing itself lives in the API, which has `node:crypto` and
which the browser bundle must not grow.

The fingerprint is led by a **serialization** version, not by the document's `schemaVersion`,
because the two answer different questions. `schemaVersion` describes the document format;
the fingerprint describes the logic. A version 1 document and its version 2 upcast express identical
logic, so they must produce an identical fingerprint — otherwise the schema bump alone would have
invalidated every stored `definitionHash`, appended a version to every strategy on its next save,
and reset the transition state of every Monitor with a FINAL EXIT, all without anyone editing
anything. The serialization version moves only when the serialization itself starts meaning
something different.

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
- A document schema change is a read-time upcast plus a validator that accepts the older version,
  never a rewrite of existing rows: `upgradeStrategyDefinitionDocument` is where version 2 did it,
  and where a version 3 would.
- Nothing indexes into the document. If a future feature needs to query strategies *by* their
  content — "every strategy using RSI 14D" — that is a new decision, and a derived index table is
  the likely answer rather than making the document queryable.

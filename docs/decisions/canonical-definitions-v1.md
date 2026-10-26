# Canonical Definitions V1

## Status

**Accepted — 2026-10-26 (owner).** FactorSage has one portable, versioned JSON form for a Strategy
and for a Stock List, with a codec that writes it, reads it back to the same meaning, validates it
with the platform's own rules and describes it in deterministic English. Its first production use
is the shared backtest: a new link records the canonical documents of the Strategy and the List the
run executed, their provenance and their descriptions.

It is **additive**. Strategies remain `Strategy` and `StrategyVersion` rows, Lists remain
`StockList` rows, backtests execute their own frozen snapshot, and nothing is evaluated from a
canonical document. It is a representation of what a definition means, not a second source of
truth. Out of scope for V1: any import or export UI, templates, AI generation, and any change to
strategy execution, snapshots, PIT membership, plans or billing.

## 1. Where it lives

`@intrinsic/strategy`, module `src/definitions/` — the pure layer that already depends on both
halves the codec needs: the Strategy model and its validator in `@intrinsic/contracts`, and the
buy-window rules in `@intrinsic/domain`. No I/O, no clock, no network, no model.

| Operation                                   | Function                                             |
| ------------------------------------------- | ---------------------------------------------------- |
| Strategy → canonical JSON                   | `serializeStrategy`                                  |
| canonical JSON → Strategy (`StrategyDraft`) | `deserializeStrategy`                                |
| List → canonical JSON                       | `serializeList`                                      |
| canonical JSON → List members               | `deserializeList`                                    |
| Validation (structural and semantic)        | `validateDefinition`                                 |
| Short and detailed description              | `describeDefinition`                                 |
| A backtest's executed Strategy / List       | `serializeSnapshotStrategy`, `serializeSnapshotList` |

Deserialization returns validated domain shapes and writes nothing; persisting them is a future
importer's act through the ordinary routes and their rules. Anything a database must answer — which
actor id a bioguide id is, which security a symbol is, which membership a pin names — is passed in
as a resolver, so the codec stays pure and its tests need no database.

## 2. The document

Every document leads with `format: "factorsage.definition"`, `schemaVersion: 1` and `type`
(`strategy` | `list`), followed by `metadata` (`name`, optional `description`), `provenance` and
`definition`. A reader refuses another format, version or type before reading anything else.

**Strategy.** `definition` is the persisted Strategy document's own grammar — the same metric,
operator and Value shapes, validated by the same `validateStrategyDefinition`, never a second
matrix — with what is identity rather than meaning taken out:

- Row ids are dropped. The platform's own fingerprint ignores them; on the way back the codec
  assigns deterministic positional ids (`buy-1`, `buy-1-condition-1`, `final-exit-rule-2`) or fresh
  ones from a caller's `nextId`.
- A Congress scope names members by **bioguide id** (`{ kind: "ACTORS", actors: ["P000197"] }`),
  sorted, with an `actors` list giving each one's name for descriptions. The legacy single-member
  `ACTOR` scope is written as the one-member selection it means. A legacy `GROUP` scope is written
  as its members only where its membership is frozen — a backtest snapshot — and refused otherwise.
- Level order, percentages, Condition order, the optional Trigger, the FINAL EXIT Exit Rules (OR of
  AND groups, the only grouping the grammar has), every metric parameter, ETF and Stock's Sector
  sources, and every Value with its unit are carried exactly.

`Strategy → JSON → Strategy` reproduces `strategyDefinitionFingerprint`, and
`JSON → Strategy → JSON` reproduces the document byte for byte.

**List.** `definition.membership` is one of:

- `members` — each security by `{ symbol, exchange }` (the catalog's unique pair, and how the
  built-in catalog itself is written; never a database id), with its buy window in the one canonical
  form `normalizeBuyWindowRanges` defines. Members are sorted by symbol then exchange (code units).
- `point_in_time_index` — a **pinned reference** (§4).

Determinism: one meaning, one document. Optional fields are omitted rather than written empty, keys
are written in a fixed order, and collections are in canonical order.

## 3. Validation and refusal

`validateDefinition` is strict: closed key sets everywhere (an unknown field is an `UNKNOWN_FIELD`
issue, never ignored), the Strategy logic rebuilt and checked by `validateStrategyDefinition` itself,
Congress scopes and their references checked against each other, buy windows required to be already
canonical (`BUY_WINDOW_NOT_CANONICAL`), members sorted and unique, and provenance shaped per origin.
Every issue carries a code and a document path.

The codec is lossless or it refuses. Serializing a definition the Strategy rules refuse, an actor
or legacy group whose identity was not supplied, a duplicated security or an invalid window throws
`CanonicalDefinitionError` with the issues; every document the writer produces is validated before
it is returned. Reading back a bioguide id or a security the database cannot resolve is refused,
naming each one — never skipped.

## 4. Point-in-time universes

The S&P 500 Historical PIT List holds about 735 securities and 761 membership periods, and its
projection is rewritten whenever the canonical membership is corrected. The projection is not
versioned; the only immutable copy of the membership a run used is that run's snapshot.

So a PIT universe is never copied into a document. It is written as:

```json
{
  "kind": "point_in_time_index",
  "index": "SP500",
  "universe": "sp500-historical-pit",
  "membershipFloor": "1996-01-02",
  "period": { "startDate": "2000-01-03", "endDate": "2020-12-31" },
  "membership": {
    "digest": "sha256:…",
    "securities": 732,
    "windows": 758,
    "peakSimultaneousMembers": 506
  }
}
```

`digest` is SHA-256 of the members' canonical form; `period` says the membership is the run's: every
universe member with a period overlapping those dates, with all of its periods. Reconstruction
requires a source that supplies the membership — the snapshot that froze it
(`snapshotIndexMembershipResolver`), or a projection that has not moved — and the codec recomputes
the digest and counts and refuses a mismatch (`INDEX_MEMBERSHIP_MISMATCH`) or an absent source
(`INDEX_MEMBERSHIP_UNAVAILABLE`). A pinned reference therefore can never resolve to today's
constituents, and a corrected projection is refused rather than silently substituted. The reference
is about half a kilobyte; the same membership written out would be about 100 KB.

## 5. Provenance: built-in, custom, derived, unknown

Built-in status is never decided by a name. The evidence, strongest first:

1. **Ownership.** SYSTEM content is official (`evidence: "system_content"`); a SYSTEM row is never
   deleted and its ownership never changes. A built-in Strategy is referenced by `systemKey` and the
   `StrategyVersion` number the run executed; a List by `systemKey` (Lists have no versions).
2. **The copy record** (`copy_record`, `authored_record`). New, nullable columns record how a
   customer's content came to exist: `Strategy.origin` / `StockList.origin` = `AUTHORED` on create,
   `COPIED` on duplicate, with `originSystemKey` — the built-in at the root of the copy chain — and
   what it was when copied (`originVersionNumber` + `originDefinitionHash` for a Strategy,
   `originMembershipDigest` for a List). A copy of a copy inherits the root. A copy whose frozen
   `definitionHash` (or membership digest) still equals the recorded one is **built-in** — it is the
   official logic unchanged; any other is **derived**, naming its source. Copied customer content
   with no built-in root is **custom**.
3. **Strategy version history** (`version_history`, `content_match`), for strategies saved before
   origins were recorded: a duplicate's first version is always its source's logic, so a first
   version whose `definitionHash` equals a built-in version's began as that built-in. A deleted
   strategy's frozen logic can still match a built-in version exactly.

Anything else is `unknown`: a List saved before origins were recorded, a strategy whose history
matches no built-in or several, a deleted customer row. Nothing is guessed in either direction, and
a modified copy is never called built-in. The record is the smallest mechanism that makes "derived"
knowable — nothing is backfilled, and a row created before it keeps `NULL`, which means "not
recorded". The persisted membership digest is environment-local (security ids), because it only
ever compares a copy with its source in the same database.

A provenance claim inside an imported document is only a claim; only the share writer computes one,
from this evidence.

## 6. Descriptions

`describeDefinition` validates its input and returns `{ short, detailed }`, generated from the
document alone and composed from the platform's own canonical sentences (`describeCondition`,
`describeTrigger`): the catalog's labels, the product's units (`15.0x`, `25%`, `$50,000`),
`STRATEGY_LEVEL_PERCENTAGE_BASIS`, and the configuration summary of alternative-data rules. Same
document, same text, on every runtime: dates and counts are formatted without a locale.

- A Strategy's short form names the first BUY level's rules (two, then a count) and summarizes the
  exits; the detailed form is one line per level and one numbered alternative per Exit Rule, then
  the notes its rules need — same-session evaluation, the trigger rule, `is close to` = 2%, ETF and
  Stock's Sector sources, Gain and Loss — and nothing it does not use.
- A List's description counts and explains its membership — how many securities, how many always
  eligible, how many periods, the earliest start, how many are open-ended — and **never names a
  security**. A PIT universe's says it uses historical index membership rather than today's
  constituents, the pinned size over the period, and that a holding is not sold when its company
  leaves the index.
- Neither ever names the Strategy or the List, and neither makes a performance claim.

## 7. Shared backtests

`PUT /backtests/{runId}/share`, when it creates a link, serializes the run's **frozen snapshot** —
never the current rows — resolves provenance for the Strategy and the List independently, validates
both documents, generates both descriptions, and inserts the share with all of it in one statement:
`BacktestShare.definitions` (`{ strategy, list }`), `.descriptions` and `.publishDescriptions`. A
CHECK constraint keeps definitions and descriptions both present or both absent. If either document
cannot be written, no link is created: `409 BACKTEST_SHARE_DEFINITIONS_UNAVAILABLE`. Descriptions are
generated once, at creation, and never on a read; editing or deleting the Strategy or List later
changes nothing a link recorded.

**Publication** (owner decision, 2026-10-26; `definitionDescriptionPublication` in
`@intrinsic/contracts`):

| Definition                                        | Public description                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| Non-premium built-in Strategy (or unchanged copy) | always                                                                  |
| Built-in List, premium or not                     | always — it names no member, the only restricted part of a premium List |
| Custom, derived or unknown Strategy or List       | only when the owner opts in                                             |
| Premium built-in Strategy, or one derived from it | never                                                                   |

The opt-in is `publishDescriptions` — off by default, set in the Share dialog, which says that it
reveals the strategy's conditions, metrics, operators and thresholds and how the list's membership
works. Provenance labels are always shown. The public report gains `definitions` — per Strategy and
List: `origin`, the official `builtInName` of the built-in it is or was derived from, and either the
published `short` and `detailed` text or `withheld` with its reason. The canonical documents, their
metadata (a customer's own names), ids and securities never leave the API.

A link created before this keeps `NULL` definitions and reads exactly as before. Setting
`publishDescriptions` on such a link records its definitions then, from the same snapshot — the
owner's deliberate act, the one moment its report may change. The Open Graph metadata and image are
unchanged.

## 8. Size and cost

Measured on the real code (`real-definitions.test.ts`, `list-codec.test.ts`): a PIT reference is
under 1 KB; a 1,000-member custom List (the largest any plan allows) is about 135 KB and serializes
and describes in tens of milliseconds; a Strategy document is a few kilobytes. Recording a share adds
two indexed reads per definition for provenance and one serialization of the snapshot already
loaded.

## 9. Known V1 limitations

- **Deleted customer content** shared afterwards resolves to `unknown`: the snapshot records no
  ownership or origin, so a deleted row cannot be told custom from derived.
- **Content saved before origins were recorded** is `unknown` unless its version history proves a
  built-in start; Lists have no history, so a pre-existing customer List is `unknown`.
- **Security references are symbol + exchange**, the catalog's portable identity. A future importer
  in another environment resolves them by that pair; a ticker reused by another issuer would resolve
  to whatever the catalog holds under it, which an importer must check.
- **A legacy Congress group** serializes only where its membership is frozen.

## Alternatives rejected

- **A simplified schema of conditions and tickers**: could not carry Exit Rules, sources, triggers,
  alternative-data scopes or buy windows, and would have needed a second validator.
- **JSON as the source of truth**: would rewrite storage, execution and Monitors for no product gain.
- **Expanding PIT membership into every document**: copies a dataset and still does not say which
  projection it was.
- **Matching built-ins by name, or by content alone for every row**: names are not identity, and
  content alone cannot tell a modified copy from custom content.
- **Recording provenance in the backtest snapshot**: changes the reproducibility authority and its
  hash for every new run.
- **Regenerating descriptions on each read**: a code change would silently rewrite what a link
  already published.

# Alternative Data Signals — Product & Engineering Specification

## Status

Implementation target: `feat/alternative-data-signals`

This document freezes the product decisions for adding Insider Activity and Congressional Trading to FactorSage. The implementation should reuse existing strategy, backtest, monitor, Lists, FMP, caching, and UI patterns rather than introducing a parallel subsystem.

## Goals

Add two new alternative-data domains that can be used consistently in Strategies, Backtests, and Monitors:

1. Insider Activity
2. Congressional Trading (House + Senate)

The core requirement is point-in-time correctness: a backtest must only see information after it was publicly observable.

Institutional Activity based on SEC Form 13F was specified alongside these two and is **out of V1**; see [Institutional Activity / 13F is out of V1](#institutional-activity--13f-is-out-of-v1).

## Non-goals for V1

- No AI / smart-money scoring.
- No historical dynamic membership such as “all senators at that historical date”.
- No Institutional Activity / Form 13F, and therefore no institution groups.
- No new alternative-data-specific strategy builder.
- No redesign of the current Strategy page.
- No insider person groups in V1.

## Point-in-time semantics

Every event must preserve both the underlying economic/event date and the date/time when the information became publicly observable.

Examples:

- Insider: transaction date != Form 4 filing/publication date.
- Congress: transaction date != disclosure date.

Backtest evaluation must use the public availability boundary, never the underlying transaction/period date when disclosure came later.

For daily evaluation, if the available provider data cannot prove that the information was public before the relevant market-session execution boundary, use the next valid trading session as the observable session. Reuse the existing market-calendar/session utilities.

Do not weaken this rule for convenience.

## Data architecture

Keep provider/raw data auditable and separate from normalized or derived state.

Recommended conceptual split:

- raw insider filings / transactions
- raw congressional disclosures
- canonical actors
- normalized alternative-data events / derived metrics

Historical provider records must not be destructively overwritten. Amendments/revisions should preserve identity and provenance so historical results remain reproducible.

### Canonical actors

Use stable external IDs as identity. Display names are labels only.

Conceptually:

```ts
Actor {
  id
  externalId
  displayName
  metadata
}
```

Examples of metadata:

- Congress person: provider/member identifier, chamber, state/district where available.

## Actor groups

> **Superseded on 2026-10-11 (owner).** Congress groups are no longer part of the product: a
> Congressional rule selects the members it counts directly, in the Strategy Builder. This section,
> **Group UI** and **Backtest snapshots** below describe what was first built and are kept because
> strategy versions and backtest snapshots saved under it still exist and still execute. What
> replaced them, and what must keep working, is in
> [Direct member selection replaces Congress groups](#direct-member-selection-replaces-congress-groups-2026-10-11).

Add reusable user-defined groups for Congress people.

Do not add insider groups in V1.

Conceptually:

```ts
ActorGroup {
  id
  userId
  name
}

ActorGroupMember {
  groupId
  actorId
}
```

Groups are explicit collections of actors selected by the user.

Do not implement semantic/dynamic historical groups such as “current senators”, “top hedge funds”, or committee membership through time in V1.

### Group UI

Integrate group management into the existing `Lists` product area rather than adding a new top-level navigation item.

Preferred structure:

- Stock Lists
- Congress Groups

Keep the current FactorSage desktop table / mobile card conventions.

A group page should support:

- create
- rename/edit
- delete
- search actors
- add/remove members
- member count

Actor pickers should be searchable comboboxes, not giant native selects.

### Backtest snapshots

If a Strategy references an actor group, the backtest must snapshot the group membership with the other mutable backtest inputs.

Editing a group later must never change the semantics/results of a previously created or running backtest.

## Strategy Builder UX

The current Strategy page design is authoritative.

Preserve:

- the Category -> Metric choice for the first operand (it replaced the single large categorized
  selector on 2026-09-28, and became one Metric picker — every category at once, the chosen
  category's metrics beneath — on 2026-10-11; `ai/product/strategies.md` § Strategy Builder surface
  owns it)
- the condition row's grammar
- the current `signal / operator / value-or-series` grammar
- the Strategy Logic sidebar
- current responsive/mobile behavior

Do not replace conditions with alternative-data cards or large forms.

The condition row must remain conceptually:

```text
[first operand: category + metric] [operator] [value / comparison operand]
```

Examples:

```text
Insider activity      | Insider buyers     | is above | 1     Configure · 20D
Congressional trading | Congress purchases | is above | 1     Configure · 30D
Congressional trading | Congress buyers    | is above | 1     Configure · 30D · Nancy Pelosi, Ro Khanna +3
```

### First-operand selector

Insider activity and Congressional trading are two categories of the Metric picker, and each
measure is one entry within its category — `Insider buyers`, never `Insider buyers 20D`: the lookback
is configuration, so no entry carries one and no configuration is ever enumerated. Choosing another
measure of the same family keeps the applied configuration (2026-10-11); another family starts from
its own defaults.

Do not create a separate “Alternative Data” strategy-builder page.

### Configurable signals

Some first operands require extra configuration. That configuration belongs to the signal itself and must not become extra permanent columns in the condition row.

Use the most natural existing UI primitive after inspecting the repo: popover, dialog, or equivalent.

Possible configuration:

- lookback in trading sessions
- scope: anyone, or the members of Congress the rule selects (2026-10-11; originally Any / Specific
  actor / Actor group)
- chamber
- owner
- insider role, where supported

After configuration, keep the condition row compact and render a subtle secondary summary below the first operand. It always leads with the lookback, because the lookback is configuration rather than part of the metric's name, and then names only what narrows the metric, e.g.:

- `20D`
- `30D · Nancy Pelosi`
- `30D · Nancy Pelosi, Ro Khanna +3 · Senate · Self, Spouse`
- `180D · CEO, CFO, Director`

A selection is summarized by its first two members alphabetically and a count of the rest, so the
line stays one line however many members are selected.

### Strategy Logic summary

Render readable natural-language summaries using the same semantics as the condition rows.

Examples:

- `Insider buyers is above 1 (20D)`
- `Congress purchases is above 1 (30D · Nancy Pelosi, Tommy Tuberville)`
- `Congress buyers is above 1 (30D · Nancy Pelosi, Ro Khanna +3)`

Do not make the sidebar noisy.

## Insider Activity

Treat actual open-market purchases/sales separately from awards, gifts, conversions, option exercises, and other Form 4 transaction types.

V1 strategy metrics should focus on objective signals such as:

- Insider buyers over N trading sessions
- Insider sellers over N trading sessions
- Insider purchase value over N sessions
- Insider sale value over N sessions

Where supported, allow role filtering, e.g. CEO / CFO / Director / officer categories already available from source data.

Do not interpret every acquisition as a discretionary buy.

## Congressional Trading

House and Senate share one product domain: `Congressional Trading`.

Preserve at least:

- person identity
- chamber
- owner (self/spouse/joint/other provider value)
- asset type
- transaction type
- transaction date
- disclosure date
- disclosed amount range
- source link / provider provenance

V1 should focus on stock-related activity. Avoid forcing bonds/options/other asset types into the security model unless the existing mapping is clearly safe.

Useful V1 metrics include:

- Congress purchases over N trading sessions
- Congress sales over N trading sessions
- Congress buyer count / seller count
- defensible amount-based filters

Disclosed amounts may be ranges. Store range bounds and do not invent an exact value or midpoint as if it were factual.

## Scope semantics

For configurable alternative-data metrics, support:

### Congress

- Any member
- The members the rule selects — one or many (2026-10-11; originally "Specific person" and
  "Congress group", which stored versions may still hold)

Optional Congress filters can include:

- Chamber: Any / House / Senate
- Owner: Any / self / spouse / joint / available provider values

A selection is a filter/scope over the same metric. Do not create bespoke strategy signal types for named actors.

The filter is on **membership**: the disclosures of every selected member are pooled, and the measure
aggregates the pool. It is not an OR between the rule evaluated once per member — see
[Direct member selection replaces Congress groups](#direct-member-selection-replaces-congress-groups-2026-10-11).

## Monitor compatibility

The same normalized data and configured signals should be evaluable by Monitor where semantically applicable.

Avoid separate historical and live definitions of the same signal.

## FMP integration

Before implementation, inspect the current FMP provider/gate/cache/retry/data-ingestion architecture and reuse it.

Do not call new endpoints outside the established shared FMP gate.

Relevant domains/endpoints include:

- Insider trades / Form 4 data
- House disclosures
- Senate disclosures

Keep provider limitations explicit. If licensing, plan level, historical coverage, or endpoint semantics block a requirement, report the limitation rather than silently changing the product semantics.

## Suggested V1 signal catalog

The exact naming should follow the existing series catalog conventions after inspection.

### Insider Activity

- Insider buyers (ND)
- Insider sellers (ND)
- Insider purchase value (ND)
- Insider sale value (ND)

### Congressional Trading

- Congress purchases (ND)
- Congress sales (ND)
- Congress buyers (ND)
- Congress sellers (ND)
- Congress purchase value / minimum disclosed value (ND), only if semantics remain defensible with amount ranges

Do not add signals merely to inflate the catalog. Prefer a small explainable V1.

## Testing requirements

Add focused unit/integration/e2e coverage for at least:

- no look-ahead across transaction date vs filing/disclosure date
- next-session observability boundary
- weekends/market holidays using existing calendar utilities
- amendments/reingestion/idempotency
- insider transaction-type classification
- Congress amount ranges
- actor identity and duplicate display names
- group CRUD
- Any / specific actor / group scope
- group snapshot immutability in backtests
- strategy serialization/deserialization
- Strategy Logic rendering
- Monitor compatibility
- desktop and mobile Strategy UI
- backwards compatibility for all existing strategy conditions

Run focused suites throughout implementation and the full repository gate before considering the branch ready.

## Implementation approach

1. Audit existing architecture first.
2. Produce a concise implementation plan before feature work.
3. Reuse existing abstractions where possible.
4. Implement data/provider/persistence semantics before wiring strategy UI.
5. Add strategy catalog/configuration.
6. Add group management in Lists.
7. Add backtest snapshot behavior.
8. Add Monitor support.
9. Complete test coverage and full gate.

Avoid unrelated refactors and cosmetic redesigns.

---

## Implementation clarifications (added during implementation)

The product decisions above are unchanged except where a later decision is dated in place (the
Category / Metric selector and the removal of the inclusive operators, 2026-09-28; the single Metric
picker, the configuration kept across measures of one family, and direct member selection in place
of Congress groups, 2026-10-11). What follows are
semantics the implementation had to fix
precisely, and provider facts verified live on 2026-09-25, recorded here so no surface has to
rediscover them. Nothing in this section relaxes the point-in-time rule.

### The lookback window is measured on the observable session

A disclosure has two dates and a backtest may only ever see the second. `Congress purchases` over a
30-session lookback therefore counts the purchases **disclosed** in the last thirty sessions, not the
purchases _made_ in them.

This is a clarification rather than a change, and it is load-bearing: a congressional disclosure
routinely lags its transaction by up to forty-five days, so windowing on the transaction date would
produce a metric that is almost always zero while still looking correct. The transaction date is
preserved on every row, is what the product reports, and is simply not what the window is measured
on. The same rule gives one definition for a historical backtest and a live Monitor, which is what
the Monitor-compatibility requirement asks for.

The **observable session** is the first trading session on or after `publication date + 1 day`. The
`+ 1 day` is the convention `statementPublicAvailabilityDate` already applies to a financial
statement with a real filing date, and for the same reason: the provider supplies a date and no
time, so nothing proves the document was public before that session's close. "First trading session
on or after" is implemented by the evaluation frame's own date axis, which holds exactly the sessions
the security traded — so weekends and exchange holidays are handled by the axis rather than by a
second calendar.

### Coverage has a floor, and outside it a metric is NOT_EVALUABLE

None of the provider endpoints accepts a date range, so a bounded historical read is
impossible and there is no coverage statement to read. The earliest availability date actually
ingested is therefore the earliest date a metric may report for, and before it the column is
NOT_EVALUABLE — never zero. "The provider had no filing" and "the dataset does not reach that far"
are indistinguishable from the payload, and reporting the second as the first would make
`Insider sellers is below 1` true across every year the data does not reach. A session is
evaluable only when its **whole** lookback window lies inside coverage, for the same reason a
partially warmed-up moving average is unavailable rather than short.

The upper bound is the date of the last successful ingest. Past it the product knows nothing.

### Operators and units the catalog gained

- **`is at least` / `is at most`** were added to the Condition vocabulary for these metrics and then
  **removed on 2026-09-28**: every comparison in the product is now the strict `is above` / `is below`
  pair, and on a whole-number count "at least two" is written `is above 1`. A rule still naming the
  inclusive pair is refused, never mapped onto a strict comparison (`>= 2` is not `> 2`). No product
  data held one — V2 was unreleased — and the developer-only QA-matrix fixtures were rewritten
  explicitly (`docs/development/qa-matrix-fixtures.md`).
- **A `MONEY` Value kind** was added for the amount measures (`$1,000,000`), for the same reason
  `MULTIPLE` exists: the unit is what lets one renderer print `30`, `2x` and `$1,000,000` without a
  per-metric formatting rule.
- **A money window is an exact sum** (pre-release audit ALT-01, fixed 2026-10-16). The window is
  summed in whole ten-thousandths of a dollar — the stored precision of an insider
  `transactionValue` (`Decimal(24,4)`) and of a Congress range bound (`Decimal(24,2)`) — and divided
  once, so an emptied window reads exactly `0` and `purchase value is above $0` never fires without a
  purchase. A floating-point running total left a residue (`6.98e-12` after four ordinary amounts)
  that made it fire, and made a backtest and a Monitor read the same session differently because the
  residue depended on where the frame started. The data-correctness audit compares every money
  column exactly.
- **Count thresholds are whole numbers.** `Insider buyers is above 2.5` is refused, and the
  bound is `0..1000` — a product bound no real disclosure count reaches, which keeps the validator's
  message readable and the control's range finite.
- **The lookback is a closed preset list** — 5, 10, 20, 30, 60, 90, 120, 180 and 250 trading sessions,
  defaulting to 20 for insiders and 30 for Congress. Presets rather than a
  user-entered window, exactly as `RELATIVE_VOLUME_PERIODS` is: an arbitrary window would be a
  parameter nothing validates and a label nothing can render consistently. A value outside the list is
  refused rather than rounded to a supported one.

### The alternative-data metrics are Condition-only

Neither offers a Trigger, exactly as Relative Volume does not and for the same stated
reason: a disclosure count is a state, and a Monitor's own not-matched -> matched transition already
raises a Signal on the session a Condition first holds. A `crosses above` form would be a second,
differently latched way to say the same thing.

### Direct member selection replaces Congress groups (2026-10-11)

**Decision (owner).** Reusable Congress groups are removed from the product. A Congressional rule
that narrows whose activity it counts selects the members itself, in its own configuration, and each
rule has its own selection. There are no groups, presets or saved selections, and the Lists area is
stock lists only.

**Why it is safe.** The engine never read a group. It reads a list of actor ids and filters
disclosures with it (`actorId IN (…)`); a group was one way to produce that list. A rule that holds
the list itself feeds the same read, so the same members give the same number on every session —
proven for every measure, lookback, chamber and owner filter, through a backtest and through a
Monitor, by `alternative-data-scope-equivalence.integration.test.ts`.

**What a selection means.** It is a membership filter, and the measure aggregates the pool:

| Selected members disclosed | `Congress purchases` | `Congress buyers` | `…minimum disclosed purchase value` |
| --- | --- | --- | --- |
| A: one purchase, B: one purchase | 2 | 2 | A's band floor + B's |
| A: two purchases, B: none | 2 | 1 | both of A's band floors |

So `Congress purchases is above 1` holds in both rows. It would hold in neither if the rule were
evaluated once per member and the results ORed, and `Congress sales is below 1` would hold whenever
any one selected member had not sold. Pooled is what a group always did, and it is the only reading
under which a threshold other than `is above 0` means what it says.

**The stored shape.** `scope: { kind: "ACTORS", actorIds: [...] }` — this product's canonical actor
ids, never display names; sorted, de-duplicated, between 1 and 250 (the bound a group had, so every
group converts). A selection of nobody is refused: "anyone" already has a shape, and a rule that
selects nobody reads a confident zero forever.

**What did not move.** No stored `definitionHash`, no frame column and no Monitor latch:

- A one-member selection serializes exactly as the old single-member scope did (`actor:<id>`), and
  the old shape is rewritten to it at read time, as a schema version 1 FINAL EXIT is upgraded to one
  Exit Rule.
- A group scope serializes as it always did, because it is still read.
- A selection of two or more contributes a **digest** of its ids to a fingerprint, not the ids. A
  Monitor stores its level's fingerprint on every state row, Signal and transition, and 250 ids are
  nine kilobytes; the digest keeps that string the size a group's was.

**What must keep working.** Strategy versions and backtest snapshots saved before this still name a
group or a single member, and they are re-read through the canonical validator on every path. So the
validator keeps both legacy shapes; only the strategy **write** boundary refuses a group, including
one carried over from the version being edited. A backtest still resolves a group from the
membership frozen in its own snapshot, a Monitor still resolves it from the group as it stands, and
the group tables and routes remain. The Builder opens a rule that names a group on that group's
members, so one Apply turns it into a selection.

**Duplicating a strategy that still names a group** gives the copy a selection of the members the
group holds at that moment. A copy is a new strategy and nothing new may name a group, but refusing
it left the user with a strategy they could run and not copy. The copy counts exactly the
disclosures the original counts that day and stops following the group afterwards; the original is
only read — same version, same hash, still naming its group. The group is read as a backtest
submission reads it, so only a built-in group or the caller's own can be embedded. A group that is
gone, not the caller's, or empty refuses the copy and says which: an empty selection is not a rule.

**What an unknown scope does.** It is refused — by the validator, by the signature, by the loader
and by the worker's snapshot parse — and is never read as nobody. A backtest snapshot holding a
selection is written at snapshot version 2, which a worker built before the selection existed
refuses at the parse; it would otherwise have serialized the unknown scope as a group with no id and
completed the run reporting no congressional activity at all.

**Converting what already exists** is the operator's deliberate act, never a side effect of a
deploy: `pnpm strategies:convert-group-scopes` is a dry run unless told otherwise, appends a version
and rewrites none, skips and names any strategy whose group is missing, empty or not its owner's,
and will not convert a strategy that has a Monitor until told to — because the conversion resets
that Monitor's affected levels once. `docs/development/congress-group-scope-conversion.md` is the
runbook, including the deploy order.

**The member catalog is synchronized with the provider's member directory** (owner, 2026-10-11;
`docs/development/congress-member-catalog.md` is the runbook). The first version of this decision
left the catalog holding only the members some loaded disclosure had named, which made the picker
depend on which securities happened to have been opened. It no longer does:

- **Where members come from.** `GET /stable/senate-profile` lists both chambers, in office and
  former — 1,261 identities on 2026-10-11 — and carries the same bioguide id a disclosure carries.
  A synchronization adds every member the catalog lacks and records the directory's spelling of
  every member it holds. All 217 members that disclosures had already created were found in the
  directory by that id, and kept their canonical ids.
- **Identity is the bioguide id.** No identity is made from a name, a directory row whose id is not
  a bioguide id is declined, and a member the directory stops listing is never removed.
- **The whole directory or nothing.** A run reads every page of both halves before it writes, in
  one transaction. A page that fails, an empty half, a filter the provider did not honour or paging
  that does not advance fails the run and leaves the catalog as it was.
- **An identity, never a trade.** A synchronization writes no disclosure and no coverage, and no
  metric reads the catalog. A member it added has no disclosures; a rule selecting them counts
  nothing where the security's coverage reaches and is still `NOT_EVALUABLE` where it does not.
- **Whose label.** A member's displayed name, chamber and state are their disclosures' once one has
  been loaded, as before, and the directory's until then. Ingestion is unchanged.
- **It runs when somebody runs it**: `pnpm data:congress-members:sync` or
  `POST /admin/congress-members/sync`, never on a page load and never beside another run. Nothing
  schedules it; the runbook says when to.

**What the catalog still does not hold, stated rather than hidden.**

- **It is the provider's directory, not a guarantee.** A former member the directory does not list,
  or a member sworn in since the last run, is in the catalog only once a disclosure of theirs is
  loaded. Three people whose latest position is outside Congress and who have no loaded disclosure
  are declined, because there is no chamber to file them under.
- **The picker says which catalog it is searching.** `GET /alternative-data/actors/catalog` reports
  `SYNCHRONIZED`, `NOT_SYNCHRONIZED` or `SYNCHRONIZATION_FAILED`, and an empty search is worded from
  it: nobody matches, or the directory is not loaded and the member may simply not be here yet.
- **A member has two spellings and no nicknames.** The directory spells 99 of those 217 members
  differently from their disclosures — "Bill Cassidy" beside "William Cassidy" — and a search
  matches either. Neither source holds a nickname: the senator people search for as "Ted Cruz" is
  "Rafael E Cruz" in one and "Rafael Edward Cruz" in the other. A search whose whole term matches
  nobody therefore still falls back to names sharing some of its words, those sharing more first
  and, among equals, those sharing its last word first, so he is found by the surname. No alias is
  invented and nothing is matched fuzzily.

**Not changed, on purpose.** Which disclosures exist, when each becomes observable, how a window is
measured, and what counts as coverage are exactly as they were. The data-quality questions the
investigation raised — a trade disclosed again later, a disclosure dated before its trade, the
absence of a provider-observation timestamp — are separate correctness work.

### Provider facts (verified live, 2026-09-25)

- `insider-trading/search` takes `symbol`, `page` and `limit`. `limit` caps at **1000**; `page` is a
  page index. Rows come newest-first by `filingDate`. **`from` and `to` are ignored** — the same
  newest rows come back whatever range is asked for — so history is reached by paging.
- `senate-trades` and `house-trades` take the same three parameters; `limit` caps at **250**. Rows
  come newest-first by `disclosureDate`, and **ordering within one disclosure date is not stable
  between calls**. Both endpoints return the member's bioguide id in a field named `senateID`, and
  neither states the chamber — the endpoint asked is the only evidence.
- `senate-profile` is the member directory and holds **both chambers** (verified live on
  2026-10-11; `house-profile` answers HTTP 404). `active=true`, also the default, returns members
  in office and `active=false` former ones; no row belongs to both. A page holds at most **500**
  rows, `page` is a page index, and the page after the last is an empty array: 540 in office and
  721 former that day, 1,261 distinct bioguide ids in the same `senateID` field the trade endpoints
  use. `latestPosition` is the latest position only, and is an office outside Congress for a former
  member who went on to hold one. There is no alias field.
- Because the payloads carry no per-line identity, two genuinely separate same-day trades by one
  actor with identical size, price and amount band **collapse into one row**. Collapsing is the
  deterministic choice; the alternative is a row count that grows on every reingest.
- **A full page can contain rows this product cannot normalize**, and the two counts must not be
  confused (verified live on 2026-09-26). `insider-trading/search` returns Form 3 rows — an initial
  statement of holdings, not a transaction — with an empty `transactionType`; sixteen of them were in
  AAPL's newest thousand. The mapper correctly drops them, so a full 1,000-row page arrived as 984
  mapped rows. Paging is therefore decided on the **provider's** own row count, never on the mapped
  one: the first implementation read 984 as "shorter than the cap, therefore the last page" and every
  cold ingest stopped after one page. AAPL's insider coverage floor was recorded as 2018-08-18 when
  the provider holds filings back to 2003-05-28, and the fifteen intervening years read NOT_EVALUABLE
  for a reason that had nothing to do with the data. The fix is in the port — `FmpProviderPage`
  carries `providerRowCount` beside `rows` — and the dataset variants are bumped to `v2`, because a
  `v1` state row is a coverage statement that is *wrong* rather than merely old and the refresh rule
  (stop at the first page that inserts nothing new) cannot repair it.
- **History is bounded by `ALT_DATA_MAX_PAGES_PER_INGEST`, and that bound is honest.** At twelve
  pages of a thousand insider rows a heavily-filed symbol can exhaust the budget before reaching its
  oldest filing — `CRM` reaches 2019 and `GOOGL` 2018 where most symbols reach 2003. The earliest
  availability date actually ingested is recorded as the coverage floor, so those years are
  NOT_EVALUABLE rather than silently zero, which is the same rule every other gap follows.

### Institutional Activity / 13F is out of V1

Every `institutional-ownership/*` endpoint answers **HTTP 402 "Restricted Endpoint: This endpoint is
not available under your current subscription"**: `extract`, `extract-analytics/holder`,
`symbol-positions-summary`, `latest` and `holder-performance-summary`. The legacy
`api/v4/institutional-ownership/portfolio-holdings` answers 403 "Legacy Endpoint". Verified live on
2026-09-25.

Form 13F is therefore **removed from V1 altogether** rather than shipped dormant. An integration that
has never seen a real payload cannot be validated: the field names would come from the provider's
documentation alone, and the derivation of new/increased/reduced/exited positions from consecutive
filings is exactly the kind of logic a wrong field name breaks silently. Unverified production code
behind a flag would still have to be read, migrated and maintained by everyone touching this area, so
none of it is kept: there are no institutional tables, enums, ports, metrics, scopes, groups or
settings in the schema or the code, and no surface carries a placeholder for them.

The 13F product decisions are out of this document rather than rewritten as a deferred appendix: they
are recoverable from the branch's history, and a specification that still described a domain the
product does not have would be the same dormant liability in prose. Reintroducing the domain is a
feature in its own right — a provider port and mapper verified against live payloads, an actor kind,
a third selector section and institution groups — and the abstractions the shipping V1 does keep are
the ones Insider and Congress genuinely need: the availability-date convention, the coverage
floor/ceiling, the content-addressed ingest, the actor catalog and the group snapshot.

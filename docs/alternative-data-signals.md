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

- the existing large categorized selector for the first operand
- the existing three-control condition row
- the current `signal / operator / value-or-series` grammar
- the Strategy Logic sidebar
- current responsive/mobile behavior

Do not replace conditions with alternative-data cards or large forms.

The condition row must remain conceptually:

```text
[first operand / signal] [operator] [value / comparison operand]
```

Examples:

```text
Insider buyers 20D       | is at least | 2
Congress purchases 30D   | is at least | 2
Congress buyers 30D      | is at least | 2
```

### First-operand selector

Add grouped sections to the existing large selector, matching the current visual pattern:

- Insider Activity
- Congressional Trading

Do not create a separate “Alternative Data” strategy-builder page.

### Configurable signals

Some first operands require extra configuration. That configuration belongs to the signal itself and must not become extra permanent columns in the condition row.

Use the most natural existing UI primitive after inspecting the repo: popover, dialog, or equivalent.

Possible configuration:

- lookback in trading sessions
- scope: Any / Specific actor / Actor group
- Congress person / Congress group
- chamber
- owner
- insider role, where supported

After configuration, keep the condition row compact and optionally render a subtle secondary summary below the first operand, e.g.:

- `Congress Watchlist`
- `Congress Watchlist · Any owner · Any chamber`
- `CEO, CFO, Director`

### Strategy Logic summary

Render readable natural-language summaries using the same semantics as the condition rows.

Examples:

- `Insider buyers 20D is at least 2`
- `Congress purchases 30D is at least 2 — Congress Watchlist`
- `Congress buyers 30D is at least 2 — House leadership`

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
- Specific person
- Congress group

Optional Congress filters can include:

- Chamber: Any / House / Senate
- Owner: Any / self / spouse / joint / available provider values

Specific actor and group selection are filters/scope over the same metric. Do not create bespoke strategy signal types for named actors.

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

The product decisions above are unchanged. What follows are semantics the implementation had to fix
precisely, and provider facts verified live on 2026-09-25, recorded here so no surface has to
rediscover them. Nothing in this section relaxes the point-in-time rule.

### The lookback window is measured on the observable session

A disclosure has two dates and a backtest may only ever see the second. `Congress purchases 30D`
therefore counts the purchases **disclosed** in the last thirty sessions, not the purchases *made* in
them.

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
`Insider sellers 20D is at most 0` true across every year the data does not reach. A session is
evaluable only when its **whole** lookback window lies inside coverage, for the same reason a
partially warmed-up moving average is unavailable rather than short.

The upper bound is the date of the last successful ingest. Past it the product knows nothing.

### Operators and units the catalog gained

- **`is at least` / `is at most`** were added to the Condition vocabulary and are offered by the
  alternative-data metrics **only**. The specification writes its own examples as
  `Insider buyers 20D is at least 2`; expressing that as `is above 1` would make a reader reason
  about the gap between whole numbers. No other metric gained an inclusive form, so no existing rule
  changed meaning.
- **A `MONEY` Value kind** was added for the amount measures (`$1,000,000`), for the same reason
  `MULTIPLE` exists: the unit is what lets one renderer print `30`, `2x` and `$1,000,000` without a
  per-metric formatting rule.
- **Count thresholds are whole numbers.** `Insider buyers 20D is at least 2.5` is refused, and the
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

### Provider facts (verified live, 2026-09-25)

- `insider-trading/search` takes `symbol`, `page` and `limit`. `limit` caps at **1000**; `page` is a
  page index. Rows come newest-first by `filingDate`. **`from` and `to` are ignored** — the same
  newest rows come back whatever range is asked for — so history is reached by paging.
- `senate-trades` and `house-trades` take the same three parameters; `limit` caps at **250**. Rows
  come newest-first by `disclosureDate`, and **ordering within one disclosure date is not stable
  between calls**. Both endpoints return the member's bioguide id in a field named `senateID`, and
  neither states the chamber — the endpoint asked is the only evidence.
- Because the payloads carry no per-line identity, two genuinely separate same-day trades by one
  actor with identical size, price and amount band **collapse into one row**. Collapsing is the
  deterministic choice; the alternative is a row count that grows on every reingest.

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

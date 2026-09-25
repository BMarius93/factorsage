# Alternative Data Signals — Product & Engineering Specification

## Status

Implementation target: `feat/alternative-data-signals`

This document freezes the product decisions for adding Insider Activity, Congressional Trading, and Institutional / 13F activity to FactorSage. The implementation should reuse existing strategy, backtest, monitor, Lists, FMP, caching, and UI patterns rather than introducing a parallel subsystem.

## Goals

Add three new alternative-data domains that can be used consistently in Strategies, Backtests, and Monitors:

1. Insider Activity
2. Congressional Trading (House + Senate)
3. Institutional Activity based on SEC Form 13F

The core requirement is point-in-time correctness: a backtest must only see information after it was publicly observable.

## Non-goals for V1

- No AI / smart-money scoring.
- No historical dynamic membership such as “all senators at that historical date”.
- No attempt to infer the actual trade date inside a 13F quarter.
- No new alternative-data-specific strategy builder.
- No redesign of the current Strategy page.
- No insider person groups in V1.

## Point-in-time semantics

Every event must preserve both the underlying economic/event date and the date/time when the information became publicly observable.

Examples:

- Insider: transaction date != Form 4 filing/publication date.
- Congress: transaction date != disclosure date.
- 13F: quarter end / report period != filing date.

Backtest evaluation must use the public availability boundary, never the underlying transaction/period date when disclosure came later.

For daily evaluation, if the available provider data cannot prove that the information was public before the relevant market-session execution boundary, use the next valid trading session as the observable session. Reuse the existing market-calendar/session utilities.

Do not weaken this rule for convenience.

## Data architecture

Keep provider/raw data auditable and separate from normalized or derived state.

Recommended conceptual split:

- raw insider filings / transactions
- raw congressional disclosures
- raw 13F filings / holdings
- canonical actors
- normalized alternative-data events / derived metrics

Historical provider records must not be destructively overwritten. Amendments/revisions should preserve identity and provenance so historical results remain reproducible.

### Canonical actors

Use stable external IDs as identity. Display names are labels only.

Conceptually:

```ts
Actor {
  id
  type: INSTITUTION | CONGRESS_PERSON
  externalId
  displayName
  metadata
}
```

Examples of metadata:

- Institution: CIK, provider identifiers, aliases.
- Congress person: provider/member identifier, chamber, state/district where available.

## Actor groups

Add reusable user-defined groups for:

- Institutions
- Congress people

Do not add insider groups in V1.

Conceptually:

```ts
ActorGroup {
  id
  userId
  name
  actorType: INSTITUTION | CONGRESS_PERSON
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
- Institution Groups
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
Institutional buyers 60D | is at least | 3
Congress purchases 30D   | is at least | 2
Institutional position change | is at least | 25%
```

### First-operand selector

Add grouped sections to the existing large selector, matching the current visual pattern:

- Insider Activity
- Congressional Trading
- Institutional Activity

Do not create a separate “Alternative Data” strategy-builder page.

### Configurable signals

Some first operands require extra configuration. That configuration belongs to the signal itself and must not become extra permanent columns in the condition row.

Use the most natural existing UI primitive after inspecting the repo: popover, dialog, or equivalent.

Possible configuration:

- lookback in trading sessions
- scope: Any / Specific actor / Actor group
- institution / institution group
- Congress person / Congress group
- chamber
- owner
- insider role, where supported

After configuration, keep the condition row compact and optionally render a subtle secondary summary below the first operand, e.g.:

- `Superinvestors`
- `Congress Watchlist · Any owner · Any chamber`
- `CEO, CFO, Director`

### Strategy Logic summary

Render readable natural-language summaries using the same semantics as the condition rows.

Examples:

- `Insider buyers 20D is at least 2`
- `Institutional buyers 60D is at least 3 — Superinvestors`
- `Congress purchases 30D is at least 2 — Congress Watchlist`

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

## Institutional Activity / 13F

Use institutional naming in the product/domain rather than implying all 13F filers are hedge funds.

Preserve separately:

- report/quarter period
- filing date / public availability
- manager identity (CIK or canonical equivalent)
- security identity
- shares / value / portfolio weight when available
- amendment/revision identity

Derive position changes by comparing publicly available filings only.

V1 derived states/metrics can include:

- New position
- Position increased
- Position reduced
- Position exited
- Position change %
- Portfolio weight / weight change when source data supports it
- Institutional buyers / increasing managers count over an appropriate lookback

Do not infer when during the quarter the manager traded. A quarter-end holding is not a transaction event.

## Scope semantics

For configurable alternative-data metrics, support:

### Institutions

- Any institution
- Specific institution
- Institution group

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
- Form 13F institutional holdings / filing dates / positions

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

### Institutional Activity

- Institutional buyers (ND)
- Institutional sellers / reducers (ND)
- Institutional new positions (ND)
- Institutional exits (ND)
- Institutional position change (%)

Do not add signals merely to inflate the catalog. Prefer a small explainable V1.

## Testing requirements

Add focused unit/integration/e2e coverage for at least:

- no look-ahead across transaction date vs filing/disclosure date
- next-session observability boundary
- weekends/market holidays using existing calendar utilities
- 13F new/increase/reduce/exit comparisons
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
# V1 Visual Parity and UI Consistency Specification

Status: normative for the V2 visual-parity pass.

This document defines how FactorSage V2 should recover the visual character, information density
and responsive composition of the deployed V1 product while retaining the V2 domain model,
contracts, accessibility and component architecture.

`frontend.md` remains authoritative for frontend architecture and product-wide direction.
`ui-system.md` remains authoritative for component ownership. This document is the acceptance
contract for how those components compose into consistent product screens.

## Goal and non-goals

The goal is a refined continuation of V1, not a visual copy and not a new redesign. A returning user
should recognize FactorSage from its calm near-white canvas, compact financial information,
restrained blue accent, light borders and clear outcome-first hierarchy.

The parity pass must not restore obsolete V1 product decisions:

- no credits;
- no Watchlist;
- no historical index-membership universes;
- no Strategy-owned Stock List or execution parameters;
- no user-entered maximum-allocation percentage;
- no legacy valuation-model grammar where it conflicts with the canonical V2 Strategy grammar;
- no incorrect or invented chart values across unavailable periods;
- no duplicated desktop/mobile records or legacy repository architecture.

V2 semantics win whenever they conflict with V1. V1 is the visual and interaction oracle.

## Consistency contract

Every screen must use the following hierarchy. Feature pages must not invent local alternatives for
equivalent actions or surfaces.

### Page types

There are four page types:

1. **Collection** — Lists, Strategies, Monitors and Backtests.
2. **Editor/workflow** — create or edit forms and New Backtest.
3. **Entity detail** — List, Strategy, Monitor and Stock details.
4. **Outcome hero** — Backtest results and other future result-first experiences.

Billing is a **product page of the first type's family**, not a marketing surface. `/billing` is
reached only from an authenticated session, and a returning customer opens it to see what they are on
and what it costs — so it uses the ordinary `PageHeader` + section composition, with three plan cards
(Free, Starter, Pro) and one billing-cadence toggle as its only feature-owned composition. A
conversion hero belongs to a future _public_ pricing page, if one is ever built; it does not belong
behind the sign-in.

### Page header

`PageHeader` remains the only page-title component and gains explicit visual variants rather than
being reimplemented by features:

| Variant     | Use                                                          | Composition                                                                       |
| ----------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `surface`   | collections and ordinary entity details                      | white 16px-radius bordered surface; title, lead/badges and actions                |
| `plain`     | editors where the form surface supplies the visual container | compact title and optional back link; no duplicate section title                  |
| `hero`      | result-first screens                                         | title/context/actions composed into the feature hero; no separate header above it |
| `marketing` | future **public** conversion pages only, never `/billing`    | feature-owned promotional layout using shared tokens                              |

For `surface`, use 12px padding on phones and 24px from tablet upward. The title is approximately
16px on phones and 20px on desktop. Ordinary collection headers must not use a 24-28px display title.

There must be exactly one visible page title and one accessible `<h1>`. Do not follow a collection
header with a second card titled “Your lists”, “Your strategies”, “Your monitors” or “Run history”.

### Page-level action placement

The same semantic action must appear in the same location across features:

| Context                                                                        | Desktop                                                                                     | Phone                                                                                                        |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Collection `New …`                                                             | right side of the `PageHeader` surface                                                      | right side of the same header when it fits; otherwise full-width directly below title/lead inside the header |
| Entity primary action (`Run Backtest`, `Save`, `Update`)                       | rightmost action in the entity header                                                       | full-width primary action below identity/context, or in the workflow action bar                              |
| Entity secondary action (`Edit`)                                               | immediately left of the primary action                                                      | visible secondary action beside the primary when there are at most two actions                               |
| Destructive action (`Delete`)                                                  | overflow menu or confirmation workflow; never equal visual weight beside the primary action | overflow menu only                                                                                           |
| Row/card contextual action (`View Results`, `Run Backtest`, `Open`)            | one quiet visible action in the actions column                                              | one visible action at the bottom of the card                                                                 |
| Row/card maintenance actions (`Rename`, `Edit`, `Enable`, `Disable`, `Delete`) | overflow menu unless it is the row's single primary purpose                                 | overflow menu at the top-right                                                                               |

Rules:

- The order is always secondary, then primary, with overflow last when displayed in the same row.
- A page or record has at most one solid-blue action.
- `New …` is the collection-level primary action; row actions must not compete with it in solid blue.
- `Edit` is never placed in a different corner merely because a feature owns bespoke markup.
- `Delete` must not appear as a permanently visible peer to `New`, `Edit`, `Run` or `Save`.
- The overflow trigger has the same icon, hit area, accessible label pattern and menu alignment across
  Lists, Strategies, Monitors and Backtests.
- Actions must not change order between loading, empty and populated states.

### Workflow actions

Create/edit workflows use the same footer contract:

- Desktop/tablet: actions appear at the bottom-right of the form surface in the order Cancel,
  primary action.
- Phone: long workflows use a fixed action bar above the mobile bottom navigation and safe-area
  inset. It contains an optional concise selection summary, Cancel and the primary action.
- The page reserves bottom space equal to the action bar plus bottom navigation so content cannot be
  obscured.
- Validation errors focus or scroll to the first invalid field; moving actions into a fixed bar must
  not hide the error state.

New Backtest must use this phone action bar. Its summary should describe the current configuration
or allocation state, never V1 credits.

## Visual tokens and elevation

Ordinary product surfaces use:

- 16px radius;
- a light cool border;
- no shadow or only the subtle equivalent of V1 `shadow-sm`;
- white background;
- 12px internal padding on phones and 24px on desktop unless a dense table supplies cell padding.

Large 24-30px radii and blue-tinted elevation are reserved for a true hero, primarily Backtest
Results. They are not defaults for every `SectionCard`.

Nested elements use smaller radii than their parent. A nested control, chip or chart frame must not
look like another page-level card. Do not create equally elevated card-inside-card compositions.

The page canvas remains near-white. Positive, negative and warning colors communicate financial or
operational state; they are not decorative section colors.

## Spacing and width

- Page horizontal padding: 16px phone, 24px tablet, 32px small desktop, 40px large desktop.
- Page section gap: 24px phone and 32px desktop.
- Product pages use the available desktop width. A maximum width may protect readability on forms
  and prose, but must not unnecessarily compress financial tables or charts to 1280px.
- Section headings, table first/last cells and flush content align to the same surface inset.
- Dense tables use compact row heights; 44px minimum targets apply to touch interactions, not to
  adding desktop whitespace around every label.

## Responsive breakpoints

Shell layout and feature content have different constraints and therefore use different switches:

- `600px`: fuller brand treatment and tablet form composition where space permits.
- `768px`: collection tables switch between semantic desktop table and dedicated mobile-card
  layout.
- `1024px`: persistent desktop navigation replaces mobile bottom navigation.
- `1280px`: large-desktop page padding.

Do not reuse one breakpoint for table composition, brand visibility and navigation solely for code
convenience.

At widths below 768px, a collection surface must visually dissolve: no bordered/shadowed outer card
around a stack of bordered row cards. The section title is already supplied by `PageHeader`; render
standalone record cards with the page background visible between them. The single accessible DOM
tree and explicit table roles from V2 must remain.

## Application shell

The shell should reproduce the V1 information architecture while using the V2 route registry.
Navigation metadata remains centralized, but it may expose an explicit order/visibility per surface.

Desktop order from 1024px:

1. Strategies
2. Monitors
3. Backtests
4. Lists
5. Learn, when the destination exists in V2

The brand links to Dashboard, so Dashboard does not need a desktop navigation label.

Mobile bottom-navigation order below 1024px:

1. Dashboard
2. Lists
3. Monitors
4. Strategies
5. Backtests

Search remains directly visible in the topbar at normal phone widths. An icon-only search may be
used only where the full control genuinely cannot fit, and must open an immediately focused search
surface. Fixed shell elements must respect safe areas and reserve content space.

## Collection anatomy

All four collections use the same page composition:

```text
PageHeader(surface)
  title + lead
  New <entity>

filters/toolbar, only when needed

DataTable on desktop / standalone record cards on phone
```

Do not add a second generic `SectionCard` merely to wrap the collection. An empty state occupies the
same collection region without moving `New …` away from the header.

Every mobile record card uses this order:

1. identity top-left;
2. status and overflow top-right;
3. optional description;
4. compact high-value facts;
5. linked entities as one relationship block or compact chain;
6. one contextual action below a subtle divider.

Feature-specific applications:

- **Backtests:** stable run identity and status; Strategy/List/Benchmark context; period, result and
  completion state; visible `View Results` when available.
- **Strategies:** name/type, description, last updated and usage when contracts provide it; visible
  `Run Backtest`; maintenance actions in overflow.
- **Lists:** name/type, symbol count, usage/update summary; visible `Run Backtest`; maintenance
  actions in overflow.
- **Monitors:** name/status, compact `Strategy → List` relationship, match or stock count and last
  scan; opening the detail is the contextual action; enable/edit/delete live in overflow unless a
  blocked state requires one explicit corrective action.

Missing reverse-usage counts, entity ids or active-match aggregates are contract gaps documented in
`ui-system.md`. Do not fake them or introduce N+1 requests.

## Page-specific acceptance

### Dashboard

- No redundant visible “Dashboard” heading.
- The summary strip remains a compact four-item row on desktop and phone; phone content may use
  abbreviated labels and values rather than changing to a 2x2 grid.
- One major blue action tile may be used for Run Backtest. The other tiles remain quiet.
- Current/active matches are the first primary dataset when the aggregate contract exists. Until
  then, show truthful collection-level information with a clear path into Monitors.

### New Backtest

- Present one cohesive workflow surface, with internally grouped fields rather than three equally
  elevated page cards.
- Keep the canonical V2 Strategy, Stock List, Benchmark, period, capital, contributions and maximum
  positions semantics.
- Use the shared workflow footer and fixed phone action bar.

### Backtest result

- Use an outcome hero containing run identity/context, status/progress, the absolute-value Strategy,
  Benchmark and Cash chart, legend and primary KPIs.
- Configuration follows the result and may be collapsible.
- On phones, primary KPIs remain compact; target four columns when labels/values fit and split the
  eight core values over two rows. Do not default to a long two-column dashboard.
- Preserve V2 chart correctness and unavailable-data gaps.
- Add human-readable frozen Strategy logic and per-security breakdown only when supported by a
  truthful run snapshot/read model.

### Entity detail and editors

- **List detail:** surface header with identity, membership summary and Edit/Run Backtest in the
  canonical action positions; preserve V2 buy-window editing.
- **Strategy detail/editor:** surface or plain header appropriate to mode, actual Strategy identity,
  secondary Edit and primary Run/Update positioning; preserve V2 Strategy grammar and level ids.
- **Monitor detail:** surface header combines identity, status, relationships, last checked and
  active count. Current Matches is the first/default data section; Signal History follows. Preserve
  V2 enabled-versus-operational status and four security states.
- **Stock detail:** surface header; on phones show price, market cap and sector in a compact summary
  grid. Keep the chart in a restrained inner frame, preserve the canonical Indicators control,
  viewport-driven history and unavailable gaps.

### Billing

- Billing is an authenticated product page and composes like one: `PageHeader` with the plan badge
  and the single `Manage billing` action, then the plan comparison, then a `SectionCard` carrying the
  subscription's own facts. No hero, no promotional copy, no giant empty vertical regions.
- **Three plan cards — Free, Starter, Pro — and never one card per price.** Monthly and yearly are a
  property of a plan, so a segmented cadence control re-prices the same three cards in place. Free is
  a first-class card, not an account state.
- Plan cards wear the product's own page-level surface, composed from `SectionCard`'s `.card` rather
  than restyled, and their buttons align on one baseline however the feature text wraps.
- Capacities on the cards are **derived** from `PLAN_ENTITLEMENTS` and amounts from
  `BILLING_CATALOG`; no limit or price is written down a second time in the web app.
- The current plan is shown on its own card and as a badge beside the title — never as a standalone
  strip above the comparison.
- It must use current V2 tiers, prices and entitlements and must not restore credits.
- It still consumes global color, typography, control and focus tokens. Feature checks use the brand
  accent, not `--color-positive`: green and red mean financial and operational state here.

## Accessibility and interaction

- Preserve exactly one semantic record in the DOM across desktop and phone.
- Every icon-only and overflow action has a specific accessible label including the entity name
  where useful.
- Keyboard focus order follows the visible order: identity/context, primary content, contextual
  action, overflow where applicable.
- Status is never communicated by color alone.
- Touch targets are at least 44px without forcing desktop row heights to 44px.
- Fixed mobile bars respect `env(safe-area-inset-bottom)` and never cover content or toasts.
- Charts and menus work without hover.

## Implementation boundaries

- Extend shared components with explicit variants; do not add page-local imitations of the same
  header, action row, collection card or workflow footer.
- Centralize action vocabulary and ordering in shared composition/CSS, while features own action
  availability and business behavior.
- Navigation stays one registry, with explicit desktop/mobile ordering metadata rather than two
  duplicated lists.
- Feature CSS consumes semantic tokens and must not introduce new brand hex values.
- Backend/read-model work required for exact V1 information parity must be a deliberate contract
  change with tests, not frontend reconstruction.

## Verification checklist

The parity work is incomplete until all affected screens are verified at representative widths:

- 390px phone;
- 768px boundary;
- 1024px navigation boundary;
- 1440px desktop.

For every collection and detail/workflow screen verify:

- title, lead and actions occupy the prescribed positions;
- New/Edit/Run/Save/Delete and overflow ordering matches this document;
- no duplicate heading or nested page-level surface exists;
- no page-level horizontal scroll exists;
- mobile fixed chrome does not obscure content;
- loading, empty, error and populated states preserve the same layout anchors;
- long names, missing descriptions, blocked statuses and unavailable actions do not move actions to
  inconsistent locations;
- keyboard focus, accessible names and semantic table/card roles remain correct.

Capture desktop and phone screenshots for Dashboard, Lists, Strategies, Monitors, Backtests, New
Backtest, one Backtest Result, one Monitor Detail and Stock Details. Compare the hierarchy and
density with deployed V1, while explicitly documenting any intentional V2 semantic difference.

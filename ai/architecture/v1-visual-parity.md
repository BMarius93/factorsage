# V1 Visual Parity and UI Consistency Specification

Status: normative, and **implemented**. The design-system pass that closed this specification is
described under "What the parity pass changed" below; the measured V1 reference it was calibrated
against is under "Measured V1 reference".

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
(Free, Starter, Pro) and one billing-cadence toggle as its only feature-owned composition.

The public `/pricing` page (DEC-001, PRICING-001) is the same family, not a marketing surface: an
ordinary `PageHeader`, the **same** plan comparison component `/billing` renders (`PlanCatalog`),
and one `SectionCard` of billing facts. It gets no conversion hero and no second card design, so the
two pages cannot drift apart visually or in what they quote. A Guest reads it inside the normal
shell, with a quiet "Pricing" link beside "Sign in" in the topbar.

### Page header

`PageHeader` remains the only page-title component and gains explicit visual variants rather than
being reimplemented by features:

| Variant   | Use                                                          | Composition                                                                   |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `surface` | collections and ordinary entity details (the **default**)    | white `--radius-lg` bordered surface; title, lead/badges, `aside` and actions |
| `plain`   | editors where the form surface supplies the visual container | compact title and optional back link; no duplicate section title              |
| `hero`    | result-first screens                                         | title/context composed into the feature hero; no separate frame of its own    |

`surface` uses `--card-pad` (12px on phones, 24px from 880px). The title is `--text-page-title`
(17px on phones, 20px from 880px) at `--weight-emphasis`. Ordinary headers must not use a 24-28px
display title; that size is `--text-page-title-hero` and belongs to the backtest result.

`PageHeader` also takes an `aside`: a page-level _fact_ aligned to the right of the identity — a
stock's quote, a run's progress. It sits where actions sit but is something the page reports, not
something the user can do. A marketing variant is deliberately **not** implemented: no route needs
one — `/billing` and the public `/pricing` are ordinary product pages.

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
- **A page or record has at most one solid-blue action, and it is the one that commits work.**
  `forms.primaryButton` (solid `--color-primary`) is for `Run backtest`, `Save`, `Create` and the
  single call to action on an empty state. `forms.tintedButton` — brand blue as _ink_ on
  `--color-primary-soft` — is what `New …` and an entity's `Edit` wear. This is V1's own treatment,
  and it is what keeps a page's loudest element from being a link to a form.
- `New …` is the collection-level action and uses the tinted treatment; row actions must not compete
  with it.
- `Edit` is never placed in a different corner merely because a feature owns bespoke markup.
- `Delete` must not appear as a permanently visible peer to `New`, `Edit`, `Run` or `Save`.
- The overflow trigger has the same icon, hit area, accessible label pattern and menu alignment across
  Lists, Strategies, Monitors and Backtests.
- Actions must not change order between loading, empty and populated states.

### Workflow actions

Create/edit workflows use the same footer contract. `WorkflowFooter` implements it and is the
default; Strategy Builder is an intentional exception, documented under "Workflow footer exceptions"
below:

- Desktop/tablet: actions appear at the bottom-right of the form surface in the order Cancel,
  primary action.
- Phone: long workflows use a fixed action bar above the mobile bottom navigation and safe-area
  inset. It contains an optional concise selection summary, Cancel and the primary action.
- The page reserves bottom space equal to the action bar plus bottom navigation so content cannot be
  obscured.
- Validation errors focus or scroll to the first invalid field; moving actions into a fixed bar must
  not hide the error state.

#### Workflow footer exceptions

`WorkflowFooter` is the default, not a mandate. A screen may keep its own footer when it carries
state the generic one does not model — and exactly one does today:

**Strategy Builder** keeps its persistent save bar. It is not a Cancel/Submit pair: it reports live
save status and dirty state, counts outstanding validation issues and uses that count as the control
that reveals and focuses the first invalid condition, and offers Discard changes beside Save. Moving
that into `WorkflowFooter` would either teach a shared component what a strategy issue is, or strip
the editor of an affordance. Neither is an improvement, so the exception is deliberate — do not
refactor it away to make the vocabulary look tidier. If a second editor ever needs the same
behaviour, that is the point to generalise, with the shared thing modelling save state explicitly.

New Backtest must use this phone action bar. Its summary should describe the current configuration
or allocation state, never V1 credits.

### The Dashboard overview strip

The Dashboard opens with V1's own five-card row — `Run Backtest · S&P 500 · DJIA · VIX · Real-time
Matches` — directly under the page header and above the signals table. It is a feature-owned
composition, not a `SectionCard`: five small cards on the page canvas, measured against V1 at 76px
on a phone and 120px from 880px, with the label/value/change hierarchy and the right-hand
seven-session sparkline V1 uses. Two departures from V1 are deliberate:

- **flat, not elevated.** V1 gives each card a soft drop shadow and the action card a blue gradient.
  V2 surfaces use `--shadow-surface` (`none`) and a flat `--color-primary` fill, because a glow
  under every panel is the single loudest thing that made V2 read as a different product.
- **the session date, not `24h`.** V1's change pill says `24h`; these are end-of-day closes compared
  session over session, so the pill carries the session the close belongs to instead. A market card
  must not claim a freshness it does not have.

**VIX is read as a gauge, not a trend.** It is a level, not a price, so its card keeps the family's
size, border, radius and padding and swaps the sparkline for a segmented semicircular arc with a
marker, the level set inside the arc and its zone underneath (`Very low · Normal · Elevated · High ·
Extreme`, from `features/market/utils/vix.ts`, the one place the thresholds live). The number is
always the real `^VIX` close. The arc is an explicitly clamped 0–80 display range — the marker pins
to the end at 80 or more while the text keeps the real value — and runs green → amber → red because
a low VIX is calm, the opposite of a fear/greed dial. Colours are the financial-state tokens and
blends of adjacent ones, mapped once. The session-over-session change stays, secondary, beside the
title. On a phone the card is `VIX · 15.43 · Normal`; an arc in 65px would not be legible. It is
never called Fear & Greed or given a sentiment score.

`Run Backtest` is a card in the same family, not a button beside cards, and it wears the product's
one solid-blue action treatment because it is the only thing in the strip that does something. Do
not add a sixth card: the metrics deliberately left out are listed in `benchmark-data.md`.

## Visual tokens and elevation

Ordinary product surfaces use:

- `--radius-lg` (16px);
- a light cool border (`--color-border`);
- **no shadow** (`--shadow-surface` is `none`) — V1 measures `box-shadow: none` on every ordinary
  surface, and a soft blue glow under every panel is the single loudest thing that made V2 read as a
  different product;
- white background (`--color-surface`);
- `--card-pad` internal padding, unless a dense table supplies cell padding.

`--radius-hero` (28px) and `--shadow-hero` are reserved for a true hero — today only Backtest
Results, through `<SectionCard hero>`. They are not defaults for every `SectionCard`. Overlays are
the only other place elevation is real: `--shadow-menu` for menus and dropdowns, `--shadow-dialog`
for a modal.

Nested elements use smaller radii than their parent. A nested control, chip or chart frame must not
look like another page-level card. Do not create equally elevated card-inside-card compositions.

The page canvas remains near-white. Positive, negative and warning colors communicate financial or
operational state; they are not decorative section colors.

## Spacing and width

- Page horizontal padding: `--page-pad-mobile` 16px, `--page-pad-tablet` 32px from 600px,
  `--page-pad-wide` 40px from 1280px — V1's three-step ladder.
- Page section gap: `--section-gap`, 24px phone and 32px desktop. V1 measures a consistent 32px
  between page sections on desktop.
- Product pages use the available desktop width. `PageContainer` takes `width="data" | "reading"`:
  `data` runs to `--content-max-width` (1600px) for collections, details, charts and results;
  `reading` caps at `--reading-max-width` (820px) for editors and prose. A route never writes its
  own max-width. V1 is fluid to a 40px gutter — at 1920px its backtests table is 1838px wide — so a
  financial table must never be compressed into a reading column.
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
same collection region without moving `New …` away from the header: `New …` is in the header in
loading, empty, error and populated states alike (disabled while the session resolves), and the
empty state points at it in words rather than repeating it as a second, differently styled button
(UI-030).

Every List, Strategy and Monitor detail header offers **Run backtest** (secondary), owned or
built-in, before the page's own Edit and overflow; see `frontend.md` (UI-008).

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
- Current matches are the first primary dataset: the "Current signals" table (desktop) / record
  cards (phone), one row per monitor outcome, filterable by state and action, row click to Stock
  Details (`docs/decisions/builtin-dashboard-signals-v1.md` section 4). It replaced the V2 summary
  strip, which reported collection counts only while the aggregate contract did not exist.
- Below it, the monitors feeding the table as quiet cards with a switch each and honest freshness.
- A Guest sees the same page with a restrained sign-in notice; nothing on it is a dead end.

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
- Primary KPIs: **two columns below 600px, four from 600px, eight from 1,280px** (UI-033). The
  earlier four-columns-on-phones target is withdrawn: a value such as `$137,426.91` does not fit a
  ~90px cell at 390px, and a clipped financial figure is worse than a taller card.
- The chart keeps a persistent legend under it (hover only adds the crosshair readout). Strategy is
  the brand blue, the Benchmark a cool neutral, and Cash a warm neutral **dashed** line, so the
  Strategy and Cash lines stay distinguishable where they overlap (UI-032).
- A completed run's hero offers **Edit and run again**: New Backtest prefilled from the run's
  immutable snapshot. The original run is never changed.
- A failed run shows cause and recovery, not an implementation code (UI-031): the message is mapped
  from the failure code and phase (`features/backtests/utils/failure.ts`); a data problem asks for
  a different list or period instead of recommending a futile retry; the code, phase and run id sit
  in a collapsed "Details for support". A run that never produced a result renders **no** result
  sections — no empty chart, no KPIs of "—", no "No positions"/"no trades" copy.
- The collection gives every row a contextual action: "View results" for a finished run, "View
  progress" for a queued or running one (UI-034). Its Stock list chip links while the list exists.
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

## Measured V1 reference

The tokens were calibrated against the deployed V1 product read through computed CSS at 390 / 834 /
1440 / 1920px. The values that mattered:

| Property              | V1 measured                                    | V2 token                          |
| --------------------- | ---------------------------------------------- | --------------------------------- |
| Page title (desktop)  | 20px / 600, `#111827`                          | `--text-page-title` at 880px      |
| Page title (phone)    | 16px / 600                                     | `--text-page-title`               |
| Result hero title     | 32px / 600                                     | `--text-page-title-hero`          |
| Emphasis weight       | 500 and 600; 700 used 33× in the whole product | `--weight-emphasis: 600`          |
| Page surface          | `radius 16px`, `1px #E5E7EB`, `shadow: none`   | `--radius-lg`, `--shadow-surface` |
| Result hero surface   | `radius 30px`, tinted border, gradient         | `--radius-hero`, `--shadow-hero`  |
| Overflow menu         | `160×74px`, `radius 8px`, `1px #E5E7EB`        | `--radius-sm`, `--shadow-menu`    |
| Page padding          | 16 / 32 / 40px                                 | `--page-pad-*`                    |
| Section gap (desktop) | 32px                                           | `--section-gap`                   |
| Card padding          | 24px (12px phone)                              | `--card-pad`                      |
| Content width @1920   | table 1838px, fluid, no cap                    | `--content-max-width: 1600px`     |
| Collection CTA        | `34px`, `#EDF1FF` fill, `#3B5CCC` ink          | `forms.tintedButton`              |
| Row hover             | `#F5F7FF`                                      | `--color-row-hover` (`#F5F8FF`)   |
| App background        | `#FCFCFC`                                      | `--color-background`              |
| Table header          | 11px / 600 uppercase, tracking 0.88px          | `--text-label-size` + tracking    |
| Table row height      | 63–77px                                        | cell padding, not a fixed height  |

**What V1 does that V2 deliberately does not reproduce.** V1 runs three competing neutral ramps —
Tailwind cool greys on the collections, a warm taupe layer on the chrome and forms (`#E8DFDA`,
`#DFD3CE`, `#F7F2EF`), and a newer cool-blue layer on the dashboard and monitor detail. That is
drift, not identity. V2 keeps one ramp. V1 also ships no custom focus ring (the browser default
outline and nothing more), no measurable hover on its primary button, three different greens for a
positive value, and a separate mobile DOM. V2 keeps its focus ring, its hover states, one green and
`DataTable`'s single accessible tree.

## What the parity pass changed

Tokens now carry the product's shared visual language: `apps/web/src/styles/tokens.css` owns the
semantic palette, the radius and elevation scales, the type scale, the standard control sizes and
the page spacing and width system, and no feature restates one of those. Geometry local to a single
component stays with that component; `ai/architecture/ui-system.md` draws the line. One part of the
rule is absolute and holds: a hex colour appears nowhere else in `apps/web/src`. The components that
consume the tokens:

- `PageContainer` gained `width="data" | "reading"`.
- `PageHeader` gained `variant="surface" | "plain" | "hero"` (default `surface`) and an `aside` slot.
- `SectionCard` became a flat `--radius-lg` surface, gained `hero`, and a `flush` surface now
  **dissolves below 880px** so `DataTable`'s record cards sit on the canvas instead of inside a box.
- `OverflowMenu` is new and is the only home for Rename / Edit / Enable / Disable / Delete.
- `CollectionFooter` + `usePagination` are new: page size, visible range and page navigation, applied
  in the browser over rows the page already holds — no contract change and no extra requests.
- `WorkflowFooter` is new: Cancel then primary at the bottom-right of a form surface, and a sticky
  bar above the bottom navigation on a phone. New Backtest uses it; Strategy Builder keeps its own
  save bar, for the reasons under "Workflow footer exceptions".
- `forms.module.css` gained `tintedButton` and `inputCompact`; `actions.module.css` **lost** its
  danger variant, because a destructive action is never a visible peer to the record it destroys.

Every collection is now `PageHeader(surface)` → flush `SectionCard` → `DataTable` →
`CollectionFooter`, with no second heading. The backtest result leads with `<SectionCard hero>`
holding identity, status, chart and KPIs, and its run configuration follows in a collapsed
`<details>`.

# UI System

The shared UI vocabulary of the FactorSage web application: what the reusable components are, what
each one represents, and when **not** to reach for one.

`v1-visual-parity.md` is the normative composition and acceptance contract for the visual-parity
pass, including surface hierarchy, consistent action placement and responsive page anatomy.

`frontend.md` owns frontend architecture, the visual direction and the responsive contract. This
document owns the component inventory that implements them. If the two ever disagree, `frontend.md`
wins and this file is the thing to correct.

The rule this document exists to enforce:

> Reuse a stable cross-feature UI **concept**. Do not promote markup to a shared component merely
> because two features currently produce similar-looking HTML.

A page header, a section surface, a collection, a status, a relationship and a stock's identity are
concepts. A two-column grid is not.

## Where things live

```text
apps/web/src/components/ui/       # the shared vocabulary below
apps/web/src/components/layout/   # application chrome (AppShell, topbar, navigation)
apps/web/src/features/<feature>/  # what a Monitor, a Backtest or a Strategy *means*
```

A feature owns its labels, its tones, its ordering and its copy. A shared component owns only how
those look. `SECURITY_STATUS_TONES` lives in `features/monitors/utils/format.ts` and maps the four
Monitor security statuses to `StatusTone`; `StatusBadge` has no idea what a Monitor is, and must
not learn.

## Composition

Every product page is the same three layers:

```text
PageContainer            # width intent + progressive padding (components/layout)
  PageHeader             # the one <h1>, its lead, badges, aside, actions, back link
  SectionCard            # the page-level surface per section
    DataTable            # a collection inside it
    CollectionFooter     # page size, visible range, page navigation
    FactGrid             # the properties of one entity
    EmptyState           # nothing / not found / could not be loaded
  WorkflowFooter         # Cancel + primary, for a create/edit route
```

A **collection** is always exactly this, and never adds a second heading of its own:

```text
PageContainer width="data"
  PageHeader variant="surface"     # title, lead, New … (tinted)
  SectionCard flush                # untitled surface; dissolves below 880px
    DataTable                      # one contextual action + OverflowMenu per row
    CollectionFooter
```

A route's own `.page` class composes `stack` from `components/ui/page.module.css`, which is the one
definition of the vertical rhythm between sections. Do not set a page gap or a page top padding in a
feature stylesheet.

## The components

### `PageContainer`

Width is an **intent**, not a number. `width="data"` (the default) lets collections, details, charts
and results use the screen; `width="reading"` caps editors and prose at a readable measure. No route
writes a `max-width` of its own.

### `PageHeader`

The product's only page-title treatment: `<h1>`, optional lead sentence, optional status badges
beside the title, an optional `aside`, optional actions, optional back link to the parent collection.

`variant` is `surface` (the default — the white bordered card every collection and entity detail
opens with), `plain` (editors, where the form surface below is already the container) or `hero` (a
result-first screen, where the title is composed into the feature's own hero surface and brings only
the display type). See `v1-visual-parity.md` for what each one means.

`aside` is a page-level **fact** aligned right of the identity — a stock's quote, a run's progress.
It sits where actions sit but is something the page reports, not something the user can do; do not
put a control in it.

Use it on every route that has a title. Do not write a local `header`/`title`/`lead` trio, and do not
write a bespoke breadcrumb — `back` is the breadcrumb.

### `SectionCard`

The rounded white surface the product is composed from — the "card" of the FactorSage card feel.
Takes a title, an optional caption, an optional right-aligned `aside` (a count, a link), an optional
`toolbar` (filter pills), and the body.

It is **flat**: `--radius-lg`, a 1px border, `--shadow-surface` (`none`). Separation comes from the
border on a near-white canvas. `hero` opts into `--radius-hero` and `--shadow-hero` and is used by
exactly one screen, the backtest result; do not reach for it to make a section look important.

`flush` removes the body padding so a `DataTable` can run edge to edge; the table's own cells carry
the inset. Below 880px a `flush` surface **dissolves** — border, background and shadow go — because
`DataTable` already gives each record its own card there and the wrapper would draw a box around a
stack of boxes. The heading stays: it is the section's name, not the card's.

**Do not nest a `SectionCard` inside another.** One page-level surface per section is the whole
point; card-inside-card is the noise this replaced.

### `CollectionFooter` / `usePagination`

Page size, the visible range and page navigation, under every collection. Paging is applied in the
browser over rows the page already holds — every collection endpoint returns the caller's own records
in one response — so this is presentation, not a data-loading concern. If a collection ever outgrows
one response, `usePagination` is the seam to replace.

### `OverflowMenu`

The product's one maintenance-action menu: Rename, Edit, Enable/Disable, Delete. Every collection row
and every entity header uses it rather than exposing those as visible buttons, so one trigger glyph,
one hit area, one accessible-label pattern (`More actions for {name}`) and one alignment hold across
Lists, Strategies, Monitors and Backtests.

**A destructive action is never a visible peer to the record it destroys.** Red means a loss in a
financial product; spending it on a permanently visible button in every row both raises the accident
rate and drains the meaning from the negative numbers beside it. `actions.module.css` therefore has
no danger variant at all, and `forms.dangerButton` is reachable only from `ConfirmDialog`.

Give each row one visible contextual action — `Open`, `View results` — beside the trigger. A record
with no maintenance actions renders no trigger: `OverflowMenu` returns `null` for an empty list.

### `WorkflowFooter`

The one create/edit footer. Desktop and tablet: a quiet row at the bottom-right of the form surface,
in the order Cancel then primary. Phone: the same row becomes a sticky bar above the fixed bottom
navigation and the safe-area inset, so the action that commits a long form is never a scroll away.
Its optional `summary` describes the configuration about to be submitted.

### `DataTable`

The one way to render a collection. A dense table on desktop, one purpose-built card per row on a
phone — **from a single DOM tree**, not two copies behind media queries.

That single-tree property is load-bearing:

- a record is never rendered twice, so a row count is a row count and a screen reader reads each
  record once;
- `data-testid` on a row stays unique, which is why Playwright can count `tbody tr`.

Table roles are written explicitly (`role="table"`, `"rowgroup"`, `"row"`, `"columnheader"`,
`"cell"`) because the mobile card layout changes `display` away from the table values, which would
otherwise drop them from the accessibility tree. On mobile the header row is visually hidden but
kept in that tree, so every cell keeps its column name.

Each column declares a `cardRole` that says where its cell goes on a phone:

| `cardRole` | Desktop | Phone                                                    |
| ---------- | ------- | -------------------------------------------------------- |
| `identity` | cell    | the card's title, top-left                               |
| `status`   | cell    | top-right, beside the identity                           |
| `fact`     | cell    | a full-width `LABEL … value` row (the default)           |
| `links`    | cell    | a labelled relationship row in the card's "linked" block |
| `actions`  | cell    | a full-width action row under a divider                  |
| `hidden`   | cell    | omitted                                                  |

Card regions are ordered by role, not by declaration order, so a card's hierarchy cannot drift when
someone reorders columns. Three desktop columns — Strategy, Stock list, Benchmark — become the
legacy "LINKED" block on a card with no second component and no second markup.

Mark numeric columns `numeric` so digits align with tabular figures, and `align: "right"`.

**Column sizing.** Do not hand out a `width` to every column: the content area is capped at
`--content-max-width`, so fixed widths that sum past it starve the identity column until a name
wraps to three lines. Instead mark the short columns `nowrap` — timestamps, counts, money, badges —
so they size to their own content, and let the identity column absorb the remainder. A relationship
chip caps its own width and truncates, so one long name cannot widen a column. If a table still
exceeds the content width it scrolls inside its surface; the page body never scrolls sideways.

When a table needs one column too many, **fold a fact into the cell it belongs to** rather than
adding a column: the Monitors table carries the universe size beside the Stock List chip, and the
Backtests table carries the benchmark's return beside the Benchmark chip. That keeps the
information and the association, and costs no width.

A flush table's first and last columns align with the section heading through `--surface-inset`,
which `SectionCard` publishes and `DataTable` consumes. Do not re-pad a table to line it up.

**Do not** use `DataTable` for the properties of a single entity; that is `FactGrid`.

### `FactGrid`

A labelled set of read-only facts about **one** entity: a monitor's counts, a backtest's frozen run
parameters. Deliberately not a table — a table is for a collection.

### `StatusBadge` / `StatusTone`

One pill for every status in the product. The tones are `positive`, `negative`, `warning`,
`neutral`, `pending`, `active` and `blocked`.

`blocked` shares the warning palette but stays a separate **name**, because it is a separate product
fact — an entitlement is holding work back, not a data problem — and the two must be able to diverge
without a find-and-replace across features.

The feature supplies the label and the tone from its own canonical map. Never hard-code a colour for
a status in a feature stylesheet.

### `EntityReferenceChip` / `LinkedEntities`

How one entity refers to another. `EntityKind` is `monitor | strategy | list | backtest | benchmark |
stock`.

`href` is optional, and that is a product requirement rather than convenience: a Benchmark has no
page of its own, and a Backtest's snapshot can name a Strategy that has since been deleted
(`BacktestRunConfigurationResponse.strategyId` is `string | null`). Without an `href` the chip
renders as a static pill instead of a link that would 404 — it still says _what kind of thing_ this
is.

`LinkedEntities` is the "Linked" block for detail pages. Inside a `DataTable`, the same shape comes
from columns with `cardRole: "links"`, so a collection does not need it.

### `StockIdentity` / `StockLogo`

How a security is identified everywhere: mark, ticker, company name.

A logo is **decoration, never data**:

- the box is sized before anything loads, so a slow or broken logo cannot shift its row;
- a failed load falls back to the ticker monogram, never a broken-image glyph;
- the element is `aria-hidden` — the symbol and name sit beside it, and announcing the logo too
  would read every row twice;
- the monogram is rendered as CSS generated content from `data-monogram`, so it never joins the
  row's text layer, where it would be copied with a selection, matched by find-in-page, and
  prepended to every symbol.

`logoUrl` is optional and today only `StockDetailsResponse.profile` carries one. Everywhere else
renders the monogram. See "Known read-model gaps" below — the fix is one optional contract field,
not a provider URL assembled in a component. **Do not** construct a provider image URL in the web
app.

### `EmptyState`

Every "nothing here yet", "not found" and "could not be loaded" panel. `variant="error"` marks it as
an alert; `variant="compact"` is for an empty region inside a section that already has a heading.
`as="h1"` for a detail route whose entity is missing, so the page still has exactly one `<h1>`.

### `Skeleton` / `SkeletonList`

The one loading language. Always `aria-hidden`: a placeholder is not content.

### `actions.module.css`

Row-level actions — the quiet bordered buttons inside a table row, a card or a detail header —
imported as classes the way `forms.module.css` already is. It has **no danger variant**: see
`OverflowMenu`.

Page-level buttons stay in `forms.module.css`, and there are three:

| Class             | For                                                                          |
| ----------------- | ---------------------------------------------------------------------------- |
| `primaryButton`   | the action that commits work — `Run backtest`, `Save`, an empty state's CTA  |
| `tintedButton`    | `New …` and an entity's `Edit` — brand blue as ink on `--color-primary-soft` |
| `secondaryButton` | `Cancel` and other quiet page-level actions                                  |
| `dangerButton`    | **only** inside `ConfirmDialog`                                              |

One solid-blue action per page, and it is never a link to a form.

## Tokens

`apps/web/src/styles/tokens.css` is the only file in the web app that may hold a hex colour, a
radius, an elevation, a type size or a spacing constant. A feature stylesheet asks for a semantic
token — there are no raw hex values anywhere else in `apps/web/src`, and that is worth keeping true.

The system is deliberately small. It is grouped, and the groups are the whole vocabulary:

| Group           | Tokens                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Surfaces**    | `--color-background` `--color-surface` `--color-background-translucent` `--color-surface-muted` `--color-surface-soft` `--color-surface-selected`                                                                              |
| **Text**        | `--color-text-primary` `--color-text-body` `--color-text-secondary` `--color-text-muted` `--color-text-on-primary`                                                                                                             |
| **Borders**     | `--color-border` `--color-border-strong` `--color-border-subtle`                                                                                                                                                               |
| **Brand**       | `--color-primary` `--color-primary-hover` `--color-primary-ink` `--color-primary-soft` `--color-primary-soft-hover` `--color-primary-border`                                                                                   |
| **State**       | `--color-positive[-soft,-border]` `--color-negative[-soft,-hover]` `--color-warning[-soft]`                                                                                                                                    |
| **Interaction** | `--color-row-hover` `--focus-ring` `--focus-ring-inset`                                                                                                                                                                        |
| **Type**        | `--text-page-title` `--text-page-title-hero` `--text-section-title` `--text-body` `--text-secondary` `--text-small` `--text-label-size` `--text-label-tracking` `--weight-emphasis` `--line-height-body` `--line-height-tight` |
| **Geometry**    | `--radius-sm` `--radius-md` `--radius-lg` `--radius-hero` `--radius-pill`                                                                                                                                                      |
| **Elevation**   | `--shadow-surface` `--shadow-hero` `--shadow-menu` `--shadow-dialog`                                                                                                                                                           |
| **Spacing**     | `--page-pad-mobile` `--page-pad-tablet` `--page-pad-wide` `--section-gap` `--card-pad` `--surface-inset`                                                                                                                       |
| **Controls**    | `--control-height` `--control-height-compact` `--button-height` `--action-height`                                                                                                                                              |
| **Width**       | `--content-max-width` `--reading-max-width`                                                                                                                                                                                    |
| **Shell**       | `--topbar-height` `--topbar-height-wide` `--bottom-nav-height` `--safe-area-bottom`                                                                                                                                            |

Several are **responsive**: `--text-page-title`, `--text-page-title-hero`, `--section-gap`,
`--card-pad`, `--button-height` and `--action-height` all change at 880px, in one place, so a
component never writes its own media query for a size.

The four that carry the most meaning:

| Token                 | Why it exists                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--weight-emphasis`   | One emphasis weight (600). The product does not use 700 — V1 uses it 33 times in total, and reserving it stops a label competing with its own value. |
| `--shadow-surface`    | `none`. Ordinary surfaces are flat; a soft blue glow under every panel is what made the product read as a marketing page rather than a tool.         |
| `--radius-hero`       | The large radius, reserved for one screen. Paired with `--shadow-hero`, and only `<SectionCard hero>` may ask for either.                            |
| `--color-primary-ink` | Brand blue as **ink** on a tint — the FactorSage action treatment, and why `New …` is not a slab of saturated colour.                                |

Name a token for what it **means**, not for the feature that first needed it: `--color-positive`,
never `--monitor-green`. Before adding one, check whether an existing token already means it: the
system is meant to stay small enough to hold in your head.

## Breakpoints

The target breakpoints are:

- `600px` — tablet padding and fuller brand treatment
- `768px` — the collection table/card switch
- `1024px` — persistent topbar navigation replaces the fixed bottom navigation
- `1280px` — wide desktop padding

`DataTable` scopes its two layouts to explicitly non-overlapping `max-width: 767px` and
`min-width: 768px` blocks rather than layering them by specificity, so a per-role rule in one layout
can never leak into the other. Shell navigation intentionally uses a different switch because its
content constraint is different. See `v1-visual-parity.md`.

## Known read-model gaps

These are UI requirements the current contracts cannot satisfy truthfully. Each is a backend
addition, not something to work around in the browser.

1. **Dashboard aggregate matches.** The legacy dashboard led with "Real-time Matches": every stock
   currently matching, across every monitor, with its monitor, strategy and list beside it. V2 has
   no endpoint for it — `GET /monitors` carries per-monitor counts, and only `GET /monitors/{id}`
   carries evaluated securities. Fanning that out would cost one request per monitor and grow with
   the account, so the dashboard reports collection-level truth and links into each monitor.
   _Needed:_ something like `GET /monitors/signals?status=active`, returning active Signals across
   the caller's monitors with the security, level kind, signal kind, observation price and detected
   time, plus the monitor / strategy / list ids and names — one page, newest first.

2. **Stock logos outside Stock Details.** `StockListSecurityResponse` and
   `StockSearchResultResponse` are identity-only by explicit contract design, so list members,
   monitored stocks, signals, search results and backtest positions render the monogram.
   `SecurityProfile.logoUrl` is already persisted. _Needed:_ an optional `logoUrl?: string` on the
   lightweight security projection, joined in the three places that build it
   (`apps/api/src/lists/stock-lists.service.ts`, `apps/api/src/monitors/monitors.service.ts` ×2).
   Nothing in the UI changes — `StockIdentity` already takes the field.

3. **Clickable entities in the Backtests collection.** `BacktestRunSummaryResponse` carries
   `strategyName` and `stockListName` but no ids, so the collection's chips are static while the
   run's own page links them. _Needed:_ the nullable `strategyId` / `stockListId` the detail
   configuration already exposes.

4. **Reverse usage on Strategy and List.** "Which monitors and backtests use this?" has no
   contract. _Needed:_ a usage count or reference list on the Strategy and Stock List summaries. The
   API already refuses to delete a Strategy or List a Monitor references, so the relationship is
   known server-side; it is simply not projected.

5. **Benchmark quotes.** The legacy dashboard showed S&P 500 and DJIA quote cards. `GET /benchmarks`
   returns catalog metadata only, with no price or change, so those tiles are not built. _Needed:_ a
   latest-close projection on the benchmark catalog.

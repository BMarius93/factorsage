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
  WorkflowFooter         # Cancel + primary, for an ordinary create/edit route
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
one response, `usePagination` is the seam to replace. A new `resetKey` (a new query or order)
returns to the first page.

### `useCollection` — search and sort (UI-010, UI-011)

Client-side search and sort over the same in-memory rows, feeding `usePagination`, used by
`CollectionSection` (Lists, Strategies, Monitors), the Backtests history and a list's members. The
**search field appears from 10 records** (`COLLECTION_SEARCH_THRESHOLD`) and stays while a query is
active; the **Sort control** appears where the feature offers more than one order and there is more
than one record — built-in sections pass no orders, so a two-row section carries no chrome. The
Sort control is also the phone's only ordering control, since card layouts hide table headers. The
API's order is always the first ("Newest"), so the default never re-sorts what the server decided.
A query announces "N of M {noun} match “q”." through a `role="status"` region; filtered to nothing,
the section shows a compact `EmptyState` with **Clear search** instead of an unfiltered table. No
server pagination is introduced: endpoints still return the whole owned collection. A list's
members are searchable and sortable but stay one scroll, so a stock just added never lands on a
later page.

**One empty-collection composition (UI-012):** a titled `SectionCard` ("Your lists", "Your
backtests") holding a compact `EmptyState`; the page's create action stays in the `PageHeader`.
Every filtered-empty state offers the reset — Clear search on collections, Clear filters on the
Dashboard.

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
Name the visible action after its record (`aria-label="Open {name}"`), as the trigger already is:
"Open" read 158 times down a page tells a screen-reader user nothing (UI-050).

**Placement is collision-aware** (UI-006). The popup right-aligns under its trigger; where that
would cross the left edge it left-aligns, and where it would fall under the bottom edge or the phone
bottom navigation it opens upwards. `placeMenu` is the pure rule and is unit-tested. On a phone card
the trigger sits at the card's **top-right** (see `DataTable`), never beside the bottom action.

### `WorkflowFooter`

The **default** footer for an ordinary create/edit workflow. Desktop and tablet: a quiet row at the
bottom-right of the form surface, in the order Cancel then primary. Phone: the same row becomes a
sticky bar above the fixed bottom navigation and the safe-area inset, so the action that commits a
long form is never a scroll away. Its optional `summary` describes what is about to be submitted.

It models a workflow that ends in one decision: cancel, or commit. Reach for it whenever that is the
shape of the screen.

**It owns submit feedback** (UI-005). A refusal of the submit — a server validation, a plan limit —
goes in its `error` slot, not in a paragraph somewhere above it: on a phone that is the sticky bar
the user just tapped, so the answer is on screen without scrolling. The slot is an always-mounted
`aria-live="assertive"` region, so the message is announced, and on desktop the footer scrolls
itself into view when a message appears. Field-level validation stays beside each field; on a
failed client validation the form moves focus to the **first invalid field** in reading order,
never back to the submit button. What the user entered is kept either way.

**Strategy Builder is a deliberate exception, and is not to be "cleaned up" into this.** Its
persistent save bar is not a Cancel/Submit pair — it carries editor state this component does not
model and should not grow: live save status, dirty state, a count of validation issues that is also
the control for revealing and focusing the first invalid condition, and Discard changes alongside
Save. Folding that into `WorkflowFooter` would mean either a generic footer that knows what a
strategy issue is, or a strategy editor that has lost the affordance. Both are worse than one
justified local bar, so the exception stays until something else genuinely needs the same behaviour.

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

| `cardRole` | Desktop | Phone                                                      |
| ---------- | ------- | ---------------------------------------------------------- |
| `identity` | cell    | the card's title, top-left                                 |
| `status`   | cell    | top-right, beside the identity                             |
| `summary`  | cell    | shares one unlabelled line with the other `summary` cells  |
| `fact`     | cell    | a full-width `LABEL … value` row (the default)             |
| `links`    | cell    | a labelled relationship row in the card's "linked" block   |
| `actions`  | cell    | a full-width action row under a divider                    |
| `hidden`   | cell    | omitted                                                    |

**A card is not the desktop row with the columns turned sideways.** Every `fact` costs a label, a
value and a row, and a record with seven of them becomes a screenful: the Dashboard's match card
was 333px tall with `SINCE`, `WHY`, `PRICE`, `STRATEGY`, `LIST` and `MONITOR` each owning one. Two
things bring that back down without dropping anything. `summary` is for the short secondary facts
that say what they are — a relative time, a price: consecutive `summary` cells share one line, the
first at the leading edge and the rest at the trailing one, with no visible label. And `cardLabel:
null` drops the label from a cell whose value is already a sentence, such as a signal's "why". In
both cases the column header still labels the cell for assistive technology, because the header row
stays in the accessibility tree; only the visual label goes. The same card is now 248px.

The `OverflowMenu` in an `actions` cell is pinned to the card's top-right, in the same row as the
identity and status; the contextual action stays at the bottom. It is one DOM node positioned by
the stylesheet, so the tab order and the desktop cell are unchanged. A column marked `stacked`
(long prose — a signal's "why") puts its label above a left-aligned value instead of beside it.

Below 880px the cards form a **fluid grid**, `repeat(auto-fit, minmax(min(100%, 20rem), 1fr))`: one
card per row on a phone, two where the content area genuinely fits two readable cards (roughly
680–879px), never a single card stretched to 850px with its values far from their labels.

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

**Why the chip contains itself** (UI-001, UI-002). The chip is an `inline-grid` with one
`minmax(2.5rem, max-content)` track and an **absolute** `max-width: 12rem`. A percentage cap looks
equivalent but is cyclic while an auto-layout table computes its column widths and is ignored
there — which is how a visibly truncated chip once kept its 700px label width, widened the
Backtests table to 1,735px and pushed `View results` off-screen, and made the phone Dashboard
scroll sideways. No feature needs a wrapper rule for this any more.

**The identity column absorbs the remainder, but never its identifier** (UX-007). A column that
absorbs everything can be squeezed to nothing: at 1280 px the Dashboard's Stock column once
rendered "U." and "QATE…". Where a table is wide enough to squeeze its identity, give the identity
cell a floor that fits the whole identifier and let the relationship chips give way instead.
`DataTable` gives every `identity` column a `12rem` floor in the desktop layout (and lets a single
unbroken token wrap rather than widen the table); a column overrides it with `minWidth` — the
Dashboard's ticker column is `8.5rem`, the mark plus a full seven-character symbol. Width hints
travel as custom properties that only the desktop layout reads, so they never constrain a phone
card. **`minWidth` is a border-box floor**, so it has to cover the cell's own padding: the
Dashboard's ticker column was `7rem` while nothing else in the table had a floor, which left 44px
for a 53px symbol and only held because auto layout handed the column more than its floor. Give the
other columns floors and that stops being true, so a floor and the columns around it are one
decision, not several.
`e2e/dashboard/ticker-width.guest.spec.ts` asserts the full ticker, unclipped, at 880, 1024, 1280
and 1440 px with no document overflow.

**A name is a column's information, and may take two lines.** An `EntityReferenceChip` truncates
to one line by default, because most of them sit beside the content that matters. Where the name
*is* what distinguishes one row from another — the Dashboard's Strategy, List and Monitor columns,
which at eight columns rendered "Trend C…", "Recent M…" and "New Listin…" — the chip takes
`lines={2}`: same pill, wrapped to at most two lines and clipped after them, with the whole name in
`title` either way. Pair it with a `minWidth` on the columns concerned so the wrap has somewhere to
happen — and size that floor against the **narrowest** width at which every column is shown, with
the widest content the product can produce. The Dashboard's `9.5rem` is what is left at 1,280px once
the ticker, a `Waiting for trigger` badge, a relative time, the reason and a price have taken what
they need; asking for more does not widen the column, it scrolls the table sideways inside its
surface, which is worse than a name wrapping.

**Fold before scrolling.** In the intermediate desktop band (880–1,279px) a wide table has more
columns than room. A column marked `foldIntermediate` steps out there, and the feature renders the
same facts inside a cell that stays, wrapped in `IntermediateOnly` (displayed only in that band, so
a fact is never exposed twice): the Dashboard folds Strategy · List · Monitor under the stock, the
Monitors collection folds Strategy and Stock list under the monitor's name, and Backtests folds the
Benchmark under the Stock list and drops the low-priority Queued column. Every collection then fits
its surface at 880, 1,024, 1,280 and 1,440px with its actions visible.

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

`pulse` adds a small breathing dot before the label, and it means exactly one thing: **this job is
still alive**. It is for work genuinely in flight — a queued or running backtest, on its own page
and in the collection alike — and never for a finished one, because animating a result implies work
that is not happening. It says nothing about progress; a percentage is a different affordance. The
dot is `aria-hidden`, so the label still carries the whole meaning, it is a slow opacity-and-scale
breath rather than a blink, and under `prefers-reduced-motion: reduce` it stays visible and stops
moving. Tests assert the `data-activity="pulse"` hook, never an animation frame.

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

How a security is identified everywhere: mark, ticker, company name. It is the **only** rendering
path for a stock logo in the product — search rows, the list picker, list members, monitored
securities, signals, backtest holdings and trades, and the Stock Details header all go through it,
and no feature owns an `<img>` of its own.

A logo is **decoration, never data**:

- the box is sized before anything loads, so a slow or broken logo cannot shift its row. Both
  dimensions live on the container at every size and the image fills it, so nothing in the layout
  depends on an asset that has not arrived;
- a failed load falls back to the ticker monogram, never a broken-image glyph;
- `object-fit: contain`, never `cover` — a wordmark cropped to fill a square has lost its word;
- the element is `aria-hidden` — the symbol and name sit beside it, and announcing the logo too
  would read every row twice;
- the monogram is rendered as CSS generated content from `data-monogram`, so it never joins the
  row's text layer, where it would be copied with a selection, matched by find-in-page, and
  prepended to every symbol.

**Sizes are contextual, not uniform.** `sm` is 28px for a compact dropdown or trade row, `md` is
32px for a collection row, and `lg` is the one page-level identity — 48px, 56px from 880px up.

**Near-white marks get a plate.** A great many logos are drawn for a dark header and are close
enough to white to vanish on `--color-surface`. `StockLogo` samples the loaded image on a canvas
(`logo-brightness.ts`), averages the perceived brightness of its opaque pixels, and sets
`data-bright` so the box switches to `--color-surface-contrast`. It fails closed: no canvas, a
tainted canvas or an unreadable sample all leave the mark on the ordinary surface.

#### Where a mark comes from

One rule, and it is the reason logos do not visibly reload as the user moves through the product:

```text
SecurityProfile.logoUrl  ->  contract projection  ->  StockLogo  ->  /api/logo/{TICKER}  ->  provider
        (persisted)            (logoUrl?: string)     (stockLogoSrc)     (proxy + cache)
```

`apps/web/src/lib/stock-logo.ts` is the one abstraction. It turns a security into the product's own
`/api/logo/{ticker}` URL, and `apps/web/src/app/api/logo/[symbol]/route.ts` is the **only** file in
the web application that knows a provider image URL. That single indirection buys four things:

- **One cache entry per security.** The URL is derived from the ticker alone, so the mark a search
  row loaded is the same HTTP cache entry the list row and the Stock Details header ask for. The
  route answers `public, max-age=86400, stale-while-revalidate=604800`, so navigation re-reads
  them from cache instead of re-fetching a logo per screen.
- **Same-origin pixels**, without which the brightness sample above is refused as a tainted canvas.
- **No provider URL anywhere under `features/` or `components/`.**
- **A mark for securities the catalog has not profiled.** `SecurityProfile` rows exist only for
  securities something has hydrated, which is a small fraction of the catalog, so gating the image
  on `logoUrl` would leave most rows showing initials. The endpoint is keyed by the ticker instead,
  and a symbol with no mark upstream falls back to the monogram after one 404 that is itself cached
  for an hour.

`logoUrl` is still projected and still load-bearing: it is the product's own record of the mark, it
is what a future non-FMP provider would flow through, and it is the image used directly for the one
case the endpoint cannot serve — a ticker outside the safe-symbol pattern.

The route validates the ticker against the same pattern the browser does, times the upstream out,
refuses to pass a non-image `200` through as a logo, and never caches a `502`: a provider outage
says nothing about the security.

**A missing mark is `204 No Content`, not `404`** (UX-005). Most of the catalog has no upstream
mark, and Chromium logs every `4xx` image as "Failed to load resource" — once per logo-less row,
and again for each cached copy — which buried real errors and tripped the E2E console assertion.
`204` is a success status, so the browser records no failed resource and no console error, yet an
`<img>` cannot decode an empty body: it fires `error` and settles `complete` with `naturalWidth ===
0`. `StockLogo` treats both as missing — `onError`, and the same condition checked at mount for a
miss that settled from the HTTP cache before hydration — and shows the monogram. The miss keeps the
one-hour `MISSING_CACHE_CONTROL` and SEC-002's image policy (`Content-Security-Policy`, `nosniff`);
a real provider failure stays `502 no-store`. Verified in Chromium for the PR: a `404` image logged
a console error on first load and on reload, a `204` logged nothing, fired `onerror`, and was served
from cache on reload.

**Backtest results are deliberately not part of the contract half.** `BacktestTradeResponse` and
`BacktestHoldingResponse` carry denormalized `symbol`/`name` frozen at execution precisely so a
completed run never joins the mutable catalog, and a decoration is not a reason to change that.
They render their marks from the ticker like every other row.

### `EmptyState`

Every "nothing here yet", "not found" and "could not be loaded" panel. `variant="error"` marks it as
an alert; `variant="compact"` is for an empty region inside a section that already has a heading.
`as="h1"` for a detail route whose entity is missing, so the page still has exactly one `<h1>`.

It is also what the application's failure pages are made of (UX-006): `app/not-found.tsx` (any
unmatched URL — standalone and branded, because the product shell belongs to the `(app)` layout an
unmatched URL never reaches) and `app/(app)/error.tsx` (a render error inside a product page, shown
in the shell so navigation keeps working, with a "Try again" that calls `reset()`).
`app/global-error.tsx` is the last resort for a root-layout failure: it owns its `<html>`/`<body>`
and depends on nothing but the token stylesheet. None of the three renders an error's message,
digest or stack; the error is logged to the browser console only.

**Page states (UI-027…UI-029, UI-057).**

- **Loading an entity page:** `DetailSkeleton` — the real `PageHeader` frame with its back link, a
  placeholder title and actions, and a section of rows, so nothing jumps when the entity lands. The
  page keeps exactly one `h1` ("Loading list…", for assistive technology) and reports `aria-busy`.
- **Not found:** one pattern for every owned entity — "{Thing} not found", "It may have been deleted,
  or it belongs to another account.", and "Back to {Collection}". Another account's object and a
  deleted one are deliberately indistinguishable: no access-control detail is leaked.
- **Load failures:** "{Thing} could not be loaded", with "Try again" (secondary) always present.
- **Session gates** (`RequireAuth`) render inside `PageContainer` as `EmptyState`s, never bespoke
  markup against the viewport edge. A failed session check is worded by cause — the API answered
  with a failure ("usually temporary") versus no answer at all ("check your connection") — and
  offers Try again beside Return to sign in. A missing role reads "This page is not available to
  your account", with a way back.

### `Notice`

One inline message about the state of what the user is looking at — `info`, `warning`, `success`
or `error` — with an optional title and at most one or two next steps (cleanup plan §3.7). It is
not an empty state (`EmptyState` owns nothing / not found / could not be loaded) and not a field
error. `announce="alert"` is for an operational failure the user must not miss, such as a failed
backtest; a static notice announces nothing. Tone is a left rule and a tint, and the words always
say what happened, so colour is never the only signal.

### `LimitMeter` / `EntitlementNotice`

`LimitMeter` is "N of LIMIT" for a quantity the plan caps, shown wherever that quantity is edited;
the words carry the state ("· at your plan's limit", "· 1 over your plan's limit") and the bar only
echoes them. `EntitlementNotice` is a plan refusal or a plan-imposed pause told with a way forward:
the API's own sentence, an optional recovery that fits the case, and "See plans". Neither holds a
number of its own — the feature passes usage it already has and limits from `useEntitlements()`
or a server-derived `compliance` (see `ai/architecture/entitlements.md`).

### `SegmentedControl`

One row of mutually exclusive view choices — `aria-pressed` toggle buttons in a labelled group,
each showing the count it would reveal. The chosen option is tinted (`--color-surface-selected`,
primary ink), never a solid slab: a page keeps one solid-blue commit action. The Dashboard's state
filter and the Monitor page's status filter use it (UI-009 … UI-012 build on the same control).

### `Select` / `SelectControl` / `EntitySelect`

`Select` is the product's one native select; nothing renders a bare `<select>`. It owns three
densities from the control scale — `default` (`--control-height`, 44 px: forms and dialogs),
`compact` (`--control-height-compact`, 38 px: Strategy Builder predicate rows) and `toolbar`
(`--action-height`: beside row actions and segmented filters) — the chevron, focus, the invalid
border and the **stale-value rule**: a value that is not among the options renders as an explicit
"Unavailable …" option instead of the browser silently showing the placeholder while state still
holds the old id. `SelectControl` is `Select` at toolbar density with its label beside it.

`EntitySelect` chooses a Strategy or a Stock List the same way on every surface: the caller's own
content first, then built-ins, in groups named like the collection pages' two sections ("Your
strategies" / "Built-in strategies"), ungrouped when only one kind exists; disabled with "Loading …"
in place while options load; and "Unavailable strategy (deleted or not yours)" for a stale id. A
surface that cannot use built-ins passes only the caller's own items **and says so** beside the
control — a user's monitor shows "Monitors watch your own strategies and lists. Built-in ones can be
backtested, but not monitored." — rather than pretending built-ins do not exist. "Create a stock
list" links go to `/lists?new=1`, which opens the create dialog.

### Stock search — `useSecurityCombobox` / `SecurityListbox`

One stock-search behaviour for the topbar (`StockSearch`, `single` mode) and the list picker
(`SecurityMultiSelect`, `multi` mode). The hook owns the debounced catalog search, what a blank
field offers ("Recently Viewed" stocks — named for what they are, since viewing a stock from anywhere
records it; `single` mode adds "Popular Stocks", static shortcuts with no catalog
row and so cannot become list members), arrow-key wrap, Enter (highlighted option, else the first;
never free text), Escape (closes an open list without closing the surrounding dialog; a closed list
lets Escape through), Backspace on an empty field, blur-to-close, and the status line. Throttling
follows `lib/api/rate-limit-errors.ts`: a `429` names the wait from `Retry-After`, no "Try again"
is offered inside it, a new query inside it says how long is left without sending a request, and
the retry returns when the wait is over. `SecurityListbox` renders the one labelled listbox with a
documented `aria-selected` meaning per mode:

| Mode     | `aria-selected` means | Listbox                          | Highlight carried by    |
| -------- | --------------------- | -------------------------------- | ----------------------- |
| `single` | highlighted           | labelled                         | `aria-activedescendant` |
| `multi`  | chosen                | labelled, `aria-multiselectable` | `aria-activedescendant` |

### Dates and relative time — `lib/dates.ts`, `lib/use-now.ts`

Every rendered date goes through `lib/dates.ts` in one product locale (UI-049): `formatDay` for a
calendar day (`"2026-08-28"`, in UTC so no timezone moves it), `formatDate` / `formatDateTime`
for an instant, `formatRelative` for "12 min ago". A relative label reads the page clock from
`useNow()`, so it keeps ticking while the page is open (UI-048), and the absolute value is always
in text a keyboard or screen-reader user can reach — never only a tooltip. Feature formatters
(`formatListDate`, `formatDay`, `formatMonitorTimestamp`, …) delegate here; do not add another
`Intl.DateTimeFormat`. Native date **inputs** keep the platform's own locale on purpose.

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

**Button order by context (UI-056).** Order is fixed per context, not per screen:

| Context                                                            | Order (desktop, left → right)                                              | Phone                                      |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------ |
| Dialogs, prompts, form footers (`forms.actions`, `WorkflowFooter`) | quiet/Cancel, then the primary                                             | stacked, primary on top (`column-reverse`) |
| Entity headers (`PageHeader` actions)                              | secondary (Run backtest, Add to list), then tinted Edit, then the overflow | wraps in the same order                    |
| Error and not-found panels (`EmptyState`)                          | the way out (Back to …), then **Try again**                                | stacked in the same order                  |

"Try again" is always `secondaryButton`: it is a recovery, not a commit, so it never takes the
page's one solid-blue slot — on pages, in dialogs and in `error.tsx`/`global-error.tsx` alike.

## Shell and metadata (UI-051…UI-055)

- **Account menu** is a disclosure, modelled as one: the trigger carries `aria-expanded` and
  `aria-controls`, and the panel is a labelled `group` of ordinary links and buttons that Tab walks
  through. There is no `role="menu"`, because the panel has no arrow-key model. Escape closes it and
  returns focus to the trigger, and so does an outside press or tabbing past the last item.
- **Navigation guard.** Every shell link — primary navigation, brand, `PageHeader` back links,
  account-menu links, Sign in and Pricing — passes through `guardNavigation`, and Sign out calls
  `canNavigate()` first, so a page with unsaved work (the Strategy Builder) is asked before any of
  them leave it. Browser Back and reload keep the documented limits of `unsaved-changes.ts`.
- **The Dashboard is the product's home, at `/`.** `app/(app)/page.tsx` renders it; `/dashboard`,
  the address it used to answer at, is a 307 to `/` declared in `lib/route-redirects.ts` and applied
  by `next.config.ts`, so an old link keeps working without ever putting the old address in the
  browser. `APP_HOME_HREF`, the bottom bar's Dashboard item and `DEFAULT_RETURN_PATH` on both sides
  of the sign-in boundary all resolve to `/`.
- **Active item.** The brand link carries `aria-current="page"` on the Dashboard, which has no nav
  item of its own. Routes that are not navigation items (Stock Details, Billing) claim no active
  item rather than a false one.
- **`/stocks`** redirects to the Dashboard: a stock is reached through search or a record, and a
  research landing is a separate product decision.
- **Tab titles** are `{Page} · FactorSage` on every route (Dashboard, collections, New …, Billing,
  Pricing, Admin, auth, not-found; the `|` separator is gone). Entity pages start from the route's
  generic title and switch to the entity's own name once it loads (`useDocumentTitle`): "Blue chips
  · FactorSage", "Value ladder backtest · FactorSage".
- **Hydration.** The topbar search, a singleton, uses a fixed id base (`topbar-stock-search`) rather
  than `useId`, so its `aria-controls` can never hydrate differently. A Guest's `401` from
  `/auth/me` is the expected session probe, not an error.
- **Admin** is built from `PageHeader`, `SectionCard`, `FactGrid` and `DataTable`, and says that
  changes apply to everyone. Every built-in page an administrator can edit shows a
  `BuiltInEditNotice` saying the same.

## Tokens

`apps/web/src/styles/tokens.css` holds the product's **shared visual language**, so a screen cannot
quietly invent a second version of one of its constants.

The rule is a distinction, not a ban on numbers:

**Must be a token.** These make up the design language, and a feature stylesheet asks for them by
name rather than restating their values:

- every semantic colour — brand, text, border, surface, and the financial/operational states;
- the radius scale (`--radius-sm|md|lg|hero|pill`) and the elevation scale
  (`--shadow-surface|hero|menu|dialog`);
- the type scale and `--weight-emphasis`;
- the standard control sizes — `--control-height`, `--button-height`, `--action-height`;
- the page spacing and width system — `--page-pad-*`, `--section-gap`, `--card-pad`,
  `--surface-inset`, `--content-max-width`, `--reading-max-width`.

**May stay local.** Geometry that belongs to one component's own implementation rather than to the
product: the gap between its parts, a grid template, a chart's fixed height, a transform, a
truncation width, the radius of a small ornament it draws — a legend swatch, a logo mark, a close
button. These are not design language, and pushing them through tokens would grow the file without
making anything more consistent.

**Never.** Redefining a shared constant locally: a second brand blue, a second card radius, a second
button height, a second page gap, a second section-heading size. That is the drift this file exists
to prevent — and it is what to look for in review, rather than the presence of a number.

One part of the rule is absolute and currently holds: **a hex colour lives only in `tokens.css`.**
There are none anywhere else in `apps/web/src`, and that is worth keeping true.

The system is deliberately small. It is grouped, and the groups are the whole vocabulary:

| Group           | Tokens                                                                                                                                                                                                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Surfaces**    | `--color-background` `--color-surface` `--color-background-translucent` `--color-surface-muted` `--color-surface-soft` `--color-surface-selected` `--color-surface-contrast`                                                   |
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

**880px is the canonical dense/compact switch** (UI-004). It is what the code has always shipped,
and one switch drives everything that changes between the two modes: the topbar navigation and the
phone bottom navigation, the table/card switch in `DataTable`, the dissolving flush `SectionCard`,
`WorkflowFooter`'s sticky bar and the responsive tokens in `tokens.css`. The earlier documented
`768px`/`1024px` pair never existed in CSS and is withdrawn.

- `600px` — tablet padding and the fuller brand treatment
- `880px` — dense desktop ↔ compact phone/tablet, as above
- `880–1,279px` — the intermediate desktop band, where wide tables fold (`foldIntermediate`)
- `1280px` — wide desktop padding

Below 880px the compact layout is not one stretched column: `DataTable` cards form a fluid
one/two-column grid (see `DataTable`), so there is no second hard breakpoint for tablets.

`DataTable` scopes its two layouts to explicitly non-overlapping `max-width: 879px` and
`min-width: 880px` blocks rather than layering them by specificity, so a per-role rule in one layout
can never leak into the other. A component-local breakpoint is allowed only where it is about that
component's own content, not the page's mode, and every one is listed here (UI-004):

| Width | Where                                             | Why it is not 600/880/1280                                                                      |
| ----- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 380px | Topbar search (`AppTopbar`, `StockSearch`)        | below it the field cannot sit beside the brand and account; it collapses to an icon             |
| 960px | Strategy Builder side column (`ExplanationPanel`) | the editor rows need ~560px beside a 360px logic column; at 880 they would wrap every predicate |

Everything else uses the shared set: auth and Admin phone padding at `max-width: 599px`, the Builder's
two-up predicate fields at 600px, and the plan cards three abreast at 880px. See
`v1-visual-parity.md`.

## Known read-model gaps

These are UI requirements the current contracts cannot satisfy truthfully. Each is a backend
addition, not something to work around in the browser.

1. ~~**Dashboard aggregate matches.**~~ Closed by `GET /dashboard`
   (`docs/decisions/builtin-dashboard-signals-v1.md`), which returns every current `ACTIVE` and
   `PENDING_TRIGGER` row of the monitors the viewer can see, with security, level, reason, monitor,
   strategy, list, price and freshness, in one request.

2. ~~**Clickable entities in the Backtests collection.**~~ Closed (UI-034):
   `BacktestRunSummaryResponse` now carries the run's nullable `strategyId` / `stockListId`, the
   same foreign keys its configuration reports, so a chip links while the entity exists and stays
   a static pill after it is deleted. Names still come from the immutable snapshot.

3. **Reverse usage on Strategy and List.** "Which monitors and backtests use this?" has no
   contract. _Needed:_ a usage count or reference list on the Strategy and Stock List summaries. The
   API already refuses to delete a Strategy or List a Monitor references, so the relationship is
   known server-side; it is simply not projected.

4. **Benchmark quotes.** The legacy dashboard showed S&P 500 and DJIA quote cards. `GET /benchmarks`
   returns catalog metadata only, with no price or change, so those tiles are not built. _Needed:_ a
   latest-close projection on the benchmark catalog.

5. **Why a stock is "Not evaluable".** The Monitor page explains what the state means in words
   (UI-026), but the specific cause for one security — warm-up, missing history, no quote — is
   recorded only as the outcome `NOT_EVALUABLE` (`MonitorSignalState.lastOutcome`). _Needed:_ an
   evaluation-reason code persisted with the outcome and projected on
   `MonitorSecurityEvaluationResponse`.

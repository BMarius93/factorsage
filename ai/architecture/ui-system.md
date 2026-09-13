# UI System

The shared UI vocabulary of the FactorSage web application: what the reusable components are, what
each one represents, and when **not** to reach for one.

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
PageContainer            # width + progressive padding (components/layout)
  PageHeader             # the one <h1>, its lead, badges, actions, back link
  SectionCard            # a large rounded surface per section
    DataTable            # a collection inside it
    FactGrid             # the properties of one entity
    EmptyState           # nothing / not found / could not be loaded
```

A route's own `.page` class composes `stack` from `components/ui/page.module.css`, which is the one
definition of the vertical rhythm between sections. Do not set a page gap or a page top padding in a
feature stylesheet.

## The components

### `PageHeader`

The product's only page-title treatment: `<h1>`, optional lead sentence, optional status badges
beside the title, optional actions, optional back link to the parent collection.

Use it on every route that has a title. Do not write a local `header`/`title`/`lead` trio, and do not
write a bespoke breadcrumb — `back` is the breadcrumb.

### `SectionCard`

The large rounded white surface the product is composed from — the "card" of the FactorSage card
feel. Takes a title, an optional caption, an optional right-aligned `aside` (a count, a link), an
optional `toolbar` (filter pills), and the body.

`flush` removes the body padding so a `DataTable` can run edge to edge; the table's own cells carry
the inset.

**Do not nest a `SectionCard` inside another.** One page-level surface per section is the whole
point; card-inside-card is the noise this replaced.

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

| `cardRole`  | Desktop | Phone                                                   |
| ----------- | ------- | ------------------------------------------------------- |
| `identity`  | cell    | the card's title, top-left                               |
| `status`    | cell    | top-right, beside the identity                           |
| `fact`      | cell    | a full-width `LABEL … value` row (the default)           |
| `links`     | cell    | a labelled relationship row in the card's "linked" block |
| `actions`   | cell    | a full-width action row under a divider                  |
| `hidden`    | cell    | omitted                                                  |

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
renders as a static pill instead of a link that would 404 — it still says *what kind of thing* this
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
imported as classes the way `forms.module.css` already is. Page-level primary/secondary/danger
buttons stay in `forms.module.css`.

## Tokens

`apps/web/src/styles/tokens.css` is the only file in the web app that may hold a hex colour. A
feature stylesheet that needs a colour asks for a semantic token.

Tokens this pass added, and what each is for:

| Token                    | Purpose                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `--color-border-subtle`  | row dividers inside a surface, lighter than its own border   |
| `--color-row-hover`      | table row / option / menu-item hover                         |
| `--color-primary-border` | the resting border of a relationship chip                    |
| `--color-positive-border`| the resting border of a Stock List reference                 |
| `--focus-ring`           | one focus-visible ring for every interactive element         |
| `--radius-pill`          | badges, chips, filter pills                                  |
| `--radius-chip`          | logo marks and small nested surfaces                         |
| `--text-label-size`      | table headers, fact labels, section eyebrows                 |
| `--text-label-tracking`  | the tracking that goes with them                             |

Name a token for what it **means**, not for the feature that first needed it: `--color-positive`,
never `--monitor-green`.

## Breakpoints

The shell's breakpoints, reused everywhere unless content genuinely demands otherwise:

- `600px` — tablet padding, fuller brand treatment
- `880px` — **the table/card switch**, persistent topbar navigation, desktop padding
- `1280px` — wide desktop padding

`DataTable` scopes its two layouts to explicitly non-overlapping `max-width: 879px` and
`min-width: 880px` blocks rather than layering them by specificity, so a per-role rule in one layout
can never leak into the other. Keep it that way.

## Known read-model gaps

These are UI requirements the current contracts cannot satisfy truthfully. Each is a backend
addition, not something to work around in the browser.

1. **Dashboard aggregate matches.** The legacy dashboard led with "Real-time Matches": every stock
   currently matching, across every monitor, with its monitor, strategy and list beside it. V2 has
   no endpoint for it — `GET /monitors` carries per-monitor counts, and only `GET /monitors/{id}`
   carries evaluated securities. Fanning that out would cost one request per monitor and grow with
   the account, so the dashboard reports collection-level truth and links into each monitor.
   *Needed:* something like `GET /monitors/signals?status=active`, returning active Signals across
   the caller's monitors with the security, level kind, signal kind, observation price and detected
   time, plus the monitor / strategy / list ids and names — one page, newest first.

2. **Stock logos outside Stock Details.** `StockListSecurityResponse` and
   `StockSearchResultResponse` are identity-only by explicit contract design, so list members,
   monitored stocks, signals, search results and backtest positions render the monogram.
   `SecurityProfile.logoUrl` is already persisted. *Needed:* an optional `logoUrl?: string` on the
   lightweight security projection, joined in the three places that build it
   (`apps/api/src/lists/stock-lists.service.ts`, `apps/api/src/monitors/monitors.service.ts` ×2).
   Nothing in the UI changes — `StockIdentity` already takes the field.

3. **Clickable entities in the Backtests collection.** `BacktestRunSummaryResponse` carries
   `strategyName` and `stockListName` but no ids, so the collection's chips are static while the
   run's own page links them. *Needed:* the nullable `strategyId` / `stockListId` the detail
   configuration already exposes.

4. **Reverse usage on Strategy and List.** "Which monitors and backtests use this?" has no
   contract. *Needed:* a usage count or reference list on the Strategy and Stock List summaries. The
   API already refuses to delete a Strategy or List a Monitor references, so the relationship is
   known server-side; it is simply not projected.

5. **Benchmark quotes.** The legacy dashboard showed S&P 500 and DJIA quote cards. `GET /benchmarks`
   returns catalog metadata only, with no price or change, so those tiles are not built. *Needed:* a
   latest-close projection on the benchmark catalog.

# FactorSage design system

How the FactorSage web app looks and behaves, and the rules a UI change must keep. This file
documents what is **implemented**; it is not a redesign brief.

- The executable source of truth is `apps/web/src/styles/tokens.css` (every shared colour, size,
  radius, shadow and spacing value) and the components in `apps/web/src/components/ui/`.
- This file says how to use them. When it and the code disagree, the code is right and this file is
  the thing to fix.
- Deeper references: `ai/architecture/frontend.md` (visual direction, responsive contract, charts),
  `ai/architecture/ui-system.md` (the component inventory, one entry per component) and
  `ai/architecture/v1-visual-parity.md` (page anatomy and its acceptance checklist). Those documents
  own their topics; this one is the map and the short version.

## 1. Character

A calm, light, research-grade financial tool — not a trading terminal and not a marketing page.

- Near-white canvas (`--color-background` #fcfcfc), white surfaces, a hairline cool border, **no
  shadow on ordinary surfaces** (`--shadow-surface: none`). Elevation exists only for real overlays
  (menus, dialogs) and the one result hero.
- One restrained blue accent, used as **ink** (words, outlines, tinted buttons) far more often than
  as a fill. Each page has at most one solid-blue commit action.
- Green, red and orange mean financial or operational state — gain, loss, warning, buy, sell, final
  exit — and are never decoration.
- Information-dense but legible: compact rows on desktop, one purpose-built card per record on a
  phone, the same DOM for both.
- Geist (sans) and Geist Mono; no second display face.

## 2. Colour

### Tokens

| Role                | Tokens                                                                                                                                                                     | Use                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Canvas and surfaces | `--color-background`, `--color-surface`, `--color-surface-soft`, `--color-surface-muted`, `--color-surface-selected`                                                       | page, cards, nested wells, the selected tint                     |
| Text                | `--color-text-primary` (#222), `--color-text-body` (#404040), `--color-text-secondary` (#5e677b), `--color-text-muted` (#696e79), `--color-text-on-primary` (white)        | titles and values; prose; labels, captions; least important text |
| Borders             | `--color-border`, `--color-border-strong`, `--color-border-subtle`                                                                                                         | surfaces; control wells; row dividers                            |
| Brand               | `--color-primary` (#4882ff), `--color-primary-solid` (#2f6fe8), `--color-primary-hover`, `--color-primary-ink` (#3b5ccc), `--color-primary-soft`, `--color-primary-border` | see "Fill and ink"                                               |
| State               | `--color-positive` / `-ink` / `-soft` / `-border`, `--color-negative` / `-ink` / `-soft` / `-hover`, `--color-warning` / `-ink` / `-soft`                                  | gains, losses, warnings, buy/sell/final exit                     |
| Interaction         | `--color-row-hover`, `--color-focus`, `--focus-ring`, `--focus-ring-inset`                                                                                                 | hover rows, keyboard focus                                       |

A hex value lives only in `tokens.css`. The one exception is a canvas chart palette
(`features/stocks/details/utils/chart-theme.ts`, `features/backtests/utils/chart-theme.ts`):
Lightweight Charts cannot read CSS variables, so those files mirror token values and say which.

### Fill and ink

Every colour used as **text** meets WCAG 2.2 AA — at least 4.5:1 — on every product surface,
including `--color-surface-selected` (#eef3ff).

- The brand blue and the three state colours are **fills**: chart strokes, sparklines, meters,
  rules, borders, badge dots, the active-navigation underline. As graphics they need 3:1, and their
  values are the product's identity. Do not darken them.
- The same meanings as **words or figures** use the ink: `--color-primary-ink`,
  `--color-positive-ink`, `--color-negative-ink`, `--color-warning-ink`. Each keeps its hue and
  reaches 4.6:1 or better on white and on its own soft tint.
- A fill that carries white text — the primary button, a selected Builder segment, a count badge —
  uses `--color-primary-solid` (4.6:1 with white), with `--color-primary-hover` as its hover.
- Secondary text stays darker than muted text, so the hierarchy survives the contrast floor.

`color: var(--color-positive)` (or `-negative`, `-warning`, `--color-primary`) in a stylesheet is a
contrast bug. Write the `-ink` token.

### Contrast checks

When a token changes, check every pair it is used in: text on `--color-surface`,
`--color-background`, `--color-surface-soft`, `--color-surface-selected` and its own soft tint.
axe-core's `color-contrast` rule over the main pages is the regression check; disabled controls are
exempt by WCAG and are not "fixed" by darkening them.

## 3. Typography and hierarchy

- Scale (from `tokens.css`): page title `--text-page-title` (17px, 20px from 880px); hero title
  `--text-page-title-hero` (24/28px, backtest result only); section title `--text-section-title`
  (17px); body `--text-body` (14px); secondary `--text-secondary` (13px); small `--text-small`
  (12px); label `--text-label-size` (11px, uppercase, `--text-label-tracking`).
- **One emphasis weight**, `--weight-emphasis` (600). The product does not use 700.
- One visible page title and exactly one `<h1>` per page (`PageHeader`); sections are `<h2>`
  (`SectionCard`).
- Uppercase labels use the label size and tracking tokens together.
- Numbers that line up — table cells, KPIs, facts, prices — use tabular figures
  (`font-variant-numeric: tabular-nums`).

## 4. Spacing, width and density

- Page padding steps 16 → 32 → 40px (`--page-pad-mobile|tablet|wide`) at 600 and 1280px; sections
  are `--section-gap` apart (24px, 32px from 880px); a surface pads `--card-pad` (12px, 24px from
  880px).
- `PageContainer width="data"` (to 1600px) for collections, details, charts and results;
  `width="reading"` (820px) for forms and prose. A route never sets its own max-width.
- A route's `.page` composes `stack` from `components/ui/page.module.css`; do not set a page gap or
  top padding in a feature stylesheet.
- Desktop rows are compact (`--action-height` 32px controls); touch sizes apply to touch layouts,
  not as desktop whitespace.

## 5. Responsive conventions

- **880px is the one dense/compact switch**: the topbar navigation replaces the phone's bottom
  navigation, and `DataTable` turns its cards into a table. 600px brings tablet padding and the
  fuller brand; 1280px wide padding. 880–1,279px is the intermediate band where wide tables fold
  secondary columns (`foldIntermediate`) into a cell they belong to.
- Component-local breakpoints are allowed only for a component's own content and are listed in
  `ui-system.md` (Breakpoints).
- Below 880px a collection is one card per record, same DOM as the table. A feature may arrange its
  own card from the cells' `data-column` attribute (the Dashboard activity card does), but must
  never let the record's identity — a ticker, a name — be what truncates first.
- No page scrolls horizontally at 360–1920px. Fixed bars respect `env(safe-area-inset-bottom)`.
- Acceptance captures each changed surface at 390, 768, 1024, 1280/1440 and 1920px, with long names
  and long badges as the stress case.

## 6. Controls

- **Buttons** (`components/ui/forms.module.css`): `primaryButton` (solid, one per page),
  `secondaryButton`, `tintedButton` (primary ink on the soft tint — the FactorSage action treatment,
  e.g. "New list"), `dangerButton` (only inside `ConfirmDialog`). Row actions use
  `actions.module.css`; maintenance actions live in `OverflowMenu`.
- **Inputs**: the shared `forms.input`; `Select` is the only native select (three densities);
  `EntitySelect` for strategies and lists; `MoneyInput` for US-dollar amounts (a `$` inside the field,
  thousands grouped as it is read and typed with the caret kept on its digit, the raw number in form
  state); `SegmentedControl` for a short set of mutually exclusive choices, its selected option
  tinted, never a solid slab.
- **Validation**: client validation runs on submit, focuses the first invalid field, and every
  field names its error (or hint) with `aria-describedby`. Errors are text next to the field, not a
  stack of alerts. A primary action stays enabled and validates on press (New backtest); the
  Strategy Builder disables Save but its issue counter is a button that focuses the field to fix.
- **Dialogs**: only `Modal`. It opens on its first field (or the element marked `data-autofocus`, or
  the first action — Cancel for a confirmation), never on the close button, and returns focus to
  the control that opened it, or to the main content when that control is gone.
- **Explanations**: `InfoTip` — an "i" toggletip with a 24 × 24 target that opens on hover where the
  pointer can hover and on click/tap everywhere, closes on Escape, an outside press or focus
  leaving. Never a `title` attribute for anything a user needs to read.
- **Search**: the shared stock combobox closes when focus leaves it, its listbox is never a Tab
  stop, and options are reached with the arrow keys.

## 7. Keyboard focus and accessibility

- One focus ring: `--focus-ring`, a solid 2px ring in `--color-focus` behind a 2px surface-coloured
  gap (4.6:1). Fields use `--focus-ring-inset` with `border-color: var(--color-focus)`. A component
  draws it on `:focus-visible` (fields on `:focus`); `globals.css` draws the same colour as an
  outline for anything without its own treatment. Never remove an outline without replacing it.
- The skip link targets `#main-content`, which is focusable by script only and draws no ring.
- Landmarks: `header`, `nav` (labelled), `main`, `footer`. Icon-only controls have an accessible name
  that includes the entity ("More actions for Blue chips").
- Status is never colour alone: a badge always has words; a gain or loss always has a sign.
- Live regions announce state changes, not ticks: a backtest announces "Backtest running." and
  "Backtest completed." once each, never its percentage; failures are alerts.
- Target sizes come from the control tokens: fields are `--control-height` (44px); buttons are
  `--button-height` (44px below 880px, 36px from it); row actions `--action-height` (38px, 32px
  from 880px). A small icon control is never below 24 × 24 CSS px (WCAG 2.5.8) — the `InfoTip`
  button is exactly that.
- Motion is short and functional (hover, a progress fill, a live job's pulse). A component that
  animates or transitions declares a `prefers-reduced-motion: reduce` override that removes it;
  `Switch` is the one stylesheet that does not yet.

## 8. Financial data presentation

- **Signs and units.** Gains and losses carry a sign as well as a colour; zero is unsigned and
  neutral. A return is a percentage; a **difference between two returns is in percentage points**
  ("Excess return +3,541.42 pp"). Money is US dollars through the feature's formatter. A maximum
  drawdown is shown as a decline (−34.40%).
- **Nothing is a fabricated zero.** A value that does not exist yet renders "—".
- **Compare like with like.** Runs of different lengths are compared by CAGR, not by cumulative
  return ("Best CAGR"). A KPI that has a benchmark equivalent shows it beside it, small and neutral
  ("CAGR +13.65% SPY +8.34%").
- **Name things for what they are.** The backtest benchmark backed by the SPY ETF is called "SPY";
  "S&P 500 — Historical PIT" is the point-in-time index-membership universe.
- **Valuation wording.** A price compared with an intrinsic-value estimate reads "Price 73.92%
  above value" / "Price 15.20% below value", in neutral styling, with an InfoTip saying it compares
  today's price with the model's estimate and is not a forecast or an expected return. Every model is
  shown the same way; none is hidden, reordered or flagged.
- **Provenance.** Market figures say what they are and when: "At close · Oct 16, 2026 · End-of-day
  data".
- Calculations never happen in React: the browser formats and arranges what the API computed.

## 9. Charts

- Lightweight Charts for market time series. Price is the always-visible base series in the brand
  blue with a soft area under it; volume is a desaturated slate in its own pane, never coloured by
  direction.
- Canvas colours live in the feature's `chart-theme.ts` (see Colour), mirroring tokens.
- **Stable series colours.** Overlays and indicator series draw from one palette of twelve
  (`OVERLAY_PALETTE`). Each catalog series has a home colour, dealt family by family, so a series
  keeps its colour whatever order it was enabled in; when two owners of a colour are on screen, the
  one dealt first keeps it and the other takes the first colour no visible series owns
  (`docs/decisions/selectable-series-catalog.md`).
- **Titled panes.** Every pane below the price — volume, oscillators, a valuation ratio, a
  Fundamental Metric — names its series in its top-left corner with the newest session's reading,
  or "Unavailable" for that session. A pane never shows an older reading as though it were current,
  so those series have no last-value label on the axis.
- **Pane sizing.** Lower panes are sized by stretch factors against the price pane's 2, and the
  chart grows by each pane's room, so adding a pane never shrinks the price chart. Scale margins
  keep the readings clear of the pane's title and the separator; the oscillator pane keeps its fixed
  0–100 range, with margins small enough that the axis never labels a value outside it.
- Benchmarks and comparison scenarios are visually secondary to the strategy line (the benchmark
  is grey, the Cash scenario dashed). Chart legends and keys use the same names as the KPIs ("SPY").

## 10. States

- **Loading**: a skeleton shaped like the final page (`Skeleton`, `SkeletonList`, `DetailSkeleton`)
  inside the real page header; never a bare spinner. While a skeleton is on the page the shell keeps
  the footer below the fold, so loading does not shift the layout.
- **Empty**: `EmptyState` (title, one sentence, and the next step where there is one); a filtered
  empty state always offers "Clear search" or "Clear filters".
- **Error**: `EmptyState` with "… could not be loaded", a cause in plain words, and a secondary "Try
  again". A plan refusal is an `EntitlementNotice`: the API's sentence, a recovery that is actually
  possible, and "See plans". Never advise something the user cannot do (removing stocks from a
  read-only built-in list).
- **Disabled**: only for something genuinely unavailable right now, with the reason nearby. Prefer
  an enabled action that explains itself on press.
- **In progress**: a live job gets the badge's pulse; a finished one stays still.

## 11. Keeping it consistent

Before merging a UI change:

1. Use the shared component; extend it with a variant instead of a page-local imitation.
2. Ask for tokens by name. No new hex outside `tokens.css`, no second button height, page gap,
   heading size or brand blue. Text uses ink tokens.
3. Check 390 / 768 / 1024 / 1280 / 1440 / 1920px with long content: no horizontal page scroll, a
   table's actions never scrolled out of its card, identity never truncated first.
4. Keyboard pass: visible focus on every control, logical order, dialogs return focus, popups close
   when focus leaves.
5. Run axe on the changed pages; contrast and names must pass.
6. Financial copy: signs, units (% vs pp), "—" for missing values, honest names.
7. Update this file and the relevant `ai/architecture/` document in the same change when a
   convention changes.

# Stock Details

Stock Details is the full research view for one security. The price series is always visible.
Technical and intrinsic-value overlays are selected from one shared canonical catalog defined in
`../../docs/decisions/selectable-series-catalog.md`.

## Indicators dropdown

The chart exposes one grouped multi-select control named `Indicators`. It replaces separate
hard-coded overlay toggles. The groups, ordering, labels, and identifiers come from the canonical
catalog; the component must not maintain a second local list.

Groups:

1. Moving averages — Daily
2. Moving averages — Weekly
3. Oscillators
4. Intrinsic Value — Blends
5. Intrinsic Value — Models

The price series is not an option because it is always shown. The initial chart state keeps
`Balanced` enabled and every other overlay disabled — every oscillator starts unchecked — driven by
the catalog's own default-selection metadata, preserving the current V2 default while making the
full catalog discoverable.

Availability is answered per series over everything loaded, not over the visible window: `RSI 7D`
becomes available once eight closes exist, `RSI 14D` after fifteen and `RSI 21D` after twenty-two,
and a leading warm-up gap in a long response does not disable a series whose later points are
evaluable. Loading older history can only add options, never remove them, so the picker does not
reshuffle while the user navigates.

All catalog entries remain discoverable. An entry whose series is unavailable for the security or
selected range is disabled and identified as unavailable; it is never replaced by zero or silently
substituted.

## Chart window and navigation

The chart explores at most **30 years** of history. That limit is
`STOCK_DETAILS_MAX_HISTORY_YEARS` in `@intrinsic/contracts` and exists once: the API clamps every
Stock Details read to it, and reports as `history` on the Stock Details response the boundary the
chart should navigate to — that limit narrowed by the deployment's retained horizon, the security's
listing date and, once proven, the provider's earliest trading day. The clamp itself stays at the
horizon: it bounds requests, it does not answer where history begins. The web app navigates against
the reported bound and never recomputes it. A backtest names its own period through the loader and
is unaffected by this limit.

The loader retains raw daily prices four years behind that 30-year limit as internal calculation
warm-up. Those rows are never charted, never returned and never reported in `history`; they exist
so a long series is already valid on the oldest day the chart can reach. See
`../../docs/decisions/price-retention-warmup-horizon.md`.

- The page opens on approximately one year and asks the API for exactly that window. It never
  leaves the range open for the shared loader to fill in, and it never loads long history it does
  not display. `../architecture/system-overview.md` and
  `../../docs/decisions/caller-scoped-history-materialization.md` cover what the loader then
  materializes.
- **History loads from the viewport.** Dragging left or zooming out past the oldest loaded bar is
  what asks for older history: the chart reports how much empty space the window has opened up,
  the page turns that into a bounded older window — about a year for a pan, enough to fill the
  screen for a wide zoom-out — and fetches only the interval that is missing. This repeats
  incrementally until the requested start reaches the boundary the API reported as
  `history.start`.
- **The boundary is reported, never inferred.** `history.startOrigin` says why the boundary is
  where it is: `HORIZON` (the 30-year limit), `LISTING` (the security's listing date, when later)
  or `PROVIDER` (the earliest trading day the provider has, reported only once complete coverage
  proves nothing older exists for more than a week before it — a shorter verified gap is
  indistinguishable from a weekend or holiday closure and keeps the `HORIZON`/`LISTING` origin).
  An empty window never ends exploration: it advances the
  loaded-from watermark so it is not asked for again, and the next gesture asks for the next older
  window. The QA stock `QATEST1` reaches a `PROVIDER` boundary — its seed covers the whole horizon
  while its synthetic rows span 160 weeks. `../../docs/decisions/complete-price-coverage.md` is
  the decision.
- **The chart stops at that boundary.** Once the loaded history reaches `history.start` the time
  scale is pinned to the oldest bar, so there is no dragging on into meaningless blank space.
- `1M`/`3M`/`6M`/`1Y`/`5Y`/`MAX` set the visible window over everything loaded. A range inside the
  loaded history costs no request at all; one that reaches past it asks for the missing interval
  and leaves the narrower history on screen while it arrives. `MAX` is the reported bound — 30
  years, or the nearer `LISTING`/`PROVIDER` boundary — not an unbounded read.
- History already loaded is never fetched again, and only one history request is ever outstanding:
  a fast drag past the edge collapses into a single widest request rather than one per frame.
- The chart uses standard Lightweight Charts navigation: drag to pan through history, wheel or
  pinch to zoom the time scale. A vertical touch drag scrolls the page rather than the chart.
- **Navigation is bounded by the domain, not corrected after the fact.** The navigable domain is
  `[history.start, the newest trading day]`: no gesture may open blank space after the newest bar,
  and none may reach before the boundary the API reported — 30 years, or the nearer
  `LISTING`/`PROVIDER` date. Wheel, pinch, drag, a resize, a picked range and every programmatic
  move are bounded by the one definition. The right edge and, once history is exhausted, the left
  edge are pinned by the library itself, which also caps how far a zoom-out can go; the only case
  it cannot express — the space left of the oldest *loaded* bar, which is how more history is
  requested — is bounded to the history that can still arrive. `data-domain-from`/`data-domain-to`
  publish the domain for browser tests.
- The chart frames itself when a range is picked, and once more when the history that range asked
  for has arrived. Nothing else moves the window: newly loaded history is shifted into place by
  exactly the bars that appeared in front of it, so the user keeps looking at the days they
  navigated to, and an overlay toggle or any other rerender leaves the viewport where it was.
- The visible window is published on the chart wrapper as `data-visible-range` (dates) and
  `data-visible-logical` (bar indices), alongside `data-loaded-from` and `data-history-exhausted`.
  That is how browser tests assert pan, zoom and history loading against a canvas.

## Series behavior

- The picker supports multiple simultaneous overlays.
- Weekly overlays use completed-period values only; no provisional week-to-date value may enter
  historical or backtest-visible state.
- The latest eligible weekly value is carried forward on each daily chart point until a newer
  completed week replaces it.
- Intrinsic-value models and blends come from canonical backend contracts; React never calculates
  them.
- Newly loaded history extends every selected series, not just price: daily and weekly moving
  averages, the RSI family and the intrinsic-value lines all arrive materialized for the new
  interval, warmed up by the loader. A day with no value stays absent; warm-up absence never
  becomes a zero.
- **A history window is loaded completely or not at all.** Prices, technicals, intrinsic models
  and intrinsic blends are fetched together and applied together. A window whose overlays failed
  is not recorded as loaded, so the interval is asked for again rather than leaving a permanent
  hole; the chart keeps everything it already had and offers a retry.
- **An unavailable interval is drawn as a gap, never as a line across it.** Intrinsic models and
  blends are materialized onto *every* trading day by carry-forward, so a trading day a series
  does not cover is the backend stating the model was not calculable that day — a genuinely
  different fact from "the value has not changed". The chart breaks the line there. It does not
  interpolate, carry a stale value forward in the client, or join the values on either side.
  Absence before a series' first value (warm-up or pre-eligibility) and after its last one (a
  model that has become unavailable) simply draws nothing.
- Consequently an intrinsic line normally reads as a **step**: flat between information events,
  changing on the trading day a newly eligible statement revision takes effect, and broken across
  any interval the model could not be calculated for. Moving averages and oscillators stay
  continuous lines and are never stepped.
- The legend identifies every enabled series and uses the same labels as the dropdown. Oscillator
  readings render unitless; price-scaled series render as money. That split holds on the **axes and
  crosshair labels** too, not only in the legend: number formatting belongs to each series, so the
  price pane's scale reads as currency and the oscillator pane's scale stays a bare 0-100.
- Oscillators are never drawn over the price scale. All selected RSI periods share one lower pane
  with a fixed 0-100 axis and one muted set of 30/50/70 reference levels (30 oversold, 70
  overbought). The first selection creates the pane, deselecting one period removes only its line,
  deselecting the last removes the pane, and repeated toggling never duplicates panes, lines or
  levels. The pane synchronizes date range, scrolling and crosshair with the price chart, and the
  price pane keeps a useful height on desktop and phone.
- Desktop and mobile expose the same catalog even if their picker compositions differ.

Stock Details may show the complete model/blend summaries outside the chart. Chart selection is
presentation state and does not alter strategy configuration.

## Actions, key and sign convention (UI-017, UI-018)

- **Add to list** is the page's one action: it opens a dialog offering only the caller's own lists
  (built-ins are read-only), says "already in" before sending anything, adds the stock as always
  eligible, and shows a plan refusal in the API's own words. A Guest is asked to sign in with a
  `next` back to the stock. A one-stock backtest is deliberately not offered: a backtest runs over
  a list.
- A **persistent chart key** under the plot names the close and every enabled overlay; the
  crosshair readout still adds values under the pointer.
- **One sign convention:** every comparison is the price against its reference —
  "Price vs value: −5.9%", "Price vs average: +3.2%" — so a negative number always means the price
  is below the reference. The chip is neutral in colour; green/red would assert a judgement.
- The page is built from shared primitives: `EmptyState` for not-found and load failures,
  `SectionCard` panels, `FactGrid` key facts and `StatusBadge` listing badges. The lower panels are
  one ordered flow balanced into two columns from 880px.
- Market capitalisation is not shown: the stock-data contract carries no market-cap field, and
  adding one needs provider data (deferred, see the PR's finding map).


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
`STOCK_DETAILS_MAX_HISTORY_YEARS` in `@intrinsic/contracts` and exists once: the API resolves it
against each security's listing date and the deployment's retained horizon, reports the result as
`history` on the Stock Details response, and clamps every Stock Details read to it. The web app
navigates against the reported bound and never recomputes it. A backtest names its own period
through the loader and is unaffected by this limit.

- The page opens on approximately one year and asks the API for exactly that window. It never
  leaves the range open for the shared loader to fill in, and it never loads long history it does
  not display. `../architecture/system-overview.md` and
  `../../docs/decisions/caller-scoped-history-materialization.md` cover what the loader then
  materializes.
- **History loads from the viewport.** Dragging left or zooming out past the oldest loaded bar is
  what asks for older history: the chart reports how much empty space the window has opened up,
  the page turns that into a bounded older window — about a year for a pan, enough to fill the
  screen for a wide zoom-out — and fetches only the interval that is missing. This repeats
  incrementally until one of two boundaries is reached: the 30-year bound, or the security's real
  first trading day, which is discovered when a bounded read comes back with nothing older.
- **The chart stops at that boundary.** Once nothing older can arrive the time scale is pinned to
  the oldest bar, so there is no dragging on into meaningless blank space.
- `1M`/`3M`/`6M`/`1Y`/`5Y`/`MAX` set the visible window over everything loaded. A range inside the
  loaded history costs no request at all; one that reaches past it asks for the missing interval
  and leaves the narrower history on screen while it arrives. `MAX` is the 30-year bound, not an
  unbounded read.
- History already loaded is never fetched again, and only one history request is ever outstanding:
  a fast drag past the edge collapses into a single widest request rather than one per frame.
- The chart uses standard Lightweight Charts navigation: drag to pan through history, wheel or
  pinch to zoom the time scale. A vertical touch drag scrolls the page rather than the chart.
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
- The legend identifies every enabled series and uses the same labels as the dropdown. Oscillator
  readings render unitless; price-scaled series render as money.
- Oscillators are never drawn over the price scale. All selected RSI periods share one lower pane
  with a fixed 0-100 axis and one muted set of 30/50/70 reference levels (30 oversold, 70
  overbought). The first selection creates the pane, deselecting one period removes only its line,
  deselecting the last removes the pane, and repeated toggling never duplicates panes, lines or
  levels. The pane synchronizes date range, scrolling and crosshair with the price chart, and the
  price pane keeps a useful height on desktop and phone.
- Desktop and mobile expose the same catalog even if their picker compositions differ.

Stock Details may show the complete model/blend summaries outside the chart. Chart selection is
presentation state and does not alter strategy configuration.

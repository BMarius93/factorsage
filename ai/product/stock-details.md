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

Availability is answered per series over the loaded window: `RSI 7D` becomes available once eight
closes exist, `RSI 14D` after fifteen and `RSI 21D` after twenty-two, and a leading warm-up gap in
a long response does not disable a series whose later points are evaluable.

All catalog entries remain discoverable. An entry whose series is unavailable for the security or
selected range is disabled and identified as unavailable; it is never replaced by zero or silently
substituted.

## Chart window and navigation

- The page opens on approximately one year and asks the API for exactly that window. It never
  leaves the range open for the shared loader to fill in, and it never loads long history it does
  not display. `../architecture/system-overview.md` and
  `../../docs/decisions/caller-scoped-history-materialization.md` cover what the loader then
  materializes.
- `1M`/`3M`/`6M`/`1Y` are filtered from the loaded window with no further request. `5Y` and `MAX`
  load lazily, each asking only for its own start — `MAX` is the single unbounded case. What has
  been loaded is kept, so returning to a range already inside it refetches nothing, and a widening
  load leaves the narrower history on screen while it runs.
- The chart uses standard Lightweight Charts navigation: drag to pan through history, wheel or
  pinch to zoom the time scale. A vertical touch drag scrolls the page rather than the chart.
- The chart frames itself once per selected range — on that range's first drawable frame, and
  again when a long range's fuller history arrives. After that the visible window belongs to the
  user: new data, an overlay toggle and any other rerender leave it exactly where they found it.
  Only picking a different range reframes.
- The visible window is published on the chart wrapper as `data-visible-range`, which is how
  browser tests assert pan and zoom against a canvas.

## Series behavior

- The picker supports multiple simultaneous overlays.
- Weekly overlays use completed-period values only; no provisional week-to-date value may enter
  historical or backtest-visible state.
- The latest eligible weekly value is carried forward on each daily chart point until a newer
  completed week replaces it.
- Intrinsic-value models and blends come from canonical backend contracts; React never calculates
  them.
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

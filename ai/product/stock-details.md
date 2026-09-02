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
3. Intrinsic Value — Blends
4. Intrinsic Value — Models

The price series is not an option because it is always shown. The initial chart state keeps
`Balanced` enabled and every other overlay disabled, preserving the current V2 default while
making the full catalog discoverable.

All catalog entries remain discoverable. An entry whose series is unavailable for the security or
selected range is disabled and identified as unavailable; it is never replaced by zero or silently
substituted.

## Series behavior

- The picker supports multiple simultaneous overlays.
- Weekly overlays use completed-period values only; no provisional week-to-date value may enter
  historical or backtest-visible state.
- The latest eligible weekly value is carried forward on each daily chart point until a newer
  completed week replaces it.
- Intrinsic-value models and blends come from canonical backend contracts; React never calculates
  them.
- The legend identifies every enabled series and uses the same labels as the dropdown.
- Desktop and mobile expose the same catalog even if their picker compositions differ.

Stock Details may show the complete model/blend summaries outside the chart. Chart selection is
presentation state and does not alter strategy configuration.

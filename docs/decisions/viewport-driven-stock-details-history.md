# Viewport-Driven Stock Details History

## Status

**Accepted.**

Builds on `caller-scoped-history-materialization.md`, which made the loader materialize the range a
caller asks for. This decision is about who asks, and for what. `ai/product/stock-details.md`
describes the resulting product surface.

## Context

`caller-scoped-history-materialization.md` gave the loader a correct answer to "materialize this
interval": it reads the persisted coverage for the requested range, computes the missing intervals,
fetches only those, rebuilds the derived state over them and widens the manifest. Verified against
the live stack, a security resident only from 2021 answered a request reaching back to 2016 with one
provider delta for the missing prefix, and the newly loaded days came back with their complete set
of moving averages and oscillators.

The chart never used it. The web app had exactly one thing that could ask for more history — the
`1M`/`3M`/`6M`/`1Y`/`5Y`/`MAX` range selector — and pan and zoom were wired to the library's own
navigation with nothing listening. Dragging left walked the viewport into empty space and left it
there, indefinitely, for every security and whether or not older data existed. Zooming out did the
same. The capable loader sat behind a surface that never called it.

Two further problems compounded it:

- **Nothing bounded the exploration.** With no notion of a boundary, a drag could continue into
  blank space forever. The one hard limit that existed was the loader's own `STOCK_HISTORY_YEARS`
  retention horizon, which the web app could not see and which is not the same question as "how
  far may this product surface explore".
- **Arriving data moved the user.** Lightweight Charts anchors the visible logical range to bar
  indices, so prepending a year of history silently walks the window a year backwards. On top of
  that the framing effect re-fit the chart on every data update while a load was outstanding.
  Together these meant that even where loading did happen — the long ranges — the viewport was not
  the user's.

A separate observation from the live stack shaped the boundary rule. A security's manifest can
legitimately report coverage back thirty years while its first real price row is much later: for
`AAPL`, coverage from 1996 and a first trading row in 2006. Coverage is a record of what was
*asked for* — including intervals that came back empty, which is what stops the loader asking
again — not a promise that rows exist. A chart that navigates to the coverage start therefore
walks into ten years of legitimately blank canvas.

## Decision

**The viewport is what requests history, the API reports the boundary, and loading never moves the
user's window.**

1. **One definition of the limit.** `STOCK_DETAILS_MAX_HISTORY_YEARS = 30` lives in
   `@intrinsic/contracts`, the package both the web app and the API already share. Nothing else
   names the number.
2. **The API reports the bound; the client never recomputes it.** `getStockDetails` returns
   `history: { start, end, startOrigin }`, computed in `CanonicalStockDataService` because that is
   where the clock and the retained horizon live. `start` is the product limit narrowed by the
   deployment's retention and by the security's listing date; `startOrigin` distinguishes
   `HORIZON` from `LISTING` so a client can say which boundary it reached. A bound derived at the
   HTTP edge from a second clock would be a bound the loader does not honour.
3. **The surface is clamped server-side.** Every `/stocks/*` read clamps its range to the horizon
   before it reaches the loader, so a hand-written `from=1900-01-01` cannot become an unbounded
   backend request. The clamp is at the controller because `/stocks/*` *is* the Stock Details
   surface; a backtest names its own period straight through `StockDataService` and is unaffected.
4. **Gestures request history.** The chart reports how many bars of empty space the viewport has
   opened up to the left. The page turns that into a bounded older window — at least a year, more
   when a wide zoom-out has opened up more than that — clamped to `history.start`, and fetches
   `[from, loadedFrom - 1]`: the gap, never the whole range again.
5. **Exhaustion is discovered from data, not asserted from coverage.** A bounded read that returns
   no older rows means the security's history starts there. Price history is contiguous from
   listing, so an earlier window can only ever be empty too. The chart then pins its left edge and
   stops asking. This is what keeps `AAPL` from offering ten years of blank canvas back to a
   coverage start that predates its first row.
6. **One request outstanding, and nothing refetched.** A watermark of what has been asked for
   rejects already-covered asks; a single in-flight slot with one pending "widest ask" collapses a
   fast drag — which reports the edge on every animation frame — into one request.
7. **The viewport survives loading.** Older history is shifted into place by exactly the number of
   bars that appeared in front of the window. Framing happens only on a key the page controls: a
   range being picked, and that range's history arriving.

## Consequences

- The chart draws every security's real history, reached incrementally, and stops where that
  history actually ends. Panning is bounded work: about a year per screen rather than one thirty-
  year download or nothing at all.
- The range selector is no longer a loading mechanism. It sets the visible window over everything
  loaded, which makes every range inside the loaded history free and makes `MAX` mean the 30-year
  bound rather than an unbounded read.
- Series availability is answered over everything loaded rather than the first window, so a series
  that only becomes evaluable with more history stops being reported as unavailable. It can only
  widen, so the picker does not reshuffle mid-navigation.
- Browser tests assert the DOM contract the chart publishes — `data-visible-range` in dates,
  `data-loaded-from`, `data-history-exhausted` — paired with the network requests each gesture
  causes. `apps/web/e2e/stocks/history-navigation.user.spec.ts` is where "the gesture loaded the
  missing years" is distinguished from "the gesture drew nothing, again".
- Nothing about persisted coverage, manifests or revisions changed. A security loaded before this
  work needs no migration, cache flush or reseed: its manifest already records what interval is
  resident, and a request for an older one already takes the gap path. What changed is that the
  product surface now issues that request.

## Rejected

- **Recomputing the boundary in the web app from `ipoDate` and a local constant.** It is derivable,
  and it would have been a second answer to a question the loader already answers with its own
  clock and horizon. The one place they disagreed in testing — a service configured with a shorter
  horizon than the deployment default — is exactly the case that would have shipped wrong.
- **Treating the manifest's `coverageStart` as where history begins.** It is where asking began.
  Publishing it as a navigable boundary would reintroduce the blank region for every security whose
  provider history is shorter than the retained horizon.
- **Eagerly loading the full 30 years once the user pans at all.** It is one request instead of
  several, and it is the download the caller-scoped decision exists to avoid — reintroduced through
  a gesture rather than a page view.
- **Keeping the range selector as the only loading path and disabling pan and zoom.** That was the
  state before this work. It makes the deepest history reachable only by a control that jumps
  straight to it, which is both the largest possible request and the least direct way to explore.

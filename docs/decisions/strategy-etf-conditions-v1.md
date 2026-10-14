# Strategy ETF Conditions V1 — product decision and acceptance gate

## Status and authority

**Product direction accepted by owner, 2026-10-13. Documentation handoff only.**
This file records the agreed feature and the non-negotiable correctness gate for a
later implementation by Claude Code **locally**. It is **not** evidence that the
current codebase already supports ETF-derived strategy series and is **not**
authorization to merge automatically. No application code changes belong in this
specification branch.

The read-only architecture audit this section requires has been performed and
reviewed: `ai/architecture/strategy-etf-conditions.md` is the resulting
technical design and implementation plan, carrying the owner's final
architecture decisions of 2026-10-13.

Read this alongside `AGENTS.md`, `ai/README.md`, `ai/product/strategies.md`,
`ai/architecture/strategy-builder.md`, `ai/architecture/strategy-evaluation.md`,
`ai/product/monitors.md`, `ai/architecture/monitor-engine.md`,
`ai/architecture/benchmark-data.md`,
`docs/decisions/etf-market-data-v1.md`,
`docs/decisions/etf-market-overview-v1.md`,
`docs/decisions/selectable-series-catalog.md` and `ai/workflows/validation.md`.

If an implementation choice conflicts with a canonical existing invariant,
investigate and propose an explicit, narrow amendment first; do not silently
reinterpret that invariant. This decision extends the *product capability* of
ETF-backed strategy conditions, not the definition of a Benchmark or a Security.

## 1. User outcome and scope

A user editing a BUY level can press **+ Add condition** and add an ETF-based
condition **beside existing stock-based conditions in the same Signal**.
For example:

- `Stock · Revenue Growth TTM YoY is above 15%`
- AND `XLK · RSI 14D is above 50`
- AND `SPY · Price is above SMA 200D`
- AND `GLD · RVOL 20 is above 1.5x`

**Each condition independently owns its data source.** Choosing XLK in one row
must never change the source used by adjacent rows or the Stock List. ETF
conditions are **market-context filters**, evaluated identically for each
candidate security at the same eligible session, independent of that security's
sector. No automatic "stock's sector" resolution or dynamic constituent
classification is part of V1.

Use the same canonical Strategy language and AND composition for Conditions in
BUY, SELL and FINAL EXIT Exit Rules. FINAL EXIT's existing OR-of-AND grammar
remains unchanged. Do not add per-condition AND/OR controls, multiple Triggers
per Signal, a global ETF selection, a new strategy mode or a new condition
operator. The initial feature request is about **Conditions**. Whether
ETF-sourced **Triggers** should be enabled is a separate, explicit product
follow-up: do not silently enable them just because some technical metric kinds
already support stock-sourced crossing Triggers. Existing stock Triggers remain
unchanged.

An ETF is a **source of evaluation data**, not an item in the user's Stock
List, not an investable backtest position, and not a selectable portfolio
comparison benchmark. Choosing QQQ/XLK/GLD as a condition source must not
change benchmark selection or portfolio allocation.

## 2. Available ETF sources: reuse the exact Dashboard universe

Use the **one** canonical `MARKET_OVERVIEW_ETF_GROUPS` catalog, including
tickers, display names, stable benchmark codes and grouping. Never maintain a
second manually copied ETF list or silently admit arbitrary tickers.

| Picker group | ETF tickers |
| --- | --- |
| Benchmarks | SPY, QQQ, DIA, IWM, RSP |
| Sectors | XLK, XLF, XLE, XLV, XLI, XLY, XLP, XLU, XLB, XLRE, XLC |
| Macro & Alternatives | GLD, USO, TLT, HYG |

Exactly **20** options. SPY refers to the existing `SP500` benchmark
series; the others use their existing immutable ETF-proxy benchmark series.
Do **not** insert ETF proxies into `Security`, make the other nineteen
`isBacktestSelectable`, create new FMP ticker fetching paths or duplicate
market-data storage.

## 3. Compatibility: same stock metrics, constrained by source

For ETF sources, expose **only** the following existing canonical Strategy
metric kinds and identities. There are **21 metric choices per ETF**:

| Existing metric family | Exact eligible metrics | Count |
| --- | --- | ---: |
| Price | Price (canonical daily close) | 1 |
| Moving averages — daily | SMA 20D/50D/100D/200D; EMA 20D/50D/200D | 7 |
| Moving averages — weekly | SMA 20W/50W/100W/200W; EMA 20W/50W/200W | 7 |
| Oscillators | RSI 7D/14D/21D | 3 |
| Volume | RVOL 10/20/50 | 3 |

Reuse the existing catalog identities, calculation methodologies, availability
rules, operators and metric-to-value compatibility; **no parallel ETF metric
catalog**, no second calculation formula, no hand-coded UI/backend duplicates.

- **ETF Price** keeps the existing Price Condition operators and its
  series-based Value picker; its allowed Values are moving averages of the
  **same ETF**. Intrinsic-value models/blends are **not** valid ETF Values.
  Do not invent a numeric Price threshold if the stock grammar does not offer
  one.
- **ETF moving-average Metrics** compare only with compatible moving averages
  of the **same ETF**, obeying same-timeframe (D with D, W with W), never
  themselves; preserve the existing condition operators and fixed
  `is close to` semantics.
- **ETF RSI 7D/14D/21D** uses existing Wilder methodology, numeric threshold
  range and `is above`/`is below` operators.
- **ETF RVOL 10/20/50** uses existing prior-session baseline methodology,
  multiplier formatting and `is above`/`is below` only. The stock catalog
  deliberately offers no RVOL Trigger; preserve that.
- Preserve the **existing** numeric precision, price basis, period counting,
  weekly completed-bar policy and validation domain for every metric. Never
  compare a stock's moving average with an ETF's moving average implicitly.
- A technical indicator cannot be evaluated until the ETF has sufficient,
  *genuine* eligible historical input; warm-up and coverage gaps are not
  synthesized.

**Not eligible for ETF sources:** all Fundamentals, all Valuation Ratios,
intrinsic-value blends/models, Margin of Safety, Insider Activity,
Congressional Trading, position Gain/Loss. These remain available in their
existing applicable Stock/position contexts, including Position metrics in
SELL/FINAL EXIT. Do not remove or regress them in a UI regrouping.
This is a source-specific compatibility rule, not an assertion that the
underlying ETF can never be analysed with other datasets.

**Explicitly out of scope:** new Performance 1W/1M/3M metrics,
ETF-vs-SPY performance comparisons, sector ranking/rotation, aggregate
sector fundamentals, `Stock vs ETF` metric comparisons, arbitrary ETF
symbols, ETF trading/position allocation, dynamic stock-to-sector selection.
The existing Dashboard returns are not new Strategy metric identities.

## 4. Strategy Builder popup: accepted UX direction

Preserve the existing **three controls per rule**:
`Metric | Operator | Compare With` (product labels may use the existing
`Condition` and `Value` terminology). `+ Add condition` still appends
another independent Condition to the **current** BUY/SELL/FINAL EXIT signal;
no separate ETF block, row type or fourth always-visible control.

The **Metric picker** is redesigned, for *Stock and ETF*, not just sectors:

1. **Data Source:** `Stock` (default) or `ETF`. On ETF, show an explicit
   selector for one of the 20 funds, grouped as Benchmarks / Sectors /
   Macro & Alternatives.
2. **Metric Library:** compact top-level families
   **Technical**, **Fundamentals**, **Valuation**, **Activity**.
   **Technical** groups existing Price, Moving averages, Oscillators and
   Volume as expandable subgroups. For Stock, include other metrics only
   where existing Strategy context allows them: the **Position** family/
   Gain and Loss in SELL/FINAL EXIT must remain findable. The exact
   presentation of Position (fifth group or context-specific section) can
   follow existing registry/category conventions; it must not be lost.
3. For ETF, only **Technical** appears and only the 21 compatible metrics
   are selectable. Stock retains its applicable existing choices; default
   source for new rows remains Stock.
4. **Price** is just a compact one-item subgroup, not an entire huge empty
   popup. Fundamentals and other long groups scroll **inside the list**.
   The popup adapts its height to content with a bounded list scroll;
   no oversized fixed blank panel. Desktop and mobile must be usable.
5. Selecting a metric commits that row's choice and closes the picker
   (consistent with current design). Editing/reopening displays the
   selected source, ETF, family and metric. The collapsed Metric control and
   the canonical human-readable Strategy logic/reasons **visibly include
   the ETF** (e.g., `XLK · RSI 14D is above 50`), so sources cannot be
   confused.
6. Changing sources/ETFs/metrics must preserve compatible operators and
   Values only where semantically valid; otherwise reset to canonical
   compatible defaults with an explicit/visible outcome. Never leave an
   invisible invalid value or silently reinterpret a numeric threshold.
   Choosing a different ETF while retaining the same technical metric
   keeps that metric when still compatible.
7. Category lists, metric identities, display labels, comparators and
   validation come from **one canonical registry**; no duplicated lists in
   React, API or worker. Preserve all stock-only configuration controls
   (including Insider/Congress actor filters) and current UX for other
   Strategy rows.
8. Keyboard navigation, focus restoration on close, selected-state
   indication, mobile layout and screen-reader-friendly labels are part
   of acceptance, not polish to postpone.

The visual prototype discussed in chat is conceptual, not a mandate to
copy its exact component tree or colors. Keep FactorSage's existing visual
language and compact density.

## 5. Architecture constraints and mandatory discovery

**Known architectural mismatch that must be solved explicitly:**
`Benchmark` and `BenchmarkDailyPrice` are not `Security`; benchmark
histories hold OHLCV but, per `ai/architecture/benchmark-data.md`, do
**not** currently carry the stock-derived technical series. Dashboard
returns do not prove RSI/EMA/SMA/RVOL availability in Strategy. Do a
**read-only architecture audit first**, report the gaps and an approach
that preserves benchmark identity and semantics. Do not implement by
coercing ETF proxy benchmark series into stock `Security` rows.

- Canonical ETF histories and coverage remain in PostgreSQL, resident and
  revision-consistent via the existing `benchmark:v1:*` Redis projection.
  Do not add new FMP calls for evaluating Strategy conditions and do not
  bypass or duplicate the benchmark reader/coverage mechanisms.
- Design a **single reusable technical-calculation path** for stock and
  ETF inputs that applies the same methodology. Its cache/materialization
  and invalidation policy must be explicit, bounded and correct under
  PostgreSQL revisions, price-basis generation changes, hydration and Redis
  restarts. Avoid repeated per-stock or per-condition recomputation and
  N × 20 provider requests.
- Each source has a **stable canonical identity** in serialized Strategy
  rules, normalization, validation, descriptions and Monitor fingerprints.
  Source is part of condition identity: `Stock RSI14`, `XLK RSI14`,
  `XLF RSI14` are distinguishable even with equal thresholds. Preserve
  legacy Stock-source semantics and identity when reading old documents;
  choose a safe explicit schema/read-upcast strategy if required.
- Source must propagate through API serialization, save/load/edit, duplicate,
  strategy versions, immutable BacktestRun snapshots, worker execution,
  Monitor snapshots/evaluation, explanatory reasons and trade/signal output.
  No opaque string-parsing of displayed `XLK · RSI14` labels.
- **Historical PIT correctness:** only ETF bars actually eligible on the
  historical date may affect a signal; no current reading, future-dated
  close, future-completed weekly bar or look-ahead. Respect the existing
  backtest execution-time/close policy. If a required input, prior bar,
  series generation or coverage is missing, return `NOT_EVALUABLE` with
  a useful reason: no zero/future-value/fall-forward substitution.
- Pay special attention to newer funds (e.g., XLRE/XLC), early listing,
  long weekly warm-up, holidays, gaps, missing/nonpositive volume,
  revised/rebased histories and same-session alignment. No synthetic
  pre-inception data.
- Maintain the existing stock-lifecycle, position accounting, benchmark
  selection, contribution rules, prices and sector-independent filtering.
  A single ETF condition may match many candidate stocks on a date;
  evaluate/shared-load the market condition efficiently without consuming
  position slots or allocating cash to the ETF itself.

The implementation team must **document any needed narrow amendment** to
the existing architecture's "benchmarks have no derived technicals" statement
before merging. The requirement is to enable evaluation of ETF technicals
without introducing ETF positions or a second Security identity; a separate
read-only calculation adapter is not ruled out.

## 6. Test and acceptance matrix (implementation branch)

This is a **high-risk feature** because a backtest can appear plausible while
being historically wrong. A green generic CI alone is insufficient.

### Contracts and unit tests
- Enumerate **all 20 ETF options and all 21 compatible technical metrics**,
  sourced from canonical registries (do not duplicate fixture constants as
  product definitions). Assert all forbidden kinds/values/operators rejected
  at API and worker boundaries, including forged payloads.
- Cover 14 daily/weekly MAs, three RSI periods, three RVOL periods, Price
  as a Metric, and the *compatible Value* matrix. Test daily-vs-weekly
  rejections, self-comparison rejections, RSI domains, RVOL no-Trigger
  behaviour, `is close to` precision, missing coverage and warm-up.
- Compare ETF technical results to an **independently calculated oracle** with
  deterministic known inputs, not two calls sharing the same production
  calculation implementation.

### Persistence / regression
- Create, save, reload, edit, duplicate, version and describe mixed-source
  strategies; verify no source is lost. Confirm existing serialized strategies
  (including older schema versions), built-ins, definition hashes and
  historical snapshots retain meaning without manual rewriting or
  silently reset Monitor latches.
- Changing `Stock -> SPY -> XLK -> Stock` updates only the intended
  condition. Every allowed change of ETF, metric, operator or Value follows
  the registry and produces legible human-readable reasons.

### Backtest and Monitor
- Deterministic multi-stock backtest with **Stock + SPY + XLK + GLD**
  conditions in the same BUY signal; independent expected signals/trades,
  correct AND semantics, unaffected SELL/FINAL EXIT, and a negative
  scenario where one ETF input is unavailable.
- PIT edge cases: ETF listing boundary, incomplete weekly bar, revised price
  basis, data gap, warm-up, same-day eligibility and no future leakage.
- Monitor equivalence with backtest on eligible completed sessions;
  source-specific fingerprint/state, no stale activation carryover on
  ETF or metric change, no duplicate signal on retries/restarts.
  Verify that old Stock-only monitoring retains its existing lifecycle.

### Data / performance / browser
- PostgreSQL/Redis integration for benchmark OHLCV technical evaluation,
  including Redis cold start/rehydration, generation invalidation,
  bounded reads and **no provider calls during evaluation**.
  Verify load scales with **unique ETF + time range**, not number of
  securities multiplied by conditions.
- Hermetic Playwright desktop + mobile: the compact popup, group expansion,
  Stock vs ETF switch, all three ETF group labels, group-specific metric
  visibility, keyboard navigation/focus, multiple independent conditions in
  BUY, SELL and FINAL EXIT, edit/save/reopen and validation messages.
- Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
  `pnpm openapi:validate` plus all relevant integration/E2E suites.
  If an OpenAPI schema changes, update it alongside contracts; never
  document a nonexistent endpoint. Report command, environment,
  total/pass/fail/skip and any untested scenario. No fake greens or
  tests that assert only that a page rendered.

## 7. Handoff/workflow for Claude Code local

1. **Audit only, no edits initially.** Read the documents above and inspect
   current `main`-derived code: canonical catalogs, benchmark OHLCV reader,
   derived technical pipeline, Strategy contracts, Backtest, Monitor, UI,
   caches, snapshot compatibility and E2E setup.
2. Produce a concise impact map and identify all conflicts with established
   invariants. Distinguish accepted **product** decisions above from
   **technical design** choices requiring an explicit decision. Do not
   quietly narrow the 20-ETF/21-metric or mixed-condition requirement.
3. Propose a safe implementation plan and test matrix. Then implement on a
   **separate feature branch** derived from this specification branch
   (or continue on it only if explicitly requested by the owner).
4. Run the full gate locally with PostgreSQL/Redis/Playwright as required.
   Show oracle parity and browser evidence. Open a PR; **do not merge**.
   Do not overwrite unrelated working-tree changes or run destructive
   environment commands without checking first.

## Acceptance bar

Done means: all 20 ETFs are selectable *as condition sources*, 21 existing
technical metric identities evaluate correctly where historical inputs are
available, every other metric is hidden/rejected for ETFs, existing Stock
rules remain unchanged, old strategies/snapshots/Monitor state are safe,
the popup is compact and accessible, and deterministic historical and live
validation demonstrates **no look-ahead, no cross-source state confusion,
no unintended provider traffic**. Anything less is **not accepted**.

## Extension: Stock's Sector (owner request, 2026-10-14)

Added to the same PR (#98) at the owner's request. A Condition's **Data Source** is
`Stock`, `ETF` or **`Stock's Sector`**. Stock's Sector names no fund: each evaluated
stock reads the Select Sector SPDR ETF its stored FMP sector maps to, so one rule
reads XLK for a Technology stock and XLF for a Financial Services one.

- **One canonical mapping** (`STOCK_SECTOR_ETF_CODES`, `@intrinsic/contracts`):
  Technology → XLK, Financial Services → XLF, Energy → XLE, Healthcare → XLV,
  Industrials → XLI, Consumer Cyclical → XLY, Consumer Defensive → XLP,
  Utilities → XLU, Basic Materials → XLB, Real Estate → XLRE,
  Communication Services → XLC. Aliases only where verified in the data — the
  audit of every stored security found exactly these eleven strings, so there are
  none. Missing, unsupported or ambiguous sectors are `NOT_EVALUABLE`; no fund is
  guessed or substituted (never SPY), and no sector is derived from a ticker.
- **No historical sector point-in-time.** Backtests and Monitors use the stock's
  current stored sector; the limitation is documented and said in the product.
  A backtest resolves it once at submission and freezes it in the run's immutable
  snapshot; a Monitor resolves it once per scan. A sector change between Monitor
  scans is explicit and deterministic (§14.4 of the architecture record).
- **Same capability as an ETF rule:** the 21 technical metrics, values from the
  resolved sector ETF, Conditions only (no Stock's Sector Trigger), BUY / SELL /
  FINAL EXIT; never Fundamentals, Valuation, Insider, Congress, intrinsic values,
  Gain or Loss. Label `Stock's Sector · RSI 14D`; three row controls; source-aware
  identity and fingerprints.
- **Data:** reuse the eleven bootstrapped sector ETF histories; no FMP during
  evaluation; no new tables, Redis namespaces, engines or sector history; each
  distinct sector ETF read once per backtest run and once per Monitor cycle.

`ai/architecture/strategy-etf-conditions.md` §14 records the design, the
evidence and the remaining limitations.

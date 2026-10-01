# Historical Price and Corporate-Action Basis V1

## Status

**Revised 2026-10-01 (evening) for the owner's FMP-only decision. The re-base-safe loading of PR 1
is accepted for implementation; the historical basis is not part of V1.**

- **V1 is FMP-only** (owner). No second market-data provider and no purchased as-traded series. The
  external reference this decision used to require (§6) is therefore not part of V1, and neither is
  anything that depended on it: a historical distribution factor `Φ`, the historical Margin of
  Safety correction (§13) and the historical valuation backfill.
- **PR 1, re-base-safe price loading, is required** for the correctness of what exists today: the
  next split in a loaded security leaves a split-sized step in the stored close, which breaks every
  chart, indicator, backtest and Monitor that crosses it (B2). PR 1 was re-scoped on 2026-10-01:
  "Implementation plan" classifies every component of the earlier PR 1 and keeps only what
  existing correctness or forward valuation needs.
- **Valuation ratios** are specified by `valuation-ratios-v1.md`: computed per session from the
  research close, with the factor PR 1 measures at each re-base, and unavailable where the price
  basis cannot be vouched for. They use PR 1 and nothing else from this decision.
- **Margin of Safety is a separate problem** (owner) and keeps it (§13). Its historical bias (B1) is
  not fixed in V1, because the fix needs `Φ`, which needs the external reference. PR 1 keeps it from
  getting worse.
- **The evidence stands.** The investigation and its evidence files are kept; they are why V1
  withholds what it cannot vouch for rather than estimating it.

This decision builds on these documents and does not reinterpret them:

- `valuation-ratios-v1.md`, the valuation-ratio decision, which uses PR 1's measured re-bases;
- `complete-price-coverage.md`, for what a price coverage interval means and how it is revisioned;
- `intrinsic-value-engine.md` and `fundamentals-loader.md`, for share counts and statement
  revisions;
- `backtest-run-persistence.md` and `ai/product/backtests.md`, for what a run promises.

The prior gate's evidence is `docs/valuation-ratios-gate/INVESTIGATION.md`. This decision's
evidence is `docs/historical-price-basis/INVESTIGATION.md`.

## Context

FactorSage stores one daily price per session: FMP's adjusted close from
`historical-price-eod/full`. The chart, the indicators, the backtest engine and Margin of Safety
all use it, and valuation ratios will.

The valuation gate established nine facts, and the investigation re-measured them:

1. The stored close is the provider's adjusted series.
2. That series is not only split-adjusted: it folds in most spin-offs and distributions as if they
   were splits.
3. Statement share counts follow share-changing actions and not those price-only adjustments.
4. So `close × shares` is low before every such adjustment: by 4.4 % (IBM) to 52.8 % (HON).
5. Margin of Safety is biased the same way.
6. The provider's split list omits, mis-sizes and mislabels those adjustments.
7. Its "unadjusted" series is derived from that list and cannot check it.
8. The loader re-reads only a recent tail, so a re-base after first load leaves mixed bases in
   stored history.
9. Insider trade prices are the only as-traded evidence stored, and they are sparse.

Two questions follow: which price basis each consumer needs, and how the loader stays on one basis
when the provider re-bases history.

## Terminology

These terms are exact. Code and documents use them and nothing looser: not "raw price", "real
price" or "corrected price".

- **Session `D`.** An exchange trading day.
- **Research close**, `researchClose(D)`. The value in `DailyPrice.close`: the provider's adjusted
  close as of the last full read of the security's history.
  - It is continuous through share-changing actions, and through the price-only adjustments the
    provider chose to fold in.
  - It is not adjusted for ordinary cash dividends.
  - Its unit is dollars per current research share.
  - Research open, high, low and volume are the same series' other fields.
- **As-traded close**, `asTradedClose(D)`. The official closing price printed for the security on
  `D`, in the share units outstanding on `D`.
- **Share-changing action.** Each holder's share count changes by a ratio `k` and no value leaves
  the security: a forward split, a reverse split, a stock dividend, or a distribution of the same
  company's shares (GOOG class C, 2014). The as-traded price moves by `1/k`.
- **Distribution (price-only action).** Value leaves the security to its holders while the share
  count does not change: a spin-off, or a special distribution of cash or other property.
- **Combined event.** A share-changing action and a distribution with the same ex-date: HON
  2026-06-29, HLT 2017, MSI 2011.
- **Total adjustment factor**, `A(D) = asTradedClose(D) ÷ researchClose(D)`. Piecewise constant; it
  steps only at the ex-dates of events the provider folded into its series.
- **Share factor**, `G(D)`: the product of the share-changing ratios with an ex-date after `D`.
  **Distribution factor**, `Φ(D) = A(D) ÷ G(D)`: the product of the provider's price-only factors
  with an ex-date after `D`. A filed count is in the units of its filing date.
- **Re-base.** The provider rewriting a security's history for a new event.
- **Measured re-base** (V1). One step PR 1 measures when it compares a re-based history with the
  stored one: its effective date, or the interval it lies in when it fell between two reads; its
  price ratio, the stored close over the new close of the rows before it; and when it was detected.
  A change with no such structure is `UNEXPLAINED`. Stored as a `PriceBasisEvent`.
- **Price-basis generation.** A per-security integer that increases whenever the stored research
  history is replaced. Measured re-bases belong to the generation that introduced them.
- **Basis verified at**, `verifiedAt`. The instant PR 1 first compared a security's whole stored
  history with FMP's and made them equal. Corporate actions after it are measured; those before it
  are known only from FMP's split list.
- **Basis factor**, `K(t, R)`. For a statement revision `R` and a session `t`, the product of the
  price ratios of the measured re-bases detected after `R` was observed whose effective date is
  after both `R`'s observation and `t`. `researchClose(t) × K` is the close on the basis `R` was
  observed on. It is 1 when no such re-base exists, which is everywhere in the store today.
- **Plain share change.** A ratio that in lowest terms `n:d` has `n, d <= 10`, or `n = 1`, or
  `d = 1` (and, for a provider entry, the label `stock-split`). Used only to decide whether an event
  may be a distribution (`valuation-ratios-v1.md`).

## Current semantics

As implemented at `b90ab7e2`, unchanged since `79fa8509`; the evidence is in the investigation, §1.

- **The provider read.** `historical-price-eod/full`, walked to completeness. No split, dividend or
  unadjusted endpoint is called by any product path. `StockDataset` declares `DIVIDEND` and
  `STOCK_SPLIT`, but nothing writes them.
- **Storage.** `DailyPrice` holds one row per session: research open, high, low, close, volume and
  VWAP. Coverage is revisioned by `PRICE_DATASET_VERSION` (3); nothing records which provider basis
  a row was read under. Derived state (`DailyDerivedState`, `WeeklyPrice`) is a function of those
  rows and the statements.
- **Refresh.** Only the recent tail is re-read, from ten calendar days before the earlier of today
  and the previous tail. Returned rows replace stored ones by date in one transaction; derived state
  is rebuilt from the earliest changed date in a second; Redis years are republished one key at a
  time. A re-base therefore changes the tail and leaves the rest of the history on the old basis.
- **Widening.** A request reaching further back loads only the missing prefix and saves it beside
  the stored rows, without comparing anything.
- **The research series is inconsistent about distributions.** It folds in MMM 2024, WDC 2025, IBM
  2021, MRK 2021, AXP 2005, and HON 2018 and 2025; whether it folds in DIS 2007 is undetermined.
- **Backtests** fill at the same day's research close, with fractional shares and no costs. A run
  reads its data in calendar-year windows after one preparation step and pins no data generation.
- **Margin of Safety** is `(IV − researchClose) ÷ IV`, each intrinsic value a per-share quantity in
  the share basis.

## Consumers by required basis

"Required" is the basis a consumer needs to be economically right. The research close is right
for a consumer that uses only ratios of research prices, or compares research prices only with
series derived from them.

| Consumer                                                                    | Current basis                                       | Required basis                                                                                          | V1                                                                                                               |
| --------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Stock Details price chart, OHLC; latest price, day and 52-week range        | research                                            | one continuous basis                                                                                    | PR 1 keeps the stored history on one basis                                                                       |
| Daily returns, equity curve, drawdown, CAGR; backtest fills                 | research                                            | one basis for the whole run; scale-invariant otherwise                                                  | PR 1: one basis, and a generation pin per run                                                                    |
| Backtest trade prices and share counts as displayed                         | research units at execution                         | research units, labelled as such                                                                        | documentation only                                                                                               |
| Daily and weekly SMA and EMA; RSI                                           | research                                            | basis-independent within one basis                                                                      | PR 1: full rebuild on a re-base                                                                                  |
| RVOL 10/20/50                                                               | research volume, scaled by `A` across distributions | split-adjusted volume (research volume ÷ `Φ`)                                                           | not in V1: needs `Φ`. Within one basis it is consistent; a window straddling a distribution is not (known limit) |
| Price compared with a moving average                                        | research against research-derived                   | basis-independent                                                                                       | none                                                                                                             |
| Benchmark returns, execution calendar                                       | provider-adjusted price return (SPY, indices)       | a price return on the provider's basis                                                                  | no catalog series can re-base (§12)                                                                              |
| Intrinsic values; Margin of Safety; price against an intrinsic value        | share units against a close that carries `Φ`        | split-adjusted                                                                                          | B1 not fixed in V1 (§13). PR 1 keeps a forward re-base from changing them (`K`, §10)                             |
| P/E, P/S, P/B, P/FCF, EV/EBITDA                                             | —                                                   | the close and the share count on one basis                                                              | `valuation-ratios-v1.md`: per session with `K`, unavailable where the basis is not safe                          |
| EPS growth TTM YoY (a fundamental metric)                                   | restated EPS                                        | consistent units within one vintage                                                                     | unchanged                                                                                                        |
| Monitor observation, Signal price, `lifecycleSincePrice` (as stored)        | as-traded when live; research when reconstructed    | as-traded: a record of what was observed                                                                | none; do not compare it with later research prices                                                               |
| Monitor frame: the live quote appended to closed history                    | as-traded quote beside research history             | one basis; on an ex-date the provider has not yet re-based, a 4:1 day reads −75 % against every average | PR 1: the ex-date hold (§7)                                                                                      |
| Dashboard price and market overview; insider and congressional amounts      | as-traded; provider; as reported                    | the same                                                                                                | none                                                                                                             |
| Any future comparison of a price with an absolute number ("price above $5") | —                                                   | as-traded: the research level embeds later actions                                                      | the rule in §2                                                                                                   |

## Decision

### 1. One research basis, kept consistent; no historical `Φ` in V1

- **The research close stays** the one stored price, for every consumer.
- **PR 1 keeps it on one basis.** A re-base is detected, the whole history is replaced in one
  transaction, and the step is recorded as a measured re-base (§7–9).
- **A per-share figure observed before a measured re-base is put back on its own basis by `K`**
  wherever it meets a close: intrinsic values in the derived rebuild (§10), and valuation ratios in
  their projection. That replaces the forward half of the earlier plan's statement unit conversion,
  with a ratio measured from FMP's own two histories instead of from revision pairs.
- **History before `verifiedAt` is not corrected.** Where the provider folded a distribution before
  FactorSage verified the security, `close × shares` carries `Φ`, and V1 has no source that measures
  it. Margin of Safety keeps that bias, disclosed (§13). Valuation ratios withhold those sessions
  (`valuation-ratios-v1.md`).
- **The hypothesis "adjusted close for trading, as-traded close for valuation" is rejected** in its
  literal form: the provider's share counts are restated, so an as-traded close times a stored
  count is wrong by `G` (AAPL 2019 ×4, AAPL 2013 ×28).

### 2. Backtests keep the research close

- **The engine is indifferent to scale.** It fills at the same day's close, holds fractional shares
  and pays no fees, so every return, position value and Strategy comparison between research series
  is the same at any constant scale.
- **The research close is continuous through share-changing actions.** All 89 splits in the horizon
  are invisible in it. At every confirmed distribution it shows no distribution-sized step, although
  single-day moves remain: MMM +6.0 % against SPY −0.2 % on 2024-04-01.
- **As-traded prices would need a share ledger.** Without one, every split would be a false crash:
  AAPL −75 % on 2020-08-31, NVDA −90 % on 2024-06-10.
- **Known limitation, recorded and not changed.** Where the provider folded a distribution into its
  series (MMM 2024), holding through the ex-date earns the distribution, as if reinvested. Where it
  did not, the distribution is lost, as a price return loses a dividend. A V1 result is a price
  return that includes most spin-offs.
- **Displayed trade prices and share counts are in research units at execution.** A later split
  changes the units a new run shows, not its returns.
- **Rule.** No Strategy predicate may compare a research price level with an absolute number: AAPL's
  2003 closes read $0.23–$0.44 for a traded $13–$25. The current catalog complies.

### 3. Share basis

- **The share basis stays the latest point-in-time quarterly `weightedAverageShsOutDil`.** It is
  present on 6,391 of 6,391 quarters, 4 not positive, and restated by `G` and by nothing else: HON's
  quarters from 2002 are restated to half by the 2026 reverse split (62 of 64 within 2 % of half the
  as-reported implied count), and the spin-offs are not restated.
- **Single-quarter anomalies (B3, 593 sessions)** stay provider data for Margin of Safety. Valuation
  ratios withhold them (`valuation-ratios-v1.md`, rule 2).
- **As-filed counts are not a product input:** 233 of 2,033 are defective.
- **Units after a split FactorSage observes.** FMP restates its statements for a split, and the
  fundamentals refresh re-reads the latest twelve quarters, so restated revisions arrive dated by
  their observation. Sessions before that use revisions observed in the old units. `K` puts the
  re-based close back on those units (§10); the window between the ex-date and the first revision
  observed after the re-base was detected is withheld, because without classification its units are
  unknown.
- **The earlier plan's statement unit conversion** (a full statement re-read on every share-changing
  event, revision pairs measuring `g`, two methods agreeing) **is not in V1.** `K` covers the forward
  case exactly from the price side; the historical case would need `Φ`.

### 4. Point-in-time semantics

| Option                                             | What it means                                                                     | Verdict                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| A. Retrospective research basis everywhere (today) | one provider-normalised series for everything                                     | kept for trading and indicators                           |
| B. As-traded everywhere                            | every session in its own units                                                    | rejected: every split is a discontinuity without a ledger |
| C. Two bases                                       | research for trading and indicators; split-adjusted for share-derived comparisons | not buildable in V1: the split-adjusted basis needs `Φ`   |

- **The research basis is retrospective.** It may be used where scale cancels: returns, ratios, and
  comparisons with series derived from the same research prices.
- **A share-derived value is right where nothing separates the close's basis from the statement's
  units:** no folded distribution after the session, and no share-changing event between the
  statement's observation and the price read. Forward, PR 1 measures what separates them and `K`
  removes it. Historically, V1 cannot measure it.
- **`K` adds no information.** It is built from later re-bases, but it only removes the provider's
  own later rescaling of the close, restoring the price as FactorSage stored it.
- **Masks are a known selection bias.** A session withheld because of a later event is unavailable
  because of something that happened after it. It never shows a wrong value.
- **Information and units are separate questions.** Which statement values were available on `D`
  stays the fundamentals loader's question (`availableFromDate`, never backdated).

### 5. Classification is not needed in V1

- PR 1 records a measured re-base's ratio and date. It does not decide whether it was a split, a
  distribution or both: `K` is exact for any of them before the event, and the window after it is
  withheld for share-derived values until statements observed after the detection exist.
- **The provider's labels, its split list and "clean-looking" ratios are never evidence of what an
  event was.** Every one failed in the stored data: six mislabelled spin-offs, two missing events,
  two mis-sized events, one entry (DIS 2007) whose presence in the prices cannot be established, and
  a combined event labelled as a spin-off whose share half the statements did restate.
- **Valuation ratios use the plain-share-change predicate one-sidedly:** an entry that fails it is
  treated as a possible distribution and masked. Over-masking is accepted; under-masking is not.

### 6. The historical basis needs an external as-traded reference, which V1 does not have

- **FMP cannot supply it.** Twelve endpoints were tested (investigation, §3). Only the declared
  dividends and insider trade prices are as-traded, and neither is a daily price. FMP's dividend
  adjustments (`adjDividend`) and its split list disagree with its own price factors, and both omit
  MMM 2024.
- **The owner decided V1 is FMP-only** (2026-10-01). No vendor is evaluated, licensed or integrated
  for V1, and nothing in V1 depends on one.
- **Kept as evidence for a later decision:** the tests a reference would have to pass (whole-cent,
  relative containment against insider trades, an independent spin-off-date source, step
  structure), the shortlist (Tiingo, Sharadar, Intrinio, CRSP) and the licence questions are in the
  investigation, §7, and in this decision's history (`b90ab7e2`).
- **Consequence:** `Φ` is unknown for history. Margin of Safety keeps B1 (§13); valuation ratios
  withhold the sessions the split list marks (`valuation-ratios-v1.md`); RVOL keeps its known
  distribution limit.

### 7. Detecting a re-base

A re-base rewrites every row before its ex-date, so the earliest stored row changes whenever one
happens, and nothing else is needed to see it. Four rules:

1. **First verification.** The first refresh or hydration that finds no `SecurityPriceBasis` row
   re-reads the security's whole stored range (one paginated read: two requests for 34 years) and
   compares it with the stored rows (§8). If they differ, the history is replaced (§9). Either way
   the basis row is created with `verifiedAt`. This repairs a history already mixed before PR 1:
   a tail refreshed after a split, or a prefix widened after one, which no single-row check sees.
2. **Earliest-row check on every price refresh.** After reading the tail, the refresh re-reads the
   earliest stored row (one small request). Changed beyond the tolerance, or missing from the
   answer, it triggers the full re-read of §8 and the tail read is not saved. The refresh runs at
   most every six hours per security, so this adds at most four small requests a day.
3. **Widening overlap.** A prefix widening extends its request through the two earliest stored rows
   and compares them before saving anything. A change triggers the full re-read instead.
4. **The ex-date hold, stateless.** The provider may publish an ex-date row in the new basis before
   it rewrites older rows (open measurement O-1). So rows after the newest stored one are saved only
   if the first of them does not move by a split-sized amount from the newest stored close (a
   ratio below 0.7 or above 1.4), or if at least four sessions of rows have arrived since it, in
   which case the move is genuine. The held rows are simply re-read by the next refresh, which
   always reaches them. A Monitor whose live quote is split-sized against the newest stored close
   treats the security as not evaluable for that cycle and does not append the quote.

- **Tolerance.** A row has changed when `|new − old| > ½u(new) + ½u(old)` in its close, with
  `u = 0.01` at or above $1 and `0.0001` below. Stored rows carry up to eight decimals, so `u` is a
  floor, not the provider's last decimal.
- **A change in the tail is a correction.** It takes today's path: the row is replaced and the
  derived state rebuilt from it. It neither bumps the generation nor triggers a full read.
- **What it does not see.** A rewrite that leaves the earliest row unchanged: a partial correction
  of old rows. Stored history then stays internally consistent on the old values, which is today's
  behaviour for old corrections (`ai/architecture/deep-discovery.md` §6). A distribution that is
  neither folded by the provider nor split-sized cannot be held, and needs no hold: it changes no
  stored row.
- **Not used:** the provider's split calendar as a hold signal (a further daily request, and it
  omits events) and a monthly full comparison (it existed to keep a classification ledger complete).

### 8. The full re-read

- **Range: from the earliest stored row, not from the retention start.** Rows outside current
  coverage exist (CRWD has rows from 2019-06-12 under coverage from 2021-08-19) and feed the derived
  rebuild and the earliest-row check, so a replacement that left them would mismatch again.
- **A complete answer only.** The paginated walk must reach the requested start. Stored rows the
  answer no longer contains are deleted with the replacement only when they are at most 1 % of the
  history; otherwise the replacement is refused, the old history kept, and the refresh retried later.
- **Segmentation.** `r(D) = stored close ÷ new close` on every common session.
  - Going back in time, a genuine event changes every earlier row by one ratio, and each earlier
    event multiplies onto it, so `r` is constant between event dates and steps only at them.
  - A step needs at least three consistent sessions on each side; its date is the first session of
    the later run, and its measured ratio is the older run's median `r` over the newer run's.
  - A block of rows whose ratio differs from both neighbours and returns to theirs is a correction,
    never an event.
  - **An undated event.** When every common row changed by one ratio, the event's ex-date fell after
    the newest stored row. It is recorded with an interval: from the newest stored session,
    exclusive, to the newest session of the read. One session wide, it is dated.
  - **Unexplained.** If more than 1 % of the common rows fit no run, the change is recorded as
    `UNEXPLAINED` over the changed range. The history is still replaced: the provider is the
    authority for the research series.

### 9. Atomic replacement and the generation

- **One transaction, under the per-security write lock,** replaces the prices from the earliest
  stored row, the daily derived rows and the weekly rows, all computed in memory from the new prices
  first; inserts the measured re-bases; bumps the generation; and updates coverage. PostgreSQL never
  commits an old early history beside a new late one, or new prices beside old indicators. It is
  about 8,600 price rows, 8,600 derived rows and 1,800 weekly rows, a cold hydration's size.
- **Redis.** The replacement is republished as a new hydration under the existing `HYDRATING` →
  `READY` swap, and the `READY` manifest carries the generation. Every yearly read re-checks the
  manifest after its `MGET`, and a manifest that is no longer `READY` with the same generation makes
  the read a miss. So a reader that passed the check just before a republish cannot combine old and
  new years.
- **Backtests.** `PREPARING_DATA` records each security's generation, and every window read checks
  that the projection it read carries the same one. A mismatch fails the run with a message that the
  provider re-based a security's history during it and that it can be run again. The pin lives in
  the attempt's memory: a run never resumes mid-way (a retry re-simulates from its first day), so
  nothing needs persisting, and the immutable run snapshot is never written after submission
  (AGENTS.md invariant 12).
- **Monitors.** A cycle reads prices from the Redis projection and the derived tail from
  PostgreSQL. It reads the PostgreSQL generation with that tail; a mismatch with the manifest the
  prices came from makes the security not evaluable for that cycle, because a Signal from a mixed
  frame would be permanent.
- **One counter.** The earlier design added a ledger version for classifications and unit
  conversions, which V1 does not make. Measured re-bases are written only with a replacement, so
  the generation covers them.

### 10. Derived rebuild

- **Prices and indicators.** A re-base rebuilds from the earliest persisted bar, because EMA and RSI
  are seeded from the series' start (AUD-02), and weekly prices are re-aggregated in full.
- **Intrinsic values carry `K`.** Each session's intrinsic values are divided by `K(t, R)`, with `R`
  the latest point-in-time Income revision (the share basis), so they meet the re-based close on the
  units their statements were observed in. Where `R` was observed before a measured re-base and the
  session is on or after it, inside its undated interval, or `R` was observed between its date and
  its detection, the session's intrinsic values are absent; an `UNEXPLAINED` re-base withholds them
  for every session that uses a revision observed before it. Margin of Safety and every price-to-value
  comparison then follow, because they are computed from those stored values.
  - Before PR 1 the same sessions were right before the ex-date (old prices, old statements) and
    wrong by the split ratio after it until restated statements arrived. With PR 1 they stay right
    before it, and the window after it is withheld rather than wrong.
  - With no measured re-base, `K = 1` and nothing changes. The store has none today.
- **Nothing else takes `K`.** Fundamental Metrics are ratios of statement figures, and price-derived
  series are research-only.
- **Redis:** every year is republished under the new generation.

### 11. Reproducibility

- **The contract is unchanged.** A completed run's stored results never change, and a new run may
  differ after the provider changes data (`ai/product/backtests.md`). A re-base is such a change.
- **Changing an interpretation is different.** PR 1 changes one: intrinsic values carry `K` and are
  withheld in a re-base's window. So PR 1 adds `priceBasisRevision` to `BACKTEST_DATA_REVISIONS`, and
  a queued run is refused rather than executed under a new rule with an old stamp. Valuation ratios
  record their own methodology revision (`valuation-ratios-v1.md`).

### 12. Benchmark, weekly prices and Stock Details

- **Benchmark.** Every catalog series is an index (`^GSPC`, `^DJI`, `^VIX`) or SPY, which has not
  split since 1993, so none can be re-based by a share-changing action. V1 leaves the benchmark
  loader unchanged. A benchmark series that can split (another ETF proxy) needs this detector, a
  generation and an atomic read before it is added: `BenchmarkDataCache` has no `HYDRATING`/`READY`
  manifest today.
- **Weekly prices** stay research-only and are rebuilt with the daily ones.
- **Stock Details** keeps the research close; its intrinsic-value overlays and chips read the stored
  values, which carry `K` after a measured re-base. Valuation ratios get their own series
  (`valuation-ratios-v1.md`). No second price line.
- **Signals keep the price they were observed at.** After a later action that price no longer
  matches the chart. This is correct, and the documentation says so.

### 13. Margin of Safety

Margin of Safety has two defects around distributions. Neither is fixed in V1, by the owner's
decision that it is a separate problem.

- **B1, the price basis (historical).** Every intrinsic value is a per-share figure in current share
  units, and the comparison uses a research close that carries `Φ` (investigation, §5.1).
  - 34,077 sessions (10.8 % of those with a value) and 211,653 values are overstated, in six of 62
    securities; intrinsic value ÷ price is overstated by exactly `Φ`, from 1.046 to 2.120; the
    median overstatement is 18.0 points; `Value & Trend`'s BUY condition is falsely true on 4,664 of
    28,720 affected sessions and its SELL condition falsely false on 4,557.
  - The fix needs `Φ` per session, hence the external reference (§6). **Not in V1.**
  - At the live edge `Φ = 1`, so B1 does not touch today's value.
- **Statement content after a distribution (live and historical).** After a distribution the
  statements still describe the company before it until new filings reflect the separation.
  MMM's DDM stayed at 81.65–81.75 on the pre-spin dividend from 2024-04-01 to 2024-07-26; HON's
  Balanced Margin of Safety read +14.3 % on 2026-09-24 from one quarter (Q2 2026, 2.4 times any
  other HON quarter since 2016). This needs its own intrinsic-value methodology decision. Open.
- **What PR 1 changes.** Nothing for sessions with no measured re-base. After one, intrinsic values
  carry `K` (§10), which keeps every session before the event exactly as it was, and withholds the
  window after it until statements observed after the detection arrive. For a distribution that
  window is also the start of the statement-content window above; that defect is otherwise
  unchanged.
- **Interim product behaviour: a disclosure** covering both defects, in the Margin of Safety
  description, on backtest results whose Strategy uses it or a price-to-value comparison, and beside
  the intrinsic-value history on Stock Details. It is a separate small change (PR 0), not made here.
  A partial mask would present the rest as verified, and disabling the history would remove a core
  feature whose history is right on 89 % of the stored sessions that have a value.

### 14. What valuation ratios take from this decision

- **The research close on one basis per generation** (§7–9), so no computation mixes two bases.
- **Measured re-bases with their ratios, dates or intervals, and detection times**, read with the
  generation they belong to, from which `K` and the withheld windows follow.
- **`verifiedAt`**, which separates the history FMP's split list must speak for from the events PR 1
  measures.
- **The generation pin** of backtests and the generation check of Monitors.
- **The ex-date hold** for a Monitor's live quote.
- **Not needed:** `Φ`, classification, statement unit conversion, an external reference, a
  per-session factor column, a displayed as-traded price, a total-return methodology or SEC share
  data.

## Data model

| Option                                    | Verdict                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| 1. `asTradedClose` column on `DailyPrice` | no source in V1                                             |
| 2. Separate reference-price table         | no source in V1                                             |
| 3a. Per-session factor column             | redundant: a re-base is one ratio for a run of rows         |
| **3b. Per-security event records**        | **chosen**: a few rows per security, each with its evidence |
| 4. Replace the close with as-traded       | breaks every split (−75 % AAPL, −90 % NVDA)                 |

**Schema (PR 1):**

- **`SecurityPriceBasis`**, one row per security: `generation`, `verifiedAt`, `updatedAt`.
- **`PriceBasisEvent`**, append-only, one row per measured step: `securityId`, `generation` (the
  replacement that recorded it), `kind` (`MEASURED` or `UNEXPLAINED`), `effectiveDate` (the first
  session of the new basis, null when undated), `effectiveFrom` (exclusive) and `effectiveTo`
  (inclusive) for an undated event or an unexplained range, `priceRatio` (null when unexplained),
  `detectedAt`, and `evidence` (JSON: run lengths and the sessions compared).
- **The Redis manifest** gains `priceBasisGeneration`.
- **No change to `DailyPrice`, `WeeklyPrice` or `PRICE_DATASET_VERSION`.**

PR 2V adds FMP's stored split list (`valuation-ratios-v1.md`). Nothing in V1 stores a valuation per
session, a classification, a ledger version, a per-attempt pin or a vendor price.

### Storage estimate

- **`DailyPrice`:** 368,857 rows in 100.1 MB with indexes, 271 B a row. **Redis:** MSFT's 8,571 rows
  take 1.35 MB of row JSON, 158 B a row.
- **The event records** are below 1 KB per security in PostgreSQL, and the manifest field a few
  bytes in Redis. A full replacement rewrites a cold hydration's rows.

## Alternatives rejected

| Alternative                                                                | Why not                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A second provider or a purchased as-traded series                          | the owner's FMP-only decision for V1                                                                                    |
| Correct the close with the provider's split list                           | it omits, mis-sizes and mislabels events (investigation, §2.2)                                                          |
| The provider's `non-split-adjusted` series as the as-traded close          | the adjusted series times that same list                                                                                |
| `Φ` from insider prices or FMP's dividend factors                          | sparse, approximate, and disagreeing with the price factors; the owner excluded approximated history                    |
| Provider market-cap, enterprise-value, ratio or key-metric history         | computed from the adjusted close (MMM 2024-03-28 = 88.68 × 555.0 M); rewritten after the fact; dated before publication |
| Statement unit conversion from revision pairs (the earlier PR 2)           | `K` restores the forward basis exactly from the price side, with no full statement re-read and no pairing rule          |
| Repairing the tail's step heuristically                                    | a spin-off of 4 % cannot be told from a market move; only a held save plus a comparison can tell a re-base from a move  |
| The provider's split calendar as a hold signal; a periodic full comparison | a further dataset or request stream for cases the earliest-row check and the stateless hold already cover               |
| A generation bump on every one-row correction, with a settling delay       | protected frozen valuation anchors, which V1 does not have                                                              |
| A per-attempt pin table outside the snapshot                               | a run never resumes mid-way, so the attempt's memory is enough                                                          |
| A `PRICE_DATASET_VERSION` bump per re-base                                 | global, manual, and re-reads every security for one event                                                               |
| Frozen per-run data snapshots                                              | not required by the reproducibility contract; costly                                                                    |
| As-traded execution with a share ledger                                    | a missed event becomes a catastrophic return (§2)                                                                       |

## Gate result

| #   | Condition                                    | Result                              | Evidence                                                                                                                                                                                   |
| --- | -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A canonical as-traded source exists          | **not proven**                      | FMP has none. Alpha Vantage's raw close is validated for IBM only, through a demo key. Tiingo, Sharadar, Intrinio and CRSP document one, unvalidated.                                      |
| 2   | Its licence suits a paid product             | **not proven**                      | Tiingo publishes a display plan; derived-metric scope unconfirmed. The others are by quotation or written permission. FMP's own display rights are open (O11).                             |
| 3   | 30-year coverage                             | **not proven**                      | Claimed by Tiingo (1962), Intrinio (50+ years) and CRSP (1925); Sharadar from 1998; Alpha Vantage from 1999-11 (89.7 % of IBM's horizon).                                                  |
| 4   | Split and spin-off examples validate         | **not proven**                      | Splits validate everywhere. For spin-offs, IBM validates against an independent series; MMM, WDC, HON, AXP and MRK only against insider prices, to about ±0.5 %. DIS 2007 is undetermined. |
| 5   | The share basis is coherent                  | **yes**                             | `G` equals the share-changing ratios (§3).                                                                                                                                                 |
| 6   | Point-in-time semantics are defensible       | **yes, with stated qualifications** | §4.                                                                                                                                                                                        |
| 7   | The backtest basis can remain stable         | **yes**                             | §2.                                                                                                                                                                                        |
| 8   | Re-base detection is specified               | **yes**                             | §7–9, re-scoped on 2026-10-01; both orders of O-1 are handled and tested.                                                                                                                  |
| 9   | The Margin of Safety correction is specified | **for B1 only, and not in V1**      | §13.                                                                                                                                                                                       |
| 10  | No major clean-room objection remains        | **yes, after corrections**          | "Review".                                                                                                                                                                                  |

Conditions 1–4 fail, and under the FMP-only decision they are not pursued in V1. They gate only what
needs `Φ`: Margin of Safety's historical correction, split-adjusted RVOL and any historical
valuation the split list does not mark as safe. PR 1 depends on condition 8 only.

## Implementation plan

### What the earlier PR 1 contained, and what V1 keeps

Classes: **A**, required for the correctness of existing FactorSage behaviour; **B**, required for
forward valuation; **C**, required only by the abandoned `Φ`/vendor reconstruction or the frozen
anchors; **D**, unnecessary in V1.

| Earlier PR 1 component                                      | Class | V1                                                                                                   |
| ----------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------- |
| Basis row and event records                                 | A, B  | built: `SecurityPriceBasis`, `PriceBasisEvent`                                                       |
| A second counter, the ledger version                        | C     | dropped: nothing classifies or converts                                                              |
| Overlap test on the tail read                               | D     | dropped: the earliest-row check sees every full-history re-base                                      |
| Overlap test on a prefix widening                           | A     | built (§7, rule 3)                                                                                   |
| Session anchor (the earliest stored row, re-read)           | A     | built, on every price refresh (§7, rule 2)                                                           |
| Ex-date hold on a split-sized move                          | A     | built, stateless (§7, rule 4), and for the Monitor's live quote                                      |
| Ex-date hold from the provider's split calendar             | D     | dropped                                                                                              |
| Periodic full comparison                                    | D     | dropped                                                                                              |
| Full re-read from the earliest stored row                   | A     | built (§8)                                                                                           |
| Structured segmentation with measured ratios                | A, B  | built (§8): `K` for intrinsic values (A) and valuation (B)                                           |
| Undated intervals for events between two reads              | A, B  | built (§8)                                                                                           |
| `UNEXPLAINED` changes and the withheld values they imply    | A     | built (§8, §10)                                                                                      |
| Single-transaction replacement                              | A     | built (§9)                                                                                           |
| The generation in the manifest; atomic chunk reads          | A     | built (§9)                                                                                           |
| Per-attempt data pins outside the run snapshot              | A     | built in the attempt's memory; the pin table was C (anchor versions) and is dropped                  |
| Counter-consistent Monitor reads                            | A     | built (§9)                                                                                           |
| Benchmark generation and atomic read                        | D     | not needed while no catalog benchmark can re-base (§12)                                              |
| `NOT_EVALUABLE` before a pending or unexplained event       | A     | built as `K` with withheld windows (§10)                                                             |
| `priceBasisRevision`                                        | A     | built (§11)                                                                                          |
| `observedSince` from a verified read                        | A, B  | built as `verifiedAt`, by the first verification that also repairs a pre-existing mixed history (§7) |
| A settling delay, and a generation bump on every correction | C     | dropped                                                                                              |

### Pull requests

| PR                                | Scope                                                                                                                      | Depends on         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| **1. Re-base-safe price loading** | the A and B components above, with their tests                                                                             | nothing            |
| **2V. Valuation Ratios V1**       | `valuation-ratios-v1.md`: FMP's split list, the per-session calculation and its rules, Strategy, backtest, Monitor and API | PR 1               |
| 0. Margin of Safety disclosure    | copy only (§13)                                                                                                            | nothing; optional  |
| Not in V1                         | the external reference, historical `Φ`, statement unit conversion, Margin of Safety's split-adjusted basis, RVOL on it     | a post-V1 decision |

### Open measurements

None blocks PR 1 or PR 2V. Each is real-world validation of behaviour the tests already pin for both
outcomes; record the observation, and compare it with what the code did.

- **O-1: does the provider publish an ex-date row before it rewrites the older rows?** Re-read the
  rows in `docs/historical-price-basis/evidence/rebase-observation-baselines.csv` daily around GPMT's
  1:10 on 2026-10-06 and DXJ's 3:1 on 2026-10-09: when the ex-date row appears, when the earliest
  row changes, whether they change together. If the row comes first, the hold (§7, rule 4) carries
  the gap; if not, it never fires.
- **O-2: does the provider restate statements before the ex-date?** GPMT is the one of the two with
  statements. If it does, valuation's rule 3 withholds the restated revision until the re-base is
  measured; if not, the rule never fires.
- **Volume across distributions: answered.** The provider scales volume by `A`, distributions
  included (IBM's stored volume is exactly 1.046 × raw before Kyndryl).

## Tests the implementation needs

- **Detection:** a full-history re-base found by the earliest-row check, the tail read discarded; a
  re-base found by the first verification of a history mixed before PR 1 (tail after a split; prefix
  after a split); a prefix widening after a re-base, refused and replaced; a one-row correction in
  the tail, which neither bumps the generation nor triggers a full read; an earliest row missing
  from the provider's answer.
- **The hold:** an ex-date row published before the rewrite (held; then the rewrite replaces
  everything); the same row with no rewrite (saved after four sessions); a genuine crash; a Monitor
  quote that is split-sized against the stored close.
- **Segmentation:** a split, a reverse split, a spin-off ratio, two events between two reads, a
  correction block, an undated event (dated when one session wide), an unexplained change, a
  provider date on a weekend.
- **Replacement:** rows older than coverage replaced with the rest; rows missing from a complete
  answer deleted within 1 % and refused beyond it; prices, derived rows, weekly rows, events and the
  generation committed in one transaction.
- **`K`:** intrinsic values before a measured re-base equal their pre-PR 1 values; the window after
  it is withheld until a revision observed after the detection; an undated interval withholds; an
  unexplained change withholds for revisions observed before it; no re-base, no change.
- **No mixed data:** a concurrent reader during a replacement; a backtest that crosses a replacement
  fails, and its snapshot never changes; a Monitor cycle that meets one is not evaluable.
- **Existing guarantees still hold:** no provider call in the backtest loop; identical frames from
  the same generation; queued runs refused across the `priceBasisRevision` bump.

## Operational risks and deployment

- **The first verification** re-reads each security's history once, on its first refresh after the
  deploy: two requests per security through the existing FMP gate.
- **Re-base storms.** A provider-wide recomputation would trigger many full reads, through the same
  gate. One full read is two requests and about 2 s of CPU.
- **Holds.** A split-sized move leaves a security's newest rows unsaved for up to four sessions if
  the provider never rewrites, and a Monitor not evaluable on those days. A genuine crash of that
  size is the cost.
- **Mid-run failures.** A backtest crossing a replacement fails and must be run again. The chance
  grows with the number of securities in a run; a single security re-bases about once in twenty
  years.
- **The current vendor.** Every basis here is FMP's, and FMP's display rights for a paid product are
  an open owner input (O11 in `docs/legal/owner-inputs-and-review.md`).
- **Deployment.** One additive migration. The new manifest field makes every manifest non-current,
  so each security's projection rebuilds from PostgreSQL: no provider traffic, but a stop-then-start
  deploy. The `priceBasisRevision` bump refuses queued runs once.

## Quantitative summary

| Measure                                            | Value                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Affected securities in the store                   | 6 of 62 with statements (9.7 %); none found among the other 56, all scanned                                                                           |
| Affected sessions                                  | 35,234 of 332,294 in the horizon (10.6 %); 34,077 of the 315,524 with a Margin of Safety value (10.8 %)                                               |
| Built-in `Value & Trend`                           | BUY margin condition falsely true on 4,664, SELL falsely false on 4,557, of 28,720 affected sessions                                                  |
| Market-wide estimate                               | 36–37 of 230 US large caps (about 16 %) carry a provider-listed price-only candidate since 1996-09-30; an estimate, since the list omits events (MMM) |
| Maximum price-basis divergence                     | `Φ` = 2.120 (HON before 2018-10-01): `close × shares` is 47.2 % of the true value                                                                     |
| Valuation sessions withheld by the split-list rule | 36,312 of 332,294 (10.9 %) for P/E, P/S and P/FCF; 36,383 for P/B and EV/EBITDA (`valuation-ratios-v1.md`)                                            |
| PR 1 storage                                       | below 1 KB per security in PostgreSQL; one manifest field in Redis                                                                                    |
| PR 1 provider requests                             | two per security once (first verification); at most four small ones a day per refreshed security (earliest-row check); two per re-base                |

## Review

**First clean-room review (2026-09-30).** It accepted the blocked result and the core design (two
bases, an event ledger, classification by measured `g`, replacement with generations), the identity
`researchClose × Φ = asTradedClose ÷ G`, the independence of the insider and Alpha Vantage evidence
and the engine's scale invariance. Its fifteen findings (F1–F15) were applied: the ex-date hold, the
overlap test on widening, replacement from the earliest stored row, the Monitor's live quote,
statement content after a distribution, measured unit conversion, the ledger version pin, the
dividend method's noise, RVOL's volume scaling, segmentation, containment counts, point-in-time
qualifications, the benchmark cache, licensing and the reference tests. Of these, the hold, the
widening overlap, the replacement range, the Monitor guard and segmentation are in V1's PR 1; the
rest concern the historical basis and are not in V1.

**Second clean-room review (2026-10-01).** It checked the frozen-anchor valuation design and added
undated intervals, `observedSince` from a verified read, per-attempt pins outside the run snapshot,
and the correction trigger. V1 keeps the first three (as undated intervals, `verifiedAt`, and an
in-memory pin) and drops the correction trigger with the anchors it protected.

**FMP-only revision (2026-10-01, evening).** The owner's decision removed the vendor, historical
`Φ`, the anchors and the historical backfill; "Implementation plan" records what each earlier
component became. The earlier text of this decision is in the history at `b90ab7e2`.

## References

- `docs/historical-price-basis/INVESTIGATION.md` and `docs/historical-price-basis/evidence/`
- `docs/decisions/valuation-ratios-v1.md`
- `docs/valuation-ratios-gate/INVESTIGATION.md`
- `docs/decisions/complete-price-coverage.md`, `intrinsic-value-engine.md`,
  `fundamentals-loader.md`, `backtest-run-persistence.md`
- `ai/architecture/deep-discovery.md` §6 and §15, `ai/product/backtests.md`,
  `ai/architecture/production-capacity.md`

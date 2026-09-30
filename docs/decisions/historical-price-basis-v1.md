# Historical Price and Corporate-Action Basis V1

## Status

**Blocked.** The design below is proposed. None of it is accepted, and nothing is implemented.

- **The gate failed on the external data** (see "Gate result").
  - FactorSage cannot measure the price-only adjustments in history without an as-traded
    reference series.
  - FMP has none.
  - No candidate source has been validated against the event set.
  - No candidate's licence has been confirmed for a paid product.
- **What is decided by evidence** is the rest:
  - the two price bases;
  - the factor model;
  - the share basis;
  - the point-in-time semantics;
  - how the loader detects and replaces a re-based history;
  - what the backtest trades on.
- **Two pieces do not depend on the data decision** (plan, PRs 1 and 2):
  - re-base-safe loading;
  - statement unit conversion.

  They address blocker B2 for price-derived series. The clean-room review found holes in their
  first specification, and those are corrected below (see "Review").
  - PR 1 still waits for one observation: whether the provider publishes an ex-date row before it
    rewrites the older ones (O-1, GPMT on 2026-10-06).
  - PR 2 waits for the restatement-timing measurement (O-2).
  - The historical basis, the Margin of Safety correction and the valuation ratios wait for the
    data decision.

- **The Margin of Safety correction specified here covers B1 only.** Statements that still
  describe a company as it was before a distribution are a second defect, open (section 13).

This decision builds on the documents below and does not reinterpret them:

- `valuation-ratios-v1.md`, which is blocked on this prerequisite;
- `complete-price-coverage.md`, for what a price coverage interval means and how it is
  revisioned;
- `intrinsic-value-engine.md` and `fundamentals-loader.md`, for share counts and statement
  revisions;
- `backtest-run-persistence.md` and `ai/product/backtests.md`, for what a run promises.

The prior gate's evidence is `docs/valuation-ratios-gate/INVESTIGATION.md`. This decision's
evidence is `docs/historical-price-basis/INVESTIGATION.md`.

## Context

FactorSage stores one daily price per session: FMP's adjusted close from
`historical-price-eod/full`. Everything uses it:

- the chart, the indicators and the backtest engine;
- Margin of Safety, which compares it with per-share intrinsic values built from statement
  share counts;
- the four valuation ratios, which are blocked on it.

The valuation gate established nine facts, and this investigation re-measured them with a
stronger test:

1. The stored close is the provider's adjusted series.
2. That series is not only split-adjusted: it folds in most spin-offs and distributions as if
   they were splits.
3. Statement share counts follow share-changing actions and not those price-only adjustments.
4. So `close × shares` is low before every such adjustment: by 4.4 % (IBM) to 52.8 % (HON).
5. Margin of Safety is biased the same way.
6. The provider's split list omits, mis-sizes and mislabels those adjustments.
7. Its "unadjusted" series is derived from that list and cannot check it.
8. The loader re-reads only a recent tail, so a re-base after first load leaves mixed bases in
   stored history.
9. Insider trade prices are the only as-traded evidence stored, and they are sparse.

Two questions follow:

- **Which price basis does each consumer need?** The adjustments that make a chart and a backtest
  continuous are exactly the ones that break a comparison with a share count.
- **How does the loader stay on one basis when the provider re-bases history?**

## Terminology

These terms are exact. Code and documents use them and nothing looser: not "raw price", "real
price" or "corrected price".

- **Session `D`.** An exchange trading day.
- **Research close**, `researchClose(D)`. The value in `DailyPrice.close`: the provider's
  adjusted close as of the last full read of the security's history.
  - It is continuous through share-changing actions, and through the price-only adjustments the
    provider chose to fold in.
  - It is not adjusted for ordinary cash dividends.
  - Its unit is dollars per current research share.
  - Research open, high, low and volume are the same series' other fields.
- **As-traded close**, `asTradedClose(D)`. The official closing price printed for the security on
  `D`, in the share units outstanding on `D`. It never changes after the session settles, except
  for a genuine correction.
- **Split-adjusted close**, `splitAdjustedClose(D)`. The as-traded close divided by every
  share-changing ratio with an ex-date after `D`.
  - It is continuous through share-changing actions and **not** through distributions.
  - It is the price basis of the provider's restated statement share counts.
  - The provider's own "split-adjusted" label does not mean this, because its series also folds
    in distributions.
- **Share-changing action.** Each holder's share count changes by a ratio `k` and no value leaves
  the security: a forward split, a reverse split, a stock dividend, or a distribution of the same
  company's shares (GOOG class C, 2014, which is share-changing for the all-class statement
  count). The as-traded price moves by `1/k`.
- **Distribution (price-only action).** Value leaves the security to its holders while the share
  count does not change: a spin-off, or a special distribution of cash or other property. The
  as-traded price falls by the value distributed.
- **Combined event.** A share-changing action and a distribution with the same ex-date: HON
  2026-06-29, HLT 2017, MSI 2011.
- **Total adjustment factor**, `A(D) = asTradedClose(D) ÷ researchClose(D)`. Piecewise constant.
  It steps only at the ex-dates of events the provider folded into its series.
- **Share factor**, `G(D)`. The product of the share-changing ratios with an ex-date after `D`.
  - Operationally, it is the factor by which the provider restated a statement share count, which
    is what is measured.
  - A filed count is in the units of its filing date, because issuers restate for a split before
    they file. The ratios that separate it from session `D` therefore run over (filing date,
    `D`], not (period end, `D`].
- **Distribution factor**, `Φ(D) = A(D) ÷ G(D)`. The product of the provider's price-only factors
  with an ex-date after `D`. It is 1 wherever the provider folded nothing but share-changing
  actions into the series after `D`.
- **Identities.**

  ```text
  splitAdjustedClose(D) = researchClose(D) × Φ(D) = asTradedClose(D) ÷ G(D)
  ```

- **Basis event.** One step in `A` at one ex-date. It records a price ratio `a` (A before ÷ A
  after), a share ratio `g`, and a distribution ratio `φ = a ÷ g`.
- **Basis generation.** A per-security integer that increases whenever the stored research
  history is replaced after a basis event.
- **Ledger version.** A per-security integer that increases on any ledger insert,
  classification or unit conversion. Each of those can change `Φ`, a statement's units or a mask
  without replacing a price.
- **Share basis.** The latest point-in-time quarterly `weightedAverageShsOutDil`, in current
  research share units: restated by the provider for every share-changing action known to it.
- **Re-base.** The provider rewriting a security's history for a new basis event.

## Current semantics

As implemented at `79fa8509`; the evidence is in the investigation, §1.

- **The provider read.** `historical-price-eod/full`, walked to completeness. Nothing else about
  prices is read: no split, dividend or unadjusted endpoint is called by any product path.
  `StockDataset` declares `DIVIDEND` and `STOCK_SPLIT`, but nothing writes them.
- **Storage.** `DailyPrice` holds one row per session: research open, high, low, close, volume
  and VWAP.
  - Coverage is revisioned by `PRICE_DATASET_VERSION` (3), and nothing records which provider
    basis a row was read under.
  - Derived state (`DailyDerivedState`, `WeeklyPrice`) is a function of those rows and the
    statements.
- **Refresh.** Only the recent tail is re-read. The tail starts ten calendar days before the
  earlier of today and the previous tail.
  - Returned rows replace stored ones by date in one transaction.
  - Derived state is rebuilt from the earliest changed date in a second transaction.
  - Redis years are republished one key at a time.
  - A re-base therefore changes the tail and leaves the rest of the history on the old basis.
- **The research series is inconsistent about distributions.**
  - It folds in MMM 2024, WDC 2025, IBM 2021, MRK 2021, AXP 2005, and HON 2018 and 2025.
  - Whether it folds in the provider's DIS 2007 entry is undetermined.
  - For the spin-offs before insider coverage (AXP 1994, MMM 1996, MRK 2003) it cannot be
    determined from stored data.
- **Backtests** fill at the same day's research close, with fractional shares and no costs. A
  run reads its data in calendar-year windows after one preparation step and pins no data
  generation. The result is a price return: dividends are not modelled.
- **Margin of Safety** is `(IV − researchClose) ÷ IV`. Each intrinsic value is a per-share
  quantity in the share basis.

## Consumers by required basis

"Required" is the basis a consumer needs to be economically right. The research close is right
for a consumer that uses only ratios of research prices, or compares research prices only with
series derived from them.

| Consumer                                                                    | Current source                                        | Current basis                                                                                                               | Required basis                                                                                                                                                                                                                                | Change needed                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Stock Details price chart, OHLC                                             | `DailyPrice` → Redis → `/stocks/:symbol`, `/prices`   | research                                                                                                                    | split-adjusted for continuity; distribution treatment needs further decision                                                                                                                                                                  | none now; documented                                                            |
| Latest price, change, previous close, day and 52-week range                 | the latest `prices[]` rows                            | research                                                                                                                    | research, like the chart: a display series. It equals split-adjusted only when no distribution falls inside the window (HON's does today)                                                                                                     | none; a display decision, recorded                                              |
| Daily returns: holdings value, equity curve, annual returns, drawdown, CAGR | frame `close`                                         | research                                                                                                                    | a total return is the economic truth; V1 is a price return by product decision; needs further decision                                                                                                                                        | none; the distribution inconsistency is documented                              |
| Backtest fill price, BUY and SELL execution, terminal liquidation           | frame `close`                                         | research                                                                                                                    | basis-independent: fractional shares, no costs and same-day fills make returns scale-invariant; the series must be one basis for the whole run                                                                                                | a pin of the basis generation and ledger version                                |
| Backtest trade prices and share counts as displayed                         | `BacktestTrade`                                       | research units at execution                                                                                                 | research units, labelled as such                                                                                                                                                                                                              | documentation only                                                              |
| Daily SMA and EMA; weekly SMA and EMA                                       | `DailyDerivedState`, `WeeklyPrice`                    | research                                                                                                                    | basis-independent within one basis; wrong across a mixed-basis step                                                                                                                                                                           | full rebuild on a re-base                                                       |
| RSI 7/14/21                                                                 | `DailyDerivedState`                                   | research                                                                                                                    | basis-independent within one basis                                                                                                                                                                                                            | full rebuild on a re-base                                                       |
| RVOL 10/20/50                                                               | `DailyDerivedState` from `volume`                     | research volume. The provider scales volume by `A`, distributions included: stored IBM volume is 1.046 × raw before Kyndryl | **split-adjusted volume** (research volume ÷ `Φ`). A window that straddles a distribution is biased by up to `Φ`: 4.6 % for IBM, and up to ×0.52 for HON 2026, whose pre-event volume was scaled by 0.9532 instead of the reverse split's 0.5 | **yes**, through the ledger; full rebuild on a re-base                          |
| Price compared with a moving average                                        | frame                                                 | research against research-derived                                                                                           | basis-independent                                                                                                                                                                                                                             | none                                                                            |
| Benchmark returns, execution calendar                                       | `BenchmarkDailyPrice` (SPY), same endpoint            | provider-adjusted price return                                                                                              | a price return on the provider's basis, like the portfolio                                                                                                                                                                                    | the same detector; its own generation and atomic read (section 9)               |
| Intrinsic values (DCF, RI, DDM, Graham, blends)                             | statements: restated shares, EPS, dividends per share | current research share units                                                                                                | split-adjusted share units                                                                                                                                                                                                                    | unit conversion for a revision observed before a later share-changing event     |
| Margin of Safety: frame, Stock Details, backtests, Monitors                 | IV against `close`                                    | IV in share units; the close carries `Φ`                                                                                    | **split-adjusted**                                                                                                                                                                                                                            | **yes**                                                                         |
| Price compared with an intrinsic value; IV overlays on the chart            | frame `close` against IV; chart overlays              | as Margin of Safety                                                                                                         | **split-adjusted**, or IV ÷ `Φ` on the research scale                                                                                                                                                                                         | **yes**                                                                         |
| P/E, P/S, P/FCF, EV/EBITDA (planned)                                        | —                                                     | —                                                                                                                           | **split-adjusted** close × share basis                                                                                                                                                                                                        | blocked                                                                         |
| EPS growth TTM YoY (a fundamental metric)                                   | restated EPS                                          | share units, consistent within one vintage                                                                                  | split-adjusted share units                                                                                                                                                                                                                    | unit conversion across a later share-changing event                             |
| Stock Details "price vs value" chips                                        | the latest close against the latest IV                | price basis right today, since `Φ(today) = 1`                                                                               | split-adjusted, which equals research today                                                                                                                                                                                                   | none for the price basis. Statement content can lag a distribution (section 13) |
| Monitor observation, Signal price, `lifecycleSincePrice` (as stored)        | live quote, or the research close at reconstruction   | as-traded when live; research when reconstructed                                                                            | **as-traded**: a record of what was observed                                                                                                                                                                                                  | none for the stored record; do not compare it with later research prices        |
| Monitor frame: the live quote appended to closed history                    | live quote plus Redis history                         | as-traded quote beside research history                                                                                     | one basis. On an ex-date the provider has not yet re-based, the quote is post-event and the history is not (a 4:1 day reads −75 % against every moving average)                                                                               | **yes**: the ex-date hold (section 7)                                           |
| Monitor state reconstructed from history                                    | historical frame                                      | as each operand                                                                                                             | as each operand                                                                                                                                                                                                                               | follows Margin of Safety                                                        |
| Dashboard price and market overview                                         | live quote; benchmark index series                    | as-traded; provider                                                                                                         | as-traded; provider                                                                                                                                                                                                                           | none                                                                            |
| Insider and congressional money amounts                                     | disclosures                                           | as reported                                                                                                                 | as reported                                                                                                                                                                                                                                   | none                                                                            |
| Any future comparison of a price with an absolute number ("price above $5") | —                                                     | —                                                                                                                           | **as-traded**: the research level embeds later actions                                                                                                                                                                                        | a rule, below                                                                   |

**No single stored column serves every consumer.** The research close is right for the chart,
the indicators and the engine. The split-adjusted close is right for every comparison with a
share count or per-share figure. The as-traded close is needed only to measure `Φ` and for
absolute price levels, which no consumer compares today.

## Decision

### 1. Two bases and one event ledger

- **The research close stays.** `DailyPrice.close` keeps its meaning, and every consumer that
  needs the research basis keeps it: the chart, the price indicators, weekly prices, the backtest
  engine and the benchmark.
- **RVOL moves to split-adjusted volume** (research volume ÷ `Φ`). The provider scales volume by
  the same factor as price, distributions included.
- **Every comparison of a price with a share count or a per-share figure uses the split-adjusted
  basis:**
  - Margin of Safety is `(IV − researchClose × Φ) ÷ IV`.
  - A price compared with an intrinsic value, and an intrinsic-value overlay on the chart, use
    `IV ÷ Φ` on the research scale. The price series then stays continuous, and the comparison
    equals the one on the split-adjusted scale.
  - A market capitalisation is `researchClose × Φ × shareBasis`.
- **`Φ` is kept as a per-security basis-event ledger, not as a per-session column.**
  - `A` is piecewise constant. IBM's independent series shows one step in 22 years and matches
    the stored close within cent rounding on 98.7 % of 6,450 sessions; the exceptions are vendor
    disagreements, not steps (investigation, §2.4).
  - So a handful of events per security carry the whole basis. The stored set has 97 provider
    entries across 62 securities in 30 years.
  - Each event keeps its evidence.
- **The as-traded close is a measurement input.** It measures `A` in history. It becomes a stored
  per-session column only if a consumer of absolute price levels is ever added (section 4).
- **The hypothesis "adjusted close for trading, as-traded close for valuation" is rejected in
  its literal form, and kept in substance.**
  - The provider's share counts are restated, so an as-traded close times a stored share count
    is wrong by `G`: AAPL 2019 ×4, AAPL 2013 ×28.
  - Valuation needs the split-adjusted close, which pairs with the stored share basis. The
    as-traded close is what `Φ` is measured from.

### 2. Backtests keep the research close

- **The engine is indifferent to scale.** It fills at the same day's close, holds fractional
  shares and pays no fees (`same-day-close/fractional-shares/…@3`, `zero-fees/zero-slippage@1`).
  So every return, every position value and every Strategy comparison between research series
  is the same at any constant scale.
- **The research close is continuous through share-changing actions.** All 89 splits in the
  horizon are invisible in it. At every confirmed distribution it shows no distribution-sized
  step, although single-day moves remain: MMM +6.0 % against SPY −0.2 % on 2024-04-01.
- **As-traded prices would need a share ledger.** Without one, every split would be a false
  crash: AAPL −75 % on 2020-08-31, NVDA −90 % on 2024-06-10. A ledger that must list every
  share-changing action of every security, and turns each missed one into a catastrophic
  return, is not justified.
- **Known limitation, recorded and not changed.** Where the provider folded a distribution into
  its series (MMM 2024), holding through the ex-date earns the distribution, as if reinvested.
  Where it did not, the distribution is lost, as a price return loses a dividend. The provider
  lists DIS 2007 without clearly folding it in, so whether it did is undetermined.
  - So a V1 result is a price return that includes most spin-offs.
  - A total-return methodology would need its own decision and a dividend-and-distribution
    ledger.
- **Displayed trade prices and share counts are in research units at execution.** A later split
  changes the units a new run shows. Its returns stay the same, except where a Strategy compares
  rounded restated per-share figures (section 4).
- **Rule.** No Strategy predicate may compare a research price level with an absolute number,
  because the research level embeds later actions: AAPL's 2003 closes read $0.23–$0.44 for a
  traded $13–$25. The current catalog complies: Price compares only with price-valued series. A
  future absolute-price metric uses `asTradedClose = researchClose × A`.

### 3. Share basis and unit conversion

- **The share basis stays the latest point-in-time quarterly `weightedAverageShsOutDil`.**
  - The investigation re-validates it: present on 6,391 of 6,391 quarters, 4 not positive.
  - It is restated by `G` and by nothing else.
    - HON's quarters from 2002 give 0.48–0.51 by the dividend method, and 62 of 64 give half of
      net income ÷ diluted EPS as reported (the clean-room check).
    - The spin-offs give about 1.
    - The prior gate's as-reported probe gave ×4, ×10, ×20 and ×28 across splits.
  - Its single-quarter anomalies (B3, 593 sessions) stay provider data, as Margin of Safety
    already treats them. Valuation ratios decide for themselves.
  - As-filed counts are not a product input: 233 of 2,033 are defective.
- **Unit conversion changes units, never information.**
  - A revision whose units are older than the current price basis has its per-share fields
    converted at materialization: share counts × `g`, EPS ÷ `g`, dividends per share ÷ `g`.
  - It keeps its `availableFromDate`.
  - Without conversion, a re-based history pairs new-unit prices with old-unit statements on
    every session before the event. That is B2's statement half.
- **A revision's units are measured, never assumed from its observation date.** The provider may
  restate before an ex-date as well as after it (O-2), and an assumption would convert twice.
  - **On every detected share-changing event, the whole statement history is re-read.**
    - The refresh re-reads only the latest twelve quarters
      (`FUNDAMENTALS_REFRESH_QUARTERLY_LIMIT`).
    - A full re-read gives every fiscal identity a revision in the new units.
    - Each new revision is dated by its observation, as `fundamentals-loader.md` requires.
  - **A pair is evidence of old units.** A revision is in the old units when a later revision of
    the same fiscal identity differs from it by the event's measured `g` (within rounding) in its
    share count and its EPS. Only such a pair licenses a conversion.
  - **An unpaired revision is not converted.** If a revision has no pair after the full re-read,
    or its pair disagrees with `g`, sessions that use it are `NOT_EVALUABLE` for share-derived
    values.
  - **Nothing stored yet tests the pairing rule.** None of the 15 multi-revision income
    identities in the development store changes a share count or an EPS. The rule is therefore
    validated on the first live event, as part of O-2.
  - **Converted and restated figures differ by rounding.** A converted revision keeps full
    precision, while the provider's restated one is rounded (restated EPS to the cent). A
    per-share value can therefore differ slightly between a converted and a re-observed
    revision (section 4).
  - **PR 2 bumps `DERIVED_STATE_REVISION`**, because every stored derived row was materialized
    without conversion.
- **Measuring `g` itself** (section 5) uses three methods in this order:
  1. revision pairs;
  2. as-reported counts, excluding derived fourth quarters and any quarter that spans the event;
  3. declared dividends against statement dividends per share, as a median over at least four
     quarters on each side of the event, and as a cross-check only.

  A ratio is accepted only when two independent methods agree.
  - The dividend method is too noisy on its own:
    - 9 of 68 single-quarter readings in the evidence fall outside ±2 %, one by +51 % (AXP
      Q4 2005, a payment-timing artefact);
    - it reads about 0.5–1 % high throughout, because it divides by diluted rather than
      record-date shares;
    - one quarter cannot separate 1.000 from 1.048 (MRK Q4 2021 reads 1.065).
  - As-reported figures fail exactly at an event: HON's as-reported Q2 2026 EPS is a
    year-to-date subtraction that mixes the two bases.

- **SEC EDGAR's XBRL facts** are a public-domain, independent source of as-filed counts, and a
  candidate second method. Using them needs a declared operator contact in the `User-Agent`.
  That is an owner fact, not decided here.

### 4. Point-in-time semantics

The three options differ in when later corporate-action knowledge enters a historical number:

| Option                                             | What it means                                                                     | Point in time                                                      | Charts and backtests                                                              | Verdict                                                 |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| A. Retrospective research basis everywhere (today) | one provider-normalised series for everything                                     | levels embed later actions; share-derived comparisons wrong by `Φ` | continuous                                                                        | rejected for valuation                                  |
| B. As-traded everywhere                            | every session in its own units                                                    | strict                                                             | every split is a discontinuity unless a complete share ledger re-weights holdings | rejected: the ledger's completeness is the failure mode |
| C. Two bases                                       | research for trading and indicators; split-adjusted for share-derived comparisons | see below                                                          | continuous                                                                        | **chosen**                                              |

Under C:

- **The research basis is retrospective.** It may be used only where scale cancels: returns,
  ratios, and comparisons with series derived from the same research prices.
- **The split-adjusted basis is retrospective for share-changing actions only.** Every quantity
  computed on it is a ratio in which the share factor cancels. On session `D` it equals the value
  computed from the as-traded price and the share count in the units of its filing, with three
  qualifications:
  - the provider's rounding of restated per-share figures;
  - statements the provider already restated before FactorSage first read them, the loader's
    known backfill limit;
  - the masks below.

  Within those qualifications, no information dated after `D` enters it.
  - `Φ(D)` is built from later events, but it only removes the provider's own retrospective
    adjustment. It restores the value on `D`; it adds nothing.
  - A future split changes units. It does not change a result, except through the provider's
    rounding of restated figures.
    - Graham sums restated diluted EPS rounded to the cent, and NVDA's 2005 Q2 is stored as
      0.0003 where net income ÷ shares gives 0.00024.
    - Deriving Graham's EPS from net income ÷ diluted shares would remove this. That belongs to
      the intrinsic-value methodology, not to this decision.

- **Masks are a known selection bias.** A session made `NOT_EVALUABLE` because of a pending event
  or an unpaired revision is unavailable because of something that happened after it. The mask
  withholds a value; it never shows a wrong one. It is recorded as a bias, and it is stamped as
  an interpretation (section 11).
- **The as-traded basis** is strict point in time. It is needed only for absolute levels (the
  rule in section 2).
- **Information and units are separate questions.**
  - Which statement values were available on `D` stays the fundamentals loader's question:
    `availableFromDate`, never backdated.
  - Which units they are expressed in is this decision's question.
- **A backtest evaluates its predicates on these same bases and trades on the research basis.**
  It stays point in time because nothing it decides depends on a research price level.

### 5. Classification: measured, never labelled

- **The price ratio `a`** is measured from prices: the ratio between re-read and stored rows at a
  detected re-base (section 7), or the step in `A` against a reference series (section 6).
- **The share ratio `g`** is measured from statements, by the ranked methods of section 3.
  Revision pairs come first, then as-reported counts outside derived and event-spanning
  quarters, then dividends as a cross-check. `g` is accepted only when two independent methods
  agree.
- **`φ = a ÷ g`.**
  - `φ = 1` is a share-changing action.
  - `g = 1` is a distribution.
  - Both different from 1 is a combined event.
  - A rounding tolerance separates 1 from a real ratio.
- **The provider's labels, its split list and "clean-looking" ratios are never evidence.** They
  may order the verification work. Every one of them failed in the stored data:
  - six mislabelled spin-offs;
  - two missing events;
  - two mis-sized events;
  - one entry (DIS 2007) whose presence in the prices cannot be established;
  - a combined event labelled as a spin-off whose share half the statements did restate.
- **An event not yet classified makes share-derived values before its ex-date `NOT_EVALUABLE`.**
  It never makes them guessed.

### 6. The historical basis needs an external as-traded reference

This is the blocker.

- **FMP cannot supply it.** Twelve endpoints were tested (investigation, §3). Only the declared
  dividends and insider trade prices are as-traded, and neither is a daily price.
- **What the reference must pass before it is canonical.** Each test is necessary and none is
  sufficient alone:
  - **Whole-cent test.** After decimalisation, closes above $1 before a split date are whole
    cents.
    - EODHD fails it (59 % of AAPL's are not), which reveals a close rebuilt from adjusted
      prices.
    - A rebuild rounded to cents would pass it, so passing proves little.
  - **Relative containment test.** On the investigation's securities and windows, with the same
    trade filters, the reference must contain at least as many stored insider trades as the
    stored close times the measured `A` does. An absolute rate is no benchmark: AAPL's right
    factor contains only 92 %, because of misdated or averaged filings.
  - **Spin-off-date test, against a second independent source.** On the session before each
    known distribution, the reference's close must equal the printed price, not the price
    divided by the factor. The printed price has to come from a source independent of the
    candidate, because checking a vendor against itself proves nothing. Alpha Vantage's raw
    series serves for IBM; each other event needs one found for it.
  - **Step structure.** `reference ÷ research` must be piecewise constant, with steps only at
    event dates.
    - Sessions where the two disagree beyond rounding without a step are vendor disagreements.
      They are listed and never become events.
    - Before 2001 they are common: Alpha Vantage and FMP disagree on IBM by more than 0.5 % on
      26 of 316 sessions, by more than 1 % on 12 and by more than 3 % on 3. A segment's factor is
      therefore its median, and a step needs a run of consistent sessions on each side.
  - **Coverage.** From the product horizon (1996-09-30), because `Φ(D)` depends only on events
    after `D`. Indicators stay on the research series, so warm-up years need no reference.
    Delisted securities are needed where the product shows them.
- **Candidates.** No source is chosen. The shortlist, in order:
  1. **Tiingo.** A raw close from 1962; a published display plan at $250 or $500 a month; its
     split factor includes distributions.
  2. **Sharadar through Nasdaq Data Link.** The cleanest documented separation: `closeunadj`, a
     split-only `close`, typed spin-off actions. History from 1998; professional licence by
     quotation.
  3. **Intrinio.** Display rights from $333 a month; distribution handling undocumented.
  4. **CRSP.** The reference method (`CFACPR` apart from `CFACSHR`, and `FACSHR = 0` for
     spin-offs); commercial licence by written permission.

  Alpha Vantage's raw close is validated for IBM, but its history starts in 1999-11 and its
  commercial terms are by contact only.
  - Its `demo` key served this research.
  - Using its data in the product would need those terms.

- **How it is used.** One full-history comparison per security:
  - the steps in `A` become ledger events carrying `a`;
  - `g` comes from statements, and `φ` follows;
  - re-verification is periodic.

  The runtime never depends on the vendor: the ledger is FactorSage's.

- **What the licence must allow.** Three things, and one to avoid:
  - Displaying values derived from its prices to paying users: Margin of Safety, the four
    ratios, their charts and Strategy results.
  - Storing its data internally for measurement and audit. That includes vendor values kept in
    a ledger event's `evidence`.
  - Reconstructing and showing an as-traded price (`researchClose × A`) reproduces the vendor's
    prices, so that needs display rights. The decision does not require such a view.
  - The questions for sales are in the investigation, §7.
- **The current provider's own display rights are an open owner input as well** (O11 in
  `docs/legal/owner-inputs-and-review.md`).
  - FMP's individual plans exclude displaying data to end users.
  - Every consumer here, the ledger's `A` included, is built on FMP's prices.

  This decision does not resolve it. It records the dependency.

- **Until such a source is chosen and validated, `Φ` is unknown for history.** Margin of Safety
  stays as it is (section 13), and valuation ratios stay blocked.

### 7. Detecting a re-base

| Signal                                                                                 | Role                          | Detects                                                              | False positives                                                                              | False negatives                                                  | Extra provider cost                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Overlap test on every read that touches stored history (tail refresh, prefix widening) | trigger                       | a changed settled row inside the read                                | a genuine correction of two or more rows; the full comparison then treats it as a correction | a re-base whose changed rows all lie outside the read            | none: the read already happens, widened by two stored rows at a prefix |
| Session anchor: the earliest stored row, re-read once per session                      | trigger                       | a re-base or correction that reaches the anchor, whenever it happens | a correction of that one row, or the row dropped; the full comparison decides                | a partial re-base or a correction that does not reach the anchor | one small request per resident security per session day                |
| Periodic full comparison                                                               | trigger                       | everything, including partial re-bases and old corrections           | none                                                                                         | none                                                             | two requests per resident security per month                           |
| Provider split calendar                                                                | **hold** only, never evidence | listed events                                                        | mislabelled entries (harmless for a hold)                                                    | MMM 2024, HON 2025                                               | one request a day for all securities                                   |
| Split-sized day move of the newest row                                                 | **hold** only                 | forward and reverse splits of 3:2 or more                            | a genuine crash, released after three sessions                                               | spin-offs of a few percent (IBM's −4.9 %)                        | none                                                                   |

- **Why all of them.**
  - Overlap, anchor and periodic comparison decide whether the stored history must be
    re-compared, and none of them trusts a label.
  - The two hold signals exist because of one gap: the provider may publish an ex-date row in
    the new basis before it rewrites the older rows (open measurement O-1). In that window no
    stored row has changed and the anchor has not moved, so nothing else can see the event.
- **The rules:**
  1. **Test before saving, on every read.** A read that adds or replaces rows next to stored ones
     must include at least two stored, settled rows at its boundary and compare them before
     anything is saved. That covers a tail refresh and a prefix widening
     (`hydrateWithinLease` asks only for the missing interval).
     - **Why widening is covered.** Without it, a widening after a re-base would put a new-basis
       prefix beside old-basis rows, and the anchor would then move onto the new prefix and
       never see the mix.
     - **The anchor moves** only after that test passes.
     - **Settled** means that session had already closed, by the exchange calendar and not the
       UTC `tailDate`, when the stored row was read. A session the provider had not published
       before is a new row, not a changed one.
  2. **What holds the save.** Any change to two or more settled rows, whatever the ratios, and
     any change to the anchor or its absence from the provider's answer. The save is held and the
     full comparison runs (section 8). The ratios only classify what the comparison finds. A
     single changed settled row takes today's correction path.
  3. **Per-row tolerance.** `|new − r × old| ≤ ½u(new) + r × ½u(old)`, with `u` = 0.01 at or
     above $1 and 0.0001 below. It is a floor, not the provider's last decimal: stored rows carry
     up to eight decimals, and 6,863 rows at or above $1 have more than two (ADBE, BA, AMD, AAL).
  4. **A held save is never partially applied.** Neither the tail nor the prefix is saved on the
     old history. The full replacement writes everything.
  5. **The ex-date hold.** Until O-1 shows the provider rewrites history no later than it
     publishes an ex-date row:
     - **When it applies.** The provider's calendar lists an event for the security with an
       ex-date inside the read window, or the newest row moves by less than −30 % or more than
       +40 % from the previous session.
     - **What it does.** Rows from the ex-date on are not saved. A Monitor treats the security as
       `NOT_EVALUABLE` for share-derived and price-derived operands, and does not append the live
       quote to the older history.
     - **How it ends.** When the anchor shows the rewrite (section 8), or after three sessions
       without one. The rows are then saved as a genuine move.
     - **Its limit.** A distribution that is neither listed nor split-sized cannot be held. Its
       step is committed until the provider rewrites history and the anchor sees it. The
       provider's own history is mixed during that window as well.
  6. **Anchor and cost.** The anchor is re-read on the first refresh after a session closes. The
     refresh budget is 28 requests per monitored security per day; the anchor adds one, or
     3.6 %.
  7. **Periodic full comparison.** Monthly per resident security: two requests. It closes the
     anchor's blind spot. It also ends the "corrections older than the tail are never observed"
     limitation of `ai/architecture/deep-discovery.md` §6.

### 8. The full-history re-read

- **Trigger.** Rule 2 of section 7, an anchor change, or a difference found by the periodic
  comparison.
- **Range: from the earliest stored row, not from the retention start.**
  - Rows outside current coverage exist and feed both the derived rebuild and the anchor:
    - CRWD has rows from 2019-06-12 under coverage from 2021-08-19;
    - MSFT has rows from 1992-09-09 under coverage from 1992-09-22;
    - 26 securities hold rows before today's retention start.
  - A replacement from the retention start would leave them on the old basis. The anchor would
    then mismatch again and trigger a replacement every session.
  - So the replacement covers the earliest stored row onwards, or deletes the rows it does not
    cover, and resets the anchor, all in the same transaction.
- **A complete answer only.**
  - Stored rows the complete answer no longer contains are deleted with the replacement, but
    only when:
    - the paginated walk reached the requested start;
    - such rows are at most 1 % of the history.
  - Otherwise the replacement is refused and retried later, never applied partially.
- **Segment by the structure of a basis event.**
  - Going back in time, a genuine event changes every earlier row by one ratio, and each earlier
    event multiplies onto it. So `new ÷ old` is constant between event dates and steps only at
    them.
  - The date of a step is the first session of the later run, which also handles a provider date
    on a weekend or holiday (HON's entries are dated Sundays). A step needs at least three
    consistent sessions on each side.
  - A block of rows whose ratio differs from its neighbours and returns to theirs afterwards is
    a correction, never an event. `Φ` must not undo a correction.
- **An unexplained change.** If more than 1 % of rows fit no such structure:
  - the change is recorded as `UNEXPLAINED`;
  - the history is still replaced, because the provider is the authority for the research
    series;
  - share-derived values before the earliest changed row are `NOT_EVALUABLE` until measured.
- **Classification.** Every event starts as pending and is classified by section 5. A
  share-changing or combined event also starts the full statement re-read of section 3.

### 9. Atomic replacement, generations and ledger versions

- **PostgreSQL holds one generation per security.**
  - The new prices, weekly prices and derived rows are computed in memory, as a rebuild already
    is.
  - One transaction, under the existing per-security write lock, does all of this:
    - replaces all three from the earliest stored row (section 8);
    - bumps the security's basis generation;
    - inserts the ledger event;
    - resets the anchor;
    - updates coverage.
  - This is about 8,600 price rows, 8,600 derived rows and 1,800 weekly rows, the size of a cold
    hydration's writes. PostgreSQL never commits an old early history beside a new late one.
- **Two counters, because two things change what a consumer reads.**
  - The **basis generation** changes when the research history is replaced.
  - The **ledger version** changes on any ledger insert, classification or unit conversion.
    Those change `Φ`, a statement's units or a `NOT_EVALUABLE` mask without touching a price.
  - Every pin below pins both.
- **Redis.** The replacement is published as a new hydration generation, using the existing
  `HYDRATING` → `READY` swap.
  - The manifest carries both counters.
  - Price chunks and derived chunks are separate `MGET`s. Each must verify the manifest's
    counters atomically with its read: one script, or a re-check of the manifest afterwards.
  - Otherwise a reader that passed the `READY` check just before a republish can combine old and
    new years.
- **Monitor.** It reads prices from Redis and the derived tail from PostgreSQL.
  - The derived tail and the counters are read in one PostgreSQL snapshot, and compared with the
    manifest the prices came from.
  - A mismatch makes the security `NOT_EVALUABLE` for that cycle, because a Signal emitted from a
    mixed frame would be permanent.
- **Backtest.**
  - `PREPARING_DATA` records each security's pair of counters in the run's snapshot, and every
    window read checks both.
  - A mismatch fails the run with a retryable "market data changed during the run" reason. The
    alternative would be a held position jumping by a split ratio between two years, or Margin
    of Safety changing meaning between two windows.
  - How often this happens grows with the number of securities in a run and its duration. A
    single security re-bases about once in twenty years.
- **Benchmark series need their own design.**
  - `BenchmarkDataCache` has no `HYDRATING`/`READY` manifest and no generation, so "the same
    detector and replacement" is not enough there.
  - The benchmark and execution-calendar series need the same counters and an atomic read, and
    the run's pin covers them too.
- **Where the counters live.**
  - **PostgreSQL:** the durable truth, in a per-security basis row beside the ledger.
  - **The Redis manifest:** so a projection from an older generation is not current.
  - **Not `PRICE_DATASET_VERSION`:** a re-base changes one security's data, not what coverage
    means, so no global bump is needed.

### 10. Derived rebuild

- **Prices and indicators.** A re-base rebuilds from the earliest persisted bar. Every row
  before the event changed, and EMA and RSI are seeded from the series' start (AUD-02). A
  ten-day rebuild would leave every moving average that spans the event wrong for up to 200
  weeks.
- **Weekly prices** are re-aggregated in full.
- **Intrinsic values** change only where unit conversion changes a revision's units, for a
  share-changing event, and are then rebuilt in full.
- **Where `Φ` is applied.**
  - Prices and intrinsic values take it at projection, in the evaluation frame and the chart
    overlay. It is never stored per row.
  - RVOL is materialized from volume, so a change to `Φ` (a new ledger version) rebuilds RVOL
    from the earliest affected session.
- **Redis:** every year is republished under the new generation.

### 11. Reproducibility

- **The contract is unchanged.** A completed run's stored results never change, and a new run
  may differ after the provider changes data (`ai/product/backtests.md`). A re-base is such a
  change:
  - For a share-changing action, a new run shows other units. Its returns are the same, except
    where a comparison uses rounded restated per-share figures (section 4).
  - For a distribution, it shows the returns the provider's new series implies.

  No archive of frozen data is needed.

- **Changing an interpretation is different.** Each of these changes numbers for an unchanged
  Strategy and period:
  - PR 1's `NOT_EVALUABLE` masks before a pending or unexplained event;
  - PR 2's unit conversion;
  - PR 4's move of Margin of Safety, the price-to-value comparisons and RVOL onto the
    split-adjusted basis.

  So PR 1 adds a `priceBasisRevision` to `BACKTEST_DATA_REVISIONS`, and each later change bumps
  it. A queued run is then refused rather than executed under a new rule with an old stamp.
  PR 2 also bumps `DERIVED_STATE_REVISION` (section 3).

### 12. Benchmark, weekly prices and Stock Details

- **Benchmark.** It stays on the research basis. SPY has had no share-changing action, and the
  comparison is price return against price return. Benchmark series share the endpoint and the
  tail refresh, so they share the detector. Their replacement and atomic read need the design in
  section 9, because their cache has no generation today.
- **Weekly prices** stay research-only. No consumer needs an as-traded week, so none is stored.
- **Stock Details:**
  - The chart stays on the research close.
  - Intrinsic-value overlays are drawn at `IV ÷ Φ`, so the gap between the lines is the true
    one. That line is in research dollars, not the intrinsic value per share on that date, and
    its tooltip says so.
  - Valuation series get their own pane.
  - No second price line in V1. A tooltip or footnote says that valuations use prices adjusted
    for share splits only.
  - An "as traded" view is derivable from the ledger (`researchClose × A`). It would reproduce
    the reference vendor's prices, so it needs that vendor's display rights (section 6).
- **Signals keep the price they were observed at.** After a later action that price no longer
  matches the chart. This is correct, and the documentation says so.

### 13. Margin of Safety

Margin of Safety has **two** defects around distributions. This decision specifies the fix for the
first only.

- **B1, the price basis (historical).**
  - Every intrinsic value is a per-share figure in current share units. The comparison uses a
    research close that carries `Φ` (investigation, §5.1). One correction fixes all four models
    and three blends for B1.
  - **Impact:**
    - 34,077 sessions (10.8 % of those with a value) and 211,653 values are overstated, in six
      of 62 securities.
    - Intrinsic value ÷ price is overstated by exactly `Φ`, from 1.046 to 2.120.
    - The median overstatement is 18.0 points.
    - `Value & Trend`'s BUY condition (Balanced above 5 %) is falsely true on 4,664 of 28,720
      sessions, and its SELL condition (below −15 %) falsely false on 4,557.
  - At the live edge `Φ(today) = 1`, so B1 does not touch today's value.
- **Statement content after a distribution (live and historical, open).**
  - After a distribution the price is right, but the statements still describe the company as it
    was before, until new filings reflect the separation. Sometimes they carry a one-off gain from
    it. No price basis fixes this.
  - **MMM.** DDM stayed at 81.65–81.75, built on the pre-spin $1.51 quarterly dividend, from
    2024-04-01 to 2024-07-26. It then fell to 70.83 and 59.88.
  - **HON on 2026-06-29.** Balanced is 158.15 from pre-separation statements, against a
    post-event price of 227.80.
  - **HON today.** Balanced Margin of Safety is **+14.3 %** on 2026-09-24, so `Value & Trend`'s
    BUY margin condition holds.
    - It comes from one quarter, Q2 2026: EPS 17.81 and net income 5,682 M, 2.4 times any other
      HON quarter since 2016.
    - On 2026-07-24, when that quarter became available, Graham went from 180.66 to 362.30 and
      Residual Income from 152.87 to 327.96.
  - **So the live edge is not clean.** Live Signals are free of B1, not of this.
  - **This needs its own decision in the intrinsic-value methodology**, recorded here as open.
    Two directions are candidates:
    - making share-derived values unavailable between a distribution and the first statement
      that reflects it;
    - excluding discontinued-operations gains from the model inputs.
- **Interim product behaviour: C, a disclosure, covering both defects.** The affected sessions
  cannot be identified across the catalog from stored data:
  - the provider list omits events, so its count (about 16 % of US large caps, investigation
    §2.6) is an estimate, not a bound;
  - insider coverage starts in 2003 and is sparse;
  - only 64 of 9,768 catalog securities are loaded, and any other opens on demand.

  The other options are worse:
  - **B, a mask**, would be partial and would present the rest as verified;
  - **D, disabling** the historical metric, would remove a core feature. Its history is not
    shown wrong on 89 % of the stored sessions that have a value.
  - **A, silence**, is not acceptable once the defect is known.

  The disclosure belongs:
  - in the Margin of Safety metric's description in the Strategy Builder;
  - on backtest results whose Strategy uses Margin of Safety or a price-to-value comparison;
  - beside the intrinsic-value history on Stock Details.

  It is a separate small change, not made here.

- **The minimal fix for B1.**
  - The ledger with `Φ` measured for history (section 6).
  - The projection change: `(IV − researchClose × Φ) ÷ IV`, and `IV ÷ Φ` where an intrinsic
    value meets a price.
  - `NOT_EVALUABLE` before an unclassified event, and wherever `Φ` is unmeasured.
  - For future splits, unit conversion (section 3).

  Intrinsic values themselves need no share normalisation for B1.

### 14. What unblocks valuation ratios

**Required:**

1. `Φ` measured for the product horizon of each security, or the session marked unavailable.
   This is the external reference (section 6).
2. Re-base detection, the ex-date hold and atomic replacement (sections 7–9), so no future event
   mixes bases.
3. Statement unit conversion with the full statement re-read (section 3), so no future split
   mixes units.
4. The ratios' own methodology: windows, currency, recast statements around spin-offs, statement
   content after a distribution (section 13), and the B3 decision. This is
   `valuation-ratios-v1.md`'s follow-up.

**Not required:**

- a displayed as-traded price;
- an as-traded weekly series;
- per-session factor columns;
- a total-return methodology;
- SEC share data.

**A narrower alternative, not recommended.** Ratios only on sessions whose `Φ` is proven by the
forward ledger, meaning after the first anchor-verified session. That gives no history, so no
backtest could use them.

## Data model

| Option                                    | Correctness                                                                     | Point in time       | Storage (per 34-year security)                         | Backtest compatibility                  | Rebuild complexity                                                | Debuggability                | Future valuation use |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------- | ---------------------------- | -------------------- |
| 1. `asTradedClose` column on `DailyPrice` | needs `G` beside it to become `Φ`; two sources in one row, corrected separately | as-traded is strict | +~69 KB PostgreSQL (+5 % heap), +~189 KB Redis (+14 %) | unchanged                               | every re-base rewrites both columns                               | direct per session           | indirect through `G` |
| 2. Separate reference-price table         | as option 1, with source and licence isolated                                   | strict              | as option 1, or more with OHLC                         | unchanged                               | independent coverage and revision                                 | good: source per row         | indirect             |
| 3a. Per-session factor column             | redundant: `A` is piecewise constant                                            | derived             | +~69 KB PostgreSQL, +~171 KB Redis                     | unchanged                               | rewritten on every event                                          | per session, but opaque      | direct               |
| **3b. Basis-event ledger (chosen)**       | exact wherever the events are measured; evidence per event                      | derived             | < 1 KB (a few events)                                  | unchanged, with a pinned ledger version | an event is appended; `Φ` applied at projection, and RVOL rebuilt | per event, with its evidence | direct               |
| 4. Replace the close with as-traded       | breaks every split                                                              | strict              | none                                                   | **breaks** (−75 % AAPL, −90 % NVDA)     | full                                                              | —                            | rejected             |

**Chosen: 3b.** The reference series, if the licence permits storing it, is an internal table of
option 2's shape, used for measurement and audit only.

**Schema this eventually requires.** A sketch; each PR carries its own migration:

- **`PriceBasisEvent`:** `securityId`, `effectiveDate` (the first session of the new basis),
  `priceRatio`, `shareRatio`, `distributionRatio`, `classification`, `detectedBy`, `detectedAt`,
  `basisGeneration`, `ledgerVersion`, and `evidence` (JSON: the runs compared, the revisions
  paired, the source; vendor values only as the licence allows).
  - `classification` is one of `PENDING`, `SHARE_CHANGING`, `DISTRIBUTION`, `COMBINED`,
    `UNEXPLAINED`.
  - `detectedBy` is one of `REFERENCE`, `OVERLAP`, `ANCHOR`, `PERIODIC_COMPARISON`.
  - Append-only; a correction is a new row.
- **`SecurityPriceBasis`:** one row per security, with:
  - `generation` and `ledgerVersion`;
  - `anchorDate` and `anchorClose`;
  - `verifiedThrough` and `verifiedAt`;
  - `lastFullComparisonAt`;
  - `holdFrom` (the ex-date hold, section 7) and `holdReason`;
  - `measuredFrom`: the earliest session whose `Φ` is measured. Before it, share-derived values
    are unavailable.
  - `referenceSource`.
- **The Redis manifest** gains both counters. The benchmark cache gains the equivalent (section
  9). The few ledger events travel with the projection, never as per-row fields.
- **No change to `DailyPrice`, `WeeklyPrice` or `PRICE_DATASET_VERSION`.**

### Storage estimate

Measured on the development store:

- **`DailyPrice`:** 368,857 rows in 100.1 MB with indexes, which is 271 B a row (147.5 B of heap).
  A numeric column averages 7.0 B.
- **Redis:** MSFT's 8,571 rows take 1.35 MB of row JSON, 158 B a row.

Projected for a 34-year security (8,571 rows), and for the whole 9,768-security catalog as an
upper bound (83.7 M rows):

| Addition               | PostgreSQL per security | Redis per resident security | Catalog upper bound (PostgreSQL) | `/prices` payload |
| ---------------------- | ----------------------- | --------------------------- | -------------------------------- | ----------------- |
| one `DECIMAL` close    | +~69 KB                 | +~189 KB (+14 %)            | +~0.7 GB                         | +14 % if exposed  |
| one factor per row     | +~69 KB                 | +~171 KB                    | +~0.7 GB                         | +13 % if exposed  |
| a full second OHLC     | +~240 KB (+19 % heap)   | +~690 KB (+51 %)            | +~2.3 GB                         | +50 % if exposed  |
| **basis-event ledger** | **< 1 KB**              | **< 200 B in the manifest** | **< 10 MB**                      | **none**          |

Redis residency is bounded by the resident-security budget (`production-capacity.md`), so the
Redis column scales with residents, not with the catalog.

## Alternatives rejected

| Alternative                                                       | Why not                                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct the close with the provider's split list                  | it omits, mis-sizes and mislabels events (investigation, §2.2)                                                                                              |
| The provider's `non-split-adjusted` series as the as-traded close | the adjusted series times that same list                                                                                                                    |
| Provider market-cap, enterprise-value or key-metric history       | computed from the adjusted close (MMM 2024-03-28 = 88.68 × 555.0 M)                                                                                         |
| The provider's dividend-adjusted series                           | its factors are computed on the adjusted close                                                                                                              |
| EODHD's `close`                                                   | documented as traded, observed reconstructed from adjusted prices; fails the whole-cent test                                                                |
| Insider trade prices as the reference                             | 33 securities stored, from 2003 at best, sparse, clustered on few dates and with non-market rows; they validate a basis to about ±0.5 %, they cannot be one |
| As-traded close × as-filed counts                                 | 233 of 2,033 as-filed counts are defective, and every split between the filing and the session still has to be found                                        |
| As-traded close × stored (restated) counts                        | wrong by `G`: ×28 for AAPL 2013                                                                                                                             |
| A per-session factor, or a second OHLC series                     | redundant with a ledger (option 3a); no consumer for an as-traded OHLC (option 2 with OHLC)                                                                 |
| Replacing the research close with as-traded prices                | breaks every split in every consumer (option 4)                                                                                                             |
| Repairing the tail's step heuristically                           | a spin-off of 4 % cannot be told from a market move; only a held save plus the anchor and the full comparison can tell a re-base from a move                |
| The anchor alone as the detector                                  | blind to partial re-bases and to a prefix widening; the overlap test on every read and the periodic comparison close those gaps                             |
| A `PRICE_DATASET_VERSION` bump per re-base                        | global, manual, and re-reads every security for one event                                                                                                   |
| Frozen per-run data snapshots                                     | not required by the reproducibility contract; costly                                                                                                        |
| A partial Margin of Safety mask                                   | cannot be complete from stored data (section 13)                                                                                                            |
| As-traded execution with a share ledger                           | a missed event becomes a catastrophic return (section 2)                                                                                                    |

## Gate result

| #   | Condition                                    | Result                              | Evidence                                                                                                                                                                                   |
| --- | -------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A canonical as-traded source exists          | **not proven**                      | FMP has none. Alpha Vantage's raw close is validated for IBM only, through a demo key. Tiingo, Sharadar, Intrinio and CRSP document one, unvalidated.                                      |
| 2   | Its licence suits a paid product             | **not proven**                      | Tiingo publishes a display plan; derived-metric scope unconfirmed. The others are by quotation or written permission. FMP's own display rights are open (O11).                             |
| 3   | 30-year coverage                             | **not proven**                      | Claimed by Tiingo (1962), Intrinio (50+ years) and CRSP (1925); Sharadar from 1998; Alpha Vantage from 1999-11 (89.7 % of IBM's horizon).                                                  |
| 4   | Split and spin-off examples validate         | **not proven**                      | Splits validate everywhere. For spin-offs, IBM validates against an independent series; MMM, WDC, HON, AXP and MRK only against insider prices, to about ±0.5 %. DIS 2007 is undetermined. |
| 5   | The share basis is coherent                  | **yes**                             | `G` equals the share-changing ratios. The investigation measures it by dividends, the prior gate and the review by as-reported figures (§3).                                               |
| 6   | Point-in-time semantics are defensible       | **yes, with stated qualifications** | Section 4: provider rounding, backfill restatements, masks.                                                                                                                                |
| 7   | The backtest basis can remain stable         | **yes**                             | Section 2.                                                                                                                                                                                 |
| 8   | Re-base detection is specified               | **partly**                          | Sections 7–9, corrected after review. The ex-date window depends on O-1, which PR 1 waits for.                                                                                             |
| 9   | The Margin of Safety correction is specified | **for B1 only**                     | Section 13. History depends on condition 1; statement content after a distribution is open.                                                                                                |
| 10  | No major clean-room objection remains        | **yes, after corrections**          | The review accepted the gate result and the core design and found holes in the first PR specifications. Those are corrected here ("Review").                                               |

Conditions 1–4 fail and conditions 8 and 9 are partial, so no product code is written on this
branch.

## Implementation plan

Conditional. Each PR has its own tests, migration note and validation gate.

| PR                                               | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Depends on                                         | Invariants                                                                                                                                                                                                                                                                                             | Migration                                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 (optional, small)                              | The Margin of Safety disclosure for both defects (section 13) and its documentation                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | nothing                                            | copy only; no number changes                                                                                                                                                                                                                                                                           | none                                                                                                                                                            |
| **1. Re-base-safe loading**                      | `SecurityPriceBasis` and `PriceBasisEvent` with both counters; the overlap test on every read (tail and prefix widening); the session anchor; the ex-date hold; the periodic full comparison; the full re-read from the earliest stored row, with structured segmentation; single-transaction replacement; both counters in the manifest with atomic chunk reads; the backtest pin in the run snapshot; counter-consistent Monitor reads; the benchmark design of section 9; `NOT_EVALUABLE` before a pending or unexplained event; `priceBasisRevision` | O-1 observed on at least one event                 | PostgreSQL never holds two generations for one security; nothing is saved next to stored rows without the overlap test; the anchor moves only after a passed test; a run reads one pair of counters per series; a one-row correction never triggers a full read; no provider call in the backtest loop | additive tables; basis rows created lazily with generation 1 and the earliest stored row as anchor; no backfill; stop-then-start deploy for the manifest fields |
| **2. Classification and unit conversion**        | the full statement re-read on a share-changing event; `g` from revision pairs, then as-reported, then dividends, with two methods required to agree; classifying events; unit conversion at materialization; `φ` for forward events; `DERIVED_STATE_REVISION` and `priceBasisRevision` bumps                                                                                                                                                                                                                                                             | PR 1; O-2, including restatement before an ex-date | a revision's `availableFromDate` never moves; conversion only on a measured pair                                                                                                                                                                                                                       | additive columns only                                                                                                                                           |
| 3. Historical reference (**blocked**)            | an adapter for the chosen vendor behind a port (a new provider package, added to the dependency rules); one full comparison per security; historical ledger events with `a`, `g` and `φ`; `measuredFrom`; a verification report; periodic re-verification                                                                                                                                                                                                                                                                                                | a licensed source that passes section 6's tests    | the ledger, never the vendor, is read at runtime; an event is never taken from a vendor label                                                                                                                                                                                                          | reference table if licensed; a one-off per-security job, resumable                                                                                              |
| 4. Split-adjusted basis for share-derived values | Margin of Safety, price-to-value comparisons, chart overlays and RVOL; a `priceBasisRevision` bump                                                                                                                                                                                                                                                                                                                                                                                                                                                       | PR 3 (and PR 2 for forward events)                 | `NOT_EVALUABLE` before `measuredFrom` and before a pending event                                                                                                                                                                                                                                       | RVOL rebuild                                                                                                                                                    |
| 5. Valuation Ratios V1                           | re-run `valuation-ratios-v1.md`'s gate on this basis, with the statement-content decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PRs 1–4                                            | as that decision                                                                                                                                                                                                                                                                                       | as that decision                                                                                                                                                |

**Open measurements:**

- **O-1: does the provider publish an ex-date row before it rewrites the older rows?** PR 1
  waits for this.
  - Re-read the rows captured in
    `docs/historical-price-basis/evidence/rebase-observation-baselines.csv` daily around GPMT's
    1:10 on 2026-10-06 and DXJ's 3:1 on 2026-10-09.
  - Record when the ex-date row appears, when the anchor changes, and whether the tail and the
    anchor change together.
  - Then repeat for the next events in loaded securities.
- **O-2: when does the provider restate statements, before or after the ex-date?** PR 2 waits
  for this. GPMT is the only one of the two with statements; DXJ is an ETF.
- **Volume across distributions: answered.** The provider scales volume by `A`, distributions
  included. IBM's stored volume is exactly 1.046 × raw before Kyndryl, and 1.000 × raw after.

## Tests the implementation needs

- **Share-changing actions:** an ordinary split; a reverse split; a stock dividend; a class
  distribution of the same company's shares (GOOG 2014).
- **Distributions:** a spin-off; a special cash distribution.
- **Combined events:** a split and a spin-off on the same ex-date (HON 2026, HLT 2017, MSI 2011);
  two events between two verifications.
- **Provider behaviour:**
  - a full-history re-base discovered by the overlap test;
  - the same re-base discovered only by the anchor, after the tail has moved past the ex-date;
  - a partial re-base found only by the periodic comparison;
  - an ex-date row published before the rewrite, which the hold must catch;
  - a one-row correction, which must not trigger a full read;
  - a block of corrected rows, which is a correction and not two events;
  - an anchor row the provider stops returning;
  - a provider date on a weekend or a holiday;
  - "settled" judged by the exchange calendar across a holiday.
- **Loader paths:**
  - a prefix widening after a re-base, which must be tested and must not move the anchor;
  - rows older than coverage and retention, which must be replaced with the rest.
- **Metadata:** an event missing from the provider's metadata; an event the metadata mis-sizes.
  The measured ratio wins in both.
- **Statements:**
  - a share anomaly (B3) that must not be read as a split: conversion needs a pair agreeing with
    `g` in shares and EPS;
  - a restatement published before the ex-date, which must not be converted twice;
  - Graham's rounding difference between a converted and a re-observed revision, bounded and
    recorded.
- **Identity:** a symbol change and a delisting; a spliced history must trip the anchor.
- **No look-ahead.** A value on `D` equals the value computed with data through `D`, within the
  qualifications of section 4, after a later split is converted.
- **No mixed data:**
  - a concurrent reader during a replacement;
  - a backtest that crosses a replacement, or a ledger-version change, mid-run;
  - a Monitor cycle that meets a replacement;
  - a Monitor on an ex-date with the live quote held back;
  - a benchmark series replaced during a run.
- **Existing guarantees still hold:** no provider call in the backtest loop, and identical frames
  from the same counters. Queued runs are refused across a `priceBasisRevision` bump.
- **Reference validation:** the whole-cent, relative-containment, independent spin-off-date and
  step-structure tests from section 6, run against the chosen source.

## Operational risks and deployment

- **A second vendor.** An outage or licence change stops new historical measurement only. The
  ledger is FactorSage's, and the runtime does not read the vendor.
- **The current vendor.** Every basis here is built on FMP's prices, and FMP's display rights
  for a paid product are an open owner input (O11). This decision records the dependency and
  does not resolve it.
- **Re-base storms.** A provider-wide recomputation would trigger many full reads. They go
  through the existing FMP gate, and the anchor keeps unaffected securities out. One full read
  is 2 requests and about 2 s of CPU (scaled from the measured cold hydration: 0.8 s for 12
  years, times 2.7).
- **Holds and pending windows.** An ex-date hold makes a security `NOT_EVALUABLE` for up to
  three sessions. A pending classification does the same for share-derived values until O-2's
  measured lag. Both need measuring before a bound is promised.
- **Mid-run failures.** A backtest crossing a replacement or a ledger change fails and must be
  re-run. The chance grows with the number of securities in a run and its duration.
- **Deployment.**
  - Additive migrations only.
  - The new manifest fields make every manifest non-current, so each security's projection
    rebuilds from PostgreSQL. That needs no provider traffic, but it is a stop-then-start deploy.
  - Each `priceBasisRevision` bump refuses queued runs once.

## Quantitative summary

| Measure                                          | Value                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Affected securities in the store                 | 6 of 62 with statements (9.7 %); none found among the other 56, all scanned                                                                                                                                                                                                                        |
| Affected sessions                                | 35,234 of 332,294 in the horizon (10.6 %, including HON's 20 unverifiable sessions); 34,077 of the 315,524 with a Margin of Safety value (10.8 %, excluding them)                                                                                                                                  |
| Built-in `Value & Trend`                         | BUY margin condition falsely true on 4,664, SELL falsely false on 4,557, of 28,720 affected sessions                                                                                                                                                                                               |
| Market-wide estimate                             | 36–37 of 230 US large caps (about 16 %) carry a provider-listed price-only candidate since 1996-09-30. That is about 10 % of all US large-cap sessions and about 60 % of the flagged securities' own. It is an estimate: the list omits events (MMM) and may include a few share-changing entries. |
| Maximum price-basis divergence                   | `Φ` = 2.120 (HON before 2018-10-01): `close × shares` is 47.2 % of the true value                                                                                                                                                                                                                  |
| Insider validation of the provider's own factors | WDC 64/64, IBM 361/361, MRK 178/178; MMM 0/306, HON 0/261 and 1/30, AXP 94/147. These are distinct trades, clustered on 49, 72, 115, 48, 166, 29 and 43 dates, with a factor resolution of about ±0.5 %.                                                                                           |
| Candidate source coverage                        | Alpha Vantage IBM: 6,766 of 7,545 horizon sessions (89.7 %), from 1999-11-01; vendors claim 1962 (Tiingo) and 1998 (Sharadar, 93 %)                                                                                                                                                                |
| Candidate validation error                       | Alpha Vantage against stored × `A`: 6,366 of 6,450 sessions from 2001 (98.7 %) within cent rounding; median deviation of the 84 exceptions 0.089 %, largest 1.01 %. Before 2001: 26 of 316 sessions differ by more than 0.5 %.                                                                     |
| Share-basis reconciliation                       | HON: 62 of 64 quarters within 2 % of half the as-reported implied count (review). As-reported counts within 2 % of the split history in 85.4 % of 2,033 quarters (prior gate). Dividend method as a cross-check: 59 of 68 single-quarter readings within ±2 %.                                     |
| Storage increase (chosen model)                  | < 1 KB per security in PostgreSQL; < 200 B per resident in Redis                                                                                                                                                                                                                                   |
| Full-history refresh cost                        | 2 provider requests and about 2 s of CPU per event; about one event per security in twenty years (97 provider entries across 62 securities in 30 years)                                                                                                                                            |
| Provider request volume                          | +1 request per resident security per session for the anchor (+3.6 % of the refresh budget); +2 per resident security per month for the periodic comparison; a one-off historical comparison of at least one request per security with the chosen vendor                                            |

## Review

A clean-room reviewer checked this decision and its evidence on 2026-09-30.

- **What it had and did not have.** It read the committed documents, the cited code and the
  database. It did not see the author's scratch analysis. It made 7 FMP requests and one Alpha
  Vantage demo request of its own.
- **What it accepted.**
  - The Blocked result and the core design: two bases, the event ledger, classification by
    measured `g`, and replacement with generations.
  - The identity `researchClose × Φ = asTradedClose ÷ G`, and that `Φ` leaks nothing.
  - That the insider and Alpha Vantage evidence is not circular.
  - The engine's scale invariance.
- **What it re-computed.** MMM containment (317/317 rows at 1.1963, 0/317 at 1) and the session
  and value counts.
- **What it found**, all accepted and corrected:

| Finding                                                                                                                                                                   | Severity         | Correction                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| F1. An ex-date row published before the history rewrite escapes every detector                                                                                            | Major            | the ex-date hold (section 7, rule 5); O-1 is now a prerequisite of PR 1; gate row 8 is "partly" |
| F2. A prefix widening adds rows beside stored ones without any test                                                                                                       | Blocker for PR 1 | the overlap test on every read; the anchor moves only after a passed test (rule 1)              |
| F3. The full re-read and the anchor covered different ranges; rows outside coverage exist (CRWD from 2019 under coverage from 2021)                                       | Blocker for PR 1 | replace from the earliest stored row and reset the anchor in the same transaction (section 8)   |
| F4. A Monitor appends the live quote to un-rebased history on an ex-date                                                                                                  | Major            | the hold also withholds the live quote; the consumer table is corrected                         |
| F5. "The live edge is correct" is false after a distribution (HON +14.3 % today; MMM DDM on the pre-spin dividend)                                                        | Major            | two defects named; the disclosure covers both; the fix is specified for B1 only (section 13)    |
| F6. Unit conversion was assumed and measured at once; the 12-quarter refresh leaves older quarters unpaired                                                               | Major            | measured only, on a full statement re-read; a `DERIVED_STATE_REVISION` bump (section 3)         |
| F7. The backtest pin missed ledger changes                                                                                                                                | Major            | a ledger version pinned beside the generation (section 9)                                       |
| F8. The dividend method is not ±2 % (9 of 68 readings outside, one +51 %; biased high)                                                                                    | Minor            | ranked methods, two must agree, dividends as cross-check only; AXP's range corrected            |
| F9. RVOL is not basis-independent: the provider scales volume by `A`                                                                                                      | Minor            | RVOL moves to split-adjusted volume (sections 1, 10)                                            |
| F10. Rule 2 was defeated by one odd row; `u` is not the provider's last decimal; segmentation could turn a correction into two events; the anchor misses partial re-bases | Minor            | any multi-row change holds; `u` is a floor; structured segmentation; the periodic comparison    |
| F11. Containment counts were deduplicated trades clustered on few dates, and the resolution is about ±0.5 %; DIS rests on two trades                                      | Minor            | counts, dates and resolution disclosed; DIS undetermined; relative acceptance test              |
| F12. Point-in-time claims ignored rounding, backfill and masks                                                                                                            | Minor            | qualified (section 4); Graham's rounding recorded                                               |
| F13. The benchmark cache has no generation                                                                                                                                | Minor            | its own atomic-read design; the run pin covers it (section 9)                                   |
| F14. Licensing: FMP's own display rights (O11), a reconstructed as-traded view, vendor values in `evidence`, the demo key                                                 | Minor            | recorded (section 6, operational risks)                                                         |
| F15. The reference tests were weak; vendors disagree before 2001                                                                                                          | Minor            | a relative test, an independent spin-off-date source, step structure (section 6)                |

- **Clarifications, also applied:**
  - `G`'s filing-date units.
  - The large-cap count: 36–37, an estimate.
  - Alpha Vantage's coverage: 89.7 %.
  - The Value & Trend counts: 4,664 and 4,557, after a column error in the author's script.
  - "Exactly", "moves with the market" and "right on 89 %" reworded.

## References

- `docs/historical-price-basis/INVESTIGATION.md` and `docs/historical-price-basis/evidence/`
- `docs/valuation-ratios-gate/INVESTIGATION.md`, `docs/decisions/valuation-ratios-v1.md`
- `docs/decisions/complete-price-coverage.md`, `intrinsic-value-engine.md`,
  `fundamentals-loader.md`, `backtest-run-persistence.md`
- `ai/architecture/deep-discovery.md` §6 and §15, `ai/product/backtests.md`,
  `ai/architecture/production-capacity.md`

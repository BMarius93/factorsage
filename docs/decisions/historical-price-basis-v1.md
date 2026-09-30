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

  They fix blocker B2 for every price-derived series and may start after this document is
  reviewed. The historical basis, the Margin of Safety correction and the valuation ratios may
  not.

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
  company's shares (GOOG class C, 2014). The as-traded price moves by `1/k`.
- **Distribution (price-only action).** Value leaves the security to its holders while the share
  count does not change: a spin-off, or a special distribution of cash or other property. The
  as-traded price falls by the value distributed.
- **Combined event.** A share-changing action and a distribution with the same ex-date: HON
  2026-06-29, HLT 2017, MSI 2011.
- **Total adjustment factor**, `A(D) = asTradedClose(D) ÷ researchClose(D)`. Piecewise constant.
  It steps only at the ex-dates of events the provider folded into its series.
- **Share factor**, `G(D)`. The product of the share-changing ratios with an ex-date after `D`.
  It is the factor by which the provider restated a statement share count dated before `D`.
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
- **The research series is inconsistent about distributions.** It folds in MMM 2024, WDC 2025,
  IBM 2021, MRK 2021, AXP 2005 and HON 2018 and 2025. It does not fold in DIS 2007.
- **Backtests** fill at the same day's research close, with fractional shares and no costs. A
  run reads its data in calendar-year windows after one preparation step and pins no data
  generation. The result is a price return: dividends are not modelled.
- **Margin of Safety** is `(IV − researchClose) ÷ IV`. Each intrinsic value is a per-share
  quantity in the share basis.

## Consumers by required basis

"Required" is the basis a consumer needs to be economically right. The research close is right
for a consumer that uses only ratios of research prices, or compares research prices only with
series derived from them.

| Consumer                                                                    | Current source                                        | Current basis                                    | Required basis                                                                                                                                 | Change needed                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Stock Details price chart, OHLC                                             | `DailyPrice` → Redis → `/stocks/:symbol`, `/prices`   | research                                         | split-adjusted for continuity; distribution treatment needs further decision                                                                   | none now; documented                                                        |
| Latest price, change, previous close, day and 52-week range                 | the latest `prices[]` rows                            | research                                         | split-adjusted (equal to as-traded after the latest event)                                                                                     | none                                                                        |
| Daily returns: holdings value, equity curve, annual returns, drawdown, CAGR | frame `close`                                         | research                                         | a total return is the economic truth; V1 is a price return by product decision; needs further decision                                         | none; the distribution inconsistency is documented                          |
| Backtest fill price, BUY and SELL execution, terminal liquidation           | frame `close`                                         | research                                         | basis-independent: fractional shares, no costs and same-day fills make returns scale-invariant; the series must be one basis for the whole run | a basis-generation pin                                                      |
| Backtest trade prices and share counts as displayed                         | `BacktestTrade`                                       | research units at execution                      | research units, labelled as such                                                                                                               | documentation only                                                          |
| Daily SMA and EMA; weekly SMA and EMA                                       | `DailyDerivedState`, `WeeklyPrice`                    | research                                         | basis-independent within one basis; wrong across a mixed-basis step                                                                            | full rebuild on a re-base                                                   |
| RSI 7/14/21                                                                 | `DailyDerivedState`                                   | research                                         | basis-independent within one basis                                                                                                             | full rebuild on a re-base                                                   |
| RVOL 10/20/50                                                               | `DailyDerivedState` from `volume`                     | research volume, split-adjusted (APH ×2)         | basis-independent within one basis; the provider's volume treatment across distributions is unverified                                         | full rebuild on a re-base                                                   |
| Price compared with a moving average                                        | frame                                                 | research against research-derived                | basis-independent                                                                                                                              | none                                                                        |
| Benchmark returns, execution calendar                                       | `BenchmarkDailyPrice` (SPY), same endpoint            | provider-adjusted price return                   | a price return on the provider's basis, like the portfolio                                                                                     | none; the same re-base detector                                             |
| Intrinsic values (DCF, RI, DDM, Graham, blends)                             | statements: restated shares, EPS, dividends per share | current research share units                     | split-adjusted share units                                                                                                                     | unit conversion for a revision observed before a later share-changing event |
| Margin of Safety: frame, Stock Details, backtests, Monitors                 | IV against `close`                                    | IV in share units; the close carries `Φ`         | **split-adjusted**                                                                                                                             | **yes**                                                                     |
| Price compared with an intrinsic value; IV overlays on the chart            | frame `close` against IV; chart overlays              | as Margin of Safety                              | **split-adjusted**, or IV ÷ `Φ` on the research scale                                                                                          | **yes**                                                                     |
| P/E, P/S, P/FCF, EV/EBITDA (planned)                                        | —                                                     | —                                                | **split-adjusted** close × share basis                                                                                                         | blocked                                                                     |
| EPS growth TTM YoY (a fundamental metric)                                   | restated EPS                                          | share units, consistent within one vintage       | split-adjusted share units                                                                                                                     | unit conversion across a later share-changing event                         |
| Stock Details "price vs value" chips                                        | the latest close against the latest IV                | `Φ(today) = 1`                                   | split-adjusted, which equals research today                                                                                                    | none                                                                        |
| Monitor observation, Signal price, `lifecycleSincePrice`                    | live quote, or the research close at reconstruction   | as-traded when live; research when reconstructed | **as-traded**: a record of what was observed                                                                                                   | none; never compared with later research prices                             |
| Monitor state reconstructed from history                                    | historical frame                                      | as each operand                                  | as each operand                                                                                                                                | follows Margin of Safety                                                    |
| Dashboard price and market overview                                         | live quote; benchmark index series                    | as-traded; provider                              | as-traded; provider                                                                                                                            | none                                                                        |
| Insider and congressional money amounts                                     | disclosures                                           | as reported                                      | as reported                                                                                                                                    | none                                                                        |
| Any future comparison of a price with an absolute number ("price above $5") | —                                                     | —                                                | **as-traded**: the research level embeds later actions                                                                                         | a rule, below                                                               |

**No single stored column serves every consumer.** The research close is right for the chart,
the indicators and the engine. The split-adjusted close is right for every comparison with a
share count or per-share figure. The as-traded close is needed only to measure `Φ` and for
absolute price levels, which no consumer compares today.

## Decision

### 1. Two bases and one event ledger

- **The research close stays.** `DailyPrice.close` keeps its meaning, and every consumer that
  needs the research basis keeps it: the chart, the indicators, weekly prices, RVOL, the backtest
  engine and the benchmark.
- **Every comparison of a price with a share count or a per-share figure uses the split-adjusted
  basis:**
  - Margin of Safety is `(IV − researchClose × Φ) ÷ IV`.
  - A price compared with an intrinsic value, and an intrinsic-value overlay on the chart, use
    `IV ÷ Φ` on the research scale. The price series then stays continuous, and the comparison
    equals the one on the split-adjusted scale.
  - A market capitalisation is `researchClose × Φ × shareBasis`.
- **`Φ` is kept as a per-security basis-event ledger, not as a per-session column.**
  - `A` is piecewise constant. IBM's independent series shows one step in 22 years, matching the
    stored close to the cent on 98.7 % of 6,450 sessions (investigation, §2.4).
  - A handful of events per security therefore reproduce every session exactly: the stored set
    has 97 provider entries across 62 securities in 30 years.
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
  horizon are invisible in it, and at every confirmed distribution it moves with the market.
- **As-traded prices would need a share ledger.** Without one, every split would be a false
  crash: AAPL −75 % on 2020-08-31, NVDA −90 % on 2024-06-10. A ledger that must list every
  share-changing action of every security, and turns each missed one into a catastrophic
  return, is not justified.
- **Known limitation, recorded and not changed.** Where the provider folded a distribution into
  its series (MMM 2024), holding through the ex-date earns the distribution, as if reinvested.
  Where it did not (DIS 2007), the distribution is lost, as a price return loses a dividend.
  So a V1 result is a price return that includes most spin-offs. A total-return methodology
  would need its own decision and a dividend-and-distribution ledger.
- **Displayed trade prices and share counts are in research units at execution.** A later split
  changes the units shown by a new run and never its returns.
- **Rule.** No Strategy predicate may compare a research price level with an absolute number,
  because the research level embeds later actions: AAPL's 2003 closes read $0.23–$0.44 for a
  traded $13–$25. The current catalog complies: Price compares only with price-valued series. A
  future absolute-price metric uses `asTradedClose = researchClose × A`.

### 3. Share basis and unit conversion

- **The share basis stays the latest point-in-time quarterly `weightedAverageShsOutDil`.**
  - The investigation re-validates it: present on 6,391 of 6,391 quarters, 4 not positive.
  - It is restated by exactly `G`. The dividend-per-share method gives 0.48–0.51 across 27 HON
    quarters from 2002 and 1.00 across four spin-offs. The prior gate's as-reported probe gave
    ×4, ×10, ×20 and ×28 across splits.
  - Its single-quarter anomalies (B3, 593 sessions) stay provider data, as Margin of Safety
    already treats them. Valuation ratios decide for themselves.
  - As-filed counts are not a product input: 233 of 2,033 are defective.
- **Unit conversion.** A statement revision observed before a later share-changing event is in
  the old units.
  - Its per-share fields are converted at materialization into the current units: share counts
    × `g`, EPS ÷ `g`, dividends per share ÷ `g`.
  - This changes units, not information. The revision keeps its `availableFromDate`, and the
    economic content used on session `D` is exactly what was published by `D`.
  - Without it, a re-based history pairs new-unit prices with old-unit statements on every
    session before the event: B2's statement half.
- **Which units a revision is in is measured, not assumed.**
  - A later revision of the same fiscal identity whose share count differs from it by the
    event's `g`, within rounding, proves the earlier one is in old units.
  - A revision observed after the ex-date with no such pair is taken as current only after the
    provider's restatement lag. That lag is unmeasured today (open measurement O-2).
  - A session whose statement units are undetermined is `NOT_EVALUABLE` for share-derived values.
- **SEC EDGAR's XBRL facts** are a public-domain, independent check of as-filed counts. Using
  them needs a declared operator contact in the `User-Agent`. That is an owner fact, not decided
  here.

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
- **The split-adjusted basis is retrospective for share-changing actions only**, and every
  quantity computed on it is a ratio in which the share factor cancels. The value on session `D`
  is exactly what an observer on `D` would compute from the as-traded price and the as-filed
  share count. No information dated after `D` enters it.
  - `Φ(D)` is built from later events, but it only removes the provider's own retrospective
    adjustment. It restores the value on `D`; it adds nothing.
  - A future split changes units and never a result.
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
- **The share ratio `g`** is measured from statements, in this order of precedence:
  1. the ratio between revisions of the same fiscal identity across the event (exact, going
     forward);
  2. declared dividends against statement dividends per share (±2 %, regular payers only);
  3. as-reported counts (usable in 85 % of quarters).
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
  - one entry absent from the prices;
  - a combined event labelled as a spin-off whose share half the statements did restate.
- **An event not yet classified makes share-derived values before its ex-date `NOT_EVALUABLE`.**
  It never makes them guessed.

### 6. The historical basis needs an external as-traded reference

This is the blocker.

- **FMP cannot supply it.** Twelve endpoints were tested (investigation, §3). Only the declared
  dividends and insider trade prices are as-traded, and neither is a daily price.
- **What the reference must pass before it is canonical:**
  - **Whole-cent test.** After decimalisation, closes above $1 before a split date are whole
    cents. EODHD fails it (59 % of AAPL's are not), which reveals a close rebuilt from adjusted
    prices.
  - **Spin-off-date test.** The close on the session before each known distribution equals the
    printed price, not the price divided by the factor.
  - **Containment test.** At least 98 % of stored insider trades fall in the reference's session
    ranges, for the same securities and windows as the investigation.
  - **Coverage.** From the product horizon (1996-09-30) at least. From the retention start
    (four years earlier) to cover indicator warm-up. Delisted securities where the product
    shows them.
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

- **How it is used.** One full-history comparison per security:
  - the steps in `A` become ledger events carrying `a`;
  - `g` comes from statements, and `φ` follows;
  - re-verification is periodic.

  The runtime never depends on the vendor: the ledger is FactorSage's. The vendor's prices are
  stored only if the licence permits, and only for internal measurement.

- **The licence must allow:**
  - displaying values derived from its prices to paying users (Margin of Safety, the four
    ratios, their charts and Strategy results);
  - storing its data internally for measurement and audit.

  It need not allow displaying the vendor's prices themselves. The questions for sales are in
  the investigation, §7.

- **Until such a source is chosen and validated, `Φ` is unknown for history.** Margin of Safety
  stays as it is (section 12), and valuation ratios stay blocked.

### 7. Detecting a re-base

| Signal                                                               | Detects                                                                | False positives                                                         | False negatives                                                 | Extra provider cost                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------- |
| Overlap common ratio at the tail re-read                             | a re-base whose ex-date falls after the oldest settled row in the tail | none found: a correction is not one common ratio over several rows      | the provider re-bases after the tail has moved past the ex-date | none                                                    |
| Session anchor: the earliest persisted row, re-read once per session | any re-base that touches stored history, whenever it happens           | a provider correction of that one row; the full comparison then decides | none after the anchor                                           | one small request per resident security per session day |
| Provider split calendar                                              | listed share-changing actions                                          | mislabelled entries                                                     | MMM 2024, HON 2025                                              | one request a day for all securities                    |
| Periodic full comparison                                             | everything, including old corrections                                  | none                                                                    | none                                                            | two requests per security per period                    |
| Large day-over-day move                                              | nothing reliable                                                       | IBM's −4.9 % spin-off looks like a market move                          | spin-offs of a few percent                                      | none                                                    |

- **Chosen signals.** The overlap test and the session anchor, confirmed by a full comparison.
  The calendar may schedule an extra anchor check and is never required. The session anchor
  alone would suffice; the overlap test catches the common case with no extra request.
- **The rules:**
  1. **Test before saving.** Before a tail is saved, each returned row that was already stored
     and settled is compared with its stored value. Settled means dated before the previous
     sync's last session, which may still have been in progress when it was read. A session the
     provider had not published before is a new row, not a changed one.
  2. **What makes a re-base suspected.** At least two settled rows changed, and one ratio `r`
     explains every changed row within the per-row tolerance with `|r − 1| ≥ 0.2 %`. Or the
     anchor's close changed beyond that tolerance.
  3. **Per-row tolerance.** `|new − r × old| ≤ ½u(new) + r × ½u(old)`, where `u` is the
     provider's last published decimal: 0.01 at or above $1 and 0.0001 below (investigation,
     §6).
  4. **A suspected re-base is never saved into the tail.** The full re-read replaces the whole
     history instead (section 8).
  5. **Anchor and cost.** The anchor is re-read on the first refresh after a session closes. The
     current refresh budget is 28 requests per monitored security per day; the anchor adds one,
     or 3.6 %.

### 8. The full-history re-read

- **Trigger.** Rule 2 of section 7, and nothing else. A one-day correction is not one common
  ratio and leaves the anchor unchanged, so it takes today's path: the changed dates are
  rewritten and derived state is rebuilt from the earliest of them.
- **Read and compare.** The complete retained history is requested: two pages for 34 years.
  Every row is compared with the stored one.
- **Segment.** The history is split into maximal runs of consecutive sessions that share one
  ratio within tolerance.
  - Each boundary between two runs is a basis event. Its date is the first session of the later
    run, which also handles a provider date on a weekend or holiday (HON's entries are dated
    Sundays). Its price ratio is the ratio of the two runs.
  - Rows no run explains, at most 1 % of the history, are provider corrections.
- **An unexplained change.** If more than 1 % of rows fit no run, the event is recorded as
  unexplained.
  - The history is still replaced: the provider is the authority for the research series.
  - Share-derived values before the earliest changed row are `NOT_EVALUABLE` until they are
    measured.
- **Classification.** Every event starts as pending and is classified by section 5.

### 9. Atomic replacement and generations

- **PostgreSQL holds one generation per security.**
  - The new prices, weekly prices and derived rows are computed in memory, as a rebuild already
    is.
  - One transaction, under the existing per-security write lock, replaces all three for the
    whole retained range, bumps the security's basis generation, inserts the ledger event and
    updates coverage.
  - This is about 8,600 price rows, 8,600 derived rows and 1,800 weekly rows, the size of a cold
    hydration's writes. PostgreSQL never commits an old early history beside a new late one.
- **Redis.** The replacement is published as a new hydration generation, using the existing
  `HYDRATING` → `READY` swap.
  - Chunk reads must verify the manifest's generation atomically with the multi-year `MGET`:
    one script, or a re-check of the manifest afterwards.
  - Otherwise a reader that passed the `READY` check just before a republish can combine old and
    new years.
- **Monitor.** It reads prices from Redis and the derived tail from PostgreSQL. Both must carry
  the same generation, or the security is `NOT_EVALUABLE` for that cycle. A Signal emitted from a
  mixed frame would be permanent.
- **Backtest.** `PREPARING_DATA` records each security's generation, and every window read
  checks it. A mismatch fails the run with a retryable "market data changed during the run"
  reason, rather than letting a held position jump by a split ratio between two years. A
  security re-bases about once in twenty years, so this is rare.
- **Where the generation lives.**
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
- **`Φ` is applied at projection**, in the evaluation frame and the chart overlay, never stored
  per row. A newly classified distribution therefore needs no derived rebuild.
- **Redis:** every year is republished under the new generation.

### 11. Reproducibility

- **The contract is unchanged.** A completed run's stored results never change, and a new run
  may differ after the provider changes data (`ai/product/backtests.md`). A re-base is such a
  change:
  - for a share-changing action, a new run shows other units and the same returns;
  - for a distribution, it shows the returns the provider's new series implies.

  No archive of frozen data is needed.

- **Changing an interpretation is different.** Moving Margin of Safety and the price-to-value
  comparisons onto the split-adjusted basis is one, and it changes numbers for an unchanged
  Strategy and period.
  - It adds a `priceBasisRevision` to `BACKTEST_DATA_REVISIONS` in the same change.
  - A queued run is then refused rather than executed under the new rule with the old stamp.

### 12. Benchmark, weekly prices and Stock Details

- **Benchmark.** It stays on the research basis. SPY has had no share-changing action, and the
  comparison is price return against price return. Benchmark series use the same detector and
  replacement, because they share the endpoint and the tail refresh.
- **Weekly prices** stay research-only. No consumer needs an as-traded week, so none is stored.
- **Stock Details:**
  - The chart stays on the research close.
  - Intrinsic-value overlays are drawn at `IV ÷ Φ`, so the gap between the lines is the true
    one.
  - Valuation series get their own pane.
  - No second price line in V1. A tooltip or footnote says that valuations use prices adjusted
    for share splits only. An "as traded" view is derivable from the ledger (`researchClose × A`)
    if it is ever wanted.
- **Signals keep the price they were observed at.** After a later action that price no longer
  matches the chart. This is correct, and the documentation says so.

### 13. Margin of Safety

- **Root cause.** Every intrinsic value is a correct per-share figure in current share units.
  The comparison uses a research close that carries `Φ` (investigation, §5.1). One correction
  fixes all four models and three blends for B1.
- **Impact.**
  - 34,077 sessions (10.8 % of those with a value) and 211,653 values are overstated, in six of
    62 securities.
  - Intrinsic value ÷ price is overstated by exactly `Φ`, from 1.046 to 2.120.
  - The median overstatement is 18.0 points.
  - `Value & Trend`'s BUY condition is falsely true on 4,635 sessions, and its SELL condition
    falsely false on 4,369, of 28,720.
  - Today's value and every live Signal are unaffected, because `Φ(today) = 1`.
- **Interim product behaviour: C, a disclosure.** The affected sessions cannot be identified
  across the catalog from stored data:
  - the provider list omits events, and its count (17 % of US large caps) is a lower bound;
  - insider coverage starts in 2003 and is sparse;
  - only 64 of 9,768 catalog securities are loaded, and any other opens on demand.

  The other options are worse:
  - **B, a mask**, would be partial and would present the rest as verified;
  - **D, disabling** the historical metric, would remove a core feature whose live values are
    correct and whose history is right on 89 % of the stored sessions that have a value;
  - **A, silence**, is not acceptable once the defect is known.

  The disclosure belongs:
  - in the Margin of Safety metric's description in the Strategy Builder;
  - on backtest results whose Strategy uses Margin of Safety or a price-to-value comparison;
  - beside the intrinsic-value history on Stock Details.

  It is a separate small change, not made here.

- **The minimal fix.**
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
2. Re-base detection and atomic replacement (sections 7–9), so no future event mixes bases.
3. Statement unit conversion (section 3), so no future split mixes units.
4. The ratios' own methodology: windows, currency, recast statements around spin-offs, the B3
   decision. This is `valuation-ratios-v1.md`'s follow-up.

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

| Option                                    | Correctness                                                                     | Point in time       | Storage (per 34-year security)                         | Backtest compatibility              | Rebuild complexity                              | Debuggability                | Future valuation use |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------ | ----------------------------------- | ----------------------------------------------- | ---------------------------- | -------------------- |
| 1. `asTradedClose` column on `DailyPrice` | needs `G` beside it to become `Φ`; two sources in one row, corrected separately | as-traded is strict | +~69 KB PostgreSQL (+5 % heap), +~189 KB Redis (+14 %) | unchanged                           | every re-base rewrites both columns             | direct per session           | indirect through `G` |
| 2. Separate reference-price table         | as option 1, with source and licence isolated                                   | strict              | as option 1, or more with OHLC                         | unchanged                           | independent coverage and revision               | good: source per row         | indirect             |
| 3a. Per-session factor column             | redundant: `A` is piecewise constant                                            | derived             | +~69 KB PostgreSQL, +~171 KB Redis                     | unchanged                           | rewritten on every event                        | per session, but opaque      | direct               |
| **3b. Basis-event ledger (chosen)**       | exact wherever the events are measured; evidence per event                      | derived             | < 1 KB (a few events)                                  | unchanged                           | an event is appended; `Φ` applied at projection | per event, with its evidence | direct               |
| 4. Replace the close with as-traded       | breaks every split                                                              | strict              | none                                                   | **breaks** (−75 % AAPL, −90 % NVDA) | full                                            | —                            | rejected             |

**Chosen: 3b.** The reference series, if the licence permits storing it, is an internal table of
option 2's shape, used for measurement and audit only.

**Schema this eventually requires.** A sketch; each PR carries its own migration:

- **`PriceBasisEvent`:** `securityId`, `effectiveDate` (the first session of the new basis),
  `priceRatio`, `shareRatio`, `distributionRatio`, `classification`, `detectedBy`, `detectedAt`,
  `basisGeneration`, and `evidence` (JSON: the runs compared, the revisions paired, the source).
  - `classification` is one of `PENDING`, `SHARE_CHANGING`, `DISTRIBUTION`, `COMBINED`,
    `UNEXPLAINED`.
  - `detectedBy` is one of `REFERENCE`, `OVERLAP`, `ANCHOR`, `FULL_COMPARISON`.
  - Append-only; a correction is a new row.
- **`SecurityPriceBasis`:** one row per security, with `generation`, `anchorDate`, `anchorClose`,
  `verifiedThrough`, `verifiedAt`, `measuredFrom`, and `referenceSource`.
  - `measuredFrom` is the earliest session whose `Φ` is measured. Before it, share-derived values
    are unavailable.
- **The Redis manifest** gains `priceBasisGeneration`. The few ledger events travel with the
  projection, never as per-row fields.
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

| Alternative                                                       | Why not                                                                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Correct the close with the provider's split list                  | it omits, mis-sizes and mislabels events (investigation, §2.2)                                                           |
| The provider's `non-split-adjusted` series as the as-traded close | the adjusted series times that same list                                                                                 |
| Provider market-cap, enterprise-value or key-metric history       | computed from the adjusted close (MMM 2024-03-28 = 88.68 × 555.0 M)                                                      |
| The provider's dividend-adjusted series                           | its factors are computed on the adjusted close                                                                           |
| EODHD's `close`                                                   | documented as traded, observed reconstructed from adjusted prices; fails the whole-cent test                             |
| Insider trade prices as the reference                             | 33 securities stored, from 2003 at best, sparse and with non-market rows; they validate a basis, they cannot be one      |
| As-traded close × as-filed counts                                 | 233 of 2,033 as-filed counts are defective, and every split between the quarter and the session still has to be found    |
| As-traded close × stored (restated) counts                        | wrong by `G`: ×28 for AAPL 2013                                                                                          |
| A per-session factor, or a second OHLC series                     | redundant with a ledger (option 3a); no consumer for an as-traded OHLC (option 2 with OHLC)                              |
| Replacing the research close with as-traded prices                | breaks every split in every consumer (option 4)                                                                          |
| Repairing the tail's step heuristically                           | a split-sized day move cannot be told from a market move without the anchor, and a spin-off of 4 % cannot be told at all |
| A `PRICE_DATASET_VERSION` bump per re-base                        | global, manual, and re-reads every security for one event                                                                |
| Frozen per-run data snapshots                                     | not required by the reproducibility contract; costly                                                                     |
| A partial Margin of Safety mask                                   | cannot be complete from stored data (section 13)                                                                         |
| As-traded execution with a share ledger                           | a missed event becomes a catastrophic return (section 2)                                                                 |

## Gate result

| #   | Condition                                    | Result         | Evidence                                                                                                                                              |
| --- | -------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | A canonical as-traded source exists          | **not proven** | FMP has none. Alpha Vantage's raw close is validated for IBM only, through a demo key. Tiingo, Sharadar, Intrinio and CRSP document one, unvalidated. |
| 2   | Its licence suits a paid product             | **not proven** | Tiingo publishes a display plan; derived-metric scope unconfirmed. The others are by quotation or written permission.                                 |
| 3   | 30-year coverage                             | **not proven** | Claimed by Tiingo (1962), Intrinio (50+ years) and CRSP (1925); Sharadar from 1998; Alpha Vantage from 1999-11.                                       |
| 4   | Split and spin-off examples validate         | **not proven** | Splits validate everywhere. Spin-offs validate only for IBM against an independent series; MMM, WDC, HON, AXP and MRK only against insider prices.    |
| 5   | The share basis is coherent                  | **yes**        | `G` equals the share-changing ratios, measured two ways (§3).                                                                                         |
| 6   | Point-in-time semantics are defensible       | **yes**        | Section 4.                                                                                                                                            |
| 7   | The backtest basis can remain stable         | **yes**        | Section 2.                                                                                                                                            |
| 8   | Re-base detection is specified               | **yes**        | Sections 7–9. The provider's timing is an open measurement the design does not depend on.                                                             |
| 9   | The Margin of Safety correction is specified | **yes**        | Section 13; it depends on condition 1 for history.                                                                                                    |
| 10  | No major clean-room objection remains        | see "Review"   |                                                                                                                                                       |

Conditions 1–4 fail, so no product code is written for the historical basis.

## Implementation plan

Conditional. Each PR has its own tests, migration note and validation gate.

| PR                                              | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                              | Depends on                                      | Invariants                                                                                                                                                                                                             | Migration                                                                                                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 (optional, small)                             | The Margin of Safety disclosure (section 13) and its documentation                                                                                                                                                                                                                                                                                                                                                                                 | nothing                                         | copy only; no number changes                                                                                                                                                                                           | none                                                                                                                                                           |
| **1. Re-base-safe loading**                     | `SecurityPriceBasis` and `PriceBasisEvent`; the overlap test before a tail is saved; the session anchor; the full re-read and segmentation; single-transaction replacement of prices, weekly and derived rows; the generation in the manifest with atomic chunk reads; the backtest generation pin; generation-consistent Monitor reads; share-derived values `NOT_EVALUABLE` before a pending or unexplained event; the same for benchmark series | nothing                                         | PostgreSQL never holds two generations for one security; no tail is saved over an older generation; a run reads one generation; a one-day correction never triggers a full read; no provider call in the backtest loop | additive tables; basis rows created lazily with generation 1 and the earliest stored row as anchor; no backfill; stop-then-start deploy for the manifest field |
| **2. Classification and unit conversion**       | measuring `g` from revision pairs, with dividends as a check; classifying events; unit conversion at materialization; recording `φ` for forward events and applying it at projection; rebuild on classification                                                                                                                                                                                                                                    | PR 1; the timing measurements O-1 and O-2       | a revision's `availableFromDate` never moves; conversion only by a measured `g`                                                                                                                                        | additive columns only                                                                                                                                          |
| 3. Historical reference (**blocked**)           | an adapter for the chosen vendor behind a port (a new provider package, added to the dependency rules); one full comparison per security; historical ledger events with `a`, `g` and `φ`; `measuredFrom`; a verification report; periodic re-verification                                                                                                                                                                                          | a licensed source that passes section 6's tests | the ledger, never the vendor, is read at runtime; an event is never taken from a vendor label                                                                                                                          | reference table if licensed; a one-off per-security job, resumable                                                                                             |
| 4. Margin of Safety on the split-adjusted basis | the frame, Stock Details overlays and backtests; `priceBasisRevision` in `BACKTEST_DATA_REVISIONS`                                                                                                                                                                                                                                                                                                                                                 | PR 3 (and PR 2 for forward events)              | `NOT_EVALUABLE` before `measuredFrom` and before a pending event                                                                                                                                                       | none                                                                                                                                                           |
| 5. Valuation Ratios V1                          | re-run `valuation-ratios-v1.md`'s gate on this basis                                                                                                                                                                                                                                                                                                                                                                                               | PRs 1–4                                         | as that decision                                                                                                                                                                                                       | as that decision                                                                                                                                               |

**Open measurements before PR 2 fixes its constants:**

- **O-1: re-base timing.** Re-read the rows captured in
  `docs/historical-price-basis/evidence/rebase-observation-baselines.csv` daily around GPMT's
  1:10 on 2026-10-06 and DXJ's 3:1 on 2026-10-09. Then do the same for the next events in loaded
  securities.
- **O-2: statement-restatement lag.** Watch statements across the same events.
- **Volume across distributions.** Check whether the provider scales volume there, for RVOL.

## Tests the implementation needs

- **Share-changing actions:** an ordinary split; a reverse split; a stock dividend; a class
  distribution of the same company's shares (GOOG 2014).
- **Distributions:** a spin-off; a special cash distribution.
- **Combined events:** a split and a spin-off on the same ex-date (HON 2026, HLT 2017, MSI 2011);
  two events between two verifications.
- **Provider behaviour:**
  - a full-history re-base discovered by the overlap test;
  - the same re-base discovered only by the anchor, after the tail has moved past the ex-date;
  - a one-day correction, which must not trigger a full read;
  - a provider date on a weekend or a holiday.
- **Metadata:** an event missing from the provider's metadata; an event the metadata mis-sizes.
  The measured ratio wins in both.
- **A share anomaly** (B3) that must not be read as a split. Classification needs the same `g`
  across every re-observed quarter.
- **Identity:** a symbol change and a delisting; a spliced history must trip the anchor.
- **No look-ahead.** A value on `D` is identical when computed with data through `D` and with
  data after a later split, once units are converted.
- **No mixed generations:**
  - a concurrent reader during a replacement;
  - a backtest that crosses a replacement mid-run;
  - a Monitor cycle that meets a replacement.
- **Existing guarantees still hold:** no provider call in the backtest loop, and identical frames
  from the same generation.
- **Reference validation:** the whole-cent, spin-off-date and containment tests from section 6,
  run against the chosen source.

## Operational risks and deployment

- **A second vendor.** An outage or licence change stops new historical measurement only. The
  ledger is FactorSage's, and the runtime does not read the vendor.
- **Re-base storms.** A provider-wide recomputation would trigger many full reads. They go
  through the existing FMP gate, and the anchor keeps unaffected securities out. One full read
  is 2 requests and about 2 s of CPU (scaled from the measured cold hydration: 0.8 s for 12
  years, times 2.7).
- **Pending windows.** Between a detected share event and its classification, share-derived
  values are unavailable. Measure O-2 before promising a bound.
- **Mid-run failures.** A backtest crossing a replacement fails and must be re-run. This is
  expected about once per security every twenty years of runs.
- **Deployment.**
  - Additive migrations only.
  - The new manifest field makes every manifest non-current, so each security's projection
    rebuilds from PostgreSQL. That needs no provider traffic, but it is a stop-then-start deploy.
  - A `priceBasisRevision` bump refuses queued runs once (PR 4).

## Quantitative summary

| Measure                                          | Value                                                                                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Affected securities in the store                 | 6 of 62 with statements (9.7 %); none found among the other 56, all scanned                                                                                              |
| Affected sessions                                | 35,234 of 332,294 in the horizon (10.6 %); 34,077 of the 315,524 with a Margin of Safety value (10.8 %)                                                                  |
| Market-wide lower bound                          | 39 of 230 US large caps (17.0 %) carry a provider-listed price-only candidate since 1996-09-30, about 10 % of their sessions                                             |
| Maximum price-basis divergence                   | `Φ` = 2.120 (HON before 2018-10-01): `close × shares` is 47.2 % of the true value                                                                                        |
| Insider validation of the provider's own factors | WDC 64/64, IBM 361/361, MRK 178/178; MMM 0/306, HON 0/261 and 1/30, AXP 94/147                                                                                           |
| Candidate source coverage                        | Alpha Vantage IBM: 6,766 sessions from 1999-11-01, 88 % of the horizon; vendors claim 1962 (Tiingo) and 1998 (Sharadar, 93 %)                                            |
| Candidate validation error                       | Alpha Vantage vs stored × `A`: 6,366 of 6,450 sessions (98.7 %) within cent rounding; median deviation of the 84 exceptions 0.089 %, largest 1.01 %                      |
| Share-basis reconciliation                       | `G` from dividends within ±2 % of the share-changing ratio in every regular-payer quarter tested; as-reported counts within 2 % in 85.4 % of 2,033 quarters              |
| Storage increase (chosen model)                  | < 1 KB per security in PostgreSQL; < 200 B per resident in Redis                                                                                                         |
| Full-history refresh cost                        | 2 provider requests and about 2 s of CPU per event; about one event per security in twenty years (97 provider entries across 62 securities in 30 years)                  |
| Provider request volume                          | +1 request per resident security per session (+3.6 % of the refresh budget); a one-off historical comparison of at least one request per security with the chosen vendor |

## Review

Filled in by the clean-room review below.

## References

- `docs/historical-price-basis/INVESTIGATION.md` and `docs/historical-price-basis/evidence/`
- `docs/valuation-ratios-gate/INVESTIGATION.md`, `docs/decisions/valuation-ratios-v1.md`
- `docs/decisions/complete-price-coverage.md`, `intrinsic-value-engine.md`,
  `fundamentals-loader.md`, `backtest-run-persistence.md`
- `ai/architecture/deep-discovery.md` §6 and §15, `ai/product/backtests.md`,
  `ai/architecture/production-capacity.md`

# Historical Price and Corporate-Action Basis V1

## Status

**Draft: problem definition.** The evidence and the decision follow on this branch.

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

| Consumer | Current source | Current basis | Required basis | Change needed |
| --- | --- | --- | --- | --- |
| Stock Details price chart, OHLC | `DailyPrice` → Redis → `/stocks/:symbol`, `/prices` | research | split-adjusted for continuity; distribution treatment needs further decision | none now; documented |
| Latest price, change, previous close, day and 52-week range | the latest `prices[]` rows | research | split-adjusted (equal to as-traded after the latest event) | none |
| Daily returns: holdings value, equity curve, annual returns, drawdown, CAGR | frame `close` | research | a total return is the economic truth; V1 is a price return by product decision; needs further decision | none; the distribution inconsistency is documented |
| Backtest fill price, BUY and SELL execution, terminal liquidation | frame `close` | research | basis-independent: fractional shares, no costs and same-day fills make returns scale-invariant; the series must be one basis for the whole run | a basis-generation pin |
| Backtest trade prices and share counts as displayed | `BacktestTrade` | research units at execution | research units, labelled as such | documentation only |
| Daily SMA and EMA; weekly SMA and EMA | `DailyDerivedState`, `WeeklyPrice` | research | basis-independent within one basis; wrong across a mixed-basis step | full rebuild on a re-base |
| RSI 7/14/21 | `DailyDerivedState` | research | basis-independent within one basis | full rebuild on a re-base |
| RVOL 10/20/50 | `DailyDerivedState` from `volume` | research volume, split-adjusted (APH ×2) | basis-independent within one basis; the provider's volume treatment across distributions is unverified | full rebuild on a re-base |
| Price compared with a moving average | frame | research against research-derived | basis-independent | none |
| Benchmark returns, execution calendar | `BenchmarkDailyPrice` (SPY), same endpoint | provider-adjusted price return | a price return on the provider's basis, like the portfolio | none; the same re-base detector |
| Intrinsic values (DCF, RI, DDM, Graham, blends) | statements: restated shares, EPS, dividends per share | current research share units | split-adjusted share units | unit conversion for a revision observed before a later share-changing event |
| Margin of Safety: frame, Stock Details, backtests, Monitors | IV against `close` | IV in share units; the close carries `Φ` | **split-adjusted** | **yes** |
| Price compared with an intrinsic value; IV overlays on the chart | frame `close` against IV; chart overlays | as Margin of Safety | **split-adjusted**, or IV ÷ `Φ` on the research scale | **yes** |
| P/E, P/S, P/FCF, EV/EBITDA (planned) | — | — | **split-adjusted** close × share basis | blocked |
| EPS growth TTM YoY (a fundamental metric) | restated EPS | share units, consistent within one vintage | split-adjusted share units | unit conversion across a later share-changing event |
| Stock Details "price vs value" chips | the latest close against the latest IV | `Φ(today) = 1` | split-adjusted, which equals research today | none |
| Monitor observation, Signal price, `lifecycleSincePrice` | live quote, or the research close at reconstruction | as-traded when live; research when reconstructed | **as-traded**: a record of what was observed | none; never compared with later research prices |
| Monitor state reconstructed from history | historical frame | as each operand | as each operand | follows Margin of Safety |
| Dashboard price and market overview | live quote; benchmark index series | as-traded; provider | as-traded; provider | none |
| Insider and congressional money amounts | disclosures | as reported | as reported | none |
| Any future comparison of a price with an absolute number ("price above $5") | — | — | **as-traded**: the research level embeds later actions | a rule, below |

**No single stored column serves every consumer.** The research close is right for the chart,
the indicators and the engine. The split-adjusted close is right for every comparison with a
share count or per-share figure. The as-traded close is needed only to measure `Φ` and for
absolute price levels, which no consumer compares today.

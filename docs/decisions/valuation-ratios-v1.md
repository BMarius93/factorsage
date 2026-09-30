# Valuation Ratios V1

## Status

**Blocked. Not implemented.**

The split and share-basis gate had to pass before any product code was written, and it failed on
2026-09-30. `docs/valuation-ratios-gate/INVESTIGATION.md` holds the evidence, which a clean-room
review checked and corrected.

Nothing below is accepted methodology. The last section records two choices the evidence already
settles, as a starting point for the follow-up.

This decision builds on the documents below and does not reinterpret them:

- `fundamental-metrics-v1.md`, which reserves `P/E`, `P/S`, `P/FCF` and `EV/EBITDA` for a
  separate methodology lock;
- `intrinsic-value-engine.md`, whose per-share models divide by the latest point-in-time diluted
  share count;
- `fundamentals-loader.md`, for statement revisions and their availability;
- `complete-price-coverage.md`, for what stored price coverage means.

## Context

The four ratios combine a daily market observation with point-in-time statement values:
`P/E TTM`, `P/S TTM`, `P/FCF TTM` and `EV/EBITDA TTM`. Any coherent formulation of them needs an
equity value on each session `D`. The stored data offers one candidate:

```text
equityValue(D) = close(D) × weightedAverageShsOutDil of the latest point-in-time quarterly income statement
```

That is the share count the intrinsic-value engine already divides by. The candidate is right only
if the close and the share count carry the same adjustments.

## Decision

1. **Valuation Ratios V1 is not built on the stored data.** No `DailyDerivedState` column, no
   `DERIVED_STATE_REVISION` bump, no Strategy metric, no chart pane and no API route are added.
2. **The reason is blocker B1.** The stored close also carries price-only adjustments: spin-offs
   and distributions, and for HON a reverse split fused with a spin-off.
   - Share counts do not follow these adjustments.
   - So the candidate equity value is 4.4 % to 52.8 % too low on every session before such an
     adjustment. That is 10.6 % of the sessions of the securities with statements, in six
     securities.
   - Nothing stored identifies the affected sessions for every security, and the provider's own
     split history is not a reliable list of them.
   - Further findings are recorded in the investigation: B2, a split after a security is first
     loaded; B3, single-quarter share anomalies; and statements recast around spin-offs.
3. **Valuation ratios resume on a corporate-action basis** (see below). That prerequisite is its
   own decision and its own change.
4. **Margin of Safety has the same defect today.** It is recorded here and in
   `ai/architecture/deep-discovery.md` §15, and it is not changed.

## Why not ship with a documented limitation

- **The bias is material and long-lived.**
  - HON's multiples would read about half their true value for 25 years of history.
  - WDC's would read a quarter low for 28 years, MMM's a sixth low for 27 years, and AXP's about
    an eighth low for 9 years.
- **It is invisible.** A user, a Strategy or a backtest cannot tell a biased session from a
  correct one. The product could not mark them either, because it cannot identify them.
- **A valuation screen is where the error decides outcomes.** `P/E TTM is below 15` would buy HON
  on half its true multiple.
- **It would extend a known-wrong basis to four more metrics.** Every correction needs the same
  missing data.

## Alternatives considered

| Alternative                                                                       | Needs                                                           | Fixes B1 | Fixes B2 | Why not                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The candidate: close × latest diluted shares                                      | nothing new                                                     | no       | no       | Biased as above.                                                                                                                                                                                                                                                                 |
| `P/E` as close ÷ the sum of four quarterly diluted EPS                            | nothing new                                                     | no       | no       | Same bias, because EPS follows share restatements only. It adds the provider's EPS defects and puts `P/E` on a different basis from the other three ratios.                                                                                                                      |
| Basic instead of diluted shares                                                   | nothing new                                                     | no       | no       | Same bias, and not the basis Margin of Safety uses.                                                                                                                                                                                                                              |
| Correct the close with the provider's split history, by entry, label or ratio     | the split history                                               | no       | no       | The history omits MMM 2024 and HON 2025, misstates the size of HON 2018 and AXP 2005, and lists a DIS entry the close does not carry. Corrected with it, MMM would stay 16.4 % low, HON would be 0.3 % to 9.1 % low depending on the period, AXP 0.9 % high, and DIS 1.4 % high. |
| The provider's "unadjusted" close × as-filed share counts                         | two new provider datasets                                       | no       | partly   | That close is the adjusted one multiplied back by the same split history. The as-filed share counts are defective in 233 of the 2,033 quarters probed.                                                                                                                           |
| Only sessions after each security's latest split-history entry                    | the split history                                               | no       | partly   | It relies on the same incomplete history: MMM's whole history before 2024 stays biased.                                                                                                                                                                                          |
| Stored insider transaction prices as the as-traded reference                      | nothing new                                                     | partly   | no       | They cover 33 securities, from 2000, sparsely, with non-market rows, and none for WDC. They can validate a basis but not supply it for every session.                                                                                                                            |
| The provider's market-capitalisation, key-metrics or ratios endpoints             | a new provider dependency                                       | —        | —        | Not product truth (`fundamental-metrics-storage-and-evaluation.md`), and excluded for this slice.                                                                                                                                                                                |
| **An independent as-traded reference with a measured share effect (recommended)** | an as-traded close, statement evidence, loader and rebuild work | yes      | yes      | The largest change, and the only one that makes every session correct or unavailable. It fixes Margin of Safety too.                                                                                                                                                             |

## Recommended prerequisite: a corporate-action basis

1. **An as-traded reference independent of the provider's split history.**
   - This is the smallest additional dataset that answers B1: an unadjusted daily close that does
     not come from the split history. It could come from a second source, or from the provider if
     it offers a series that is really as traded (`historical-price-eod/non-split-adjusted` is
     not).
   - With it, the adjustment the stored close carries on each session is measured rather than
     assumed: `A(D) = asTradedClose(D) ÷ close(D)`.
   - The stored insider prices then audit that reference; they are not the reference.
2. **The share effect of the adjustments, from statements.**
   - `G(D)` is the factor by which the provider restated share counts for the adjustments after
     `D`. It is measured from the provider's restated and as-filed figures for the quarters
     concerned: share counts, or diluted EPS where the as-filed counts are defective, with a
     tolerance for cent rounding.
   - In the probe, AAPL's 2012 share counts are restated by 28, CRWD's by 4, HON's by one half,
     and IBM's and WDC's not at all.
   - A session where `G` cannot be measured is unavailable.
3. **A re-basing detector that does not depend on the split history.**
   - The recent-tail refresh already compares the rows it re-reads with the stored ones
     (`samePrice`). When every settled overlapping row changes by one common ratio, the provider
     has re-based the history.
   - That must trigger a full price re-read and a rebuild from the retention start, and record
     the observed factor.
   - Without it, the next split among the stored securities gives the stored close a split-sized
     step (B2) and breaks every price-derived series.
4. **Statement revisions in the price's basis.**
   - A revision observed before a share-changing adjustment is on the old basis. Its per-share
     inputs (diluted shares, EPS, dividends per share) are converted by the share factor of the
     adjustments between its observation and the price basis.
   - That is a unit conversion with facts already recorded, not future information.
   - How long the provider takes to restate its statements after a live split is unknown, because
     nothing stored predates one. It must be measured before this rule is fixed.
5. **The equity value on that basis.**

   ```text
   equityValue(D) = close(D) × A(D) ÷ G(D) × latest diluted shares in the price basis
   ```

   Every session where `A` or `G` is unmeasured is unavailable. Margin of Safety adopts the same
   basis in the same change.

6. **A separate methodology question: recast statements.** Around a spin-off the provider recasts
   some quarters to continuing operations and leaves others as filed, not necessarily the older
   ones, while net income stays the whole company's. A TTM revenue or EBITDA window can therefore
   mix bases. The follow-up decides whether such a window is used or made unavailable.

## Settled by the evidence, for the follow-up

These are not accepted methodology. They are two choices the investigation's evidence settles:

- **One equity value for all four ratios, `P/E` included.**
  - `P/E` is the equity value divided by net income TTM, not the close divided by the sum of four
    quarterly diluted EPS.
  - 191 of 6,387 quarters have a diluted EPS more than 20 % away from net income ÷ shares. Only
    21 of them are cent rounding; the other 170 are provider disagreements between EPS and net
    income.
  - Dividing net income by the share count avoids all of those, and keeps the four ratios on one
    basis.
- **The share count is the latest point-in-time quarterly `weightedAverageShsOutDil`**, as in the
  intrinsic-value engine.
  - It is present on all 6,391 quarterly income statements; four of them are not positive.
  - There is no fallback to basic shares or to an older quarter.
  - Its single-quarter anomalies (B3, 593 sessions) need a decision in the follow-up: accept them
    as provider data, as Margin of Safety does, or guard against them.

Everything else is left to the follow-up decision, once the prerequisite exists: identities,
storage fields, denominator rules, currency, windows, rebuild, and the Strategy and chart
semantics. It starts from `fundamental-metrics-v1.md`'s rules for windows, currency and
availability.

## References

- `docs/valuation-ratios-gate/INVESTIGATION.md`: the evidence and how to reproduce it.
- `ai/architecture/deep-discovery.md` §15: the same finding as it affects the running product.
- `docs/decisions/fundamental-metrics-v1.md`, `intrinsic-value-engine.md`,
  `fundamentals-loader.md`, `complete-price-coverage.md`.

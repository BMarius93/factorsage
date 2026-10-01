# Valuation Ratios V1

## Status

**Accepted direction, decided by the product owner on 2026-10-01 (evening). The detailed rules
below are this design's, written the same night, and are implemented by PR 1 and PR 2V.**

- **FactorSage V1 is FMP-only.** There is no second market-data provider, no purchased as-traded
  price series, no reconstruction of the historical distribution factor `Φ`, and no approximated
  historical value.
- **A valuation is correct or unavailable.** Where FMP's data puts a session's price and share
  count on one coherent basis, the ratio is available. Where a known or detected corporate action
  makes that basis unsafe, the ratio is unavailable. That is intended V1 behaviour, not a gap.
- **A Strategy Condition on an unavailable ratio does not match.**
- **This supersedes** the frozen-anchor architecture merged with PR #75 (`b90ab7e2`): valuation
  anchors carried by research returns, `Φ` at historical anchors, the vendor-backed historical
  backfill (PR 3V), the anchor version pin and the invariant 9 amendment that architecture needed.
  It also supersedes this decision's 2026-09-30 conclusion that valuation ratios need a per-session
  corporate-action basis. "What changed from PR #75" lists what was removed and why.
- **Margin of Safety is not covered by this decision.** It keeps its own problem and its own path
  (`historical-price-basis-v1.md`, §13). Nothing here changes how it is computed, except that PR 1
  keeps it on a consistent basis after a re-base, which PR 1 owes every share-derived value.
- **Owner** marks a rule the owner decided. Everything else is this design's.

The evidence is `docs/valuation-ratios-gate/INVESTIGATION.md` (the 2026-09-30 gate) and
`docs/historical-price-basis/INVESTIGATION.md` (the corporate-action investigation, with FMP's
ratio endpoints in §8). It is kept: it is why the unavailable policy exists.

## The product rule (owner)

```text
FMP data on a coherent price/share basis      -> AVAILABLE
known or detected basis ambiguity (spin-off,
unmeasured re-base, unexplained share count)  -> UNAVAILABLE
unavailable metric in a Strategy Condition    -> the Condition does not match
```

- **Five ratios:** P/E, P/S, P/B, P/FCF and EV/EBITDA.
- **Conditions only.** No Triggers in V1.
- **The Strategy Builder stays simple:** `P/E is below 15`, `P/B is below 2`, `P/FCF is below 20`,
  `EV/EBITDA is below 10`. It shows no distribution factor, corporate-action confidence, basis
  generation or availability machinery.
- **No per-session valuation persistence.** Daily values are computed when they are read.
- **No historical `Φ`.** A historical session the price basis cannot vouch for is unavailable; it is
  never repaired with an estimate.
- **Anchor-and-carry may be used where it genuinely simplifies safe valuation.** It does not here
  ("Computation and storage"), so it is not used.

## Definitions

```text
MC_t        = close(t) × K(t) × dilutedShares       market capitalisation on session t
P/E_t       = MC_t ÷ NetIncome_TTM
P/S_t       = MC_t ÷ Revenue_TTM
P/B_t       = MC_t ÷ Equity
P/FCF_t     = MC_t ÷ FCF_TTM
EV/EBITDA_t = (MC_t + NetDebt) ÷ EBITDA_TTM
```

- **`close(t)`** is the stored research close (`DailyPrice.close`), the series the chart draws and
  the backtest trades on.
- **`K(t)`** is the basis factor of "Price-basis safety", rule 5. It is 1 unless a re-base measured
  by PR 1 separates the share count's observation from session `t`, and in the stored data today it
  is 1 everywhere.
- **EV/EBITDA is computed from its components.** The market capitalisation moves with the price and
  net debt is the balance sheet's dollar amount. Scaling the whole ratio by price would scale net
  debt with the share price: up to 13.3 % wrong on IBM and 72.5 % between FMP's quarterly rows
  (investigation, §8.4 and §9.4).
- **Units.** Raw multiples, like Fundamental Metrics' multiples. A Value is entered as `15`, shown as
  `15x`.

### Inputs, inherited from accepted decisions

| Input           | Definition                                                                                                                                      | Source                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `dilutedShares` | `weightedAverageShsOutDil` of the latest point-in-time Income quarter, `> 0`; no fallback to basic shares or an older quarter                   | `intrinsic-value-engine.md`; the 2026-09-30 gate                    |
| `NetIncome_TTM` | `netIncome` summed over exactly four consecutive Income quarters `Q[-3]..Q[0]`                                                                  | `fundamental-metrics-v1.md`, shared rules 3–5 and 11                |
| `Revenue_TTM`   | `revenue` over the same four Income quarters                                                                                                    | as above                                                            |
| `EBITDA_TTM`    | `ebitda` over the same four Income quarters                                                                                                     | `fundamental-metrics-v1.md` §13                                     |
| `FCF_TTM`       | `operatingCashFlow + capitalExpenditure` over four consecutive Cash Flow quarters, ending at that family's latest quarter; never `freeCashFlow` | `fundamental-metrics-v1.md`, "Free cash flow convention"            |
| `NetDebt`       | `netDebt` of the latest point-in-time quarterly Balance Sheet, independent of the flow windows; never reconstructed                             | `fundamental-metrics-v1.md` §13                                     |
| `Equity`        | `totalStockholdersEquity` of the latest point-in-time quarterly Balance Sheet                                                                   | the equity field of ROE, Debt / Equity and Residual Income; see P/B |

- **The point-in-time rules of `fundamental-metrics-v1.md` apply unchanged.** Only revisions with
  `availableFromDate <= t` exist; each fiscal identity is its latest eligible revision; a window is
  exactly four consecutive standalone quarters and an `FY` row never fills one; a missing quarter
  makes the ratio unavailable; there is no fallback to an older window; a revision keeps the
  loader's `availableFromDate`.
- **P/E is market capitalisation over net income**, not the close over the sum of four quarterly
  EPS: 191 of 6,387 stored quarters have a diluted EPS more than 20 % from net income ÷ shares, and
  only 21 of them are cent rounding (2026-09-30 gate).
- **P/B uses `totalStockholdersEquity`.** It is the one equity field every accepted definition
  reads, and the accepted rules refuse `totalEquity` because minority interest would change what
  the denominator means. It includes preferred stock while the market capitalisation does not; in
  the store that is 31.9 % of MSTR's equity, 10.6 % of GS's, 5.6 % of JPM's, 1.5 % of V's and 0.1 %
  of BA's, and nothing for the other 57. Deducting `preferredStock` is an open owner choice
  ("Open owner decisions"), not a V1 rule.

### Unavailability from the inputs (owner defaults)

A ratio is unavailable on a session when any of these holds, and its value is then absent: `NaN` in
an evaluation frame, absent in an API response, never zero, infinity, a sentinel or a stale value.

- **A denominator `<= 0`:** net income, revenue, equity, free cash flow or EBITDA. `P/E is below 15`
  then never admits a loss-maker. The numerator of EV/EBITDA may be negative: net cash larger than
  the market capitalisation is a real reading.
- **A share count that is missing or `<= 0`.**
- **A statement currency other than the trading currency.** Every statement a ratio reads reports
  the same non-empty `reportedCurrency`, equal to `Security.currency`. There is no FX conversion.
  TSM reports TWD and is quoted in USD, so it has no V1 valuation.
- **A missing input or an incomplete window.**
- **A result that is not finite, or not representable** as a calculated-series value, as for
  Fundamental Metrics.
- **No synthetic starting value.** A security's first value is on the first session its inputs are
  complete and its basis is safe.

## Price-basis safety

### Why it is needed

`close × dilutedShares` is the true market capitalisation only when the research close and the
share count are in the same units:

- **Splits are fine.** FMP restates share counts by the splits it folds into the close, so the
  factors cancel: all 89 splits in the horizon are invisible in the close, and 87 of them in the
  stored counts as well.
- **Folded distributions are not.** FMP's adjusted close also absorbs most spin-offs as if they were
  splits, and share counts rightly do not follow them. Before such an event the product is low by
  the distribution factor `Φ`: 4.4 % (IBM) to 52.8 % (HON) on 35,234 of 332,294 stored sessions
  (2026-09-30 gate).
- **A split after the share count was observed** puts the count in old units beside re-based
  prices, unless something accounts for it (B2).
- **After a spin-off** the market capitalisation describes the company without the distributed
  business while the statements still describe the combined company, until a statement covers the
  event.

`Φ` cannot be measured from FMP for history: FMP has no as-traded series (investigation, §3), its
split list omits and mis-sizes events, and its other factor histories disagree with each other.
So the rule does not measure `Φ`. It withholds what it cannot vouch for.

### Corporate-action events

Two sources, and nothing else:

- **Provider entries.** FMP's per-security split list (`stable/splits`), stored by PR 2V: date,
  numerator, denominator and label. It is the only FMP record of historical adjustments, and it is
  incomplete (MMM below).
- **Measured re-bases.** PR 1 compares the stored history with FMP's whenever FMP re-bases it,
  and records each step it measures: its effective date (or the interval it lies in, when it fell
  between two reads), the price ratio of the rows before it, and when it was detected; or an
  `UNEXPLAINED` change. See `historical-price-basis-v1.md`, §7–9.

An event is a **plain share change** when its ratio, in lowest terms `n:d`, has `n` and `d` both at
most 10, or `n = 1`, or `d = 1`, and, for a provider entry, its label is `stock-split`. A measured
ratio is plain when it is within 0.5 % of such a ratio. Every observed FMP distribution entry fails
it (523:500, 131:125, 1323:1000, 10000:8753, 1011:1000, 1907:2000 `spin-off`, 5000:2399, 331:250),
and every ordinary split and reverse split passes it (2:1, 3:2, 4:1, 1:10, 20:1, 1:32). Stock
dividends (51:50, 11:10) and labels other than `stock-split` fail it: they are treated as
distributions, which over-masks and never under-masks.

`verifiedAt` (`SecurityPriceBasis.verifiedAt`) is the instant PR 1 first verified a security's
whole stored history against FMP's (`historical-price-basis-v1.md`, §7). Provider entries dated on
or before it are history. Entries after it are forward events, which PR 1 measures when FMP
re-bases the prices, so the provider entry is not needed for them.

### The rules

For a ratio `r` on session `t`, with `R` the share-count revision (the latest point-in-time Income
quarter) observed at `R.observedAt`:

1. **The inputs** (previous section) are complete, positive and in the trading currency.
2. **The share count is not an anomaly.** If the two Income quarters before `R`'s exist, `R`'s
   count is within 25 % of at least one of them. A count that differs by more than 25 % from both
   is unavailable, with no fallback. In the store, quarter-on-quarter changes beyond 25 % are 99 of
   6,325, the 99.0th percentile is 33 %, and the both-quarters rule flags 66 quarters: initial public
   offerings, large mergers and FMP artefacts such as NKE's ×2.03 quarter and V's alternating ±40 %
   in 2010–2012. A merger quarter is withheld once; the next quarter agrees with it and is
   available. A one-quarter artefact is withheld; the next quarter agrees with the quarter before
   it and is available.
3. **The share count was not restated in units unexplained.** If `R`'s count differs by more than
   25 % from the previous revision of the same fiscal quarter, a measured re-base detected no later
   than `R.observedAt` must explain it (its ratio within 2 %). Otherwise `R` is unavailable. This
   is what keeps a restatement FMP publishes before an ex-date (open measurement O-2) from being
   read against old-basis prices.
4. **History, from provider entries** dated on or before `verifiedAt` and not superseded by a
   measured re-base within seven calendar days of them:
   1. **A distribution or any non-plain entry at `E`:** `r` is unavailable until every statement
      family it reads has a point-in-time latest quarter whose fiscal period ends on or after `E`.
      That covers every session before `E`, where the close carries `Φ`, and the sessions after
      it whose statements still describe the company before the event.
   2. **Any entry at `E` with `R.observedAt < E`:** unavailable. A count observed before an event
      that was folded into the stored prices without being measured has unknown units. Nothing in
      the store today meets this; it guards data loaded before PR 1.
5. **Measured re-bases detected after `R.observedAt`**, each in turn:
   1. `UNEXPLAINED`: unavailable.
   2. `R` observed before the event and `t` before the event: `K(t)` is multiplied by the measured
      ratio. That restores the close to the basis `R` was observed on, exactly.
   3. Otherwise unavailable: `t` on or after the event, `t` inside an undated interval, or `R`
      observed after the event's date but before its detection. Without classification the units
      of `R` relative to the close are unknown there.
6. **After a measured non-plain re-base at `E`**, on sessions on or after it: `r` is unavailable
   until every statement family it reads has a point-in-time latest quarter whose fiscal period
   ends on or after `E`, as in rule 4.1.

The statement families: P/E and P/S read Income; P/B reads Income and Balance Sheet; P/FCF reads
Income and Cash Flow; EV/EBITDA reads Income and Balance Sheet.

### Why these ranges are the smallest safe ones

- **Before an unmeasured distribution at `E`, every session is unsafe.** `Φ(t)` is the product of
  every folded factor after `t`, so it is not 1 anywhere before the latest one. Masking less would
  emit a known-biased value; the only way to mask less is to measure `Φ`, which V1 does not do. HON
  is the extreme: its latest entry is 2026-06-28, and every earlier session carries a factor of
  1.9 to 2.1, so HON's valuation starts on 2026-07-24.
- **After it, the range ends at the first statement that covers the event**, per ratio. A shorter
  window would pair the post-event market capitalisation with statements that are entirely about
  the company before it (IBM's next filing after Kyndryl covered Q3 2021, which ended before the
  ex-date; WDC's balance sheet lagged its income statement by 71 sessions).
- **A plain split masks nothing in history**: the counts and the close are restated together.
- **A measured re-base masks only the window it cannot order.** Before it, `K` restores the exact
  basis. On and after it, the window ends at the first share revision observed after its detection
  (days for a split FMP restates, up to a quarter for a distribution), plus rule 6 for a
  distribution.
- **What is not masked:** a session whose statements lag a distribution after a covering statement
  exists (the trailing window still holds quarters from before it). That is the statement-content
  limit Fundamental Metrics already have (`fundamental-metrics-v1.md`; `historical-price-basis-v1.md`
  §13), not a price-basis question.

### The six known securities

| Security | Event (ex-date)                     | FMP entry               | Behaviour                                                                                                             |
| -------- | ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| WDC      | Sandisk (2025-02-24)                | 1323:1000 `stock-split` | masked; P/E, P/S, P/FCF from 2025-05-05, P/B and EV/EBITDA from 2025-08-15 (balance sheet with a period end after it) |
| IBM      | Kyndryl (2021-11-04)                | 523:500 `stock-split`   | masked through 2022-02-22; available from 2022-02-23 (the next filing covered Q3 2021, before the ex-date)            |
| MRK      | Organon (2021-06-03)                | 131:125 `stock-split`   | masked; available from 2021-08-10                                                                                     |
| AXP      | Ameriprise (2005-10-03)             | 10000:8753              | masked; available from 2006-03-07                                                                                     |
| HON      | 2018, 2025 spin-offs; 2026 combined | 1011:1000; 1907:2000    | masked through 2026-07-23 (the unlisted 2025 Solstice event lies inside the 2026 mask); available from 2026-07-24     |
| **MMM**  | **Solventum (2024-04-01)**          | **none**                | **not masked: 6,920 sessions before 2024-04-01 read 16.4 % low. See "Open owner decisions".**                         |

- MMM's adjustment is in FMP's adjusted close and in no FMP metadata. Checked on 2026-10-01:
  `stable/splits` lists only its 1994 and 2003 2:1 splits; `stable/dividends` has
  `dividend ÷ adjDividend = 1` after 2003, so it carries no Solventum factor; its `yield` field
  implies the adjusted close (77.63 on 2024-02-15 against 77.27 stored and about 92.5 as traded).
  The only FMP-sourced evidence is the insider trade prices the investigation used (0 of 306 trades
  inside the stored range, 306 of 306 at ×1.1963).
- HON's 2025 Solstice spin-off is also missing from the split list, but every HON session before it
  is already inside the 2026 mask.
- The rule names no security: these rows are what it computes from FMP's lists and the stored
  statements.

### Measured coverage

The development store, 62 securities with statements, product horizon (1996-09-30 to 2026-09-25),
price-basis rules 4.1 only (the inputs, rules 1–3 and the windows make further sessions
unavailable for reasons every fundamental shares):

| Ratio           | Unavailable sessions | Share of 332,294 |
| --------------- | -------------------- | ---------------- |
| P/E, P/S, P/FCF | 36,312               | 10.9 %           |
| P/B, EV/EBITDA  | 36,383               | 10.9 %           |

- Eight securities are affected: HON 6,392, IBM 6,393, MRK 6,257, WDC 7,194 (7,265 for the
  balance-sheet ratios), DIS 2,736, GOOGL 2,515, GOOG 2,452 and AXP 2,373.
- DIS (2000:1973 in 2007, whose price effect the investigation could not determine) and GOOG and
  GOOGL (the 2014 class C distribution, 1001:500 and 999:500) are masked because their entries are
  not plain. That is over-masking by design: their bias, if any, is at most a few tenths of a
  percent.
- Rules 4.2, 5 and 6 mask nothing in the store today: every statement was observed between
  2026-08-31 and 2026-09-28, after every listed event, and nothing has been measured yet.
- The figure is reported, not optimised. No rule was added to raise it.

## Computation and storage

- **One pure calculation**, in `@intrinsic/stock-data`, computes a security's daily ratios from its
  stored closes, its point-in-time statement revisions, PR 1's measured re-bases and the stored
  provider entries. It reads no provider, writes nothing and has no clock.
- **Every consumer calls it:** the backtest evaluation frame, the Monitor frame (with the live quote
  as the provisional close) and the Stock Details series. So a chart and a Strategy show the same
  number.
- **Nothing is stored per session.** Valuation ratios are projected the way Margin of Safety is:
  from stored inputs, when they are read. This is a scoped exception to AGENTS.md invariant 9, which
  stores every other calculated daily series as an explicit column; the owner decided it, and the
  invariant records it.
- **Anchor-and-carry is not used.** The 2026-10-01 design froze a market capitalisation per
  statement event and carried it by research returns, so that later re-bases cancelled. PR 1 now
  measures every re-base exactly, so the per-session product with `K` gives the same forward safety
  with no frozen state: no anchor table, no supersession, no pending reasons, no late-revision
  rewrites and no anchor version to pin. Across a distribution the frozen anchor also carried an
  "as if reinvested" value; under the owner's rule that window is unavailable instead.

## Strategy Conditions, backtests and Monitors

- **One metric kind per ratio identity**, in its own product catalog with one label and one order,
  like Fundamental Metrics. Conditions only, with the strict `is above` / `is below` pair. Values
  are raw multiples bounded only where the ratio's own mathematics is: `>= 0` for P/E, P/S, P/B and
  P/FCF, whose numerator and denominator are both positive when available, and any finite number
  for EV/EBITDA, whose enterprise value can be negative.
- **Unavailable is `NOT_EVALUABLE`**, and a Condition that is not evaluable does not match. A
  backtest never buys on it; a Monitor never raises a Signal on it.
- **The Monitor** evaluates its provisional observation with the live quote as the close and the
  inputs eligible on the observation date. When the quote moves by a split-sized amount against the
  newest stored close, PR 1's ex-date hold makes the security not evaluable for that cycle.
- **Fingerprints and duplicate detection** include the ratio identity, so two ratios never share a
  definition hash or a Monitor latch, and `P/E is below 15` fingerprints identically wherever it
  appears.
- **The Strategy Builder** places the ratios in the Valuation category and shows their names only.
  A metric description says, in one sentence, that a ratio is unavailable around corporate actions
  the data cannot place consistently, and that an unavailable ratio does not match.

## Determinism

- **A backtest reads one price basis per security.** PR 1 records each security's price-basis
  generation when the run prepares its data, and every window read checks it. A re-base during the
  run fails it with a message to run it again (`historical-price-basis-v1.md`, §9).
- **Measured re-bases belong to a generation**, so a run pinned to one reads a fixed `K`.
- **Statements and provider entries** change between runs as the provider publishes, exactly as for
  Fundamental Metrics: a new run may differ, a completed run never changes.
- **A data revision** for the valuation methodology is recorded in every run snapshot, so a queued
  run is refused across a change of these rules.

## What changed from PR #75

| PR #75 element                                                                    | Under the FMP-only decision                                                                                                       |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Frozen valuation anchors, carried by research returns                             | removed: the per-session product with PR 1's measured `K` is exact forward and needs no frozen state                              |
| `ValuationAnchor` table, supersession, pending-reason sets, late-revision rule 11 | removed with the anchors                                                                                                          |
| The "as if reinvested" reading across a distribution                              | removed: the window is unavailable                                                                                                |
| Historical anchors from `Φ` (PR 3V) and the external as-traded vendor (PR 3)      | removed: no second provider; unsafe history is unavailable                                                                        |
| Measured unit evidence for revisions observed before a later split (PR 2)         | removed for valuation: `K` restores the price side exactly; an unexplained restatement is unavailable (rule 3)                    |
| The anchor version pin and the per-attempt data-pin table                         | removed: a run re-simulates from its first day on retry, so an in-memory generation pin per attempt suffices                      |
| `observedSince` from a verified read                                              | kept as `verifiedAt`, which separates provider-listed history from measured events                                                |
| Undated intervals for events between two reads                                    | kept: `K` cannot be applied inside one                                                                                            |
| The settling delay and a generation bump on every one-row correction              | removed: they protected frozen anchor closes; nothing is frozen now                                                               |
| The ex-date calendar hold                                                         | replaced by PR 1's stateless split-sized-move hold                                                                                |
| The periodic monthly full comparison                                              | removed: the earliest-row check catches every full-history re-base                                                                |
| The invariant 9 amendment "if the owner accepts"                                  | made: the owner decided no per-session valuation persistence                                                                      |
| U1–U4                                                                             | decided by the owner's defaults: denominators `<= 0`, currency, the existing equity field, anomalies unavailable                  |
| U5 (bootstrap), U7 (Triggers), U9 (rebuild a corrected anchor)                    | U5: no synthetic start; U7: Conditions only; U9: no anchors                                                                       |
| U6 (statements around a distribution), U8 (unfolded distributions)                | U6: the price-basis windows above; the remaining statement lag is shared with Fundamental Metrics. U8: see "Open owner decisions" |

## Open owner decisions

1. **Folded distributions FMP does not list (MMM).** The rule cannot see them, so MMM's history
   before 2024-04-01 is available and 16.4 % low. HON's 2025 event is the only other one known, and
   it is masked by HON's 2026 entry. Three choices:
   - **(a) Accept it as a disclosed V1 limit.** The metric description says that history before
     a distribution FMP does not record can be biased. No code.
   - **(b) Add FMP's insider trade prices as a second historical signal.** The investigation's
     range-containment test flags MMM, HON and AXP, and also flags feed defects (class B trades filed
     under BRK-A, class mixing in GOOG and GOOGL, non-market rows in GS, MRK and AAL), which would
     mask those histories too. It needs insider ingestion for every valued security, thresholds, and
     still sees nothing for a security without open-market insider trades. It is the kind of
     confidence test this decision otherwise avoids.
   - **(c) No historical valuation before `verifiedAt`.** Safe and simple, and it removes every
     historical value, including the 89 % the rule shows to be safe.
   - **Recommended: (a)** for V1, with the disclosure, because (b) adds a statistical subsystem and
     false positives for one known case, and (c) removes the feature's history. PR 2V implements
     the rule as written; adopting (b) or (c) changes rule 4 only.
2. **Preferred stock in P/B.** `totalStockholdersEquity` is used (above). Deducting `preferredStock`
   would raise P/B by 46.8 % for MSTR, 11.9 % for GS and 6.0 % for JPM. One line of the calculation;
   no other part depends on it.
3. **Triggers.** Conditions only in V1. Margin of Safety supports `crosses above` and
   `crosses below`; whether valuation ratios should is a later product decision.

## Rejected alternatives

| Alternative                                                                           | Why not                                                                                                                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `close × latest diluted shares` on every session, unmasked (the 2026-09-30 candidate) | biased by `Φ` before every folded distribution; masked by the rules above it is what V1 computes                                          |
| A second provider or a purchased as-traded series                                     | the owner's FMP-only decision                                                                                                             |
| Reconstructing `Φ` from insider prices, FMP's dividend factors or its split list      | approximate, sparse, or wrong for the very events that matter (MMM, HON 2025)                                                             |
| FMP's ratio, key-metric, market-capitalisation or enterprise-value history            | the same biased inputs, one quarter annualised on basic shares, rewritten after the fact and dated before publication (investigation, §8) |
| Frozen anchors carried by research returns                                            | the 2026-10-01 design; superseded (above)                                                                                                 |
| Persisted daily valuation columns                                                     | the owner's no-per-session-persistence decision; they would also have to be rebuilt after every re-base                                   |
| Carrying the whole EV/EBITDA ratio by price                                           | scales net debt with the price (investigation, §9.4)                                                                                      |
| P/E as price ÷ the sum of four quarterly diluted EPS                                  | 170 of 6,387 quarters disagree with net income by more than 20 % for reasons other than rounding, and it puts P/E on another basis        |
| Basic shares                                                                          | not the basis the intrinsic-value engine uses, and no less biased                                                                         |
| Masking a security's whole history whenever it has any corporate action               | over-masks every plain split, which FMP restates consistently                                                                             |

## The 2026-09-30 gate

Condensed; the record is `docs/valuation-ratios-gate/INVESTIGATION.md`.

- **The candidate was `close × latest diluted shares` on every session. It failed (B1).** The stored
  close also carries price-only adjustments, which share counts do not follow: 4.4 % to 52.8 % low
  on 10.6 % of the sessions of the securities with statements, in six securities. Nothing stored
  marked the affected sessions, and the provider's split list is not a reliable list of them.
- **It also found** B2 (a split after a security is first loaded), B3 (single-quarter share
  anomalies) and statements recast around spin-offs.
- **What this decision keeps from it:** one equity value for every ratio, P/E included, and the
  latest point-in-time quarterly `weightedAverageShsOutDil` as the share count, present on all 6,391
  quarterly income statements, four of them not positive.

## References

- `docs/decisions/historical-price-basis-v1.md`: terminology, PR 1 (re-base-safe loading, measured
  re-bases, generations, the hold), and Margin of Safety's separate problem.
- `docs/historical-price-basis/INVESTIGATION.md` and `evidence/`, and
  `docs/valuation-ratios-gate/INVESTIGATION.md`: the evidence.
- `docs/decisions/fundamental-metrics-v1.md`, `fundamental-metrics-storage-and-evaluation.md`,
  `intrinsic-value-engine.md`, `fundamentals-loader.md`,
  `retain-wide-column-calculated-series-storage.md`.
- `ai/product/strategies.md` (the metric family) and `ai/architecture/deep-discovery.md` §15.

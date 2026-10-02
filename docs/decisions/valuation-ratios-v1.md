# Valuation Ratios V1

## Status

**Accepted direction, decided by the product owner on 2026-10-01 (evening). The detailed rules
below are this design's, written the same night; PR 1 (`historical-price-basis-v1.md`) implements
the price-basis part and PR 2V the ratios. A clean-room review corrected them the same night
("Review"). PR 2V implements them as written (`packages/stock-data/src/valuation-ratios.ts`), and
"Measured coverage" reports what the implementation computes on the development store.**

- **FactorSage V1 is FMP-only.** There is no second market-data provider, no purchased as-traded
  price series, no reconstruction of the historical distribution factor `Φ`, and no approximated
  historical value.
- **A valuation is correct or unavailable.** Where FMP's data puts a session's price and share
  count on one coherent basis, the ratio is available. Where a known or detected corporate action
  makes that basis unsafe, the ratio is unavailable. That is intended V1 behaviour, not a gap.
- **A Strategy Condition on an unavailable ratio does not match.** It is `NOT_EVALUABLE`, as every
  unavailable metric is: a backtest never acts on it, and a Monitor never raises a Signal on it.
- **One limitation is accepted for V1** (owner, 2026-10-02). A basis-changing event that FMP does
  not report and FactorSage cannot otherwise detect escapes the rules below, and the ratios before
  it are biased. MMM's Solventum spin-off is the known case. It is accepted, not treated as correct
  ("Accepted V1 limitation").
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
basis event FMP does not report and V1
cannot otherwise detect (MMM, 2024)           -> not seen: AVAILABLE and biased,
                                                 an accepted V1 limitation
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
- **`K(t)`** is the basis factor of `historical-price-basis-v1.md` §10, for the share count's
  revision: it puts the close on the basis that revision was observed on, or withholds the session
  where that basis cannot be known. It is 1 unless PR 1 measured a re-base, which is everywhere in
  the stored data today.
- **EV/EBITDA is computed from its components.** The market capitalisation moves with the price and
  net debt is the balance sheet's dollar amount, as of each session's own statements. Nothing is
  carried by price, so net debt never scales with the share price.
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
  of BA's, and nothing for the other 57. Deducting `preferredStock` is a later owner choice
  ("Later owner choices"), not a V1 rule.
- **Share counts follow the listing.** FMP serves depositary units for HSBC's and TSM's ADSs,
  class A units for BRK-A and class B units for BRK-B, so the close times the count is in one unit
  for all four (investigation, §9.5). That was checked on those four only; the currency rule removes
  most foreign listings anyway, and a listing whose count FMP serves in other units would be wrong
  by that ratio. It is a stated limit, not a rule.

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
  incomplete (MMM below). It also lists announced events before their ex-date: on 2026-10-01 it
  held GPMT's 1:10 for 2026-10-06 and DXJ's 3:1 for 2026-10-09.
- **Measured re-bases.** PR 1 compares the stored history with FMP's whenever FMP re-bases it,
  and records each step it measures: its effective date (or the interval it lies in, when it fell
  between two reads), the price ratio of the rows before it, and when it was detected; or an
  `UNEXPLAINED` change. See `historical-price-basis-v1.md`, §7–9.

An event is a **plain share change** when its ratio is `k:1` or `1:k` for a whole `k >= 2`, or one
of 3:2, 5:4, 4:3, 5:2 and 5:3 either way: exactly, for a provider entry labelled `stock-split`;
within 0.5 %, for a ratio PR 1 measured. Every observed FMP distribution entry fails it (523:500,
131:125, 1323:1000, 10000:8753, 1011:1000, 1907:2000 `spin-off`, 5000:2399, 331:250), and every
ordinary split and reverse split passes it (2:1, 3:2, 4:1, 1:10, 20:1, 1:32). The list is short on
purpose: the ratios between 1 and 1.5 are dense with spin-off factors, and AXP's Ameriprise factor
(10000:8753) lies within 0.03 % of 8:7. Stock dividends (51:50, 11:10), rarer splits (9:5, 7:5)
and labels other than `stock-split` fail it: they are treated as possible distributions, which
over-masks and never under-masks. The predicate trusts a provider entry that does pass it, and a
distribution the provider encoded as an exact common split ratio would be missed; no observed entry
does that.

`verifiedAt` (`SecurityPriceBasis.verifiedAt`) is the instant PR 1 first verified a security's
whole stored history against FMP's (`historical-price-basis-v1.md`, §7). Provider entries dated on
or before it are history. Entries after it are forward events: PR 1 measures them when FMP re-bases
the prices, and until it has, the entry holds the sessions after its date (rule 8).

### The rules

For a ratio `r` on session `t`, with `R` the share-count revision (the latest point-in-time Income
quarter) observed at `R.observedAt`, and "an event" meaning a provider entry or a measured re-base:

0. **The price history is verified.** A security whose stored history PR 1 has not verified yet has
   no ratio on any session: without `verifiedAt` no provider entry can be placed as history or
   forward. A security whose verification the provider's answer keeps refusing (more than 1 % of the
   stored sessions missing, `historical-price-basis-v1.md` §8) therefore has none until it succeeds.
1. **The inputs** (previous section) are complete, positive and in the trading currency.
2. **The share count holds a level.** Walking the point-in-time Income quarters in order, a count
   within 25 % of the last accepted count is accepted. A count outside it is accepted as a new level
   only on the third consecutive quarter that agrees with it within 25 %; until then the quarter is
   withheld, with no fallback. Consecutive means consecutive fiscal quarters, each with a usable
   count: a missing quarter or count starts the agreement again. So a merger or an offering is withheld for two quarters and then
   available, while a one- or two-quarter artefact is never accepted: NKE's ×2.03 quarter, MSTR's
   Q3 1999 (153.4 M against 76 M), and Visa's counts that alternate in two-quarter blocks of ±40 %
   in fiscal 2010–2012. In the store, quarter-on-quarter changes beyond 25 % are 99 of 6,325, and
   the 99th percentile is 33 %.
3. **The share count was not restated unexplained.** If `R`'s count differs by more than 2 % from
   the previous revision of the same fiscal quarter, a measured re-base must explain it (its ratio
   within 2 %): one new to the previous revision — detected or dated after it was observed, and
   dated less than 30 days before it was observed (rule 5's month; an undated re-base at the latest
   date it may have) — and detected no later than `R.observedAt`. Otherwise `R` is unavailable. This
   keeps a restatement FMP publishes before an ex-date from being read against old-basis closes,
   whatever the split's size. An older re-base of the same ratio explains nothing, even when PR 1's
   first verification measures it only after the previous revision was observed.
4. **History, from provider entries** dated on or before `verifiedAt` and not superseded by a
   measured re-base within seven calendar days of them:
   1. **A non-plain entry at `E`:** `r` is unavailable until every statement family it reads has a
      point-in-time latest quarter whose fiscal period ends on or after `E`. That covers every
      session before `E`, where the close carries `Φ`, and the sessions after it whose statements
      still describe the company before the event.
   2. **Any entry at `E` with `R.observedAt < E`:** unavailable. A count observed before an event
      that was folded into the stored prices without being measured has unknown units. Nothing in
      the store today meets this; it guards data loaded before PR 1.
5. **A count observed soon after an event.** If an event lies at `E` with
   `E <= R.observedAt < E + 30 days` and `R`'s fiscal quarter ended before `E`, `R` is unavailable.
   The provider may restate its statements some time after it re-bases the prices, so such a count
   can still be in the old units while every rule above takes it as new (open measurement O-2). A
   quarter that ended after the event is reported in the new units by the company itself. **Its
   cost:** a security whose statements are all first observed in the 30 days after an event — first
   loaded then — has no ratio on any session whose latest quarter ended before the event, and on the
   historical ones for good, since a revision is never observed again unless its content changes.
   If O-2 shows FMP restates counts together with the price re-base, rule 5 can go; otherwise a
   confirming re-read after 30 days is the follow-up.
6. **The basis factor.** `K(t)` for `R`, from PR 1's measured re-bases
   (`historical-price-basis-v1.md`, §10). Where it is withheld, `r` is unavailable: on or after a
   re-base `R` predates, inside an undated interval, for an `R` observed between a re-base and its
   detection, before a non-plain re-base for an `R` observed after it, and where an unexplained
   change reaches.
7. **After a measured non-plain re-base at `E`**, on sessions on or after it: `r` is unavailable
   until every statement family it reads has a point-in-time latest quarter whose fiscal period
   ends on or after `E`, as in rule 4.1.
8. **A forward provider entry not yet measured.** For an entry dated after `verifiedAt`, with no
   measured re-base within seven calendar days of it, sessions from its date through the next 30
   calendar days are unavailable. That covers the ex-date the provider has not re-based yet, where
   a Monitor would otherwise read a post-split quote against pre-split counts, or a post-spin-off
   quote against the combined company's statements, even for events too small for PR 1's
   split-sized hold. Once PR 1 measures the re-base, rules 6 and 7 take over; an entry the provider
   never folds stops holding after 30 days.

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
  and at least 30 days after its date (rule 5), plus rule 7 for a possible distribution.
- **What is not masked:** a session whose statements lag a distribution after a covering statement
  exists (the trailing window still holds quarters from before it). That is the statement-content
  limit Fundamental Metrics already have (`fundamental-metrics-v1.md`; `historical-price-basis-v1.md`
  §13), not a price-basis question.
- **What rule 3 cannot tell apart:** a second restatement by the same ratio within one quarter. If
  the provider restated the counts for one re-base before the previous revision was observed — ahead
  of the ex-date, or together with the price re-base before PR 1 detected it — and restates them
  again by the same ratio ahead of another event while the same quarter is still the latest, that
  re-base explains the second restatement too. It takes two events of one ratio within about three
  months on one security: among the 64 securities in the store, only KO's two 2:1 entries of 1965
  are, 24 years before its first statement.

### The six known securities

| Security | Event (ex-date)                     | FMP entry               | Behaviour                                                                                                             |
| -------- | ----------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| WDC      | Sandisk (2025-02-24)                | 1323:1000 `stock-split` | masked; P/E, P/S, P/FCF from 2025-05-05, P/B and EV/EBITDA from 2025-08-15 (balance sheet with a period end after it) |
| IBM      | Kyndryl (2021-11-04)                | 523:500 `stock-split`   | masked through 2022-02-22; available from 2022-02-23 (the next filing covered Q3 2021, before the ex-date)            |
| MRK      | Organon (2021-06-03)                | 131:125 `stock-split`   | masked; available from 2021-08-10                                                                                     |
| AXP      | Ameriprise (2005-10-03)             | 10000:8753              | masked; available from 2006-03-07                                                                                     |
| HON      | 2018, 2025 spin-offs; 2026 combined | 1011:1000; 1907:2000    | masked through 2026-07-23 (the unlisted 2025 Solstice event lies inside the 2026 mask); available from 2026-07-24     |
| **MMM**  | **Solventum (2024-04-01)**          | **none**                | **not masked: 6,920 sessions before 2024-04-01 read 16.4 % low, the accepted V1 limitation**                          |

- MMM's adjustment is in FMP's adjusted close and in no usable FMP metadata. Checked on 2026-10-01:
  `stable/splits` lists only its 2:1 splits of 1972, 1987, 1994 and 2003. `stable/dividends` has
  `dividend ÷ adjDividend = 1` from 2003-11-19 on; its 1989–2003 dividends carry 2.3922, which is
  the 1994 and 2003 splits' 2 times a factor of 1.1961 — Solventum-sized, but on the wrong decades
  and not on the 2003–2024 dividends it should cover, so it marks nothing usable. Its `yield` field
  implies the adjusted close (77.63 on 2024-02-15, against 77.24 stored that day and about 92.4 as
  traded). The only FMP-sourced evidence that places it is the insider trade prices the
  investigation used (0 of 306 trades inside the stored range, 306 of 306 at ×1.1963).
- HON's 2025 Solstice spin-off is also missing from the split list, but every HON session before it
  is already inside the 2026 mask.
- The rule names no security: these rows are what it computes from FMP's lists and the stored
  statements.

### Measured coverage

Measured with the PR 2V implementation, as its reviews left it, on 2026-10-02: the development
store, 62 securities with statements, product horizon (1996-09-30 to 2026-09-25), FMP's split lists
as read on 2026-10-01 and no measured re-base. The loader had verified nothing in that store yet, so
the measurement gives every security `verifiedAt` 2026-10-02 — as the first verification after the
deploy will — which makes every listed event history; with no `verifiedAt` at all, rule 0 withholds
everything.

| Ratio     | Unavailable sessions | Share of 332,294 | Of which withheld by the split list (rule 4) |
| --------- | -------------------- | ---------------- | -------------------------------------------- |
| P/E       | 74,472               | 22.4 %           | 33,608                                       |
| P/S       | 42,976               | 12.9 %           | 36,026                                       |
| P/B       | 53,920               | 16.2 %           | 35,811                                       |
| P/FCF     | 81,249               | 24.5 %           | 34,493                                       |
| EV/EBITDA | 62,711               | 18.9 %           | 35,183                                       |

- **The split list withholds 10.1–10.8 %** of the sessions, in the eight securities named
  below. The figure before implementation (36,312 sessions for P/E) counted every session rule 4.1
  touches; the column above counts only those that would otherwise be available, since the inputs
  already withhold some of the same sessions.
- **The share-count rule (2)** withholds a further 3,308 sessions of P/E, 5,312 of P/S, 5,042 of P/B,
  2,644 of P/FCF and 4,264 of EV/EBITDA; **the restatement rule (3)** withholds none in the store.
  Rules 4.2, 5, 6, 7 and 8 withhold nothing: every statement was observed between 2026-08-31 and
  2026-09-28, more than 30 days after every listed event, and nothing has been measured yet.
- **The rest is the inputs**: a loss (no P/E), negative free cash flow (no P/FCF), negative EBITDA,
  a missing quarter or field, the four quarters before a security's first complete trailing year,
  and statements in another currency than the listing (TSM).
- Eight securities are affected by the split list: HON, IBM, MRK, WDC, DIS, GOOGL, GOOG and AXP.
  DIS (2000:1973 in 2007, whose price effect the investigation could not determine) and GOOG and
  GOOGL (the 2014 class C distribution, 1001:500 and 999:500) are masked because their entries are
  not plain. That is over-masking by design: their bias, if any, is at most a few tenths of a
  percent.
- The figure is reported, not optimised. No rule was added to raise it.

## Computation and storage

- **One pure calculation**, `packages/stock-data/src/valuation-ratios.ts`, computes a security's
  daily ratios from its stored closes, its point-in-time statement revisions, PR 1's measured
  re-bases and the stored provider entries. It reads no provider, writes nothing and has no clock.
  `buildValuationTimeline` applies the statement-level rules (1–5) once per statement event;
  `valuationRatioColumns` applies the session-level rules (6–8) and the arithmetic per session.
- **Every consumer calls it:** the backtest evaluation frame and the Monitor frame (with the live
  quote as the provisional close). A Stock Details series is not part of PR 2V; one added later
  calls the same calculation, so a chart and a Strategy show the same number.
- **The split list** is stored whole per security (`StockSplit`, replaced on every read). An entry
  whose ratio the provider did not state readably is kept with ratio `0 : 1` — a possible
  distribution, which over-masks rather than under-masks. An entry without a real calendar date
  cannot be placed, so the read fails like any malformed provider response rather than store a
  thinner list. The list is read from the provider in the preparation phases — a backtest's and a
  Monitor cycle's — when a Strategy names a valuation ratio and the stored list is more than a day
  old (`STOCK_SPLIT` dataset state). A day is enough: the provider lists an announced event before
  its date, and rule 8 withholds it from that listing.
- **A backtest computes a security's inputs once**, while preparing, from the generation it pins,
  and passes them to every window read; a window never reads the statements again. A Monitor
  reads them each cycle, between the two reads of the generation.
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
  backtest never buys on it; a Monitor never raises a Signal on it. As for every other metric, a
  Monitor's Signal that is already active is held through a `NOT_EVALUABLE` observation, not
  resolved by it (`ai/product/monitors.md`).
- **The Monitor** evaluates its provisional observation with the live quote as the close and the
  inputs of the newest closed session, the carry-forward rule Fundamental Metrics and intrinsic
  values follow: on the first session a statement becomes eligible, an intraday Monitor reads the
  previous inputs, and agrees with a backtest from the next observation. When the quote moves by a
  split-sized amount against the newest stored close, PR 1's ex-date hold makes the security not
  evaluable for that cycle; rule 8 covers smaller events the provider has listed.
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

| PR #75 element                                                                     | Under the FMP-only decision                                                                                                              |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Frozen valuation anchors, carried by research returns                              | removed: the per-session product with PR 1's measured `K` is exact forward and needs no frozen state                                     |
| `ValuationAnchor` table, supersession, pending-reason sets, late-revision rule 11  | removed with the anchors                                                                                                                 |
| The "as if reinvested" reading across a distribution                               | removed: the window is unavailable                                                                                                       |
| Historical anchors from `Φ` (PR 3V) and the external as-traded vendor (PR 3)       | removed: no second provider; unsafe history is unavailable                                                                               |
| Measured unit evidence for revisions observed before a later split (PR 2)          | removed for valuation: `K` restores the price side exactly; an unexplained restatement is unavailable (rule 3)                           |
| The anchor version pin and the per-attempt data-pin table                          | removed: a run re-simulates from its first day on retry, so an in-memory generation pin per attempt suffices                             |
| `observedSince` from a verified read                                               | kept as `verifiedAt`, which separates provider-listed history from measured events                                                       |
| Undated intervals for events between two reads                                     | kept: `K` cannot be applied inside one                                                                                                   |
| The settling delay and a generation bump on every one-row correction               | removed: they protected frozen anchor closes; nothing is frozen now                                                                      |
| The ex-date calendar hold                                                          | for valuation, rule 8 from the stored split list; for every operand, PR 1's stateless split-sized-move hold                              |
| Rules 6–7 (a count's units ordered against events; a hold near an announced event) | rule 5 (a count observed within 30 days after an event) and rule 8 (a listed event not yet measured)                                     |
| The periodic monthly full comparison                                               | removed: the earliest-row check catches every full-history re-base                                                                       |
| The invariant 9 amendment "if the owner accepts"                                   | made: the owner decided no per-session valuation persistence                                                                             |
| U1–U4                                                                              | decided by the owner's defaults: denominators `<= 0`, currency, the existing equity field, anomalies unavailable                         |
| U5 (bootstrap), U7 (Triggers), U9 (rebuild a corrected anchor)                     | U5: no synthetic start; U7: Conditions only; U9: no anchors                                                                              |
| U6 (statements around a distribution), U8 (unfolded distributions)                 | U6: the price-basis windows above; the remaining statement lag is shared with Fundamental Metrics. U8: an accepted V1 limitation (owner) |

## Accepted V1 limitation: basis events FMP does not report

**Owner decision, 2026-10-02: option (a), accept and disclose.** FactorSage V1 accepts that FMP
may omit a historical basis-changing corporate action, and that the valuation ratios before such an
event are then biased.

- **FMP remains V1's source of truth.** The rules read nothing but what FMP serves and what PR 1
  measures from it.
- **Every known or detected unsafe period is still unavailable.** Rules 0–8 apply unchanged: to an
  event FMP's split list reports, and to every re-base PR 1 measures in a history FactorSage has
  stored, including a distribution FMP leaves off its list but folds into its prices later.
- **What escapes them.** An event FMP had already folded into its adjusted close when FactorSage
  first stored the history, and that its split list does not report, leaves no trace in anything V1
  reads: PR 1 measures only re-bases of stored history, and the split list is the only other
  signal. The ratios before such an event are available, and biased by its factor.
- **The known case is MMM.** Solventum (2024-04-01) is in FMP's adjusted close and in no usable FMP
  metadata ("The six known securities"). MMM's valuation history before 2024-04-01, 6,920 sessions,
  reads about 16.4 % low. HON's 2025 Solstice event is the only other unlisted event known, and
  HON's 2026 entry already withholds every session before it.
- **Accepted, not correct.** It is a known inaccuracy, accepted to keep V1 simple. The ratios' help
  discloses it ("A distribution the data provider does not record cannot be seen, and before one a
  ratio can read low"); nothing may present those sessions as verified.
- **Not to be fixed in unrelated work.** Do not special-case MMM or any other security, add insider
  transaction prices or another provider, reconstruct `Φ`, add a confidence framework, withhold all
  history before `verifiedAt`, or add detection infrastructure for it.
- **A future enhancement, not a V1 blocker:** independent detection of basis-changing events the
  provider does not report. It needs its own owner decision, and the options below are where it
  starts.

The options the owner did not choose for V1:

- **(b) FMP's insider trade prices as a second historical signal.** The investigation's
  range-containment test flags MMM, HON and AXP, and also flags feed defects (class B trades filed
  under BRK-A, class mixing in GOOG and GOOGL, non-market rows in GS, MRK and AAL), which would mask
  those histories too. It needs insider ingestion for every valued security and tuned thresholds,
  and still sees nothing for a security without open-market insider trades.
- **(c) No historical valuation before `verifiedAt`.** Safe and simple, and it removes every
  historical value, including the 89 % the rule shows to be safe.
- **A dated list of the known unlisted events** (MMM 2024-04-01, HON 2025-10-30): excluded by the
  owner's instruction against curated per-security exceptions.

## Later owner choices

V1 ships the owner's defaults for both, and neither blocks it.

1. **Preferred stock in P/B.** `totalStockholdersEquity` is used (above). Deducting `preferredStock`
   would raise P/B by 46.8 % for MSTR, 11.9 % for GS and 6.0 % for JPM. One line of the calculation;
   no other part depends on it.
2. **Triggers.** Conditions only in V1. Margin of Safety supports `crosses above` and
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
| Carrying the whole EV/EBITDA ratio by price                                           | scales net debt with the price: up to 13.3 % wrong on IBM, 72.5 % between FMP's quarterly rows (investigation, §8.4 and §9.4)             |
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

## Review

A clean-room reviewer checked this design on 2026-10-01, the night it was written: the committed
documents, the code and the development database, with four FMP requests.

- **What it accepted.** The basis factor's identity under its stated assumptions, every measured
  figure (MMM's 6,920 sessions, the 99 of 6,325 share-count changes, the preferred-stock shares, the
  masked sessions per security and their availability dates), the FMP checks, and that the owner's
  requirements are met except where the table says.
- **What it found**, all accepted:

| Finding                                                                                                                                                                                                                                                                                                       | Severity | Correction                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| R2. A count first loaded after the provider re-based its prices but before it restated its statements is in old units while every rule takes it as new; rule 3's 25 % missed 5:4 and 6:5 splits and stock dividends; a filing first observed after a measured distribution read sessions before it at `K = 1` | Major    | rule 5 (30 days after an event); rule 3 at 2 %; the basis factor withholds sessions before a non-plain re-base for such counts |
| R3. The share-count rule caught the first quarter of Visa's two-quarter blocks and missed MSTR Q3 1999: 262 known-wrong sessions                                                                                                                                                                              | Major    | rule 2 accepts a new level only on its third agreeing quarter                                                                  |
| R4. On an ex-date the provider has not re-based, a Monitor would read a post-event quote against pre-event counts for events smaller than the hold                                                                                                                                                            | Major    | rule 8, from the stored split list, which lists announced events                                                               |
| R5. An unexplained change withheld whole histories                                                                                                                                                                                                                                                            | Major    | bounded in `historical-price-basis-v1.md` §8 and §10                                                                           |
| R6. Recommending option (a) for MMM contradicts the owner's rule                                                                                                                                                                                                                                              | Major    | the decision is the owner's, with (a) labelled an exception, and the curated-list option named and excluded                    |
| Minor: the plain predicate trusts the provider in the unsafe direction; the listing-unit caveat was dropped; the Monitor's input date departed from the carry-forward rule; "does not match" in a Monitor is `NOT_EVALUABLE`; nits on MMM's split list, a stored close and the EV/EBITDA rationale            | Minor    | stated (predicate, listing units); carry-forward adopted; `NOT_EVALUABLE` semantics stated; facts corrected                    |

R1 concerns PR 1's hydration path and is recorded in `historical-price-basis-v1.md`.

**Clean-room code review of PR 2V (2026-10-02).** It read the implementation against these rules,
probed every rule with fixtures that isolate it, and ran 19 mutants of the calculation against its
tests. It confirmed the inputs, the point-in-time selection, the date boundaries, the Monitor's
carry-forward, the generation-consistent preparation, the contracts and the OpenAPI document. Its
findings, all applied:

| Finding                                                                                                                                 | Severity | Correction                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| Rule 3 let an older measured re-base of the same ratio explain a new restatement, reading a pre-ex-date restatement at twice its P/E    | Major    | the re-base must be new to the previous revision and known by `R`'s observation (rule 3)                       |
| The tests did not prove the masking rules: nine mutants, among them removing rule 4.1 or rule 7, passed                                 | Major    | a test per rule with statements observed long after every event; all 22 mutants now fail the tests             |
| Rule 2 kept an agreement across a missing quarter or count                                                                              | Minor    | consecutive means consecutive quarters with usable counts (rule 2)                                             |
| Rule 5 withholds the whole history of a security first loaded in the month after an event                                               | Minor    | stated as rule 5's cost, tied to O-2                                                                           |
| The split list's write used the default transaction limits under the per-security write lock                                            | Minor    | the bulk writers' limits                                                                                       |
| The mapper dropped a dated entry with an unreadable ratio, and checked dates by pattern only                                            | Minor    | kept as a possible distribution; dates checked as real days                                                    |
| The QA matrix did not copy the split list beside its fresh dataset state; its preflight and provenance audit ignored valuation operands | Minor    | the matrix copies `StockSplit`; the preflight counts ratios as statement readers; the audit skips them by name |
| Rule 0, nothing for an unverified history, was undocumented, and so was the measurement's `verifiedAt`                                  | Minor    | stated (rule 0, "Measured coverage")                                                                           |
| A coverage percentage; annual revisions read on every Monitor cycle                                                                     | Nit      | corrected; standalone quarters only. A Monitor reconstruction still builds the inputs twice, accepted          |

**Re-review of the fixes (2026-10-02).** The same reviewer rebuilt the 22 mutants against the fixed
code and tests (all fail them), confirmed that its earlier counter-examples now withhold, and added
11 mutants, 10 of which the tests did not catch. Its findings, all applied:

| Finding                                                                                                                                                                                                                                        | Severity | Correction                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rule 3 still let an old re-base explain a new restatement when PR 1's first verification measures it after the previous revision was observed: P/B at twice its value from the restatement to the ex-date                                      | Minor    | the re-base must also be dated less than 30 days before the previous revision was observed (rule 3); the same-ratio case left is stated under "What rule 3 cannot tell apart" |
| Ten mutants passed the tests: rule 3 at 25 %, with any ratio, or without "dated after"; rule 7 at an undated re-base's earliest date; P/B without its count's currency; rule 2's level not following each accepted count; four date boundaries | Minor    | a test for each; all 38 mutants, the 33 above and five of the new rule 3 condition, now fail the tests                                                                        |
| The mapper skipped an entry whose date is in another format, so nothing masked it                                                                                                                                                              | Nit      | a row without a calendar date fails the read                                                                                                                                  |
| The domain type's comment did not mention the `0 : 1` ratio of an unreadable entry                                                                                                                                                             | Nit      | stated                                                                                                                                                                        |

Re-measuring the coverage for this record showed that its table predated the first review's rule 2
fix. It now reports the reviewed code: rule 2 withholds 62 more sessions of P/E, P/S, P/B and
EV/EBITDA; the split list's figures and rule 3's are unchanged.

## References

- `docs/decisions/historical-price-basis-v1.md`: terminology, PR 1 (re-base-safe loading, measured
  re-bases, generations, the hold), and Margin of Safety's separate problem.
- `docs/historical-price-basis/INVESTIGATION.md` and `evidence/`, and
  `docs/valuation-ratios-gate/INVESTIGATION.md`: the evidence.
- `docs/decisions/fundamental-metrics-v1.md`, `fundamental-metrics-storage-and-evaluation.md`,
  `intrinsic-value-engine.md`, `fundamentals-loader.md`,
  `retain-wide-column-calculated-series-storage.md`.
- `ai/product/strategies.md` (the metric family) and `ai/architecture/deep-discovery.md` §15.

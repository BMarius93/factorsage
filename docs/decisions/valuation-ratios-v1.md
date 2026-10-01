# Valuation Ratios V1

## Status

**Proposed. Not implemented.** This revision makes **frozen valuation anchors carried by
research-price returns** the canonical architecture for valuation ratios. The product owner chose
it on 2026-10-01, together with the carried reading across distributions. It replaces this
decision's 2026-09-30 conclusion that valuation ratios need a corporate-action basis on every
session.

- **Forward valuation (PR 2V)** needs re-base-safe loading (`historical-price-basis-v1.md`, PR 1,
  with the additions in "Implementation plan"), the product decisions U1–U4 and U8 below, and the
  owner's acceptance of the invariant 9 amendment. It needs no external data and no `Φ`. Event
  classification and statement unit conversion are needed only to release the rare anchor that a
  nearby ledger event leaves pending.
- **Historical valuation (PR 3V)** needs `Φ` at anchor sessions only. It stays blocked on the
  external as-traded reference that `historical-price-basis-v1.md` §6 describes, and on U6 for
  statements the provider recast after the fact.
- **Margin of Safety is unchanged.** It keeps the per-session design of
  `historical-price-basis-v1.md`, and this simplification does not apply to it.
- **The 2026-09-30 gate result stands** ("The 2026-09-30 gate", below). The candidate
  `close × latest diluted shares` on every session is biased and is not built.
- **FMP's ratio, key-metric and enterprise-value endpoints are not product truth and are not
  anchors.** They are computed from the same biased inputs, rewritten after the fact and dated
  before their statements were public (investigation, §8).
- **"Locked"** marks what the owner decided or an accepted decision already fixes. **"Proposed"**
  marks this design's own rules. A clean-room review checked them on 2026-10-01 ("Review"), but
  nobody has accepted them yet.

The evidence is `docs/historical-price-basis/INVESTIGATION.md` §8 (FMP's ratio endpoints) and §9
(frozen anchors), with `docs/valuation-ratios-gate/INVESTIGATION.md` for the 2026-09-30 gate.

## The model

```text
point-in-time statement revisions
        │  a revision becomes eligible and changes an anchor input's value
        ▼
PIT availability event: the first settled session on or after its availableFromDate
        ▼
valuation anchor: market capitalisation and denominators, frozen
        ▼
daily carry: market capitalisation × research-price return, within one price generation
        ▼
the next input-changing revision
        ▼
a new valuation anchor
```

- **A forward anchor** is created and frozen when its revision is available and its session has
  settled: `MC_a = asTradedClose(a) × dilutedShares(a)`.
- **A historical anchor** is reconstructed with `Φ`, then frozen:
  `MC_a = researchClose(a) × Φ(a) × dilutedShares(a)`. After that, no session uses `Φ`.
- **Daily values are computed, never stored.** Only anchors are persisted.

The terms (`researchClose`, `asTradedClose`, `Φ`, generation, ledger, `observedSince`) are those of
`historical-price-basis-v1.md`, "Terminology".

## Carried semantics (locked by the owner)

1. **Between anchors, fundamentals are frozen point-in-time inputs.** A session that brings no new
   statement revision changes nothing about the company's fundamentals.
2. **The market capitalisation moves with research-price returns:**
   `MC_t = MC_a × P^g(t) ÷ P^g(a)`, with both closes from one price generation `g`.
3. **A split or a reverse split does not change the carried ratio.** The research series folds the
   split in, so across it the carried market capitalisation equals the actual one. Nothing is
   classified and no share count is converted (investigation, §9.1–9.2).
4. **A distribution does not create an anchor.** A spin-off or a special distribution is not a
   fundamental event.
   - **Where the provider folds the distribution into the research series**, as in every confirmed
     case, the carried market capitalisation keeps the value the company had before it, as if the
     distribution had been reinvested in the company. Until new point-in-time fundamentals
     arrive, the ratio keeps describing the last fundamental reality an investor could know: the
     combined company. It is not the market value of parent plus spun-off company, which drift
     apart as their prices move (Aerospace was about 48 % of HON).
   - **Where the provider does not fold it in, the owner's reading is not delivered (U8).** The
     research return falls with the price, and so does the carried market capitalisation, while
     every denominator, net debt included, still describes the company before the distribution.
     The ratio then reads low by the distribution factor: the mismatch the next section rejects.
     Forward valuation cannot detect this without classifying the event against an as-traded
     reference, which is what this architecture avoids. DIS 2007 is the one stored provider entry
     whose folding is undetermined.
   - The denominator is never reinterpreted as the standalone company before its statements exist.
5. **The next relevant revision creates the new anchor**: one that changes an input's value
   ("Anchor creation", rule 1), whether a new quarter or a restatement. An anchor is never dated
   before its revision's `availableFromDate`.

### Why the carried reading

The alternative values the company from the ex-date at its post-distribution market
capitalisation, against the only statements available, which still describe the combined company.

- **Its numerator and denominator describe different companies.** The post-distribution market
  capitalisation excludes the distributed business; the statements still include its earnings,
  sales, cash flow, book value and debt. The ratio reads low by the distribution factor until the
  statements catch up: MMM's P/E 16 % low after Solventum, IBM's 4 % after Kyndryl, HON's 48 %
  after Aerospace.
- **The carried reading pairs like with like.** The research series keeps the distributed value
  in, as if reinvested. The market capitalisation and the statements then both describe the
  combined company until the next statement.
- **It uses no information the investor lacked.** Describing the standalone company before its
  statements exist would need figures not yet published.
- **It moves with the chart and the backtest.** Between anchors the ratio is a function of the
  same research closes the chart draws and the engine trades on, so a Strategy that compares a
  valuation ratio with a price-derived series uses one basis.
- **It needs nothing at the event:** no classification, no `Φ`, no rebuild, no mask.

**How much it touches.** The six securities with confirmed distributions have nine distribution
steps in the stored history. Each is carried for 2 to 74 sessions, 325 sessions in all. The
per-session bias of the 2026-09-30 candidate touched 35,234 (investigation, §9.3;
`docs/historical-price-basis/evidence/anchor-carry-windows.csv`).

**What it does not fix.** The carried window ends at the next input-changing revision, whatever
period that statement covers.

- **Flows.** In four of the nine steps (IBM 2021, MMM 2024, AXP 2005 and HON's first 2018 step),
  the next statement covers a quarter that ended before the ex-date. The anchor it creates pairs
  the post-distribution market capitalisation with combined-company flows for 60 to 78 sessions,
  until a statement whose quarter includes the ex-date.
- **Balance sheets can lag further.** WDC's next anchor after Sandisk has no post-spin balance
  sheet: the provider's Q3 FY2025 balance sheet has a moved period end, was filed 2025-08-14 and is
  eligible from 2025-08-15. P/B and EV/EBITDA therefore pair the post-Sandisk market capitalisation with the
  pre-spin balance sheet for 71 sessions, which makes five of the nine steps for those two ratios.
- Every design has these windows, from the ex-date on; the carried reading shortens them by the
  carried sessions. What to do about them is U6.

## Anchor creation (proposed)

Rules 1, 3 and 8 follow from the owner's instructions and `fundamental-metrics-v1.md`. The others
are this design's.

1. **Trigger: an input value changes.** An anchor is created when the point-in-time input set
   changes in value: a TTM input's four fiscal identities or values, a latest-state input's
   identity or value, the share count, or a contributing statement's currency.
   - The comparison is by value, never by revision. A revision that changes only fields no ratio
     uses, or only its filing date, creates no anchor. In the development store, 10 of the 23
     consecutive quarterly revision pairs are of that kind (ADBE, BRK-A, GOOG, GOOGL and JNJ).
   - `inputFingerprint` hashes those canonical values ("Anchor persistence").
2. **A unit-only restatement creates no anchor.**
   - A revision that differs from the previous revision of the same fiscal identity only by one
     common share-unit ratio changes units, not information: every share count × `r`, every
     per-share figure ÷ `r`, everything else equal within the provider's rounding.
   - The governing anchor's close and share count are already in one unit, so it stays.
   - This holds whether the provider restates after an ex-date or before it. Rule 6 keeps the
     restated count out of a later anchor until a ledger event of the same ratio, on or before
     that anchor's session, explains it.
3. **Anchor session.** The first settled session on or after the revision's `availableFromDate`, as
   Fundamental Metrics map a statement event onto the trading axis.
   - The anchor is built from that session's settled close: stored at least the settling delay
     after the session closed (`historical-price-basis-v1.md` §7, O-3). Never from an intraday
     price.
   - **Who writes it.** The derived-work path writes the anchor once both its revision and that
     settled close are stored: the statement write or the price write, whichever comes second,
     under the per-security write lock. A superseding row is written in the transaction of the
     write that causes it (rules 9 to 11). The projection never writes.
   - Until the anchor is written, a Monitor's provisional observation carries the previous anchor
     to the live quote. That is the existing rule for intrinsic values and Fundamental Metrics
     (`monitor-frame.ts`, rule 2), which carry the previous session's values until the canonical
     materializer applies a new statement. The Monitor agrees with a backtest from the first
     observation after the anchor is written, once its session's close has settled.
4. **Domain.** An anchor whose session is on or after the security's `observedSince` is `LIVE`. An
   anchor before it is `BACKFILL`, and only PR 3V creates one.
5. **Price.** Every anchor reads the ledger in the same snapshot as `P^g(a)`, and records `g` and
   the ledger version.
   - The as-traded close is `P^g(a) × F^g(a)`. `F^g(a)` is the product of the measured price
     ratios of the ledger events whose effective date is after `a`, and 1 when there is none.
   - **An undated event counts by its interval** (`historical-price-basis-v1.md` §8): as after a
     session when its whole interval is after it, as on or before it when its whole interval is on
     or before it. An interval that contains the session leaves the order unknown. This applies
     wherever these rules place an event relative to a date.
   - What matters is which events generation `g` has folded in after `a`, not when the revision
     was observed. An anchor written at PR 2V's first deploy, by the price write or by a
     methodology rewrite can have `F ≠ 1`.
   - The anchor is pending when an event after `a` has no single measured ratio (`UNEXPLAINED`),
     or when `a` falls inside an event's undated interval. Such an event's ex-date fell between
     two reads of a security nobody refreshed in between, so it is unknown whether it precedes
     `a`.
6. **Share units.** The diluted share count must be in the units of session `a`. It comes from the
   latest Income quarter's revision, which need not be the revision that triggered the anchor. It
   is used as stored only when all three hold:
   - that revision's filing date is on or after `observedSince`, so the ledger covers everything
     after it;
   - the ledger has no event of any kind, dated or counted by its interval as in rule 5, after
     that filing date and on or before the later of `a` and the revision's first observation
     (without classification a distribution cannot be told from a split). An interval that
     contains either end of that range counts as an event in it;
   - if the revision differs from its predecessor by a unit ratio `r ≠ 1` (rule 2), a ledger event
     of ratio `r` has an effective date on or before `a`. That one event is then exempt from the
     second condition, because it is what put the count in session `a`'s units.

   Then no share-changing event can lie between three things: the units the count was filed in,
   the units the provider served when FactorSage observed it, and session `a`. Otherwise the
   count's units come from classification and measured revision pairs
   (`historical-price-basis-v1.md` §3, PR 2), and until that evidence exists the anchor is pending.

7. **A restatement before an ex-date.** O-2 measures whether the provider restates statements
   before an ex-date. If it does, a revision first observed while the provider's calendar lists an
   upcoming share-changing event for the security is pending until that event's units are
   measured. The calendar only holds; it never supplies a value. Until O-2 is observed, the hold is
   on. Its cost: a security that files between a split's announcement and its ex-date has no
   value until PR 2 measures the units or the next anchor governs.
8. **Pending anchors.** A pending anchor makes every ratio `NOT_EVALUABLE` from its session until a
   later row resolves it or a later anchor governs.
   - The previous anchor is never carried past it: an obsolete value must not carry forward past
     an invalidating event (`fundamental-metrics-v1.md`, rule 7).
   - The causes are those of rules 5 to 7 and 9 to 11: an unexplained or undated event, a ledger
     event near the share count's revision, an unexplained restatement, the calendar hold, a
     corrected anchor close, a replaced history, or a late revision before `observedSince` that
     cannot be anchored. A pending anchor withholds values; it never shows a wrong one.
   - **Pending reasons are a set, and they are inherited.** A superseding row keeps every pending
     reason of the row it replaces, unless it removes that reason's cause. A release for one
     reason, for example by PR 2's unit evidence, never clears another.
9. **A corrected anchor-session close.** Only a correction of the close itself counts, beyond the
   price tolerance (`historical-price-basis-v1.md` §7 and §9); a corrected volume or VWAP does not.
   The transaction that stores the corrected close and bumps the generation also appends a pending
   row for that anchor.
   Rebuilding the anchor from the corrected close would recompute an anchor from FMP's data, which
   the owner excluded; whether to allow it is U9.
10. **A replaced history.** Some anchors' session closes change in a full replacement
    (`historical-price-basis-v1.md` §8–9) by something other than the factor of the events recorded
    with it, or their session row disappears. The replacement's transaction appends a pending row
    for each such anchor, because its frozen market capitalisation no longer matches the divisor.
    An anchor whose close changed by exactly those factors is unaffected, by the identity of
    investigation §9.1.
11. **A revision dated before existing anchors.** The loader dates a first observation from its
    filing (`fundamentals-loader.md`), so a revision can become eligible at a session before
    anchors that were built without it.
    - If it changes an input (rule 1), its own anchor is inserted at its session.
    - Every later anchor whose point-in-time inputs it changes is superseded by a row with the
      same session, close and `F` and the new inputs (reason: late revision), subject to rule 6.
      The new row inherits the pending reasons of the row it replaces (rule 8), so a copied close
      never restores a divisor that rule 9 or 10 had withdrawn. Fundamental Metrics rebuild from
      the revision's date in the same way.
    - A revision whose session falls before `observedSince` and that arrives after the backfill
      is anchored by PR 3V's job where `Φ` is measured. Otherwise the governing `BACKFILL` anchor
      becomes pending.

## Formulas (locked)

```text
MC_a          = close × dilutedShares                frozen at the anchor
MC_t          = MC_a × P^g(t) ÷ P^g(a)               P^g(a) and P^g(t) from one generation g

P/E_t         = MC_t ÷ NetIncome_TTM
P/S_t         = MC_t ÷ Revenue_TTM
P/B_t         = MC_t ÷ Equity
P/FCF_t       = MC_t ÷ FCF_TTM

EV_t          = MC_t + NetDebt
EV/EBITDA_t   = EV_t ÷ EBITDA_TTM
```

- **EV/EBITDA carries components.** Net debt is frozen in dollars and only the market
  capitalisation moves. Carrying the whole ratio by price would scale net debt with the share
  price: on IBM that errs by 0.5 % at the median and by up to 13.3 %, and between FMP's quarterly
  anchors by up to 72.5 % (investigation, §9.4 and §8).
- **`P^g(a)` is read from the same generation as `P^g(t)`.** The research close stored on the
  anchor row at creation is an audit value. It is never a divisor for another generation's price.
- **The value on the anchor session is the anchor itself:** the carry factor is 1.
- **Units.** Values are raw multiples, like Fundamental Metrics' multiples.

### Inputs, inherited from accepted decisions

| Input           | Definition                                                                                                                                                     | Source                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `dilutedShares` | the latest PIT-eligible quarterly `weightedAverageShsOutDil` (Income Statement, latest state), required `> 0`; no fallback to basic shares or an older quarter | `intrinsic-value-engine.md` (DCF equity bridge, Residual Income); settled by this decision's 2026-09-30 evidence      |
| `NetIncome_TTM` | the sum of `netIncome` over exactly four consecutive Income quarters, `Q[-3]..Q[0]`                                                                            | `fundamental-metrics-v1.md` shared rules 3–5 and 11; ROE                                                              |
| `Revenue_TTM`   | the sum of `revenue` over four consecutive Income quarters                                                                                                     | as above; the margins                                                                                                 |
| `FCF_TTM`       | the sum of `operatingCashFlow + capitalExpenditure` over four consecutive Cash Flow quarters; both required in every quarter; provider `freeCashFlow` not used | `fundamental-metrics-v1.md`, "Free cash flow convention"                                                              |
| `EBITDA_TTM`    | the sum of `ebitda` over four consecutive Income quarters                                                                                                      | `fundamental-metrics-v1.md` §13                                                                                       |
| `NetDebt`       | provider `netDebt` from the latest PIT-eligible quarterly Balance Sheet, independent of any flow window; never reconstructed from other fields                 | `fundamental-metrics-v1.md` §13                                                                                       |
| `Equity`        | the latest PIT-eligible quarterly Balance Sheet's equity                                                                                                       | the field is U3; `totalStockholdersEquity` is the precedent (`fundamental-metrics-v1.md` §9 and §11, Residual Income) |

The shared point-in-time rules of `fundamental-metrics-v1.md` apply unchanged. In particular:

- only revisions with `availableFromDate <= a` are used, and each fiscal identity is represented by
  its latest eligible revision (rules 1, 2 and 13);
- a window is exactly four distinct consecutive standalone quarters; an `FY` row never fills it,
  and a missing quarter makes the ratio unavailable (rules 3 and 4);
- each flow window ends at its own family's latest PIT-eligible quarter, and latest-state inputs
  are taken independently of the windows ("Window anchors"); there is no fallback to an older
  window (rule 11);
- missing is never zero (rule 6);
- every statement that contributes to one ratio reports the same non-empty `reportedCurrency`, or
  that ratio is unavailable; there is no FX conversion (rule 12);
- a revision keeps the loader's `availableFromDate`: its filing date plus a day for a first
  observation, never before its observation for a restatement. The valuation path never
  reconstructs it (rule 10; `fundamentals-loader.md`, "Revisions and restatements").

**Unavailability is per ratio and recorded on the anchor:** a missing input, an incomplete window,
mixed currencies, a non-positive share count, or the rules U1 and U2 decide. In an evaluation frame
the value is `NaN` and a Condition is `NOT_EVALUABLE`; in an API response it is absent. It is never
zero, infinity, a sentinel or a stale previous value (`fundamental-metrics-v1.md`, "Unavailability
and numeric safety").

**FMP's ratio methodology is not adopted.** FMP annualises one quarter, uses basic shares and
prices at the session nearest the period end (investigation, §8).

## Unresolved product decisions

U1 to U4 and U8 block PR 2V. U6 blocks PR 3V. U5, U7 and U9 have a safe default, used until the
owner decides, and block nothing.

| #   | Decision                                                                                                   | Evidence and precedent                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Zero and negative denominators (net income, revenue, FCF, equity, EBITDA), and a negative enterprise value | No accepted document decides it for valuation. Every Fundamental Metrics denominator must be positive or the metric is unavailable: ROE, Debt / Equity ("rather than producing a misleading signed leverage ratio"), Net Debt / EBITDA (`EBITDA_TTM > 0`). Numerators may be negative: net debt, EBIT.                                                                                                                                                                           | Unavailable when the denominator is `<= 0`, so `P/E is below 15` never admits a loss-maker. A negative enterprise value over positive EBITDA is a valid negative multiple, as negative net debt is.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| U2  | Statement currency against trading currency                                                                | Rule 12 compares statements with each other, never with the price. All 62 stored securities report in their trading currency, but the catalog holds 2,091 non-US issuers, all quoted in USD. TSM reports in TWD. FMP serves each listing's share count in that listing's units: depositary units for HSBC and TSM, class A for BRK-A, class B for BRK-B (investigation, §9.5).                                                                                                   | Unavailable when `reportedCurrency` differs from `Security.currency`; no FX in V1. Listing units are measured on four securities only, so PR 2V checks them on its test set.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| U3  | The equity field for P/B                                                                                   | `totalStockholdersEquity` is used by ROE, Debt / Equity and Residual Income's book value. The market capitalisation is common equity, so preferred stock is a candidate deduction.                                                                                                                                                                                                                                                                                               | `totalStockholdersEquity`, for consistency with every existing equity input.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| U4  | One-quarter share-count anomalies (B3)                                                                     | 593 sessions in nine episodes, each reversing at the next statement (NKE ×2.03, MSTR, JPM, JNJ, AMZN, UBER); JPM's coincides with a merger. Margin of Safety accepts them as provider data. A frozen anchor carries one for a whole quarter.                                                                                                                                                                                                                                     | The owner's choice: (a) accept them, as Margin of Safety does; or (b) hold an anchor whose share count moves beyond a calibrated threshold from the previous anchor's with no ledger event to explain it. (b) also catches a unit error at creation, and withholds genuine moves. A held anchor is never released by a later statement, which would use later information.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| U5  | A bootstrap anchor for a newly observed security                                                           | Without one, a security has no forward value until its first input-changing revision after `observedSince`, up to a quarter. A bootstrap at `observedSince` from the latest input set is point-in-time, but its share units depend on the provider's restatement lag (O-2).                                                                                                                                                                                                      | Default: none. Revisit after O-2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| U6  | Statements around a distribution                                                                           | Forward: four of the nine steps above, five for balance-sheet ratios. Historically, the backfilled statements are the provider's current versions, dated from their original filings: MMM's revenue drops from 8,031 (Q1 2023) to 6,283 (Q2 2023), recast to continuing operations after Solventum and eligible from 2023-07-26. HON's Q2 2026 net income, 2.4 times any other HON quarter since 2016, enters four TTM windows. Fundamental Metrics use the revisions as stored. | Forward (PR 2V): inherit Fundamental Metrics' treatment; a stricter rule belongs to the shared methodology. Historical (PR 3V, blocking), three options: (a) the loader's backfill limit, disclosed, as Fundamental Metrics' history already has it; (b) a `BACKFILL` anchor unavailable when a window quarter ended before a later distribution and was first observed after it. Every backfilled statement was first observed in September 2026, after every stored distribution, so (b) withholds every `BACKFILL` session before each security's last distribution: in the store, the 35,234 sessions PR 3V exists to price, MMM's as-filed Q1 2023 included; (c) (b) narrowed to quarters shown to be recast, which needs a recast test not yet designed. Recommended: (a) now, (c) if a reliable recast test is found. |
| U7  | Conditions only, or Conditions and Triggers                                                                | Fundamental Metrics are Conditions only, because they are step series. Margin of Safety also moves with the price every session and supports `crosses above` and `crosses below`.                                                                                                                                                                                                                                                                                                | Default: Conditions only. Recommended: Conditions and Triggers, as Margin of Safety, with existing operators only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| U8  | Distributions the provider does not fold in                                                                | The carried reading needs the provider to fold the distribution in (rule 4). Where it does not, the ratio reads low by the distribution factor until the next statement, and forward valuation cannot tell. Every confirmed stored case is folded; DIS 2007 is undetermined.                                                                                                                                                                                                     | Accept it as a disclosed limit of research-return carry: the chart footnote and the metric description say so. Detecting it would need classification against an as-traded reference for every forward event, which this architecture exists to avoid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| U9  | Rebuilding an anchor from a corrected close                                                                | Rule 9 makes the anchor pending, which withholds up to a quarter of values, because rebuilding it would recompute an anchor from FMP's data.                                                                                                                                                                                                                                                                                                                                     | Default: pending. Allowing the rebuild is an explicit exception to "never recompute anchors from FMP" that only the owner can grant.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Anchor persistence (proposed)

`ValuationAnchor` holds one row per security and anchor observation, never one per metric or per
session. It is append-only: a row is never updated, and a correction is a new row that supersedes
it.

| Field                                                                    | Meaning                                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `securityId`                                                             | the security                                                                                                                                              |
| `sequence`                                                               | strictly increasing per security at insert; the security's anchor version is its highest `sequence`                                                       |
| `anchorSession`                                                          | the first settled session on or after `availableFromDate`                                                                                                 |
| `availableFromDate`                                                      | that of the revision that created the anchor                                                                                                              |
| `origin`                                                                 | `LIVE` or `BACKFILL`                                                                                                                                      |
| `state`                                                                  | `ACTIVE`, or `PENDING` with its set of reasons (rule 8)                                                                                                   |
| `methodologyRevision`                                                    | the valuation methodology revision its components were computed under                                                                                     |
| `close`, `closeBasis`                                                    | the close the market capitalisation is built from: `AS_TRADED` for `LIVE`; `SPLIT_ADJUSTED` (research × `Φ`, in `priceGeneration`'s units) for `BACKFILL` |
| `dilutedShares`                                                          | in the same units as `close`                                                                                                                              |
| `marketCap`                                                              | `close × dilutedShares`: the frozen quantity the carry uses                                                                                               |
| `netIncomeTtm`, `revenueTtm`, `fcfTtm`, `ebitdaTtm`, `equity`, `netDebt` | null when that input is unavailable                                                                                                                       |
| `currency`                                                               | the inputs' `reportedCurrency`; null when they disagree or one is missing                                                                                 |
| `ratioStates`                                                            | for each ratio: available, or the reason it is not                                                                                                        |
| `inputFingerprint`                                                       | a hash of the canonical input values of rule 1, which decides whether a revision creates an anchor                                                        |
| `inputs`                                                                 | provenance only: the statement type, fiscal identity and `contentHash` of every revision that supplied an input                                           |
| `priceGeneration`, `researchCloseAtCreation`                             | audit only                                                                                                                                                |
| `ledgerVersion`                                                          | the ledger version read: for `F`, and for `Φ` on a `BACKFILL` row                                                                                         |
| `supersedes`, `supersedeReason`                                          | the row replaced, and why: unit evidence, a late revision, a corrected close, a replaced history or a re-backfill                                         |
| `createdAt`                                                              | when the row was written                                                                                                                                  |

- **Numeric types.** Market capitalisations and some TTM sums exceed the `|value| < 10^12` range
  of `DECIMAL(20,8)`, the calculated-series type: Alphabet's is about 4.2 × 10^12. Monetary
  fields therefore need a wider type, for example `DECIMAL(28,4)`, and the share count likewise.
  The close keeps `DailyPrice`'s `DECIMAL(20,8)`.
- **Which row governs session `t`** under anchor version `v`: among the rows of the current
  methodology revision with `sequence <= v` that no row with `sequence <= v` supersedes, the one
  with the latest `anchorSession <= t`, and of those the highest `sequence`. A pending row makes
  its ratios unavailable.
- **A methodology change** writes a new set of rows under the new revision.
  - Existing anchor sessions keep their frozen closes. A new anchor session is priced with the
    ledger's `F` if it is `LIVE`, and by a re-backfill if it is `BACKFILL`. No provider is read.
  - The new revision is served only once its rows are written: a stop-then-start deploy, or a run
    that finds a security with rows under an older revision and none under its own fails
    retryably. A security with no anchors at all, such as one newly observed, simply has no
    values.
  - Rows of other revisions are kept for audit and ignored.
- **Storage.** About four rows per security-year, so about 120 rows per 30-year security.
  - The `inputs` provenance list makes a row about 1 KB, so a 30-year security takes about 150 KB.
  - The projection needs about 150 B of each row, so about 20 KB per resident security in Redis.
  - Five per-session columns would add about 0.6 MB of Redis per security (four measured at
    0.47 MB, `retain-wide-column-calculated-series-storage.md`).

## Daily values are projected, never stored (locked by the owner, pending the invariant 9 amendment)

- **One projection function** in `@intrinsic/stock-data` computes each session's values from the
  governing anchor and the research closes of one generation. The evaluation frame, the Monitor
  frame and the Stock Details API all call it, so the chart and a Strategy show the same number.
  It reads no statement and writes nothing.
- **This departs from accepted decisions, by the owner's choice of 2026-10-01.**
  - AGENTS.md invariant 9 and `retain-wide-column-calculated-series-storage.md` store every
    calculated daily series as an explicit PostgreSQL column, and make the canonical rebuild the
    only calculation path. That decision measured room for four valuation columns.
  - Valuation ratios persist their anchors only. Margin of Safety is the precedent: it is computed
    once, during projection, from a stored intrinsic value and the close
    (`packages/stock-data/src/evaluation-frame.ts`).
  - PR 2V amends invariant 9 and the storage decision in the same change, with a scoped exception
    for carried valuation series. The rest of invariant 9 stands: one selectable-series catalog,
    one label and one ordering.
  - **The two cannot both hold as written.** If the owner declines the amendment, invariant 9
    requires columns materialized by the canonical rebuild, which "no per-session valuation
    persistence" excludes. One of the two must give way. Nothing else in this decision depends on
    which.
- **The chart** draws valuation ratios as daily lines in their own pane, not as step series,
  because the market capitalisation moves every session. A footnote states the carried reading,
  its distribution limit (U8) and the statement lag (U6).

## Historical backfill (PR 3V)

- **The same anchor-and-carry semantics as forward.** For each historical PIT event, with an
  anchor session before `observedSince`:

  ```text
  MC_a = researchClose^g(a) × Φ^L(a) × dilutedShares(a)
  ```

  - `Φ^L(a)` comes from the historical ledger at version `L` (`historical-price-basis-v1.md`,
    PR 3).
  - `dilutedShares(a)` is the PIT revision's count in generation `g`'s units. A revision observed
    before a later share-changing event is converted by measured unit evidence (PR 2).
  - The anchor is then frozen as a `BACKFILL` row carrying `g` and `L`.

- **Not the same statement vintages.** A forward anchor uses revisions as they were observed at
  the time. A backfilled statement is the provider's current version, dated from its original
  filing: the loader's backfill limit (`historical-price-basis-v1.md` §4). Around a later
  distribution that version can be recast with information published after the anchor session,
  as MMM's revenue is from Q2 2023 (U6). The "no look-ahead" property therefore holds for
  `BACKFILL` anchors only within that limit.
- **No session uses `Φ` after that.** Historical sessions are carried by research returns exactly
  like forward ones. A per-session `Φ` would give the actual-market-capitalisation reading inside
  historical distribution windows and the carried reading in forward ones: a methodology break at
  `observedSince`.
- **Unavailable where `Φ` is unmeasured:** before the security's `measuredFrom`, and before an
  unclassified, unexplained or undated event.
- **The boundary.**
  - `BACKFILL` rows exist only before `observedSince`, `LIVE` rows only on or after it.
  - The last `BACKFILL` anchor governs until the first `LIVE` one, carried by research returns
    across the boundary, so the only change there is the new inputs.
  - Backfilling never changes a `LIVE` value.
  - A late revision with a session before `observedSince` follows rule 11.
- **Frozen means corrections are explicit.** A later correction of `Φ` or of the vendor's data is a
  versioned re-backfill: new rows that supersede the old ones under a new ledger version.
  - A later provider rewrite of the research series changes no historical value when the
    rewritten events lie outside the carried window, because the carry cancels them.
  - Inside a window it does: a newly folded or re-sized event (DIS 2007 is undetermined, HON 2018
    was mis-sized) changes the carried values up to the next anchor, as it changes every
    research-derived series.
- **Securities first observed after the backfill** need their history measured against the
  reference: either once for the whole catalog at cutover, or at each first load. That choice is
  made with the vendor contract.

## Deterministic backtests (proposed)

A running backtest never changes silently: a provider rewrite or correction fails it with a
retryable reason, and a new anchor is invisible to it.

| Pin                            | Where                                                  | What it isolates                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Price generation, per security | the attempt's data-pin record (PR 1)                   | every research close, including each anchor session's close the carry divides by. A rewrite or a correction during the attempt fails it, retryably                       |
| Anchor version, per security   | the attempt's data-pin record (PR 2V)                  | rows with a higher `sequence`: new anchors, restatements, supersessions and re-backfills. Anchors are append-only, so the run reads its version and never fails for them |
| Ledger version                 | frozen on each anchor row; the data-pin record         | the `Φ` of a historical anchor and the `F` of every anchor                                                                                                               |
| `valuationMethodologyRevision` | `BACKTEST_DATA_REVISIONS`, in the run snapshot (PR 2V) | a queued run is refused across a bump, as for every data revision                                                                                                        |
| Statement revisions            | each anchor's inputs, through the anchor version       | statements reach valuation ratios only through anchors                                                                                                                   |

- **The data pins live outside the run snapshot.** AGENTS.md invariant 12 and
  `backtest-run-persistence.md` §2 make `BacktestRun.snapshot` immutable, written once at
  submission and hashed into `snapshotHash`. A security first hydrated in `PREPARING_DATA` has no
  counters at submission anyway.
  - So `PREPARING_DATA` writes a separate append-only record per run attempt: one row per security
    and per benchmark series, with the generation, ledger version and anchor version it read.
  - It is never part of the snapshot or its hash. A retry records its own pins.
- The existing stamps stay in the snapshot: `priceDatasetVersion`, `fundamentalsVariantVersion`
  and PR 1's `priceBasisRevision`.
- **Monitor.** One cycle reads one generation and one anchor version; a mismatch makes the security
  `NOT_EVALUABLE` for that cycle, as PR 1 specifies for prices.
- **Stock Details.** One response reads one generation and one anchor version.
- **Redis.** Anchors travel with the security's projection, under the manifest's generation and
  anchor version.

## Responsibilities

| Area                                | Responsibilities                                                                                                                                                                                                                                                     | Where                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Permanent, for every price consumer | re-base-safe loading; price generations; re-base detection, with undated intervals; atomic replacement; the ex-date hold; `observedSince`; per-attempt data pins; point-in-time statement revisions                                                                  | `historical-price-basis-v1.md` PR 1; the fundamentals loader |
| Historical valuation backfill only  | the external as-traded vendor; historical `Φ`; reconstructing and freezing historical anchors; unit evidence for revisions observed before a later split                                                                                                             | PR 3, PR 2 and PR 3V                                         |
| Forward valuation                   | frozen anchors; research-return carry; EV by components. No continuous `Φ`, no valuation rebuild after a corporate action, no per-session valuation persistence. The ledger's `F` at every anchor; classification and unit evidence only to release a pending anchor | PR 2V, with PR 2 for pending anchors                         |
| Margin of Safety                    | unchanged: per-session `Φ`, classification, unit conversion and masks; this simplification does not apply                                                                                                                                                            | `historical-price-basis-v1.md` PRs 2, 3 and 4                |

## Implementation plan

| PR                                    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Blocked on                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **1. Re-base-safe loading**           | as `historical-price-basis-v1.md` specifies, including what this design needed: `observedSince` from a verified read; undated intervals for events between two reads; a settling delay (by default, a row is settled once the next session has closed) and a generation bump on every correction of a settled row; per-attempt data pins outside the run snapshot                                                                                                                                                                                                    | O-1 (GPMT 1:10 on 2026-10-06, DXJ 3:1 on 2026-10-09). O-3 may shorten the default settling delay, and does not block |
| **2V. Forward valuation anchors**     | the methodology lock (U1–U4 and U8); `ValuationAnchor` and its migration; anchor creation by rules 1 to 11, written by the derived-work path, with the pending rows of rules 9 and 10 in PR 1's correction and replacement transactions; the projection function with EV by components; the five ratios in the selectable-series catalog and the Strategy registry, as Conditions unless U7 decides Triggers; the Stock Details pane; `valuationMethodologyRevision` and the anchor-version pin; the amendment of invariant 9 and the storage decision; forward only | PR 1 deployed; U1–U4 and U8; the owner's acceptance of the invariant 9 amendment                                     |
| **3V. Historical valuation backfill** | `BACKFILL` anchors for sessions before `observedSince`, with `Φ` from PR 3's ledger and units from PR 2's evidence; frozen; a resumable per-security job that also anchors late revisions (rule 11); the cutover and first-load rule; a verification report                                                                                                                                                                                                                                                                                                          | PR 3, hence a licensed as-traded reference that passes `historical-price-basis-v1.md` §6; PR 2; PR 2V; U6            |

- **Why PR 1 needs `observedSince`.** A forward anchor reads the ledger, which is complete only
  from the session PR 1 began observing the security. Nothing can reconstruct that session later.
  PR 1 records it when it creates the security's basis row, from the newest settled session of the
  first read that passes the overlap test. It is also the forward/historical boundary.
- **Why PR 1 needs undated intervals.** An event whose ex-date fell between two reads of a security
  scales every stored row by one ratio, so the comparison cannot date it. PR 1 records the interval
  instead of a date, and an anchor inside it waits (rules 5 and 6).
- **Why every correction must bump the generation.** Today's correction path writes a one-row
  correction without a new generation. A run could then read a corrected close in one window and
  the old one in another. For valuation the effect is larger: a corrected anchor-session close is
  the divisor of up to a quarter of carried values (rule 9).
- **Ordering.** PR 1 should ship as early as possible. A security's forward observation starts at
  its first verified read after PR 1 deploys, so the earlier it ships, the more forward history PR
  2V can anchor. A security nobody opens is not observed.
- **PR 2V and PR 2.** PR 2V does not wait for PR 2. Without it, an anchor that needs
  classification or unit evidence stays pending until a later anchor governs. PR 2, Margin of
  Safety's path, later releases such anchors with superseding rows.
- **Margin of Safety** keeps its own path: PRs 2, 3 and 4 of `historical-price-basis-v1.md`.

## Tests the implementation needs

- **Invariance:** a re-base for any event outside `(a, t]` (a split, a reverse split, a spin-off, a
  combined event, several events) leaves every carried value unchanged.
- **Inside `(a, t]`:** a split carries the actual market capitalisation; a folded spin-off carries
  the value as if reinvested until the next anchor, and creates no anchor; an unfolded
  distribution follows the price (U8).
- **Generations:** a projection never combines `P(a)` and `P(t)` from two generations; the research
  close stored at creation is never used as a divisor; a corrected anchor-session close and a
  replaced history append pending rows in their own transactions.
- **Anchor creation:**
  - a revision that changes only non-input fields, or only its filing date, creates no anchor;
  - an anchor is written by whichever of the revision and the settled close arrives second;
  - every anchor reads `F`, including one written at deploy, by the price write or by a
    methodology rewrite;
  - an anchor is pending exactly when rules 5 to 7 say: an unexplained event, an undated interval
    that contains its session or either end of rule 6's range, a ledger event near the share
    count's revision, an unexplained restatement, the calendar hold;
  - an undated event whose whole interval follows the session counts in `F`;
  - a unit-only restatement before and after an ex-date creates no anchor, and its count enters a
    later anchor only after the matching ledger event, which rule 6 then exempts;
  - a superseding row keeps the pending reasons it does not remove;
  - a pending anchor is never bridged by the previous one.
- **Restatements and late revisions:** a restatement that changes an input anchors at its own
  `availableFromDate` session and changes no earlier session; one outside every window creates no
  anchor; a moved period end follows rule 13; a first observation dated before existing anchors
  supersedes those whose inputs it changes (rule 11).
- **No look-ahead:** for every `LIVE` session, the value equals the one computed from revisions
  with `availableFromDate` on or before it and prices through it, after later splits and spin-offs.
  For `BACKFILL` sessions, the same within the loader's backfill limit.
- **Unavailability:** each reason per ratio, and the U1 and U2 rules; never zero, infinity or a
  stale value.
- **EV/EBITDA:** component carry matches a direct computation within rounding; whole-ratio carry
  does not.
- **Determinism:** a run ignores anchors above its pinned version; a generation change mid-attempt
  fails it and the retry records new pins; the snapshot and its hash never change; a methodology
  bump refuses a queued run.
- **Monitor:** the provisional observation on an anchor session carries the previous anchor; the
  ex-date hold makes valuation `NOT_EVALUABLE`.
- **Boundary (PR 3V):** the last `BACKFILL` anchor carries into the first `LIVE` one; no `BACKFILL`
  row on or after `observedSince`; `LIVE` values are unchanged by a backfill; a re-backfill
  supersedes and is visible only to runs pinned after it.
- **Dependencies:** no product path calls FMP's ratio, key-metric, market-capitalisation or
  enterprise-value endpoints.

## Alternatives considered

| Alternative                                                                          | Why not                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The 2026-09-30 candidate: research close × latest diluted shares on every session    | biased by `Φ` before every folded distribution (the 2026-09-30 gate)                                                                                                                            |
| A per-session corporate-action basis: research close × `Φ` × shares on every session | the previous design. Forward it needs classification, unit conversion, a rebuild and a mask for every event; historically it reads the actual market capitalisation inside distribution windows |
| FMP's ratio, key-metric or enterprise-value history as anchors                       | the same biased inputs, one quarter annualised on basic shares, rewritten after the fact and dated before publication (investigation, §8)                                                       |
| Carrying the whole EV/EBITDA ratio by price                                          | scales net debt with the price (investigation, §9.4)                                                                                                                                            |
| A new anchor at each distribution, at the post-distribution market capitalisation    | needs classification at the event, and pairs the standalone company's value with the combined company's statements. The owner chose the carried reading                                         |
| Carrying until a statement whose quarter includes the ex-date                        | needs classification to know a distribution happened; not the owner's rule. U6 may revisit statement content in the shared methodology                                                          |
| Anchor creation by revision identity (`contentHash`)                                 | a change to any unrelated field or to the filing date would end a carried window and could make an anchor pending (rule 1)                                                                      |
| Per-session columns materialized by the canonical rebuild                            | excluded by the owner's "no per-session valuation persistence"; it is what invariant 9 requires if the amendment is declined                                                                    |
| P/E as price ÷ the sum of four quarterly diluted EPS                                 | 170 of 6,387 quarters disagree with net income by more than 20 % for reasons other than rounding, and it puts P/E on a different basis from the other ratios                                    |
| Basic shares                                                                         | not the basis Margin of Safety uses, and no less biased                                                                                                                                         |
| Correcting prices with the provider's split history, or its "unadjusted" series      | the history omits, mis-sizes and mislabels events, and the "unadjusted" series is derived from it (the 2026-09-30 gate)                                                                         |

## The 2026-09-30 gate

Recorded, condensed. The details are in `docs/valuation-ratios-gate/INVESTIGATION.md`.

- **The candidate was `close × latest diluted shares` on every session. It failed (B1).** The
  stored close also carries price-only adjustments, which share counts do not follow: spin-offs and
  distributions, and for HON a reverse split fused with a spin-off.
  - Before such an adjustment the candidate is 4.4 % to 52.8 % low, on 10.6 % of the sessions of
    the securities with statements, in six securities.
  - Nothing stored identifies the affected sessions for every security, and the provider's split
    history is not a reliable list of them.
  - Also found: B2, a split after a security is first loaded; B3, single-quarter share anomalies;
    statements recast around spin-offs.
- **A documented limitation was rejected.** The bias is material and long-lived (HON's multiples
  about half their true value for 25 years), invisible to a user or a backtest, and decisive in a
  valuation screen.
- **It recommended a per-session corporate-action basis:** an as-traded reference, a measured
  share factor, a re-basing detector and statement unit conversion. The detector is now PR 1, for
  every price consumer. The rest serves Margin of Safety, and the historical backfill at anchor
  sessions only.
- **Two choices the evidence settled, and this decision keeps:**
  - **One equity value for every ratio, P/E included.** P/E is the market capitalisation over net
    income TTM, not the close over the sum of four quarterly EPS: 191 of 6,387 quarters have a
    diluted EPS more than 20 % from net income ÷ shares, and only 21 of them are cent rounding.
  - **The share count is the latest point-in-time quarterly `weightedAverageShsOutDil`**, as in the
    intrinsic-value engine. It is present on all 6,391 quarterly income statements, and four are
    not positive.

## Review

A clean-room reviewer checked the combined design on 2026-10-01: this decision, the updated
`historical-price-basis-v1.md`, the new evidence and the pointers.

- **What it had.** The committed documents, the cited code and read-only access to the
  development database. It did not see the author's scratch analysis. It made one FMP request
  (BRK-B's income statement).
- **What it accepted.**
  - Recommendation B is sound, and nothing should stop the design.
  - The carry identity: it re-derived it.
  - The nine carried windows: it recomputed them from the database, and every row matches.
  - The lag statistics of investigation §8.2, and the claims about the code and the cited rules.
  - That no product path calls FMP's ratio or market-capitalisation endpoints.
  - That an event on the anchor session, or between a filing and its anchor, makes the anchor
    pending.
- **What it found**, all accepted and corrected. HPB is `historical-price-basis-v1.md`.

| Finding                                                                                                                                                                                                                     | Severity | Correction                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| V1. The fingerprint hashed revisions, so any unrelated field or a filing-date change created an anchor (10 of 23 stored revision pairs)                                                                                     | Major    | anchors are created by a change in input values; the fingerprint hashes values (rule 1)                                   |
| V2. The statement path cannot write an on-time anchor, because the revision is stored before its session settles                                                                                                            | Major    | the derived-work path writes it when the second of the revision and the settled close arrives (rule 3)                    |
| V3. A corrected anchor close and its superseding row were separate writes, so a run could pin the gap; rebuilding the anchor recomputed it from FMP                                                                         | Major    | a pending row in the correction's own transaction; rebuilding is the owner's choice (rule 9, U9)                          |
| V4. "An on-time anchor reads no ledger" was wrong: `F` depends on events folded after the session, not on when the revision was observed                                                                                    | Major    | every anchor reads `F` with `P(a)`; "late" is descriptive (rule 5); cross-references corrected                            |
| V5. An event whose ex-date falls between two reads cannot be dated, so `F` is undetermined inside that interval; `observedSince` could precede such a gap                                                                   | Major    | undated intervals in PR 1's ledger; anchors inside them pending; `observedSince` from a verified read (rules 5–6; HPB §8) |
| V6. Recording pins in the run snapshot contradicts AGENTS.md invariant 12 and `snapshotHash`                                                                                                                                | Major    | per-attempt data pins in a separate append-only record ("Deterministic backtests"; HPB §9)                                |
| V7. An unfolded distribution does not get the owner's carried reading, and the decision presented it as compliance                                                                                                          | Major    | stated as a limit needing the owner's acceptance (rule 4, U8)                                                             |
| V8. Backfilled statements include recasts published after later spin-offs, so "same semantics" and "no look-ahead" fail for history                                                                                         | Major    | the backfill limit stated for PR 3V; U6 extended and made blocking for PR 3V; the test qualified                          |
| V9. A revision dated before existing anchors left them with stale inputs                                                                                                                                                    | Minor    | later anchors are superseded with the new inputs (rule 11)                                                                |
| V10. A count restated before an ex-date entered a later anchor as stored                                                                                                                                                    | Minor    | used only after the matching ledger event (rule 6)                                                                        |
| V11. A replacement that changes an anchor close by other than the event factor left a wrong divisor                                                                                                                         | Minor    | pending rows in the replacement's transaction (rule 10)                                                                   |
| V12. A methodology rewrite could be served before its rows exist, and could not price new anchor sessions                                                                                                                   | Minor    | served only once written; new sessions priced by `F` or by re-backfill ("Anchor persistence")                             |
| V13. "Correction" was undefined, and finalized volumes could bump generations daily                                                                                                                                         | Minor    | trigger and settling delay defined, measured by O-3 (HPB §7, §9)                                                          |
| V14. "(locked)" covered this design's own rules; U7's default was inconsistent                                                                                                                                              | Minor    | locked and proposed separated; U7 defaults to Conditions                                                                  |
| V15. WDC's next anchor kept the pre-spin balance sheet for 71 sessions                                                                                                                                                      | Minor    | five of nine steps for balance-sheet ratios; the evidence gains a balance-sheet column                                    |
| V16. "A provider rewrite changes no historical value" ignored events inside the window                                                                                                                                      | Minor    | qualified ("Historical backfill")                                                                                         |
| V17–V21. Responsibilities omitted PR 2's unit evidence; "combined company's value" needed "as if reinvested"; one claim held by construction; storage and types were understated; a pointer overstated the storage decision | Nit      | corrected; types and sizes restated; `calculated-series.md` aligned                                                       |

- **Verification.** The same reviewer then checked the corrections.
  - It found 19 of the 21 resolved, and two partly resolved: undated events (V5) and the
    methodology serving condition (V12).
  - It found eight smaller defects in the new text, all applied:
    - an undated event now counts by its interval wherever a rule places an event (rules 5–6);
    - the ledger event that explains a restated count is exempt from rule 6's range test;
    - only a corrected close, not volume or VWAP, makes an anchor pending, and the correction
      trigger covers every field;
    - pending reasons are a set that a superseding row inherits (rules 8 and 11);
    - the serving condition no longer fails a security that has no anchors;
    - U6 option (b) states its cost;
    - stale sentences were corrected in `historical-price-basis-v1.md`;
    - nits, including a conservative default settling delay, so O-3 no longer blocks PR 1.
  - It then judged the two decisions consistent at the architecture level, and consistent at the
    rule level once these were applied.

## References

- `docs/historical-price-basis/INVESTIGATION.md` §8 and §9, and
  `docs/historical-price-basis/evidence/anchor-carry-windows.csv` and `fmp-ratio-endpoints.csv`.
- `docs/decisions/historical-price-basis-v1.md`: terminology, PR 1, the ledger, `observedSince`,
  PR 2 and PR 3.
- `docs/valuation-ratios-gate/INVESTIGATION.md`: the 2026-09-30 gate.
- `docs/decisions/fundamental-metrics-v1.md`, `fundamental-metrics-storage-and-evaluation.md`,
  `intrinsic-value-engine.md`, `fundamentals-loader.md`,
  `retain-wide-column-calculated-series-storage.md`, `backtest-run-persistence.md`.
- `ai/architecture/deep-discovery.md` §15.

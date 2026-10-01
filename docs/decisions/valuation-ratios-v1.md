# Valuation Ratios V1

## Status

**Proposed. Not implemented.** This revision makes **frozen valuation anchors carried by
research-price returns** the canonical architecture for valuation ratios. The product owner chose
it on 2026-10-01, together with the carried reading across distributions. It replaces this
decision's 2026-09-30 conclusion that valuation ratios need a corporate-action basis on every
session.

- **Forward valuation (PR 2V)** needs re-base-safe loading (`historical-price-basis-v1.md`, PR 1,
  with the two additions in "Implementation plan") and the product decisions U1–U4 below. It needs
  no external data, no `Φ`, no event classification and no statement unit conversion for an anchor
  created on time.
- **Historical valuation (PR 3V)** needs `Φ` at anchor sessions only. It stays blocked on the
  external as-traded reference that `historical-price-basis-v1.md` §6 describes.
- **Margin of Safety is unchanged.** It keeps the per-session design of
  `historical-price-basis-v1.md`, and this simplification does not apply to it.
- **The 2026-09-30 gate result stands** ("The 2026-09-30 gate", below). The candidate
  `close × latest diluted shares` on every session is biased and is not built.
- **FMP's ratio, key-metric and enterprise-value endpoints are not product truth and are not
  anchors.** They are computed from the same biased inputs, rewritten after the fact and dated
  before their statements were public (investigation, §8).

The evidence is `docs/historical-price-basis/INVESTIGATION.md` §8 (FMP's ratio endpoints) and §9
(frozen anchors), with `docs/valuation-ratios-gate/INVESTIGATION.md` for the 2026-09-30 gate.

## The model

```text
point-in-time statement revisions
        │  a revision becomes eligible and changes an anchor input
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

- **A forward anchor** is created and frozen when its revision becomes available:
  `MC_a = asTradedClose(a) × dilutedShares(a)`.
- **A historical anchor** is reconstructed with `Φ`, then frozen:
  `MC_a = researchClose(a) × Φ(a) × dilutedShares(a)`. After that, no session uses `Φ`.
- **Daily values are computed, never stored.** Only anchors are persisted.

The terms (`researchClose`, `asTradedClose`, `Φ`, generation, ledger) are those of
`historical-price-basis-v1.md`, "Terminology".

## Carried semantics (locked)

1. **Between anchors, fundamentals are frozen point-in-time inputs.** A session that brings no new
   statement revision changes nothing about the company's fundamentals.
2. **The market capitalisation moves with research-price returns:**
   `MC_t = MC_a × P^g(t) ÷ P^g(a)`, with both closes from one price generation `g`.
3. **A split or a reverse split does not change the carried ratio.** The research series folds the
   split in, so across it the carried market capitalisation equals the actual one. Nothing is
   classified and no share count is converted (investigation, §9.2).
4. **A distribution does not create an anchor.** A spin-off or a special distribution is not a
   fundamental event.
   - Where the provider folds the distribution into the research series, as in every confirmed
     case, the carried market capitalisation keeps the value of the company as it was before the
     distribution: the combined company. Until new point-in-time fundamentals arrive, the ratio
     keeps describing the last fundamental reality an investor could know.
   - Where the provider does not fold it in, the research return falls with the price, and so
     does the carried market capitalisation.
   - The rule is the same in both cases: research returns. No ledger is consulted and the
     denominator is never reinterpreted as the standalone company before its statements exist.
5. **The next input-changing revision creates the new anchor**, whether it is a new quarter or a
   restatement ("Anchor creation"). An anchor is never backdated.

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

- In four of the nine steps (IBM 2021, MMM 2024, AXP 2005 and HON's first 2018 step), the next
  statement covers a quarter that ended before the ex-date.
- The anchor it creates pairs the post-distribution market capitalisation with combined-company
  statements for 60 to 78 sessions, until a statement whose quarter includes the ex-date.
- Every design has this window, from the ex-date on; the carried reading shortens it by the
  carried sessions. What to do about it is U6.

## Anchor creation (locked)

1. **Trigger.** A statement revision becomes point-in-time eligible (`fundamentals-loader.md`) and
   changes at least one anchor input: a new quarter, or a restatement of a quarter inside a window
   or of a latest-state statement. The candidate input set is compared with the governing
   anchor's by its fingerprint.
2. **A unit-only restatement creates no anchor.**
   - A revision that differs from the previous revision of the same fiscal identity only by one
     common share-unit ratio changes units, not information: every share count × `r`, every
     per-share figure ÷ `r`, everything else equal within the provider's rounding.
   - The governing anchor's close and share count are already in one unit, so it stays.
   - This holds whether the provider restates after an ex-date or before it.
3. **Anchor session.** The first settled session on or after the revision's `availableFromDate`,
   as Fundamental Metrics map a statement event onto the trading axis.
   - The anchor is built from that session's settled close, never from an intraday price.
   - Before the session settles, a Monitor's provisional observation carries the previous anchor
     to the live quote. That is the existing rule for intrinsic values and Fundamental Metrics
     (`monitor-frame.ts`, rule 2): the Monitor agrees with a backtest from the next observation
     on.
4. **Domain.** An anchor whose session is on or after the security's `observedSince`
   (`historical-price-basis-v1.md`, "Data model") is `LIVE`. An anchor before it is `BACKFILL`,
   and only PR 3V creates one.
5. **Price.** The as-traded close at the anchor session is `P^g(a) × F^g(a)`. `F^g(a)` is the
   product of the measured price ratios of the ledger events whose effective date is after `a`.
   - For an anchor created on time no such event exists, `F = 1`, and the ledger is not read.
   - A late anchor, created after later events, reconstructs its price from the ledger without
     classifying anything. An anchor is late when its revision was observed late, for example
     after the security was not refreshed for a while.
   - If an event after `a` has no single measured ratio (`UNEXPLAINED`), the anchor is pending.
6. **Share units.** The diluted share count must be in the units of session `a`. It comes from the
   latest Income quarter's revision, which need not be the revision that triggered the anchor. It
   is used as stored only when:
   - that revision's filing date is on or after `observedSince`, so the ledger covers everything
     after it; and
   - the ledger has no event with an effective date after that filing date and on or before the
     later of `a` and the revision's first observation.

   Then no share-changing event can lie between the units the count was filed in, the units the
   provider served when FactorSage observed it, and session `a`. Otherwise the count's units come
   from measured revision pairs (`historical-price-basis-v1.md` §3, PR 2), and until that evidence
   exists the anchor is pending.

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
   - Pending anchors need a share-changing or unexplained event near a revision, a share count
     filed before `observedSince`, or the hold of rule 7. They withhold values; they never show a
     wrong one.
9. **Price corrections.** When the provider corrects the settled close of an anchor session, the
   anchor is superseded by a row built from the corrected close. Otherwise the frozen market
   capitalisation and the corrected divisor would disagree on every session the anchor governs.

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
- a revision keeps the loader's `availableFromDate`, never reconstructed or backdated (rule 10;
  `fundamentals-loader.md`, "Revisions and restatements").

**Unavailability is per ratio and recorded on the anchor:** a missing input, an incomplete window,
mixed currencies, a non-positive share count, or the rules U1 and U2 decide. In an evaluation frame
the value is `NaN` and a Condition is `NOT_EVALUABLE`; in an API response it is absent. It is never
zero, infinity, a sentinel or a stale previous value (`fundamental-metrics-v1.md`, "Unavailability
and numeric safety").

**FMP's ratio methodology is not adopted.** FMP annualises one quarter, uses basic shares and
prices at the session nearest the period end (investigation, §8).

## Unresolved product decisions

U1 to U4 block PR 2V's methodology lock. U5 to U7 have a safe default and do not block it.

| #   | Decision                                                                                                                                             | Evidence and precedent                                                                                                                                                                                                                                                                                                                                             | Recommendation                                                                                                                                                                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | Zero and negative denominators (net income, revenue, FCF, equity, EBITDA), and a negative enterprise value                                           | No accepted document decides it for valuation. Every Fundamental Metrics denominator must be positive or the metric is unavailable: ROE, Debt / Equity ("rather than producing a misleading signed leverage ratio"), Net Debt / EBITDA (`EBITDA_TTM > 0`). Numerators may be negative: net debt, EBIT.                                                             | Unavailable when the denominator is `<= 0`, so `P/E is below 15` never admits a loss-maker. A negative enterprise value over positive EBITDA is a valid negative multiple, as negative net debt is.                                                                                                                                                                        |
| U2  | Statement currency against trading currency                                                                                                          | Rule 12 compares statements with each other, never with the price. All 62 stored securities report in their trading currency, but the catalog holds 2,091 non-US issuers, all quoted in USD. TSM reports in TWD. FMP's diluted counts for HSBC and TSM are in depositary units (investigation, §9.5).                                                              | Unavailable when `reportedCurrency` differs from `Security.currency`; no FX in V1. Depositary units are measured on two securities only, so PR 2V checks them on its test set.                                                                                                                                                                                             |
| U3  | The equity field for P/B                                                                                                                             | `totalStockholdersEquity` is used by ROE, Debt / Equity and Residual Income's book value. The market capitalisation is common equity, so preferred stock is a candidate deduction.                                                                                                                                                                                 | `totalStockholdersEquity`, for consistency with every existing equity input.                                                                                                                                                                                                                                                                                               |
| U4  | One-quarter share-count anomalies (B3)                                                                                                               | 593 sessions in nine episodes, each reversing at the next statement (NKE ×2.03, MSTR, JPM, JNJ, AMZN, UBER); JPM's coincides with a merger. Margin of Safety accepts them as provider data. A frozen anchor carries one for a whole quarter.                                                                                                                       | The owner's choice: (a) accept them, as Margin of Safety does; or (b) hold an anchor whose share count moves beyond a calibrated threshold from the previous anchor's with no ledger event to explain it. (b) also catches a unit error at creation, and withholds genuine moves. A held anchor is never released by a later statement, which would use later information. |
| U5  | A bootstrap anchor for a newly observed security                                                                                                     | Without one, a security has no forward value until its first input-changing revision after `observedSince`, up to a quarter. A bootstrap at `observedSince` from the latest input set is point-in-time, but its share units depend on the provider's restatement lag (O-2).                                                                                        | None in PR 2V. Revisit after O-2.                                                                                                                                                                                                                                                                                                                                          |
| U6  | Statements after a distribution: quarters that ended before the ex-date, windows that mix recast and as-filed quarters, and one-off separation gains | Four of the nine steps above. The provider recasts some quarters to continuing operations and not others, while net income stays the whole company's (the 2026-09-30 gate). HON's Q2 2026 net income, 2.4 times any other HON quarter since 2016, enters four TTM windows (`historical-price-basis-v1.md` §13). Fundamental Metrics use the revisions as reported. | V1 inherits Fundamental Metrics' treatment. A stricter rule belongs to the shared methodology, because it would change Fundamental Metrics too.                                                                                                                                                                                                                            |
| U7  | Conditions only, or Conditions and Triggers                                                                                                          | Fundamental Metrics are Conditions only, because they are step series. Margin of Safety also moves with the price every session and supports `crosses above` and `crosses below`.                                                                                                                                                                                  | Conditions and Triggers, as Margin of Safety, with existing operators only.                                                                                                                                                                                                                                                                                                |

## Anchor persistence

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
| `state`                                                                  | `ACTIVE`, or `PENDING` with its reason                                                                                                                    |
| `methodologyRevision`                                                    | the valuation methodology revision its components were computed under                                                                                     |
| `close`, `closeBasis`                                                    | the close the market capitalisation is built from: `AS_TRADED` for `LIVE`; `SPLIT_ADJUSTED` (research × `Φ`, in `priceGeneration`'s units) for `BACKFILL` |
| `dilutedShares`                                                          | in the same units as `close`                                                                                                                              |
| `marketCap`                                                              | `close × dilutedShares`: the frozen quantity the carry uses                                                                                               |
| `netIncomeTtm`, `revenueTtm`, `fcfTtm`, `ebitdaTtm`, `equity`, `netDebt` | null when that input is unavailable                                                                                                                       |
| `currency`                                                               | the inputs' `reportedCurrency`; null when they disagree or one is missing                                                                                 |
| `ratioStates`                                                            | for each ratio: available, or the reason it is not                                                                                                        |
| `inputs`, `inputFingerprint`                                             | the statement type, fiscal identity and `contentHash` of every revision that supplied an input, and a hash of that list                                   |
| `priceGeneration`, `researchCloseAtCreation`                             | audit only                                                                                                                                                |
| `ledgerVersion`                                                          | the ledger version read: `Φ` for `BACKFILL`, `F` for a late `LIVE` anchor; null when none was read                                                        |
| `supersedes`, `supersedeReason`                                          | the row replaced, and why: unit evidence, a price correction or a re-backfill                                                                             |
| `createdAt`                                                              | when the row was written                                                                                                                                  |

- **Which row governs session `t`** under anchor version `v`: among the rows of the current
  methodology revision with `sequence <= v` that no row with `sequence <= v` supersedes, the one
  with the latest `anchorSession <= t`, and of those the highest `sequence`. A pending row makes
  its ratios unavailable.
- **A methodology change** writes a new set of rows under the new revision, from stored statements
  and the frozen anchor closes. It reads no provider. Rows of other revisions are kept for audit
  and ignored.
- **Storage.** About four rows per security-year, so about 120 rows and 30 KB for a 30-year
  security. Four per-session columns would add about 0.47 MB of Redis per security
  (`retain-wide-column-calculated-series-storage.md`, "Headroom for the valuation ratios").

## Daily values are projected, never stored

- **One projection function** in `@intrinsic/stock-data` computes each session's values from the
  governing anchor and the research closes of one generation. The evaluation frame, the Monitor
  frame and the Stock Details API all call it, so the chart and a Strategy show the same number.
  It reads no statement and computes no anchor.
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
  - If the owner prefers to keep invariant 9 as written, the canonical rebuild can materialize the
    same projection into columns instead. Nothing else here changes.
- **Anchors are written by the statement path** that already triggers derived work when a revision
  is stored, never by a read.
- **The chart** draws valuation ratios as daily lines in their own pane, not as step series,
  because the market capitalisation moves every session. A footnote states the carried reading.

## Historical backfill (PR 3V)

- **Same semantics as forward.** For each historical PIT event, with an anchor session before
  `observedSince`:

  ```text
  MC_a = researchClose^g(a) × Φ^L(a) × dilutedShares(a)
  ```

  - `Φ^L(a)` comes from the historical ledger at version `L` (`historical-price-basis-v1.md`,
    PR 3).
  - `dilutedShares(a)` is the PIT revision's count in generation `g`'s units. A revision observed
    before a later share-changing event is converted by measured unit evidence (PR 2).
  - The anchor is then frozen as a `BACKFILL` row carrying `g` and `L`.

- **No session uses `Φ` after that.** Historical sessions are carried by research returns exactly
  like forward ones. A per-session `Φ` would give the actual-market-capitalisation reading inside
  historical distribution windows and the carried reading in forward ones: a methodology break at
  `observedSince`.
- **Unavailable where `Φ` is unmeasured:** before the security's `measuredFrom`, and before an
  unclassified or unexplained event.
- **The boundary.**
  - `BACKFILL` rows exist only before `observedSince`, `LIVE` rows only on or after it.
  - The last `BACKFILL` anchor governs until the first `LIVE` one, carried by research returns
    across the boundary, so the only change there is the new inputs.
  - Backfilling never changes a `LIVE` value.
- **Frozen means corrections are explicit.** A later correction of `Φ` or of the vendor's data is a
  versioned re-backfill: new rows that supersede the old ones under a new ledger version. A later
  provider rewrite of the research series changes no historical value, because the carry cancels
  it.
- **Securities first observed after the backfill** need their history measured against the
  reference: either once for the whole catalog at cutover, or at each first load. That choice is
  made with the vendor contract.

## Deterministic backtests

A running backtest never changes silently: a provider rewrite fails it with a retryable reason, and
a new anchor is invisible to it.

| Pin                            | Where                                                        | What it isolates                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Price generation, per security | the run snapshot (PR 1)                                      | every research close, including each anchor session's close the carry divides by. A rewrite or a correction during the run fails it, retryably                           |
| Anchor version, per security   | the run snapshot (PR 2V)                                     | rows with a higher `sequence`: new anchors, restatements, supersessions and re-backfills. Anchors are append-only, so the run reads its version and never fails for them |
| Ledger version                 | frozen on each anchor row; PR 1's pin                        | the `Φ` of a historical anchor and the `F` of a late one                                                                                                                 |
| `valuationMethodologyRevision` | `BACKTEST_DATA_REVISIONS` (PR 2V)                            | a queued run is refused across a bump, as for every data revision                                                                                                        |
| Statement revisions            | each anchor's `inputFingerprint`, through the anchor version | statements reach valuation ratios only through anchors                                                                                                                   |

- The existing stamps stay: `priceDatasetVersion`, `fundamentalsVariantVersion` and PR 1's
  `priceBasisRevision`.
- **Monitor.** One cycle reads one generation and one anchor version; a mismatch makes the security
  `NOT_EVALUABLE` for that cycle, as PR 1 specifies for prices.
- **Stock Details.** One response reads one generation and one anchor version.
- **Redis.** Anchors travel with the security's projection, under the manifest's generation and
  anchor version.

## Responsibilities

| Area                                | Responsibilities                                                                                                                                                                                                           | Where                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Permanent, for every price consumer | re-base-safe loading; price generations; re-base detection; atomic replacement; the ex-date hold; `observedSince`; point-in-time statement revisions                                                                       | `historical-price-basis-v1.md` PR 1; the fundamentals loader |
| Historical valuation backfill only  | the external as-traded vendor; historical `Φ`; reconstructing and freezing historical anchors                                                                                                                              | PR 3 and PR 3V                                               |
| Forward valuation                   | frozen anchors; research-return carry; EV by components. No continuous `Φ`, no valuation rebuild after a corporate action, no per-session valuation persistence. The ledger's measured price ratios only for a late anchor | PR 2V                                                        |
| Margin of Safety                    | unchanged: per-session `Φ`, classification, unit conversion and masks; this simplification does not apply                                                                                                                  | `historical-price-basis-v1.md` PRs 2, 3 and 4                |

## Implementation plan

| PR                                    | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Blocked on                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **1. Re-base-safe loading**           | as `historical-price-basis-v1.md` specifies, with two additions: `observedSince`, and a generation bump on every correction of a settled row                                                                                                                                                                                                                                                                                                                                               | O-1 (GPMT 1:10 on 2026-10-06, DXJ 3:1 on 2026-10-09)                                                  |
| **2V. Forward valuation anchors**     | the methodology lock (U1–U4, and U7 for Triggers); `ValuationAnchor` and its migration; anchor creation by rules 1–9, including late and pending anchors and the calendar hold of rule 7; the projection function with EV by components; the five ratios in the selectable-series catalog and the Strategy registry; Stock Details pane; `valuationMethodologyRevision` and the anchor-version pin; the amendment of invariant 9 and the storage decision; forward-only: no `BACKFILL` row | PR 1 deployed; U1–U4; the owner's acceptance of the invariant 9 amendment                             |
| **3V. Historical valuation backfill** | `BACKFILL` anchors for sessions before `observedSince`, with `Φ` from PR 3's ledger and units from PR 2's evidence; frozen; a resumable per-security job; the cutover and first-load rule; a verification report                                                                                                                                                                                                                                                                           | PR 3, hence a licensed as-traded reference that passes `historical-price-basis-v1.md` §6; PR 2; PR 2V |

- **Why PR 1 needs `observedSince`.** A late anchor reconstructs its price from the ledger, which
  is complete only from the session PR 1 began observing the security. Nothing can reconstruct that
  session later, so PR 1 records it when it creates the security's basis row: the newest settled
  session stored then. It is also the forward/historical boundary.
- **Why every correction must bump the generation.** PR 1 sends a one-row correction down today's
  correction path without a new generation. A run could then read a corrected close in one window
  and the old one in another. For valuation the effect is larger: a corrected anchor-session close
  is the divisor of up to a quarter of carried values (rule 9).
- **Ordering.** PR 1 should ship as early as possible: its deployment starts every security's
  forward observation, so the earlier it ships, the more forward history PR 2V can anchor.
- **PR 2V and PR 2.** PR 2V does not wait for PR 2. Without it, the rare anchor that needs unit
  evidence stays pending until a later anchor governs. PR 2, Margin of Safety's path, later
  resolves such anchors with superseding rows.
- **Margin of Safety** keeps its own path: PRs 2, 3 and 4 of `historical-price-basis-v1.md`.

## Tests the implementation needs

- **Invariance:** a re-base for any event outside `(a, t]` (a split, a reverse split, a spin-off, a
  combined event, several events) leaves every carried value unchanged.
- **Inside `(a, t]`:** a split carries the actual market capitalisation; a folded spin-off carries
  the combined value until the next anchor and creates no anchor; an unfolded distribution follows
  the price.
- **Generations:** a projection never combines `P(a)` and `P(t)` from two generations; the research
  close stored at creation is never used as a divisor; a corrected anchor-session close supersedes
  the anchor.
- **Anchor creation:** an on-time anchor reads no ledger; a late anchor reconstructs its price from
  the ledger and is pending exactly when rule 6 says; a unit-only restatement before and after an
  ex-date creates no anchor; the calendar hold of rule 7; a pending anchor is never bridged by the
  previous one.
- **Restatements:** a restatement that changes an input anchors at its own `availableFromDate`
  session and changes no earlier session; one outside every window creates no anchor; a moved
  period end follows rule 13.
- **No look-ahead:** for every session, the value equals the one computed from revisions with
  `availableFromDate` on or before it and prices through it, after later splits and spin-offs.
- **Unavailability:** each reason per ratio, and the U1 and U2 rules; never zero, infinity or a
  stale value.
- **EV/EBITDA:** component carry matches a direct computation within rounding; whole-ratio carry
  does not.
- **Determinism:** a run ignores anchors above its pinned version; a generation change mid-run
  fails it; a methodology bump refuses a queued run.
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
| Carrying the whole EV/EBITDA ratio by price                                          | scales net debt with the price (§9.4)                                                                                                                                                           |
| A new anchor at each distribution, at the post-distribution market capitalisation    | needs classification at the event, and pairs the standalone company's value with the combined company's statements. The owner chose the carried reading                                         |
| Carrying until a statement whose quarter includes the ex-date                        | needs classification to know a distribution happened; not the owner's rule. U6 may revisit statement content in the shared methodology                                                          |
| Per-session columns materialized by the canonical rebuild                            | the owner chose no per-session valuation persistence; this remains the fallback if invariant 9 is not amended                                                                                   |
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

## References

- `docs/historical-price-basis/INVESTIGATION.md` §8 and §9, and
  `docs/historical-price-basis/evidence/anchor-carry-windows.csv` and `fmp-ratio-endpoints.csv`.
- `docs/decisions/historical-price-basis-v1.md`: terminology, PR 1, the ledger, `observedSince`,
  PR 2 and PR 3.
- `docs/valuation-ratios-gate/INVESTIGATION.md`: the 2026-09-30 gate.
- `docs/decisions/fundamental-metrics-v1.md`, `fundamental-metrics-storage-and-evaluation.md`,
  `intrinsic-value-engine.md`, `fundamentals-loader.md`,
  `retain-wide-column-calculated-series-storage.md`.
- `ai/architecture/deep-discovery.md` §15.

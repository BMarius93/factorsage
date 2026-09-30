# Valuation Ratios V1: the split and share-basis gate

Branch `feat/valuation-ratios-v1`, cut from `main` at `a4f80d0f` (the merge of PR #73), investigated
on 2026-09-30.

`P/E TTM`, `P/S TTM`, `P/FCF TTM` and `EV/EBITDA TTM` all need an equity value on each trading
session. FactorSage's close is the provider's split-adjusted close. Before any of the four could be
built, a methodology gate had to show that a stored share count sits on the same basis as that
close on every session. This document is the evidence. The gate **failed**, and
`docs/decisions/valuation-ratios-v1.md` records the decision that follows. No product code was
written.

A clean-room reviewer checked a first version of this document and corrected it. The provider's
"unadjusted" prices proved not to be independent, and the size of B1 was measured again against
insider transaction prices. Everything below is the corrected version.

## Verdict

- **Blocker B1: the stored close is not purely split-adjusted.** It also carries spin-offs and
  distributions, which change no share count. For HON it also carries a reverse split fused with
  a spin-off. The measure used is the insider transaction prices already in the store, which are
  as-traded prices; for WDC, which has none, it is the provider's own split history.
  - Six securities carry such adjustments inside the product horizon.
  - `close × diluted shares` is 4.4 % to 52.8 % below the true equity value on every session before
    them.
  - That is 35,234 of the 332,294 sessions of the 62 securities with statements (10.6 %), and
    28,089 of the QA matrix's 234,085 (12.0 %).
- **Nothing stored identifies those sessions reliably.**
  - The provider's split history omits two of the adjustments, misstates the size of two, and
    lists one the stored close does not carry.
  - The provider's "unadjusted" price series is derived from that same history, so it cannot
    check it.
  - Insider prices measure the adjustment, but only for 33 securities, sparsely, and not for
    WDC.
- **Blocker B2 (future splits).** A split after a security was first loaded gives the stored close
  a split-sized step, because the loader re-reads only the recent tail of prices. On the sessions
  between that step and the next statement refresh, prices and point-in-time statements sit on
  different bases, permanently.
- **Where only share splits intervene, the bases do align.**
  - All 89 share splits in the product horizon are invisible in the stored close.
  - 87 of the 89 are invisible in the latest-quarter share count.
  - The provider's share restatements equal its split factors: AAPL ×28, NVDA ×10, AMZN ×20,
    WMT ×3 and CRWD ×4.
  - Insider prices confirm the price side: AAPL insider trades before its 2020 split are at 4.00×
    the stored close, and GOOGL's before its 2022 split at 20.0×.
- **Also found.**
  - B3: a few quarters' share counts sit on a different basis than their neighbours (593
    sessions).
  - The provider's statements are recast to continuing operations around a spin-off, so a TTM
    window can mix bases.
- **An existing feature carries B1 and B2 today.** Margin of Safety compares per-share intrinsic
  values, built from the same share counts, with the same close. HON's stored Balanced MOS on
  2025-06-30 reads −63.8 %; on the as-traded price it is −231 %.

## Scope

| Data                                    | What was read                                                                                                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Development database `intrinsic_value`  | 62 securities with statements, 23,853 statement revisions, 6,391 quarterly income identities, and 332,294 price sessions from 1996-09-30 (the 30-year product horizon on 2026-09-30).                                                                                                        |
| QA matrix copy `intrinsic_value_matrix` | The 33-security subset: 16,797 revisions and 234,085 sessions. Each finding holds there for the securities it contains.                                                                                                                                                                      |
| Insider transactions                    | The 63,377 priced open-market Form 4 trades (codes `S` and `P`) that fall on a stored session, for the 33 matrix securities, from 2000-08-31. A transaction price is the as-traded price on its date, so its ratio to that session's stored close measures the adjustment the close carries. |
| Provider (investigation only)           | 152 read-only requests with the local key: the split history of all 62 securities (`stable/splits`), adjusted and "unadjusted" closes in 13 windows, and as-reported quarterly income statements. Nothing was persisted in the repository.                                                   |

Every stored statement revision was first observed between 2026-08-31 and 2026-09-28. Only 25
fiscal identities have more than one revision, in five securities, and none of the income-statement
revisions changes a share count or an EPS figure. So the stored data holds one vintage of the
provider's statements, and one vintage of its prices.

The provider's "unadjusted" series (`historical-price-eod/non-split-adjusted`) is its adjusted
series multiplied back by the ratios in its own split history. Its volumes show it:

- WDC's for 2025-02-19 is 5,240,219.2, which is 6,932,810 ÷ 1.323;
- IBM's for 2021-11-02 is 4,514,399.62, which is 4,722,062 ÷ 1.046.

So that series restates the split history. It is no independent check of it.

## The five questions

### 1. Are historical diluted share counts restated for later splits?

**Yes, by the split ratio, for share-changing splits.** The as-reported statement feed gives the
share count as originally filed. Dividing the restated count by it gives the provider's
restatement factor. That factor matches the product of the provider's split ratios after the
quarter became available, wherever only share splits followed.

| Quarter (fiscal) | As reported | Restated (stored) | Restated ÷ as reported | Split-history factor once the quarter is available |
| ---------------- | ----------: | ----------------: | ---------------------: | -------------------------------------------------- |
| AAPL Q3 FY2012   |     947.1 M |        26,517.7 M |                28.0000 | 28 (7:1 on 2014-06-09 × 4:1 on 2020-08-31)         |
| AAPL Q3 FY2014   |   6,051.7 M |        24,206.8 M |                 4.0000 | 4                                                  |
| NVDA Q3 FY2024   |   2,494.0 M |        24,940.0 M |                10.0000 | 10 (10:1 on 2024-06-10)                            |
| AMZN Q3 2021     |     515.0 M |        10,300.0 M |                20.0000 | 20 (20:1 on 2022-06-06)                            |
| WMT Q3 FY2024    |   2,703.0 M |         8,109.0 M |                 3.0000 | 3 (3:1 on 2024-02-26)                              |
| CRWD Q1 FY2027   |     257.9 M |         1,031.5 M |                 4.0000 | 4 (4:1 on 2026-07-02)                              |
| IBM Q1 2021      |     901.7 M |           901.7 M |                 1.0000 | **1.046** (Kyndryl, see question 4)                |
| WDC Q2 FY2025    |     357.0 M |           357.0 M |                 1.0000 | **1.323** (Sandisk, see question 4)                |

- **Across the whole feed.** 2,033 quarters have an as-reported diluted share count to compare.
  - 1,736 (85.4 %) agree with the split-history factor within 2 %.
  - 64 differ by exactly a price-only factor: IBM 25 and WDC 39.
  - 233 differ because the as-reported value itself is defective, so the feed cannot serve as a
    product input. 98 of them are off by 50× or more (counts reported in thousands or millions,
    or placeholders). 68 are class-A-only or pre-IPO counts (V, DDOG, HOOD, RDDT, META). 67
    differ by less than 25 %, mostly derived fourth quarters.
- **The stored data agrees.** Of the 89 share splits inside the stored price history of the
  product horizon:
  - All 89 are invisible in the stored close. On each split date the day-over-day move is less
    than half of the split's own size; an unadjusted split would move by the whole ratio.
  - 87 are invisible in the latest-quarter diluted share count, compared between the last quarter
    before the split and the first quarter after it.
  - The two exceptions are single-quarter provider inconsistencies (question 3), not an
    unrestated history: JPM's 3:2 of 2000-06-12 (×1.57, the Q2 2000 figure, which reverts) and
    MSTR's 2:1 of 2000-01-27 (×0.51, from MSTR's alternating 1999 quarters).
- **Insider prices confirm the price side.** Controls with no other adjustment:
  - AAPL trades before 2020-08-31 are at 4.001× the stored close (n = 302), and 0.999× after it
    (n = 198).
  - GOOGL trades between the 2014 distribution and the 2022 split are at 20.04× (n = 6,119).
  - JNJ 0.999× (n = 460) and KO 1.000× (n = 369).
- **Split history.** The splits come from the provider's own history: 226 events for the 62
  securities, 97 of them inside the horizon. 89 are these share splits and seven are the provider's
  price-only entries of question 4. The last is a HON split from 1997 that predates HON's stored
  prices.
- **One split postdates this model's knowledge.** CRWD's 4:1 of 2026-07-02 was restated for every
  stored quarter, and the stored close is continuous across it (193.19 → 193.98).

### 2. Is `epsDiluted` on the same basis?

**Yes, on the same restatement, with a precision loss.** Most values are stored to the cent, which
loses precision when restatement makes EPS small. AAPL's Q3 FY2012 diluted EPS was 9.32 as filed;
divided by 28 that is 0.3329, and it is stored as 0.33. Some values keep sub-cent precision (1,116 of
6,391, in 56 securities), so the rounding is not uniform. The provider also has EPS defects of its
own:

- a fourth quarter carrying the fiscal year's EPS: CVX Q4 2010 is stored at 9.48, where net
  income ÷ shares gives 2.64;
- a figure that disagrees with its own net income: JNJ Q3 2019 is stored at 1.81, against 0.66;
- a half-restated EPS: GOOG and GOOGL Q4 2006 and Q4 2007 are about twice net income ÷ shares;
- a value no rounding explains: CSCO's FY1990 quarters are stored at 0.01, where net income ÷
  shares is 0.0007 to 0.0010.

### 3. Does `epsDiluted × weightedAverageShsOutDil` reconcile with net income?

**Mostly.** 6,387 quarterly income identities have both a net income and a positive share count.

| Relative difference from net income | Quarters |  Share |
| ----------------------------------- | -------: | -----: |
| ≤ 0.5 %                             |    3,764 | 58.9 % |
| 0.5 – 2 %                           |    1,665 | 26.1 % |
| 2 – 5 %                             |      510 |  8.0 % |
| 5 – 20 %                            |      257 |  4.0 % |
| > 20 %                              |      191 |  3.0 % |

- The median difference is 0.32 %.
- Of the 191 quarters beyond 20 %, only 21 are cent rounding: their EPS is within half a cent of
  net income ÷ shares.
- The other 170 are provider disagreements between EPS and net income, concentrated in DIS (42),
  ROP (26), JPM (14) and CSCO (11).
- The diluted share count is present on all 6,391 quarterly income statements, and four of them
  are not positive.

**Share-count anomalies (B3).** The share series itself has a few quarters on a different basis
than their neighbours. In the product horizon an anomalous count becomes the latest point-in-time
quarter in nine episodes: one row below for each security, two for JPM and three for MSTR. Each
reverses at the next statement.

| Security | Sessions                | Latest-quarter diluted shares | Move                             |
| -------- | ----------------------- | ----------------------------- | -------------------------------- |
| NKE      | 2002-04-16 → 2002-08-15 | 2,155 M → 4,374 M             | ×2.03 for 85 sessions            |
| MSTR     | 1999-05-17 → 2000-04-14 | alternates 76 M ↔ 153 M       | ×2 up and down, 232 sessions     |
| JPM      | 2000-08-15 → 2001-03-23 | 1,236 M → 1,939 M → 1,312 M   | ×1.57, then ×0.68, 152 sessions  |
| JNJ      | 2000-04-03 → 2000-05-16 | 2,838 M → 3,785 M             | ×1.33 for 30 sessions            |
| AMZN     | 1998-03-31 → 1998-05-18 | 5,667 M → 3,540 M             | ×0.63 for 33 sessions            |
| UBER     | 2019-08-12 → 2019-11-06 | 1,677 M → 1,111 M             | ×0.66 for 61 sessions (IPO year) |

That is 593 sessions, 0.18 % of the horizon. Visa's 2010–2012 quarters also alternate by about
±45 % every two quarters, depending on whether class B and C shares are counted as converted (633
sessions by hindsight). These are provider data-quality issues. Margin of Safety already consumes
the same counts.

### 4. Does `close × shares` avoid split-induced market-cap discontinuities?

**Not across price-only adjustments.** The stored close absorbs spin-offs and distributions as if
they were splits, and the share counts do not follow them, because a spin-off changes no share
count. The ratio of insider transaction prices to the stored close measures each adjustment
directly:

| Security | Sessions (before the next event) | Event and provider split-history entry                                                                                        | Insider price ÷ stored close (median, n) | Share counts                             | `close × shares` against the true equity value |
| -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| MMM      | to 2024-03-28 (6,920)            | Solventum spin-off, 2024-04-01: **no entry**                                                                                  | 1.1967 (317); 1.0022 after (158)         | not restated (554 M → 556 M, as filed)   | **−16.4 %**                                    |
| HON      | to 2018-10-26 (4,450)            | Garrett (2018-10-01) and Resideo (2018-10-29) spin-offs: one entry, 1011:1000 (`stock-split`) dated 2018-10-28, **too small** | 1.0602 (267)                             | restated ×0.5 by the 2026 reverse split  | **−52.8 %**                                    |
| HON      | 2018-10-29 → 2025-10-29 (1,760)  | Solstice spin-off, 2025-10-30: **no entry**                                                                                   | 1.0107 (31)                              | restated ×0.5                            | **−50.5 %**                                    |
| HON      | 2025-10-30 → 2026-06-26 (164)    | 1-for-2 reverse split and Aerospace spin-off, 2026-06-29: entry 1907:2000 (`spin-off`)                                        | 0.9561 (8)                               | restated ×0.5 (EPS as filed 1.29 → 2.58) | **−47.7 %**                                    |
| WDC      | to 2025-02-21 (7,145)            | Sandisk spin-off, 2025-02-24: entry 1323:1000 (`stock-split`)                                                                 | none stored; entry gives 1.323           | not restated (357 M as filed)            | **−24.4 %**                                    |
| AXP      | to 2005-09-30 (2,267)            | Ameriprise spin-off, 2005-10-03: entry 10000:8753 (`stock-split`), **too large**                                              | 1.1327 (148); 0.9984 after (410)         | continuous (1,254 M → 1,258 M)           | **−11.7 %**                                    |
| MRK      | to 2021-06-02 (6,210)            | Organon spin-off, 2021-06-03: entry 131:125 (`stock-split`)                                                                   | 1.0478 (238); 1.0008 after (123)         | continuous (2,541 M → 2,540 M)           | **−4.6 %**                                     |
| IBM      | to 2021-11-03 (6,318)            | Kyndryl spin-off, 2021-11-04: entry 523:500 (`stock-split`)                                                                   | 1.0456 (2,164); 0.9951 after (15)        | not restated (25 quarters as filed)      | **−4.4 %**                                     |

- **One provider entry is not in the stored close.** DIS's 2007-06-13 entry (2000:1973, 1.4 %)
  does not appear in it: insider trades before it sit at 0.999× the stored close (n = 13, a thin
  sample). No bias is counted for DIS.
- **GOOG and GOOGL's 2014 class C distributions** (1001:500 and 999:500) are share-changing 2:1
  events. The provider's entry carries a 0.1 % price-only residual, below the 1 % threshold used
  for counting.
- **HON's rows split at the provider's entry date.** Garrett was distributed on 2018-10-01, so
  the 19 sessions before 2018-10-29 carry about 1 % less adjustment than the first HON row
  states.
- **The stored values carry the bias, not only the feed.** For every event above, the stored close
  on the session before it matches the provider's adjusted close to the cent.
- **The size of the problem, at 1 % or more.** Development: 35,234 of 332,294 sessions (10.6 %).
  QA matrix, which lacks WDC: 28,089 of 234,085 (12.0 %).

What this means for the ratios:

- **Every multiple on a biased session is too low.** P/E, P/S and P/FCF are too low by the table's
  factor. EV/EBITDA is too low through its equity component.
- **The affected history is long.** About 25 years at IBM, MRK and HON (at HON by about half), 27
  years at MMM and 28 at WDC.

**Why it cannot be handled from stored data.**

- **The stored series hide the events.** Across each event the stored close is continuous, which
  is the adjustment's purpose, and so is the share series. Since 1992 the stored closes move by
  more than +80 % or −45 % in a day only three times, and all three are real market events:
  AAPL's profit warning of 2000-09-29 (−52 %), CRCL's first session after its IPO, and MRNA on
  2026-08-19 (+177 % on 199 M shares, confirmed against the provider).
- **The provider's split history is not a reliable list.**
  - It omits two events (MMM 2024, HON 2025), misstates the size of two (HON 2018, AXP 2005), and
    lists one the stored close does not carry (DIS 2007).
  - It labels six of its seven price-only entries `stock-split`. Its one `spin-off` label, HON's,
    also contains the reverse split, which the statements did restate.
  - A rule that classifies entries by their ratio would separate the entries it lists. It cannot
    add the missing ones or resize the wrong ones.
  - The provider's "unadjusted" series inherits all of this (see Scope).
- **Insider prices measure the adjustment, but not everywhere.**
  - They exist only for 33 securities, from 2000 (WDC has none).
  - They are sparse: n = 8 for HON's last period and 13 for DIS.
  - They include non-market rows. MRK's 2003–2008 medians are 0.39–0.69, which is why the MRK
    period above starts in 2009.
  - They cannot see a share restatement such as HON's reverse split.
  - They can validate a basis. They cannot be the basis for every session.

### 5. Does the ratio stay point-in-time under the existing revision model?

**Within one vintage of provider data, yes, apart from B1.**

- The ratio would read only revisions with `availableFromDate ≤ D`, mapped to the first session on
  or after it, and the close of session `D`.
- Where only share splits intervene, the split factor cancels exactly between the close and the
  restated share count. So no knowledge of a later split can leak into a session's multiple.

**Across a split that happens after a security was loaded, no (B2).**

- **The stored close gains a split-sized step.** After first load the loader re-reads only the
  recent tail of prices. The tail runs from ten calendar days before the earlier of today and the
  previous refresh's tail (`refreshPriceWithinLease`, pinned by `service.test.ts` › "refreshes
  only a stale recent tail and rewrites only affected years"). The provider re-bases the whole
  history on a split, so rows older than the tail keep the old basis and the tail takes the new
  one. That step alone is wrong for every Monitor, technical indicator and backtest that crosses
  it, whether or not valuation ratios exist. This is the "corrections older than the tail are
  never observed" limitation of `ai/architecture/deep-discovery.md` §6, applied to an event that
  corrects every row. Bumping `PRICE_DATASET_VERSION` is the only existing way to re-read a
  history, and it is manual and global.
- **Prices and statements diverge on the sessions between the step and the next statement
  refresh.**
  - The history before the tail stays consistent with itself: old-basis prices against old-basis
    statements.
  - The statement refresh re-reads the latest twelve quarters. A split restatement changes their
    content, so each becomes a revision whose `availableFromDate` is its observation
    (`fundamentals-loader.md`, rule 3).
  - The sessions from the tail's start to that observation therefore pair new-basis prices with
    old-basis share counts. They stay that way in every later rebuild.
- **A real split shows the size.** Had CRWD been loaded before its 4:1 split of 2026-07-02:
  - its stored closes before about 2026-06-22 would still read four times higher;
  - the re-read sessions would pair the new basis with the pre-split statements (about 250 M
    shares) until those were re-observed;
  - the multiples on those sessions would be a quarter of the truth.
- **The stored data does not hit this today.** Every statement and price was fetched after the
  last split in the data (CRWD was first loaded in September 2026). The price scan above found no
  stale-basis segment.

## Statements recast around a spin-off

Around a spin-off the provider recasts some quarters to continuing operations and leaves others as
filed, and the recast ones are not necessarily the most recent. So the quarters in one TTM window
can describe different companies.

- **WDC.** Revenue is stored as 3,032 M for Q2 FY2024 and as 4,285 M for Q2 FY2025, the last
  quarter before the spin-off, both as filed and including flash. In between, Q3 FY2024 to
  Q1 FY2025 are recast to hard drives only: 1,752 M, 2,004 M and 2,212 M, with discontinued
  operations of 135 M, 285 M and 340 M.
- **IBM.** Q4 2020 is stored at 20,368 M as filed, and Q1–Q3 2021 at 13,187 M, 14,218 M and
  13,251 M, which exclude Kyndryl.
- **Net income stays the whole company's total.** Stored net income is continuing plus
  discontinued operations (WDC Q3 FY2024: 127 M = −8 M + 135 M). So revenue- and EBITDA-based
  multiples would mix bases around a spin-off even on a correct equity value. That is a
  methodology question for the follow-up.

## Consequence for an existing feature: Margin of Safety

Margin of Safety divides by per-share intrinsic values. DCF (FCFF) and Residual Income divide an
equity value by the same latest diluted share count, Graham uses summed diluted EPS, and DDM uses
per-quarter dividends per share. The result is compared with the same stored close
(`intrinsic-value-engine.md`), so it inherits B1 and B2.

| Session        | Stored inputs                      | Stored MOS | On the as-traded price                                                           |
| -------------- | ---------------------------------- | ---------: | -------------------------------------------------------------------------------- |
| HON 2025-06-30 | Balanced 140.55, close 230.20      |    −63.8 % | −231 % (Balanced 70.28 per as-traded share; close 232.66 at the insider 1.0107×) |
| WDC 2025-02-21 | Residual Income 34.36, close 51.92 |    −51.1 % | −99.9 % (close 68.69 at the provider's 1.323)                                    |

In both cases, and on every other session before the adjustments above, the stored MOS overstates
the margin. A `Margin of Safety … is above` rule therefore fires where the as-traded numbers say it
should not. This investigation changes nothing in Margin of Safety: fixing it needs the same
prerequisite as the valuation ratios (see the decision).

## Alternatives considered

The comparison and the recommendation are in `docs/decisions/valuation-ratios-v1.md`. In short, no
formulation that multiplies or divides the stored close by a statement quantity avoids B1. That
includes `close ÷ EPS TTM`, basic instead of diluted shares, and the provider's own ratio or
market-capitalisation endpoints, which are ruled out regardless. Neither does any correction built
on the provider's split history alone, because that history is what is incomplete.

## Reproducing

The probes were one-off scripts and are not part of the repository. The queries below reproduce
every stored-data figure, against either database, with
`docker exec -i factorsage-postgres-1 psql -U intrinsic -d <database>`.

Latest revision of every quarterly income statement:

```sql
select distinct on (s.symbol, fs."fiscalYear", fs.period)
  s.symbol, fs."fiscalYear", fs.period, fs."fiscalDate", fs."availableFromDate",
  (fs.values->>'netIncome')::numeric                as net_income,
  (fs.values->>'epsDiluted')::numeric               as eps_diluted,
  (fs.values->>'weightedAverageShsOutDil')::numeric as diluted_shares
from "FinancialStatement" fs join "Security" s on s.id = fs."securityId"
where fs."statementType" = 'INCOME' and fs.period <> 'FY'
order by s.symbol, fs."fiscalYear", fs.period, fs."availableFromDate" desc, fs."observedAt" desc;
```

The adjustment carried by the stored close, measured by insider trades. Substitute the security and
the period. The figures above use these windows:

- MMM: 2019-01-01 → 2024-03-28 and 2024-04-01 → today;
- HON: 2010-01-01 → 2018-10-26, then the table's periods;
- IBM: 2010-01-01 → 2021-11-03;
- MRK: 2009-01-01 → 2021-06-02;
- AXP: 2003-01-01 → 2005-09-30 and 2005-10-03 → 2012-12-31;
- DIS: 2003-01-01 → 2007-06-12;
- AAPL: 2015-01-01 → 2020-08-28;
- JNJ from 2010, KO from 2013, and GOOGL: 2014-04-03 → 2022-07-15.

The medians barely move with the window. HON's trades from 2000 to 2018-10-26 give 1.0607
(n = 370), and IBM's from 2000 to 2021-11-03 give 1.0454 (n = 2,883).

```sql
select percentile_cont(0.5) within group (order by i.price / p.close) as median, count(*)
from "InsiderTransaction" i
join "DailyPrice" p on p."securityId" = i."securityId" and p.date = i."transactionDate"
join "Security" s on s.id = i."securityId"
where i."transactionCode" in ('S', 'P') and i.price > 0
  and s.symbol = 'MMM' and i."transactionDate" between '2019-01-01' and '2024-03-28';
```

Stored day-over-day moves beyond +80 % or −45 %:

```sql
with p as (
  select s.symbol, d.date, d.close,
         lag(d.close) over (partition by d."securityId" order by d.date) as previous
  from "DailyPrice" d join "Security" s on s.id = d."securityId")
select symbol, date, previous, close, round(close / previous, 4)
from p where previous is not null and (close / previous > 1.8 or close / previous < 0.55);
```

Provider reads, each taking `symbol` and the key:

- `stable/splits` gives the adjustment history.
- `stable/historical-price-eod/full` and `stable/historical-price-eod/non-split-adjusted`, with
  `from` and `to`, give the adjusted close and the one the split history implies.
- `stable/income-statement-as-reported` with `period=quarter` gives the as-filed share counts and
  EPS.

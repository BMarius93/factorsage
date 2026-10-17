# Listing evidence and pre-listing statements (V1)

Status: **proposed** in the pre-release remediation (2026-10-16). Fixes DATA-02 and implements the
owner's DATA-03 ruling, option C (`docs/audits/pre-release-audit-2026-10-16.md` §4.2 and §9.6).
Supersedes the listing clamp in `price-retention-warmup-horizon.md` ("A security listed inside the
retention window clamps to its listing date") and in `fundamentals-loader.md` ("All three are
clamped to a known IPO/listing date").

## The problem

FMP's profile IPO date was a hard lower bound on everything: the price and statement retention
windows, statement ingestion, the backtest frame and the product horizon all started at
`max(horizon, ipoDate)`. Two things were wrong with that.

- **The IPO date can be wrong.** `NEE` is dated 2014-06-19 though its stored bars start in 1992,
  and `HON` is dated 2001-02-21 though FMP serves 1,304 of its bars from 1996-01-02 to 2001-02-21. A
  wrong IPO date silently removed up to fifteen years of a thirty-year backtest. HON's early bars
  were never even requested.
- **Whether the clamp applied depended on hydration order.** The catalog carries no IPO date. The
  profile arrives inside the first hydration, but that hydration ran its fundamentals and derived
  rebuild with the identity read before the profile. A backtest worker kept that identity for its
  frames too (BT-04). So the same stored data produced different rows, and two runs of one
  snapshot could trade differently.

Separately, DATA-03 asked whether statements from before a listing may count once the stock lists.

## The rules

1. **The provider is asked for the whole retention window.** Prices are retained for 34 years and
   statements for 37, by the clock only, never clamped to the IPO date. A genuine IPO costs nothing
   for this. The first read is one request either way, the provider returns nothing before the
   listing, and coverage then records that the whole window was asked for. A wrong IPO date no
   longer removes real bars.
2. **Listing evidence is `min(ipoDate, first stored bar)`.** A traded bar is direct evidence of a
   listing. The provider's IPO date is evidence only where the bars do not contradict it. It is
   _contradicted_ when a stored bar falls in an earlier ISO week than the IPO date. A session or two
   apart is the same listing week: `CAVA`'s first stored session is 2023-06-15 and its IPO date
   2023-06-16. Without an IPO date there is no listing evidence, as before. The IPO date is always
   read from PostgreSQL, never from the identity a caller holds, so the first hydration, every
   rebuild and a backtest worker all apply the same evidence.
3. **Pre-listing statements (DATA-03, option C):** _"Only use pre-listing financial statements when
   there is reliable evidence of genuine public availability. Placeholder publication dates are not
   sufficient."_ A revision whose fiscal period ended before the listing evidence is read only when
   the provider holds a real filing date for it, meaning a filing date after the period end
   (`hasProviderFilingDate`). Its availability is then that filing plus a day, like any statement.
   A placeholder gets the statutory deadline that `statementPublicAvailabilityDate` assigns. That
   deadline stands for a filing obligation a company did not have before it listed, so such a
   revision is never read. This applies wherever statements feed a calculation: Fundamental
   Metrics, intrinsic values and valuation ratios (`statementsWithEvidencedAvailability`). Statements
   from the listing on are read exactly as before, including the AUD-03 statutory-deadline rule.
4. **No listing bound on frames or reads.** A security participates on the days its frame has rows
   for. The backtest projection and the product horizon are clock bounds only. Stock Details still
   reports `LISTING` for an IPO date the bars do not contradict, starting at the listing evidence,
   so a stored session never hides behind it. For a contradicted IPO date it falls back to the
   `HORIZON`/`PROVIDER` bound.
5. **First week.** A calculation's first week is a listing week, kept even when partial, only when
   the IPO date is on or after the first bar _and in its week_. A contradicted IPO date makes the
   first week a cut week, as for a history cut by the horizon.
6. A contradicted IPO date is logged as a provider anomaly on every rebuild, as
   `stock-data.price-basis` with outcome `LISTING_DATE_CONTRADICTED` at `warn`.

## Consequences

| Security                                                    | Before                                                                    | After                                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEE` (IPO date 2014, bars from 1992)                       | backtests start 2014-06-19; Stock Details from 2014; valuations from 2015 | trades from its first bar in the period; Stock Details over the whole horizon; statements from the first bar on read as listed. The audit measured DCF from 1995-03-21 (≈6,400 sessions change) |
| `HON` (IPO date 2001, FMP serves bars from 1996)            | history starts 2001-02-21                                                 | the 1996–2001 bars are requested once and stored; frames, technicals and valuations follow                                                                                                      |
| `PLD` (IPO date = first bar)                                | listing week dropped when built before the profile                        | listing week kept on every build                                                                                                                                                                |
| `V`                                                         | first DCF 2009-02-10 (only after-listing filings)                         | 2008-11-24: nine pre-listing revisions carry real filing dates (audit: 308 sessions differ)                                                                                                     |
| `GOOGL`, `CRM`, `MRNA`, `AMZN`, `GS`                        | —                                                                         | unchanged: every pre-listing revision is a placeholder                                                                                                                                          |
| every security with an IPO date inside the retention window | coverage starts at the IPO date                                           | **one** extra price request, once, for `[retention start, IPO date)`                                                                                                                            |

Behaviour that is visible beyond valuations:

- Stock Details' statement tables can show statements from before an IPO date. Ingestion no longer
  discards them, and the product's statement read is bounded by the horizon only. Which of them a
  valuation reads is rule 3's business.
- `evaluationHistoryStart`, where a Monitor reconstruction reads from, is the product horizon for
  every security. A recent IPO has no rows before its first bar, so nothing more is read.

## Deploying it

- **Production (pre-launch, still on r7):** ships with this release's r8 rebuild, so every security
  is rebuilt once with the new rules. No extra revision bump is needed. Each security whose
  coverage starts at an IPO date inside the retention window makes its one widening request on its
  next preparation, through the normal provider gate.
- **Environments already rebuilt at r8 under the old rules** (the development database, the QA
  matrix database) keep their stored derived rows until something rebuilds them. A re-provision
  rebuilds them, as does deleting a security's `DAILY_DERIVED_STATE` coverage, which makes the next
  hydration rebuild it from stored data.
- **Frozen datasets** (the QA matrix, the data-correctness audit) cannot make the widening request:
  their provider guard refuses it, and a case whose list holds such a security fails its preparation.
  The matrix database (as of 2026-10-15) needs **eight** approved provider requests, one each for
  `AMZN`, `CRM`, `GOOGL`, `GS`, `HON`, `MRNA`, `NVDA` and `V`, before the next sweep. `PLD`'s and
  `NEE`'s coverage already reaches the retention start.
- **Statements discarded by the old ingestion filter are not re-fetched.** A security whose
  pre-listing statements were dropped at ingestion keeps today's valuations until its statements
  are backfilled again. The rules apply in full to every security hydrated after the change, and to
  every stored statement already there (`NEE`'s and `HON`'s in the development database).

## Release note

> Historical valuations of companies listed within the last 37 years can change. A financial
> statement from before a company's listing now counts once the company lists, when its filing date
> shows it was public. Securities whose provider IPO date is later than their first traded bar are
> no longer cut at that date. Their backtests, charts and valuations now include the earlier
> history.

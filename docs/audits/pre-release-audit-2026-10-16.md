# FactorSage pre-release audit — 2026-10-16

- **Audited commit:** `main` @ `bebf3dc79143e43c44675051364b133803be345c` (merge of PR #107, the last of the nine
  Monitor EOD V2 PRs #99–#107).
- **Branch:** `test/pre-release-audit-qa-matrix`. It changes **test, fixture and QA-matrix tooling only**, plus
  this report and two development runbooks. No production business logic is modified; production defects found are
  reported below with proposed fixes, and the ones that could be pinned by a test are pinned by a **known-defect**
  test (`it.fails`) that stays green while the defect is open and turns red the moment it is fixed.
- **Evidence** lives outside the repository (git-ignored `.debug/qa-matrix/<execution id>/` per sweep, and the
  session scratch directory for the refresh and reproduction scripts); every number below names the artefact it
  came from.
- **Environment:** Apple M1, 8 GB RAM (swap in use throughout), Docker PostgreSQL 16 / Redis 7 (`noeviction`, no
  `maxmemory`), Node 22.23.2. The development database was **never written**: the matrix dataset was refreshed into
  a throwaway copy (`intrinsic_value_qa_source`) and provisioned from there.
- **Live provider use (owner-authorized, 2026-10-15):** 233 FMP requests in total — 74 to pin the venue holiday
  calendar, 117 to refresh the 35 matrix securities through the canonical loader (68 price, 35 split-list,
  12 statement, 2 profile), 40 (+≈2 calendar) to refresh the twenty ETFs through the market-data child. None during
  any sweep (proven at the network boundary, §3.3). No Stripe operation of any kind was performed.

---

## 1. Executive summary

### Verdict: **NOT READY** — five small code fixes, one Stripe sandbox run and two deploy decisions away from READY WITH RISKS

The criteria used:

| Verdict | Meaning |
| --- | --- |
| READY | no open P0/P1; P2s triaged and accepted |
| READY WITH RISKS | no open P0; every P1 fixed or explicitly accepted by the owner with a mitigation in place |
| NOT READY | an open P0, or an open P1 that silently produces a wrong financial result or wrong user-visible history |

FactorSage's core is in good shape, and this audit's evidence for that is unusually strong:

- **5,000 real backtests** through the product's own submission service and worker (§3), each checked against
  forty persisted-evidence invariants plus four new ETF invariants, with an independent ETF oracle re-deriving every
  ETF-gated trade from stored bars. See §3.5 for the exact counts.
- The strategy registry and the backend validator agree on **every** cell of the data-sourced Condition surface
  (20 ETFs + Stock's Sector × 3 level kinds × 21 metrics × 3 operators × 38 candidate Values: 150,822 documents), and
  every forged source and every ETF Trigger is refused.
- The ETF technical path agrees with an independently written oracle on **>200,000 values** across twelve seeded
  random histories (holiday weeks, halted Fridays, zero volume, an unanswerable calendar year).
- The data-correctness audit's independent oracles re-derived **92.9 million** stored and served values (technicals,
  Relative Volume, alternative data, intrinsic values, Fundamentals, 1,000 reference backtests). Every one of the
  134,674 disagreements traces to a security's listing date (DATA-02, DATA-03); everything else agrees. Backtests
  rehydrated from PostgreSQL after a Redis flush are identical to the warm runs (60 of 60 compared).
- No IDOR, tenancy leak or privilege escalation was found on any route family. Ownership predicates are re-applied
  inside the writing statements; entitlement limits are decided inside the writing transaction.

It is **not READY** because five defects produce wrong results a user sees as correct (four confirmed, one plausible):

1. **MON-01 (P1, confirmed by test).** A new Monitor's 90-day replay **fires again** when a member's List
   membership is ended and later restored — two ordinary List edits — **duplicating Signals and transitions**.
2. **ALT-01 (P1, confirmed by test).** An insider money window that has emptied reads `6.98e-12`, not `0`, so
   `Insider purchase value is above $0` — the natural "any purchase" rule, whose domain starts at 0 — is **TRUE on
   sessions with no purchase**, in backtests and Monitors alike.
3. **UI-01 (P1, confirmed in the real Builder).** The Strategy Builder's numeric Value field corrupts what a user types key by
   key: `0.75` becomes `75`, `-1.5` becomes `5`, `1.25` becomes `25`. A `Debt / Equity is below 0.75x` rule is
   silently saved as `below 75x`.
4. **DATA-02 (P1, confirmed by reproduction).** A security's stored history depends on whether its provider profile
   had been read when it was first built, and the provider's IPO date is then trusted as a hard lower bound. `NEE`
   (FMP says listed 2014-06-19; it has bars from 1992) is **silently left out of every backtest before 2014** — in the
   matrix's 30-year one-member-per-sector run it first trades in 2014, every other member in 1999 — while its stored
   valuations for 1992–2014 exist and would vanish at the next rebuild; `PLD`'s first weekly averages are missing.
5. **BILL-01 (P1, plausible; needs one Stripe sandbox run).** An immediate upgrade made while a downgrade is
   scheduled leaves the Stripe schedule attached, which can later **override the upgrade the user paid for** (or,
   if Stripe refuses the update, makes upgrading impossible with a "temporarily unavailable" message).

And three operational P1s must be handled before the deploy, not after:

6. **OPS-01.** `STOCK_CACHE_MAX_RESIDENT_STOCKS` defaults to **100**, below what one PRO user is entitled to run
   (two concurrent 100-symbol backtests), and the capacity document's sizing rule ignores backtests. Results stay
   correct; cost goes up by an order of magnitude (measured 4.38 M vs 267 k Redis commands per stock-EOD session at
   U=500).
7. **OPS-02.** This release bumps `DERIVED_STATE_REVISION` 7→8, and the stock EOD child decides "nothing to do" from
   the **price** tail only. Every Monitor therefore stalls until the next session's tail read — about 6.5 h for a
   weekday-morning deploy, Friday evening to Monday 16:30 over a weekend. Do not "fix" it with `data:resync`: that
   tool has no venue calendar and rewrites holiday weeks wrongly (MON-03).
8. **OPS-06 (confirmed by test and measurement).** A read that finds another process mid-hydration deletes that
   process's cache manifest, and the other process's backtest fails ("The backtest could not be completed"). The same
   r8 bump makes every cached stock stale, so **the deploy itself is a cold-cache event**: on a flushed matrix Redis,
   **7 of 40** concurrent backtests failed this way; submitted again, all seven completed, and all forty then matched
   the warm sweep exactly. The core of the fix is one guard in a Lua script.

Each of the five code fixes (MON-01, ALT-01, UI-01, DATA-02's identity part, OPS-06) is small and local (proposed in
§4); with them merged, BILL-01 settled in the sandbox and OPS-01/OPS-02 handled by configuration and deploy timing,
the verdict becomes **READY WITH RISKS**, the remaining risks being the P2s of §4 (login CSRF via form posts,
duplicate Checkout sessions, the Monitor's ETF-load-failure path, weekly values that depend on the venue schedule
being reachable, and DATA-03 — historical valuations of companies listed inside the horizon change at this deploy's
rebuild, pending an owner ruling on pre-listing filings).

### What changed in the test estate

| | Before (main @ bebf3dc7) | After (this branch) |
| --- | --- | --- |
| QA-matrix dimensions | 3 (S, A, F) = 3,000 cases | **5** (+E static ETF, +T Stock's Sector) = **5,000 cases** |
| Matrix invariants per run | 40 | 40, **+4 for ETF/sector runs** (41–44, independent oracle) |
| Matrix gate conditions | 15 | **18** (+`PROVIDER_EGRESS`, `METAMORPHIC_DIFFERENCE`, `BEHAVIOUR_COVERAGE`) |
| Provider accounting | one log line (blind to the venue calendar and alt-data loader) | **network boundary**: loopback guard replays a pinned calendar, refuses and journals everything else |
| Preflight | 18 checks, core dimension only from the CLI | **19** (+`etf-sources`), any dimension (`--strategies`) |
| Securities / Lists | 33 / 10 | **35 / 11** (`NEE`, `PLD`, `L11` = one member per FMP sector) |
| Registry-driven ETF validation | per-kind examples | **exhaustive** cell-by-cell agreement test |
| Known-defect pins | — | 11 (`MON-01`, `MON-02`, `OPS-02`, `OPS-06`, `SEC-01`, `ALT-01` ×2, `PRED-01`, `UI-01` ×2, `UI-03`) |

---

## 2. Scope, baseline and method

### 2.1 Baseline (read-only, before any change)

- `main` @ `bebf3dc7`, clean except the expected `apps/web/next-env.d.ts` dev-server drift (left untouched, never
  committed).
- Development database `intrinsic_value`: all 44 migrations applied (including the four EOD V2 ones). Its matrix
  dataset was **stale and internally inconsistent**: price coverage ended 2026-10-02 for XOM and MRNA, 10-12 for
  ADBE, 10-14 for the rest; derived state was at revision 7 while `main` requires 8; the twenty ETFs ended 10-13.
  The matrix could not have passed its own preflight.
- Matrix database `intrinsic_value_matrix`: 37 migrations (2026-10-02 schema), an old copy.
- Test database `intrinsic_value_test`: 44 migrations.
- Redis: `noeviction`, logical databases 0, 6 and 7 in use by other work (left untouched); the matrix uses 3, the
  refresh used 9 (empty before, flushed after).

### 2.2 Method

1. **Six parallel read-only code audits** (security/billing, Monitor EOD V2, Redis/PostgreSQL/capacity, financial
   correctness, extensibility, frontend/E2E) and a seventh on engine accounting and replay. Their findings were
   triaged; every P0/P1 claim and every finding this report rests a recommendation on was re-checked by hand, and
   where possible **reproduced**: by a PostgreSQL integration test (MON-01, MON-02), a PostgreSQL + Redis integration
   test (OPS-02, OPS-06), a unit test against the built package (ALT-01, PRED-01), a headless-Chromium reproduction
   of the exact control logic with the app's React version (UI-01), a re-materialization of the stored inputs through
   the production materializer (DATA-02, DATA-03), or a measurement in the matrix (QA-03, DATA-01, OPS-06).
2. **Matrix extension** (§3): two new strategy dimensions, the infrastructure they needed, and the defects in the
   existing infrastructure that the extension uncovered.
3. **Execution** of all five dimensions (5,000 runs), the unit/integration gate, Redis integration, the hermetic E2E
   suite and the data-correctness audit (§3.5, §8).

Every finding below carries one of: **CONFIRMED (test)** — reproduced by an automated check committed on this
branch; **CONFIRMED (repro)** — reproduced by a script outside the repo, described; **CONFIRMED (code)** — the exact
path traced end to end; **PLAUSIBLE** — the path exists, the outcome depends on runtime behaviour not yet observed,
with the test that would settle it.

---

## 3. Test coverage report

### 3.1 The two new dimensions

**`E01` … `E10` — static ETF Conditions** and **`T01` … `T10` — Stock's Sector Conditions**, each 10 × 10 × 10 =
1,000 cases, defined in `packages/testing/src/qa-matrix/etf-strategies.ts` and documented in
`docs/development/qa-matrix-fixtures.md`. Between them they read all twenty ETFs (the eleven sector funds through
`L11`), Price, daily and weekly SMA/EMA, every RSI and RVOL period, `is close to`, every level kind, a two-rule FINAL
EXIT, Stock + ETF, ETF + ETF, ETF + Stock's Sector and Stock's Sector + Fundamentals / Valuation, and the funds that
list inside the horizon (`HYG` 2007, `RSP` 2003, `XLRE` 2015, `XLC` 2018). ETF Triggers stay absent — the product
refuses them, and `strategies.etf-registry-exhaustive.test.ts` proves the refusal for every cell.

**Why the sector dimension needed new data.** The thirty-three matrix securities span nine of FMP's eleven sectors;
no Stock's Sector rule over them could ever read `XLU` or `XLRE`. With the owner's authorization, `NEE` (Utilities)
and `PLD` (Real Estate) were hydrated into the source copy and added as sector-only securities, kept out of the list
`L08` is derived from so no baseline moves. `L11` lists one member per sector; only the T dimension runs it, in place
of `L10`.

**Proving the dimensions exercised what they claim.** A green zero-trade run proves nothing about an ETF rule (an
unreadable fund makes every rule NOT_EVALUABLE and the run still completes). So:

- **Invariant 41** re-derives every ETF Condition of every executed, signal-driven trade from the fund's stored bars
  through the independent oracle; **42–44** check pins, the frozen sector mapping (against a *restated* mapping, so
  registry drift is caught) and the persisted per-fund diagnostics.
- **Three metamorphic pairs** must persist identical results case by case: `E08` = `E07` + an always-TRUE SPY
  Condition in every level; `E10` = `E09` + a level gated by a never-TRUE one; `T10` (Stock's Sector) = `T09` (XLK by
  name) on `L01` (AAPL). 210 comparisons per complete pair of sweeps.
- **Behaviour coverage** is measured from per-session oracle tallies: every sourced Condition both TRUE and FALSE
  somewhere, the probes' premises (never FALSE / never TRUE) measured rather than assumed, every younger fund
  NOT_EVALUABLE before it listed, every fixture trading through an ETF-gated level (and the never-TRUE level never),
  all eleven sector funds read.

### 3.2 The independent ETF oracle

`apps/api/src/qa-matrix/matrix-etf-oracle.ts` re-implements SMA, EMA (first-window SMA seed), Wilder RSI (flat window
= 50), RVOL (baseline strictly before the session, zero baseline absent) and the week-completion rule (last
*scheduled* session; Friday when the year is unanswerable) from the documented methodology, importing none of the
stock-data kernels. `matrix-etf-oracle.test.ts` holds it to the production `buildBenchmarkTechnicalContext` over
twelve seeded random histories: identical session sets, identical NaN patterns, and **>200,000 values equal within
1e-9**, including holiday-shortened weeks, halted Fridays, zero-volume sessions, a mid-week listing and an
unanswerable year. It also pins the 2001-09-10 case (FIN-07).

Because the ETF context reuses `buildDailyDerivedState`, this is also the evidence that a stock and an ETF with
identical OHLCV get identical technicals (raw doubles for ETFs vs. 8-decimal storage for stocks being the one
documented difference).

### 3.3 Infrastructure defects found while extending the matrix

These are defects in **test tooling**, fixed on this branch (no production code touched):

| ID | Defect | Fix on this branch |
| --- | --- | --- |
| QA-01 | The matrix clock was the **UTC date** while every product boundary (loader `today()`, coverage, the thirty-year submission horizon) is the **EOD cutoff** since PR #99. For most of every UTC day the preflight demanded coverage through a session the loader cannot have stored, and refused a fresh dataset. | `currentAsOfDate()` = `eodCutoffDate(now, publicationDelay)`; a dataset refreshed after one close is valid for 24 h. |
| QA-02 | Provisioning did not copy `BenchmarkSeriesPriceBasis` / `BenchmarkPriceBasisEvent` (added 2026-10-11): matrix ETF runs would record generation 0 whatever the source said. | Both copied. |
| QA-03 | **The "zero provider requests" ledger was blind.** It counts one log line; the venue holiday schedule (`CachedTradingCalendar`, consulted for week completion since PR #107) and the alternative-data loader never write it, and the worker inherited the developer's real `FMP_API_KEY`. **Measured:** a 4-case sector smoke run made **87** schedule requests the old ledger reported as **0** — they would have reached FMP. | `MatrixProviderGuard`: workers get `FMP_BASE_URL` = a loopback server and a placeholder key; it replays a **pinned** venue calendar (captured once by `pnpm qa:matrix:capture-calendar`) byte for byte and refuses/journals everything else; any refusal fails the gate (`PROVIDER_EGRESS`). |
| QA-04 | `pnpm qa:matrix:preflight` could only check the core dimension, so the ETF data an E/T sweep reads was never preflighted. | `--strategies`, and a new `etf-sources` check (floor-anchored coverage, a completed tail read, bars through the last simulated session, every member's sector resolving). |
| QA-06 | The archive verifier (invariants 36–38) read a sourced Condition's **Value** from the stock's own `series:` column, which a sourced frame does not carry, so every ETF/Stock's Sector BUY re-derived as NOT_EVALUABLE. Latent since PR #98 (no archived fixture read an ETF until this audit); it made the Stock's Sector sweep's six golden archives fail. | `valueSeries` resolves through the canonical `valueOperand(value, source)`; re-verified offline, all six archives pass (233 BUYs re-derived TRUE); unit cases for both source kinds. |
| QA-07 | **The sweep's warm-up hides cold-cache concurrency.** Every sweep hydrates each security once, sequentially, before submitting cases, so concurrent first hydrations — the state right after this release's deploy, a Redis restart or an LRU eviction — are never exercised. The runbook knew cold sweeps fail ("generation changed") and treated it as a harness race to design around; it is a product defect (OPS-06), and the warm-up kept it out of 5,000 green runs. | The runbook now says so and how to look at it (`docs/development/qa-matrix-runner.md`, "The warm-up"); this audit ran the cold check by hand (`FLUSHDB` of the matrix index, then `--no-warmup`, §3.5). Proposal: a `--cold` stage in the release sweep. |
| QA-05 | **Not fixable in tooling:** the valuation split-list freshness is a hard-coded 24 h (`STOCK_SPLIT_LIST_FRESHNESS_MS`, `packages/stock-data/src/service.ts:549`), so any matrix strategy reading a valuation ratio (`T08`) re-asks the provider once the capture is a day old. The guard now makes that a visible `PROVIDER_EGRESS` failure instead of silent live traffic. | Reported; proposal: honour a `STOCK_SPLIT_LIST_FRESHNESS_MS` setting like the other freshness windows the matrix pins. |

### 3.4 Other new tests

| Test | What it proves |
| --- | --- |
| `packages/contracts/src/strategies.etf-registry-exhaustive.test.ts` | Builder registry and validator agree on every data-sourced Condition cell; every sourced Trigger, forged source (index series, tickers, case variants, extra keys, unknown kinds) and source on a non-technical kind is refused. |
| `apps/api/src/qa-matrix/matrix-etf-oracle.test.ts` | §3.2. |
| `apps/api/src/qa-matrix/matrix-etf-invariants.test.ts` | Each of invariants 41–44 fails on exactly the fault it exists for (FALSE day, pre-warm-up day, no-bar day, FINAL EXIT OR semantics, liquidation exempt, wrong fund, catalog drift, non-READY fund). |
| `apps/api/src/qa-matrix/matrix-provider-guard.test.ts` | Byte-exact replay through the real `FmpClient`; non-retryable refusals counted once; recorded refusals replayed as given; keys never stored. |
| `apps/api/src/qa-matrix/qa-matrix-source-fixtures.test.ts` | E/T fixtures pass the real contract, claim exactly their structural behaviours, read all twenty ETFs, keep L08 unchanged, and the metamorphic premises hold structurally; the matrix clock is the EOD cutoff. |
| `apps/api/src/qa-matrix/matrix-gate.test.ts` (+3) | Each new gate condition turns the verdict red on its own. |
| `apps/worker/src/monitor/monitor-evaluation.integration.test.ts` (+2, `it.fails`) | MON-01 and MON-02 on real PostgreSQL. |
| `packages/strategy/src/alternative-data.test.ts` (+2, `it.fails`) | ALT-01. |
| `packages/strategy/src/predicates.test.ts` (+1, `it.fails`) | PRED-01. |
| `apps/worker/src/stock-eod/stock-eod.integration.test.ts` (+1, `it.fails`) | OPS-02 on PostgreSQL and Redis. |
| `apps/api/src/auth/auth.integration.test.ts` (+1, `it.fails`) | SEC-01: a form-encoded login is accepted. |
| `apps/web/e2e/strategies/value-entry.user.spec.ts` (+2, `test.fail`) | UI-01 in the real Builder, typing with `pressSequentially`. |
| `apps/web/e2e/strategies/run-backtest-guard.user.spec.ts` (+1, `test.fail`) | UI-03: the header's Run backtest leaves a dirty Builder without asking. |
| `packages/stock-data/src/redis.integration.test.ts` (+1, `it.fails`) | OPS-06 on real PostgreSQL and Redis: process A reads a READY stock while process B is widening it; B fails with "Stock cache hydration generation changed". Mutation-checked: with the invalidation limited to READY manifests the test turns red (both reads succeed). |

### 3.5 Execution results

All five dimensions were swept on the provisioned matrix (clock **2026-10-15**, the EOD cutoff; execution calendar
8,486 SPY sessions 1993-01-29 → 2026-10-15; 35 securities; derived state r8), sequentially, at concurrency 3, each
with its own preflight GREEN (19 checks), warm-up, golden determinism rerun and forensic archives. Raw evidence:
`.debug/qa-matrix/<execution id>/` (`summary.json`, `cases.ndjson`, `report.md`, `worker.log`, `archives/`).

| Dimension | Execution id | Completed | Invariant failures | Undecided | Provider requests (log / refused at the guard) | Pinned calendar replays | Golden reruns identical | Metamorphic | Behaviour coverage | Archives verified | Wall | Throughput | Trades | Zero-trade cases |
| --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| T — Stock's Sector | `…-213752` | **996 / 1,000** | 0 | **4** (FIN-12) | 0 / 0 | 218 | 6 / 6 | **10 / 10** | **43 / 43** | 6 / 6 † | 2,315 s | 25.9 /min | 447,552 | 33 |
| E — static ETF | `…-221838` | **1,000 / 1,000** | 0 | 0 | 0 / 0 | 238 | 6 / 6 | **200 / 200** | **43 / 43** | 6 / 6 † | 1,350 s | 44.5 /min | 190,910 | 36 |
| A — RVOL / alternative data | `…-224440` | 1,000 / 1,000 | 0 | 0 | 0 / 0 | 0 | 6 / 6 | — | — | 6 / 6 | 1,558 s | 38.5 /min | 360,489 | 114 |
| F — Fundamentals | `…-231315` | 1,000 / 1,000 | 0 | 0 | 0 / 0 | 0 | 6 / 6 | — | — | 6 / 6 | 1,308 s | 45.9 /min | 63,507 | 185 |
| S — core | `…-233725` | 1,000 / 1,000 | 0 | 0 | 0 / 0 | 0 | 6 / 6 | — | — | **1,000 / 1,000** (`--archive-all`) | 1,475 s | 40.7 /min | 185,007 | 104 |
| **Total** | | **4,996 / 5,000** | **0** | **4** | **0 / 0** | 456 | 30 / 30 | 210 / 210 | 86 / 86 | 1,024 | 2 h 13 min | | **1,247,465** | 472 |

18,107,000 daily equity rows were validated (3,621,400 per dimension). No run failed, timed out or errored; no
runner error occurred.

**Gate verdicts as executed.** A, F and S: **GREEN**. E: NOT GREEN on `ARCHIVE_INVARIANT_FAILED` only, and T:
NOT GREEN on `ARCHIVE_INVARIANT_FAILED` plus the four undecided cases (which also count as "not completed" in
`COUNTS_MISMATCH`). † Both archive failures are QA-06, a defect in the archive verifier that the E and T sweeps were
the first ever to exercise; the fix landed after those two runners had loaded the old verifier. Re-verifying the
twelve archives offline with the fix: **all pass** — 694 ETF/sector-gated BUYs re-derived TRUE from the frame columns
the day loop consumed (36), every year boundary's `t − 1` row correct (37), every BUY inside its window (38).

**The four undecided cases** (`T09-L08-C01`, `T09-L08-C08`, `T10-L08-C01`, `T10-L08-C08`) are the oracle declining to
judge an exact decimal tie: XLK's close on 2012-12-20 is 14.69 and so is its exact 200-day mean, and these runs held
XLK-sector positions whose FINAL EXIT reads `Price is below SMA 200D`. Production computed the mean as
14.690000000000033 and exited — in `T09-L08-C01` ten FINAL EXITs, every holding, on that one session; mathematically the comparison is FALSE (FIN-12, §4.2). The gate is right to stay red
on them; they are not counted as passes anywhere in this report.

**What the new checks proved.**

- Every ETF- and sector-gated trade of both dimensions — 562,438 BUY, SELL and FINAL EXIT decisions at levels that
  read a fund (441,955 sector, 120,483 static ETF; `gatedTradesByStrategy` in the two summaries) — passed invariant
  41: each sourced Condition of the level re-derived TRUE from the fund's stored bars through the independent oracle
  on the trade's session (for FINAL EXIT, at least one Exit Rule whose sourced Conditions all hold, or one with none),
  except the four ties above. For the archived golden cases, invariant 36 additionally re-derives every BUY's whole
  Signal — stock and sourced Conditions alike — from the frame the day loop consumed.
- The always-TRUE premise held on all 362,140 sessions it was evaluated (never FALSE); the never-TRUE level was never
  TRUE and **never traded**; `E08` reproduced `E07` and `E10` reproduced `E09` column for column on every List and
  configuration; `T10` reproduced `T09` on `L01` in all ten configurations.
- The younger funds were genuinely unavailable before they listed — `HYG` 255,240, `RSP` 50,820, `XLRE` 287,040
  (E) / 350,625 (T), `XLC` 2,305,400 NOT_EVALUABLE session reads — and no gated trade happened in those sessions.
- Stock's Sector read all eleven sector funds, including `XLU` (NEE) and `XLRE` (PLD) that no matrix run could read
  before this audit.
- The provider guard refused **nothing** across 5,000 runs, and served 456 pinned venue-calendar answers to the E/T
  workers — requests the previous runner would have sent to FMP while reporting zero (QA-03).

**Behaviour the matrix still does not reach** (stated rather than implied): a security with no or an unsupported
sector (covered by contracts and worker unit tests, and invariant 43's refusal logic, not by real data — every
matrix member has one of FMP's eleven); an ETF series with a gap in the middle of its history (none exists in the
real data); Monitor behaviour (the matrix is backtest-only — Monitor coverage is the PostgreSQL suites of §3.4 and §8);
valuation-ratio dimensions beyond `T08` (QA-05's 24-hour split-list freshness limits them).

**Cold-cache rehydration (Redis flushed, no warm-up).** The matrix Redis index was flushed and 40 core cases
(S01–S10 × L03-C05, L05-C07, L08-C10, L10-C01; `…-002124`) were run at concurrency 3 with `--no-warmup`, so every
security was first hydrated by a backtest while others were reading it. **7 of 40 failed** in PREPARING_DATA with
"Stock cache hydration generation changed" (OPS-06), all among the first 14 submitted; submitted again on the now-warm
cache (`…-002617`) all seven completed. Compared column for column with the warm core sweep (`compareForDeterminism`
over trades, equity and summaries), **all 40 are identical** (30,044 trades). The same check on
20 Stock's Sector cases (T01–T10 × L11-C05, L03-C10), cold (`…-002737`) then warm (`…-002918`): 20/20 completed,
gate GREEN both times, **identical** (9,600 trades). Rehydration from PostgreSQL is deterministic; the failure mode
is availability, not values.

**Data-correctness audit (Stage D).** `apps/api/src/data-correctness-audit/run-audit.ts --sweep=…-233725` (the
1,000 archived core cases), sections technicals, relative-volume, alternative-data, intrinsic, fundamentals,
strategies, lists, backtests, look-ahead, backtest API and signals; 14 minutes on the matrix database. Not run:
`source` (live FMP), `stock-details` and `ui` (the full browser stack) — the generated summary carries those rows over
from the committed 2026-10-11 run, and they are **not** counted here. Output preserved in
`.debug/data-correctness-audit-2026-10-16/`; the committed `artifacts/` were restored.

| Section | Comparisons | Failed | Where |
| --- | ---: | ---: | --- |
| technicals | 4,237,091 | 16,420 | `NEE` 7,428, `PLD` 8,992 only — DATA-02 |
| relative-volume | 747,888 | 0 | |
| alternative-data | 5,750,932 | 0 | |
| intrinsic | 2,609,463 | 27,700 | the seven securities listed inside the horizon only (`V` 7,437, `HON` 7,281, `GOOGL` 6,280, `CRM` 4,451, `MRNA` 1,930, `AMZN` 207, `GS` 114) — DATA-03 |
| fundamentals (+ 8 seeded synthetic histories, 0 mismatches) | 5,126,565 | 74,832 | `NEE` only — DATA-02 |
| fundamental-frame-provenance / fundamental-scale | 11,295,730 | 0 | |
| strategies / lists and buy windows | 296,639 | 0 | |
| backtests (reference backtester, 1,000 cases) | 57,539,700 | 0 | |
| frame-provenance | 3,514,080 | 15,722 | intrinsic and Margin-of-Safety columns of the DATA-03 securities |
| backtest API / signals and dashboard / look-ahead | 1,764,244 | 0 | the filing-date check has teeth: 8 of 100 S09 cases trade differently without it |
| **Total** | **92,882,332** | **134,674** | **two root causes, both about the listing date; zero elsewhere** |

The committed 2026-10-11 run had none of these failures because the rows it audited predated two things: the
statement-range fix of 2026-09-29 (`a399d137`), and `NEE`/`PLD`, which entered the matrix in this audit. The refresh
rebuilt every security at r8 — exactly what this release's deploy will do in production.


---

## 4. Findings register

Severity: **P0** exploitable now / data loss / wrong money shown as correct and likely; **P1** serious correctness,
security or reliability defect likely in production; **P2** real defect with limited impact or a workaround; **P3**
minor or maintainability. "Blocks" = blocks release on its own.

### 4.1 P1 — release-relevant

#### MON-01 · P1 · Monitor · CONFIRMED (test) · **blocks release**

**A new Monitor's 90-day replay fires again when a member's membership ends and is restored, duplicating Signals and
transitions.**

- **Code.** The replay predicate is "no checkpoint, no state, listed before the window was fixed"
  (`apps/worker/src/monitor/monitor-evaluation.ts:613–627`). Ending an ongoing membership resolves the member
  administratively (`MEMBERSHIP_CHANGED`, `apps/worker/src/monitor/monitor-repository.ts:477–560`) and
  `pruneCheckpoints` deletes the checkpoint of every member that is listed but not current
  (`monitor-repository.ts:663–688`, called from `monitor-evaluation.ts:418–434`). The window is fixed once and never
  cleared (`monitor-evaluation.ts:873–894`), every API-created Monitor and every bootstrapped built-in asks for it
  (`apps/api/src/monitors/monitors.service.ts:322`, `builtins/builtin-bootstrap.ts:318`), and editing a membership
  updates the List item in place, so `listedAt` never moves (`apps/api/src/lists/stock-lists.service.ts:655–700`).
  Restoring the membership therefore re-satisfies the predicate.
- **Reproduction.** `apps/worker/src/monitor/monitor-evaluation.integration.test.ts`, "KNOWN DEFECT MON-01"
  (PostgreSQL): replay, bound the membership, pass, restore FULL, pass. Observed: the third pass reports
  `membersReplayed = 1`; Signals go from 2 to **4** (the 2026-03-02 and 2026-09-15 activations each twice) and the
  window's three transitions are inserted a second time. With sessions after `watchingSince` the duplicates are
  `OBSERVED` and appear in the Dashboard activity feed; sessions when the security was not a member are also decided.
- **Impact.** Wrong, duplicated Signal history from two ordinary edits (one for an administrator on a SYSTEM List);
  violates AGENTS invariant 15 and `monitor-eod-v2.md` §5.1. `MonitorSignal` has no unique key on
  (monitor, security, level, observation date) to stop it.
- **Fix.** Prune checkpoints only for members no longer *listed* (pass the listed ids); re-entry then takes the §4
  path (`resetMembership`, reconstruct at the newest session). Also make the replay one-shot: mark it consumed once the
  members current at fixing time have checkpoints, or require that the member has no transition for this Monitor.

#### ALT-01 · P1 · Strategy evaluation (alternative data) · CONFIRMED (test) · **blocks release**

**An emptied insider money window reads a positive residue, so `purchase value is above $0` fires with no purchase.**

- **Code.** `buildAlternativeDataColumn` keeps one float running total, adding each disclosure's amount as it enters
  the window and subtracting it as it leaves, never resetting it (`packages/strategy/src/alternative-data.ts:232–258`,
  written to the column at `:301–303`). Amounts are `Decimal(24,4)` money, not dyadic.
- **Reproduction.** `packages/strategy/src/alternative-data.test.ts`, "KNOWN DEFECT ALT-01": amounts 52,341.25,
  1,817.33, 99,999.99 and 12.07 over a two-session lookback leave **6.98e-12** on the first session whose window holds
  no disclosure (`EVENT_COUNT` is 0 there), and `IS_ABOVE 0` evaluates TRUE.
- **Why reachable.** The MONEY domain's minimum is 0 and a new MONEY row defaults to 0
  (`packages/contracts/src/strategies.ts:873`, `:1141–1145`), so "value above $0" is the natural "any purchase" rule.
  The earlier alternative-data audit saw a ~1e-6 residue on real MRNA data and accepted it within a tolerance
  (`apps/api/src/data-correctness-audit/alternative-data/run-alternative-data-audit.ts:835–855`); the property test
  uses integer amounts, which hides it.
- **Impact.** Spurious BUY/SELL/FINAL EXIT on every empty-window session after the first non-dyadic disclosure leaves.
  Backtest and Monitor can disagree on the same session, because the residue depends on where the frame starts.
- **Fix.** Accumulate exactly (integer ten-thousandths, `Math.round(amount × 1e4)`, divide on read) — at minimum reset
  to exactly 0 when the window's event count is 0. Re-run the alternative-data audit section without its tolerance.

#### UI-01 · P1 · Web (Strategy Builder) · CONFIRMED (E2E) · **blocks release**

**Typing a decimal or negative Value key by key silently stores a different number.**

- **Code.** `apps/web/src/features/strategies/components/ValueControl.tsx:126` renders `value={String(value.value)}`
  and `:149–156` maps `""` to `NaN`. A number input reports a partial entry (`-`, `0.`) as `""`; the state becomes
  `NaN`, the prop `"NaN"`, React writes it back (its numeric coercion is defeated by the string prop), and the browser
  sanitizes it to empty — erasing what the user typed.
- **Reproduction.** The exact control logic, rendered with the app's React 19.2.3 in headless Chromium (Playwright
  1.62.1) and typed with `pressSequentially`: `0.75` → **75**, `-1.5` → **5**, `1.25` → **25**, `-10` → **10**, both in
  the field and in state. Then in the real Builder on the hermetic stack (`e2e/strategies/value-entry.user.spec.ts`,
  typing with `pressSequentially`): the field reads **`75`** after `0.75` and **`5`** after `-1.5`. Existing tests
  miss it because E2E uses `fill()` and unit tests use jsdom.
- **Impact.** `Debt / Equity is below 0.75x` is saved as `below 75x`; any negative threshold (Net Debt / EBITDA,
  Margin of Safety, growth) loses its sign; RVOL `1.5x` becomes `5x`. Silent, and the result is a different strategy.
- **Fix.** Keep the raw string in local state (as `apps/web/src/features/backtests/utils/submission.ts:21–24` already
  does) and parse it on change/blur; add a Playwright case that types with `pressSequentially`.

#### BILL-01 · P1 · Billing · PLAUSIBLE · **blocks release until disproved or fixed**

**An immediate plan change made while a downgrade is scheduled ignores the attached Stripe schedule.**

- **Code.** `changePlan`'s IMMEDIATE branch (`apps/api/src/billing/billing.service.ts:330–343`) calls
  `updateSubscriptionPriceImmediately` (`stripe.gateway.ts:240–255`, a plain `subscriptions.update`) without looking
  at the mirror's `stripeScheduleId` / pending price; the scheduled path does rewrite an existing schedule
  (`stripe.gateway.ts:288–342`); reconciliation releases a schedule only when no change is pending
  (`billing-reconciliation.service.ts:436–439`); the web offers the immediate action while a change is pending
  (`apps/web/src/features/billing/utils/plan-actions.ts:159–181`). The test fake already models the schedule
  surviving (`stripe-gateway.test-helper.ts:371–388`).
- **Scenario.** PRO_MONTHLY → STARTER_MONTHLY (scheduled at period end), then PRO_YEARLY the same month (cadence
  lengthened ⇒ immediate, prorated invoice paid). Either Stripe applies the schedule's phase 2 at the old boundary and
  the user drops to STARTER after paying for a PRO year, or Stripe refuses the update and the user sees "Billing is
  temporarily unavailable" with no way to upgrade until the downgrade applies. Also: a pending downgrade cannot be
  reverted (asking for the current price is refused as `UNCHANGED`, `billing.service.ts:271–277`).
- **To settle.** One Stripe **sandbox** run with a Test Clock (`pnpm qa:billing:*` tooling): change to
  STARTER_MONTHLY, then PRO_YEARLY; inspect `subscription.schedule` and its phases; advance past the old period end.
  Not run in this audit (no Stripe operation was authorized).
- **Fix.** In the IMMEDIATE branch, release the schedule (or rewrite it to one open-ended phase at the target) before
  the update, then reconcile; add a "keep my current plan" action that releases it.

#### OPS-01 · P1 · Capacity / configuration · CONFIRMED (code + measured) · **blocks release as configuration**

**The default stock cache residency is below what one PRO user may run, and the documented sizing rule ignores
backtests.**

- **Code.** `STOCK_CACHE_MAX_RESIDENT_STOCKS` defaults to 100 (`packages/config/src/index.ts:1136–1140`); the LRU
  evicts by count (`packages/stock-data/src/cache.ts:822–847`); the backtest year loop reads every security of the run
  each window (`apps/worker/src/backtest/backtest-processor.ts:1193–1199`); a miss re-materializes the security from
  the window's warm-up start to today (`service.ts:1958–2006`, `:3299–3312`). PRO allows 100 symbols per backtest and
  two concurrent runs (`packages/contracts/src/entitlements.ts:288–295`); SYSTEM/admin Lists reach 200; the stock EOD
  child admits every monitored security into the same LRU each session (`apps/worker/src/stock-eod/refresh-run.ts:264`).
  PC's rule is "R ≥ monitored universe" only (`ai/architecture/production-capacity.md`, Recommended limits).
- **Impact.** Results stay correct (every miss is repaired from PostgreSQL); cost does not: MEASURED 2.4× wall and
  16× Redis commands for the stock EOD child at U=500/R=100; DERIVED up to ~3,000 re-materializations, +12 min and
  ~6 GB of Redis writes for one thrashing 30-year, 100-security run, on the Redis the rate limiter shares.
- **Fix.** Before launch: set R ≥ monitored U + Σ securities of concurrent backtests + the API working set, and
  `maxmemory` to match (OPS-03). Then the code changes of §6.3 items 3–4.

#### OPS-02 · P1 · Stock EOD / Monitor · CONFIRMED (test) · **blocks this release's deploy unless mitigated**

**The stock EOD child never repairs a derived-state gap while the price tail is current — and this release creates
that gap for every security.**

- **Code.** `prepareOne` returns READY when `historyLoaded && decision.action === "SKIP"`, a decision about price
  freshness only (`apps/worker/src/stock-eod/refresh-run.ts:246–262`). The Monitor requires `derivedThrough` and holds
  members without it in `membersAwaitingData` (`apps/worker/src/monitor/monitor-evaluation.ts:531–545`). The r8 bump
  (`packages/stock-data/src/derived-state.ts:91`) makes every r7 row read as absent.
- **Reproduction.** `apps/worker/src/stock-eod/stock-eod.integration.test.ts`, "KNOWN DEFECT OPS-02" (PostgreSQL +
  Redis): prepare a security to READY (`derivedThrough` = the session), delete only its derived rows, coverage and
  state — what the revision bump leaves — and run the child again: it reports READY and `derivedThrough` stays
  `undefined`.
- **Impact.** Deployed after a session's tail reads, every Monitor stalls until the next session's tail read
  (≈ 6.5 h for a weekday-morning deploy; Friday evening → Monday 16:30) while the logs say READY. The same happens to
  one security after any crash between the price save and the derived rebuild (`service.ts:2826–2833`). No wrong
  Signals: the missed sessions are caught up in order afterwards.
- **Fix.** Skip only when `derivedThrough >= latestVerifiedBar`; otherwise call `refreshStockTail` (the rebuild needs
  no provider read). Mitigation without the fix: deploy shortly before the New York close on a weekday. **Do not** run
  `data:resync` to pre-build r8 (MON-03).

#### DATA-02 · P1 · Stock data (listing date) · CONFIRMED (repro + code) · **blocks release**

**A security's stored history depends on whether its profile had been read when it was first built, and a wrong
provider IPO date silently removes years from backtests.**

- **Code.** The catalog sync carries no IPO date; the profile arrives lazily inside the first hydration
  (`packages/stock-data/src/service.ts:1658–1689`). `hydrateWithinLease` uses the enriched identity only to publish
  the cache (`:1721`, `:1918`): the fundamentals hydration (`:1860`) and the derived rebuild (`:1898`) run with the
  pre-profile `security`. Every later rebuild uses the stored IPO date, which then decides three things: the
  statement revisions read (`fiscalDate ≥ max(horizon, ipoDate)`, `horizonTarget` / `fundamentalsTarget`
  `:3417–3449`), whether the first week is a listing week or a horizon cut (`weeklyHistoryContext` `:3460–3468`), and
  where a backtest frame may start (`projectionRange(…, "BACKTEST")` `:3495–3504`). Nothing compares the provider's
  IPO date with the stored bars.
- **Evidence.**
  - `NEE`: FMP's profile says IPO 2014-06-19; the stored bars start 1992-10-15 (NextEra traded as FPL Group). In
    `T01-L11-C01` (single-case run `…-000847`) every other member first trades in 1999 and `NEE` first on
    **2014-06-19**: fifteen years of a 30-year backtest without it, with no notice, although its bars, technicals and
    valuations for those years are stored. Those stored rows were built before the profile, i.e. without the clamp;
    the data-correctness audit, applying the product's own rule with the stored IPO date, disagrees on **74,832**
    Fundamentals values (for example 1992-10-15 Revenue Growth: stored −14.41, rule: unavailable) and 7,428 weekly
    values. Re-materializing `NEE` the way the next rebuild will (any revision bump) deletes its 1992–2014 valuations
    and moves later ones: 2016-06-01 DCF stored 8.01, after a rebuild 12.63.
  - `PLD`: IPO date right (1997-11-21, its first bar) but built before the profile, so the listing week was dropped as
    a horizon cut: SMA 20W and EMA 20W are missing from 1998-04-03 to 1998-05-26 where the rule has values, and every
    later weekly EMA is slightly off (8,992 audit failures).
  - Development database: 1 of 64 priced securities (`GJR`) also has an IPO date more than a year after its first bar.
- **Impact.** Silent and user-visible: two runs of one snapshot trade differently depending on hydration order
  (BT-04 is the same defect seen from the backtest worker), and a wrong provider IPO date drops a company from years of
  every backtest — exactly the kind of result a user reads as the strategy's.
- **Fix.** (1) Use the profile-enriched identity for the rest of the hydration (the three call sites above) and
  re-resolve the security in the backtest worker after preparation (BT-04). (2) Never let `ipoDate` cut stored data:
  bound by `min(ipoDate, first stored bar)`, and log an IPO date later than the first bar as a provider anomaly.
  (3) Ship (1) with this release's r8 bump, so the rebuild every security is about to get uses one identity. Test: a
  catalog-only security whose profile has an IPO date inside the horizon — rows built by the first hydration equal
  rows rebuilt afterwards.

#### OPS-06 · P1 · Redis projection · CONFIRMED (test + measured) · **blocks this release's deploy unless mitigated**

**A read that finds another process mid-hydration deletes that process's manifest, and the other process fails.**

- **Code.** `readDailyPriceProjection` / `readDailyDerivedStateProjection` (and the statement read) treat any
  non-READY manifest as a miss and call `invalidateManifest` with what they observed
  (`packages/stock-data/src/service.ts:1949–2015`, `:1590–1606`); `INVALIDATE_MANIFEST` deletes it whenever it is
  unchanged, whatever its status (`cache.ts:849–855`) — including another process's live HYDRATING generation. That
  process's next registered write then throws "Stock cache hydration generation changed" (`setRegistered`, `cache.ts:557–575`), which the
  backtest worker records as a terminal EXECUTION_FAILED (`apps/worker/src/backtest/backtest-processor.ts:1374–1384`).
- **Reproduction.** `packages/stock-data/src/redis.integration.test.ts`, "KNOWN DEFECT OPS-06" (PostgreSQL + Redis):
  A holds a READY stock and reads it; between A's freshness check and its read, B starts widening the same stock; A
  observes B's HYDRATING manifest and deletes it; B rejects with "Stock cache hydration generation changed".
  **Measured** in the matrix (§3.5): after a Redis flush, 7 of 40 concurrent core backtests failed in PREPARING_DATA
  with that error; the run's worker log records no loss of a hydration lock. The matrix runbook had attributed such
  cold-start failures to a Redlock lease expiring mid-hydration ("The warm-up", `docs/development/qa-matrix-runner.md`)
  and avoided them with the warm-up; that is a second route to the same error, and this one needs no lease loss.
- **Why this release.** The r8 bump makes every READY manifest non-current (`service.ts:3134–3151`), so the deploy is a
  cold-cache event for every security, with backtest workers, the stock EOD child and Stock Details reading
  concurrently. A Redis restart, and every LRU eviction (frequent at the default residency, OPS-01), recreate it.
- **Impact.** "The backtest could not be completed. Please try running it again." for a fraction of runs submitted
  while the cache warms; a stock EOD preparation can fail the same way (then backs off 30 min–6 h, OPS-05). Values are
  never wrong: the completed runs matched the warm sweep exactly.
- **Fix.** Invalidate only READY manifests (a status check in the Lua script); on a HYDRATING manifest, read
  PostgreSQL (or wait on the hydration lock) instead. Mitigation without the fix: deploy while no backtest is running,
  and warm the monitored universe sequentially before reopening submissions.

### 4.2 P2

| ID | Subsystem | Finding | Evidence | Status | Impact | Minimal fix | Blocks |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BILL-02 | Billing | Several open Checkout sessions can each be paid, creating **two live subscriptions**: the "already subscribed" guard reads only the mirror (`billing.service.ts:126–170`), each action gets a new idempotency key (`:162`), sessions carry no `expires_at` (`stripe.gateway.ts:176–196`) and nothing expires older ones. Violates `stripe-billing-v1.md` §5. | code traced end to end | CONFIRMED (code) | double billing until a manual refund; reconciliation keeps the oldest | inside the advisory lock, `checkout.sessions.list({customer, status:"open"})` and expire them; set a 30-minute `expires_at` | no (fix before launch) |
| SEC-01 | Auth | **Login and logout CSRF** through form posts: `NestFactory.create` keeps the urlencoded parser (`apps/api/src/main.ts:30`) and `parseLoginRequest` accepts form fields (`auth/auth-requests.ts:37`); a top-level cross-site POST sets the `SameSite=Lax` cookie. Reproduced: a form-encoded `POST /auth/login` returns **200** with the session cookie. Open since the 2026-09-18 audit (S-1). | "KNOWN DEFECT SEC-01" in `auth.integration.test.ts` | CONFIRMED (test) | a victim silently signed into the attacker's account; any site can sign users out | register only the JSON parser (keep `rawBody`) or refuse non-JSON content types on state-changing methods | no |
| MON-02 | Monitor | A **transient ETF snapshot load failure** is treated as "the fund did not print": members whose checkpoint is older than now − `EOD_LATE_RECOVERY_MS` are stepped with every rule reading that ETF/sector NOT_EVALUABLE and never re-decided (`apps/worker/src/shared/etf-context.ts:117–160`; `monitor-evaluation.ts:849–863`, `:640–646`, `:1020–1024`; `stock-data/src/etf-frame-columns.ts:63–71`). Reproduced: a new Monitor replaying 90 days with `readFullBenchmarkHistory` throwing reports `membersAwaitingEtf = 1` **and** writes its checkpoint at 2026-10-13 with no transition, losing the window's activation for good. | "KNOWN DEFECT MON-02" (PostgreSQL) | CONFIRMED (test) | a Redis blip during a new Monitor's replay, a >4-day pause or an outage catch-up writes permanently wrong (missing) ETF-driven history, labelled OBSERVED | carry per-code load status into the member evaluation; on `LOAD_FAILED` hold members reading it at their checkpoint | no |
| MON-03 | Operator tooling | `data:resync` and `fmp:live` compose the loader **without a venue calendar** (`apps/api/src/resync-canonical-stock-data.ts:269`, `fmp-live/fmp-live-runtime.ts:213` → `WEEKDAY_TRADING_CALENDAR`), so every holiday-shortened week they rebuild gets the pre-#107 rule; those historical rows are never rewritten. `MERGE_READINESS.md:99` recommends resync after a dataset bump. This audit's refresh used a scratch composition with the pinned calendar instead. | code (verified) | CONFIRMED (code) | backtests and Monitor reconstructions differ depending on which tool materialized a security | compose `CachedTradingCalendar` in both; add a composition test | no |
| DATA-01 | Data / reproducibility | **Weekly values depend on whether the venue schedule answered at computation time.** `resolveWeekSessionEnds` treats an unanswerable year as "Friday is a session" (`stock-data/src/weekly.ts:80–126`); the schedule is the provider's, cached in process memory only (`trading-calendar.ts:92–184`, `eod-finality.ts:229–252`). Stock rows freeze the answer; ETF contexts **recompute** it every run/pass (`etf-context.ts:111–114`), via provider reads on paths documented as provider-free (backtest `composition.ts:150–153, 231–232`; Monitor `composition.ts:56–58, 186–187` vs invariant 15's "makes no provider request"). **Measured:** 87 schedule requests in a 4-case backtest run. FMP was verified (2026-10-15) to answer 1990–2026 for NYSE and NASDAQ, so the risk is outages, not coverage. | code + measurement | CONFIRMED | two executions of one snapshot can differ on holiday-week Thursdays; Monitor and backtest can disagree; provider traffic per worker process per day | persist resolved week ends per (venue, year) in PostgreSQL once answered and read only that; correct invariant 15 / PC wording | no |
| DATA-03 | Stock data / valuation methodology | **Filings dated before the listing are never read, so the intrinsic values of every company listed inside the horizon change when it is next rebuilt — and this release's r8 bump rebuilds them all.** Since `a399d137` (2026-09-29) the rebuild's revision read honours its lower bound, `fiscalDate ≥ max(horizon, ipoDate)` (`prisma-store.ts:1560–1583`, `service.ts:2222–2227`); rows written before that — the development database's pre-2021 rows for `V`, for instance — used every revision. Re-materializing from the stored statements both ways reproduces the stored r8 values exactly: `V` 2012-06-01 DCF **55.60 → 27.23** and Graham **50.82 → 24.42**; `HON` 2005-06-01 DCF 43.64 → 57.53. Differences last four to six years after listing (`V` to 2013-11, `HON` to 2007-02, `GOOGL` to 2010-03), reach 51 % on DCF and Graham and 13–32× on Residual Income, and first values move up to a year later. The repository's two oracles disagree with each other: the Fundamentals oracle applies the clamp (and the 2026-09-30 Fundamentals audit accepted it as methodology, its observation 2), the intrinsic oracle reads every revision — so the committed evidence cannot be refreshed green until this is ruled (27,700 intrinsic + 15,722 frame-provenance failures, §3.5). | re-materialization of the stored statements both ways (`.debug/data-correctness-audit-2026-10-16/clamp-stats.ndjson`) | CONFIRMED (repro) | intrinsic and Margin-of-Safety backtests on `V`, `GOOGL`, `CRM`, `HON`, `MRNA`, `AMZN`, `GS` trade differently after the deploy; users comparing a re-run with an earlier one see different trades | owner ruling: read filings published before the listing (they were public when it listed), or keep the clamp; then align the other oracle, and say in the release notes that historical valuations of companies listed inside the 37-year statement retention (after 1989) change | owner's call |
| FIN-01 | Trigger context (Monitor and backtest) | A Trigger is NOT_EVALUABLE on the first session after a gap of more than ~10 calendar days whenever that session is the **first row of a frame read**: the read is widened only by `TRIGGER_CONTEXT_CALENDAR_DAYS = 10` (`stock-data/src/service.ts:1071–1080`, `evaluation-frame.ts:44`) and `evaluateMarketTrigger` refuses index 0 (`strategy/src/predicates.ts:161–164`). The Monitor reads from its checkpoint, so it hits this after any halt of ≥ ~8 sessions; a backtest carries the previous row across **year** boundaries (`strategy/src/backtest/window.ts:156–181`) but its **first** window has the same gap, so the same session's decision depends on the run's start date (engine review, BT-05). Breaks `ai/product/monitors.md:447–450` and "requires the previous eligible value". | two reviewer traces | CONFIRMED (code) | a resumption crossing is recorded or lost depending on where the frame starts; Monitor and backtest disagree | in the shared frame read, also read the security's last printed row before `from` when index 0 needs `t−1` | no |
| FIN-02 | Web (backtest result) | The ETF notice says "Every ETF this strategy reads had data for this run" for READY funds whose first session is **after** the run ends (XLRE before 2015, XLC before 2018) or whose last session is before it ends (`apps/web/src/features/backtests/utils/etf-conditions.ts:42–48, 120–128`; API `backtests.service.ts:231–243`); a test pins the wording (`etf-conditions.test.ts:43–48`). | code (verified) | CONFIRMED (code) | a no-data zero-trade run is presented as the strategy's genuine result, against owner ruling §13.7 | compare `firstSession`/`latestSession` with the snapshot period; warning tone for none/partial | no |
| FIN-03 | Alternative data | Amended disclosures are **double-counted**: content hashes include `filingDate`/`formType` and `disclosureDate` (`stock-data/src/alternative-data-service.ts:179–207`), so a Form 4/A restating a line adds a second purchase. Listed as open work without a ruling (`docs/alternative-data-signals.md:538–540`). | code | CONFIRMED (code path); frequency unmeasured | money and count measures overstated on amended filings | owner ruling, then supersede-by-amendment | owner's call |
| FIN-12 | ETF technicals | **Exact decimal ties are decided by float noise on the ETF path.** XLK's close on 2012-12-20 is 14.69 and its exact 200-day mean is 14.69; the ETF context computes 14.690000000000033 (raw doubles, owner ruling 6), so `XLK · Price is below SMA 200D` reads TRUE. In `T09-L08-C01` (re-run to pin it) that one tie fired **ten FINAL EXITs — every holding — on the same session**, and the cash rotated into ten other names. A stock with the same bars stores the mean at 8 decimals (14.69000000) and reads FALSE. A scan of XLK finds a second tie (2015-07-29, close = SMA 50D = 21.32). Found by the oracle, which refuses comparisons inside 1e-9 (4 sector cases INDETERMINATE, §3.5). | oracle + single-case rerun (`…-000607`) | CONFIRMED (repro) | rare, but when it hits a static ETF rule every position moves at once; stock and ETF decide the same tie differently | quantize ETF technicals to the stock storage scale before comparing, or compare with a relative epsilon (one fix with PRED-01); revisit owner ruling 6 | no |
| OPS-03 | Redis | `noeviction` + a full Redis fails every warm stock read (`TOUCH_READY` writes, `cache.ts:811–820`), the FMP gate, Redlock and fail-closed rate-limit policies (503), while `/health/ready` checks only PING and the policy (`apps/api/src/health.controller.ts:91–99`). | code | CONFIRMED (code), OOM semantics PLAUSIBLE | outage-shaped failure from a sizing mistake | sizing formula + readiness warning; best-effort `touch` | no |
| OPS-04 | Redis | `SET_REGISTERED` re-applies the TTL to every registered key on each write: `K²/2` `PEXPIRE`s, ~48 k per 34-year hydration (`cache.ts:776–777, 803–806`). | MEASURED (PC) | CONFIRMED | the multiplier behind OPS-01's millions of commands | give new keys the manifest's PTTL | no |
| OPS-05 | FMP / stock EOD | A saturated FMP gate sleeps until the oldest lease expires (30 s, `stock-data/src/fmp-gate.ts:27–30`), and the stock EOD child backs a failed security off 30 min → 6 h whenever the run is "mixed", contrary to its stated intent (`refresh-run.ts:178–181, 310–335`). | code + team measurement (1.0 s vs 30.9 s) | CONFIRMED (code) | Monitor Signals delayed 30 min–6 h under backtest load | poll ≤ 250 ms when saturated; do not back off on transient/gate errors | no |
| UI-02 | Web (auth) | No 401/403 handling (`apps/web/src/lib/api/client.ts`; session resolved once, `use-auth-session.tsx:67–91`): an expired (8 h TTL) or revoked session, or a Terms bump, shows "try again in a moment"; reloading loses the Builder draft; the run page re-polls `/progress` every second forever (`use-backtest-run.ts:148–156`). | code | CONFIRMED (code) | lost work; misleading errors; wasted requests | map 401/legal-403 to a "session ended" state with `signInHref(currentPath)`; stop polling on 401/403/404 | no |
| UI-03 | Web (Builder) | "Run backtest" in the Builder header bypasses the unsaved-changes guard (`StrategyBuilder.tsx:234–237` → `AccountActionLink.tsx:45–49`) and runs the **saved** version. | `e2e/strategies/run-backtest-guard.user.spec.ts`: no confirmation asked, the page leaves | CONFIRMED (E2E) | the user backtests a strategy they did not mean | pass `onNavigate={guardNavigation}` | no |
| UI-04 | Web (Monitor) | After a rebind the Signal table keeps showing old Signals as Active until reload: `onSaved` reloads the detail but not `useMonitorSignals` (`MonitorDetail.tsx:237, 750–753`), although the API resolved them (`monitors.service.ts:983`). | code | CONFIRMED (code) | contradictory status on one page | reload the table, or key it on `configVersion` | no |
| UI-05 | Web (backtest result) | A failed trades request renders "This run made no trades" beside KPIs reporting N trades (`use-backtest-trades.ts:90–95`, `BacktestRunView.tsx:710–724`, `BacktestTrades.tsx:238–260`). | code | CONFIRMED (code) | false empty state after a 429/503 | error state + retry | no |
| UI-06 | Web (Dashboard) | "Show older activity" collapses back to 15 rows every 60 s (`DashboardPage.tsx:212`, `use-monitor-activity.ts:60`). | code | CONFIRMED (code) | readers lose their place | merge new events by id; keep the cursor | no |
| UI-07 | Web (Lists) | The "Over plan limit" badge and notice survive the removals that fix it (`ListDetail.tsx:368–372, 408–420`; `use-stock-list.ts:83–92`). | code | CONFIRMED (code) | downgraded users remove more than needed | re-read the list after a removal | no |
| MAINT-01 | Contracts / engine | Non-exhaustive source dispatch (§5.3). | code | CONFIRMED | a fourth source kind silently aliases to Stock's Sector | `switch` + `assertNever` | no |
| MAINT-02 | Codebase | Disproportionate file growth (§5.3). | `git log --numstat` | MEASURED | review and merge cost | split by existing section banners when next touched | no |
| QA-05 | QA tooling / stock-data | Split-list freshness hard-coded to 24 h (§3.3). | code | CONFIRMED | valuation-ratio matrix strategies cannot be pinned past a day | make it configuration like the other freshness windows | no |

### 4.3 P3

| ID | Subsystem | Finding (refs) | Status | Fix |
| --- | --- | --- | --- | --- |
| PRED-01 | Strategy evaluation | `is close to` decides exactly-2% pairs inconsistently in binary: (30.6, 30), (1.02, 1), (0.98, 1) are outside, (102, 100) inside (`strategy/src/predicates.ts:62–67`). Pinned by "KNOWN DEFECT PRED-01". | CONFIRMED (test) | compare with a relative epsilon or in scaled decimals |
| FIN-07 | Weekly rule | A closure decided after the fact ends a week early: FMP lists 2001-09-11…14 as full closures (verified in the pinned capture), so Monday 2001-09-10's row already carries that week as complete. Pinned in `matrix-etf-oracle.test.ts`. | CONFIRMED | owner ruling: accept and document, or shorten weeks only by holidays known in advance |
| FIN-08 | Monitor | One unavailable ETF (e.g. `SP500` not floor-anchored, `NOT_BOOTSTRAPPED`) holds **every** level of a member for 4 days (`monitor-evaluation.ts:830–862`). | CONFIRMED (code) | do not wait on a code that cannot catch up; or hold per level |
| FIN-09 | Alternative data | (a) the coverage floor can over-claim after a truncated or chamber-merged ingest → 0 instead of NOT_EVALUABLE; (b) a correction observed after the close applies to the same session (`stock-data/src/prisma-store.ts:1389, 1521–1525`); (c) the 45/90-day placeholder can precede a 12b-25-extended filing (`domain/src/financial-statements.ts:217–282`). | PLAUSIBLE | next New York day for (b); floor from contiguous pages for (a) |
| MON-04 | Monitor | A Strategy edit is never applied to a member passed through a session its security did not print (halted/delisted): `redecideEdited` looks up a non-printed `from` (`monitor-evaluation.ts:663–686, 1118–1129`). An Active Signal of removed logic stays open. | CONFIRMED (code) | exclude pass-only plans from work; decide at the newest printed session ≤ `from` |
| MON-05 | Monitor | Reconciliation reads orphaned rows outside its transaction and deletes without a `stateVersion` guard (`monitor-repository.ts:487–560`; `pruneCheckpoints` alike). Overlapping passes after a lease loss can leave two open Signals for one level. | PLAUSIBLE | re-select `FOR UPDATE` inside the transaction; version-guarded delete |
| MON-06 | Config | `EOD_LATE_RECOVERY_MS` is capped at 6 days assuming a 10-day recent tail, but `STOCK_RECENT_TAIL_CALENDAR_DAYS` is freely configurable (`config/src/index.ts:880–886, 1156–1160`) → a silent clock-only give-up if misconfigured. Not reachable with defaults. | CONFIRMED (code) | startup validation |
| OPS-07 | Redis | An empty derived window counts as a miss and re-materializes on every read (`service.ts:1991, 2003`). | PLAUSIBLE | distinguish empty from missing |
| OPS-08 | Calendar | No negative caching: after the 24 h TTL lapses during an outage every call re-asks; unanswerable past years re-asked hourly per process (`trading-calendar.ts:147–158`). | CONFIRMED (code) | negative-cache with backoff (DATA-01's persistence removes it) |
| OPS-09 | PostgreSQL | No Prisma pool sizing anywhere; up to 32 backtest processes vs `max_connections` 100; `applyMemberEvaluation` 30 s timeout with the default 2 s `maxWait` (`monitor-repository.ts:723–797`). | CONFIRMED (code) | per-process `connection_limit` |
| OPS-10 | Workers | Singleton work has no crash/hang protection: expired-lease recovery does not move `dueAt`, `consecutiveFailures` is unread (`monitor/scan-repository.ts:276–292`, market-data `schedule-repository.ts`); the supervisor watches `exit` only (`apps/worker/src/index.ts:149`); no ioredis `commandTimeout`, no `statement_timeout`, no child heap cap (`index.ts:139`). | CONFIRMED (code) | back off a repeatedly failing claim; heartbeat watchdog; timeouts; `--max-old-space-size` |
| OPS-11 | PostgreSQL | Hot-path costs: `resolveUnvisitedStates` loops inside a 5 s transaction; `FOR SHARE` on the Monitor row per member; backtest claims wait on the entitlement advisory lock that billing holds across Stripe calls (`job-repository.ts:283–287`); Dashboard activity sorts without index support (`dashboard.service.ts:437–466`); `getDailyPriceBounds` computes an unused `_count` (`prisma-store.ts:893–897`); unused index `MonitorStateTransition(monitorId, sequence)`. | CONFIRMED (code) | targeted fixes when measured |
| OPS-12 | Redis | Compose Redis persists RDB snapshots (`docker-compose.yml:19–25`); a restore can bring back an old-basis READY manifest, which carries no basis generation (`cache.ts:29–77`). | PLAUSIBLE | run the cache Redis without persistence, or flush the projection namespaces on restore |
| OPS-13 | Docs | PC states ≈2×U provider requests per session; with statement-reading Monitors it is up to ≈8×U (`refresh-run.ts:264–268`). | CONFIRMED (code) | correct PC; size the gate to the plan |
| SEC-02 | Rate limiting | Signed-in `/stocks/*` and `/market-overview` traffic is keyed by IP (no guard populates `authUser`: `rate-limit.service.ts:374–375`, `stocks.controller.ts:338`, `market.controller.ts:21`), against invariant 19. | CONFIRMED (code) | `OptionalCookieAuthGuard` on both controllers |
| SEC-03 | Billing | The Stripe idempotency suffix comes from the **inbound** `x-request-id` (`billing.controller.ts:167–172`); the comment says otherwise; a test pins it (`billing.integration.test.ts:356`). Self-only effect. | CONFIRMED (code) | use `getLogContext().requestId` |
| SEC-04 | Input parsing | Repeated query keys (`/stocks/search?q=a&q=b`, actor search, `ids=`) and a cursor `d:"2023-13-45"` return 500 (`stocks.controller.ts:379`, `actor-groups.service.ts:213`, `alternative-data.controller.ts:114`, `dashboard.service.ts`). | CONFIRMED (code) | type checks, `isLocalDate`, bounded offsets |
| SEC-05 | Auth | `safeReturnPath` accepts `/.//evil.example` and `/a/..//evil.example` (resolve to pathname `//evil.example`) in the API and web twins (`auth/return-path.ts:41–75`, web `return-path.ts:64–73`); exploitability depends on Next.js slash handling. | PLAUSIBLE | reject a resolved pathname starting with `//`; extend the corpus |
| SEC-06 | Backtests | Submission reads List items and buy windows with separate SELECTs at READ COMMITTED (`backtests.service.ts:817–844, 901`); a concurrent buy-window replace yields an unmapped `BuyWindowValidationError` → 500. | CONFIRMED (code), rare | `RepeatableRead` transaction as `duplicateList` does |
| SEC-07 | Config | Production accepts `http://` CORS origins (`config/src/index.ts:206–213`) while the docs require https. | CONFIRMED (code) | `assertProductionPublicUrl` per origin |
| SEC-08 | Ops | Public readiness returns raw dependency error messages (`health.controller.ts:182–189`), rate-limit exempt. Open since 2026-09-18. | CONFIRMED (code) | log the message; return status only |
| UI-08 | Web | "Replace with one period" pre-fills the oldest range (`lists/utils/buy-windows.ts:145–158`); saving it can end Monitor Signals with `MEMBERSHIP_CHANGED`. | CONFIRMED (code) | seed from the leading period |
| UI-09 | Web | The Backtests collection stops refreshing after one failed poll (`use-backtest-runs.ts:80, 86`); a failed terminal refetch shows the last live snapshot as the result (`use-backtest-run.ts:126–140`). | CONFIRMED (code) | re-arm on failure; retry `settle` |
| UI-10 | Web | Plan/entitlements stale after an in-app plan change (`use-plan-actions.ts:86–88`); Builder save is PATCH then PUT with no rollback or version precondition (`StrategyBuilder.tsx:154–170`) — last write wins on live Monitor logic. | CONFIRMED (code) | `session.refresh()`; `expectedVersionNumber` on PUT |
| UI-11 | Web (a11y) | Modal closes on a drag-release outside and while a save is pending (`components/ui/Modal.tsx:38–49`); the Dashboard Monitor filter unmounts itself on change, dropping focus (`DashboardPage.tsx:220, 249, 275`). | CONFIRMED (code) | mousedown+mouseup on backdrop; `busy` prop; keep the toolbar mounted |
| UI-12 | Web | Silent "Show more" failures (`use-monitor-signals.ts:87`, `use-monitor-activity.ts:85`); a flat close shown as a green ▲ (`StockHeader.tsx:47–49`); `todayLocalDate` is the UTC day with a wrong comment (`stocks/details/utils/local-dates.ts:9–12`). | CONFIRMED (code) | inline errors; direction from the rounded value; fix the comment/name |
| BT-01 | Backtest result | A completed run liquidates a position whose provider history ended years earlier at that stale close, and nothing in the completed result says so (`strategy/src/backtest/simulation.ts:515–522, 1004–1050`; no price-date column on `BacktestTrade`, `schema.prisma:1178`); the staleness marker exists only in the live holdings panel. Documented methodology ("visible rather than silent"), but only while running. | CONFIRMED (code) | persist the observed price date on END_OF_BACKTEST trades and render it; owner ruling on long-stale marks |
| BT-02 | Backtest worker | A transient comparison-benchmark read failure completes the run with no benchmark, alpha or S&P line and no notice (`apps/worker/src/backtest/backtest-processor.ts:846–867, 1049–1081`), although the calendar read the same series moments earlier. | CONFIRMED (code) | reuse the calendar's bars (same series in V1) or fail the attempt so lease recovery retries; at least surface "comparison unavailable" |
| BT-03 | Engine | A monthly contribution that quantizes to $0.000000 still triggers the contribution-day top-up (`simulation.ts:490–496, 706`; the API accepts any 0 ≤ x ≤ 1e7). Invariants 14/15/21 cannot see it. Note also: a deposit day's top-up is funded from all idle cash, not the deposit — a buy-side rebalance on every deposit day, as the rule text says but the DCA framing does not. | CONFIRMED (code) | derive `depositedToday` from the quantized deposit, or refuse contributions below $0.01 |
| BT-04 | Backtest worker | The first backtest on a never-profiled security keeps the pre-hydration catalog identity, so `ipoDate` written by the first profile sync is not applied to its frames (`backtest-processor.ts:552–554, 786–793`; `service.ts:1332, 1658–1688, 3495–3507`); a re-run of the same snapshot can trade differently. `getDailyValuationRatio` already re-resolves for this reason (`service.ts:1548–1551`). The same root cause as DATA-02, seen from the backtest worker; fix them together. | CONFIRMED (code path), frequency PLAUSIBLE | re-read the security after preparation, or freeze `ipoDate` into the snapshot |
| BT-06 | Docs | `ai/architecture/backtest-execution.md:196` says zero cash leaves a level unfired; under methodology v3 the tiers of an open position settle (`simulation.ts:817–837`), as lines 376–383 of the same doc say. | CONFIRMED | reword the table row |
| BT-07 | Engine (latent) | `BenchmarkCursor` returns null on a non-positive or NaN close instead of carrying the last valid close forward (`strategy/src/backtest/benchmark.ts:30–42`); unreachable for SPY today. | CONFIRMED (code) | keep the last valid close |
| MAINT-03 | Composition | `CanonicalStockDataService` / `FmpClient` / gate hand-wired in 17 files; PR #99 threaded one option through 7 roots. | MEASURED | one runtime factory per process type |
| MAINT-04 | Engine | No operand-family seam: ~6 branch points per new window-based family, one runtime-only (`evaluation-frame.ts:232`). | CONFIRMED | descriptor inside the next family PR |
| MAINT-05 | stock-data | Technical columns hand-mapped three times in `prisma-store.ts` (:91–110, :204–227, :248–269) and listed by hand in `DailyDerivedState`. | CONFIRMED | iterate the registries |
| MAINT-06 | Docs / drift | `calculated-series.md:323` says revision 7 (code 8); `system-overview.md:7–8` two child kinds (four); `strategy-etf-conditions.md` §8 references deleted files; AGENTS omits `stock-data → valuation`; the web recomputes MOS with the opposite sign (`web/.../utils/valuation.ts:116`); operand prefixes spelled outside `operands.ts`; OpenAPI ETF code enum and `DailyTechnicalResponse` have no parity test; 77 literal-count assertions; tooling (data-correctness audit 25.5 k lines, QA matrix 9.9 k) and 138 `*.test.js` ship in `apps/api/dist`. | CONFIRMED | §5.5 item 5 |


### 4.4 Checked and found sound

Recorded so the next audit does not re-derive them; each line names what proves it.

- **Tenancy and authorization.** Every route family re-applies the owner predicate inside the writing statement
  (`content-access.ts` `readableWhere` / `mutableWhere`); another customer's row is a 404 even for an administrator;
  SYSTEM content is ADMIN-only and never deleted; backtest reads are scoped by `userId`; Monitor references are
  verified inside the writing transaction; admin routes are guarded at class level and role/plan are reloaded per
  request.
- **Sessions and sign-in.** HS256 pinned, TTL matches the cookie, session-version equality per request with a
  generic 401, HttpOnly/Secure/SameSite=Lax host-only cookie, dummy Argon2 hash for unknown users, Google PKCE S256 +
  state + nonce, unverified password cleared on link.
- **Stripe webhooks.** Raw-body signature verified before any write, livemode check, event-id marker inside the
  locked transaction, metadata trusted only on `checkout.session.completed`; the whole client surface is a price key.
- **SQL.** All HTTP-reachable raw SQL is tagged-template and parameterized; `$queryRawUnsafe` only in CLIs with
  constants or validated identifiers.
- **Rate limiting.** Right-indexed `X-Forwarded-For` by trusted hop count, IPv6 /64 grouping, fail-closed auth and
  billing policies, refunds on refusal; logging redacts secrets and never logs query strings.
- **Engine accounting.** Exits before entries; one FINAL EXIT action across ORed Exit Rules; SELL % of shares
  remaining once per lifecycle; strongest eligible BUY with tier settlement; contributions on each month's first
  calendar session, never the first simulated date; exact-decimal ledger with float only in sizing; value-neutral
  terminal liquidation; windowed execution equals continuous; candidate ordering total; no clock in the engine.
- **Snapshot immutability and replay.** Nothing updates `BacktestRun.snapshot`; the worker reads no Strategy, List or
  Benchmark row; revision mismatches are refused in both directions before hydration, with a "run again with these
  settings" path; retries restart cleanly; result persistence is ownership-guarded, delete-then-insert in one
  transaction, idempotent.
- **Monitor EOD V2 core.** Checkpoint, Signals, transitions and states are written in one transaction behind the
  binding fence and a checkpoint compare; overlapping passes and crash recovery decide each session once
  (`monitor-evaluation.integration.test.ts`, `monitor-late-recovery.integration.test.ts`); rebinds are fenced by
  `configVersion`; the stock give-up is evidence-based; the Dashboard feed shows `OBSERVED` only; a replay starts from
  the exact pre-window state.
- **Point-in-time inputs.** Kernels are trailing only; statements become available at filing + 1 (or a statutory
  placeholder); TTM uses consecutive quarters; ratios withhold on an unsafe price basis; the frame joins by exact
  date; ETF bars count only when final and proven by a tail read; NOT_EVALUABLE follows strong Kleene logic and
  never becomes 0.
- **Stock's Sector.** Frozen at submission only when the definition reads it; the worker refuses a missing, stray,
  contradicting or unpinned freeze and reads `member.sector.etfCode`, never the catalog; an unresolved sector joins
  NaN, never SPY. The matrix's invariant 43 checks this on every T run against a restated mapping.
- **Projections.** Benchmark chunks are content-addressed behind a compare-and-set head with a generation fence;
  stock reads re-check the manifest after each `MGET`; a Redis flush costs zero provider requests; per-security
  single-flight via Redlock with ownership asserted before writes; no provider call inside a PostgreSQL transaction.
- **Frontend.** Strategy documents round-trip verbatim through the Builder (ETF `source`, `STOCK_SECTOR`, Exit Rules,
  `ACTORS`); detail hooks are sequence-guarded; no financial calculation in components; NOT_EVALUABLE rendered
  distinctly; market-overview staleness honest.

---

## 5. Architecture and extensibility

### 5.1 Verdict

FactorSage is **well factored where it has been extended most often** — the Strategy metric registry, the
entitlement matrix, the durable claim protocol, versioned methodology with fail-closed refusal, and completeness
tests that fail the build when an extension is half wired. It is **expensive in three places** that will be hit by
the next product steps: a new **technical indicator family** (two registries joined by convention, hand-written
persistence mappings, a weekly path that only knows moving averages, hard-coded chart panes), a new **data-source or
operand family** (non-exhaustive source dispatch and no operand-family seam), and any **cross-cutting loader
option** (seven hand-wired composition roots). None of this blocks release; all of it should be paid down inside the
next feature PR that touches it, not as a standalone refactor.

Measured baselines (files changed by the merge, from `git diff --name-only M^1 M`):

| Change | Files | Of which tests |
| --- | ---: | ---: |
| Relative Volume, PR #60 (`43482480`) | 46 | 17 |
| Alternative data, PR #61 (`8c3491f6`) | 81 | 14 |
| Fundamental Metrics, PRs #66 + #67 + #70 + #71 | 140 | — |
| Valuation ratios, PR #78 (`13a3e75b`) | 43 | 11 |
| ETF Conditions, PR #98 (`149ca276`) | 111 | 42 |
| Stock's Sector, inside #98 (`ba07a689`) | 38 | 18 |
| Stock EOD worker kind, PR #100 | 29 | 12 |
| Entitlements, PR #28 (`9bee7785`) | 119 | 41 |

### 5.2 Extension-impact matrix

Ratings: **S** ≤ 8 files, one registry; **M** 9–25 files; **L** 25–60 files or a missing seam; **XL** new concepts
across every layer. Paths are the switch/registry points, not every touched file.

| # | Extension | Rating | Registries / contracts | Engine, worker, stock-data | API / DB / OpenAPI | Web | Tests that force the change |
| - | --- | --- | --- | --- | --- | --- | --- |
| 1 | New technical metric, daily + weekly (MACD, %B) | **L** (45–60) | `contracts/selectable-series.ts` catalog (:59, :121); `domain/stock-data.ts` registries (:131/:150/:210), `TECHNICAL_SERIES_FIELDS` (:304), `DailyDerivedState` (:530, hand-listed); `contracts/strategies.ts` metric definitions (:686), `ETF_COMPATIBLE_METRIC_KINDS` (:266) and its exhaustive switches; value spec (MACD signed, %B unbounded — neither fits `OSCILLATOR` 1–100) | new kernel + `derived-state.ts`; `weekly.ts` `calculateWeeklyTechnicalValues` (moving averages only); `prisma-store.ts` hand mappings (:91–110, :204–227, :248–269); `daily-state-chunk.ts` `COLUMNS`; `evaluation-frame.ts` `seriesReader` (:287); `etf-frame-columns.ts` field whitelist (:94–104); `DERIVED_STATE_REVISION` bump (global rebuild, queued runs refused) | `DailyDerivedState` column + migration; `stocks.controller.ts`; OpenAPI `DailyTechnicalResponse` (:3781–3833, **no parity test**) | `series-catalog.ts`, `chart-series.ts`, `StockPriceChart.tsx` panes (:148–211, hard-coded) | `selectable-series.test.ts`, `daily-state-chunk.test.ts`, derived-state/Redis integration, `openapi.strategy-schema.test.ts`, literal counts in `etf-conditions.user.spec.ts` |
| 2 | New fundamental metric / valuation ratio | **M** (14–18) | mirrored catalogs `domain/fundamental-metrics.ts` ↔ `contracts/fundamental-metrics.ts` (drift-tested); `contracts/valuation-ratios.ts` | kernel map in `stock-data/fundamental-metrics.ts`; `valuation-ratios.ts` `RATIO_FAMILIES` (:161, compile-forced) and a hidden `EV_TO_EBITDA_TTM` special case (:514); `VALUATION_RATIO_REVISION` bump | column + migration (fundamentals); OpenAPI enums (guarded) | none — the Builder and Stock Details read the catalogs | catalog drift guards, OpenAPI history tests, the deliberately independent audit lists (`testing/fundamental-audit.ts`) |
| 3a | One more ETF | **S** (~6 + count tests) | `domain/benchmarks.ts` `BENCHMARK_CATALOG` (:144), `MARKET_OVERVIEW_ETF_GROUPS` (:64), `contracts/strategy-etf-sources.ts` (drift-guarded), `stock-sector-etfs.ts` if a sector fund | none (catalog-driven) | OpenAPI ETF `code` enum (:4559–4580, **no parity test**); rows from `BenchmarkCatalogService` | none | literal "20" counts in Dashboard and ETF specs |
| 3b | New benchmark *source kind* (non-FMP, computed) | **L** | `BENCHMARK_SOURCE_KINDS` (`domain/benchmarks.ts:22`) | `benchmark-service.ts` (1,424 lines), re-base and generation handling, gate/lock composition | Prisma enum + migration | — | benchmark integration suites |
| 4 | Fourth Strategy data-source kind | **L** (≈38, Stock's Sector baseline); **XL** if not an ETF | `StrategyMetricSource` (:174), `parseMetricSource` (:3203), **seven `ETF ? … : STOCK_SECTOR` ternaries** (MAINT-01) | `operands.ts` `sourcedOperand` (:231); `etf-frame-columns.ts` joins benchmark snapshots only; worker `backtest-processor.ts:598`, `run-snapshot.ts:210–274`, `monitor-evaluation.ts:284–316` | `backtests.service.ts` freeze/pin (:268, :896–967); OpenAPI | `MetricPicker.tsx`, backtest/monitor notices | golden fingerprints; per-source suites |
| 5 | New alternative-data family (short interest) | **XL** (81-file baseline) | `alternative-data.ts` measures/kinds; `StrategyMetric` union | a *level* measure (short % of float), not an event count — a new aggregation kind; `alternative-data-service.ts` (~36 per-family branches); frame post-pass | new content-addressed table + migration; ingestion CLI, admin route, OpenAPI; `FMP_ENDPOINT_CLASSES` | `AlternativeDataConfigDialog.tsx` (8 kind branches) | oracle `alternative-data.ts`; AGENTS invariant 23 text |
| 6 | New condition operator ("is between") | **M–L** (20–25) | `CONDITION_OPERATORS` (:351); `StrategyCondition.value` is single-valued (:373) | `predicates.ts` `evaluateConditionValues` (:53); Monitor evidence `v:1` (`monitor-lifecycle.ts:429`) needs a new version | OpenAPI (guarded) | `ValueControl.tsx` | predicate oracles |
| 6b | "% change over N sessions" | **M–L** | a metric kind, compile-forced switches | five operand-family branch points (MAINT-03) | — | — | — |
| 7 | New allocation mode (equal-weight rebalance, vol targeting) | **L** | snapshot `allocation` section (good seam, `contracts/backtests.ts:1189`) | sizing inline in `simulation.ts:736–830` with no policy seam; methodology key bump refuses queued runs (`revisionMismatches`, `contracts/backtests.ts:1072`) | `BacktestRun` column + migration; `backtests.service.ts:974–1032` | `NewBacktestForm.tsx` (740 lines) | independent `reference-backtester.ts`; `maximumPositions` appears in 37 production files |
| 8a | New worker kind | **M** (29-file baseline) | `CHILD_KINDS` (`apps/worker/src/index.ts:69`), `get*WorkerConfig` | process module, composition, schedule row | — | — | AGENTS invariant 15 text ("four instances") |
| 8b | Backtests across machines | **S** (configuration) | — | PostgreSQL claims with hostname-qualified ids; gate and locks in Redis | — | — | — |
| 8c | Horizontally scaled Monitor cycle | **XL** | — | singleton `MonitorScanSchedule` claim by design | — | — | — |
| 9a | Change a plan limit's value | **S** (1 file + decision doc) | `PLAN_ENTITLEMENTS` (`contracts/entitlements.ts:271`) | — | — | pricing page derives from it | persona E2E |
| 9b | New count-type limit | **M** | `Entitlements` type, three plans, `GUEST`/`ADMIN` | guard under the per-user entitlement lock | OpenAPI reason code | `LimitMeter`, `EntitlementNotice` | entitlement suites |
| 9c | Usage limit (backtest-minutes / month) | **XL** + product/legal decision | no usage ledger exists; AGENTS 17 ("compliance is derived") and 18 (no metered billing) | claim-time check in `job-repository.ts:269–317`; cancellation is deferred | ledger table | — | — |

### 5.3 Maintainability findings

These are in the register (§4) as `MAINT-*`; the two that matter most:

- **MAINT-01 (P2).** The Strategy data-source dispatch is a set of seven binary ternaries that read "not ETF ⇒
  Stock's Sector" (`contracts/strategies.ts:188, :958, :1665, :3599, :4231, :4548`; `strategy/src/operands.ts:238`).
  A fourth source kind added to the union and parser would compile cleanly and be normalized, fingerprinted and
  latched **as Stock's Sector** — exactly what the comments at `:4224` and `:4508` say must be a compile error.
  About an hour to replace with `switch` + `assertNever`; the golden fingerprint tests guard the rewrite.
- **MAINT-02 (P2).** Growth concentrates in a few files: `contracts/strategies.ts` 2,020 → 4,634 lines since
  2026-09-15 (+3,083/−469), `stock-data/service.ts` 2,287 → 3,791 (one class with four frame readers, hydration,
  freshness, statements, intrinsic values, ratios and splits), `StockPriceChart.tsx` 629 → 1,277, `openapi.yaml`
  3,845 → 6,497. Splitting does not reduce files-per-extension, but it is where merge conflicts and review time go.

### 5.4 Already well factored (keep it that way)

- `STRATEGY_METRIC_DEFINITIONS` / `METRIC_KEYS` are `Record<Kind, …>` with exhaustive switches; adding the whole
  `FUNDAMENTAL` kind touched one web file.
- The web Builder reads only `@intrinsic/contracts`; 0 runtime import cycles across 718 files in 7 packages; no
  `process.env` in the pure packages.
- One indicator implementation: ETF technicals reuse `buildDailyDerivedState` and `aggregateCompletedWeeks`
  (independently confirmed by the oracle, §3.2).
- Entitlements in one matrix, resolved server-side, the worker claim calling the same resolver.
- Versioning is centralized and refuses rather than reinterprets (`BACKTEST_DATA_REVISIONS`, `BACKTEST_METHODOLOGY`,
  fail-closed snapshot parses); golden fingerprints keep stored hashes and Monitor latches still.
- Completeness tests force the work (OpenAPI contract, rate-limit and legal-acceptance coverage, FMP gate coverage,
  `Required<DailyDerivedState>` chunk fixtures); tests are behavioural (0 snapshot matchers, 4 `as any` in 494 files).

### 5.5 Five minimal improvements, in order of payoff

1. **Exhaustive source dispatch** (MAINT-01): ~1 h; seven silent mis-routes become compile errors.
2. **Registry-driven technical persistence** (MAINT-05): iterate `MATERIALIZED_MOVING_AVERAGES`,
   `DAILY_OSCILLATORS`, `RELATIVE_VOLUME_FIELDS` in `prisma-store.ts` as fundamentals already do; ~100 lines; a new
   period goes from 13 checklist steps to 8 and the "written but never read" failure disappears.
3. **One stock-data runtime factory per process type** (MAINT-03): PR #99 threaded one option through seven roots;
   this makes it one or two, keeping `fmp-gate-coverage.test.ts` and the fmp:live guard rule.
4. **A chart-pane registry in `StockPriceChart`**: a new non-price pane from ~5 edit sites to one descriptor.
5. **Cheap drift closures**: one shared Margin-of-Safety helper (the web recomputes it with the opposite sign,
   `web/.../utils/valuation.ts:116` vs `evaluation-frame.ts:271`), a MOS operand decoder, OpenAPI parity for the ETF
   code enum and technical fields, and the doc drift in `calculated-series.md` (revision 7 → 8),
   `system-overview.md` (two child kinds → four) and `strategy-etf-conditions.md` §8 (deleted `monitor-cycle.ts`).

Defer to the next relevant feature PR: an `OperandFamily` descriptor (MAINT-04, ~6 branch points → 1) and the
`domain → contracts` dependency change that would remove the mirrored vocabularies (an AGENTS rule change, owner's
call).


---

## 6. Capacity and performance

Tags: **MEASURED** = a number recorded in `ai/architecture/production-capacity.md` (PC) or measured in this audit;
**DERIVED** = arithmetic from code paths and measured unit costs, shown; **SPECULATIVE** = labelled as such. All
measurements are on this 8 GB M1 with PostgreSQL and Redis in Docker Desktop, so absolute wall times are a floor for
a production host, not a forecast.

### 6.1 Measured baselines

| Workload | Measurement | Source |
| --- | --- | --- |
| Stock EOD child, steady session | U=100: 14 s, 200 requests, 53 k Redis cmds; **U=500, R=100: 190 s, 4.38 M Redis cmds**; U=500, R=1,000: 80 s, 267 k cmds | PC "The stock EOD child" |
| Stock EOD child, cold | 8 provider requests per security; U=500: 626 s over 3 four-minute runs | PC |
| Monitor pass | 9,000 members: steady 15–18 s (~53.5 k PostgreSQL queries, 0 Redis, 0 provider for data); idle 3.0–3.5 s; new-Monitor 90-day replay 65 s | PC (EOD V2 `capacity-bench`) |
| Re-materialization from PostgreSQL | 0.09 s wall, 0.7 MB and ~6,800 Redis commands per security at 12-year retention; ~48 k `PEXPIRE`s per security at 34 years | PC "resident bound" |
| ETF technical context | 55 ms compute, 89 ms warm load, ~2 MB retained per fund | PC / strategy-etf-conditions §13 |
| **QA matrix, this audit** | 5,000 real backtests at concurrency 3: see §3.5 for per-dimension wall time and throughput | `.debug/qa-matrix/*/summary.json` |
| **Venue calendar traffic, this audit** | a 4-case Stock's Sector run made **87** `holidays-by-exchange` requests (one per year with a non-Friday week, per worker process, per 24 h) | `providerEgress` in the smoke run's `summary.json` |
| **Live provider for the refresh, this audit** | 35 securities through the canonical loader with a pinned calendar: 117 requests, ~7 s per security (3 requests each for an up-to-date security; 9 for a first hydration with 34 years) | refresh log |

### 6.2 Bottlenecks and estimated limits

| Workload | First bottleneck | Estimated limit | Kind | Cheapest mitigation |
| --- | --- | --- | --- | --- |
| Concurrent backtests | the **count-based stock LRU** (`STOCK_CACHE_MAX_RESIDENT_STOCKS`, default **100**): the year loop reads every security every window; a miss re-materializes the security over its whole retention (`service.ts:1958–2006`, `:3299–3312`) | one PRO user's two concurrent 100-symbol runs exceed R=100; a sequential scan larger than R misses 100 % (PC). A 30-year × 100-security run under full thrash ≈ 3,000 re-materializations ≈ +12 min, ~6 GB written to Redis, >100 M commands | DERIVED from MEASURED unit costs | **R ≥ monitored U + Σ securities of concurrent backtests + API working set** (OPS-01), with `maxmemory` sized to match (≈ 4.64 MiB per resident security at the catalog's widest row, measured) |
| Redis memory | `noeviction` + a full Redis makes **every warm read fail** (`TOUCH_READY` writes inside a script), FMP gate and rate limiting fail closed (503), while `/health/ready` stays green (OPS-03) | 2 GB holds ≈ 411 resident securities | MEASURED per-security size, DERIVED limit | the sizing formula above, a readiness warning when `maxmemory` is set below it, best-effort `touch` |
| Stock EOD per session | serial work at concurrency 2 inside a 4-minute budget | ≈ 1,500 securities per budget at R ≥ U (0.16 s each); beyond, 30 s follow-ups | DERIVED | R ≥ U; fix the `K²/2` `PEXPIRE` registration (OPS-04) |
| Provider budget | the shared gate (4 slots, 20 req/s default) and its 30 s lease sleep when saturated (OPS-05) | 2×U per session steady; **up to ~8×U** when Monitors read statement-derived operands (6 statements refreshed per 6 h freshness window) — PC understates this (OPS-13) | DERIVED | poll the gate at ≤ 250 ms; size the gate to the FMP plan |
| Monitor pass | one transaction per member in a singleton claim | ≈ 1.7–2 ms per member → ~300 k members per 10-minute window, once per session | DERIVED from MEASURED | none needed for V1; a sharded claim is an XL change (§5.2) |
| Revision rollout (r8, this release) | a full 34-year derived rewrite per security (~8,500 rows, ≥5 s each, one 120 s transaction) on first touch, plus OPS-02's stall | U=500 ≈ 20–25 min at stock-EOD concurrency 2; ≈ 1.9 GB inserted + equal dead tuples; first Stock Details view per security rebuilds inside the request; concurrent first hydrations abort each other (OPS-06: **7 of 40** cold backtests failed, MEASURED) | DERIVED + MEASURED | deploy in the New York morning and pre-warm the monitored universe sequentially *after* fixing OPS-02 and OPS-06 |
| PostgreSQL connections | no pool sizing anywhere; up to 32 backtest processes allowed vs `max_connections` 100 (OPS-09) | SPECULATIVE until a production pool budget exists | — | set `connection_limit` per process type |
| Result tables | no retention for `BacktestDailyEquity`, trades, signals, transitions | ~7,560 equity rows per 30-year run; the matrix measured 1,982 MB of `BacktestDailyEquity` from 1,006 retained runs before its cleanup existed | MEASURED (runner doc) | a retention policy is a product decision; not a V1 blocker |

### 6.3 Optimization priorities (cost-effective first)

1. **Configuration before launch** (OPS-01, OPS-03): size `R` and `maxmemory` together; add the readiness warning.
2. **Fix the stock-EOD derived-lag skip** (OPS-02) — a two-line condition that also makes the r8 rollout
   self-healing — and **spare live hydrations from read-path invalidation** (OPS-06), a status check in one script,
   which makes every cold-cache event (deploy, Redis restart, eviction) safe under concurrency.
3. **`SET_REGISTERED` TTL registration** (OPS-04): give a new key the manifest's PTTL instead of re-expiring every
   registered key — removes the quadratic term that makes thrash cost millions of commands.
4. **Backtest window miss → PostgreSQL read** (as `readFinalizedEvaluationFrame` already does) instead of re-hydrating
   the whole security; and have the stock-EOD child skip LRU admission for securities not already resident.
5. **Gate polling** (OPS-05) and **calendar negative caching** (OPS-08).
6. Later, only on evidence: per-family derived revisions, a sharded Monitor claim, result retention.

Do **not** raise worker parallelism or cache residency blindly: on this machine three backtest processes already
keep ~10 GB of swap in use, and a larger `R` without a matching `maxmemory` turns OPS-01 into OPS-03.


---

## 7. Prioritized action plan

### 7.1 Critical correctness / security fixes before release

| Order | ID | Fix | Size | Proof it is fixed |
| --- | --- | --- | --- | --- |
| 1 | UI-01 | `ValueControl` keeps the raw string; parse on change/blur | S (one component) | `e2e/strategies/value-entry.user.spec.ts` turns red → drop `test.fail()` |
| 2 | ALT-01 | exact money sums in `buildAlternativeDataColumn` | S | "KNOWN DEFECT ALT-01" turns red → drop `.fails`; rerun the alternative-data audit section without tolerance |
| 3 | MON-01 | prune checkpoints only for unlisted members; one-shot replay | S–M | "KNOWN DEFECT MON-01" turns red → drop `.fails` |
| 4 | OPS-06 | invalidate READY manifests only; read PostgreSQL (or wait on the lock) on HYDRATING | S | "KNOWN DEFECT OPS-06" turns red → drop `.fails`; repeat the cold-cache matrix check of §3.5 |
| 5 | DATA-02 | profile-enriched identity through the whole hydration and in the backtest worker (with BT-04); bound by `min(ipoDate, first stored bar)` | S–M | the new first-hydration test; `T01-L11-C01` trades `NEE` from 1999; technicals and fundamentals sections clean for `NEE`/`PLD` after a rebuild |
| 6 | BILL-01 | settle in the Stripe sandbox; then release/rewrite the schedule in the IMMEDIATE branch and add "keep my plan" | S + one sandbox run | a sandbox smoke case in `billing.sandbox.smoke.test.ts` |
| 7 | BILL-02 | expire open Checkout sessions inside the lock; `expires_at` | S | `billing.integration.test.ts` with two sessions |
| 8 | SEC-01 | JSON-only body parsing on the API | S | an urlencoded `POST /auth/login` is refused (`auth.integration.test.ts`) |

### 7.2 Operational readiness before release

| ID | Action |
| --- | --- |
| OPS-02 | Ship the derived-lag condition in `prepareOne`, **or** deploy shortly before the New York close on a weekday; never pre-build r8 with `data:resync` (MON-03). |
| OPS-06 | Without the fix: deploy with no backtest running and warm the monitored universe sequentially before reopening submissions. |
| DATA-03 | Owner ruling on pre-listing filings before the deploy, because the r8 rebuild applies whichever rule is in the code to every stored history; mention the change in the release notes. |
| OPS-01 / OPS-03 | Set `STOCK_CACHE_MAX_RESIDENT_STOCKS` ≥ monitored universe + concurrent backtest securities + API working set, and Redis `maxmemory` ≈ R × 4.64 MiB + 32 MB + concurrency × 4.64 MiB (or run without `maxmemory`); amend PC's rule. |
| MON-03 | Compose `CachedTradingCalendar` into `data:resync` (and decide fmp:live's derived rows) before anyone uses them after this release. |
| OPS-09 / OPS-10 | Set Prisma `connection_limit` per process type; give worker children a heap cap. |
| QA | Run the hermetic E2E and the matrix on the release candidate with the tooling on this branch (§8). |

### 7.3 Valuable, non-blocking (first weeks after release)

MON-02 (hold members on ETF load failure), DATA-01 (persist resolved week ends; correct invariant 15's wording),
FIN-01 (Monitor trigger context after long gaps), FIN-02 (ETF notice against the period), OPS-04 (TTL registration),
OPS-05 (gate polling, backoff), OPS-07/08, QA-07 (a cold stage in the release sweep), UI-02…UI-07, SEC-02…SEC-08, QA-05, PRED-01, MON-04/05/06, FIN-08.

### 7.4 Post-V1 architecture

MAINT-01 (exhaustive source dispatch — do this first, it is an hour), MAINT-05 (registry-driven technical persistence),
MAINT-03 (one runtime factory per process type), a chart-pane registry, MAINT-04 (operand-family descriptor, inside the
next window-based family), per-family derived revisions only if the global rebuild becomes an operational problem, a
result-retention policy, and an owner decision on FIN-03 (amendments) and FIN-07 (after-the-fact closures).


---

## 8. Handoff

- **Branch:** `test/pre-release-audit-qa-matrix`, from `main` @ `bebf3dc7`. **Pull request:** [#108](https://github.com/BMarius93/factorsage/pull/108)
  (open; not merged). The audit's own work is commit `0b95ad7f`.
- **What the branch changes:** QA-matrix fixtures and tooling (`packages/testing/src/qa-matrix/`,
  `apps/api/src/qa-matrix*`), new tests and known-defect pins, two development runbooks, this report. **No production
  source file is modified.**

### 8.1 Commands

| What | Command |
| --- | --- |
| Pin the venue calendar (live FMP, 74 requests, once per dataset) | `QA_MATRIX_CAPTURE_LIVE_CALENDAR=1 pnpm qa:matrix:capture-calendar` |
| Provision the matrix database | `pnpm qa:matrix:provision`, with `DATABASE_URL` naming the refreshed source (this audit: a scratch copy of the development database; the development database itself is only ever read) |
| Preflight one dimension | `pnpm qa:matrix:preflight --strategies core\|audit\|fundamentals\|etf\|sector` |
| Sweep one dimension | `pnpm qa:matrix:run --strategies <set> --concurrency 3` (`--archive-all` for the data-correctness audit) |
| Cold-cache check (§3.5) | flush the matrix Redis index, then `pnpm qa:matrix:run --case <ids> --no-warmup --no-cleanup --no-determinism` |
| Data-correctness audit | `pnpm audit:data-correctness -- --sweep=<core sweep dir> --sections=<list>` |
| Gate | `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm openapi:validate` |
| Hermetic E2E | `pnpm dev:fmp:e2e`, `pnpm dev:api:e2e`, `pnpm dev:worker:e2e`, `pnpm dev:web:e2e`, then `pnpm test:personas:seed && pnpm test:e2e` |

### 8.2 Results on the final tree

| Check | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` (serial; PostgreSQL and Redis suites included, none skipped) | **433 files, 7,229 tests, all pass** — including the 8 `it.fails` pins, each failing as expected |
| `pnpm build` | pass (`apps/web/next-env.d.ts` restored to its development form afterwards; never committed) |
| `pnpm openapi:validate` | pass (66 paths) |
| Hermetic Playwright (`pnpm test:e2e`) | **314 / 314** in 9.0 min, including the 3 `test.fail` pins (UI-01 ×2 observed `75` and `5`; UI-03 observed no confirmation). Fixture FMP requests: 1 (a fixture); egress guard: 1 tolerated framework connection (`registry.npmjs.org` from Next), nothing else |
| QA matrix, five dimensions | 4,996 / 5,000 completed, 0 invariant failures, 4 undecided (FIN-12), 30 / 30 golden reruns identical, 210 / 210 metamorphic, 86 / 86 behaviour coverage, 0 provider requests, 1,247,465 trades (§3.5) |
| Cold-cache rehydration | 60 / 60 identical to warm runs; 7 of 40 core cases failed first time (OPS-06) |
| Data-correctness audit | 92,882,332 comparisons, 134,674 failures, all DATA-02 / DATA-03 (§3.5) |

### 8.3 Not verified — stated, not passed

- **Stripe:** no Stripe operation was authorized. BILL-01 is unsettled; `billing.sandbox.smoke`, the billing persona
  browser suite (`pnpm test:e2e:billing:personas`) and `qa:billing:*` were not run.
- **Live provider:** `packages/stock-data` `test:live` and the data-correctness `source` section (live FMP) were not
  run; nor were its `stock-details` and `ui` sections.
- **Email:** the Mailpit lifecycle suite (`pnpm test:e2e:mail`) was not run.
- **Second entitlement pass** (`pnpm test:entitlements:seed && pnpm test:e2e`) was not repeated.
- **Monitor at matrix scale:** the matrix is backtest-only; Monitor coverage is the PostgreSQL suites (§3.4).

### 8.4 Blockers, risks, next steps

- **Release blockers (§4.1):** code — MON-01, ALT-01, UI-01, DATA-02, OPS-06; Stripe sandbox, then code — BILL-01;
  configuration and deploy timing — OPS-01, OPS-02. **Owner ruling before the deploy:** DATA-03.
- **Remaining risks after those:** the P2s of §4.2, above all SEC-01 (login CSRF), BILL-02 (duplicate Checkout),
  MON-02 (ETF load failure during a replay), DATA-01 (weekly values and venue-schedule reachability), FIN-12/PRED-01
  (exact ties).
- **Next steps:** fix the five code P1s in the order of §7.1 — each has a pinned test that turns red when it is fixed,
  and the pin is then removed; settle BILL-01 in the sandbox; rule on DATA-03, FIN-03 and FIN-07; then, on the release
  candidate, re-run the five dimensions, the cold-cache check and the data-correctness audit (expected: `NEE`/`PLD`
  clean after DATA-02's rebuild; intrinsic clean once DATA-03's ruling aligns oracle and product).
- **Local state left behind (throwaway, safe to drop):** database `intrinsic_value_qa_source` (the scratch copy the
  refresh wrote to) and `intrinsic_value_matrix` (the provisioned matrix); Redis index 3 (matrix). Redis index 9 (the
  refresh) was flushed; indexes 0, 6 and 7 were never touched. Evidence: `.debug/qa-matrix/2026-10-15-*` (five
  sweeps, single-case reruns, four cold-cache runs) and `.debug/data-correctness-audit-2026-10-16/`.

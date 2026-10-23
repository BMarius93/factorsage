# Capacity model

How many people the production deployment (`architecture.md`) serves, derived from the measurements
in `benchmark-results.md` and stated as ranges with their assumptions. Every input is a measurement
(with its source) or an assumption (A1–A10, §2), never a guess presented as a result. The tables in
§3 are computed, not typed: `pnpm --filter @intrinsic/api exec tsx
src/backtest-benchmark/capacity-model.ts` reads `benchmark-results/scale-backtests.jsonl` and
`capacity-assumptions.json` and prints them.

**Scope of the numbers.** Run times were measured on the 4 vCPU benchmark machine against synthetic
34-year histories (`benchmarks.md`). The recommended production host has 8 vCPU (`architecture.md`
§3), so these are the conservative end: with a core per worker and spare cores for PostgreSQL, Redis
and the API, the four-way slowdown (1.21× here) and the cold-rebuild cost should both fall. That has
**not** been measured; the harness runs unchanged on the production host and should be run there
before the numbers are relied on for anything but planning.

## 1. The model

The binding resource is the **four execution slots** — a product rule, so it does not grow with
hardware. Everything else (web, API, the Monitor's end-of-day pass, the provider) is checked against
its own measured capacity in §4 and sized to stay out of their way.

- **Service time** of a run of `n` securities = its measured warm execution time **while four run
  at once** (scenarios H and I; sizes measured only alone are scaled by the measured four-way
  slowdown, A9) **plus** 4.31 s of slot time for each of its members that is not resident in Redis
  (measured: the cold four-way run's extra preparation over the warm one, spread over the 1,000
  securities it rebuilt). Canonical-universe members are always resident; other members are cold
  with probability `c` (A10).
- **Offered load** in the peak hour: `λ = DAU × runs per DAU per day × peak-hour share`, from the
  plan mix (A4), runs per active user (A1) and the peak share (A3). A run's service time is the
  mixture of the plans' list sizes (A2): mean `t̄`, coefficient of variation `cv`.
- **Queue**: the four slots as an M/G/4 queue. Utilization `ρ = λ t̄ / 4`; the mean wait is Erlang C
  with the Allen–Cunneen correction, `Wq ≈ C(4, λ t̄) / (4/t̄ − λ) × (1 + cv²)/2`, and the 95th
  percentile applies the same correction to the exponential tail (`capacity-math.ts`, unit-tested
  against published Erlang C values). These are standard approximations, accurate at the
  utilizations a product should run at; near `ρ = 1` every model agrees the queue grows without
  bound, until the 100-run bound refuses submissions (`503 BACKTEST_QUEUE_FULL`).
- **The capacity of a mix** is the largest DAU whose peak hour stays within both targets (A8):
  utilization ≤ 70 % and p95 wait ≤ 15 minutes.

## 2. Assumptions

| #   | Assumption                                                             | Value                                                                                      | Why this value                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Backtests per **active** user per day                                  | Free 1, Starter 2, Pro 4, Pro+ 8                                                           | A research session iterates on one strategy: a few runs per session, more on the plans bought for it; Pro+ pays for parallel runs, so it is assumed to use them.                                                                                 |
| A2  | List size of those runs                                                | Free 10; Starter 50; Pro 250 (50 %), 500 (30 %), 750 (20 %); Pro+ 500 (30 %), 1,000 (70 %) | Free and Starter at their caps (small); Pro and Pro+ skewed to their caps — the pessimistic side, since run time grows with size.                                                                                                                |
| A3  | Peak-hour share of a day's runs                                        | 12 %; 25 % in the market-close scenario                                                    | Usage concentrated in a few working hours; the market-close scenario puts a quarter of the day's runs in the hour after the close.                                                                                                               |
| A4  | Plan mix of daily active users                                         | per scenario (§3)                                                                          | Six scenarios, from mostly Free to high Pro+ utilization.                                                                                                                                                                                        |
| A5  | DAU / MAU                                                              | 0.25                                                                                       | Typical of a research tool used a few times a week.                                                                                                                                                                                              |
| A6  | MAU / registered                                                       | 0.4                                                                                        | Registered users include dormant sign-ups.                                                                                                                                                                                                       |
| A7  | Concurrent browsing users at peak / DAU                                | 0.0375                                                                                     | 15 % of DAU have a session in the peak hour, averaging 15 minutes (0.15 × 15/60).                                                                                                                                                                |
| A8  | Targets                                                                | utilization ≤ 70 %, p95 queue wait ≤ 15 min                                                | Beyond ~70 % an M/G/c wait grows steeply with small load changes; 15 minutes is a wait a person tolerates for a run they can watch progress on.                                                                                                  |
| A9  | Service time of a size measured only alone                             | alone × 1.21, the measured four-way slowdown (750: 98 → 122 s; 1,000: 132 → 157 s)         | Slots are busy for the time a run takes while the other slots are busy too.                                                                                                                                                                      |
| A10 | Share `c` of a run's non-canonical members not resident when it starts | 0, 25 %, 50 %, 100 % (all reported)                                                        | Depends on how many distinct non-S&P securities the users' lists span against the 500-security LRU — unknown before launch, and the largest single sensitivity in the model. Canonical members: 60 % of each list (the benchmark's mixed lists). |

## 3. Results

### 3.1 Measured service times (warm, 30 years, four at once)

| Securities | Alone (samples) | Four at once (samples) |     Used |
| ---------: | --------------: | ---------------------: | -------: |
|         10 |    0.08 min (3) |                      — | 0.10 min |
|         50 |    0.20 min (3) |                      — | 0.24 min |
|        250 |    0.63 min (3) |                      — | 0.76 min |
|        500 |    1.11 min (1) |                      — | 1.34 min |
|        750 |    1.63 min (1) |           2.04 min (4) | 2.04 min |
|      1,000 |    2.20 min (2) |           2.58 min (8) | 2.58 min |

Plus **4.31 s of slot time per cold non-canonical member** (`H-cold-mixed-shared`: preparation
1,082 s vs 4.3 s warm, four runs sharing 1,000 rebuilt securities).

### 3.2 Capacity of the four slots, by workload mix and cold share

Each cell: mean service time of a run · the four slots' capacity · **the largest DAU within the
targets**.

| Mix (DAU plan shares)                       | Runs / DAU / day | Cold 0 %                     | Cold 25 %                  | Cold 50 %                  | Cold 100 %                |
| ------------------------------------------- | ---------------: | ---------------------------- | -------------------------- | -------------------------- | ------------------------- |
| Mostly Free (85/10/4/1)                     |             1.29 | 0.39 min · 619/h · **2,797** | 1.25 min · 192/h · **869** | 2.11 min · 114/h · **514** | 3.83 min · 63/h · **270** |
| Mostly Starter (30/60/8/2)                  |             1.98 | 0.53 min · 450/h · **1,325** | 1.75 min · 137/h · **404** | 2.96 min · 81/h · **238**  | 5.40 min · 45/h · **127** |
| Mostly Pro (20/20/55/5)                     |             3.20 | 1.13 min · 212/h · **386**   | 4.04 min · 59/h · **108**  | 6.96 min · 35/h · **62**   | 12.78 min · 19/h · **32** |
| Mixed (60/25/12/3)                          |             1.82 | 0.71 min · 340/h · **1,091** | 2.44 min · 98/h · **315**  | 4.17 min · 58/h · **184**  | 7.64 min · 31/h · **94**  |
| High Pro+ (40/20/20/20)                     |             3.20 | 1.45 min · 166/h · **302**   | 5.32 min · 45/h · **82**   | 9.19 min · 26/h · **47**   | 16.93 min · 14/h · **22** |
| Market-close peak (mixed, 25 % in one hour) |             1.82 | 0.71 min · 340/h · **523**   | 2.44 min · 98/h · **151**  | 4.17 min · 58/h · **88**   | 7.64 min · 31/h · **45**  |

Plan shares are Free/Starter/Pro/Pro+ of daily active users.

### 3.3 Queue waits — the mixed mix

All members resident (`c` = 0):

|   DAU | Peak arrivals / h | Utilization | Mean wait |  p95 wait | Mean queued |
| ----: | ----------------: | ----------: | --------: | --------: | ----------: |
|   250 |              54.6 |        16 % |         0 |         0 |           0 |
|   500 |             109.2 |        32 % |         0 |         0 |           0 |
| 1,000 |             218.4 |        64 % |   0.2 min |   1.1 min |         0.7 |
| 2,000 |             436.8 |       128 % | saturated | saturated |   unbounded |

Half the non-canonical members cold (`c` = 50 %):

| DAU | Peak arrivals / h | Utilization | Mean wait |  p95 wait | Mean queued |
| --: | ----------------: | ----------: | --------: | --------: | ----------: |
|  50 |              10.9 |        19 % |         0 |         0 |           0 |
| 100 |              21.8 |        38 % |   0.2 min |   1.0 min |         0.1 |
| 250 |              54.6 |        95 % |  24.4 min |  78.8 min |        22.2 |
| 500 |             109.2 |       190 % | saturated | saturated |   unbounded |

### 3.4 All four slots occupied for an extended period

When arrivals exceed the slots' capacity, the queue grows until its 100-run bound and further
submissions are refused with `503` and a `Retry-After` until it drains. For the mixed mix:

|                                                 | Cold 0 % | Cold 50 % |
| ----------------------------------------------- | -------: | --------: |
| Runs completed per hour, all four slots busy    |      340 |        58 |
| The bounded queue fills at 125 % of capacity in |   71 min |   417 min |
| … at 150 % of capacity in                       |   35 min |   209 min |
| Wait of the 100th queued run                    |   18 min |   104 min |

### 3.5 Users

From the capacity in §3.2 through A5–A7 (rounded):

| Mix, cold share  | Max DAU | MAU (A5) | Registered (A6) | Peak concurrent browsing (A7) |
| ---------------- | ------: | -------: | --------------: | ----------------------------: |
| Mixed, 0 %       |   1,091 |   ~4,400 |         ~11,000 |                           ~40 |
| Mixed, 25 %      |     315 |   ~1,300 |          ~3,200 |                           ~12 |
| Mixed, 50 %      |     184 |     ~740 |          ~1,800 |                            ~7 |
| Mostly Free, 0 % |   2,797 |  ~11,200 |         ~28,000 |                          ~105 |
| High Pro+, 50 %  |      47 |     ~190 |            ~470 |                            ~2 |

These are **backtest-slot** limits; the interactive tier's own limit is §4.1, and the lower of the
two applies.

## 4. Beyond the slots

### 4.1 Interactive traffic

See `benchmark-results.md` §6: the API's latency at 5–100 concurrent browsing users with and
without four backtests executing.

### 4.2 Monitors

See `benchmark-results.md` §7.

### 4.3 FMP request consumption

Measured per security (`benchmark-results.md` §5 and the Monitor EOD V2 record in
`ai/architecture/production-capacity.md`):

| What                                                                                            | Requests                                                               |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| A security seen for the first time (true miss), full ingest with insider and congressional data | ~22 (real FMP sample: 66 for 3 securities)                             |
| … prices, statements and splits only                                                            | ~8–11                                                                  |
| Each later trading session, per maintained security (stock EOD child)                           | ~2                                                                     |
| A rebuild of an evicted security into Redis                                                     | ~0.6 (a one-day price read at its leading edge; 600 per 1,000 rebuilt) |

The deployment-wide FMP gate allows 20 requests/s (72,000/hour); a first-time list of 1,000 new
securities (8,000–22,000 requests) therefore needs 7–18 minutes of provider time alone, inside the
run's preparation and its execution slot. Daily maintenance of a 5,000-security catalog is ~10,000
requests per session.

### 4.4 Cost per active subscriber

The four slots, not the bill, bound capacity: the reference host costs ~€140/month (`architecture.md`
§3; plus off-host backup storage). At the mixed mix's capacity with all members resident (1,091 DAU,
~~4,400 MAU, 40 % of them paying), that is **~~€0.08 per paying subscriber per month**; with half the
non-canonical members cold (184 DAU, ~~740 MAU) **~~€0.47**. The mixed mix's paying users average
~$41.5/month (Starter $19, Pro $49, Pro+ $199 at 25/12/3). Infrastructure is not the constraint at
any of these points; the queue is.

## 5. What moves these numbers, and confidence

| Lever                                                                       | Effect                                                                                                                                                      | Confidence                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Share of cold non-canonical members (A10)                                   | 3–12× on capacity (§3.2)                                                                                                                                    | **Low** until measured in production: watch `stock-data.cache.lru-evicted` and preparation times per run |
| Production host (8 vCPU) vs this machine (4 vCPU)                           | per-run times and the cold cost should fall; not measured                                                                                                   | Medium                                                                                                   |
| Real histories vs synthetic 34-year ones                                    | real ones are shorter on average (0.74 vs 1.05 MB in Redis), so frames and rebuilds cost less                                                               | Medium                                                                                                   |
| Runs per user (A1) and list sizes (A2)                                      | capacity scales inversely                                                                                                                                   | Low — assumptions until usage data exists                                                                |
| Skipping preparation's Redis rebuild for LRU-tier securities (P1 follow-up) | a cold member would cost ~0.7–0.9 s of PostgreSQL window reads over 30 years (~24 ms per security-year measured in `F-ordinary-1y-store`) instead of 4.31 s | Estimated, not measured                                                                                  |
| `STOCK_LRU_MAX_SECURITIES` above 500 (owner decision)                       | fewer cold members; ~0.74 MB of Redis per security on real data                                                                                             | High that it helps; the size needed depends on A10                                                       |

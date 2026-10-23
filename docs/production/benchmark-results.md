# Benchmark results

Measured 2026-10-23 on the cloud development container (4 vCPU Intel Xeon @ 2.10 GHz, 16 GB RAM, no
swap, network block storage; PostgreSQL 16.15 and Redis 7.0.15 on the same machine). How each number
was produced, and what is real and what is synthetic, is `benchmarks.md`; the raw reports are in
`benchmark-results/` and every table here is a projection of them
(`tsx src/backtest-benchmark/summarize-results.ts`).

**Everything below ran against the synthetic provider and synthetic 34-year histories**, except the
one real-FMP sample in §5. Provider-miss timings are FactorSage's own miss path against a provider
that answers instantly unless stated; they are not FMP's latency, rate limit or quota behaviour.

## 1. Stock cache tiers at `STOCK_LRU_MAX_SECURITIES=500`

735 protected (canonical-universe) securities and 1,029 ordinary ones, every one with a complete
stored history. Raw reports: `benchmark-results/lru/`.

| Check                                                                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LRU-500 model check (sequential, from an empty LRU: fill, overflow, re-reads, re-admissions, protected reads between) | 1,392 reads (1,039 LRU, 353 protected); LRU 0 → 500, **536 evictions**; after every read the LRU equals a reference count-bounded LRU **in membership and order** (0 deviations); every evicted security gone whole (0 leftover keys); every read equal to PostgreSQL's rows; never above 500; protected digest unchanged; 0 provider requests. Cold LRU read (rebuilt from PostgreSQL) median **1.86 s**, p95 2.19 s, max 3.68 s; warm LRU read 3 ms; protected read median 3 ms, p95 5 ms |
| Concurrent readers at 500 (6 processes × 120 random reads, 71 % LRU / 29 % protected)                                 | 720 reads, 257 cold, **0 mismatches against PostgreSQL**, 0 errors; read p50 11 ms, p95 4.2 s (cold rebuilds under six-way contention), max 5.9 s; LRU never above 500 across 29,758 samples; nothing left behind by any eviction; protected digest unchanged                                                                                                                                                                                                                               |
| Capacity lowered to 400 under concurrent access (forced eviction)                                                     | the first touch evicted 100 members in **21 ms**, 0 of their keys left; 360 further reads with the LRU never above 400; audit clean                                                                                                                                                                                                                                                                                                                                                         |
| Promotion of an LRU member to protected, and demotion back                                                            | left the LRU with all 72 keys and their bytes unchanged and no TTL; reconciled back, it rejoined as the newest LRU member within capacity, bytes unchanged                                                                                                                                                                                                                                                                                                                                  |
| Protected tier rebuilt from PostgreSQL alone (`protect --concurrency 4`)                                              | 733 published + 2 already resident in **973 s** (16.2 min); 0 provider requests; tier 770 MB (mean 1.05 MB per security, p95 1.19 MB)                                                                                                                                                                                                                                                                                                                                                       |
| Protected residency                                                                                                   | 735 designated, 735 READY, 52,920 keys, **0 keys with a TTL**, 0 orphans, 0 dual residency, 0 violations                                                                                                                                                                                                                                                                                                                                                                                    |
| Redis restart (`SHUTDOWN SAVE`, restart, load ~1.2 GB)                                                                | **15.5 s** until it served again; protected digest identical; 52,920 keys; LRU 400/400 READY; audit clean                                                                                                                                                                                                                                                                                                                                                                                   |
| Redis loss (`FLUSHDB` of the benchmark database), then `protect`                                                      | 735 published from PostgreSQL alone in **875 s** (14.6 min), 0 provider requests, 770 MB; every price and daily-state chunk of the sample **byte-identical** to before the loss (manifests differ only by their publication time); 52,920 keys, 0 with a TTL, audit clean; the LRU starts empty and fills on reads                                                                                                                                                                          |

Redis memory: the synthetic histories cost 1.05 MB per security (34 full years); the real S&P 500
point-in-time universe measured 0.74 MB per security (`docs/decisions/protected-stock-tier-v1.md`).
With both tiers full — 735 protected and 500 LRU securities — `used_memory` was **1.30 GB**.

## 2. LRU contention: a run with more ordinary securities than the LRU holds

Pro+ × 1,000 ordinary securities (no canonical-universe member), one year (two calendar-year
windows), four workers, warm cache, LRU 500 (`F-ordinary-1y-*`).

| Frame read                            | Preparation | Window reads (2025 · 2026)     | Frames from PostgreSQL | Evictions | Result digest |
| ------------------------------------- | ----------- | ------------------------------ | ---------------------- | --------- | ------------- |
| `STORE` (now the default)             | 1,335 s     | **18.7 s** (5.2 · 13.4)        | 1,000                  | 993       | `9070dcbc…`   |
| reference: LRU 1,100, nothing evicted | 846 s       | 4.7 s (2.3 · 2.4)              | 0                      | 0         | `9070dcbc…`   |
| `REBUILD` (the previous behaviour)    | 1 s ¹       | **1,418.7 s** · not finished ² | 0                      | 1,922 ²   | — ²           |

¹ Every security was already resident from the run before, so preparation found nothing to load —
the windows are where the old behaviour pays. ² A container restart at 21:29 UTC ended the run
~16 minutes into its second window; its first window (48 sessions, 2025-10-23 → 2025-12-31) is
measured from the run's own log events (`benchmark-results/F-ordinary-1y-rebuild.interrupted.jsonl`),
and the harness never wrote its report.

The same 48-session window took **1,418.7 s** with the previous behaviour, **5.2 s** with `STORE`
and 2.3 s with nothing evicted: the previous behaviour rebuilt each of the 1,000 securities' full
34-year histories in every window, ~270 times the cost. Over 30 calendar-year windows that is on the
order of twelve hours of rebuilding per run, against minutes. The digests of the two completed runs
are identical: reading a non-resident security's window from PostgreSQL gives the same
result, as the integration test proves value by value. All the evictions in the `STORE` run happened
in preparation, which still rebuilds each non-resident security once (1,000 rebuilds, 22 minutes
here); none happened in the windows.

**Over 30 years** (`F-ordinary-30y`: the same list, 31 windows, alone, `STORE`): execution
**1,681 s (28.0 min)** — preparation 978 s (600 rebuilds from PostgreSQL, 1.6 s each), window reads
680 s (15,500 frames read from PostgreSQL, 500 per window, ~22 s per full-year window), simulation
19 s, persistence 3 s. The 1,000-security mixed list, fully resident, takes 132 s (§3): a list whose
ordinary members exceed the LRU costs ~13× as much, and is the slowest workload measured. With the
previous behaviour the windows alone would have rebuilt 500–1,000 securities each, on the order of
6–12 hours. The worker peaked at 2.08 GB and used 2,875 CPU-seconds in 1,681 s (1.7 cores: part
of its work runs off the JavaScript thread); PostgreSQL had ≤ 18 connections and read 10.2 GB of
blocks — on this machine's network block storage a window read from PostgreSQL costs ~40 ms per security-year, about
ten times a Redis frame read (3.5 ms).

## 3. Per-plan workloads and four simultaneous executions (warm cache)

30-year runs ending on the newest stored session (2026-10-22), the simple strategy (SMA 200
crossover) unless stated, mixed lists (60 % canonical-universe members, 40 % ordinary), four worker
processes, global cap 4, `STOCK_LRU_MAX_SECURITIES=500`, frame read `STORE`. "Execution" runs from
the claim to the committed result; queue waits were under 0.3 s throughout because no run waited for
a slot.

| Scenario         | Runs × securities         |    Samples | Execution (s) median · max       | Preparation | Frame reads | Simulation | Persistence | Worker RSS / process |
| ---------------- | ------------------------- | ---------: | -------------------------------- | ----------: | ----------: | ---------: | ----------: | -------------------: |
| A Free           | 1 × 10                    |          3 | 4.9 · 5.2                        |       0.1 s |       1.3 s |      2.0 s |       1.5 s |              0.29 GB |
| B Starter        | 1 × 50                    |          3 | 12 · 13                          |       0.2 s |       5.7 s |      3.4 s |       2.7 s |              0.32 GB |
| C Pro            | 1 × 250                   |          3 | 38 · 39                          |       0.6 s |        27 s |      7.4 s |       2.8 s |              0.38 GB |
| D Pro            | 1 × 500                   |          1 | 66                               |       0.9 s |        52 s |       11 s |       2.7 s |              0.43 GB |
| E Pro            | 1 × 750                   |          1 | 98                               |       1.4 s |        79 s |       15 s |       2.9 s |              0.44 GB |
| F Pro+           | 1 × 1,000                 |          2 | 132 · 133                        |       1.9 s |       109 s |       19 s |       2.9 s |              0.46 GB |
| G Pro+, one user | 2 × 1,000 at once         |          2 | 137 · 137                        |       2.7 s |       112 s |       20 s |       3.0 s |              0.46 GB |
| H four users     | 750 + 750 + 1,000 + 1,000 | 8 (2 runs) | 750: 122 · 124; 1,000: 153 · 155 |   3.9–4.7 s |    97–126 s |    16–21 s |       3.0 s |              0.50 GB |
| I sizing case    | 4 × 1,000 at once         |          4 | 157 · 158                        |       4.8 s |       130 s |       20 s |       2.8 s |              0.49 GB |

- **Every repeat of the same inputs produced the same result digest** — A, B and C three times, F
  twice, the 1,000-security list across F, G, H and I, and both lists across the cold and warm H.
- **Four at once costs ~1.2× per run** on 4 vCPU (750: 98 → 122 s; 1,000: 132 → 157 s): H and I
  finished all four runs in **2.6 min** each, the CPU 91–97 % busy. Throughput of the four slots on
  this machine: ~92 runs of this mix per hour.
- **Pro+'s two runs execute together** (G: both claimed at once, 137 s each, beside 132 s alone).
- Execution grows linearly, about **0.13 s per security** for 30 years, and is spent mostly reading
  frames (decoding each security's year chunks from Redis, 80 %) and simulating (15 %).
- **Strategy complexity** (Pro × 500, 30 years): simple 66 s; monthly contributions and ten positions
  66 s; sector-ETF conditions 94 s (14 s preparing the sector ETF series); fundamentals, an
  oscillator and a valuation 86 s (simulation 23 s). Four at once with the complex strategy: 3.3 min
  (1,000: 191–195 s, 750: 153 s).

**Bottleneck: CPU.** Worker CPU time matched execution time (each worker runs at about one core,
more during garbage collection), the host was 91–97 % busy with four runs, PostgreSQL used ~0.2 of a
core and Redis ~0.25, memory stayed under 0.5 GB per worker, and the database never had more than 26
connections or 4 active ones. Nothing was FMP-bound: warm runs made no provider request.

## 4. Cold Redis (PostgreSQL → Redis), the same four runs

`H-cold-mixed-shared`: Redis emptied first, so every security — 600 canonical and 400 ordinary,
shared by the four lists — was rebuilt from PostgreSQL inside the runs' preparation (no provider
data was missing).

|                                        |                                                                              Cold |          Warm (H-1, H-2) |
| -------------------------------------- | --------------------------------------------------------------------------------: | -----------------------: |
| Wall time, four runs                   |                                                                      **21.3 min** |                  2.6 min |
| Preparation (median)                   |                                                                       **1,082 s** |                    4.5 s |
| Frame reads · simulation · persistence |                                                         107–114 s · 19–20 s · 3 s | 97–126 s · 16–21 s · 3 s |
| Worker RSS, per process / all four     |                                                                  1.99 GB / 6.6 GB |         0.50 GB / 1.7 GB |
| Event-loop delay p99 (max)             |                                                                    2.24 s (4.8 s) |            0.2 s (0.6 s) |
| Provider requests                      | 608 (600 one-day price reads at the rebuilt securities' leading edge, 8 calendar) |                        0 |
| Result digests                         |                                                                 identical to warm |        identical to cold |

Hydration and computation separate cleanly: the 1,000 rebuilds cost **~4.3 s of slot time per
security** with four workers sharing them (the protected tier alone rebuilt at 0.8–0.84 securities/s,
§1), while computation was the same as warm. The rebuild is CPU-bound (decoding PostgreSQL rows and
encoding the year chunks); PostgreSQL itself used 34 s of CPU over the 21 minutes.

# Benchmark raw results

Every number in `../benchmark-results.md`, `../capacity-model.md` and
`../PRODUCTION-READINESS-REPORT.md` comes from a file here. How each was produced is
`../benchmarks.md`; the exact command sequences are in `drivers/`.

| File                                         | What                                                                                                                                                                                                         | Produced by                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| `scale-backtests.jsonl`                      | one JSON object per backtest-benchmark invocation (scenarios A–I, cold/warm/miss, failure injection)                                                                                                         | `bench:scale-backtests run`              |
| `lru/*.json`, `lru/lru-500.json.gz`          | the stock-cache tier checks: the LRU-500 model check, concurrent readers at 500 and a capacity lowered to 400, promotion and demotion, protected residency before and after a Redis restart and a Redis loss | `bench:stock-cache-tiers`                |
| `lru/phase3.log`, `phase4.log`, `phase5.log` | timestamps, exit codes and Redis memory between the steps of each driver                                                                                                                                     | `drivers/*.sh`                           |
| `interactive-load.jsonl`                     | one JSON object per interactive load level (5–100 users, with and without four backtests)                                                                                                                    | `load:interactive run`                   |
| `browser-journeys.jsonl`                     | Chromium page loads during the same windows                                                                                                                                                                  | `apps/web/load-test/browser-journeys.ts` |
| `submission-probes.jsonl`                    | live admission and entitlement probes against the running API                                                                                                                                                | `src/load-test/submission-probes.ts`     |
| `load-setup.json`                            | the load accounts' creation summary                                                                                                                                                                          | `load:interactive setup`                 |
| `fmp-live-sample-2026-10-23.txt`             | the one real-FMP sample (3 securities, guarded live command)                                                                                                                                                 | `scripts/cloud/fmp-live.sh`              |
| `synthetic-hydration-single.json`            | the same three-security hydration against the synthetic provider                                                                                                                                             | `bench:scale-backtests hydrate`          |

Everything except `fmp-live-sample-*` ran against the **synthetic** provider and synthetic
histories (`../benchmarks.md`, "What is real and what is synthetic").

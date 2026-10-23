# Benchmark drivers

The exact command sequences that produced `../` — run in this order on 2026-10-23, each from the
repository root on the benchmark environment (`../../benchmarks.md`, "Isolation" and "Reproducing"):

| Driver         | What it ran                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `phase3.sh`    | the stock-cache tier checks after the LRU-500 model check: protected-tier rebuild, residency, concurrent readers at 500, capacity forced to 400, promotion and demotion, Redis restart, Redis loss and rebuild |
| `lru-rerun.sh` | the LRU-500 model check (`lru/lru-500.json.gz`)                                                                                                                                                                |
| `phase4a.sh`   | the LRU-contention comparison (`F-ordinary-1y-*`)                                                                                                                                                              |
| `phase4b.sh`   | the scenario matrix A–I, cold and warm, strategy complexity, the LRU worst cases                                                                                                                               |
| `phase4c.sh`   | true provider misses against the synthetic provider                                                                                                                                                            |
| `phase5.sh`    | interactive load and browser journeys, without and with four backtests, and the live admission probes                                                                                                          |
| `phase8.sh`    | the failure and recovery tests                                                                                                                                                                                 |
| `chain-all.sh` | 4b → 4c → 5 → 8, unattended                                                                                                                                                                                    |

They derive the benchmark database from `DATABASE_URL` (`…/intrinsic_value` → `…/intrinsic_value_bench`)
and refuse to run against any database whose name does not end in `_bench`. `phase8.sh` restarts the
local Redis server (`redis-cli SHUTDOWN SAVE` and `redis-server /etc/redis/redis.conf`), which is
specific to the development container they ran in.

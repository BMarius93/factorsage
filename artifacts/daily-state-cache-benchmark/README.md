# Daily-state Redis chunk: evidence

Evidence for the column-oriented `daily-state` chunk (encoding 2). The decision, its reasoning and
its numbers are in `docs/decisions/retain-wide-column-calculated-series-storage.md`, section "Redis
chunk layout".

All four files were produced on the frozen QA-matrix copy (`intrinsic_value_matrix`: 33
securities, full retained history, data as of 2026-09-28). In every run the provider was refused and
every process ran under `packages/testing/egress-guard.cjs`. No run reached the provider, and the
copy's derived rows were fingerprinted as unchanged afterwards.

**Machine-specific.** Byte counts, Redis `MEMORY USAGE` and every parity result reproduce anywhere.
Timings do not. They were taken on one development machine: Apple M1, 8 cores, 8 GB, Node 22.23.2,
Redis 7.4.11 with jemalloc 5.3.0. Compare the two encodings within a file, not against another
machine.

| File | What it is | How it was produced |
| --- | --- | --- |
| `report.json` | Both encodings on the same PostgreSQL rows: per-security footprint by key family, byte-for-byte parity of every chunk, CPU, garbage collection, retained heap, warm product reads and their Redis commands, synthetic worst cases, capacity, and simulated valuation-ratio columns | `pnpm bench:daily-state-cache` (`apps/api/src/cache-benchmark/`), at the commit it records |
| `baseline-main.json` | The row-oriented layout measured with `main`'s own cache and service at `81f53560`, before any change | A one-off harness around `main`'s build; it agrees with `report.json`'s "before" column |
| `cross-version-parity.json` | `main`'s build and this change's build compared on what every consumer reads (1,023 backtest frame windows, 660 Stock Details projections, 99 Monitor frames), 17 backtests re-executed through the real `BacktestProcessor`, and a deploy transition from a version-1 namespace | One-off harnesses run against a detached `main` worktree and this branch |
| `mutations.json` | 21 controlled mutants of the final code, each run against the codec, cache and Redis/PostgreSQL suites and restored byte for byte | A one-off harness |

To re-measure after a series family is added:

```bash
pnpm infra:up
NODE_OPTIONS=--expose-gc pnpm bench:daily-state-cache
```

The command needs a provisioned matrix copy (`docs/development/qa-matrix-runner.md`), and
`--expose-gc` adds the retained-heap figures. Use `--symbols=WMT,AAPL` for a quick run and `--out=…`
to write the report somewhere else.

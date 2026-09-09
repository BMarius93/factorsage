# Backtest debug archives

Developer-only forensic capture. It is off by default, it never runs in production, and it cannot
change what a backtest computes.

## What it is for

A backtest result is a set of numbers. When the numbers look wrong, the question is always the same:
_did the engine decide correctly given what it actually saw?_ — and neither the run's stored result
nor its logs can answer it, because the inputs the day loop consumed are transient. The evaluation
frames live for one calendar year and are released; the row carried across a year boundary for
Trigger semantics is never persisted at all.

With `BACKTEST_DEBUG_ARCHIVE=full`, each worker child writes one self-contained `.zip` per backtest
attempt holding those inputs, the state carried between windows, and the outputs — enough for
another engineer or another model to reconstruct the run independently and disagree with it.

## Why it stores evidence rather than explanations

The archive deliberately contains **no engine-produced reasoning**. There is no

> BUY because Price crossed EMA50

anywhere in it, and adding one would defeat the purpose. The same code produced the decision and
would produce the explanation, so a bug that made the wrong trade would also write a matching wrong
justification and the two would agree perfectly. The archive would then confirm every bug it was
built to find.

What it stores instead is the raw material the decision was made from: the immutable snapshot, the
execution calendar, the benchmark closes, the funding events, the exact frame rows the simulation
was bound to, and what the run produced. A reviewer re-derives the signals from the same inputs and
compares. Agreement then means something.

## Enabling it

```bash
BACKTEST_DEBUG_ARCHIVE=full \
BACKTEST_DEBUG_ARCHIVE_DIR=.debug/backtests \
pnpm dev:worker
```

| Variable                     | Values          | Default            |
| ---------------------------- | --------------- | ------------------ |
| `BACKTEST_DEBUG_ARCHIVE`     | `off` \| `full` | `off`              |
| `BACKTEST_DEBUG_ARCHIVE_DIR` | any path        | `.debug/backtests` |

`BACKTEST_DEBUG_ARCHIVE_DIR` is optional; the default is used whenever capture is on. A relative
path resolves against the **repository root**, not the cwd, because `pnpm dev:worker` runs inside
`apps/worker` and the default would otherwise scatter one archive directory per package. The default
directory is git-ignored (`.debug/`).

Only the worker reads this. The API does not, the Backtest API contract has no `debug` field, and
the run snapshot carries no archive configuration — `apps/worker/src/backtest/debug/archive-boundaries.test.ts`
fails the build if `apps/web`, `apps/api` or `@intrinsic/contracts` ever mention it.

**It cannot run in production.** `BACKTEST_DEBUG_ARCHIVE=full` with `NODE_ENV=production` is a
configuration error at startup, not a request that is quietly honoured: an archive holds a user's
whole run on a local disk that nothing rotates. Off is startable everywhere.

## Where archives land, and how they are named

```text
.debug/backtests/backtest-debug-<runId>-attempt-<attempt>.zip
```

`attempt` is `BacktestJob.attempts` at claim time — the canonical attempt identity. A run has
exactly one job row and the counter increments on every claim, so `runId + attempt` is unique per
attempt and a retry can never overwrite the archive of the attempt that failed. The `jobId` is
recorded inside `manifest.json` because it is what a log search keys on, not because it distinguishes
attempts. (A numeric `-2`, `-3` … suffix guards a collision that should be unreachable.)

Capture is incremental. Each window's frames, trades and equity are written as the window is consumed
and then dropped, so a thirty-year run still costs one calendar year of resident projection, and a
run that dies in year 20 leaves 19 years of evidence on disk. Staging happens in
`.debug/backtests/.staging/<name>-XXXXXX/`; the finished zip is written to a `.part` file and renamed,
which is atomic within a filesystem. A worker killed mid-run therefore leaves an obvious stray
staging directory rather than a truncated `.zip` that looks complete. Staging is removed on success.

## Archive layout

```text
backtest-debug-<runId>-attempt-<n>.zip
  manifest.json                    archive schema version, run/attempt identity, build, revisions
  README.json                      this layout, in the archive itself
  snapshot.json                    the immutable BacktestRunSnapshot the attempt executed
  preparation/
    summary.json                   per-security hydration ranges, coverage, durations, provider traffic
  inputs/
    execution-calendar.json        the authoritative calendar handed to the simulation
    benchmark.json                 the raw benchmark closes
    contributions.ndjson           every external cash flow the simulation applied
  frames/
    <year>/<SYMBOL>-<securityId>.json    the EvaluationFrame the day loop was bound to
  execution/
    windows.ndjson                 one record per calendar-year window
    checkpoints.ndjson             the state carried across each year boundary
  result/
    trades.ndjson                  every trade, in execution order
    equity.ndjson                  every simulated day
    positions.json                 final open positions
    summary.json                   final summary metrics
  diagnostics/
    timings.json                   phase durations
    failure.json                   only for a failed attempt
```

`manifest.json` carries `archiveSchemaVersion` — currently `1`. It versions the **diagnostic file
layout** and nothing else: it is not a Backtest methodology version, adding a field to it cannot
change what a run computes, and changing a methodology does not reorganize these files. Bump it when
a reader written against the previous layout would misread the next one.

JSON where a document is read whole and NDJSON where the size follows the run's length (equity,
trades, contributions, windows, checkpoints) — so a window can flush its rows and forget them, and a
reviewer can stream a thirty-year curve instead of parsing one enormous array.

### Evaluation frames

This is the part that matters most, and the part that exists nowhere else.

```json
{
  "securityId": "3aa17368-…",
  "symbol": "AAPL",
  "window": {
    "year": "2024",
    "index": 1,
    "requestedFrom": "2024-01-01",
    "requestedTo": "2024-12-31",
    "firstSimulatedDate": "2024-01-02",
    "lastSimulatedDate": "2024-12-31",
    "simulatedDates": 252
  },
  "rowCount": 253,
  "contextRowCount": 1,
  "contextRowDates": ["2023-12-29"],
  "periodStartIndex": 1,
  "dates": ["2023-12-29", "2024-01-02", "…"],
  "closes": [192.53, 185.64, "…"],
  "operandKeys": ["series:RSI_14D"],
  "operands": { "series:RSI_14D": [51.06184468, 35.37236594, "…"] }
}
```

- Columnar and date-aligned: `dates[i]`, `closes[i]` and `operands[k][i]` describe the same row.
- **Only the operands the Strategy references**, keyed by the canonical operand id from the existing
  selectable-series catalog (`price`, `series:<SERIES_ID>`, `margin-of-safety:<SOURCE_ID>`). There is
  no second naming system, and no dump of every derived-state column.
- `closes` is the `price` operand; it is not repeated inside `operands`.
- It is the frame **as bound by the engine**, after the retained context row was spliced in — not the
  frame the loader returned. That distinction is the whole point of the next section.

### Trigger context across a year boundary

`evaluateMarketTrigger` reads exactly `index - 1` of a security's own frame, so `Price crosses above
EMA` on the first eligible date of a year needs the one preceding eligible row — which may be days or
years earlier. The engine retains that row per security and splices it in front of the next window
(`ai/architecture/backtest-execution.md`).

The archive preserves it and labels it:

- rows `[0, contextRowCount)` are **read-only context**. They precede the window's first requested
  date, no execution-calendar date falls on them, and they never produce a trade, a contribution or
  an equity point;
- the first simulated row is at index `contextRowCount`;
- `contextRowDates` names them, and `execution/checkpoints.ndjson` repeats the same row under
  `retainedContextRows` so continuity is checkable without opening the next year's frames.

In the example above, `2023-12-29` is the context row and `2024-01-02` is the first simulated row, so
a crossing on `2024-01-02` can be verified against the exact prior value the engine saw.

`contextRowCount` is derived from the dates rather than from `periodStartIndex`, because the latter is
whatever the loader reported before the engine shifted every index by one. Both are recorded.

### Number encoding — `null` vs `0`

Internally `NaN` is the single representation of an **absent / NOT_EVALUABLE** value, and numeric zero
is a real reading: `RSI = 0` and `Margin of Safety = 0` are answers, not missing data. JSON cannot
represent `NaN`, so the archive states its encoding rather than relying on `JSON.stringify` doing the
right thing by accident:

| Engine value            | Archive |
| ----------------------- | ------- |
| `NaN` (absent)          | `null`  |
| `±Infinity`             | `null`  |
| real `0`                | `0`     |
| any other finite number | itself  |

Applied deliberately at every numeric field the archive writes, and covered by regression tests
(`archive-boundaries.test.ts`, and end to end in `backtest-debug-archive.test.ts`). No archive file
contains the token `NaN`, so every file is parseable JSON.

### Execution calendar, benchmark and contributions

Three inputs a reviewer cannot reconstruct from the result:

- **`inputs/execution-calendar.json`** is the calendar handed to the simulation, read from the pinned
  reference series — never re-derived from the security frames. That is what lets a reviewer see that
  a security row on a day the market was closed was correctly ignored: the row is in the frame and the
  date is not in the calendar.
- **`inputs/benchmark.json`** is the raw close series, not the `benchmarkValue` curve derived from it.
  The curve is what is being checked, so an archive carrying only the curve could not check it. With
  the closes and the funding events, `shares += contribution / closeAt(date)` and
  `value = shares × closeAt(d)` reproduce the funded scenario exactly.
- **`inputs/contributions.ndjson`** is every external cash flow the simulation applied, typed
  `INITIAL_CAPITAL` or `MONTHLY_CONTRIBUTION`, with its date, amount, resulting cash and cumulative
  invested capital. Reported by the engine, not inferred: it is what lets a reviewer compare the
  funding schedule the snapshot and calendar imply against the deposits that actually happened, and
  confirm all three comparison scenarios received identical external cash.

### Continuation checkpoints

`execution/checkpoints.ndjson` holds one allowlisted record per completed window: cash, positions
value, total value, invested capital, realized P&L, the return index and its previous total value, both
drawdown accumulators, the trade sequence, each open position (shares, cost total, average cost, last
mark, epoch, settled BUY levels, fired SELL levels and the position-dependent value a Trigger compares
against tomorrow), position epochs, the benchmark scenario's shares and pending capital, the cash
baseline, and the retained context rows.

It is an **explicit diagnostic shape, never a serialization of engine internals** — so a private field
added later cannot silently start leaving the process — and it is a cross-check, never an input. The
next window continues from the live in-memory state exactly as it always has; nothing reads a
checkpoint back.

## Security and redaction policy

Secrets stay out **by construction, not by cleanup**. Every field is built from an explicit allowlist;
nothing serializes the environment, a config object, a connection or a request. The archive therefore
never contains passwords, cookies, `Authorization` headers, JWTs, FMP API keys, database or Redis URLs,
OAuth credentials or test credentials, and it does not contain the user's identity — `actorUserId` is
deliberately not recorded.

The single exception is text the archive did not construct: an exception's message and stack in
`diagnostics/failure.json`. Those are worth keeping and can carry a provider URL with a key in it, so
they are scrubbed on the way in — URLs are replaced wholesale, and credential-shaped key/value pairs
and `Bearer`/`Basic` tokens are redacted (`debug/redaction.ts`).

What the archive **does** contain is the user's own run: their stock list's symbols, their strategy
definition, their capital and contribution amounts, and every trade and daily value. Treat an archive
as you would the run itself before sending it anywhere.

## Failed attempts

A failed attempt is the most useful archive there is, so it is written rather than discarded. It holds
the manifest, the snapshot, every input captured before the failure, every completed year's frames and
windows, the latest checkpoint, the trades and equity produced so far, and `diagnostics/failure.json`
with the failure code, the phase, the window in flight, the scrubbed error, and how much was captured.
It has no `result/summary.json`, because a failed attempt has no result.

`manifest.json` records `run.status` as `COMPLETED`, `FAILED` or `INTERRUPTED` (the worker lost its
lease or was shut down mid-run).

## The archive can never change a run

This is the invariant the feature is built around, and it holds in both directions:

- **Capture on and capture off produce identical financial results** — trades, trade ordering,
  contribution dates, fills, positions, cash, equity, all three comparison values, every summary metric
  and the terminal status. Asserted in `apps/worker/src/backtest/backtest-debug-archive.test.ts` and,
  at the engine level, in `packages/strategy/src/backtest/simulation.diagnostics.test.ts`.
- **An archive failure never fails a backtest.** Every capture step swallows its own error, reports it
  once as `backtest.debug-archive.failed` through `@intrinsic/observability`, and disables the rest of
  that attempt's capture — the second failure is almost always the same failure, and a half-written
  archive that kept retrying would bury the log line that says what went wrong. The engine observer is
  guarded inside the archive rather than at the call site, because it runs inside `consumeWindow` where
  an unguarded throw would fail a valid run.
- **A successful archive never rescues a failed backtest**, and a failing archive never demotes a
  successful one. The run's own outcome is decided before `finalize` is reached.

With capture off there is no archive object at all: the processor's dependency is absent, so nothing
can touch the disk.

## Handing an archive to a reviewer

It is one file. Send the `.zip`. It carries `README.json` describing its own layout, the number
encoding and the Trigger-context rule, so a reviewer needs no context from this repository — but
review the run's contents first, per the policy above.

A useful prompt for an external reviewer: _"Here is a forensic archive of one backtest. Using only the
inputs in it — the snapshot's strategy definition, the execution calendar, the frames and the funding
events — independently determine which BUY/SELL signals should have fired on which dates, and compare
against `result/trades.ndjson`. Absent values are `null`; a real zero is `0`. Rows before
`contextRowCount` in a frame are read-only Trigger context."_

## Limitations

- **Worker-time only.** There is no `backtest:debug:export --run-id <id>` command. The frames and the
  transient execution state exist only while the worker is running, so a historical export from the
  database could never contain the most valuable part of the archive.
- **Not all preparation detail is attributable.** Redis projection hit/miss/rebuild and PostgreSQL
  repair/fallback are performed inside the canonical projection read, which reports nothing back to its
  caller. `preparation/summary.json` names those under `unattributable` rather than guessing — a
  fabricated cache-hit number would be worse than none, because it would be believed. Provider request
  counts **are** attributable, because a worker child executes at most one backtest at a time.
- **No run-scoped log capture.** Reusing `@intrinsic/observability` to tee a run's structured events
  into the archive would mean redesigning the logger; the structured timings, window and preparation
  metadata cover V1's needs.
- **`archiveSchemaVersion` is 1 and there is no reader library.** Consumers parse the JSON directly.
- **Local filesystem only.** Nothing is written to PostgreSQL or Redis, no table exists, and archives
  are never uploaded anywhere.

## Related

- `ai/architecture/backtest-execution.md` — the lifecycle, annual windows and execution methodology
  this captures.
- `ai/architecture/observability.md` — the logging rules the archive's events follow.
- `docs/decisions/backtest-year-window-execution-and-absolute-comparison.md` — why the run is executed
  one calendar year at a time, and why a retained context row exists to be captured.

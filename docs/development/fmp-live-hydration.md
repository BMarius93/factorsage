# Guarded live FMP hydration

`pnpm fmp:live` hydrates the **full supported history of at most three securities** from the real
Financial Modeling Prep API into a local development database, through the product's own loaders.

It is a deliberate developer and QA tool. It is not a way to "turn FMP on": it cannot start a stack
with a provider key, it cannot load a list, a universe or a benchmark, and it stops when its
request budget is spent.

```bash
# What would be asked. Sends nothing, needs no key and no opt-in.
pnpm fmp:live -- --symbols AAPL --full-history --plan

# One security.
RUN_LIVE_FMP_HYDRATION=1 pnpm fmp:live -- --symbols AAPL --full-history

# Three securities, the maximum.
RUN_LIVE_FMP_HYDRATION=1 pnpm fmp:live -- --symbols AAPL,MSFT,NVDA --full-history
```

In a Claude cloud session, use the wrapper instead of `pnpm fmp:live` (§9):

```bash
RUN_LIVE_FMP_HYDRATION=1 scripts/cloud/fmp-live.sh --symbols AAPL --full-history
```

## 1. What a run needs

| Requirement                               | Why                                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUN_LIVE_FMP_HYDRATION=1` on the command | The only thing that authorizes a run. Exactly `1`. A configured key authorizes nothing, and neither does `RUN_LIVE_FMP_TESTS`               |
| `LIVE_FMP_API_KEY`                        | The only variable the key is read from. `FMP_API_KEY` is never a substitute, so a developer's ordinary key is not spent on this by accident |
| `DATABASE_URL` on this machine            | `localhost`, `127.0.0.1` or `::1`, not `NODE_ENV=production`, and not a database named `…test…` or `…matrix…` (§7)                          |
| `REDIS_URL` on this machine               | The loaders' cache, hydration lock, provider gate and the run's budget counter live there                                                   |
| A migrated database                       | `pnpm db:migrate:deploy`. The catalog may be empty: a symbol it does not hold is admitted from its own profile (§3)                         |

Never export `RUN_LIVE_FMP_HYDRATION` for a shell or a session. Set it on the one command.

## 2. The command line

```text
pnpm fmp:live -- --symbols <list> --full-history [--budget <n>] [--plan]
```

| Argument         | Meaning                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--symbols`      | Required. One to three securities, comma-separated. Trimmed and upper-cased; duplicates collapse **before** the count, so `AAPL,aapl, AAPL` is one |
| `--full-history` | Required. It is the only mode, and it is named so that a later, narrower mode can never become the default by omission                             |
| `--budget`       | Optional. Total provider requests the run may send: 1 to 600, default 200 (§5)                                                                     |
| `--plan`         | Resolve the symbols from the catalog and print what a run would hydrate and cost. Asks the provider nothing; its process holds no key              |

Anything else is refused: an unknown flag, a flag given twice, a stray word, a missing value, an
empty list entry, something that is not a symbol, a fourth distinct security. The command line is
parsed before any variable is read, so a refused command line has touched nothing.

Exit codes: `0` success (or a plan), `1` the run failed, `2` the command line or the environment was
refused before a run existed, `3` the request budget was exhausted.

## 3. Why three, and what "a security" means

Three is a product decision: enough to exercise every per-security dataset on more than one company
and to compare them, small enough that a run cannot become a universe load by accident.

The limit is not a property of the command line. It is enforced where the provider is asked:

- `FmpClient` has one private `request(path, query)` that every provider call goes through. A live
  run's client carries a **guard** there (`packages/fmp/src/request-guard.ts`). Production clients
  carry none.
- The guard holds an `FmpSecurityScope` built from the approved symbols. It counts them itself and
  cannot be built for a fourth. It has no method that adds a security afterwards.
- Every request is authorized before the key is read, before the shared gate is entered and before
  anything is sent. A request about anything else is refused there, whichever loader, helper or
  retry asked.

A symbol is not an identity. The loaders hydrate a `Security` — a catalog row with an id — so:

1. each approved symbol is resolved through `CanonicalStockDataService.getSecurity`, the catalog
   lookup every surface uses. This asks the provider nothing;
2. a symbol the catalog does not hold may be asked for exactly one thing, its `profile`, to learn
   what it is. That costs one request per such symbol;
3. the scope is then **bound** to the catalog securities. Every other dataset is refused for a
   symbol that has not been bound, and a symbol is bound to one security only.

### The one thing this mode does that production does not

In production a `Security` comes into existence only through the catalog synchronization
(`POST /admin/securities/sync`), which downloads every listing on every supported exchange. A live
run may not do that — it is the universe-wide request this mode exists to forbid — and a fresh
development database has an empty catalog. Every Claude cloud session starts with one.

So a symbol the catalog lacks is admitted from **its own profile**. The unchanged
`CanonicalSecurityCatalogService` is run with a provider port that returns only the approved
symbols' listings (`apps/api/src/fmp-live/fmp-live-identity.ts`). The same rule decides admission
(common stock, on NASDAQ, NYSE or AMEX) and the same writer creates the row, so a later real
synchronization finds rows it recognises. A run that names a fund, a foreign listing or a symbol the
provider does not know stops there, before any history is asked for.

If the provider answers a profile request under a _different_ symbol than the one asked, the run
refuses that symbol. The two may well be one company, but the security the provider named was not
approved.

## 4. What "full history" includes

Only what the product already loads, per security, through a loader this command calls unchanged.
Nothing was added to make the phrase broader.

| Dataset                                                                              | Provider endpoint(s)                                                 | History                                                                       | Loader                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| Security identity                                                                    | `profile`                                                            | One row; only for a symbol the catalog lacks                                  | `CanonicalSecurityCatalogService.sync`           |
| Security profile                                                                     | `profile`                                                            | One row: CIK, ISIN, listing date, description                                 | `CanonicalStockDataService`, once per security   |
| Daily prices                                                                         | `historical-price-eod/full`                                          | 34 years: the 30-year product horizon plus the derived-series warm-up         | `getDailyDerivedState`                           |
| Financial statements                                                                 | `income-statement`, `balance-sheet-statement`, `cash-flow-statement` | 37 years, quarterly and annual: the horizon plus the valuation warm-up        | `getDailyDerivedState`                           |
| Daily derived state: technicals, weekly state, intrinsic values, Fundamental Metrics | none                                                                 | Every trading day of the product horizon, calculated locally                  | `getDailyDerivedState`                           |
| Split list                                                                           | `splits`                                                             | The provider's whole list                                                     | `getDailyValuationRatio`                         |
| Valuation ratios (P/E, P/S, P/B, P/FCF, EV/EBITDA)                                   | none                                                                 | Computed on read from stored closes, statements and splits; nothing is stored | `getDailyValuationRatio`                         |
| Insider transactions (Form 4)                                                        | `insider-trading/search`                                             | Paged back from the newest filing, up to 12 pages of 1,000                    | `CanonicalAlternativeDataService.ensureIngested` |
| Congressional trades                                                                 | `senate-trades`, `house-trades`                                      | Paged back from the newest disclosure, up to 12 pages of 250 per chamber      | `CanonicalAlternativeDataService.ensureIngested` |

Per security a run makes three calls, in order: `getDailyDerivedState` over the whole product
horizon (the read `pnpm data:resync` makes), `getDailyValuationRatio` for each of the five ratios
(the Stock Details read, which is what refreshes the split list), and `ensureIngested` for both
alternative-data domains (what `pnpm data:alt-data:ingest` calls). There is no downloader in
`apps/api/src/fmp-live/`: a test reads the source and fails if anything there writes a row.

**Freshness is the loaders' own.** A dataset inside its freshness window is not asked for again.
A second run a minute after the first sends nothing, and the report says so per dataset.

## 5. The request budget

Every run has a hard cap on the provider requests it may send, in addition to the shared gate's
concurrency limit and rate window.

- **One unit per request that reaches the network.** A retry is another request and another unit.
  A request refused by the scope costs nothing, and neither does one that timed out in the gate's
  queue: the unit is taken inside the gate's slot, immediately before the request is sent.
- **Atomic.** The counter is in Redis, beside the gate's own keys (`stock-data:v2:fmp:budget:<run>`),
  and the check and the increment are one Lua script. However many callers race for the last unit,
  one gets it.
- **Fails closed.** When the budget is spent the next request is refused, the guard closes, no
  further request is sent, the run exits `3` and the report's first line says what is stored is
  incomplete. A later run with a larger budget continues from what the loaders stored.

### How the default was derived

From the loaders' own bounds, not from a guess (`liveFmpRequestCeiling`, held to the constants by
`fmp-live-plan.test.ts`). The most one cold security can cost, with no retry:

| Cause                                 | Requests |
| ------------------------------------- | -------- |
| Identity (only if not in the catalog) | 1        |
| Profile                               | 1        |
| Prices: 34 years in 5,000-row pages   | 2        |
| Statements: 3 types × 2 cadences      | 6        |
| Split list                            | 1        |
| Insider trades: page bound            | 12       |
| Congressional trades: page bound × 2  | 24       |
| **Total**                             | **47**   |

| Securities | Ceiling, no retry | Ceiling, every request retried three times |
| ---------- | ----------------- | ------------------------------------------ |
| 1          | 47                | 188                                        |
| 3          | 141               | 564                                        |

- **Default 200**: three cold securities at every page bound, with headroom for retries.
- **Maximum 600**: the same run with every request retried to the client's limit. Nothing a
  three-security run can legitimately need lies beyond it.

A real run sits well below the ceiling. The repository's own capacity measurements put a first
hydration at about eight requests per security for the profile, prices and statements
(`ai/architecture/production-capacity.md`); the split list adds one, an uncatalogued symbol one
more. The insider and congressional page counts depend on the company and **have not been measured
against the live provider yet** — that is what the first cloud run records (§9).

## 6. What a run never does

Each of these is refused at the client by the scope, and none of them is composed into the run in
the first place. A test reads the source for both.

| Operation                                                         | Endpoint(s)                          | Why it is excluded                                                                                             |
| ----------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Security catalog synchronization                                  | `company-screener`                   | Provider-wide: every listing on an exchange                                                                    |
| Member catalog synchronization                                    | `senate-profile`                     | Provider-wide: the whole directory of members of Congress, which is about no security                          |
| Exchange trading calendar                                         | `holidays-by-exchange`               | Provider-wide: a venue's schedule, held in memory by the workers and never stored                              |
| Benchmark series (SPY, `^GSPC`, `^DJI`, `^VIX`)                   | `historical-price-eod/full`          | Each is another provider symbol, not one of the approved securities                                            |
| Stock EOD preparation for Monitors, incl. the built-ins' thirty   | calendar, prices, statements         | Hydrates every current member of every running Monitor's list. No worker is started, and a worker holds no key |
| Backtests and the QA matrix                                       | prices, statements, a benchmark      | Hydrates a whole Stock List, up to 200 securities, and 33 for the matrix                                       |
| Form 13F institutional holdings                                   | —                                    | Not part of the product (`AGENTS.md` invariant 23)                                                             |
| Company logos                                                     | —                                    | The web app reads the provider's unmetered image host; no key, no dataset                                      |

Consequences worth knowing before relying on a live-hydrated database:

- **No benchmark data.** The market overview and a backtest's comparison need the benchmark series,
  which this command does not load.
- **The QA matrix is still not possible in the cloud.** It needs 33 securities.
- **A Monitor on a live-hydrated security decides only the sessions already stored** in a stack
  without a provider key. The Monitor evaluation reads PostgreSQL alone, but the stock EOD
  preparation that stores each new session needs the provider (`docs/decisions/monitor-eod-v2.md`).
- **A stack without a provider key can read the data only while it is fresh.** Once a newer session
  is final (16:30 New York) — or after six hours for statements — the loader wants to refresh the
  recent tail, cannot, and the read fails. Run the command again (it asks only for what is stale), or
  start the stack with `EOD_TAIL_REFRESH=frozen` and a longer `STOCK_FUNDAMENTALS_FRESHNESS_MS`
  (`docs/decisions/eod-finality-v1.md`).

## 7. Where the data goes

Into the database `DATABASE_URL` names, and the Redis `REDIS_URL` names, and nowhere else.

| Refused                                                                 | Reason                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `NODE_ENV=production`                                                   | Development-only tool                                                                                   |
| A database or Redis host that is not loopback                           | There is no override. A development tool does not get to decide a remote database is disposable         |
| A database named `…test…` or `…matrix…`                                 | They hold deterministic fixtures; a real payload in either is a defect. Same rule as `pnpm data:resync` |
| `DATABASE_URL` equal to `TEST_DATABASE_URL` or `QA_MATRIX_DATABASE_URL` | The same database, whatever it is called                                                                |

A production database tunnelled to a local port is the one thing a host check cannot see. Do not
run this with such a tunnel open.

Provider data is licensed. It lives in the development database and Redis only:

- nothing is written to git, a snapshot, a fixture or a document by this command;
- the report prints names, counts, dates and durations, read back with aggregate queries. It never
  prints a row, a response or the key;
- logs carry the same structured events every loader already writes (`stock-data.provider.request`,
  `alternative-data.provider.request`: symbol, dataset, range, reason) plus
  `fmp.live.run.started`, `fmp.live.run.completed` and `fmp.live.request.refused`.

`LOG_LEVEL=debug` on the command shows every provider request with the loader's reason for it.

Do not copy rows out of a live-hydrated database into a fixture, a test or a pull request.

## 8. Secrets and process environment

The key exists under the name the application reads in exactly one process.

1. `pnpm fmp:live` starts a **launcher** (`apps/api/src/fmp-live.ts`). It parses the command line,
   loads `.env`, requires the opt-in, vets the database and Redis, and only then looks for
   `LIVE_FMP_API_KEY`. It opens neither the database nor the provider.
2. The launcher starts one **child** with an allowlisted environment
   (`liveFmpChildEnvironment`): how to run a process, `DATABASE_URL`, `REDIS_URL`, and the tuning
   variables the loaders' configuration reads. In that environment the key is `FMP_API_KEY`.
   `LIVE_FMP_API_KEY` itself is not passed on, and `FMP_BASE_URL` is never present.
3. The child does not load `.env`. It re-parses the command line and re-checks the opt-in, the
   target and the credential's shape, so running that file directly gets no further than running
   the launcher.

Two things about how the child reaches the network:

- **`NODE_EXTRA_CA_CERTS` is passed on** when the launcher has it. It is the path of a bundle of
  certificate authorities to trust, not a credential, and Node reads it once, when a process
  starts, so it can only be inherited. An environment whose outbound TLS is inspected sets it for
  every process; without it the child cannot verify the provider's certificate there, and every
  request fails. Nothing else about TLS is passed: not `SSL_CERT_FILE`, and never
  `NODE_TLS_REJECT_UNAUTHORIZED`.
- **No proxy configuration is passed on**, in any spelling: `HTTPS_PROXY`, `http_proxy`,
  `ALL_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY` and anything else with `proxy` in its name. A proxy
  URL routinely embeds a credential. The child also refuses to start if it finds one.

Every report, a plan's included, ends with what the process that produced it actually holds, by
name and never by value:

```text
Process environment of this run (names only): 14 variables, every one from the launcher's allowlist.
  provider credential (FMP_API_KEY): present, in this process only
  extra CA certificates (NODE_EXTRA_CA_CERTS): present
  proxy variables: none
```

Nothing else reads `LIVE_FMP_API_KEY`: not `getFmpConfig`, not the API, the worker or the web app.
A process that merely inherits the variable has no provider credential. On top of that:

- `next dev` is started with an allowlist that does not include it;
- the hermetic E2E launcher blanks it, and the opt-in, for the API, the worker and the web;
- `scripts/cloud/stack.sh` unsets it before starting either stack.

## 9. Claude Cloud

### What is and is not enforced by the network

The cloud network allowlist is **environment-level**: a domain on it is reachable by every process
in the VM. It cannot be scoped to one command, and it is configured in the Claude environment, not
in this repository. So once `financialmodelingprep.com` is allowed, the network no longer stops
anything, and the authorization boundary is what this document describes: no key under a name the
application reads, the per-command opt-in, the security scope, the request budget and the database
guard.

Keep `financialmodelingprep.com` **off** the allowlist except while validating or using this
command, and remove it afterwards.

### One-time setup

1. Add `LIVE_FMP_API_KEY` to the Claude environment's variables. Use a separate FMP key for the
   cloud if the plan allows one. Never set `FMP_API_KEY` or `RUN_LIVE_FMP_HYDRATION` there: the
   session guard blanks both.
2. Add `financialmodelingprep.com` to the network allowlist immediately before validating.
3. Start a new session, so the environment change and this branch are both in effect.

If the session sets `NODE_EXTRA_CA_CERTS`, its outbound TLS is inspected, and whatever inspects it
can read each request, the key in its query string included. That is a property of the
environment, not of this command, and one more reason to give the cloud a key of its own.

### Validation sequence

Nine steps. Run each and keep its output. Stop at the first one that is not as described.

Before them, the offline proof on the cloud VM:

```bash
pnpm build:packages
pnpm --filter @intrinsic/fmp test
pnpm --filter @intrinsic/api exec vitest run src/fmp-live/
pnpm --filter @intrinsic/stock-data exec vitest run \
  src/fmp-request-budget.integration.test.ts src/fmp-gate-coverage.test.ts src/live-fmp-gate.test.ts
```

**1. No opt-in: exit 2, no provider request.**

```bash
scripts/cloud/fmp-live.sh --symbols AAPL --full-history; echo "exit=$?"
```

Expect `needs RUN_LIVE_FMP_HYDRATION=1` and `exit=2`. The launcher stopped before it looked for
the key, and no process that could ask the provider was started: there is no `Live FMP hydration:`
report.

**2. Four securities: exit 2, no provider request.**

```bash
RUN_LIVE_FMP_HYDRATION=1 scripts/cloud/fmp-live.sh --symbols AAPL,MSFT,NVDA,GOOGL --full-history; echo "exit=$?"
```

Expect `at most 3 distinct securities; 4 were given` and `exit=2`. The command line is refused
before any variable is read.

**3. A plan: no provider request.**

```bash
scripts/cloud/fmp-live.sh --symbols AAPL --full-history --plan
```

Expect `PLAN ONLY — nothing was asked of the provider`. On a fresh database AAPL is
`not in the security catalog`. The process section must read `provider credential (FMP_API_KEY):
absent`, `extra CA certificates (NODE_EXTRA_CA_CERTS): present` and `proxy variables: none`. If the
CA line says `not set`, the session has no CA bundle variable to pass and step 4 will show whether
one is needed.

**4. AAPL, for real. It must succeed.**

```bash
RUN_LIVE_FMP_HYDRATION=1 scripts/cloud/fmp-live.sh --symbols AAPL --full-history
```

Expect `Live FMP hydration: SUCCEEDED`, `admitted to the security catalog from its provider
profile`, `Refused requests: none`, and all three hydration steps `completed`. Record
`Provider requests: N sent of a budget of 200` and the per-dataset counts, in particular the
insider and congressional page counts: they are the unmeasured part of the budget.

If a step fails, its line carries the reason as a fixed code in brackets. `[HTTP 401]` or
`[HTTP 403]` is the key or the plan; `[UNABLE_TO_VERIFY_LEAF_SIGNATURE]` or
`[SELF_SIGNED_CERT_IN_CHAIN]` is a certificate the process does not trust, which is what a missing
`NODE_EXTRA_CA_CERTS` looks like; `[ECONNREFUSED]`, `[ENOTFOUND]` or a timeout is a network that
does not let the process out directly, which is the allowlist or a sandbox that requires a proxy
this command deliberately does not use.

A cold security takes from a few seconds to about half a minute. The time is mostly the shared
gate, not the provider: a request that finds the gate full waits until the oldest holder's lease
would expire.

**5. AAPL again, immediately: no provider request.**

```bash
RUN_LIVE_FMP_HYDRATION=1 scripts/cloud/fmp-live.sh --symbols AAPL --full-history
```

Expect `Provider requests: 0 sent`, `resolved from the security catalog`, and every dataset
`0  (nothing asked: stored data was fresh or already covered)`.

**6. AAPL, MSFT and NVDA. It must succeed inside the budget.** Only if 4 and 5 did.

```bash
RUN_LIVE_FMP_HYDRATION=1 scripts/cloud/fmp-live.sh --symbols AAPL,MSFT,NVDA --full-history
```

Expect `SUCCEEDED`, `Approved securities: 3 of at most 3`, each with its security id,
`Refused requests: none`, and `N sent of a budget of 200` with N well below 200. AAPL is already
stored, so its datasets show `0`.

**7. PostgreSQL coverage, and no fourth security.**

The step 6 report already answers both. Under `Stored`, every dataset has a row count and date
bounds: daily prices should begin near the retained horizon (or the listing date) and end at the
latest session, each statement family should hold quarterly and annual rows, and the ratios should
carry values on most sessions. Then, for the database as a whole:

```text
Database intrinsic_value as a whole: 3 securities in the catalog, 3 with synchronized provider data (AAPL, MSFT, NVDA).
  None outside the securities approved for this run.
```

Independently of the command, straight from PostgreSQL. On a fresh database this returns exactly
three rows:

```bash
psql "$DATABASE_URL" -X -c '
SELECT s."providerSymbol" AS symbol,
       (SELECT count(*) FROM "DailyPrice" p WHERE p."securityId" = s.id) AS bars,
       (SELECT min(p.date) FROM "DailyPrice" p WHERE p."securityId" = s.id) AS first_bar,
       (SELECT max(p.date) FROM "DailyPrice" p WHERE p."securityId" = s.id) AS last_bar,
       (SELECT count(*) FROM "FinancialStatement" f WHERE f."securityId" = s.id) AS statements,
       (SELECT count(*) FROM "StockSplit" x WHERE x."securityId" = s.id) AS splits,
       (SELECT count(*) FROM "InsiderTransaction" i WHERE i."securityId" = s.id) AS insider,
       (SELECT count(*) FROM "CongressTrade" c WHERE c."securityId" = s.id) AS congress
FROM "Security" s ORDER BY 1;'
```

**8. Secret and process isolation.**

From the reports of steps 3, 4 and 6, the process section: every variable from the launcher's
allowlist, the credential `present, in this process only` for a run and `absent` for the plan,
`NODE_EXTRA_CA_CERTS: present`, `proxy variables: none`.

Then that no stack process holds the key. The shell you type in does hold `LIVE_FMP_API_KEY` —
that is where the launcher reads it from — so this looks at the stack: with one up
(`scripts/cloud/stack.sh up dev`), it prints the name of any provider-key variable that is set to
something in any process of any role. Expect no output:

```bash
for role in api worker web; do
  for pid in $(pgrep -g "$(cat .cloud/stack/$role.pid)"); do
    tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null |
      grep -E '^(FMP_API_KEY|LIVE_FMP_API_KEY)=.' | cut -d= -f1
  done
done
```

And that the key is nowhere in the checkout. This prints a count, never the value, and keeps the
value out of the process list. Expect `0`:

```bash
[ -n "$LIVE_FMP_API_KEY" ] && grep -rlF -f <(printf '%s' "$LIVE_FMP_API_KEY") \
  --exclude-dir=node_modules --exclude-dir=.git . | wc -l
```

A byte search can miss a value inside a compressed cache file, so the process listing is the
authoritative check and this one corroborates it.

**9. A clean state afterwards.**

```bash
scripts/cloud/stack.sh down                                         # if a stack was started
pgrep -fl fmp-live || echo "no live-run process"
redis-cli --scan --pattern 'stock-data:v2:fmp:budget:*' | wc -l     # expect 0
git status --short | wc -l                                          # expect 0
```

Then take `financialmodelingprep.com` off the network allowlist again.

To look at the result in the product, before step 9: `scripts/cloud/stack.sh up dev`, sign in as a
QA persona (`pnpm qa:seed`) and open `/stocks/AAPL`. The stack has no provider key; it reads what
the run stored.

## 10. Cleaning up

A run adds rows for the approved securities to the development database and keys to Redis. Nothing
needs cleaning up to run again; the loaders reuse what is stored.

To start over:

- **A cloud session**: start a new one. Its development database is created empty.
- **Locally**: the securities stay in the catalog like any other. Deleting a `Security` row removes
  it and everything hydrated for it (prices, statements, derived state, splits, insider and
  congressional rows cascade); a security a Stock List still holds cannot be deleted. Do not reset
  the development database for this.
- **Redis** holds a disposable projection; the next read rebuilds it from PostgreSQL. The run's
  budget counter is deleted when the run ends and expires after six hours if it crashed.

## 11. Where it lives

| Piece                                   | File                                                         |
| --------------------------------------- | ------------------------------------------------------------ |
| Guard seam in the client                | `packages/fmp/src/client.ts` (`FmpClientDependencies.guard`) |
| Scope, endpoint classification, errors  | `packages/fmp/src/request-guard.ts`                          |
| Redis request budget                    | `packages/stock-data/src/fmp-request-budget.ts`              |
| Opt-in and variable names               | `packages/testing/src/live-fmp.ts`                           |
| Launcher                                | `apps/api/src/fmp-live.ts`                                   |
| Command line, limits                    | `apps/api/src/fmp-live/fmp-live-arguments.ts`                |
| Opt-in, target, child environment       | `apps/api/src/fmp-live/fmp-live-environment.ts`              |
| Composition root                        | `apps/api/src/fmp-live/fmp-live-runtime.ts`                  |
| Guard and ledger                        | `apps/api/src/fmp-live/fmp-live-guard.ts`                    |
| Symbol → security, scoped admission     | `apps/api/src/fmp-live/fmp-live-identity.ts`                 |
| The three loader calls                  | `apps/api/src/fmp-live/fmp-live-hydration.ts`                |
| Dataset classification, request ceiling | `apps/api/src/fmp-live/fmp-live-plan.ts`                     |
| Report                                  | `apps/api/src/fmp-live/fmp-live-report.ts`                   |
| Cloud wrapper                           | `scripts/cloud/fmp-live.sh`                                  |

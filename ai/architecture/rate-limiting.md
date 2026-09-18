# API Rate Limiting

How FactorSage protects its HTTP API from abuse and overload, where the policy for an endpoint is
declared, and what happens when the store behind it is unavailable.

This is **not** about commercial entitlements — see `entitlements.md` for those — and not about
outbound provider traffic, which is a different problem with a different answer (§7 below).

---

## 1. The shape, in one look

```text
request
  │
  ├── middleware ............ request id / correlation id
  ├── guards ................ CookieAuthGuard, RolesGuard        → request.authUser
  ├── RateLimitInterceptor .. reads @RateLimit(...) route metadata
  │      └── RateLimitService ── rate-limiter-flexible ── Redis (rate-limit:v1:*)
  │              ├── allowed → RateLimit-* headers, continue
  │              ├── over    → throw RateLimitError → 429 + Retry-After
  │              └── store down → policy's onRedisFailure: allow, or 503
  ├── pipes ................. request parsing / validation
  └── handler ............... controller → service → entitlement guard → PostgreSQL
```

Declared at the endpoint:

```ts
@RateLimit("stock-search")
@Get("search")
async searchStocks(@Query("q") q?: string) { … }
```

Implemented in one place: `apps/api/src/rate-limit/`.

| File                             | What it owns                                                     |
| -------------------------------- | ---------------------------------------------------------------- |
| `rate-limit-policies.ts`         | **The policy catalog.** Every allowance in the product.          |
| `rate-limit.decorator.ts`        | `@RateLimit(policy)` and `@RateLimitExempt(reason)`.             |
| `rate-limit.interceptor.ts`      | The one enforcement point; writes the `RateLimit-*` headers.     |
| `rate-limit.service.ts`          | Actor keys, limiter registry, timeouts, failure policy, logging. |
| `rate-limit-exception.filter.ts` | The one place a refusal becomes HTTP.                            |
| `rate-limit-redis.ts`            | The limiter's own Redis connection.                              |
| `rate-limit.module.ts`           | Global wiring and connection lifecycle.                          |
| `client-ip.ts`                   | Trusted client-address derivation.                               |

---

## 2. Why an interceptor, and not a decorator-plus-guard

The declaration **is** a decorator — `@RateLimit("policy")` — built on `SetMetadata`, exactly like
the `@Roles(...)` / `RolesGuard` pair already in `apps/api/src/auth/`. That was the natural
repository idiom and it is what the endpoint author sees.

What is _not_ a guard is the enforcement. Nest runs enhancers **global → controller → method**, and
`CookieAuthGuard` is applied per controller. A globally registered guard therefore runs _before_ it
and sees no `request.authUser` — every authenticated route would silently fall back to IP keying,
which is precisely the failure mode where one office shares one allowance. Global **interceptors**
run after every guard, so the session is resolved by the time the limiter runs.
`rate-limit.ordering.test.ts` pins that ordering rather than trusting it.

Two alternatives were considered and rejected:

- **A guard applied per controller after `CookieAuthGuard`.** Correct ordering, but protection
  becomes something an author can forget, and a forgotten `@UseGuards` is invisible in review.
- **A guard that parses the session cookie itself.** Correct ordering and unforgettable, but it
  gives the API a second authentication path to keep correct — for a limiter.

Global registration is what makes "every applicable route is protected" true by construction rather
than by review. `rate-limit-coverage.test.ts` enumerates every mounted route and fails when one
declares neither a policy nor an exemption, so the property is also checked.

Running after the guards puts the limiter after authentication and before the handler, which is the
order `docs/decisions/entitlements-v1.md` §10 describes — and comfortably before the entitlement
checks inside the writing transaction, which are the expensive ones.

---

## 3. The library: `rate-limiter-flexible`

Chosen over writing a distributed counter. It is mature, has **zero runtime dependencies**, is ISC
licensed and actively maintained, and its `RateLimiterRedis` is one atomic Redis `EVAL` per bucket —
`INCRBY` plus a TTL set only on the first increment of a window. That is the part that is genuinely
hard to get right, and it is the part FactorSage does not own.

Verified against this repository before adoption, not assumed:

| Question                  | Answer                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| Works with `ioredis@6`?   | Yes — the custom `defineCommand` path, not the node-redis one.            |
| Multi-instance correct?   | Yes. Two separately compiled apps share one allowance.                    |
| Atomic under concurrency? | Yes. 50 simultaneous requests against a 10-point bucket admit exactly 10. |
| New infrastructure?       | None. Same Redis instance, second connection.                             |
| Bounded failure?          | Yes, with `rejectIfRedisNotReady` plus our own timeout.                   |

`rate-limit.integration.test.ts` re-proves the middle three against real Redis on every run.

**`@nestjs/throttler` was not used.** It is the Nest-official option, but it is a guard with the
ordering problem above, its storage abstraction would still need a Redis adapter, and the policy
model is thinner than the catalog here needs (no per-policy actor, no per-policy failure mode, no
secondary bucket). The library choice and the framework integration are separable, and this takes
the good half of each.

**`insuranceLimiter` was evaluated and deliberately not used.** It falls back to a process-local
`RateLimiterMemory` when the store fails. Across N instances that enforces N times the configured
limit while still reporting the configured one — a _false_ distributed guarantee rather than a
degraded one. Choosing openly between "allow, and say so in the log" and "refuse honestly" is the
smaller lie. See §6.

FactorSage-owned code is policy definitions, actor selection, HTTP semantics, observability,
configuration and tests. No distributed counter algorithm was written.

### The algorithm, named accurately

`points` + `duration`, with `execEvenly` and `blockDuration` both off, is a **fixed-window counter
anchored to the first request**. It is not a sliding window, not a rolling window and not a token
bucket, and should not be described as any of them.

One Redis script per consume does the whole thing:

```lua
redis.call('set', KEYS[1], 0, 'EX', ARGV[2], 'NX')   -- create at 0 *only* if absent
local consumed = redis.call('incrby', KEYS[1], ARGV[1])
local ttl = redis.call('pttl', KEYS[1])
```

Which gives, precisely:

- **The window starts on the first request that finds no key** — not on a wall-clock boundary. Two
  callers who first appear at different moments have windows offset by exactly that difference.
- **The TTL is written once, when the key is created.** Later requests never extend it, including
  requests that are over the limit. A caller cannot push their own reset further away by hammering,
  which is also what keeps `Retry-After` truthful under a retry loop.
- **The counter resets by expiry**, exactly `duration` after that first request. There is no decay
  and no partial refill: the allowance returns all at once.
- **`msBeforeNext` is the key's remaining PTTL**, so `Retry-After` is a measurement, not an estimate.

**A caller can therefore spend up to twice the allowance across a window boundary** — all of it just
before the reset and all of it again just after. That is the accepted cost of a fixed window, and it
is fine here: these policies exist to bound sustained abuse and expensive work, and a brief doubling
at a boundary does neither. Replacing a mature atomic library with a custom sliding window to smooth
it would mean owning a distributed algorithm this repository deliberately does not.

`rate-limit.integration.test.ts` pins all four properties, the boundary burst included, so the
description above is observed behaviour rather than a reading of the source.

---

## 4. The policy catalog

`apps/api/src/rate-limit/rate-limit-policies.ts` is the one authoritative table. No route carries a
number; changing a limit is one edit there.

<!-- Pinned to the catalog by `apps/api/src/rate-limit/rate-limit-docs.test.ts`: the policy,
     actor, failure mode and both allowances in every row are parsed from this table and
     compared with `rate-limit-policies.ts`. Keep the `<points> / [count] <unit>` cell shape. -->

| Policy               | Per actor  | Shared per-IP bucket | Actor   | On Redis failure | Applies to                                                                        |
| -------------------- | ---------- | -------------------- | ------- | ---------------- | --------------------------------------------------------------------------------- |
| `auth-sensitive`     | 20 / 5 min | —                    | IP      | **deny**         | login, register, verify, resend, forgot/reset password, both Google routes        |
| `session-probe`      | 120 / min  | —                    | user→IP | allow            | `GET /auth/me`, `/auth/providers`, `POST /auth/logout`, `GET /entitlements`       |
| `stock-search`       | 60 / min   | —                    | user→IP | allow            | `GET /stocks/search`, `GET /recent-searches`                                      |
| `stock-read`         | 180 / min  | —                    | user→IP | allow            | the five `/stocks/{symbol}*` reads                                                |
| `standard-read`      | 240 / min  | —                    | user→IP | allow            | reads of the caller's own rows, `/benchmarks`, `/billing/status`, `/admin/health` |
| `progress-poll`      | 300 / min  | —                    | user→IP | allow            | `GET /backtests/{runId}/progress`                                                 |
| `mutation`           | 60 / min   | —                    | user→IP | allow            | list, strategy and recent-view writes, `POST /auth/logout-all`                    |
| `monitor-mutation`   | 30 / min   | —                    | user→IP | allow            | monitor create / update / delete                                                  |
| `backtest-execution` | 60 / hr    | 180 / hr             | user→IP | allow            | `POST /backtests`                                                                 |
| `billing-mutation`   | 20 / 5 min | 60 / 5 min           | user→IP | **deny**         | checkout, portal, change                                                          |
| `billing-refresh`    | 60 / 5 min | 180 / 5 min          | user→IP | **deny**         | `POST /billing/refresh`, which the client polls                                   |
| `admin-operation`    | 10 / hr    | —                    | user→IP | **deny**         | `POST /admin/securities/sync`                                                     |

Sizing is from how the product's own UI calls each endpoint, plus headroom, so ordinary use never
reaches one:

- **`stock-search`** — the dropdown debounces typing at 250 ms and issues one request per pause, so
  a minute of searching is a handful of requests. One per second sustained is an order of magnitude
  of headroom.
- **`stock-read`** — extending the Stock Details chart one window costs four requests (prices,
  technicals, intrinsic values, blends); the hook never has two loads outstanding and each is a full
  round trip. Three per second is ~45 window extensions a minute, which no sequential loader
  reaches.
- **`progress-poll`** — `BACKTEST_RUNNING_POLL_INTERVAL_MS` is one second per open run. Five per
  second leaves room for several concurrent runs plus a reload. This is the one allowance set by a
  machine rather than by a person.
- **`backtest-execution`** — **not** a bound on the queue: `assertBacktestConcurrency` counts
  `QUEUED` with the running statuses inside the writing transaction, so the entitlement already caps
  a caller's in-flight runs at one or two and nobody can queue hundreds however fast they ask. This
  bounds the cost of _asking_ — an advisory lock, an entitlement resolution, and for an accepted one
  a snapshot of every security in the list. Sized knowing that a submission the concurrency
  entitlement refuses still spends a point, because the limiter runs before the handler: a caller
  with one slot who clicks Run again mid-run pays for the `403`, and the allowance has to absorb
  that without punishing a normal iteration loop.
- **`billing-refresh`** — split from `billing-mutation` for the same reason `progress-poll` is split
  from `standard-read`: the client polls it. Returning from hosted checkout runs a bounded settle
  loop of six attempts, so three checkout round trips under the money-moving allowance would answer
  `429` on the billing page immediately after a payment. Its siblings stay tight because they are
  clicked, not polled.

The two rate-limit policies that touch backtests and billing are deliberately **not** doing the
entitlement's job. `maxConcurrentRuns` decides how much work may execute; these decide how often an
endpoint may be asked. Neither is a substitute for the other, and neither varies by plan.

`RATE_LIMIT_ALLOWANCE_MULTIPLIER` scales every policy at once, so a deployment can widen or tighten
after measuring its own traffic without editing code and without being able to silently disable one
endpoint's protection.

### Adding a policy to a new endpoint

1. Pick the class from the table in `rate-limit-policies.ts`. If none fits, add a policy there —
   never a number at the route.
2. Add `@RateLimit("your-policy")` above the HTTP verb decorator.
3. Document the operation in `docs/openapi.yaml` with `x-rate-limit: { policy: your-policy }` and a
   `429` response (`$ref: "#/components/responses/TooManyRequests"`), plus `503`
   (`ThrottlingUnavailable`) if the policy fails closed.
4. Run `pnpm --filter @intrinsic/api test` — the coverage and contract suites will tell you exactly
   what is missing.

A route that genuinely must not be limited uses `@RateLimitExempt("why")`. There are three, and the
coverage suite pins the list: `GET /health`, `GET /health/ready` and `POST /webhooks/stripe`.

---

## 5. Actor keys, IP derivation and the Redis namespace

**Keys** are `rate-limit:v1:<policy>[:ip]:<actor>`, where actor is `u:<userId>` or
`ip:<address>`:

```text
rate-limit:v1:standard-read:u:6f1b0a1e-…      one user's reads
rate-limit:v1:auth-sensitive:ip:203.0.113.5   one origin's sign-in attempts
rate-limit:v1:backtest-execution:ip:203.0.…   the secondary bucket of a combined policy
```

`actor: "user"` prefers the authenticated user id — the identity that survives a network change and
cannot be shared with a stranger behind the same NAT — and falls back to the client IP for routes
that answer a guest too. `actor: "ip"` is always the address.

**The subscription plan is never in the key.** Request rate is not something a plan sells
(`docs/decisions/entitlements-v1.md` §10), and keying by tier would make an upgrade reset an
abuser's allowance.

**Login is keyed by origin, never by the submitted email address.** Keying a credential limiter by
account lets anybody lock a known victim out by spending the victim's allowance for them — trading a
credential-stuffing defence for an account-denial attack.

That choice is also why `auth-sensitive` is deliberately wider than a per-account credential
limiter could afford to be. A per-origin counter has to tolerate the several genuine people behind
one office, university or mobile-carrier NAT, while the sustained rate it permits is still orders of
magnitude below what a credential-stuffing run needs to be worth mounting. The policy table above
carries the exact allowance. **A deployment expecting heavy carrier-grade NAT should raise
`RATE_LIMIT_ALLOWANCE_MULTIPLIER` and watch `rate-limit.request.refused` for legitimate users** —
that event carries the policy and the address class, which is exactly the signal for this.

**Combined protection** exists where one origin creating several accounts is a realistic path. Such
a policy carries a per-user bucket _and_ a wider per-IP one, and is refused if either is exhausted;
the shared bucket is sized several times the per-user one so a normal office is never what trips it.
Which policies these are is the `Shared per-IP bucket` column of the table above rather than a list
here — a list is the thing that goes stale when a policy is added.

### How a two-bucket policy spends, exactly

**A refused request does not consume usable allowance from another bucket.** Buckets are consumed in
order — per-user first, then the shared per-IP one — stopping at the first refusal, and anything an
earlier bucket already took is handed back when the request is refused anyway.

Said exactly, because the shorter version overclaims: the bucket that _produces_ the refusal does
still increment its own counter past `points`, since the refusal is the return value of an
unconditional `INCRBY`. That costs nothing — its usable allowance was already zero, and the window
does not extend, so the reset arrives at the same moment either way — but it is not "nothing
happened". What the design guarantees is narrower and is the part that matters: **no other bucket's
usable allowance is spent.** The hand-back is also best-effort; a refund that cannot reach Redis
leaves one point spent, which is logged as `rate-limit.refund.failed`.

Both halves close a real hole, and the first is the serious one:

| Situation                                            | Before                                                                                                              | Now                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Caller's own allowance gone, they keep retrying      | each doomed retry also spent a shared-bucket point, so one person could lock their whole office out of the endpoint | the shared bucket is never consulted    |
| Shared bucket full, caller's own allowance untouched | each refusal also spent one of their own points, so a retry loop emptied an allowance they had not used             | their own point is handed straight back |

**This does not weaken distributed correctness.** Every consume is still one atomic Redis script;
nothing reads a counter to decide whether to spend it, which would be a check-then-act race and a
wider limit than the one configured. Ordering and compensation decide _which_ atomic operations to
issue, never how atomic they are.

Stated as precisely as it holds:

- **Concurrent requests cannot admit more than a bucket's allowance against the same remaining
  point.** Admission is decided inside one atomic script, so two requests racing for one point
  produce one admission and one refusal.
- **Compensation cannot create an extra admission.** A refund only ever follows a refusal, and it
  moves a counter _down_ — so it can cause a request to be refused that might have been allowed a
  moment later, never the reverse.
- **One library edge case is not covered by either statement.** If a key expires in the gap between
  a consume and its refund, `reward` recreates it at `-1` with a fresh window, which effectively
  grants one additional point in that new window. It is bounded to one point for one actor, needs
  the window to end inside a sub-millisecond gap, and is the library's behaviour rather than
  something this code chose.

For abuse and capacity policies that tradeoff is accepted deliberately: eliminating it would mean
replacing the library's atomic operation with hand-written Lua, and there is no evidence a single
extra point matters to any policy here. `rate-limit.integration.test.ts` proves the first two
statements under real concurrency across six callers sharing one address.

The one sharp edge, stated rather than hidden: the library's `reward` recreates a key that expired
in the sub-millisecond gap between the consume and the refund, leaving it at `-1` with a fresh
window — worth exactly one extra request for that actor. That bound is why the library's own
operation is used rather than a hand-written script.

### IP and proxy assumptions

`X-Forwarded-For` is caller-supplied text. `RATE_LIMIT_TRUSTED_PROXY_HOPS` (default `0`) is how many
proxies this deployment really runs in front of the API:

- **`0`** — the header is not read at all; the TCP peer address is used. Correct for this
  repository's own deployment, where `docker-compose.yml` publishes the API port directly and
  nothing terminates in front of it.
- **`N`** — the entry at `length - N` is used: the address the outermost trusted proxy actually
  observed. A caller who prepends fabricated hops only pushes their own real address further right,
  where counting from the right still finds it. A header _shorter_ than `N` resolves to the peer
  address, never to the left-most entry.

Express's own `trust proxy` is deliberately left off: it would also change `req.protocol` and
`req.secure` across the whole application, which is a wider decision than this one.

Addresses are normalized before keying: IPv4-mapped IPv6 collapses to IPv4 (one client, one
bucket), and IPv6 is truncated to its `/64` — a subscriber holds a whole `/64`, so a per-address
counter costs nothing to evade.

### Relationship to the stock-data namespace

`AGENTS.md` invariant 16 governs `stock-data:v2:*`, `stock-data:load:*` and `benchmark:v1:*`, and
forbids user-scoped keys there. `rate-limit:v1:*` is a **separate namespace with separate
semantics**: it holds no projection of PostgreSQL and no user-owned state, only transient
coordination whose loss grants allowance rather than destroying anything. Losing it is harmless; the
invariant's concern — Redis as the only home for something durable — does not apply. The integration
suite asserts no rate-limit key ever lands under the stock-data prefixes.

---

## 6. Redis failure behaviour

Explicitly decided per policy, because the right answer differs by what the policy is _for_.

**Fail open (`allow`)** — every capacity policy. A Redis outage already fails `GET /health/ready`
and takes the instance out of rotation; also refusing the PostgreSQL-only surfaces that still work
would widen a partial outage into a total one for no security gain. The request proceeds, a
`rate-limit.store.unavailable` warning is logged with the policy, actor and operation, and **no
`RateLimit-*` headers are sent** — reporting an allowance nothing counted would be worse than
reporting none.

**Fail closed (`deny`)** — the credential, payment and operator policies; the `On Redis failure`
column of the table above is the current list. An outage is exactly when an unlimited credential
endpoint is most valuable to an attacker, and when an unbounded retry storm against a payment
provider is most expensive. These answer `503` with
`code: RATE_LIMIT_UNAVAILABLE` — deliberately **not** `429`, because the caller's allowance is
untouched and "slow down" would be a lie they act on.

**Nothing can hang.** Three independent bounds:

- the limiter's Redis client sets `enableOfflineQueue: false`, so a command during an outage is
  refused in microseconds rather than queued;
- `rejectIfRedisNotReady` refuses while the connection is not `ready`;
- every consume races `RATE_LIMIT_REDIS_TIMEOUT_MS` (default 250 ms), which catches the failure the
  other two cannot see — a connection that is up and not answering.

The API **starts** with Redis down: the connect failure is logged and survivable, ioredis reconnects
in the background, and until it does each policy's own decision applies.

**A store failure part-way through a two-bucket policy** follows the same rule as a refusal: give
back what an earlier bucket took _when the request is refused_, and keep it when the request is
served. A fail-closed policy whose shared bucket cannot be reached answers `503` with the caller's
own allowance untouched; a fail-open policy serves the request and charges it like any other served
request, because refunding there would let a caller spend an unlimited number of them for the
duration of the outage.

`rate-limit.failure.test.ts` covers all of it — the hanging store, a partitioned store that answers
one bucket and not the other, both failure modes — and needs no Redis.

---

## 7. FMP provider throttling is a separate mechanism

User rate limiting answers _should this caller be refused_. Provider throttling answers _when may
this system make its next upstream request_ — and the answer there is usually **wait**, not
**reject**: a backtest that needs thirty years of prices must not fail because a Monitor cycle was
running.

FactorSage already had the right answer and this work did not change it, only proved and documented
it. `RedisFmpRequestGate` (`packages/stock-data/src/fmp-gate.ts`) is a Redis-backed queue with a
bounded wait: a concurrency limit held as a sorted set of leases (genuinely rolling — expired leases
are dropped by score on every acquire), a **fixed** request window built from the same `INCR`
plus write-TTL-once shape the HTTP limiter uses, a shared `Retry-After` cooldown, a
bounded queue depth and a bounded queue wait — all in Redis under `stock-data:v2:fmp:*`, so every
process spends one allowance:

```text
  web A ─────┐
  web B ─────┤
  worker A ──┼── RedisFmpRequestGate ── FMP
  worker B ──┘
```

`FmpClient` accepts the gate optionally, which means a composition root that forgets one still works
and quietly doubles provider traffic. `packages/stock-data/src/fmp-gate-coverage.test.ts` now makes
that impossible: it reads the repository as source text and requires every production
`new FmpClient(...)` — there are exactly three — to pass a `RedisFmpRequestGate` sized from `FMP_*`
configuration rather than from a literal.

**No plan allowance is hard-coded.** `FMP_MAX_CONCURRENT_REQUESTS`, `FMP_RATE_LIMIT_PER_WINDOW`,
`FMP_RATE_WINDOW_MS`, `FMP_MAX_QUEUE_DEPTH` and `FMP_MAX_QUEUE_WAIT_MS` are configuration with
documented defaults; an operator raises them when they raise their plan, in one place for every
process.

**Cache hits cost no allowance.** PostgreSQL, not Redis, is the coverage authority: an identical
second read over a materialized range makes zero provider requests, and so does the same read after
a full Redis flush. `provider-reuse.integration.test.ts` pins that against a counting provider.

One deliberate exception: `apps/web/src/app/api/logo/[symbol]/route.ts` fetches
`images.financialmodelingprep.com` directly. `apps/web` may not depend on `@intrinsic/fmp` at all
(`AGENTS.md` dependency rules) so it _cannot_ pass the gate — which is safe only because that host
is the unmetered image CDN: no key, no API allowance, nothing the gate protects. The coverage suite
asserts the route never starts calling the metered API.

---

## 8. Internal traffic is not rate limited

Worker jobs, queue consumers, Monitor scan scheduling and internal execution loops never pass
through the HTTP limiter, because they are not HTTP requests. They are bounded by what actually
bounds them: durable PostgreSQL claims with `FOR UPDATE SKIP LOCKED` and renewable leases,
`BACKTEST_WORKER_PROCESSES` / `MONITOR_WORKER_PROCESSES`, `BACKTEST_FRAME_LOAD_CONCURRENCY`,
`MONITOR_SYMBOL_CONCURRENCY`, and the provider gate above. See `api-worker.md`.

`POST /webhooks/stripe` is exempt for the same reason: the caller is the payment provider, delivery
volume is its retry schedule rather than anybody's behaviour, and a `429` would simply be retried for
days while the billing change it carries stays unapplied. Its protection is signature verification
over the raw body plus event-id idempotency — see `billing.md`.

---

## 9. HTTP semantics, and what clients do with them

Every rate-limited response carries `RateLimit-Policy`, `RateLimit-Limit`, `RateLimit-Remaining` and
`RateLimit-Reset`, written by the interceptor in one place. A refusal adds `Retry-After`. The
un-prefixed IETF-draft spelling is used rather than `X-RateLimit-*`.

The API and the web app are different origins, so `main.ts` lists these in
`Access-Control-Expose-Headers` from `RATE_LIMIT_HEADER_NAMES` — without that the browser cannot
read `Retry-After` at all.

The body is the same machine-readable shape as every other refusal:

```json
{
  "statusCode": 429,
  "message": "Too many requests. Retry in 42 seconds.",
  "code": "RATE_LIMITED",
  "policy": "stock-search",
  "retryAfterSeconds": 42
}
```

On the client, `apps/web/src/lib/api/rate-limit-errors.ts` recognises both codes and produces copy
that names the wait. It is wired into `requestFailureMessage`, so every dialog that already used
that helper handles `429` without knowing rate limiting exists. Three call sites needed more:

- **sign-in** (`auth-errors.ts`) — a throttled login is refused whether or not the password was
  right, so the generic "unable to sign in with those credentials" would send the user to reset a
  password that works;
- **search** (`use-stock-search.ts`) — the dropdown shows the specific message instead of
  "Search is unavailable right now.";
- **backtest progress polling** (`use-backtest-run.ts`) — honours `Retry-After` instead of retrying
  on its one-second cadence, capped at a minute so a page always recovers.

---

## 10. Configuration

| Variable                          | Default         | Meaning                                                                      |
| --------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| `RATE_LIMIT_ENABLED`              | `true`          | Enforcement on/off. `false` only for a deployment whose edge already limits. |
| `RATE_LIMIT_TRUSTED_PROXY_HOPS`   | `0`             | Proxies in front of the API. **A security control** — see §5.                |
| `RATE_LIMIT_REDIS_TIMEOUT_MS`     | `250`           | Bound on one limiter round trip.                                             |
| `RATE_LIMIT_ALLOWANCE_MULTIPLIER` | `1`             | Scales every policy at once.                                                 |
| `RATE_LIMIT_KEY_NAMESPACE`        | `rate-limit:v1` | Counter namespace.                                                           |

Read once at startup by `getRateLimitConfig()` in `@intrinsic/config`. `REDIS_URL` is shared with
the rest of the application; rate limiting never needs a second Redis.

---

## 11. Observability

| Event                             | Level        | When                                                    |
| --------------------------------- | ------------ | ------------------------------------------------------- |
| `rate-limit.started`              | info         | Startup, with namespace, trusted hops and multiplier.   |
| `rate-limit.disabled`             | warn         | Enforcement is off in this deployment.                  |
| `rate-limit.request.refused`      | warn         | A `429`, with policy, actor, operation, limit and wait. |
| `rate-limit.store.unavailable`    | warn / error | Store failure, with the outcome the policy chose.       |
| `rate-limit.store.connect-failed` | error        | Startup connection failure (non-fatal).                 |
| `rate-limit.redis.error`          | debug        | Connection-level noise during an outage.                |

`actorUserId` is the internal user id, following `observability.md`. No address, cookie or
credential is ever logged.

---

## 12. Tests

| Suite                                         | Needs              | Proves                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rate-limit-coverage.test.ts`                 | PostgreSQL         | Every mounted route declares a policy or a written exemption; the exemption list is fixed.                                                                                                                                              |
| `rate-limit.integration.test.ts`              | Redis              | Limits and boundaries, `Retry-After`, refill, the four window properties including the boundary burst, actor and policy isolation, both multi-bucket directions, concurrency across six callers, multi-instance sharing, key namespace. |
| `rate-limit.api.integration.test.ts`          | PostgreSQL + Redis | A real endpoint answers `429`; credential counters are never keyed by email; two colleagues behind one address keep separate allowances; sign-in, lists and entitlements still behave.                                                  |
| `rate-limit.failure.test.ts`                  | nothing            | Fail-open, fail-closed, timeout bounding, disabled mode, and a store that answers one bucket of a two-bucket policy but not the other.                                                                                                  |
| `rate-limit-docs.test.ts`                     | nothing            | The policy table in this document equals the catalog value for value, and the multi-bucket prose does not overstate the implementation.                                                                                                 |
| `rate-limit.ordering.test.ts`                 | nothing            | Nest runs global interceptors after every guard.                                                                                                                                                                                        |
| `client-ip.test.ts`                           | nothing            | Proxy hops, spoofing, IPv6 `/64`, IPv4-mapped.                                                                                                                                                                                          |
| `openapi.contract.test.ts`                    | PostgreSQL         | The document describes exactly this API — routes, policies, statuses, auth — and restates no allowance in prose.                                                                                                                        |
| `fmp-gate-coverage.test.ts`                   | nothing            | Every production `FmpClient` passes the shared gate.                                                                                                                                                                                    |
| `entitlements.rate-limiting-boundary.test.ts` | nothing            | Entitlements still carry no request-rate concept.                                                                                                                                                                                       |

---

## 13. OpenAPI

`docs/openapi.yaml` — OpenAPI 3.1, hand-authored, describing the API that exists.

```bash
pnpm openapi:validate        # official 3.1 schema + every $ref resolvable
```

`apps/api/src/openapi/openapi.contract.test.ts` compiles the real application and checks the
document against it. **This is the answer to "rate limiting exists in code while the specification
silently forgets it":** the same route metadata is read twice, once to enforce and once to check the
document, with no code generation and no framework.

It is worth being exact about how far that reaches, because "cannot drift" is a stronger claim than
any test here supports.

**Mechanically guaranteed.** A change that breaks one of these fails the build:

| Property                                                                   | How                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------- |
| Every mounted operation is documented, and none is invented                | route table from `DiscoveryService`, compared both ways |
| Each operation's `x-rate-limit` names the policy the route declares        | the same `@RateLimit` metadata the interceptor reads    |
| `429` on every rate-limited operation, and on no exempt one                | route policy vs documented responses                    |
| `503` on every operation whose policy fails closed                         | catalog `onRedisFailure`                                |
| `cookieAuth` exactly where `CookieAuthGuard` is applied, and nowhere else  | guard metadata                                          |
| `401` on every session-required operation, `403` on every role-guarded one | guard metadata                                          |
| The documented success status is the one the handler will send             | Nest's `@HttpCode` metadata, or its `POST` default      |
| Exactly one `2xx` per operation                                            | —                                                       |
| Every documented `4xx`/`5xx` carries a machine-readable body               | —                                                       |
| Every path parameter in the route template is declared                     | route template vs parameters                            |
| `info.x-rate-limit-policies` equals the catalog, value for value           | direct comparison                                       |
| No prose anywhere in the document restates an allowance                    | scan of every `description`/`summary`                   |
| Valid OpenAPI 3.1, every `$ref` resolvable                                 | official schema + reference resolution                  |

**Hand-maintained, and not checked by anything.** These are as good as the author made them:

- request and response **schemas** — nothing compares them with the hand-written `parse*Request`
  functions or with what a controller actually returns;
- **validation constraints** (`maxLength`, `minimum`, enum members) — these were transcribed from
  the parsers and the contracts package by hand;
- **examples** — not validated against their own schemas;
- **prose descriptions** — true when written, and only the allowance scan above is enforced;
- **status-code completeness** beyond the rows in the first table: an operation that can answer
  `409` is not required to document it.

Closing the schema half honestly would mean generating the document from the runtime validators,
and this repository validates with hand-written parsers rather than a schema library — so that is a
real project, not a test. Until then the boundary is written down instead of implied.

`info.x-rate-limit-policies` mirrors the catalog number for number, and the test compares it with
the code — so changing a limit without touching the document fails the build.

**Swagger UI was not added.** It would mean two more routes on the API, each needing an exemption
and its own documentation entry, plus a `/api-docs` surface that is one misconfiguration away from
being public — a poor trade for a viewer, given the specification is the deliverable. To read it in
a browser locally:

```bash
npx @redocly/cli preview-docs docs/openapi.yaml
```

or paste it into <https://editor.swagger.io>.

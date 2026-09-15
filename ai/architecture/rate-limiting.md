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

---

## 4. The policy catalog

`apps/api/src/rate-limit/rate-limit-policies.ts` is the one authoritative table. No route carries a
number; changing a limit is one edit there.

| Policy               | Allowance                          | Actor   | On Redis failure | Applies to                                                                        |
| -------------------- | ---------------------------------- | ------- | ---------------- | --------------------------------------------------------------------------------- |
| `auth-sensitive`     | 10 / 5 min                         | IP      | **deny**         | login, register, verify, resend, forgot/reset password, both Google routes        |
| `session-probe`      | 120 / min                          | user→IP | allow            | `GET /auth/me`, `/auth/providers`, `POST /auth/logout`, `GET /entitlements`       |
| `stock-search`       | 60 / min                           | user→IP | allow            | `GET /stocks/search`, `GET /recent-searches`                                      |
| `stock-read`         | 180 / min                          | user→IP | allow            | the five `/stocks/{symbol}*` reads                                                |
| `standard-read`      | 240 / min                          | user→IP | allow            | reads of the caller's own rows, `/benchmarks`, `/billing/status`, `/admin/health` |
| `progress-poll`      | 300 / min                          | user→IP | allow            | `GET /backtests/{runId}/progress`                                                 |
| `mutation`           | 60 / min                           | user→IP | allow            | list, strategy and recent-view writes                                             |
| `monitor-mutation`   | 30 / min                           | user→IP | allow            | monitor create / update / delete                                                  |
| `backtest-execution` | 20 / hour **+ 60 / hour per IP**   | user→IP | allow            | `POST /backtests`                                                                 |
| `billing-mutation`   | 20 / 5 min **+ 60 / 5 min per IP** | user→IP | **deny**         | checkout, portal, change, refresh                                                 |
| `admin-operation`    | 10 / hour                          | user→IP | **deny**         | `POST /admin/securities/sync`                                                     |

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
- **`backtest-execution`** — bounds how fast a queue can be filled with work a worker will execute
  later. How many may _run_ at once is `backtests.maxConcurrentRuns`, an entitlement, and stays one.

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

That choice is also why `auth-sensitive` is 20 per five minutes rather than the 5 or 10 a
per-account limiter could afford. A per-origin counter has to tolerate the several genuine people
behind one office, university or mobile-carrier NAT, and one attempt every fifteen seconds sustained
is still useless to a stuffing run that needs thousands a minute. **A deployment expecting heavy
carrier-grade NAT should raise `RATE_LIMIT_ALLOWANCE_MULTIPLIER` and watch
`rate-limit.request.refused` for legitimate users** — that event carries the policy and the address
class, which is exactly the signal for this.

**Combined protection** exists where one origin creating several accounts is a realistic path:
`backtest-execution` and `billing-mutation` each consume a per-user bucket _and_ a wider per-IP
bucket, and are refused if either is exhausted. The IP bucket is sized several times the per-user
one so a shared office is never what trips it.

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

**Fail closed (`deny`)** — `auth-sensitive`, `billing-mutation`, `admin-operation`. An outage is
exactly when an unlimited credential endpoint is most valuable to an attacker, and when an unbounded
retry storm against a payment provider is most expensive. These answer `503` with
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

`rate-limit.failure.test.ts` covers all of it, including the hanging-store case, and needs no Redis.

---

## 7. FMP provider throttling is a separate mechanism

User rate limiting answers _should this caller be refused_. Provider throttling answers _when may
this system make its next upstream request_ — and the answer there is usually **wait**, not
**reject**: a backtest that needs thirty years of prices must not fail because a Monitor cycle was
running.

FactorSage already had the right answer and this work did not change it, only proved and documented
it. `RedisFmpRequestGate` (`packages/stock-data/src/fmp-gate.ts`) is a Redis-backed queue with a
bounded wait: a concurrency limit, a rolling request window, a shared `Retry-After` cooldown, a
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

| Suite                                         | Needs              | Proves                                                                                        |
| --------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------- |
| `rate-limit-coverage.test.ts`                 | PostgreSQL         | Every mounted route declares a policy or a written exemption.                                 |
| `rate-limit.integration.test.ts`              | Redis              | Limits, boundaries, `Retry-After`, refill, isolation, concurrency, multi-instance, namespace. |
| `rate-limit.api.integration.test.ts`          | PostgreSQL + Redis | A real endpoint answers `429`; sign-in, lists and entitlements still behave.                  |
| `rate-limit.failure.test.ts`                  | nothing            | Fail-open, fail-closed, timeout bounding, disabled mode.                                      |
| `rate-limit.ordering.test.ts`                 | nothing            | Nest runs global interceptors after every guard.                                              |
| `client-ip.test.ts`                           | nothing            | Proxy hops, spoofing, IPv6 `/64`, IPv4-mapped.                                                |
| `openapi.contract.test.ts`                    | PostgreSQL         | The document describes exactly this API, policies and all.                                    |
| `fmp-gate-coverage.test.ts`                   | nothing            | Every production `FmpClient` passes the shared gate.                                          |
| `entitlements.rate-limiting-boundary.test.ts` | nothing            | Entitlements still carry no request-rate concept.                                             |

---

## 13. OpenAPI

`docs/openapi.yaml` — OpenAPI 3.1, hand-authored, describing the API that exists.

```bash
pnpm openapi:validate        # official 3.1 schema + every $ref resolvable
```

It is kept synchronized by `apps/api/src/openapi/openapi.contract.test.ts`, which compiles the real
application and requires the document to match it operation for operation — including each route's
`@RateLimit` policy, its `429`, its `503` where the policy fails closed, its cookie authentication
and its `401`/`403`. **This is the answer to "rate limiting exists in code while the specification
silently forgets it":** the same route metadata is read twice, once to enforce and once to check the
document, with no code generation and no framework.

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

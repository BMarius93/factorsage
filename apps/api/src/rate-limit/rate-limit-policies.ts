/**
 * The rate-limit policy catalog — the one authoritative table of API request allowances.
 *
 * Every protected route names a policy from this file with `@RateLimit("…")`; no route carries a
 * number of its own, so changing a limit is one edit here rather than a sweep through controllers.
 * The mechanics that apply these numbers live in `rate-limit.service.ts`, and no route handler
 * ever sees Redis.
 *
 * ## What these numbers are, and what they are not
 *
 * They are abuse and capacity protection, sized from how the product's own UI actually calls each
 * endpoint plus generous headroom, so ordinary use never reaches one. They are **not** an
 * entitlement: `docs/decisions/entitlements-v1.md` section 10 forbids modelling request rate as
 * something a plan sells, so no policy varies by `plan`, and `tier` is never part of a key.
 * Product capacity — how many symbols a list may hold, how many backtests may run at once — stays
 * where it is, enforced inside the writing transaction.
 *
 * ## Choosing a policy for a new endpoint
 *
 * Ask what the endpoint costs and who may call it, in that order:
 *
 * | It is …                                              | Use                 |
 * | ---------------------------------------------------- | ------------------- |
 * | a credential, registration or account-recovery route  | `auth-sensitive`    |
 * | a cheap session/capability probe the UI calls often   | `session-probe`     |
 * | search or autocomplete                                | `stock-search`      |
 * | a market-data read that can hydrate from the provider | `stock-read`        |
 * | a read of the caller's own rows                       | `standard-read`     |
 * | something the UI polls on a timer                     | `progress-poll`     |
 * | a write to the caller's own rows                      | `mutation`          |
 * | a write that schedules recurring background work      | `monitor-mutation`  |
 * | a submission of durable expensive work                | `backtest-execution`|
 * | anything that reaches the payment provider            | `billing-mutation`  |
 * | a privileged operator action                          | `admin-operation`   |
 *
 * If none fits, add a policy here rather than inventing a number at the route.
 */

/** How the caller is identified for a policy's counter. */
export type RateLimitActor =
  /**
   * The authenticated user id, falling back to the client IP when there is no session. The normal
   * choice: a user behind a shared NAT must not consume a colleague's allowance, and a signed-in
   * caller changing networks must not get a fresh one.
   */
  | "user"
  /** Always the client IP. For routes where no session exists yet, or must not be trusted. */
  | "ip";

/**
 * What happens when the limiter cannot reach Redis inside its timeout.
 *
 * - `allow` — the request proceeds and the failure is logged. Used wherever the policy's purpose
 *   is capacity protection: a Redis outage already fails the readiness probe and takes the
 *   instance out of rotation, so also refusing the PostgreSQL-only surfaces that still work would
 *   turn a partial outage into a total one for no security gain.
 * - `deny` — the request is refused with `503` and `RATE_LIMIT_UNAVAILABLE`. Used wherever the
 *   policy's purpose is security or money: an unlimited credential endpoint during an outage is
 *   exactly when brute force is cheapest, and an unlimited payment-provider endpoint is exactly
 *   when a retry storm is most expensive.
 *
 * Neither branch ever falls back to a process-local counter. A memory limiter across N instances
 * enforces N times the limit while reporting the configured one, which is a false distributed
 * guarantee rather than a degraded one — see the `insuranceLimiter` evaluation in
 * `ai/architecture/rate-limiting.md`.
 */
export type RateLimitFailureMode = "allow" | "deny";

export type RateLimitBucket = {
  readonly actor: RateLimitActor;
  /** Requests allowed per window. */
  readonly points: number;
  /** Window length in seconds. */
  readonly durationSeconds: number;
};

export type RateLimitPolicy = RateLimitBucket & {
  /** Human-readable purpose, reused verbatim in the OpenAPI document. */
  readonly description: string;
  readonly onRedisFailure: RateLimitFailureMode;
  /**
   * An optional second bucket consumed by the same request, refused if either is exhausted.
   *
   * Used where one origin creating several accounts is a realistic abuse path and the per-user
   * bucket alone would not see it. Sized several times wider than the primary so a shared office
   * or a household NAT is never the thing that trips it.
   */
  readonly secondary?: RateLimitBucket;
};

/**
 * Applied when a route declares neither `@RateLimit` nor `@RateLimitExempt`.
 *
 * A forgotten decorator is a mistake, and the two ways of handling it are both wrong on their own:
 * leaving the route unlimited hides the mistake until it is exploited, and failing the request
 * hides it behind an outage. So the runtime is conservative and the *test* is loud —
 * `rate-limit-coverage.test.ts` enumerates every mounted route and fails when one is undeclared,
 * which is what actually keeps this policy unreachable in practice.
 */
export const UNDECLARED_ROUTE_POLICY = "undeclared" as const;

export const RATE_LIMIT_POLICIES = {
  /**
   * Credentials, registration, account recovery and the OAuth redirect pair.
   *
   * IP-keyed rather than account-keyed on purpose. Keying a login limiter by the submitted email
   * address lets anyone lock a known victim out by spending the victim's allowance for them, which
   * trades a credential-stuffing defence for an account-denial attack. The counter therefore
   * follows the origin of the traffic, which is what a stuffing run actually has to spend.
   *
   * Twenty attempts per five minutes — one every fifteen seconds sustained — is useless to a
   * credential-stuffing run, which needs thousands a minute to be worth mounting, while leaving
   * room for the several genuine people who may share one address. That headroom is the reason the
   * number is not tighter: an office, a university or a mobile carrier's NAT presents one IPv4 for
   * many users, and a per-origin counter sized for one person locks all of them out of a product
   * they are paying for. A deployment that expects heavy carrier-grade NAT raises
   * `RATE_LIMIT_ALLOWANCE_MULTIPLIER` and watches `rate-limit.request.refused`.
   *
   * Fail-closed: an outage must not open the front door.
   */
  "auth-sensitive": {
    description:
      "Credential, registration, verification and account-recovery endpoints.",
    actor: "ip",
    points: 20,
    durationSeconds: 300,
    onRedisFailure: "deny",
  },

  /**
   * Cheap "who am I / what may I do" reads the app issues on navigation and on focus. Sized so a
   * tab-switching user never notices it.
   */
  "session-probe": {
    description: "Session, provider-capability and entitlement probes.",
    actor: "user",
    points: 120,
    durationSeconds: 60,
    onRedisFailure: "allow",
  },

  /**
   * Global search and the recents that share its dropdown.
   *
   * The UI debounces typing at 250 ms and issues one request per pause, so a minute of continuous
   * searching is a handful of requests; one per second sustained is an order of magnitude of
   * headroom. Reachable without a session, so a guest's counter is their IP.
   */
  "stock-search": {
    description: "Global stock search and recently-viewed resolution.",
    actor: "user",
    points: 60,
    durationSeconds: 60,
    onRedisFailure: "allow",
  },

  /**
   * Stock Details and its history series — the only public routes that can reach the market-data
   * provider and materialize years of derived state.
   *
   * Sized from the chart rather than from a guess: extending history one window costs four
   * requests (prices, technicals, intrinsic values, blends), the hook never has two loads
   * outstanding, and each load is a full server round trip. Three per second is roughly forty-five
   * window extensions a minute, which no sequential loader reaches — while still bounding a script
   * walking the catalog.
   *
   * The provider itself is protected separately and does not rely on this: every FMP call in the
   * repository passes the shared `RedisFmpRequestGate`, and a cache hit makes no provider request
   * at all.
   */
  "stock-read": {
    description:
      "Stock Details and daily history series; may hydrate from the market-data provider.",
    actor: "user",
    points: 180,
    durationSeconds: 60,
    onRedisFailure: "allow",
  },

  /** Reads of the caller's own lists, strategies, runs, monitors and the benchmark catalog. */
  "standard-read": {
    description: "Reads of the caller's own resources and system catalogs.",
    actor: "user",
    points: 240,
    durationSeconds: 60,
    onRedisFailure: "allow",
  },

  /**
   * Endpoints the UI polls on a timer.
   *
   * `BACKTEST_RUNNING_POLL_INTERVAL_MS` is one second per open run, and a user may watch more than
   * one, so this is the one policy whose allowance is set by a machine rather than by a human:
   * five per second leaves room for several concurrent runs plus a reload.
   */
  "progress-poll": {
    description: "Endpoints the client polls on a fixed interval.",
    actor: "user",
    points: 300,
    durationSeconds: 60,
    onRedisFailure: "allow",
  },

  /** Writes to the caller's own lists, strategies and view history. */
  mutation: {
    description: "Writes to the caller's own resources.",
    actor: "user",
    points: 60,
    durationSeconds: 60,
    onRedisFailure: "allow",
  },

  /**
   * Monitor writes, which are tighter than ordinary mutations because each one changes what the
   * scan cycle evaluates every five minutes from then on. How many monitors may exist stays an
   * entitlement; how fast they may be created and rebound is this.
   */
  "monitor-mutation": {
    description: "Monitor creation, rebinding and deletion.",
    actor: "user",
    points: 30,
    durationSeconds: 60,
    onRedisFailure: "allow",
  },

  /**
   * Backtest submission — durable work a worker process will execute for minutes.
   *
   * **It does not bound the queue; the entitlement already does.**
   * `EntitlementsService.assertBacktestConcurrency` counts `QUEUED` alongside the running statuses,
   * inside the writing transaction under the per-user lock, so a caller physically cannot have
   * more runs in flight than `backtests.maxConcurrentRuns` — one or two. Nobody can queue hundreds
   * of backtests no matter how fast they ask.
   *
   * What this bounds is the cost of *asking*: every attempt takes an advisory lock, resolves
   * entitlements and counts runs, and an accepted one writes an immutable snapshot of every
   * security in the list with its buy windows.
   *
   * Sized from that, and from one thing easy to miss: a submission refused by the concurrency
   * entitlement still spends a point here, because the limiter runs before the handler. A caller
   * with one slot who clicks Run again while their backtest is going therefore pays for the `403`.
   * One submission a minute sustained is far above any real iteration loop, misclicks included,
   * while still bounding the snapshot work. The per-IP bucket is what sees one origin doing it
   * across several free accounts.
   */
  "backtest-execution": {
    description: "Backtest submission; queues durable worker execution.",
    actor: "user",
    points: 60,
    durationSeconds: 3600,
    onRedisFailure: "allow",
    secondary: { actor: "ip", points: 180, durationSeconds: 3600 },
  },

  /**
   * The billing operations that move money: starting checkout, opening the portal, changing a
   * subscription. Each is a deliberate click, each costs a round trip to the payment provider under
   * an idempotency key, and the product's own surfaces need only a handful.
   *
   * Fail-closed: refusing a checkout during a Redis outage is recoverable, and the readiness probe
   * is already reporting the instance unfit, while an unbounded retry storm against a payment
   * provider is not something to discover afterwards.
   */
  "billing-mutation": {
    description:
      "Billing operations that move money through the payment provider.",
    actor: "user",
    points: 20,
    durationSeconds: 300,
    onRedisFailure: "deny",
    secondary: { actor: "ip", points: 60, durationSeconds: 300 },
  },

  /**
   * `POST /billing/refresh` alone, because the client polls it and its siblings are clicked.
   *
   * Returning from hosted checkout runs a bounded settle loop — six attempts a second and a half
   * apart — which is six points for one purchase. Under the money-moving allowance, three checkout
   * round trips inside five minutes would exhaust it and answer `429` on the billing page
   * immediately after a payment: the worst place in the product to be throttled, and reachable by
   * anyone whose card keeps failing.
   *
   * So it gets its own allowance, sized for roughly ten of those settle cycles. It still reaches
   * the provider, so it still fails closed; it is idempotent and grants nothing, so a wider
   * allowance costs only provider round trips.
   */
  "billing-refresh": {
    description:
      "Polled reconciliation of billing state after a hosted payment round trip.",
    actor: "user",
    points: 60,
    durationSeconds: 300,
    onRedisFailure: "deny",
    secondary: { actor: "ip", points: 180, durationSeconds: 300 },
  },

  /**
   * Privileged operator actions. The catalog synchronization behind this reconciles the whole
   * supported universe against the provider; a handful an hour is generous for something normally
   * run on a schedule or by hand.
   */
  "admin-operation": {
    description: "Privileged administrative operations.",
    actor: "user",
    points: 10,
    durationSeconds: 3600,
    onRedisFailure: "deny",
  },

  /** See `UNDECLARED_ROUTE_POLICY`. Never applied to a declared route. */
  [UNDECLARED_ROUTE_POLICY]: {
    description:
      "Fallback for a route that declares no policy; the coverage test fails when one exists.",
    actor: "user",
    points: 60,
    durationSeconds: 60,
    onRedisFailure: "allow",
  },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyName = keyof typeof RATE_LIMIT_POLICIES;

/** Policy names a route may declare — every catalog entry except the undeclared fallback. */
export type DeclarableRateLimitPolicyName = Exclude<
  RateLimitPolicyName,
  typeof UNDECLARED_ROUTE_POLICY
>;

export const RATE_LIMIT_POLICY_NAMES = Object.keys(
  RATE_LIMIT_POLICIES,
) as RateLimitPolicyName[];

export function rateLimitPolicy(name: RateLimitPolicyName): RateLimitPolicy {
  return RATE_LIMIT_POLICIES[name];
}

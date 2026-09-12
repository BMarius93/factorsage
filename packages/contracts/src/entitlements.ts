import type { UserRole } from "./index.js";

/**
 * Entitlements V1 — the one central definition of what each commercial plan may do.
 *
 * `docs/decisions/entitlements-v1.md` is the product decision this file carries; it is not
 * restated or reinterpreted here. Everything below is pure: no I/O, no clock, no database and no
 * billing provider. That is what lets the API, the backtest worker, the Monitor worker and the
 * browser share one answer to "what is this identity allowed to do" instead of four.
 *
 * **The matrix is the only place a plan is compared.** Application code asks for a semantic
 * capability or limit — `entitlements.backtests.maxSymbols` — and never writes
 * `if (user.plan === "PRO")`. A scattered plan comparison is how a limit silently stops applying
 * on one of the paths that can reach the resource.
 *
 * **Stripe is not an input.** A billing provider may move a user between `UserPlan` values at the
 * billing boundary; the entitlements each value grants are decided here. Nothing in this module,
 * or anything that resolves through it, may consult a biller to answer a permission question.
 *
 * **Rate limiting is not modelled here, on purpose.** Entitlements answer "is this identity
 * allowed to perform this class of operation, and within what product limits". How frequently an
 * *allowed* caller may call is a separate, operational mechanism keyed by IP or user identity
 * (section 10 of the decision document). There is deliberately no request-rate field in any type
 * in this file, and `entitlements.rate-limiting-boundary.test.ts` is what keeps it that way.
 */

// ---------------------------------------------------------------------------
// Plans, roles and access states
// ---------------------------------------------------------------------------

/**
 * The persisted commercial plans. Mirrors the `UserPlan` enum in the Prisma schema.
 *
 * `GUEST` is **not** here: it is not a persisted plan and does not require an anonymous `User`
 * row. `ADMIN` is not here either — it is a role, and a role is not something a biller may sell.
 */
export const USER_PLANS = ["FREE", "STARTER", "PRO"] as const;

export type UserPlan = (typeof USER_PLANS)[number];

export function isUserPlan(value: unknown): value is UserPlan {
  return (
    typeof value === "string" && (USER_PLANS as readonly string[]).includes(value)
  );
}

/**
 * Which entitlement set an identity resolved to. Reported for diagnostics and for the UI; never an
 * input to a check, which always reads a named capability or limit instead.
 *
 * `ADMIN` appears here as a *resolved entitlement tier*, not as a plan: an administrator still has
 * a commercial plan, and this says only which set of entitlements was applied on top of it.
 */
export const ENTITLEMENT_TIERS = [
  "GUEST",
  "FREE",
  "STARTER",
  "PRO",
  "ADMIN",
] as const;

export type EntitlementTier = (typeof ENTITLEMENT_TIERS)[number];

/**
 * Who is asking.
 *
 * `GUEST` is the derived access state for "no authenticated session" and carries no user id,
 * because there is no user. An authenticated principal carries the two facts that decide
 * entitlements, and **both must come from trusted persisted data**: a client-supplied `role` or
 * `plan` is not an identity, it is a request to be believed.
 */
export type EntitlementPrincipal =
  | { readonly kind: "GUEST" }
  | {
      readonly kind: "AUTHENTICATED";
      readonly userId: string;
      readonly plan: UserPlan;
      readonly role: UserRole;
    };

export const GUEST_PRINCIPAL: EntitlementPrincipal = { kind: "GUEST" };

export function authenticatedPrincipal(user: {
  id: string;
  plan: UserPlan;
  role: UserRole;
}): EntitlementPrincipal {
  return {
    kind: "AUTHENTICATED",
    userId: user.id,
    plan: user.plan,
    role: user.role,
  };
}

// ---------------------------------------------------------------------------
// The entitlement shape
// ---------------------------------------------------------------------------

/**
 * A capacity bound. `null` means unbounded, which is a real product value here: the decision
 * document gives every authenticated plan an unlimited number of saved Lists and Strategies.
 *
 * `null` rather than `Infinity` so the whole structure survives JSON: `JSON.stringify(Infinity)`
 * is `null` anyway, and a limit that changes meaning when it crosses the wire is a limit that will
 * eventually be read wrong on one side.
 */
export type EntitlementLimit = number | null;

/** True when `usage` is inside `limit`. The one place `null`-means-unbounded is interpreted. */
export function withinLimit(limit: EntitlementLimit, usage: number): boolean {
  return limit === null || usage <= limit;
}

export type Entitlements = {
  /** Which set was applied. Diagnostics and UI only — never branch business logic on it. */
  readonly tier: EntitlementTier;
  /** False exactly for `GUEST`. The cheap precondition behind every authenticated-only capability. */
  readonly authenticated: boolean;

  readonly stocks: {
    readonly canSearch: boolean;
    readonly canViewDetails: boolean;
    /**
     * Stock Details historical visibility, which is **full for every plan including Guest**.
     *
     * It is stated as an entitlement rather than left implicit so that the one place a reader
     * looks for "does a plan restrict history" answers both questions at once: Backtest execution
     * depth is capped per plan, and Stock Details visibility is not. The product horizon still
     * applies to everyone equally; it is a data-retention fact, not a commercial one.
     */
    readonly maxHistoricalYears: EntitlementLimit;
  };

  /**
   * System-owned content. Built-in Lists and Strategies are not counted against a user's custom
   * content and are readable by everyone, Guests included.
   */
  readonly builtInContent: {
    readonly canViewLists: boolean;
    readonly canViewStrategies: boolean;
  };

  readonly lists: {
    readonly canCreateCustom: boolean;
    /** Unlimited (`null`) for every authenticated plan; `0` for Guest, who persists nothing. */
    readonly maxSaved: EntitlementLimit;
    /** Membership capacity of one custom List. */
    readonly maxSymbols: EntitlementLimit;
  };

  readonly strategies: {
    readonly canCreateCustom: boolean;
    readonly maxSaved: EntitlementLimit;
    /**
     * Which analytical primitives the Strategy Builder may use.
     *
     * `ALL` for every authenticated plan, by explicit product decision: monetization is product
     * capacity, not locking indicators, conditions, triggers, calculated series or intrinsic-value
     * primitives behind a tier. A Guest sees built-in content only because they persist nothing,
     * not because a primitive is paywalled.
     */
    readonly analyticalPrimitives: "BUILT_IN_ONLY" | "ALL";
  };

  readonly backtests: {
    readonly canRunLive: boolean;
    /** Precomputed/static demo runs, which every access state may consume. */
    readonly canViewDemo: boolean;
    readonly maxSymbols: EntitlementLimit;
    /** Maximum requested period length, in years. Execution only — see `stocks.maxHistoricalYears`. */
    readonly maxHistoricalYears: EntitlementLimit;
    readonly maxConcurrentRuns: EntitlementLimit;
  };

  readonly monitors: {
    /** How many enabled Monitors may be execution-eligible at once. */
    readonly maxActive: EntitlementLimit;
  };

  readonly admin: {
    /**
     * Administrative surfaces. Resolved from the persisted `role` only, never from a plan and
     * never from anything a client sent.
     */
    readonly canAccessAdminSurfaces: boolean;
  };
};

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * Guest: the derived access state for "no authenticated session".
 *
 * Stateless with respect to application users — no anonymous row, no temporary account, no
 * cleanup. Public reads are open; everything that would persist user-owned content or start live
 * execution is off, and the zeroed capacities exist so a bug that reaches a limit check with a
 * Guest principal fails closed rather than reading an absent value as unbounded.
 */
export const GUEST_ENTITLEMENTS: Entitlements = {
  tier: "GUEST",
  authenticated: false,
  stocks: { canSearch: true, canViewDetails: true, maxHistoricalYears: null },
  builtInContent: { canViewLists: true, canViewStrategies: true },
  lists: { canCreateCustom: false, maxSaved: 0, maxSymbols: 0 },
  strategies: {
    canCreateCustom: false,
    maxSaved: 0,
    analyticalPrimitives: "BUILT_IN_ONLY",
  },
  backtests: {
    canRunLive: false,
    canViewDemo: true,
    maxSymbols: 0,
    maxHistoricalYears: 0,
    maxConcurrentRuns: 0,
  },
  monitors: { maxActive: 0 },
  admin: { canAccessAdminSurfaces: false },
};

function authenticatedEntitlements(input: {
  tier: EntitlementTier;
  listSymbols: number;
  backtestSymbols: number;
  backtestYears: number;
  concurrentRuns: number;
  activeMonitors: number;
}): Entitlements {
  return {
    tier: input.tier,
    authenticated: true,
    stocks: { canSearch: true, canViewDetails: true, maxHistoricalYears: null },
    builtInContent: { canViewLists: true, canViewStrategies: true },
    lists: {
      canCreateCustom: true,
      // No commercial quota on the number of saved Lists, by explicit decision.
      maxSaved: null,
      maxSymbols: input.listSymbols,
    },
    strategies: {
      canCreateCustom: true,
      maxSaved: null,
      analyticalPrimitives: "ALL",
    },
    backtests: {
      canRunLive: true,
      canViewDemo: true,
      maxSymbols: input.backtestSymbols,
      maxHistoricalYears: input.backtestYears,
      maxConcurrentRuns: input.concurrentRuns,
    },
    monitors: { maxActive: input.activeMonitors },
    admin: { canAccessAdminSurfaces: false },
  };
}

/**
 * The commercial matrix, transcribed from section 3 of the decision document.
 *
 * Every number here is a product decision. Changing one changes what customers paid for, so it
 * changes here and in the decision document together — never in feature code.
 */
export const PLAN_ENTITLEMENTS: Readonly<Record<UserPlan, Entitlements>> = {
  FREE: authenticatedEntitlements({
    tier: "FREE",
    listSymbols: 10,
    backtestSymbols: 10,
    backtestYears: 5,
    concurrentRuns: 1,
    activeMonitors: 1,
  }),
  STARTER: authenticatedEntitlements({
    tier: "STARTER",
    listSymbols: 50,
    backtestSymbols: 50,
    backtestYears: 15,
    concurrentRuns: 1,
    activeMonitors: 3,
  }),
  PRO: authenticatedEntitlements({
    tier: "PRO",
    listSymbols: 100,
    backtestSymbols: 100,
    backtestYears: 30,
    concurrentRuns: 2,
    activeMonitors: 10,
  }),
};

/**
 * The `ADMIN` role's own entitlements, applied **on top of** whatever commercial plan the
 * administrator happens to be on.
 *
 * Two things this is not. It is not a plan: `ADMIN` is never a `UserPlan`, is never sold, and is
 * never assigned or removed by a billing provider — it is resolved from persisted `User.role`
 * alone. And it is not a scattered bypass: the decision document asks for admin permissions to be
 * expressed as explicit `ADMIN_ENTITLEMENTS` rather than as `if (role === "ADMIN") return;`
 * sprinkled through the enforcement points, so this is the *only* place the role changes an
 * answer.
 *
 * Why it lifts product capacity as well as opening administrative surfaces: an administrator
 * operates the deployment rather than buying it. The system's own operational paths run as an
 * administrator — catalog synchronization, seeded fixtures, and the developer QA validation matrix
 * that executes a thousand real backtests through the real submission path — and a commercial
 * capacity bound on those would be a billing construct throttling operations. No commercial plan
 * gains anything from this constant.
 */
export const ADMIN_ENTITLEMENTS = {
  tier: "ADMIN" as const,
  lists: { maxSymbols: null },
  backtests: {
    maxSymbols: null,
    maxHistoricalYears: null,
    maxConcurrentRuns: null,
  },
  monitors: { maxActive: null },
  admin: { canAccessAdminSurfaces: true },
} as const;

function applyAdminEntitlements(base: Entitlements): Entitlements {
  return {
    ...base,
    tier: ADMIN_ENTITLEMENTS.tier,
    lists: { ...base.lists, maxSymbols: ADMIN_ENTITLEMENTS.lists.maxSymbols },
    backtests: { ...base.backtests, ...ADMIN_ENTITLEMENTS.backtests },
    monitors: { ...base.monitors, ...ADMIN_ENTITLEMENTS.monitors },
    admin: { ...ADMIN_ENTITLEMENTS.admin },
  };
}

/**
 * The resolver. One function, so there is one answer.
 *
 * Guest resolves without touching persistence at all, which is what makes "no session" a cheap,
 * row-free access state rather than an account that has to be created and cleaned up.
 */
export function resolveEntitlements(
  principal: EntitlementPrincipal,
): Entitlements {
  if (principal.kind === "GUEST") {
    return GUEST_ENTITLEMENTS;
  }
  const base = PLAN_ENTITLEMENTS[principal.plan];
  if (!base) {
    // A persisted plan this code does not know — a rolled-back deployment, a partial migration, a
    // hand-edited row. Failing loudly is the only safe answer: returning `undefined` would make
    // every limit read as "no limit set" at the call site, which is indistinguishable from
    // unlimited.
    throw new Error(
      `Unknown commercial plan \`${String(principal.plan)}\`; entitlements cannot be resolved`,
    );
  }
  return principal.role === "ADMIN" ? applyAdminEntitlements(base) : base;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Machine-readable reasons an entitlement check refused.
 *
 * A UI maps these to an explanation or an upsell; server logic never depends on the message
 * string. They are deliberately distinguishable from authentication, validation, conflict and
 * infrastructure failures: "you are not signed in", "that field is malformed" and "your plan does
 * not include this" are three different things to a user and to an operator.
 */
export const ENTITLEMENT_REASON_CODES = [
  /** No authenticated session, and the operation requires one. */
  "ENTITLEMENT_AUTH_REQUIRED",
  /** The capability is not part of this plan at all. */
  "ENTITLEMENT_FEATURE_UNAVAILABLE",
  "ENTITLEMENT_LIST_SYMBOL_LIMIT",
  "ENTITLEMENT_BACKTEST_SYMBOL_LIMIT",
  "ENTITLEMENT_BACKTEST_HISTORY_LIMIT",
  "ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT",
  "ENTITLEMENT_MONITOR_LIMIT",
  /**
   * An existing resource exceeds the current plan and the requested operation would use it, or
   * would increase the violation. Grandfathered content stays readable; this is what refuses the
   * *new* operation.
   */
  "ENTITLEMENT_RESOURCE_OVER_LIMIT",
] as const;

export type EntitlementReasonCode = (typeof ENTITLEMENT_REASON_CODES)[number];

/** The machine-readable part of a refusal. Carried in the HTTP body; never parsed from prose. */
export type EntitlementErrorDetail = {
  readonly code: EntitlementReasonCode;
  readonly tier: EntitlementTier;
  /** The allowed value, when the refusal is a capacity bound. */
  readonly limit?: number;
  /** Usage at the moment of the check. */
  readonly current?: number;
  /** What the caller asked for. */
  readonly requested?: number;
};

/**
 * An entitlement refusal.
 *
 * Thrown by the semantic assertions and mapped once, centrally, onto `403 Forbidden` — never
 * caught and re-thrown as a validation error, because a plan limit is not a malformed request and
 * a user who "fixes" their input will keep hitting it.
 */
export class EntitlementError extends Error {
  readonly detail: EntitlementErrorDetail;

  constructor(message: string, detail: EntitlementErrorDetail) {
    super(message);
    this.name = "EntitlementError";
    this.detail = detail;
  }

  get code(): EntitlementReasonCode {
    return this.detail.code;
  }
}

// ---------------------------------------------------------------------------
// Semantic assertions that need nothing but the entitlements
// ---------------------------------------------------------------------------

function refuse(
  message: string,
  detail: EntitlementErrorDetail,
): never {
  throw new EntitlementError(message, detail);
}

/** Guests persist nothing. The first check on every authenticated-only capability. */
export function assertAuthenticated(entitlements: Entitlements): void {
  if (!entitlements.authenticated) {
    refuse("Sign in to use this feature", {
      code: "ENTITLEMENT_AUTH_REQUIRED",
      tier: entitlements.tier,
    });
  }
}

export function assertCanCreateCustomList(entitlements: Entitlements): void {
  assertAuthenticated(entitlements);
  if (!entitlements.lists.canCreateCustom) {
    refuse("Your plan does not include custom stock lists", {
      code: "ENTITLEMENT_FEATURE_UNAVAILABLE",
      tier: entitlements.tier,
    });
  }
}

export function assertCanCreateCustomStrategy(
  entitlements: Entitlements,
): void {
  assertAuthenticated(entitlements);
  if (!entitlements.strategies.canCreateCustom) {
    refuse("Your plan does not include custom strategies", {
      code: "ENTITLEMENT_FEATURE_UNAVAILABLE",
      tier: entitlements.tier,
    });
  }
}

/**
 * Membership capacity of one custom List.
 *
 * `current` is what the List holds now and `adding` is how many *new* members the mutation would
 * create, so the check is on the resulting size. This is what makes a downgraded, oversized List
 * behave as the decision document requires: removals and renames always succeed, and only a
 * mutation that would grow the List past the limit is refused — including one that leaves it
 * merely less over-limit than it could have been, because the resulting size is still what counts.
 */
export function assertListSymbolLimit(
  entitlements: Entitlements,
  usage: { current: number; adding: number },
): void {
  assertCanCreateCustomList(entitlements);
  if (usage.adding <= 0) {
    return;
  }
  const resulting = usage.current + usage.adding;
  if (!withinLimit(entitlements.lists.maxSymbols, resulting)) {
    const limit = entitlements.lists.maxSymbols ?? 0;
    refuse(
      `Your plan allows ${limit} stocks per list; this change would make ${resulting}`,
      {
        code: "ENTITLEMENT_LIST_SYMBOL_LIMIT",
        tier: entitlements.tier,
        limit,
        current: usage.current,
        requested: resulting,
      },
    );
  }
}

export function assertCanRunLiveBacktest(entitlements: Entitlements): void {
  assertAuthenticated(entitlements);
  if (!entitlements.backtests.canRunLive) {
    refuse("Sign in to run a live backtest", {
      code: "ENTITLEMENT_FEATURE_UNAVAILABLE",
      tier: entitlements.tier,
    });
  }
}

export function assertBacktestSymbolLimit(
  entitlements: Entitlements,
  symbolCount: number,
): void {
  if (!withinLimit(entitlements.backtests.maxSymbols, symbolCount)) {
    const limit = entitlements.backtests.maxSymbols ?? 0;
    refuse(
      `Your plan allows ${limit} stocks per backtest; this list has ${symbolCount}`,
      {
        code: "ENTITLEMENT_BACKTEST_SYMBOL_LIMIT",
        tier: entitlements.tier,
        limit,
        requested: symbolCount,
      },
    );
  }
}

/**
 * Requested period length, in years.
 *
 * Deliberately the length of the period rather than how far back it starts: the repository's
 * existing `BACKTEST_MAX_PERIOD_YEARS` already means "a period can cover at most N years", and two
 * different meanings for "years of history" on one submission form is how a bound gets applied to
 * the wrong end of a date range. The product's retention horizon is a separate, plan-independent
 * check that still applies to everyone.
 */
export function assertBacktestHistoricalDepth(
  entitlements: Entitlements,
  requestedYears: number,
): void {
  if (!withinLimit(entitlements.backtests.maxHistoricalYears, requestedYears)) {
    const limit = entitlements.backtests.maxHistoricalYears ?? 0;
    refuse(
      `Your plan allows ${limit} years of backtest history; this period covers ${requestedYears}`,
      {
        code: "ENTITLEMENT_BACKTEST_HISTORY_LIMIT",
        tier: entitlements.tier,
        limit,
        requested: requestedYears,
      },
    );
  }
}

/**
 * Concurrency.
 *
 * `inFlight` is how many of the caller's runs are already non-terminal. Callers must read it
 * inside the same serialized transaction that creates the new run, or two submissions arriving
 * together both read the same pre-check value and both proceed — the classic TOCTOU that makes a
 * concurrency limit advisory rather than enforced.
 */
export function assertBacktestConcurrency(
  entitlements: Entitlements,
  inFlight: number,
): void {
  if (!withinLimit(entitlements.backtests.maxConcurrentRuns, inFlight + 1)) {
    const limit = entitlements.backtests.maxConcurrentRuns ?? 0;
    refuse(
      limit === 1
        ? "Your plan runs one backtest at a time; wait for the current one to finish"
        : `Your plan runs ${limit} backtests at a time; ${inFlight} are already running`,
      {
        code: "ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT",
        tier: entitlements.tier,
        limit,
        current: inFlight,
      },
    );
  }
}

/**
 * Active-Monitor capacity, checked when a Monitor is created enabled or switched on.
 *
 * `activeCount` excludes the Monitor being enabled. As with concurrency, it must be read inside
 * the transaction that performs the write.
 */
export function assertCanEnableMonitor(
  entitlements: Entitlements,
  activeCount: number,
): void {
  assertAuthenticated(entitlements);
  if (!withinLimit(entitlements.monitors.maxActive, activeCount + 1)) {
    const limit = entitlements.monitors.maxActive ?? 0;
    refuse(
      limit === 0
        ? "Your plan does not include monitors"
        : `Your plan allows ${limit} active monitor${limit === 1 ? "" : "s"}; you already have ${activeCount}`,
      {
        code: "ENTITLEMENT_MONITOR_LIMIT",
        tier: entitlements.tier,
        limit,
        current: activeCount,
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Derived compliance
// ---------------------------------------------------------------------------

/**
 * How one resource stands against the current entitlements.
 *
 * Always **derived** from current entitlements and current resource state. The decision document
 * is explicit that compliance must not be persisted as a one-time boolean: a stored flag is right
 * only until the plan or the resource changes, and then it is a lie that no read can detect.
 */
export type ResourceCompliance = {
  readonly limit: EntitlementLimit;
  readonly usage: number;
  readonly compliant: boolean;
  /** How far over the limit, or `0` when compliant. */
  readonly overBy: number;
};

export function listCompliance(
  entitlements: Entitlements,
  symbolCount: number,
): ResourceCompliance {
  const limit = entitlements.lists.maxSymbols;
  const compliant = withinLimit(limit, symbolCount);
  return {
    limit,
    usage: symbolCount,
    compliant,
    overBy: compliant ? 0 : symbolCount - (limit ?? 0),
  };
}

/**
 * The operational status of one Monitor, derived rather than persisted.
 *
 * `enabled` is the user's intent and is never rewritten by a plan change. This is the separate
 * concept: what the system will actually do with that intent right now.
 */
export const MONITOR_OPERATIONAL_STATUSES = [
  /** Enabled, within capacity, and its List complies. It scans. */
  "ACTIVE",
  /** The user turned it off. */
  "DISABLED",
  /** Enabled, but entitlements currently prevent it from scanning. */
  "BLOCKED_BY_ENTITLEMENT",
] as const;

export type MonitorOperationalStatus =
  (typeof MONITOR_OPERATIONAL_STATUSES)[number];

/** Why an enabled Monitor is not scanning. Absent unless the status is blocked. */
export const MONITOR_BLOCKED_REASONS = [
  /** Beyond the plan's active-Monitor capacity under the deterministic order. */
  "MONITOR_CAPACITY",
  /** Its referenced List holds more symbols than the plan allows. */
  "LIST_OVER_LIMIT",
] as const;

export type MonitorBlockedReason = (typeof MONITOR_BLOCKED_REASONS)[number];

/** What deciding one Monitor's eligibility needs, and nothing more. */
export type MonitorEligibilityInput = {
  readonly monitorId: string;
  /** The user's persisted intent. */
  readonly enabled: boolean;
  /** Tie-broken by `monitorId`, so the order is reproducible across processes and restarts. */
  readonly createdAt: Date;
  /** Membership size of the referenced Stock List. */
  readonly listSymbolCount: number;
};

export type MonitorEligibility = {
  readonly monitorId: string;
  readonly status: MonitorOperationalStatus;
  /** The one thing the worker asks. */
  readonly executionEligible: boolean;
  readonly blockedReason?: MonitorBlockedReason;
};

/**
 * Resolves every Monitor of **one user** against their current entitlements.
 *
 * The rules, in the order the decision document states them:
 *
 * 1. A disabled Monitor is `DISABLED`. Nothing else is considered — intent comes first.
 * 2. Enabled Monitors are ordered by `createdAt`, then `monitorId`, and the first `maxActive` of
 *    them hold the plan's active slots. A downgrade therefore never deletes a Monitor and never
 *    rewrites `enabled`; it only decides which of them scan, and it decides it the same way every
 *    time. Disabling or deleting a slot-holder, or upgrading, recomputes this and a previously
 *    blocked Monitor resumes on its own.
 * 3. A slot-holder whose List is over the plan's symbol limit still holds its slot but cannot
 *    scan. Holding the slot is deliberate: the slot is the commercial capacity the user has, and
 *    an over-limit List is a separate, correctable problem — letting the next Monitor take the
 *    slot instead would silently reorder which Monitors are active every time a List is edited.
 *
 * Pass the caller's complete Monitor set. A partial set would silently move the slot boundary.
 */
export function resolveMonitorEligibility(
  entitlements: Entitlements,
  monitors: readonly MonitorEligibilityInput[],
): MonitorEligibility[] {
  const capacity = entitlements.monitors.maxActive;
  const ordered = [...monitors].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() ||
      left.monitorId.localeCompare(right.monitorId),
  );

  let slotsTaken = 0;
  const byId = new Map<string, MonitorEligibility>();
  for (const monitor of ordered) {
    if (!monitor.enabled) {
      byId.set(monitor.monitorId, {
        monitorId: monitor.monitorId,
        status: "DISABLED",
        executionEligible: false,
      });
      continue;
    }

    if (!withinLimit(capacity, slotsTaken + 1)) {
      byId.set(monitor.monitorId, {
        monitorId: monitor.monitorId,
        status: "BLOCKED_BY_ENTITLEMENT",
        executionEligible: false,
        blockedReason: "MONITOR_CAPACITY",
      });
      continue;
    }
    slotsTaken += 1;

    if (!listCompliance(entitlements, monitor.listSymbolCount).compliant) {
      byId.set(monitor.monitorId, {
        monitorId: monitor.monitorId,
        status: "BLOCKED_BY_ENTITLEMENT",
        executionEligible: false,
        blockedReason: "LIST_OVER_LIMIT",
      });
      continue;
    }

    byId.set(monitor.monitorId, {
      monitorId: monitor.monitorId,
      status: "ACTIVE",
      executionEligible: true,
    });
  }

  // Returned in the caller's own order so a projection can zip it against its rows.
  return monitors.map(
    (monitor) =>
      byId.get(monitor.monitorId) ?? {
        monitorId: monitor.monitorId,
        status: "DISABLED" as const,
        executionEligible: false,
      },
  );
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

/**
 * `GET /entitlements`. What the current caller — signed in or not — is entitled to.
 *
 * Read-only and advisory: the UI uses it to hide, disable, annotate or upsell, and the server
 * enforces the same matrix independently at every mutation boundary. A client that ignores this
 * response entirely must still be unable to exceed a single limit.
 */
export type EntitlementsResponse = {
  readonly principal: "GUEST" | "AUTHENTICATED";
  /** Absent for a Guest, who has no persisted plan. */
  readonly plan?: UserPlan;
  readonly role?: UserRole;
  readonly entitlements: Entitlements;
};

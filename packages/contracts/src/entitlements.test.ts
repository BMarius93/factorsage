import { describe, expect, it } from "vitest";
import {
  ADMIN_ENTITLEMENTS,
  assertBacktestConcurrency,
  assertBacktestHistoricalDepth,
  assertBacktestSymbolLimit,
  assertCanCreateCustomList,
  assertCanCreateCustomStrategy,
  assertCanEnableMonitor,
  assertCanRunLiveBacktest,
  assertListSymbolLimit,
  EntitlementError,
  ENTITLEMENT_REASON_CODES,
  GUEST_ENTITLEMENTS,
  listCompliance,
  PLAN_ENTITLEMENTS,
  resolveEntitlements,
  resolveMonitorEligibility,
  USER_PLANS,
  withinLimit,
  type EntitlementReasonCode,
  type Entitlements,
  type MonitorEligibilityInput,
  type UserPlan,
} from "./entitlements.js";
import { backtestPeriodYears } from "./dates.js";

/**
 * The commercial matrix, proven number by number against
 * `docs/decisions/entitlements-v1.md`.
 *
 * A static matrix is not evidence on its own — the enforcement suites in `apps/api` and
 * `apps/worker` are what prove a limit is applied — but every one of those suites reads its
 * expected value from *here*. If this file and the decision document ever disagree, every
 * enforcement test would agree with the wrong number, so these assertions spell the values out as
 * literals rather than importing them.
 */

function plan(value: UserPlan): Entitlements {
  return resolveEntitlements({
    kind: "AUTHENTICATED",
    userId: "user-1",
    plan: value,
    role: "USER",
  });
}

const GUEST = resolveEntitlements({ kind: "GUEST" });

function reasonOf(run: () => void): EntitlementReasonCode {
  try {
    run();
  } catch (error) {
    if (error instanceof EntitlementError) {
      return error.detail.code;
    }
    throw error;
  }
  throw new Error("Expected an EntitlementError, but nothing was thrown");
}

describe("commercial plans", () => {
  it("persists exactly FREE, STARTER and PRO", () => {
    expect([...USER_PLANS]).toEqual(["FREE", "STARTER", "PRO"]);
  });

  it("has no GUEST, ADMIN or Pro+ plan", () => {
    const names = USER_PLANS as readonly string[];
    expect(names).not.toContain("GUEST");
    expect(names).not.toContain("ADMIN");
    expect(names).not.toContain("PRO_PLUS");
  });

  it("resolves Guest from the absence of a session, with no user id anywhere", () => {
    expect(GUEST.tier).toBe("GUEST");
    expect(GUEST.authenticated).toBe(false);
    // The whole point: nothing about a Guest is keyed to a persisted row.
    expect(JSON.stringify(GUEST)).not.toContain("userId");
  });
});

describe("the entitlement matrix", () => {
  it("caps symbols per custom list at 10 / 50 / 100", () => {
    expect(plan("FREE").lists.maxSymbols).toBe(10);
    expect(plan("STARTER").lists.maxSymbols).toBe(50);
    expect(plan("PRO").lists.maxSymbols).toBe(100);
  });

  it("caps symbols per live backtest at 10 / 50 / 100", () => {
    expect(plan("FREE").backtests.maxSymbols).toBe(10);
    expect(plan("STARTER").backtests.maxSymbols).toBe(50);
    expect(plan("PRO").backtests.maxSymbols).toBe(100);
  });

  it("caps backtest history at 5 / 15 / 30 years", () => {
    expect(plan("FREE").backtests.maxHistoricalYears).toBe(5);
    expect(plan("STARTER").backtests.maxHistoricalYears).toBe(15);
    expect(plan("PRO").backtests.maxHistoricalYears).toBe(30);
  });

  it("caps concurrent live backtests at 1 / 1 / 2", () => {
    expect(plan("FREE").backtests.maxConcurrentRuns).toBe(1);
    expect(plan("STARTER").backtests.maxConcurrentRuns).toBe(1);
    expect(plan("PRO").backtests.maxConcurrentRuns).toBe(2);
  });

  it("caps active monitors at 1 / 3 / 10, and at 0 for a Guest", () => {
    expect(GUEST.monitors.maxActive).toBe(0);
    expect(plan("FREE").monitors.maxActive).toBe(1);
    expect(plan("STARTER").monitors.maxActive).toBe(3);
    expect(plan("PRO").monitors.maxActive).toBe(10);
  });

  it("leaves saved custom List and Strategy counts unlimited on every paid and free tier", () => {
    for (const value of USER_PLANS) {
      expect(plan(value).lists.maxSaved).toBeNull();
      expect(plan(value).strategies.maxSaved).toBeNull();
      expect(withinLimit(plan(value).lists.maxSaved, 10_000)).toBe(true);
      expect(withinLimit(plan(value).strategies.maxSaved, 10_000)).toBe(true);
    }
  });

  it("gives every authenticated tier every analytical primitive", () => {
    for (const value of USER_PLANS) {
      expect(plan(value).strategies.analyticalPrimitives).toBe("ALL");
      expect(plan(value).strategies.canCreateCustom).toBe(true);
    }
  });

  it("keeps Stock Details history full for every plan, Guest included", () => {
    expect(GUEST.stocks.maxHistoricalYears).toBeNull();
    expect(GUEST.stocks.canSearch).toBe(true);
    expect(GUEST.stocks.canViewDetails).toBe(true);
    for (const value of USER_PLANS) {
      expect(plan(value).stocks.maxHistoricalYears).toBeNull();
    }
  });

  it("lets every access state read built-in content and demo backtests", () => {
    for (const entitlements of [GUEST, ...USER_PLANS.map(plan)]) {
      expect(entitlements.builtInContent.canViewLists).toBe(true);
      expect(entitlements.builtInContent.canViewStrategies).toBe(true);
      expect(entitlements.backtests.canViewDemo).toBe(true);
    }
  });

  it("denies a Guest everything that persists content or executes work", () => {
    expect(GUEST.lists.canCreateCustom).toBe(false);
    expect(GUEST.lists.maxSaved).toBe(0);
    expect(GUEST.strategies.canCreateCustom).toBe(false);
    expect(GUEST.strategies.maxSaved).toBe(0);
    expect(GUEST.backtests.canRunLive).toBe(false);
    expect(GUEST.backtests.maxConcurrentRuns).toBe(0);
    expect(GUEST.strategies.analyticalPrimitives).toBe("BUILT_IN_ONLY");
  });
});

describe("the ADMIN role", () => {
  it("is separate from the commercial plan and only lifts capacity", () => {
    const freeAdmin = resolveEntitlements({
      kind: "AUTHENTICATED",
      userId: "user-1",
      plan: "FREE",
      role: "ADMIN",
    });

    expect(freeAdmin.admin.canAccessAdminSurfaces).toBe(true);
    expect(freeAdmin.backtests.maxConcurrentRuns).toBeNull();
    expect(freeAdmin.lists.maxSymbols).toBeNull();
    expect(freeAdmin.monitors.maxActive).toBeNull();
    // Still a FREE customer commercially: the role never becomes a plan.
    expect(ADMIN_ENTITLEMENTS.tier).toBe("ADMIN");
  });

  it("never grants admin surfaces to a plan on its own", () => {
    for (const value of USER_PLANS) {
      expect(plan(value).admin.canAccessAdminSurfaces).toBe(false);
    }
    expect(GUEST.admin.canAccessAdminSurfaces).toBe(false);
  });

  it("does not mutate the shared plan entitlements it is layered over", () => {
    resolveEntitlements({
      kind: "AUTHENTICATED",
      userId: "user-1",
      plan: "FREE",
      role: "ADMIN",
    });
    expect(PLAN_ENTITLEMENTS.FREE.lists.maxSymbols).toBe(10);
    expect(PLAN_ENTITLEMENTS.FREE.admin.canAccessAdminSurfaces).toBe(false);
    expect(GUEST_ENTITLEMENTS.authenticated).toBe(false);
  });
});

describe("semantic assertions", () => {
  it("names an authentication problem separately from a plan problem", () => {
    expect(reasonOf(() => assertCanCreateCustomList(GUEST))).toBe(
      "ENTITLEMENT_AUTH_REQUIRED",
    );
    expect(reasonOf(() => assertCanCreateCustomStrategy(GUEST))).toBe(
      "ENTITLEMENT_AUTH_REQUIRED",
    );
    expect(reasonOf(() => assertCanRunLiveBacktest(GUEST))).toBe(
      "ENTITLEMENT_AUTH_REQUIRED",
    );
    expect(reasonOf(() => assertCanEnableMonitor(GUEST, 0))).toBe(
      "ENTITLEMENT_AUTH_REQUIRED",
    );
  });

  it("refuses a list mutation that would exceed the plan, and permits one that fits exactly", () => {
    const free = plan("FREE");
    expect(() => assertListSymbolLimit(free, { current: 0, adding: 10 })).not.toThrow();
    expect(() => assertListSymbolLimit(free, { current: 9, adding: 1 })).not.toThrow();
    expect(reasonOf(() => assertListSymbolLimit(free, { current: 9, adding: 2 }))).toBe(
      "ENTITLEMENT_LIST_SYMBOL_LIMIT",
    );
  });

  it("never refuses a mutation that adds nothing, however far over the limit the list is", () => {
    // The downgrade rule: an 83-symbol list on FREE stays correctable.
    expect(() =>
      assertListSymbolLimit(plan("FREE"), { current: 83, adding: 0 }),
    ).not.toThrow();
    expect(reasonOf(() =>
      assertListSymbolLimit(plan("FREE"), { current: 83, adding: 1 }),
    )).toBe("ENTITLEMENT_LIST_SYMBOL_LIMIT");
  });

  it("reports the limit and the usage behind every capacity refusal", () => {
    try {
      assertListSymbolLimit(plan("FREE"), { current: 10, adding: 5 });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(EntitlementError);
      const detail = (error as EntitlementError).detail;
      expect(detail).toMatchObject({
        code: "ENTITLEMENT_LIST_SYMBOL_LIMIT",
        tier: "FREE",
        limit: 10,
        current: 10,
        requested: 15,
      });
    }
  });

  it("applies the backtest symbol and depth bounds at exactly the documented values", () => {
    expect(() => assertBacktestSymbolLimit(plan("STARTER"), 50)).not.toThrow();
    expect(reasonOf(() => assertBacktestSymbolLimit(plan("STARTER"), 51))).toBe(
      "ENTITLEMENT_BACKTEST_SYMBOL_LIMIT",
    );
    expect(() => assertBacktestHistoricalDepth(plan("FREE"), 5)).not.toThrow();
    expect(reasonOf(() => assertBacktestHistoricalDepth(plan("FREE"), 6))).toBe(
      "ENTITLEMENT_BACKTEST_HISTORY_LIMIT",
    );
  });

  it("counts the run being submitted against the concurrency limit", () => {
    expect(() => assertBacktestConcurrency(plan("PRO"), 1)).not.toThrow();
    expect(reasonOf(() => assertBacktestConcurrency(plan("PRO"), 2))).toBe(
      "ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT",
    );
    expect(reasonOf(() => assertBacktestConcurrency(plan("FREE"), 1))).toBe(
      "ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT",
    );
    expect(() => assertBacktestConcurrency(plan("FREE"), 0)).not.toThrow();
  });

  it("counts the monitor being enabled against the active limit", () => {
    expect(() => assertCanEnableMonitor(plan("STARTER"), 2)).not.toThrow();
    expect(reasonOf(() => assertCanEnableMonitor(plan("STARTER"), 3))).toBe(
      "ENTITLEMENT_MONITOR_LIMIT",
    );
  });

  it("publishes every reason code the decision document names", () => {
    expect([...ENTITLEMENT_REASON_CODES]).toEqual([
      "ENTITLEMENT_AUTH_REQUIRED",
      "ENTITLEMENT_FEATURE_UNAVAILABLE",
      "ENTITLEMENT_LIST_SYMBOL_LIMIT",
      "ENTITLEMENT_BACKTEST_SYMBOL_LIMIT",
      "ENTITLEMENT_BACKTEST_HISTORY_LIMIT",
      "ENTITLEMENT_BACKTEST_CONCURRENCY_LIMIT",
      "ENTITLEMENT_MONITOR_LIMIT",
      "ENTITLEMENT_RESOURCE_OVER_LIMIT",
    ]);
  });
});

describe("derived list compliance", () => {
  it("reports an over-limit list without refusing to describe it", () => {
    const compliance = listCompliance(plan("FREE"), 83);
    expect(compliance).toEqual({
      limit: 10,
      usage: 83,
      compliant: false,
      overBy: 73,
    });
  });

  it("is derived, so the same list is compliant again on a higher plan", () => {
    expect(listCompliance(plan("FREE"), 83).compliant).toBe(false);
    expect(listCompliance(plan("PRO"), 83).compliant).toBe(true);
  });
});

describe("derived monitor execution eligibility", () => {
  function monitor(
    id: string,
    createdAt: string,
    overrides: Partial<MonitorEligibilityInput> = {},
  ): MonitorEligibilityInput {
    return {
      monitorId: id,
      enabled: true,
      createdAt: new Date(createdAt),
      listSymbolCount: 1,
      ...overrides,
    };
  }

  const three = [
    monitor("m-c", "2026-03-01T00:00:00.000Z"),
    monitor("m-a", "2026-01-01T00:00:00.000Z"),
    monitor("m-b", "2026-02-01T00:00:00.000Z"),
  ];

  function statusById(entitlements: Entitlements, input = three) {
    return new Map(
      resolveMonitorEligibility(entitlements, input).map((entry) => [
        entry.monitorId,
        entry,
      ]),
    );
  }

  it("gives the plan's slots to the oldest enabled monitors, whatever order they arrive in", () => {
    const byId = statusById(plan("FREE"));
    expect(byId.get("m-a")?.status).toBe("ACTIVE");
    expect(byId.get("m-b")?.status).toBe("BLOCKED_BY_ENTITLEMENT");
    expect(byId.get("m-c")?.status).toBe("BLOCKED_BY_ENTITLEMENT");
    expect(byId.get("m-b")?.blockedReason).toBe("MONITOR_CAPACITY");
  });

  it("breaks a createdAt tie on monitor id, so the choice is reproducible", () => {
    const tied = [
      monitor("m-z", "2026-01-01T00:00:00.000Z"),
      monitor("m-y", "2026-01-01T00:00:00.000Z"),
    ];
    const byId = statusById(plan("FREE"), tied);
    expect(byId.get("m-y")?.status).toBe("ACTIVE");
    expect(byId.get("m-z")?.status).toBe("BLOCKED_BY_ENTITLEMENT");
  });

  it("never rewrites intent: a disabled monitor is DISABLED and consumes no slot", () => {
    const withDisabled = [
      monitor("m-a", "2026-01-01T00:00:00.000Z", { enabled: false }),
      monitor("m-b", "2026-02-01T00:00:00.000Z"),
    ];
    const byId = statusById(plan("FREE"), withDisabled);
    expect(byId.get("m-a")?.status).toBe("DISABLED");
    // The slot went to the next enabled one rather than being consumed by the disabled monitor.
    expect(byId.get("m-b")?.status).toBe("ACTIVE");
  });

  it("resumes a blocked monitor the moment capacity appears", () => {
    expect(statusById(plan("FREE")).get("m-b")?.status).toBe(
      "BLOCKED_BY_ENTITLEMENT",
    );
    // Upgrading recomputes with no write of any kind.
    expect(statusById(plan("STARTER")).get("m-b")?.status).toBe("ACTIVE");
    // And so does disabling the monitor that held the slot.
    const afterDisable = statusById(plan("FREE"), [
      monitor("m-a", "2026-01-01T00:00:00.000Z", { enabled: false }),
      monitor("m-b", "2026-02-01T00:00:00.000Z"),
      monitor("m-c", "2026-03-01T00:00:00.000Z"),
    ]);
    expect(afterDisable.get("m-b")?.status).toBe("ACTIVE");
  });

  it("blocks a monitor whose list is over the plan's symbol limit, and keeps its slot", () => {
    const byId = statusById(plan("STARTER"), [
      monitor("m-a", "2026-01-01T00:00:00.000Z", { listSymbolCount: 83 }),
      monitor("m-b", "2026-02-01T00:00:00.000Z", { listSymbolCount: 2 }),
    ]);
    expect(byId.get("m-a")?.status).toBe("BLOCKED_BY_ENTITLEMENT");
    expect(byId.get("m-a")?.blockedReason).toBe("LIST_OVER_LIMIT");
    expect(byId.get("m-a")?.executionEligible).toBe(false);
    expect(byId.get("m-b")?.status).toBe("ACTIVE");
  });

  it("blocks every monitor for a Guest, who has no active capacity at all", () => {
    for (const entry of resolveMonitorEligibility(GUEST, three)) {
      expect(entry.executionEligible).toBe(false);
    }
  });

  it("returns one decision per monitor, in the caller's own order", () => {
    const decisions = resolveMonitorEligibility(plan("PRO"), three);
    expect(decisions.map((entry) => entry.monitorId)).toEqual([
      "m-c",
      "m-a",
      "m-b",
    ]);
  });
});

describe("requested backtest history", () => {
  it("measures the period in the same whole years the plan limit is stated in", () => {
    expect(backtestPeriodYears("2020-01-01", "2025-01-01")).toBe(5);
    expect(backtestPeriodYears("2020-01-01", "2025-01-02")).toBe(6);
    expect(backtestPeriodYears("2020-01-01", "2020-12-31")).toBe(1);
    expect(backtestPeriodYears("1996-01-01", "2026-01-01")).toBe(30);
  });

  it("clamps 29 February the same way the horizon does, so both bounds agree", () => {
    expect(backtestPeriodYears("2020-02-29", "2025-02-28")).toBe(5);
    expect(backtestPeriodYears("2020-02-29", "2025-03-01")).toBe(6);
  });
});

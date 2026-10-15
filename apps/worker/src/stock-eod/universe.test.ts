import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import type { ActiveMonitor, ActiveMonitorMember } from "../monitor/monitor-repository.js";
import { stockEodUniverse } from "./universe.js";

const SESSION = "2026-10-14";

/** `Price <operator> <series>` as the only BUY condition. */
function definition(
  operator: "IS_ABOVE" | "IS_BELOW",
  seriesId: string,
): StrategyDefinition {
  return {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "buy-1",
        percentage: 100,
        signal: {
          conditions: [
            {
              id: "c-1",
              metric: { kind: "PRICE" },
              operator,
              value: { kind: "SERIES", seriesId },
            },
          ],
        },
      },
    ],
    sellLevels: [],
  } as StrategyDefinition;
}

const PRICE_ONLY = definition("IS_ABOVE", "SMA_200D");
const INTRINSIC = definition("IS_BELOW", "DCF_FCFF");

function member(
  securityId: string,
  windows: Pick<ActiveMonitorMember, "buyWindowMode" | "buyWindows"> = {
    buyWindowMode: "FULL",
    buyWindows: [],
  },
): ActiveMonitorMember {
  return { securityId, symbol: securityId.toUpperCase(), ...windows };
}

function monitor(
  monitorId: string,
  members: ActiveMonitorMember[],
  strategy: unknown = PRICE_ONLY,
): ActiveMonitor {
  return {
    monitorId,
    name: monitorId,
    ownership: "USER",
    actorUserId: "user-1",
    strategyId: `strategy-${monitorId}`,
    configVersion: 0,
    strategyVersionId: `version-${monitorId}`,
    definition: strategy,
    members,
  };
}

describe("the stock EOD universe", () => {
  it("prepares a security watched by several Monitors once, with the union of what they read", () => {
    const { targets } = stockEodUniverse(
      [
        monitor("a", [member("aapl"), member("msft")]),
        monitor("b", [member("aapl")], INTRINSIC),
      ],
      SESSION,
    );
    expect(targets.map((t) => t.securityId)).toEqual(["aapl", "msft"]);
    const aapl = targets[0]!;
    expect(aapl.monitors).toBe(2);
    expect(aapl.readsStatements).toBe(true);
    expect(aapl.operands).toContain("price");
    expect(aapl.operands).toContain("series:DCF_FCFF");
    // MSFT is only read by a price strategy: its statements are left alone.
    expect(targets[1]!.readsStatements).toBe(false);
  });

  it("watches only ongoing members: Always eligible, or an open period that has begun", () => {
    const { targets } = stockEodUniverse(
      [
        monitor("a", [
          member("full"),
          member("present", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "2024-06-24", endDate: null }],
          }),
          member("future-start", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "2027-01-04", endDate: null }],
          }),
          member("bounded-future-end", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "2020-01-02", endDate: "2030-12-31" }],
          }),
          member("ended", {
            buyWindowMode: "CUSTOM",
            buyWindows: [{ startDate: "2001-03-10", endDate: "2008-07-15" }],
          }),
        ]),
      ],
      SESSION,
    );
    expect(targets.map((t) => t.securityId).sort()).toEqual(["full", "present"]);
  });

  it("skips a Monitor whose stored definition no longer normalizes, and says which", () => {
    const { targets, invalidMonitorIds } = stockEodUniverse(
      [monitor("broken", [member("aapl")], { nonsense: true }), monitor("ok", [member("msft")])],
      SESSION,
    );
    expect(invalidMonitorIds).toEqual(["broken"]);
    expect(targets.map((t) => t.securityId)).toEqual(["msft"]);
  });
});

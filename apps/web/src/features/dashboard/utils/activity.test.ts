import type {
  DashboardActivityEventResponse,
  MonitorWhyPredicateResponse,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  compareFeedOrder,
  groupBySession,
  mergeArrivals,
  operandRelation,
  predicateComparison,
} from "./activity";

function event(
  id: string,
  sessionDate: string,
): DashboardActivityEventResponse {
  return { id, sessionDate } as DashboardActivityEventResponse;
}

describe("groupBySession", () => {
  it("writes each session once, newest first, keeping the API's order inside it", () => {
    const groups = groupBySession([
      event("e5", "2026-10-20"),
      event("e4", "2026-10-20"),
      event("e3", "2026-10-19"),
      event("e2", "2026-10-16"),
      event("e1", "2026-10-16"),
    ]);
    expect(
      groups.map((group) => [
        group.sessionDate,
        group.events.map((one) => one.id),
      ]),
    ).toEqual([
      ["2026-10-20", ["e5", "e4"]],
      ["2026-10-19", ["e3"]],
      ["2026-10-16", ["e2", "e1"]],
    ]);
  });

  it("gathers a session that a page boundary split under one heading", () => {
    const firstPage = [event("e9", "2026-10-20"), event("e8", "2026-10-19")];
    const olderPage = [event("e7", "2026-10-19"), event("e6", "2026-10-15")];
    const groups = groupBySession([...firstPage, ...olderPage]);
    expect(groups.map((group) => group.sessionDate)).toEqual([
      "2026-10-20",
      "2026-10-19",
      "2026-10-15",
    ]);
    expect(groups[1]!.events.map((one) => one.id)).toEqual(["e8", "e7"]);
  });

  it("keeps two events of one stock on one session as two events", () => {
    // Buy 1 and Buy 2 of the same stock, same Monitor, same session: different events.
    const groups = groupBySession([
      event("buy-2", "2026-10-20"),
      event("buy-1", "2026-10-20"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.events.map((one) => one.id)).toEqual(["buy-2", "buy-1"]);
  });

  it("groups by the exchange session the API recorded, never a local calendar date", () => {
    // Nothing is parsed into an instant: the string is the session.
    const groups = groupBySession([
      event("late", "2026-10-20"),
      event("early", "2026-10-19"),
    ]);
    expect(groups.map((group) => group.sessionDate)).toEqual([
      "2026-10-20",
      "2026-10-19",
    ]);
    expect(groupBySession([])).toEqual([]);
  });
});

describe("mergeArrivals", () => {
  const at = (id: string, sequence: number, sessionDate: string) =>
    ({
      id,
      sequence: String(sequence),
      sessionDate,
    }) as DashboardActivityEventResponse;
  const shown = [
    at("a", 30, "2026-10-14"),
    at("b", 20, "2026-10-13"),
    at("c", 10, "2026-10-12"),
  ];

  it("orders newest session first, then newest written, comparing sequences as numbers", () => {
    expect(
      compareFeedOrder(at("x", 9, "2026-10-14"), at("y", 10, "2026-10-14")),
    ).toBe(1);
    expect(
      compareFeedOrder(at("x", 100, "2026-10-13"), at("y", 9, "2026-10-14")),
    ).toBe(1);
    expect(
      compareFeedOrder(at("x", 5, "2026-10-14"), at("x", 5, "2026-10-14")),
    ).toBe(0);
  });

  it("puts new events above and late events inside their session, counting each kind", () => {
    const merged = mergeArrivals(
      shown,
      [at("new", 40, "2026-10-15"), at("late", 41, "2026-10-13")],
      { complete: false },
    );
    expect(merged.events.map((event) => event.id)).toEqual([
      "new",
      "a",
      "late",
      "b",
      "c",
    ]);
    expect(merged).toMatchObject({ above: 1, within: 1 });
  });

  it("leaves what sorts after the oldest loaded event to paging, unless the history is complete", () => {
    const older = at("old", 50, "2026-10-01");
    expect(mergeArrivals(shown, [older], { complete: false })).toEqual({
      events: shown,
      above: 0,
      within: 0,
    });
    expect(
      mergeArrivals(shown, [older], { complete: true }).events.at(-1)?.id,
    ).toBe("old");
  });

  it("ignores events already shown and returns the same list when nothing is placed", () => {
    const merged = mergeArrivals(shown, [shown[0]!, shown[2]!], {
      complete: true,
    });
    expect(merged.events).toBe(shown);
    expect(merged).toMatchObject({ above: 0, within: 0 });
  });
});

describe("operandRelation", () => {
  it("states how the two recorded numbers compare, whatever the rule asked", () => {
    expect(operandRelation(419.26, 412.3)).toBe(">");
    expect(operandRelation(0.85, 1.2)).toBe("<");
    expect(operandRelation(55, 55)).toBe("=");
  });

  it("claims no relation an operand cannot support, or that the printed values would contradict", () => {
    expect(operandRelation(null, 55)).toBe("vs");
    expect(operandRelation(42.5, undefined)).toBe("vs");
    // 55.004 and 55.001 both print 55.00: `55.00 > 55.00` would read as a contradiction.
    expect(operandRelation(55.004, 55.001)).toBe("vs");
  });
});

describe("predicateComparison", () => {
  const condition = (
    overrides: Partial<MonitorWhyPredicateResponse>,
  ): MonitorWhyPredicateResponse => ({
    role: "CONDITION",
    description: "RSI 14D is below 55",
    result: "TRUE",
    metric: 42.5,
    value: 55,
    ...overrides,
  });

  it("writes a Condition's operands with their relation", () => {
    expect(predicateComparison(condition({}))).toBe("42.50 < 55.00");
    expect(
      predicateComparison(
        condition({
          description: "Price is above EMA 20D",
          metric: 419.26,
          value: 412.3,
        }),
      ),
    ).toBe("419.26 > 412.30");
  });

  it("shows a failed Condition's real relation beside its ✕", () => {
    expect(
      predicateComparison(
        condition({
          description: "Relative volume is above 1.2",
          result: "FALSE",
          metric: 0.85,
          value: 1.2,
        }),
      ),
    ).toBe("0.85 < 1.20");
  });

  it("writes a Trigger's move from the previous session", () => {
    expect(
      predicateComparison({
        role: "TRIGGER",
        description: "Price crosses above SMA 20D",
        result: "TRUE",
        previousMetric: 99.5,
        previousValue: 100.2,
        metric: 102.5,
        value: 101,
      }),
    ).toBe("99.50 → 102.50 > 101.00");
  });

  it("says n/a for an operand that did not resolve, and invents nothing when no values were recorded", () => {
    expect(
      predicateComparison(
        condition({ result: "NOT_EVALUABLE", metric: null, value: 55 }),
      ),
    ).toBe("n/a vs 55.00");
    expect(
      predicateComparison({
        role: "CONDITION",
        description: "Price is above SMA 200D",
      }),
    ).toBeNull();
  });
});

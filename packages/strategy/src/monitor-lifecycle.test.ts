import { describe, expect, it } from "vitest";
import { Evaluability } from "./evaluability.js";
import {
  INITIAL_MONITOR_LEVEL_LIFECYCLE,
  parseMonitorRuleStates,
  replayMonitorLevel,
  stepMonitorLevel,
  type MonitorLevelLifecycle,
  type MonitorLevelStepResult,
  type MonitorRuleObservation,
} from "./monitor-lifecycle.js";

/**
 * The accepted signal lifecycle (`docs/decisions/builtin-dashboard-signals-v1.md` section 2),
 * exercised through the pure reducer both the live cycle and reconstruction use.
 */

const { TRUE, FALSE, NOT_EVALUABLE } = Evaluability;
type E = (typeof Evaluability)[keyof typeof Evaluability];

function rule(
  conditions: E | null,
  trigger: E | null,
  key = "level-1",
  exitRuleId: string | null = null,
): MonitorRuleObservation {
  return { key, exitRuleId, conditions, trigger };
}

/** Runs a sequence of single-rule steps and returns every result. */
function run(
  steps: {
    date: string;
    conditions: E | null;
    trigger: E | null;
    eligible?: boolean;
  }[],
  initial: MonitorLevelLifecycle = INITIAL_MONITOR_LEVEL_LIFECYCLE,
): MonitorLevelStepResult[] {
  const results: MonitorLevelStepResult[] = [];
  let current = initial;
  for (const step of steps) {
    const result = stepMonitorLevel(current, {
      date: step.date,
      eligible: step.eligible ?? true,
      rules: [rule(step.conditions, step.trigger)],
    });
    results.push(result);
    current = result.next;
  }
  return results;
}

function opened(results: MonitorLevelStepResult[]): number {
  return results.filter((result) => result.opened).length;
}

describe("conditions only", () => {
  it("false -> true -> true -> false creates one occurrence then resolves it", () => {
    const results = run([
      { date: "2026-03-02", conditions: FALSE, trigger: null },
      { date: "2026-03-03", conditions: TRUE, trigger: null },
      { date: "2026-03-04", conditions: TRUE, trigger: null },
      { date: "2026-03-05", conditions: FALSE, trigger: null },
    ]);
    expect(results.map((result) => result.next.state)).toEqual([
      "INACTIVE",
      "ACTIVE",
      "ACTIVE",
      "RESOLVED",
    ]);
    expect(opened(results)).toBe(1);
    expect(results[3]!.closed).toEqual({ reason: "CONDITIONS_ENDED" });
    // Only state changes are transitions; a repeated true writes nothing.
    expect(results.map((result) => result.transitions.length)).toEqual([
      0, 1, 0, 1,
    ]);
    expect(results[2]!.changed).toBe(false);
    expect(results[1]!.transitions[0]).toMatchObject({
      from: "INACTIVE",
      to: "ACTIVE",
      reason: "CONDITIONS_MET",
    });
  });

  it("a later true run is a new occurrence, never a reopened one", () => {
    const results = run([
      { date: "2026-03-02", conditions: TRUE, trigger: null },
      { date: "2026-03-03", conditions: FALSE, trigger: null },
      { date: "2026-03-04", conditions: TRUE, trigger: null },
    ]);
    expect(opened(results)).toBe(2);
    expect(results[2]!.transitions[0]).toMatchObject({
      from: "RESOLVED",
      to: "ACTIVE",
    });
  });

  it("NOT_EVALUABLE moves nothing", () => {
    const results = run([
      { date: "2026-03-02", conditions: TRUE, trigger: null },
      { date: "2026-03-03", conditions: NOT_EVALUABLE, trigger: null },
    ]);
    expect(results[1]!.changed).toBe(false);
    expect(results[1]!.next.state).toBe("ACTIVE");
  });
});

describe("conditions + trigger", () => {
  it("waits for the trigger, fires once, and stays active while the trigger predicate is false", () => {
    const results = run([
      { date: "2026-03-02", conditions: TRUE, trigger: FALSE },
      { date: "2026-03-03", conditions: TRUE, trigger: FALSE },
      { date: "2026-03-04", conditions: TRUE, trigger: TRUE },
      { date: "2026-03-05", conditions: TRUE, trigger: FALSE },
      { date: "2026-03-06", conditions: TRUE, trigger: TRUE },
    ]);
    expect(results.map((result) => result.next.state)).toEqual([
      "PENDING_TRIGGER",
      "PENDING_TRIGGER",
      "ACTIVE",
      "ACTIVE",
      "ACTIVE",
    ]);
    expect(opened(results)).toBe(1);
    expect(results[0]!.transitions[0]).toMatchObject({
      from: "INACTIVE",
      to: "PENDING_TRIGGER",
      reason: "SETUP_STARTED",
    });
    expect(results[2]!.transitions[0]).toMatchObject({
      from: "PENDING_TRIGGER",
      to: "ACTIVE",
      reason: "TRIGGER_FIRED",
    });
    // A second crossing while active is not a second occurrence and writes nothing.
    expect(results[4]!.changed).toBe(false);
  });

  it("resolves when a Condition becomes false", () => {
    const results = run([
      { date: "2026-03-02", conditions: TRUE, trigger: TRUE },
      { date: "2026-03-03", conditions: FALSE, trigger: FALSE },
    ]);
    expect(results[0]!.next.state).toBe("ACTIVE");
    expect(results[1]!.next.state).toBe("RESOLVED");
    expect(results[1]!.closed).toEqual({ reason: "CONDITIONS_ENDED" });
  });

  it("a setup that breaks before the trigger returns to INACTIVE without an occurrence", () => {
    const results = run([
      { date: "2026-03-02", conditions: TRUE, trigger: FALSE },
      { date: "2026-03-03", conditions: FALSE, trigger: TRUE },
    ]);
    expect(results[1]!.next.state).toBe("INACTIVE");
    expect(results[1]!.closed).toBeNull();
    expect(opened(results)).toBe(0);
    expect(results[1]!.transitions).toEqual([
      expect.objectContaining({ from: "PENDING_TRIGGER", to: "INACTIVE" }),
    ]);
  });

  it("after a resolution, a fresh setup needs a fresh trigger", () => {
    const results = run([
      // Fires on the 2nd and resolves intraday on the same session.
      { date: "2026-03-02", conditions: TRUE, trigger: TRUE },
      { date: "2026-03-02", conditions: FALSE, trigger: TRUE },
      // Conditions recover the same session: the crossing already consumed does not count.
      { date: "2026-03-02", conditions: TRUE, trigger: TRUE },
      // The next session without a crossing keeps waiting.
      { date: "2026-03-03", conditions: TRUE, trigger: FALSE },
      // A genuine new crossing starts a new occurrence.
      { date: "2026-03-04", conditions: TRUE, trigger: TRUE },
    ]);
    expect(results.map((result) => result.next.state)).toEqual([
      "ACTIVE",
      "RESOLVED",
      "PENDING_TRIGGER",
      "PENDING_TRIGGER",
      "ACTIVE",
    ]);
    expect(results[2]!.transitions[0]).toMatchObject({
      from: "RESOLVED",
      to: "PENDING_TRIGGER",
    });
    expect(opened(results)).toBe(2);
  });

  it("an undecidable Condition keeps the latch whatever the trigger does", () => {
    const results = run([
      { date: "2026-03-02", conditions: TRUE, trigger: TRUE },
      { date: "2026-03-03", conditions: NOT_EVALUABLE, trigger: FALSE },
    ]);
    expect(results[1]!.next.state).toBe("ACTIVE");
    expect(results[1]!.changed).toBe(false);
  });
});

describe("trigger only", () => {
  it("stays active for the firing session and resolves on the next observed session", () => {
    const results = run([
      { date: "2026-03-06", conditions: null, trigger: TRUE },
      // Re-scans of the same Friday session, the predicate degenerating either way.
      { date: "2026-03-06", conditions: null, trigger: FALSE },
      { date: "2026-03-06", conditions: null, trigger: TRUE },
      // Monday is observed: the event ends, even though nothing can be decided.
      { date: "2026-03-09", conditions: null, trigger: NOT_EVALUABLE },
    ]);
    expect(results.map((result) => result.next.state)).toEqual([
      "ACTIVE",
      "ACTIVE",
      "ACTIVE",
      "RESOLVED",
    ]);
    expect(opened(results)).toBe(1);
    expect(results[3]!.closed).toEqual({ reason: "EVENT_SESSION_ENDED" });
  });

  it("a weekend, a holiday or a missing quote produces no step and so resolves nothing", () => {
    // Those cycles never call the reducer. A reading of an older session does not either.
    const [fired] = run([
      { date: "2026-03-06", conditions: null, trigger: TRUE },
    ]);
    const older = stepMonitorLevel(fired!.next, {
      date: "2026-03-05",
      eligible: true,
      rules: [rule(null, FALSE)],
    });
    expect(older.changed).toBe(false);
    expect(older.next.state).toBe("ACTIVE");
  });

  it("a crossing on the next session ends the old event and begins a new one", () => {
    const results = run([
      { date: "2026-03-06", conditions: null, trigger: TRUE },
      { date: "2026-03-09", conditions: null, trigger: TRUE },
    ]);
    expect(results[1]!.closed).toEqual({ reason: "EVENT_SESSION_ENDED" });
    expect(results[1]!.opened).toBe(true);
    expect(
      results[1]!.transitions.map((transition) => [
        transition.from,
        transition.to,
      ]),
    ).toEqual([
      ["ACTIVE", "RESOLVED"],
      ["RESOLVED", "ACTIVE"],
    ]);
  });
});

describe("buy-window eligibility", () => {
  it("an ineligible observation neither starts a setup nor an occurrence", () => {
    const results = run([
      { date: "2026-03-02", conditions: TRUE, trigger: FALSE, eligible: false },
      { date: "2026-03-03", conditions: TRUE, trigger: TRUE, eligible: false },
      { date: "2026-03-04", conditions: TRUE, trigger: null, eligible: false },
    ]);
    expect(results.every((result) => result.next.state === "INACTIVE")).toBe(
      true,
    );
    expect(results.every((result) => result.transitions.length === 0)).toBe(
      true,
    );
  });

  it("resolves an active occurrence and drops a pending setup when eligibility ends", () => {
    const [active] = run([
      { date: "2026-03-02", conditions: TRUE, trigger: null },
    ]);
    const closed = stepMonitorLevel(active!.next, {
      date: "2026-03-03",
      eligible: false,
      rules: [rule(TRUE, null)],
    });
    expect(closed.closed).toEqual({ reason: "BUY_WINDOW_CLOSED" });

    const [pending] = run([
      { date: "2026-03-02", conditions: TRUE, trigger: FALSE },
    ]);
    const dropped = stepMonitorLevel(pending!.next, {
      date: "2026-03-03",
      eligible: false,
      rules: [rule(TRUE, FALSE)],
    });
    expect(dropped.next.state).toBe("INACTIVE");
    expect(dropped.closed).toBeNull();
    expect(dropped.transitions[0]).toMatchObject({
      reason: "BUY_WINDOW_CLOSED",
    });
  });

  it("the caller passes eligible=true for SELL and FINAL EXIT, so nothing gates them", () => {
    const results = run([
      { date: "2026-03-02", conditions: TRUE, trigger: null, eligible: true },
    ]);
    expect(results[0]!.opened).toBe(true);
  });
});

describe("FINAL EXIT with several Exit Rules", () => {
  const rules = (a: [E | null, E | null], b: [E | null, E | null]) => [
    rule(a[0], a[1], "exit-a", "exit-a"),
    rule(b[0], b[1], "exit-b", "exit-b"),
  ];

  it("several rules matching on one observation produce one occurrence", () => {
    const result = stepMonitorLevel(INITIAL_MONITOR_LEVEL_LIFECYCLE, {
      date: "2026-03-02",
      eligible: true,
      rules: rules([TRUE, null], [null, TRUE]),
    });
    expect(result.opened).toBe(true);
    expect(result.transitions).toHaveLength(1);
    expect(result.transitions[0]!.exitRuleId).toBe("exit-a");
    expect(Object.keys(result.next.rules)).toEqual(["exit-a", "exit-b"]);
  });

  it("keeps rule-local trigger state apart and stays one occurrence while any rule is active", () => {
    // Rule B waits for its trigger while rule A is active on its conditions.
    let state = stepMonitorLevel(INITIAL_MONITOR_LEVEL_LIFECYCLE, {
      date: "2026-03-02",
      eligible: true,
      rules: rules([TRUE, null], [TRUE, FALSE]),
    });
    expect(state.next.state).toBe("ACTIVE");
    expect(state.next.rules["exit-b"]!.state).toBe("PENDING_TRIGGER");
    // B fires while A ends: the level occurrence continues rather than closing and reopening.
    state = stepMonitorLevel(state.next, {
      date: "2026-03-03",
      eligible: true,
      rules: rules([FALSE, null], [TRUE, TRUE]),
    });
    expect(state.next.state).toBe("ACTIVE");
    expect(state.closed).toBeNull();
    expect(state.opened).toBe(false);
    expect(state.next.rules["exit-a"]!.state).toBe("RESOLVED");
    expect(state.next.rules["exit-b"]!.state).toBe("ACTIVE");
    // B's latched trigger is maintained by its condition; A becoming true again changes no level.
    state = stepMonitorLevel(state.next, {
      date: "2026-03-04",
      eligible: true,
      rules: rules([TRUE, null], [TRUE, FALSE]),
    });
    expect(state.next.state).toBe("ACTIVE");
    expect(state.transitions).toHaveLength(0);
    // Both end: one resolution.
    state = stepMonitorLevel(state.next, {
      date: "2026-03-05",
      eligible: true,
      rules: rules([FALSE, null], [FALSE, FALSE]),
    });
    expect(state.closed).toEqual({ reason: "CONDITIONS_ENDED" });
    expect(state.transitions).toHaveLength(1);
  });

  it("one pending rule breaking while another starts a setup is not a level transition", () => {
    const first = stepMonitorLevel(INITIAL_MONITOR_LEVEL_LIFECYCLE, {
      date: "2026-03-02",
      eligible: true,
      rules: rules([TRUE, FALSE], [FALSE, FALSE]),
    });
    const second = stepMonitorLevel(first.next, {
      date: "2026-03-03",
      eligible: true,
      rules: rules([FALSE, FALSE], [TRUE, FALSE]),
    });
    expect(second.next.state).toBe("PENDING_TRIGGER");
    expect(second.transitions).toEqual([]);
    expect(second.next.since).toBe("2026-03-02");
    expect(second.changed).toBe(true);
  });

  it("a level stored before rule-local state existed converges from its own state", () => {
    const legacy: MonitorLevelLifecycle = {
      state: "ACTIVE",
      since: "2026-03-02",
      rules: {},
    };
    const result = stepMonitorLevel(legacy, {
      date: "2026-03-03",
      eligible: true,
      rules: rules([FALSE, null], [null, FALSE]),
    });
    expect(result.next.state).toBe("RESOLVED");
    expect(result.closed).not.toBeNull();
  });
});

describe("retries and replay", () => {
  it("re-applying the same observation changes nothing", () => {
    const [first] = run([
      { date: "2026-03-02", conditions: TRUE, trigger: TRUE },
    ]);
    const again = stepMonitorLevel(first!.next, {
      date: "2026-03-02",
      eligible: true,
      rules: [rule(TRUE, TRUE)],
    });
    expect(again.changed).toBe(false);
    expect(again.transitions).toEqual([]);
    expect(again.opened).toBe(false);
  });

  it("replay is deterministic and establishes a trigger that fired before the replay ended", () => {
    const steps = [
      { date: "2026-03-02", eligible: true, rules: [rule(FALSE, FALSE)] },
      { date: "2026-03-03", eligible: true, rules: [rule(TRUE, FALSE)] },
      { date: "2026-03-04", eligible: true, rules: [rule(TRUE, TRUE)] },
      { date: "2026-03-05", eligible: true, rules: [rule(TRUE, FALSE)] },
    ];
    const once = replayMonitorLevel(steps);
    expect(once).toEqual(replayMonitorLevel(steps));
    expect(once.state).toBe("ACTIVE");
    expect(once.since).toBe("2026-03-04");
    expect(once.rules["level-1"]!.triggerDate).toBe("2026-03-04");
  });
});

describe("parseMonitorRuleStates", () => {
  it("keeps well-formed rules and drops anything it cannot trust", () => {
    expect(
      parseMonitorRuleStates({
        good: { state: "ACTIVE", since: "2026-03-02", triggerDate: null },
        badState: { state: "MATCHED", since: null, triggerDate: null },
        badDate: { state: "INACTIVE", since: "yesterday", triggerDate: null },
        missing: { state: "INACTIVE" },
        notAnObject: 7,
      }),
    ).toEqual({
      good: { state: "ACTIVE", since: "2026-03-02", triggerDate: null },
    });
    expect(parseMonitorRuleStates(null)).toEqual({});
    expect(parseMonitorRuleStates([])).toEqual({});
  });
});

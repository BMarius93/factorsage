import { describe, expect, it } from "vitest";
import { Evaluability } from "./evaluability.js";
import {
  INITIAL_MONITOR_LEVEL_LIFECYCLE,
  parseMonitorRuleStates,
  reconstructMonitorLevel,
  replayMonitorLevel,
  settleMonitorLevelLifecycle,
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

  it("an active rule ending while another rule is still pending records the level entering PENDING_TRIGGER", () => {
    // A is active on its conditions; B's setup is waiting for its trigger.
    const first = stepMonitorLevel(INITIAL_MONITOR_LEVEL_LIFECYCLE, {
      date: "2026-03-02",
      eligible: true,
      rules: rules([TRUE, null], [TRUE, FALSE]),
    });
    expect(first.next.state).toBe("ACTIVE");
    expect(first.next.rules["exit-b"]!.state).toBe("PENDING_TRIGGER");

    // A ends; B is still set up and does not fire.
    const second = stepMonitorLevel(first.next, {
      date: "2026-03-03",
      eligible: true,
      rules: rules([FALSE, null], [TRUE, FALSE]),
    });
    // The occurrence ends exactly once and no new one begins.
    expect(second.closed).toEqual({ reason: "CONDITIONS_ENDED" });
    expect(second.opened).toBe(false);
    expect(second.next.rules["exit-a"]!.state).toBe("RESOLVED");
    expect(second.next.rules["exit-b"]!.state).toBe("PENDING_TRIGGER");
    // Durable state and the append-only history end in the same aggregate state.
    expect(second.next.state).toBe("PENDING_TRIGGER");
    expect(second.next.since).toBe("2026-03-03");
    expect(second.transitions).toEqual([
      {
        from: "ACTIVE",
        to: "RESOLVED",
        reason: "CONDITIONS_ENDED",
        exitRuleId: "exit-a",
        date: "2026-03-03",
      },
      {
        from: "RESOLVED",
        to: "PENDING_TRIGGER",
        reason: "SETUP_STARTED",
        exitRuleId: "exit-b",
        date: "2026-03-03",
      },
    ]);

    // B firing later is a fresh occurrence, recorded from the state the history ended in.
    const third = stepMonitorLevel(second.next, {
      date: "2026-03-04",
      eligible: true,
      rules: rules([FALSE, null], [TRUE, TRUE]),
    });
    expect(third.opened).toBe(true);
    expect(third.transitions).toEqual([
      {
        from: "PENDING_TRIGGER",
        to: "ACTIVE",
        reason: "TRIGGER_FIRED",
        exitRuleId: "exit-b",
        date: "2026-03-04",
      },
    ]);
  });

  it("a trigger-only event ending while another rule is pending records the level entering PENDING_TRIGGER", () => {
    const first = stepMonitorLevel(INITIAL_MONITOR_LEVEL_LIFECYCLE, {
      date: "2026-03-02",
      eligible: true,
      rules: rules([null, TRUE], [TRUE, FALSE]),
    });
    const second = stepMonitorLevel(first.next, {
      date: "2026-03-03",
      eligible: true,
      rules: rules([null, FALSE], [TRUE, FALSE]),
    });
    expect(second.closed).toEqual({ reason: "EVENT_SESSION_ENDED" });
    expect(second.next.state).toBe("PENDING_TRIGGER");
    expect(second.transitions.map((t) => [t.from, t.to])).toEqual([
      ["ACTIVE", "RESOLVED"],
      ["RESOLVED", "PENDING_TRIGGER"],
    ]);
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

/** A small deterministic PRNG, so a failing sequence is reproducible from its seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type RuleShape = "CONDITIONS" | "CONDITIONS_TRIGGER" | "TRIGGER";
const SHAPES: readonly RuleShape[] = [
  "CONDITIONS",
  "CONDITIONS_TRIGGER",
  "TRIGGER",
];
const VALUES: readonly E[] = [TRUE, FALSE, NOT_EVALUABLE];

function sessionDate(index: number): string {
  return new Date(Date.UTC(2020, 0, 1) + index * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** A random level: 1-3 rules of random shapes, observed over `length` sessions. */
function randomLevel(
  random: () => number,
  length: number,
  options: { gated: boolean; falseWeight?: number },
) {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)]!;
  // Weighting FALSE down produces the long unbroken runs reconstruction has to cope with.
  const value = (): E =>
    random() < (options.falseWeight ?? 1 / 3)
      ? FALSE
      : random() < 0.8
        ? pick([TRUE, TRUE, TRUE, NOT_EVALUABLE])
        : pick(VALUES);
  const shapes = Array.from({ length: 1 + Math.floor(random() * 3) }, () =>
    pick(SHAPES),
  );
  const multi = shapes.length > 1;
  return Array.from({ length }, (_, index) => ({
    date: sessionDate(index),
    eligible: options.gated ? random() > 0.05 : true,
    rules: shapes.map((shape, position) =>
      rule(
        shape === "TRIGGER" ? null : value(),
        shape === "CONDITIONS"
          ? null
          : random() < 0.15
            ? TRUE
            : pick([FALSE, FALSE, NOT_EVALUABLE]),
        multi ? `exit-${position}` : "level-1",
        multi ? `exit-${position}` : null,
      ),
    ),
  }));
}

function aggregateOf(lifecycle: MonitorLevelLifecycle) {
  const states = Object.values(lifecycle.rules).map((entry) => entry.state);
  if (states.includes("ACTIVE")) return "ACTIVE";
  if (states.includes("PENDING_TRIGGER")) return "PENDING_TRIGGER";
  return "REST";
}

describe("lifecycle invariants over random observation sequences", () => {
  it("durable state, transition history and occurrences always agree", () => {
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const random = prng(seed);
      const steps = randomLevel(random, 40, { gated: seed % 2 === 0 });
      let current = INITIAL_MONITOR_LEVEL_LIFECYCLE;
      let open = false;
      for (const step of steps) {
        const result = stepMonitorLevel(current, step);
        const context = `seed ${seed} on ${step.date}`;
        const { transitions, next } = result;

        // The history is one unbroken chain from the stored state to the new stored state.
        if (transitions.length === 0) {
          expect(next.state, context).toBe(current.state);
        } else {
          expect(transitions[0]!.from, context).toBe(current.state);
          transitions.forEach((transition, index) => {
            expect(transition.from, context).not.toBe(transition.to);
            if (index > 0) {
              expect(transition.from, context).toBe(transitions[index - 1]!.to);
            }
          });
          expect(transitions.at(-1)!.to, context).toBe(next.state);
          expect(next.since, context).toBe(step.date);
        }

        // The level is the OR of its rules.
        const aggregate = aggregateOf(next);
        if (aggregate === "REST") {
          expect(["INACTIVE", "RESOLVED"], context).toContain(next.state);
        } else {
          expect(next.state, context).toBe(aggregate);
        }

        // Exactly one occurrence at a time, and the history names every open and close.
        if (result.closed) {
          expect(open, context).toBe(true);
          open = false;
        }
        if (result.opened) {
          expect(open, context).toBe(false);
          open = true;
        }
        expect(open, context).toBe(next.state === "ACTIVE");
        expect(
          transitions.filter((transition) => transition.from === "ACTIVE")
            .length,
          context,
        ).toBe(result.closed ? 1 : 0);
        expect(
          transitions.filter((transition) => transition.to === "ACTIVE").length,
          context,
        ).toBe(result.opened ? 1 : 0);

        current = next;
      }
    }
  });
});

describe("reconstruction", () => {
  /** A full canonical replay: every step from the beginning of history, then the live one. */
  function fullReplay(
    history: Parameters<typeof reconstructMonitorLevel>[0]["history"],
    live: Parameters<typeof reconstructMonitorLevel>[0]["live"],
  ) {
    return stepMonitorLevel(replayMonitorLevel(history), live);
  }

  it("a setup whose Conditions held longer than the window, with its Trigger consumed before it, is ACTIVE", () => {
    // 400 sessions: the Trigger fires on session 10 and the Conditions hold ever after.
    const history = Array.from({ length: 400 }, (_, index) => ({
      date: sessionDate(index),
      eligible: true,
      rules: [rule(index < 10 ? FALSE : TRUE, index === 10 ? TRUE : FALSE)],
    }));
    const live = {
      date: sessionDate(400),
      eligible: true,
      rules: [rule(TRUE, FALSE)],
    };
    const full = fullReplay(history, live);
    expect(full.next.state).toBe("ACTIVE");
    expect(full.next.since).toBe(sessionDate(10));

    // The old bounded replay: the last 252 sessions alone call it a setup still waiting.
    const window = history.slice(-252);
    expect(stepMonitorLevel(replayMonitorLevel(window), live).next.state).toBe(
      "PENDING_TRIGGER",
    );

    // Reconstruction refuses to guess from that window...
    const bounded = reconstructMonitorLevel({
      history: window,
      live,
      complete: false,
    });
    expect(bounded.exact).toBe(false);
    expect(bounded.anchor).toBeNull();

    // ...and from history reaching back past the last resting session it is exactly the full one,
    // having replayed only from that session on.
    const deeper = reconstructMonitorLevel({
      history: history.slice(-395),
      live,
      complete: false,
    });
    expect(deeper.exact).toBe(true);
    expect(deeper.anchor).toBe(sessionDate(9));
    expect(deeper.replayed).toBe(391);
    expect(deeper.lifecycle).toEqual(
      settleMonitorLevelLifecycle(full.next, sessionDate(9)),
    );
    expect(deeper.lifecycle.state).toBe("ACTIVE");
    expect(deeper.lifecycle.since).toBe(sessionDate(10));
    expect(deeper.lifecycle.rules["level-1"]!.triggerDate).toBe(
      sessionDate(10),
    );
  });

  it("with no resting session anywhere, only the complete history is exact", () => {
    const history = Array.from({ length: 30 }, (_, index) => ({
      date: sessionDate(index),
      eligible: true,
      rules: [rule(TRUE, index === 0 ? TRUE : FALSE)],
    }));
    const live = {
      date: sessionDate(30),
      eligible: true,
      rules: [rule(TRUE, FALSE)],
    };
    expect(
      reconstructMonitorLevel({
        history: history.slice(5),
        live,
        complete: false,
      }).exact,
    ).toBe(false);
    const complete = reconstructMonitorLevel({ history, live, complete: true });
    expect(complete.exact).toBe(true);
    expect(complete.lifecycle).toEqual(fullReplay(history, live).next);
    expect(complete.lifecycle.state).toBe("ACTIVE");
  });

  it("a live observation that rests needs no history at all", () => {
    const live = {
      date: sessionDate(5),
      eligible: true,
      rules: [rule(FALSE, TRUE)],
    };
    const result = reconstructMonitorLevel({
      history: [],
      live,
      complete: false,
    });
    expect(result.exact).toBe(true);
    expect(result.lifecycle).toEqual({
      state: "INACTIVE",
      since: sessionDate(5),
      rules: {
        "level-1": {
          state: "INACTIVE",
          since: sessionDate(5),
          triggerDate: null,
        },
      },
    });
  });

  it("a closed BUY window is a resting session", () => {
    const history = [
      { date: sessionDate(0), eligible: true, rules: [rule(TRUE, TRUE)] },
      { date: sessionDate(1), eligible: false, rules: [rule(TRUE, FALSE)] },
      { date: sessionDate(2), eligible: true, rules: [rule(TRUE, FALSE)] },
    ];
    const live = {
      date: sessionDate(3),
      eligible: true,
      rules: [rule(TRUE, FALSE)],
    };
    const result = reconstructMonitorLevel({
      history: history.slice(1),
      live,
      complete: false,
    });
    expect(result.anchor).toBe(sessionDate(1));
    // The occurrence the window closed is over; the setup after it waits for a fresh Trigger.
    expect(result.lifecycle.state).toBe("PENDING_TRIGGER");
    expect(result.lifecycle).toEqual(
      settleMonitorLevelLifecycle(
        fullReplay(history, live).next,
        sessionDate(1),
      ),
    );
  });

  it("equals a full canonical replay from any window, and behaves identically afterwards", () => {
    let exactWindows = 0;
    let deepened = 0;
    for (let seed = 1; seed <= 1_500; seed += 1) {
      const random = prng(seed);
      // FALSE is rare, so unbroken runs regularly outlast the window.
      const all = randomLevel(random, 120, {
        gated: seed % 3 === 0,
        falseWeight: seed % 2 === 0 ? 0.02 : 0.2,
      });
      const history = all.slice(0, 80);
      const live = all[80]!;
      const future = all.slice(81);
      const full = fullReplay(history, live);

      // The cycle's strategy: a bounded window, doubled until exact or complete.
      let size = 10;
      let reconstruction = reconstructMonitorLevel({
        history: history.slice(-size),
        live,
        complete: size >= history.length,
      });
      while (!reconstruction.exact) {
        size *= 2;
        deepened += 1;
        reconstruction = reconstructMonitorLevel({
          history: history.slice(-size),
          live,
          complete: size >= history.length,
        });
      }
      exactWindows += size < history.length ? 1 : 0;
      const context = `seed ${seed}`;
      const anchor = reconstruction.anchor;
      const expected =
        anchor === null
          ? full.next
          : settleMonitorLevelLifecycle(full.next, anchor);
      expect(reconstruction.lifecycle, context).toEqual(expected);
      // The product-visible state is the full replay's, unsettled.
      expect(
        reconstruction.lifecycle.state === "ACTIVE" ||
          reconstruction.lifecycle.state === "PENDING_TRIGGER"
          ? [reconstruction.lifecycle.state, reconstruction.lifecycle.since]
          : "REST",
        context,
      ).toEqual(
        full.next.state === "ACTIVE" || full.next.state === "PENDING_TRIGGER"
          ? [full.next.state, full.next.since]
          : "REST",
      );
      expect(reconstruction.live.opened, context).toBe(full.opened);

      // Continuing from the reconstructed and from the fully replayed state gives the same
      // occurrences and the same level changes on every later observation.
      let fromReconstruction = reconstruction.lifecycle;
      let fromFull = full.next;
      for (const step of future) {
        const a = stepMonitorLevel(fromReconstruction, step);
        const b = stepMonitorLevel(fromFull, step);
        expect(a.opened, context).toBe(b.opened);
        expect(a.closed, context).toEqual(b.closed);
        expect(
          a.transitions.map((t) => [t.to, t.reason, t.exitRuleId, t.date]),
          context,
        ).toEqual(
          b.transitions.map((t) => [t.to, t.reason, t.exitRuleId, t.date]),
        );
        fromReconstruction = a.next;
        fromFull = b.next;
      }
      if (anchor !== null) {
        expect(fromReconstruction, context).toEqual(
          settleMonitorLevelLifecycle(fromFull, anchor),
        );
      }
    }
    // Both paths are genuinely exercised.
    expect(exactWindows).toBeGreaterThan(100);
    expect(deepened).toBeGreaterThan(100);
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

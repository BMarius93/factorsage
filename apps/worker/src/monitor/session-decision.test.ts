import {
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import {
  createEvaluationFrame,
  monitorStrategyLevels,
  seriesOperand,
  type EvaluationFrame,
  type MonitorStrategyLevel,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import type {
  ActiveMonitorMember,
  LevelSessionsWrite,
  PersistedSignalState,
} from "./monitor-repository.js";
import { decideLevelSessions } from "./session-decision.js";

/**
 * The multi-session lifecycle a Monitor EOD evaluation records. The reducer itself is pinned by
 * `monitor-lifecycle.test.ts`; these cases pin what the evaluation makes of it over several
 * finalized sessions: every change recorded on its own session, in order, with the occurrence it
 * opens or closes and the origin it was observed under — and a level with no state reconstructed,
 * never replayed into a history.
 */

const EMA = "EMA_50D";
const DATES = [
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
  "2026-10-08",
  "2026-10-09",
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
];
const MEMBER: ActiveMonitorMember = {
  securityId: "sec-1",
  symbol: "TEST",
  buyWindowMode: "FULL",
  buyWindows: [],
};

function frame(closes: number[], ema: number[]): EvaluationFrame {
  return createEvaluationFrame({
    securityId: "sec-1",
    symbol: "TEST",
    name: "Test",
    dates: DATES.slice(0, closes.length),
    closes: Float64Array.from(closes),
    columns: new Map([[seriesOperand(EMA), Float64Array.from(ema)]]),
    periodStartIndex: 0,
  });
}

function levelOf(signal: StrategySignal): MonitorStrategyLevel {
  const definition = {
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [{ id: "buy-1", percentage: 100, signal }],
    sellLevels: [],
  } as StrategyDefinition;
  return monitorStrategyLevels(definition)[0]!;
}

const ABOVE: StrategySignal = {
  conditions: [
    {
      id: "c1",
      metric: { kind: "PRICE" },
      operator: "IS_ABOVE",
      value: { kind: "SERIES", seriesId: EMA },
    },
  ],
};
const CROSSES: StrategySignal = {
  conditions: [],
  trigger: {
    id: "t1",
    metric: { kind: "PRICE" },
    operator: "CROSSES_ABOVE",
    value: { kind: "SERIES", seriesId: EMA },
  },
};

function state(
  level: MonitorStrategyLevel,
  lifecycle: PersistedSignalState["lifecycle"],
  activeSignalId: string | null = null,
): PersistedSignalState {
  return {
    id: "state-1",
    stateVersion: 3,
    signalFingerprint: level.fingerprint,
    levelKind: "BUY",
    lastOutcome: "NOT_MATCHED",
    activeSignalId,
    lifecycle,
  };
}

const observed = () => "OBSERVED" as const;

function summary(write: LevelSessionsWrite | null) {
  return (write?.changes ?? []).map((change) => [
    change.transition.observationDate,
    `${change.transition.from}->${change.transition.to}`,
    change.transition.reason,
    change.origin,
    change.open ? `open@${change.open.price}` : change.close ? "close" : "",
  ]);
}

describe("deciding finalized sessions in order", () => {
  it("records a condition match that began and ended inside one catch-up, each on its own session", () => {
    const level = levelOf(ABOVE);
    // Above the EMA on the 6th and 7th only.
    const decision = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: state(level, {
        state: "INACTIVE",
        since: "2026-10-02",
        rules: {
          "buy-1": {
            state: "INACTIVE",
            since: "2026-10-02",
            triggerDate: null,
          },
        },
      }),
      frame: frame([10, 12, 13, 9], [11, 11, 11, 11]),
      sessions: [0, 1, 2, 3],
      historyComplete: false,
      originOf: observed,
    });
    expect(summary(decision.write)).toEqual([
      [
        "2026-10-06",
        "INACTIVE->ACTIVE",
        "CONDITIONS_MET",
        "OBSERVED",
        "open@12",
      ],
      [
        "2026-10-08",
        "ACTIVE->RESOLVED",
        "CONDITIONS_ENDED",
        "OBSERVED",
        "close",
      ],
    ]);
    expect(decision.write?.lifecycle?.state).toBe("RESOLVED");
    expect(decision.write?.outcome).toBe("NOT_MATCHED");
    expect(decision.write?.decided?.observation).toEqual({
      date: "2026-10-08",
      price: 9,
    });
  });

  it("never loses a Tuesday trigger on the way to Thursday", () => {
    const level = levelOf(CROSSES);
    // Crosses above on the 6th (Tue); below again by the 7th; nothing else.
    const decision = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: state(level, {
        state: "INACTIVE",
        since: "2026-10-02",
        rules: {
          "buy-1": {
            state: "INACTIVE",
            since: "2026-10-02",
            triggerDate: null,
          },
        },
      }),
      frame: frame([10, 12, 10, 10], [11, 11, 11, 11]),
      sessions: [1, 2, 3],
      historyComplete: false,
      originOf: observed,
    });
    expect(summary(decision.write)).toEqual([
      [
        "2026-10-06",
        "INACTIVE->ACTIVE",
        "TRIGGER_FIRED",
        "OBSERVED",
        "open@12",
      ],
      [
        "2026-10-07",
        "ACTIVE->RESOLVED",
        "EVENT_SESSION_ENDED",
        "OBSERVED",
        "close",
      ],
    ]);
  });

  it("moves nothing on a session whose inputs cannot be decided, except a trigger event's end", () => {
    const level = levelOf(ABOVE);
    const active = state(
      level,
      {
        state: "ACTIVE",
        since: "2026-10-02",
        rules: {
          "buy-1": { state: "ACTIVE", since: "2026-10-02", triggerDate: null },
        },
      },
      "signal-1",
    );
    const decision = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: active,
      frame: frame([12, 12], [Number.NaN, Number.NaN]),
      sessions: [0, 1],
      historyComplete: false,
      originOf: observed,
    });
    expect(decision.write?.changes).toEqual([]);
    expect(decision.write?.lifecycle?.state).toBe("ACTIVE");
    expect(decision.write?.outcome).toBe("NOT_EVALUABLE");
    expect(decision.write?.decided).toBeNull();

    const trigger = levelOf(CROSSES);
    const event = decideLevelSessions({
      level: trigger,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: state(
        trigger,
        {
          state: "ACTIVE",
          since: "2026-10-05",
          rules: {
            "buy-1": {
              state: "ACTIVE",
              since: "2026-10-05",
              triggerDate: "2026-10-05",
            },
          },
        },
        "signal-2",
      ),
      frame: frame([12, 12], [11, Number.NaN]),
      sessions: [1],
      historyComplete: false,
      originOf: observed,
    });
    expect(summary(event.write)).toEqual([
      [
        "2026-10-06",
        "ACTIVE->RESOLVED",
        "EVENT_SESSION_ENDED",
        "OBSERVED",
        "close",
      ],
    ]);
  });

  it("labels a change on a session the Monitor did not watch as history", () => {
    const level = levelOf(ABOVE);
    const decision = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: state(level, {
        state: "INACTIVE",
        since: "2026-10-02",
        rules: {
          "buy-1": {
            state: "INACTIVE",
            since: "2026-10-02",
            triggerDate: null,
          },
        },
      }),
      frame: frame([12, 9, 12], [11, 11, 11]),
      sessions: [0, 1, 2],
      historyComplete: false,
      // Watched again from the 7th: what finalized before it was not observed.
      originOf: (date) => (date >= "2026-10-07" ? "OBSERVED" : "HISTORY"),
    });
    expect(summary(decision.write).map((row) => [row[0], row[3]])).toEqual([
      ["2026-10-05", "HISTORY"],
      ["2026-10-06", "HISTORY"],
      ["2026-10-07", "OBSERVED"],
    ]);
  });

  it("reconstructs a level with no state at the newest session, never replaying its history", () => {
    const level = levelOf(ABOVE);
    // Below on the 5th (resting), above every session since.
    const decision = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: null,
      frame: frame([9, 12, 13, 14], [11, 11, 11, 11]),
      sessions: [1, 2, 3],
      historyComplete: false,
      originOf: observed,
    });
    expect(decision.reconstructed).toBe(true);
    expect(summary(decision.write)).toEqual([
      ["2026-10-06", "INACTIVE->ACTIVE", "RECONSTRUCTED", "HISTORY", "open@12"],
    ]);
    expect(decision.write?.changes[0]?.open?.reconstructed).toBe(true);
    expect(decision.write?.lifecycle).toMatchObject({
      state: "ACTIVE",
      since: "2026-10-06",
    });
  });

  it("asks for deeper history when nothing in the frame rests, and waits on an undecidable newest session", () => {
    const level = levelOf(ABOVE);
    const deeper = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: null,
      frame: frame([12, 13, 14], [11, 11, 11]),
      sessions: [2],
      historyComplete: false,
      originOf: observed,
    });
    expect(deeper).toMatchObject({ needsDeeperHistory: true, write: null });

    const complete = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: null,
      frame: frame([12, 13, 14], [11, 11, 11]),
      sessions: [2],
      historyComplete: true,
      originOf: observed,
    });
    expect(complete.write?.lifecycle).toMatchObject({
      state: "ACTIVE",
      since: "2026-10-05",
    });

    const undecidable = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: null,
      frame: frame([12, 13], [11, Number.NaN]),
      sessions: [1],
      historyComplete: true,
      originOf: observed,
    });
    expect(undecidable).toMatchObject({
      needsDeeperHistory: false,
      write: null,
    });
  });

  it("closes an occurrence administratively when its logic changed, then reconstructs under the new logic", () => {
    const level = levelOf(ABOVE);
    const old = {
      ...state(
        level,
        {
          state: "ACTIVE",
          since: "2026-10-01",
          rules: {
            "buy-1": {
              state: "ACTIVE",
              since: "2026-10-01",
              triggerDate: null,
            },
          },
        },
        "signal-old",
      ),
      signalFingerprint: "a different logic",
    };
    const decision = decideLevelSessions({
      level,
      member: MEMBER,
      strategyVersionId: "v2",
      previous: old,
      frame: frame([9, 12], [11, 11]),
      sessions: [1],
      historyComplete: false,
      originOf: observed,
    });
    const rows = summary(decision.write);
    expect(rows[0]).toEqual([
      null,
      "ACTIVE->RESOLVED",
      "LOGIC_CHANGED",
      "ADMINISTRATIVE",
      "close",
    ]);
    expect(rows[1]).toEqual([
      "2026-10-06",
      "INACTIVE->ACTIVE",
      "CONDITIONS_MET",
      "OBSERVED",
      "open@12",
    ]);
  });

  it("keeps a FINAL EXIT with two rules to one occurrence when both match on one session", () => {
    const definition = {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [{ id: "buy-1", percentage: 100, signal: ABOVE }],
      sellLevels: [],
      finalExit: {
        id: "exit",
        rules: [
          { id: "exit-a", signal: ABOVE },
          { id: "exit-b", signal: CROSSES },
        ],
      },
    } as unknown as StrategyDefinition;
    const exit = monitorStrategyLevels(definition).find(
      (level) => level.kind === "FINAL_EXIT",
    )!;
    const decision = decideLevelSessions({
      level: exit,
      member: MEMBER,
      strategyVersionId: "v1",
      previous: {
        ...state(exit, {
          state: "INACTIVE",
          since: "2026-10-02",
          rules: {
            "exit-a": {
              state: "INACTIVE",
              since: "2026-10-02",
              triggerDate: null,
            },
            "exit-b": {
              state: "INACTIVE",
              since: "2026-10-02",
              triggerDate: null,
            },
          },
        }),
        levelKind: "FINAL_EXIT",
      },
      frame: frame([10, 12], [11, 11]),
      sessions: [1],
      historyComplete: false,
      originOf: observed,
    });
    expect(summary(decision.write)).toEqual([
      [
        "2026-10-06",
        "INACTIVE->ACTIVE",
        expect.any(String),
        "OBSERVED",
        "open@12",
      ],
    ]);
  });
});

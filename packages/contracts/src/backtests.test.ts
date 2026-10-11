import { describe, expect, it } from "vitest";
import type { ActorScope } from "./alternative-data.js";
import {
  BACKTEST_SNAPSHOT_VERSION,
  BACKTEST_SNAPSHOT_VERSION_ACTOR_SELECTION,
  backtestSnapshotVersionFor,
  isBacktestSnapshotVersion,
  revisionMismatches,
} from "./backtests.js";
import {
  normalizeStrategyDefinition,
  STRATEGY_SCHEMA_VERSION,
  type StrategyDefinition,
} from "./strategies.js";

/**
 * Compatibility is a two-way question.
 *
 * A worker must refuse a run recording something it disagrees with, something it never recorded,
 * **and** something it recorded that this build has never heard of. The last is the one a
 * one-directional comparison misses, and it is exactly what a rolling deploy produces: a newer API
 * writing a decision an older worker cannot implement.
 */
describe("revisionMismatches", () => {
  const supported = { alpha: "a@1", beta: 2 } as const;

  it("reports nothing when the key sets and values match exactly", () => {
    expect(revisionMismatches({ alpha: "a@1", beta: 2 }, supported)).toEqual(
      [],
    );
  });

  it("reports a value this build disagrees with", () => {
    expect(revisionMismatches({ alpha: "a@2", beta: 2 }, supported)).toEqual([
      { field: "alpha", expected: "a@1", actual: "a@2" },
    ]);
  });

  it("reports a field the run never recorded", () => {
    expect(revisionMismatches({ alpha: "a@1" }, supported)).toEqual([
      { field: "beta", expected: "2", actual: null },
    ]);
  });

  it("reports a field this build has never heard of", () => {
    expect(
      revisionMismatches({ alpha: "a@1", beta: 2, gamma: "g@1" }, supported),
    ).toEqual([{ field: "gamma", expected: null, actual: "g@1" }]);
  });

  it("reports an unknown field even when it names something on Object.prototype", () => {
    // `field in supported` would call `constructor` supported and wave the run through.
    expect(
      revisionMismatches(
        JSON.parse('{"alpha":"a@1","beta":2,"constructor":"c@1"}'),
        supported,
      ),
    ).toEqual([{ field: "constructor", expected: null, actual: "c@1" }]);
  });

  it("treats a snapshot with no revisions at all as entirely incompatible", () => {
    expect(revisionMismatches(null, supported)).toEqual([
      { field: "alpha", expected: "a@1", actual: null },
      { field: "beta", expected: "2", actual: null },
    ]);
  });
});

/**
 * The snapshot version is the lowest one able to express a run, so it doubles as the guard that
 * keeps a worker built before the `ACTORS` scope from executing one: that worker accepts version 1
 * only, and it would otherwise read the unknown scope as a group with no id and count nobody.
 */
describe("backtestSnapshotVersionFor", () => {
  const definitionScopedTo = (
    scope: ActorScope | null,
  ): StrategyDefinition => ({
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    buyLevels: [
      {
        id: "b1",
        percentage: 100,
        signal: {
          conditions: [
            scope === null
              ? {
                  id: "c1",
                  metric: { kind: "PRICE" },
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 10 },
                }
              : {
                  id: "c1",
                  metric: {
                    kind: "CONGRESS_ACTIVITY",
                    measure: "PURCHASES",
                    lookback: 30,
                    scope,
                    chamber: "ANY",
                  },
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 0 },
                },
          ],
        },
      },
    ],
    sellLevels: [],
  });

  it("stays at version 1 for everything a run could hold before the selection existed", () => {
    for (const scope of [
      null,
      { kind: "ANY" },
      { kind: "GROUP", groupId: "g1" },
      // As stored by an old strategy version, before the read path rewrites it.
      { kind: "ACTOR", actorId: "a1" },
    ] as (ActorScope | null)[]) {
      expect(backtestSnapshotVersionFor(definitionScopedTo(scope))).toBe(
        BACKTEST_SNAPSHOT_VERSION,
      );
    }
  });

  it("moves to version 2 as soon as the frozen definition holds a selection", () => {
    expect(
      backtestSnapshotVersionFor(
        definitionScopedTo({ kind: "ACTORS", actorIds: ["a1", "a2"] }),
      ),
    ).toBe(BACKTEST_SNAPSHOT_VERSION_ACTOR_SELECTION);
    // A submission freezes the normalized definition, which holds a single actor as a selection —
    // a shape an older worker does not know either.
    expect(
      backtestSnapshotVersionFor(
        normalizeStrategyDefinition(
          definitionScopedTo({ kind: "ACTOR", actorId: "a1" }),
        ),
      ),
    ).toBe(BACKTEST_SNAPSHOT_VERSION_ACTOR_SELECTION);
  });

  it("recognizes exactly the versions this build can read", () => {
    expect(isBacktestSnapshotVersion(1)).toBe(true);
    expect(isBacktestSnapshotVersion(2)).toBe(true);
    for (const other of [0, 3, "1", null, undefined]) {
      expect(isBacktestSnapshotVersion(other), String(other)).toBe(false);
    }
  });
});

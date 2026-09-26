import {
  normalizeStrategyDefinition,
  strategyDefinitionFingerprint,
  strategySignalFingerprint,
  validateStrategy,
  type StrategyDefinition,
  type StrategySignal,
} from "@intrinsic/contracts";
import {
  QA_MATRIX_ACTOR_GROUP_MEMBERS,
  QA_MATRIX_ACTOR_GROUP_NAME,
  QA_MATRIX_AUDIT_ACTOR,
  QA_MATRIX_AUDIT_STRATEGY_IDS,
  QA_MATRIX_EXPECTED_COMBINATIONS,
  QA_MATRIX_EXPECTED_STRATEGIES,
  QA_MATRIX_NAME_PREFIX,
  QA_MATRIX_STRATEGIES,
  currentAsOfDate,
  isQaMatrixRun,
  qaMatrixAuditStrategies,
  qaMatrixCombinations,
  qaMatrixFixtures,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";

/**
 * The audit strategy variant — `A01` … `A10` — against the real product contracts.
 *
 * The variant exists because Relative Volume and the two alternative-data families arrived after the
 * Backtest V1 baseline, and this suite is what stops it drifting into something the product would
 * refuse. Three properties matter more here than they did for the core set:
 *
 * 1. **Two RVOL rows in one Signal must be authorable.** Until the period became part of a metric's
 *    semantic identity, `RVOL 10 is above 2 AND RVOL 20 is above 2` was rejected as a duplicate
 *    condition, and two levels differing only by period fingerprinted alike. `A02` is written
 *    precisely to contain both shapes, so a regression in either is a failing fixture rather than a
 *    thousand runs that quietly measure one period twice.
 * 2. **Nothing may collapse.** Within one fixture every level carries a distinct Signal fingerprint,
 *    and across the whole matrix every fixture carries a distinct definition fingerprint. Two
 *    *different* Strategies may share a level's fingerprint — "sell half on a 25% gain" is one rule
 *    however many Strategies write it — and that is the point of a semantic fingerprint, not a bug.
 * 3. **The baseline must not move.** The core set's definitions and their fingerprints are compared
 *    against themselves so adding this dimension cannot silently edit `S01` … `S10`.
 */

const SCOPES = {
  actorId: "actor-fixture-id",
  groupId: "group-fixture-id",
} as const;

const AUDIT_STRATEGIES = qaMatrixAuditStrategies(SCOPES);

function signalsOf(definition: StrategyDefinition): StrategySignal[] {
  return [
    ...definition.buyLevels.map((level) => level.signal),
    ...definition.sellLevels.map((level) => level.signal),
    ...(definition.finalExit?.rules ?? []).map((rule) => rule.signal),
  ];
}

describe("QA-MATRIX audit strategy fixtures", () => {
  it("defines exactly ten, numbered sequentially in their own namespace", () => {
    expect(AUDIT_STRATEGIES).toHaveLength(QA_MATRIX_EXPECTED_STRATEGIES);
    expect(AUDIT_STRATEGIES.map((fixture) => fixture.id)).toEqual(
      QA_MATRIX_AUDIT_STRATEGY_IDS,
    );
    for (const fixture of AUDIT_STRATEGIES) {
      expect(fixture.name.startsWith(`${QA_MATRIX_NAME_PREFIX}A`)).toBe(true);
      expect(fixture.description.length).toBeGreaterThan(80);
    }
  });

  it("passes the real strategy validation contract", () => {
    // The same `validateStrategy` the API enforces. A metric/operator/value combination the product
    // does not permit fails here rather than at seed time.
    for (const fixture of AUDIT_STRATEGIES) {
      const issues = validateStrategy({
        name: fixture.name,
        description: fixture.description,
        definition: fixture.definition,
      });
      expect(issues, `${fixture.name}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it("round-trips through canonical normalization unchanged", () => {
    for (const fixture of AUDIT_STRATEGIES) {
      const once = normalizeStrategyDefinition(fixture.definition);
      expect(once, fixture.name).toEqual(fixture.definition);
      expect(normalizeStrategyDefinition(once)).toEqual(fixture.definition);
    }
  });

  it("uses deterministic positional row ids, never a generated identifier", () => {
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const fixture of AUDIT_STRATEGIES) {
      const slug = fixture.id.toLowerCase();
      for (const level of [
        ...fixture.definition.buyLevels,
        ...fixture.definition.sellLevels,
      ]) {
        expect(level.id).not.toMatch(uuid);
        expect(level.id.startsWith(slug)).toBe(true);
        for (const condition of level.signal.conditions) {
          expect(condition.id.startsWith(level.id)).toBe(true);
        }
      }
    }
  });

  it("holds two Relative Volume Conditions at the same threshold in one Signal", () => {
    // `A02`'s strongest BUY names all three periods, two of them at 2x. Keyed on the metric kind
    // alone those two rows are one rule written twice, and the definition is refused.
    const a02 = AUDIT_STRATEGIES.find((fixture) => fixture.id === "A02");
    expect(a02).toBeDefined();
    const strongest = a02!.definition.buyLevels.at(-1)!;
    const periods = strongest.signal.conditions
      .filter((condition) => condition.metric.kind === "RELATIVE_VOLUME")
      .map((condition) =>
        condition.metric.kind === "RELATIVE_VOLUME"
          ? condition.metric.period
          : 0,
      );
    expect(periods).toEqual([10, 20, 50]);
    const thresholds = strongest.signal.conditions.map((condition) =>
      condition.value.kind === "MULTIPLE" ? condition.value.value : null,
    );
    expect(thresholds.filter((value) => value === 2)).toHaveLength(2);
    expect(
      validateStrategy({
        name: a02!.name,
        description: a02!.description,
        definition: a02!.definition,
      }),
    ).toEqual([]);
  });

  it("gives every level within one fixture its own Signal fingerprint", () => {
    // Nothing may collapse *inside a Strategy*: a Monitor latch is keyed by the level's own
    // fingerprint, so two levels of one Strategy sharing one would share a durable lifecycle. That is
    // exactly the defect the period fix corrected, and `A02`'s two RVOL levels are where it would
    // reappear.
    //
    // Across Strategies a shared fingerprint is correct rather than a collision: `A02` and `A07` both
    // sell half on a 25% gain, and that is the same rule, which is the whole point of a semantic
    // fingerprint. Whole definitions are what must stay distinct, and the next case requires it.
    for (const fixture of AUDIT_STRATEGIES) {
      const seen = new Map<string, number>();
      for (const [index, signal] of signalsOf(fixture.definition).entries()) {
        const fingerprint = strategySignalFingerprint(signal);
        const clash = seen.get(fingerprint);
        expect(
          clash,
          `${fixture.id} level ${index} collides with level ${clash}`,
        ).toBeUndefined();
        seen.set(fingerprint, index);
      }
    }
  });

  it("distinguishes two levels that differ only by Relative Volume period", () => {
    // Stated directly rather than only as a by-product of the case above: `A02`'s two BUY levels are
    // `RVOL 20 above 2` and a three-period Signal containing `RVOL 20 above 2`. Before the period
    // joined the metric's identity, a one-condition RVOL Signal fingerprinted the same whatever its
    // period.
    const a02 = AUDIT_STRATEGIES.find((fixture) => fixture.id === "A02")!;
    const [weaker, stronger] = a02.definition.buyLevels;
    expect(strategySignalFingerprint(weaker!.signal)).not.toBe(
      strategySignalFingerprint(stronger!.signal),
    );
    const rvol10 = AUDIT_STRATEGIES.find((fixture) => fixture.id === "A01")!
      .definition.buyLevels[0]!.signal;
    // `A01` is `RVOL 10 above 2`; `A02`'s weaker level is `RVOL 20 above 2`. Same operator, same
    // threshold, different period — and therefore a different rule.
    expect(strategySignalFingerprint(rvol10)).not.toBe(
      strategySignalFingerprint(weaker!.signal),
    );
  });

  it("gives every fixture its own definition fingerprint, and none of the core set's", () => {
    const fingerprints = new Map<string, string>();
    for (const fixture of [...QA_MATRIX_STRATEGIES, ...AUDIT_STRATEGIES]) {
      const fingerprint = strategyDefinitionFingerprint(fixture.definition);
      const clash = fingerprints.get(fingerprint);
      expect(clash, `${fixture.id} collides with ${clash}`).toBeUndefined();
      fingerprints.set(fingerprint, fixture.id);
    }
  });

  it("names the actor scopes it was resolved with, and nothing else", () => {
    // The two scope-bearing fixtures must carry the ids the seeder resolved — a fixture that hard
    // coded one would name a row that exists in no database but the one it was written against.
    const serialized = JSON.stringify(
      AUDIT_STRATEGIES.map((fixture) => fixture.definition),
    );
    expect(serialized).toContain(SCOPES.actorId);
    expect(serialized).toContain(SCOPES.groupId);
    // Identity is external and stable; a display name never reaches a definition.
    expect(serialized).not.toContain(QA_MATRIX_AUDIT_ACTOR.displayName);
    expect(serialized).not.toContain(QA_MATRIX_ACTOR_GROUP_NAME);
    expect(QA_MATRIX_ACTOR_GROUP_MEMBERS).toContain(
      QA_MATRIX_AUDIT_ACTOR.externalId,
    );
    expect(new Set(QA_MATRIX_ACTOR_GROUP_MEMBERS).size).toBe(
      QA_MATRIX_ACTOR_GROUP_MEMBERS.length,
    );
  });

  it("covers every metric family the audit exists to exercise", () => {
    const metrics = AUDIT_STRATEGIES.flatMap((fixture) =>
      signalsOf(fixture.definition).flatMap((signal) =>
        signal.conditions.map((condition) => condition.metric),
      ),
    );
    const relativeVolumePeriods = new Set(
      metrics
        .filter((metric) => metric.kind === "RELATIVE_VOLUME")
        .map((metric) =>
          metric.kind === "RELATIVE_VOLUME" ? metric.period : 0,
        ),
    );
    expect([...relativeVolumePeriods].sort((a, b) => a - b)).toEqual([
      10, 20, 50,
    ]);

    const insiderMeasures = new Set(
      metrics
        .filter((metric) => metric.kind === "INSIDER_ACTIVITY")
        .map((metric) =>
          metric.kind === "INSIDER_ACTIVITY" ? metric.measure : "",
        ),
    );
    expect(insiderMeasures).toEqual(
      new Set(["BUYERS", "SELLERS", "PURCHASE_VALUE", "SALE_VALUE"]),
    );
    expect(
      metrics.some(
        (metric) =>
          metric.kind === "INSIDER_ACTIVITY" && metric.roles !== undefined,
      ),
    ).toBe(true);

    const congress = metrics.filter(
      (metric) => metric.kind === "CONGRESS_ACTIVITY",
    );
    expect(
      new Set(
        congress.map((metric) =>
          metric.kind === "CONGRESS_ACTIVITY" ? metric.measure : "",
        ),
      ),
    ).toEqual(
      new Set(["PURCHASES", "SALES", "BUYERS", "MINIMUM_PURCHASE_VALUE"]),
    );
    expect(
      new Set(
        congress.map((metric) =>
          metric.kind === "CONGRESS_ACTIVITY" ? metric.chamber : "",
        ),
      ),
    ).toEqual(new Set(["ANY", "HOUSE", "SENATE"]));
    expect(
      new Set(
        congress.map((metric) =>
          metric.kind === "CONGRESS_ACTIVITY" ? metric.scope.kind : "",
        ),
      ),
    ).toEqual(new Set(["ANY", "ACTOR", "GROUP"]));
    expect(
      congress.some(
        (metric) =>
          metric.kind === "CONGRESS_ACTIVITY" && metric.owners !== undefined,
      ),
    ).toBe(true);

    // Mixed with the technical and valuation families, which is what makes them audit strategies
    // rather than a second product.
    for (const kind of [
      "PRICE",
      "OSCILLATOR",
      "MARGIN_OF_SAFETY",
      "GAIN",
      "LOSS",
    ]) {
      expect(
        metrics.some((metric) => metric.kind === kind),
        `no ${kind} condition in the audit set`,
      ).toBe(true);
    }
    // Moving averages appear on the **value** side — `Price is above SMA 200D` — which is how the
    // core set uses them too.
    const values = AUDIT_STRATEGIES.flatMap((fixture) =>
      signalsOf(fixture.definition).flatMap((signal) =>
        signal.conditions.map((condition) => condition.value),
      ),
    );
    expect(
      values.some(
        (value) => value.kind === "SERIES" && value.seriesId.startsWith("SMA_"),
      ),
    ).toBe(true);
    // Every value unit the alternative-data families introduced.
    expect(new Set(values.map((value) => value.kind))).toEqual(
      new Set(["SERIES", "NUMBER", "PERCENT", "MULTIPLE", "MONEY"]),
    );
  });

  it("enumerates the same thousand combinations as the core dimension", () => {
    const audit = qaMatrixCombinations(
      qaMatrixFixtures(currentAsOfDate(), undefined, AUDIT_STRATEGIES),
    );
    expect(audit).toHaveLength(QA_MATRIX_EXPECTED_COMBINATIONS);
    expect(new Set(audit.map((entry) => entry.label)).size).toBe(
      QA_MATRIX_EXPECTED_COMBINATIONS,
    );
    // The label carries the set, so the two sweeps' case identities never collide.
    const core = new Set(
      qaMatrixCombinations(qaMatrixFixtures(currentAsOfDate())).map(
        (entry) => entry.label,
      ),
    );
    for (const entry of audit) {
      expect(core.has(entry.label)).toBe(false);
      expect(entry.label.startsWith(`${QA_MATRIX_NAME_PREFIX}A`)).toBe(true);
    }
  });

  it("is retained by the matrix run predicate, exactly as the core set is", () => {
    // Without this an audit sweep's thousand runs would be immortal, which is how the matrix
    // database accumulated 1,006 orphans in the first place.
    for (const fixture of AUDIT_STRATEGIES) {
      expect(
        isQaMatrixRun({
          strategyName: fixture.name,
          stockListName: `${QA_MATRIX_NAME_PREFIX}L02-small-old-full`,
        }),
      ).toBe(true);
    }
    expect(
      isQaMatrixRun({
        strategyName: "My own strategy",
        stockListName: `${QA_MATRIX_NAME_PREFIX}L02-small-old-full`,
      }),
    ).toBe(false);
  });
});

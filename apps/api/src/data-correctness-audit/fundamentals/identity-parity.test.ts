import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_GROUPED,
  FUNDAMENTAL_METRIC_IDS as CATALOG_IDS,
  STRATEGY_LEVEL_KINDS,
  findFundamentalMetric,
  isFundamentalMetricId,
  strategyMetricOptions,
} from "@intrinsic/contracts";
import {
  FUNDAMENTAL_METRICS,
  FUNDAMENTAL_METRIC_FIELDS,
  fundamentalMetricDefinition,
} from "@intrinsic/domain";
import {
  fundamentalMetricOperand,
  operandFundamentalMetricId,
} from "@intrinsic/strategy";
import {
  FUNDAMENTAL_AUDIT_DRIFT_MESSAGE,
  FUNDAMENTAL_AUDIT_METRICS,
  QA_MATRIX_FUNDAMENTAL_STRATEGIES,
  deriveStrategyBehaviours,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ORACLE_FUNDAMENTAL_METRICS } from "../oracle/fundamentals";
import { FUNDAMENTAL_PROVENANCE_COLUMNS } from "../backtests/frame-provenance";

/**
 * Identity and unit parity of the fifteen Fundamental Metrics across every surface that knows them
 * (audit sections 4 and 28).
 *
 * The reference is `FUNDAMENTAL_AUDIT_METRICS`, the ADR's Scope table written down by hand. Every
 * list below is compared with it **in order** — exact identity sequences, never counts — so a metric
 * added, removed, reordered, renamed or re-united on one surface fails here, by name, with the one
 * message a future sixteenth metric should produce.
 */

const repositoryRoot = join(__dirname, "..", "..", "..", "..", "..");
const ADR_IDS = FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.id);

function expectSameIdentities(surface: string, ids: readonly string[]): void {
  expect([...ids], `${surface}: ${FUNDAMENTAL_AUDIT_DRIFT_MESSAGE}`).toEqual(
    ADR_IDS,
  );
  expect(new Set(ids).size, `${surface} holds a duplicate`).toBe(ids.length);
}

describe("one identity per Fundamental Metric, in one order, on every surface", () => {
  it("the domain registry: identity, storage field and unit exactly as the ADR's Scope table", () => {
    expectSameIdentities(
      "domain FUNDAMENTAL_METRICS",
      FUNDAMENTAL_METRICS.map((metric) => metric.id),
    );
    expect(
      FUNDAMENTAL_METRICS.map(({ id, field, unit }) => ({ id, field, unit })),
    ).toEqual(
      FUNDAMENTAL_AUDIT_METRICS.map(({ id, field, unit }) => ({
        id,
        field,
        unit,
      })),
    );
    expect([...FUNDAMENTAL_METRIC_FIELDS]).toEqual(
      FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.field),
    );
  });

  it("the product catalog: identity and unit, and nothing that names storage", () => {
    expectSameIdentities(
      "contracts FUNDAMENTAL_METRIC_CATALOG",
      FUNDAMENTAL_METRIC_CATALOG.map((entry) => entry.id),
    );
    expectSameIdentities("contracts FUNDAMENTAL_METRIC_IDS", CATALOG_IDS);
    expect(
      FUNDAMENTAL_METRIC_CATALOG.map(({ id, unit }) => ({ id, unit })),
    ).toEqual(FUNDAMENTAL_AUDIT_METRICS.map(({ id, unit }) => ({ id, unit })));
    const fields = new Set<string>(
      FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.field),
    );
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      for (const [key, value] of Object.entries(entry)) {
        expect(["field", "column"]).not.toContain(key);
        expect(
          fields.has(String(value)),
          `${entry.id}.${key} names a storage field`,
        ).toBe(false);
      }
      // A label is never an identity, and never derived from one.
      expect(entry.label).not.toBe(entry.id);
      expect(isFundamentalMetricId(entry.label)).toBe(false);
    }
    expectSameIdentities(
      "contracts FUNDAMENTAL_METRIC_GROUPED (as a set)",
      FUNDAMENTAL_METRIC_GROUPED.flatMap((group) =>
        group.metrics.map((metric) => metric.id),
      ).sort((left, right) => ADR_IDS.indexOf(left) - ADR_IDS.indexOf(right)),
    );
  });

  it("the Strategy registry: every level's Condition metrics, and no Trigger metric", () => {
    for (const level of STRATEGY_LEVEL_KINDS) {
      const conditionIds = strategyMetricOptions(level, "CONDITION").flatMap(
        (option) =>
          option.metric.kind === "FUNDAMENTAL" ? [option.metric.metricId] : [],
      );
      expectSameIdentities(`Strategy ${level} Conditions`, conditionIds);
      expect(
        strategyMetricOptions(level, "TRIGGER").filter(
          (option) => option.metric.kind === "FUNDAMENTAL",
        ),
        `${level} Trigger`,
      ).toEqual([]);
    }
  });

  it("the evaluation frame's operand family: one key per identity, decoded back exactly", () => {
    const keys = ADR_IDS.map((id) => fundamentalMetricOperand(id as never));
    expect(keys).toEqual(ADR_IDS.map((id) => `fundamental:${id}`));
    expectSameIdentities(
      "operandFundamentalMetricId",
      keys.map((key) => operandFundamentalMetricId(key) ?? "?"),
    );
  });

  it("the OpenAPI FundamentalMetricId enum", () => {
    const document = parse(
      readFileSync(join(repositoryRoot, "docs", "openapi.yaml"), "utf8"),
    ) as {
      components: { schemas: Record<string, { enum?: string[] }> };
    };
    expectSameIdentities(
      "docs/openapi.yaml FundamentalMetricId",
      document.components.schemas.FundamentalMetricId?.enum ?? [],
    );
  });

  it("the Prisma schema: a nullable DECIMAL(20,8) DailyDerivedState column per storage field", () => {
    const schema = readFileSync(
      join(repositoryRoot, "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    const model =
      /model DailyDerivedState \{([\s\S]*?)\n\}/.exec(schema)?.[1] ?? "";
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      expect(model, metric.field).toMatch(
        new RegExp(
          `\\n\\s*${metric.field}\\s+Decimal\\?\\s+@db\\.Decimal\\(20, 8\\)`,
        ),
      );
    }
  });

  it("the audit tooling: the oracle, the frame-provenance audit and the QA-matrix dimension know all fifteen", () => {
    expect(
      ORACLE_FUNDAMENTAL_METRICS.map(({ id, column, unit }) => ({
        id,
        field: column,
        unit,
      })),
    ).toEqual(
      FUNDAMENTAL_AUDIT_METRICS.map(({ id, field, unit }) => ({
        id,
        field,
        unit,
      })),
    );
    expectSameIdentities(
      "frame-provenance FUNDAMENTAL_PROVENANCE_COLUMNS",
      Object.keys(FUNDAMENTAL_PROVENANCE_COLUMNS),
    );
    expect(FUNDAMENTAL_PROVENANCE_COLUMNS).toEqual(
      Object.fromEntries(
        FUNDAMENTAL_AUDIT_METRICS.map((metric) => [metric.id, metric.field]),
      ),
    );
    const exercised = new Set(
      QA_MATRIX_FUNDAMENTAL_STRATEGIES.flatMap((fixture) =>
        [
          ...fixture.definition.buyLevels,
          ...fixture.definition.sellLevels,
          ...(fixture.definition.finalExit?.rules ?? []),
        ].flatMap((level) =>
          level.signal.conditions.flatMap((condition) =>
            condition.metric.kind === "FUNDAMENTAL"
              ? [condition.metric.metricId]
              : [],
          ),
        ),
      ),
    );
    expectSameIdentities(
      "QA-matrix Fundamentals dimension",
      ADR_IDS.filter((id) => exercised.has(id as never)),
    );
    for (const fixture of QA_MATRIX_FUNDAMENTAL_STRATEGIES) {
      expect(() => deriveStrategyBehaviours(fixture.definition)).not.toThrow();
    }
  });

  it("accepts no alias of an identity anywhere: lower case, spaced, storage field or label", () => {
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      const label = findFundamentalMetric(metric.id)?.label ?? "";
      for (const alias of [
        metric.id.toLowerCase(),
        ` ${metric.id}`,
        metric.id.replaceAll("_", " "),
        metric.field,
        label,
      ]) {
        expect(isFundamentalMetricId(alias), alias).toBe(false);
        expect(
          operandFundamentalMetricId(`fundamental:${alias}`),
          alias,
        ).toBeNull();
        expect(
          () => fundamentalMetricDefinition(alias as never),
          alias,
        ).toThrow();
      }
    }
  });
});

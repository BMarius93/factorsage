import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_IDS,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { loadOpenApiDocument } from "./openapi-document";

/**
 * Holds the documented Fundamental Metric history endpoint to `@intrinsic/contracts`.
 *
 * `openapi.contract.test.ts` proves the route is documented at all; this proves the document says
 * the right things about it: exactly the catalog's fifteen identities in the catalog's order, each
 * under the unit it is stored in, one required `metric`, and a row whose only value is optional
 * rather than nullable.
 */

type Schema = {
  readonly $ref?: string;
  readonly type?: string;
  readonly enum?: readonly unknown[];
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly items?: Schema;
  readonly oneOf?: readonly Schema[];
  readonly const?: unknown;
  readonly description?: string;
};

type Parameter = {
  readonly $ref?: string;
  readonly name?: string;
  readonly in?: string;
  readonly required?: boolean;
  readonly schema?: Schema;
};

const document = loadOpenApiDocument();

function resolve<T extends { $ref?: string }>(node: T): T {
  let current = node;
  while (current.$ref !== undefined) {
    current = current.$ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>(
        (value, key) => (value as Record<string, unknown>)[key],
        document,
      ) as T;
  }
  return current;
}

function schema(name: string): Schema {
  const found = (document.components?.schemas as Record<string, Schema>)[name];
  if (!found) {
    throw new Error(`docs/openapi.yaml has no \`${name}\` schema`);
  }
  return found;
}

const operation = document.paths["/stocks/{symbol}/fundamentals/daily"]?.get;

/** Prose as a reader sees it: the YAML block scalars wrap lines wherever the column runs out. */
function prose(...texts: readonly (string | undefined)[]): string {
  return texts.join(" ").replace(/\s+/g, " ");
}

describe("the documented Fundamental Metric history endpoint", () => {
  it("exists as one GET operation", () => {
    expect(operation?.operationId).toBe("getDailyFundamentalMetric");
  });

  it("names exactly the catalog's fifteen identities, in the catalog's order", () => {
    expect(schema("FundamentalMetricId").enum).toEqual([
      ...FUNDAMENTAL_METRIC_IDS,
    ]);
  });

  it("states every identity's unit exactly as the catalog stores it", () => {
    const description = schema("FundamentalMetricId").description ?? "";
    const [percent, multiple] = description.split("Raw multiples");
    expect(multiple).toBeDefined();
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const token = `\`${entry.id}\``;
      // Named once, under its own unit and never under the other one.
      expect(percent?.includes(token), `${entry.id} as percentage points`).toBe(
        entry.unit === "PERCENT",
      );
      expect(multiple?.includes(token), `${entry.id} as a multiple`).toBe(
        entry.unit === "MULTIPLE",
      );
    }
    expect(percent).toContain("percentage points");
    expect(percent).toContain("`15.42` is 15.42%");
  });

  it("requires exactly one metric, typed by that identity schema", () => {
    const parameters = ((operation?.parameters ?? []) as Parameter[]).map(
      (parameter) => resolve(parameter),
    );
    const metric = parameters.filter(
      (parameter) => parameter.name === "metric",
    );
    expect(metric).toHaveLength(1);
    expect(metric[0]).toMatchObject({ in: "query", required: true });
    expect(metric[0]?.schema?.$ref).toBe(
      "#/components/schemas/FundamentalMetricId",
    );
    // A bounded window like every other history read, never an open one.
    const names = parameters.map((parameter) => parameter.name);
    expect(names).toEqual(["symbol", "from", "to", "metric"]);
    expect(
      parameters
        .filter((parameter) => parameter.in === "query")
        .every((parameter) => parameter.required === true),
    ).toBe(true);
  });

  it("answers rows whose value is optional, not nullable, and nothing else", () => {
    const success = (
      operation?.responses?.["200"] as {
        content: { "application/json": { schema: Schema } };
      }
    ).content["application/json"].schema;
    expect(success.type).toBe("array");
    const row = resolve(success.items as Schema);
    expect(row.required).toEqual(["date"]);
    expect(Object.keys(row.properties ?? {}).sort()).toEqual(["date", "value"]);
    expect(row.properties?.value).toEqual({ type: "number" });
    // The documented contract of absence: omitted, never null or zero.
    const described = prose(row.description);
    expect(described).toContain("**omitted**");
    expect(described).toContain("never `null`, never zero");
    expect(described).toContain("percentage points");
  });

  it("describes a read of persisted, end-of-day state and not a realtime one", () => {
    const described = prose(
      operation?.summary,
      operation?.description as string | undefined,
    );
    expect(described).toContain("persisted derived state");
    expect(described).toContain("completed end-of-day trading sessions");
    expect(described).toContain("nothing here is a realtime reading");
  });

  it("is the one list of identities the Strategy metric schema refers to as well", () => {
    const metric = resolve(schema("StrategyMetric"));
    const fundamental = (metric.oneOf ?? []).find(
      (variant) => resolve(variant).properties?.kind?.const === "FUNDAMENTAL",
    );
    expect(resolve(fundamental as Schema).properties?.metricId?.$ref).toBe(
      "#/components/schemas/FundamentalMetricId",
    );
  });
});

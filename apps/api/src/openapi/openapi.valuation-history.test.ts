import { VALUATION_RATIO_IDS } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { loadOpenApiDocument } from "./openapi-document";

/**
 * Holds the documented valuation ratio history endpoint to `@intrinsic/contracts`.
 *
 * `openapi.contract.test.ts` proves the route is documented at all; this proves the document says
 * the right things about it: exactly the catalog's five identities in the catalog's order, one
 * required `ratio`, and a row whose only value is an optional raw multiple rather than a nullable
 * one.
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

const operation =
  document.paths["/stocks/{symbol}/valuation-ratios/daily"]?.get;

/** Prose as a reader sees it: the YAML block scalars wrap lines wherever the column runs out. */
function prose(...texts: readonly (string | undefined)[]): string {
  return texts.join(" ").replace(/\s+/g, " ");
}

describe("the documented valuation ratio history endpoint", () => {
  it("exists as one GET operation", () => {
    expect(operation?.operationId).toBe("getDailyValuationRatio");
  });

  it("names exactly the catalog's five identities, in the catalog's order", () => {
    expect(schema("ValuationRatioId").enum).toEqual([...VALUATION_RATIO_IDS]);
  });

  it("requires exactly one ratio, typed by that identity schema", () => {
    const parameters = ((operation?.parameters ?? []) as Parameter[]).map(
      (parameter) => resolve(parameter),
    );
    const ratio = parameters.filter((parameter) => parameter.name === "ratio");
    expect(ratio).toHaveLength(1);
    expect(ratio[0]).toMatchObject({ in: "query", required: true });
    expect(ratio[0]?.schema?.$ref).toBe(
      "#/components/schemas/ValuationRatioId",
    );
    // A bounded window like every other history read, never an open one.
    const names = parameters.map((parameter) => parameter.name);
    expect(names).toEqual(["symbol", "from", "to", "ratio"]);
    expect(
      parameters
        .filter((parameter) => parameter.in === "query")
        .every((parameter) => parameter.required === true),
    ).toBe(true);
  });

  it("answers rows whose value is an optional raw multiple, not nullable, and nothing else", () => {
    const success = (
      operation?.responses?.["200"] as {
        content: { "application/json": { schema: Schema } };
      }
    ).content["application/json"].schema;
    expect(success.type).toBe("array");
    const row = resolve(success.items as Schema);
    expect(success.items?.$ref).toBe(
      "#/components/schemas/DailyValuationRatio",
    );
    expect(row.required).toEqual(["date"]);
    expect(Object.keys(row.properties ?? {}).sort()).toEqual(["date", "value"]);
    expect(row.properties?.value).toEqual({ type: "number" });
    // The documented contract: a raw multiple, a real negative EV/EBITDA, and absence omitted.
    const described = prose(row.description);
    expect(described).toContain("**raw multiple**");
    expect(described).toContain("negative EV/EBITDA");
    expect(described).toContain("**omitted**");
    expect(described).toContain("never `null`, never zero");
  });

  it("describes a read computed by the shared calculation, never stored and never realtime", () => {
    const described = prose(
      operation?.summary,
      operation?.description as string | undefined,
    );
    expect(described).toContain("computed when it is read");
    expect(described).toContain(
      "a Strategy Condition, a backtest and a Monitor read",
    );
    expect(described).toContain("Nothing is stored per session");
    expect(described).toContain("nothing is a realtime reading");
  });

  it("is the one list of identities the Strategy metric schema refers to as well", () => {
    const metric = resolve(schema("StrategyMetric"));
    const valuation = (metric.oneOf ?? []).find(
      (variant) =>
        resolve(variant).properties?.kind?.const === "VALUATION_RATIO",
    );
    expect(resolve(valuation as Schema).properties?.ratioId?.$ref).toBe(
      "#/components/schemas/ValuationRatioId",
    );
  });
});

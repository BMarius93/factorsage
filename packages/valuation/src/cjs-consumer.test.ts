import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type * as Valuation from "./index.js";

/**
 * Compatibility proof for CommonJS consumers.
 *
 * `@intrinsic/stock-data` and every other internal runtime package is CommonJS, so the built
 * output must load through a plain `require()` with no interop shim or dynamic import. This uses
 * Node's real CJS resolver against the package's own `exports` map, so it fails if the module
 * format or the `require` condition regresses.
 *
 * The package `test` script builds before running vitest, so `dist/` is always current here.
 */
// `require` itself is a reserved name in CommonJS emit, so the resolver is named explicitly.
const requireFromPackageRoot = createRequire(join(process.cwd(), "package.json"));

describe("CommonJS consumers", () => {
  it("resolves the package entry through the require condition", () => {
    expect(requireFromPackageRoot.resolve("@intrinsic/valuation")).toMatch(
      /dist[\\/]index\.js$/,
    );
  });

  it("loads every public export through require()", () => {
    const valuation = requireFromPackageRoot("@intrinsic/valuation") as typeof Valuation;

    expect(typeof valuation.calculateDcfFcff).toBe("function");
    expect(typeof valuation.calculateResidualIncome).toBe("function");
    expect(typeof valuation.calculateDdm).toBe("function");
    expect(typeof valuation.calculateGraham).toBe("function");
    expect(typeof valuation.calculateBlend).toBe("function");
    expect(typeof valuation.estimateGrowth).toBe("function");
    expect(typeof valuation.fiveYearCagr).toBe("function");
    expect(typeof valuation.capGrowth).toBe("function");
    expect(typeof valuation.calculated).toBe("function");
    expect(typeof valuation.notApplicable).toBe("function");
    expect(typeof valuation.isFiniteNumber).toBe("function");
    expect(valuation.FORECAST_YEARS).toBe(10);
    expect(valuation.TAX_RATE).toBe(0.21);
    expect(valuation.DCF_WACC).toBe(0.1);
    expect(valuation.COST_OF_EQUITY).toBe(0.1);
    expect(valuation.TERMINAL_GROWTH).toBe(0.025);
    expect(valuation.DEFAULT_GROWTH).toBe(0.05);
    expect(valuation.MAX_FORECAST_GROWTH).toBe(0.15);
  });

  it("calculates the golden DCF vector from the built CommonJS output", () => {
    const valuation = requireFromPackageRoot("@intrinsic/valuation") as typeof Valuation;

    const result = valuation.calculateDcfFcff({
      operatingCashFlowTtm: 120,
      capitalExpenditureTtm: -20,
      interestExpenseTtm: 10,
      growthUsed: 0.05,
      cash: 50,
      debt: 30,
      shares: 10,
    });

    expect(result.status).toBe("CALCULATED");
    if (result.status !== "CALCULATED") {
      return;
    }
    expect(result.value.valuePerShare).toBeCloseTo(178.8977101328, 9);
  });
});

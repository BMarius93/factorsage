import { describe, expect, it } from "vitest";
import { ORACLE_VALUATION_REASONS } from "../oracle/valuation-ratios";
import { runDifferential } from "./differential";

/**
 * The generated differential audit, CI-sized: the first 150 seeds of the adversarial generator,
 * every session read twice (closed and provisional), five ratios each — about 1.6 million cells,
 * every one held to the clean-room oracle. The full run (`pnpm audit:valuation -- generated`) is the
 * report's; this keeps a regression from landing between audits.
 */
describe("valuation ratios: the product against the oracle over generated histories", () => {
  const seeds = Array.from({ length: 150 }, (_, index) => index + 1);
  const result = runDifferential(seeds, { keepFailures: 20 });

  it("agrees on every cell: no false availability, no false unavailability, no value outside the float bound", () => {
    expect(result.tally.failures).toEqual([]);
    expect(result.tally.total("FALSE_AVAILABLE")).toBe(0);
    expect(result.tally.total("FALSE_UNAVAILABLE")).toBe(0);
    expect(result.tally.total("VALUE_MISMATCH")).toBe(0);
    expect(result.tally.total()).toBeGreaterThan(1_000_000);
  });

  it("is not trivially green: every ratio has readings both ways, and every rule withholds something on its own", () => {
    for (const counts of result.tally.cells.values()) {
      expect(counts.AVAILABLE_MATCH).toBeGreaterThan(10_000);
      expect(counts.EXPECTED_UNAVAILABLE).toBeGreaterThan(10_000);
    }
    const sole = new Set(result.soleRuleCells.keys());
    for (const reason of ORACLE_VALUATION_REASONS) {
      expect(sole.has(reason) || result.tally.total() === 0, reason).toBe(true);
    }
  });
});

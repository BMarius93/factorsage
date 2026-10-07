import { describe, expect, it } from "vitest";
import { ORACLE_VALUATION_REASONS } from "../oracle/valuation-ratios";
import { runDifferential } from "./differential";

/**
 * The generated differential audit, CI-sized: the first 150 seeds of both generator families — the
 * adversarial histories and the share-basis restatement histories — every session read twice
 * (closed and provisional), five ratios each: about 2.9 million cells, every one held to the
 * clean-room oracle. The full run (`pnpm audit:valuation -- generated`) is the report's; this keeps a
 * regression from landing between audits.
 */
describe("valuation ratios: the product against the oracle over generated histories", () => {
  const seeds = Array.from({ length: 150 }, (_, index) => index + 1);
  const result = runDifferential(seeds, { keepFailures: 20 });

  it("agrees on every cell: no false availability, no false unavailability, no value outside the float bound", () => {
    expect(result.tally.failures).toEqual([]);
    expect(result.tally.total("FALSE_AVAILABLE")).toBe(0);
    expect(result.tally.total("FALSE_UNAVAILABLE")).toBe(0);
    expect(result.tally.total("VALUE_MISMATCH")).toBe(0);
    expect(result.tally.total()).toBeGreaterThan(2_500_000);
  });

  it("is not trivially green: every ratio has readings both ways, and every rule withholds something on its own", () => {
    for (const family of result.families.values()) {
      for (const counts of family.tally.cells.values()) {
        expect(counts.AVAILABLE_MATCH).toBeGreaterThan(10_000);
        expect(counts.EXPECTED_UNAVAILABLE).toBeGreaterThan(10_000);
      }
    }
    const sole = new Set(result.soleRuleCells.keys());
    for (const reason of ORACLE_VALUATION_REASONS) {
      expect(sole.has(reason), reason).toBe(true);
    }
  });

  it("reaches rule 3 both ways: restatements a re-base explains are read, unexplained ones withheld", () => {
    const restatement = result.families.get("restatement");
    expect(restatement?.explainedRestatementCells).toBeGreaterThan(500);
    expect(
      result.soleRuleCells.get("SHARE_RESTATEMENT_UNEXPLAINED"),
    ).toBeGreaterThan(1_000);
  });

  it("reaches the owner's rulings both ways: rule 3's anchor beyond the previous revision, rule 2's first level", () => {
    const restatement = result.families.get("restatement");
    // A count compared with an anchor past a withheld or count-less revision: read when a re-base
    // explains it against the anchor — the ruled path's own positive case — withheld when nothing
    // does. (One that agrees with such an anchor is the provider taking a restatement back across
    // the split, which the second review's ruling withholds: below.)
    expect(restatement?.explainedBeyondPreviousCells).toBeGreaterThan(100);
    expect(restatement?.anchorBeyondPreviousAvailableCells).toBeGreaterThan(
      100,
    );
    expect(restatement?.anchorBeyondPreviousWithheldCells).toBeGreaterThan(
      2_000,
    );
    for (const family of result.families.values()) {
      expect(family.firstLevelUnconfirmedCells).toBeGreaterThan(100_000);
    }
  });

  it("reaches the owner's rulings on the second review: agreement across a share change, and the month before an event", () => {
    // A count that still agrees with an anchor observed before a split — never restated, or a
    // restatement taken back — and a count first observed in the month before an event, each
    // withheld by its rule alone on many cells.
    expect(result.soleRuleCells.get("SHARE_BASIS_UNCONFIRMED")).toBeGreaterThan(
      1_000,
    );
    expect(result.soleRuleCells.get("COUNT_BEFORE_EVENT")).toBeGreaterThan(
      10_000,
    );
    expect(
      result.features.get("restatement:late-revision-never-restated"),
    ).toBeGreaterThan(5);
    expect(
      result.features.get("restatement:first-load-before-event"),
    ).toBeGreaterThan(5);
  });
});

import { describe, expect, it } from "vitest";
import { revisionMismatches } from "./backtests.js";

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

import type { LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  reconstitutionPasses,
  validateClassifiedGeneration,
  validateGeneration,
  type ReconstitutionDiagnostic,
} from "./validation.js";

function diagnostic(
  date: string,
  fields: Partial<ReconstitutionDiagnostic> = {},
): ReconstitutionDiagnostic {
  return {
    date: date as LocalDate,
    effectiveDate: date as LocalDate,
    parentLines: 500,
    parentMembers: 500,
    withData: 490,
    withValue: 480,
    expected: 100,
    selected: 100,
    unavailable: {},
    ...fields,
  };
}

/** The last session of every December from `from` to `to`, as annual diagnostics. */
function annual(from: number, to: number, failing: (year: number) => boolean) {
  const years = Array.from(
    { length: to - from + 1 },
    (_, index) => from + index,
  );
  return years.map((year) =>
    diagnostic(`${year}-12-30`, failing(year) ? { withData: 300 } : {}),
  );
}

describe("historical universe validation", () => {
  it("passes a reconstitution on coverage, availability and a full selection", () => {
    expect(reconstitutionPasses(diagnostic("2020-12-31"))).toBe(true);
    expect(
      reconstitutionPasses(diagnostic("2020-12-31", { withData: 449 })),
    ).toBe(false);
    expect(
      reconstitutionPasses(diagnostic("2020-12-31", { withValue: 360 })),
    ).toBe(false);
    expect(
      reconstitutionPasses(diagnostic("2020-12-31", { selected: 99 })),
    ).toBe(false);
    expect(
      reconstitutionPasses(diagnostic("2020-12-31", { parentLines: 0 })),
    ).toBe(false);
  });

  it("publishes only the suffix after the last failing reconstitution", () => {
    const result = validateGeneration({
      diagnostics: annual(1996, 2025, (year) => year < 2004 || year === 2008),
      latestSession: "2026-01-15" as LocalDate,
    });
    expect(result.verdict).toBe("VALIDATED");
    expect(result.reliableFrom).toBe("2009-12-30");
    expect(result.publishFrom).toBe("2009-12-30");
    expect(result.byYear.find((entry) => entry.year === "2008")?.failing).toBe(
      1,
    );
    expect(
      result.byYear.find((entry) => entry.year === "2008")?.minDataCoverage,
    ).toBeCloseTo(0.6);
  });

  it("keeps a universe a draft when its reliable period is shorter than five years", () => {
    const result = validateGeneration({
      diagnostics: annual(1996, 2025, (year) => year < 2022),
      latestSession: "2026-01-15" as LocalDate,
    });
    expect(result.verdict).toBe("DRAFT");
    expect(result.reliableFrom).toBe("2022-12-30");
    expect(result.reasons).toEqual([
      {
        code: "RELIABLE_PERIOD_TOO_SHORT",
        reliableFrom: "2022-12-30",
        years: 3,
      },
    ]);
  });

  it("keeps a universe a draft when the latest reconstitution fails, or is stale", () => {
    expect(
      validateGeneration({
        diagnostics: annual(1996, 2025, (year) => year === 2025),
        latestSession: "2026-01-15" as LocalDate,
      }).reasons[0]?.code,
    ).toBe("NO_RELIABLE_PERIOD");
    const stale = validateGeneration({
      diagnostics: annual(1996, 2020, () => false),
      latestSession: "2026-01-15" as LocalDate,
    });
    expect(stale.verdict).toBe("DRAFT");
    expect(stale.reasons).toEqual([
      {
        code: "STALE",
        lastReconstitution: "2020-12-30",
        latestSession: "2026-01-15",
      },
    ]);
  });

  it("has no verdict but a draft without reconstitutions", () => {
    expect(
      validateGeneration({ diagnostics: [], latestSession: null }),
    ).toMatchObject({
      verdict: "DRAFT",
      reasons: [{ code: "NO_RECONSTITUTIONS" }],
    });
  });
});

describe("retrospectively classified universe validation", () => {
  const classified = (year: number) =>
    diagnostic(`${year}-12-30`, {
      // The index's coverage falls short before 2016, and so does the group's before 2010.
      withData: year < 2016 ? 300 : 490,
      classification: {
        classified: 498,
        unclassified: 2,
        groupMembers: 150,
        groupPriced: year < 2010 ? 120 : 145,
      },
    });
  const diagnostics = Array.from({ length: 30 }, (_, index) =>
    classified(1996 + index),
  );

  it("publishes from the floor and discloses the coverage it does not gate on", () => {
    const result = validateClassifiedGeneration({
      diagnostics,
      latestSession: "2026-01-15" as LocalDate,
      floor: "1996-01-02" as LocalDate,
      securities: 735,
      classifiedSecurities: 733,
      indexName: "S&P 500",
    });
    expect(result).toMatchObject({
      verdict: "VALIDATED",
      reasons: [],
      // Measured exactly as for the index, but not the start of the List.
      reliableFrom: "2016-12-30",
      publishFrom: "1996-01-02",
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "RETROSPECTIVE_CLASSIFICATION" }),
      expect.objectContaining({ code: "UNCLASSIFIED_MEMBERS", securities: 2 }),
      expect.objectContaining({
        code: "INCOMPLETE_PRICE_COVERAGE",
        coveredFrom: "2010-12-30",
      }),
      expect.objectContaining({ code: "SURVIVORSHIP_BIAS" }),
    ]);
  });

  it("holds back a classification too incomplete or a group that empties", () => {
    const sparse = validateClassifiedGeneration({
      diagnostics,
      latestSession: "2026-01-15" as LocalDate,
      floor: "1996-01-02" as LocalDate,
      securities: 735,
      classifiedSecurities: 690,
      indexName: "S&P 500",
    });
    expect(sparse.verdict).toBe("DRAFT");
    expect(sparse.publishFrom).toBeNull();
    expect(sparse.reasons).toEqual([
      {
        code: "CLASSIFICATION_INCOMPLETE",
        classifiedShare: 0.9388,
        minimum: 0.95,
      },
    ]);
    const empty = validateClassifiedGeneration({
      diagnostics: [
        ...diagnostics.slice(0, 5),
        diagnostic("2001-06-29", {
          classification: {
            classified: 500,
            unclassified: 0,
            groupMembers: 0,
            groupPriced: 0,
          },
        }),
      ],
      latestSession: "2001-07-15" as LocalDate,
      floor: "1996-01-02" as LocalDate,
      securities: 735,
      classifiedSecurities: 735,
      indexName: "S&P 500",
    });
    expect(empty.reasons).toContainEqual({
      code: "EMPTY_CLASSIFICATION_GROUP",
      date: "2001-06-29",
    });
  });
});

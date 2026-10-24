import type { LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  reconstitutionPasses,
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

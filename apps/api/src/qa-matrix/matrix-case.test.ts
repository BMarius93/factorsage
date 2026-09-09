import {
  QA_MATRIX_EXPECTED_COMBINATIONS,
  qaMatrixFixtures,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import {
  parseQaMatrixCaseId,
  qaMatrixCaseId,
  qaMatrixCases,
  qaMatrixGoldenCases,
  qaMatrixWarmupCases,
  QA_MATRIX_GOLDEN_CASES,
  QA_MATRIX_TOTAL_CASES,
  QaMatrixCaseSelectionError,
  selectQaMatrixCases,
} from "./matrix-case";

/**
 * The matrix's identity layer.
 *
 * Everything downstream — the report, the reproduction command, the resume point, the golden set —
 * is keyed by `Sxx-Lxx-Cxx`, so these properties are what make a failing combination something a
 * developer can act on rather than something they have to go and find again.
 */
const FIXTURES = qaMatrixFixtures("2026-09-09");

describe("matrix enumeration", () => {
  it("enumerates exactly one thousand combinations", () => {
    expect(qaMatrixCases(FIXTURES)).toHaveLength(QA_MATRIX_EXPECTED_COMBINATIONS);
    expect(QA_MATRIX_TOTAL_CASES).toBe(1_000);
  });

  it("gives every combination a unique identity", () => {
    const cases = qaMatrixCases(FIXTURES);
    expect(new Set(cases.map((entry) => entry.caseId)).size).toBe(1_000);
    expect(new Set(cases.map((entry) => entry.label)).size).toBe(1_000);
  });

  it("orders strategy, then list, then configuration, and indexes positionally", () => {
    const cases = qaMatrixCases(FIXTURES);
    expect(cases[0]?.caseId).toBe("S01-L01-C01");
    expect(cases[1]?.caseId).toBe("S01-L01-C02");
    expect(cases[10]?.caseId).toBe("S01-L02-C01");
    expect(cases[100]?.caseId).toBe("S02-L01-C01");
    expect(cases[999]?.caseId).toBe("S10-L10-C10");
    cases.forEach((entry, index) => {
      expect(entry.index).toBe(index);
    });
  });

  it("is deterministic: two enumerations of one clock are the same sequence", () => {
    const first = qaMatrixCases(qaMatrixFixtures("2026-09-09")).map((e) => e.label);
    const second = qaMatrixCases(qaMatrixFixtures("2026-09-09")).map((e) => e.label);
    expect(first).toEqual(second);
  });

  it("labels a combination with the reserved prefix", () => {
    expect(qaMatrixCases(FIXTURES)[0]?.label).toBe("QA-MATRIX-S01-L01-C01");
  });

  it("carries the configuration a runner submits", () => {
    const entry = qaMatrixCases(FIXTURES).find((e) => e.caseId === "S03-L07-C04");
    expect(entry?.combination.config.request.maximumPositions).toBe(10);
    expect(entry?.combination.strategy.id).toBe("S03");
    expect(entry?.combination.list.id).toBe("L07");
  });
});

describe("case identity parsing", () => {
  it("accepts the short form and the labelled form", () => {
    expect(parseQaMatrixCaseId("S03-L07-C04")).toEqual({
      strategyId: "S03",
      listId: "L07",
      configId: "C04",
    });
    expect(parseQaMatrixCaseId("QA-MATRIX-S03-L07-C04")).toEqual({
      strategyId: "S03",
      listId: "L07",
      configId: "C04",
    });
    expect(parseQaMatrixCaseId(" s03-l07-c04 ")).toEqual({
      strategyId: "S03",
      listId: "L07",
      configId: "C04",
    });
  });

  it("rejects a shape that is not the canonical two-digit identity", () => {
    // `S3-L7-C4` is a second string for one cell, and a reproduction command that is only
    // sometimes the same string is not a reproduction command.
    expect(parseQaMatrixCaseId("S3-L7-C4")).toBeNull();
    expect(parseQaMatrixCaseId("S03L07C04")).toBeNull();
    expect(parseQaMatrixCaseId("")).toBeNull();
  });

  it("builds the identity from its three parts", () => {
    expect(qaMatrixCaseId("S03", "L07", "C04")).toBe("S03-L07-C04");
  });
});

describe("case selection", () => {
  const cases = qaMatrixCases(FIXTURES);

  it("returns the whole matrix when nothing is selected", () => {
    expect(selectQaMatrixCases(cases, [])).toHaveLength(1_000);
  });

  it("reruns exactly one combination", () => {
    const selected = selectQaMatrixCases(cases, ["S03-L07-C04"]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.caseId).toBe("S03-L07-C04");
    expect(selected[0]?.combination.strategy.name).toContain("S03");
    expect(selected[0]?.combination.list.name).toContain("L07");
  });

  it("preserves canonical order regardless of the order given", () => {
    const selected = selectQaMatrixCases(cases, [
      "S05-L01-C01",
      "S01-L01-C01",
      "S03-L07-C04",
    ]);
    expect(selected.map((entry) => entry.caseId)).toEqual([
      "S01-L01-C01",
      "S03-L07-C04",
      "S05-L01-C01",
    ]);
  });

  it("refuses an unknown combination rather than silently running nothing", () => {
    expect(() => selectQaMatrixCases(cases, ["S03-L07-C99"])).toThrow(
      QaMatrixCaseSelectionError,
    );
    expect(() => selectQaMatrixCases(cases, ["nonsense"])).toThrow(
      /not a matrix case identity/,
    );
  });
});

describe("the golden set", () => {
  it("names combinations that exist, with a stated reason each", () => {
    const golden = qaMatrixGoldenCases(qaMatrixCases(FIXTURES));
    expect(golden).toHaveLength(QA_MATRIX_GOLDEN_CASES.length);
    for (const entry of QA_MATRIX_GOLDEN_CASES) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it("stays small: archives are reserved, not the default", () => {
    // A full archive for a thirty-year, thirty-security run is hundreds of megabytes. A thousand of
    // them is a disk-space incident, not a validation strategy.
    expect(QA_MATRIX_GOLDEN_CASES.length).toBeLessThanOrEqual(10);
  });

  it("spans more than one strategy, list and configuration", () => {
    const golden = qaMatrixGoldenCases(qaMatrixCases(FIXTURES));
    expect(new Set(golden.map((e) => e.strategyId)).size).toBeGreaterThan(3);
    expect(new Set(golden.map((e) => e.listId)).size).toBeGreaterThan(3);
    expect(new Set(golden.map((e) => e.configId)).size).toBeGreaterThan(3);
  });
});

describe("the warm-up set", () => {
  const cases = qaMatrixCases(FIXTURES);
  const warmup = qaMatrixWarmupCases(cases);

  it("covers every security the matrix will read", () => {
    const covered = new Set(
      warmup.flatMap((entry) =>
        entry.combination.list.members.map((member) => member.symbol),
      ),
    );
    const everySymbol = new Set(
      FIXTURES.lists.flatMap((list) =>
        list.members.map((member) => member.symbol),
      ),
    );
    expect([...everySymbol].filter((symbol) => !covered.has(symbol))).toEqual([]);
  });

  it("stays small: it is a precondition, not a second sweep", () => {
    expect(warmup.length).toBeLessThanOrEqual(4);
    expect(warmup.length).toBeGreaterThan(0);
  });

  it("uses the longest configuration, so every calendar-year chunk is warmed", () => {
    const earliestStart = [...FIXTURES.configs]
      .map((config) => config.request.startDate)
      .sort()[0];
    for (const entry of warmup) {
      expect(entry.combination.config.request.startDate).toBe(earliestStart);
    }
    expect(new Set(warmup.map((entry) => entry.strategyId)).size).toBe(1);
  });

  it("is deterministic and in canonical order", () => {
    expect(qaMatrixWarmupCases(cases).map((entry) => entry.caseId)).toEqual(
      warmup.map((entry) => entry.caseId),
    );
    expect([...warmup].sort((a, b) => a.index - b.index).map((e) => e.caseId)).toEqual(
      warmup.map((e) => e.caseId),
    );
  });
});

import { describe, expect, it } from "vitest";
import { planMatrixArchives } from "./matrix-archive-plan";
import { QA_MATRIX_GOLDEN_CASES, QA_MATRIX_TOTAL_CASES } from "./matrix-case";

/**
 * Archive scoping, decided without executing a single backtest.
 *
 * The defect this pins was measured rather than imagined: `--archive` on the full matrix wrote
 * 1,006 archives and 567 MB, because `BACKTEST_DEBUG_ARCHIVE` is a worker-process setting and the
 * sweep had only one pool. The rule is now a pure function, so "a thousand runs produce six
 * archives" is a property a test can hold rather than something a nine-hour sweep discovers.
 */
const GOLDEN = QA_MATRIX_GOLDEN_CASES.length;

describe("a full 1,000-case sweep", () => {
  const plan = planMatrixArchives({
    archiveRequested: true,
    selectedCases: QA_MATRIX_TOTAL_CASES,
    goldenCases: GOLDEN,
    determinismEnabled: true,
  });

  it("produces exactly six archives from 1,000 + 6 executions", () => {
    expect(QA_MATRIX_TOTAL_CASES).toBe(1_000);
    expect(GOLDEN).toBe(6);
    expect(plan.expectedArchives).toBe(6);
  });

  it("never captures in the pool that runs the thousand", () => {
    expect(plan.mainPool).toBe("off");
    expect(plan.rerunPool).toBe("full");
  });

  it("captures in the determinism rerun, which re-executes those six anyway", () => {
    expect(plan.reason).toContain("determinism");
  });
});

describe("an explicit selection", () => {
  it("gives exactly one archive for one case", () => {
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: 1,
      goldenCases: GOLDEN,
      determinismEnabled: true,
    });
    expect(plan.mainPool).toBe("full");
    expect(plan.rerunPool).toBe("off");
    expect(plan.expectedArchives).toBe(1);
  });

  it("gives six for --golden --archive, not twelve", () => {
    // The golden set is also what the determinism rerun executes; capturing in both pools would
    // double it.
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: GOLDEN,
      goldenCases: GOLDEN,
      determinismEnabled: true,
    });
    expect(plan.expectedArchives).toBe(GOLDEN);
    expect([plan.mainPool, plan.rerunPool]).toEqual(["full", "off"]);
  });
});

describe("no archives requested", () => {
  it("captures nothing anywhere", () => {
    const plan = planMatrixArchives({
      archiveRequested: false,
      selectedCases: QA_MATRIX_TOTAL_CASES,
      goldenCases: GOLDEN,
      determinismEnabled: true,
    });
    expect(plan).toMatchObject({
      mainPool: "off",
      rerunPool: "off",
      expectedArchives: 0,
    });
  });
});

describe("a full sweep with determinism disabled", () => {
  it("refuses the combination and says how to get the golden archives instead", () => {
    // Refusing to capture 1,000 is the point; silently capturing them would be one defect, and
    // silently capturing *none* while the user asked for archives was the other.
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: QA_MATRIX_TOTAL_CASES,
      goldenCases: GOLDEN,
      determinismEnabled: false,
    });
    expect(plan.expectedArchives).toBe(0);
    expect(plan.mainPool).toBe("off");
    expect(plan.refusal).toContain("--golden --archive");
  });
});

describe("the property that actually failed", () => {
  it("never plans an archive per executed case on a full sweep", () => {
    for (const determinismEnabled of [true, false]) {
      const plan = planMatrixArchives({
        archiveRequested: true,
        selectedCases: QA_MATRIX_TOTAL_CASES,
        goldenCases: GOLDEN,
        determinismEnabled,
      });
      expect(plan.expectedArchives).toBeLessThanOrEqual(GOLDEN);
      expect(plan.expectedArchives).not.toBe(QA_MATRIX_TOTAL_CASES);
      expect(plan.expectedArchives).not.toBe(QA_MATRIX_TOTAL_CASES + GOLDEN);
    }
  });
});

/**
 * An explicit `--archive` is never silently ignored.
 *
 * For a full sweep the archives come from the second pool — the one that re-executes the golden
 * combinations for determinism. Turn that rerun off and there is no pool left to capture in, so
 * `--archive --no-determinism` planned zero archives, wrote none, and the gate then skipped every
 * archive condition because the plan had not switched a pool on. The user asked for forensic
 * archives and got a green sweep with none, and nothing said so.
 */
describe("--archive with the determinism rerun disabled", () => {
  it("refuses a full sweep rather than planning zero archives", () => {
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: QA_MATRIX_TOTAL_CASES,
      goldenCases: 6,
      determinismEnabled: false,
    });
    expect(plan.refusal).toBeTruthy();
    expect(plan.refusal).toContain("--golden --archive");
    expect(plan.expectedArchives).toBe(0);
  });

  it("still accepts an explicit selection, which captures in the main pool", () => {
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: 1,
      goldenCases: 6,
      determinismEnabled: false,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.mainPool).toBe("full");
    expect(plan.rerunPool).toBe("off");
    expect(plan.expectedArchives).toBe(1);
  });

  it("accepts the golden set on its own", () => {
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: 6,
      goldenCases: 6,
      determinismEnabled: false,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.mainPool).toBe("full");
    expect(plan.expectedArchives).toBe(6);
  });

  it("has nothing to refuse when archives were not requested at all", () => {
    const plan = planMatrixArchives({
      archiveRequested: false,
      selectedCases: QA_MATRIX_TOTAL_CASES,
      goldenCases: 6,
      determinismEnabled: false,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.expectedArchives).toBe(0);
  });

  it("accepts the ordinary full sweep, where the rerun captures", () => {
    const plan = planMatrixArchives({
      archiveRequested: true,
      selectedCases: QA_MATRIX_TOTAL_CASES,
      goldenCases: 6,
      determinismEnabled: true,
    });
    expect(plan.refusal).toBeNull();
    expect(plan.rerunPool).toBe("full");
    expect(plan.expectedArchives).toBe(6);
  });
});

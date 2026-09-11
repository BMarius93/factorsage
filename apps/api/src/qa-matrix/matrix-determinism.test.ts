import { describe, expect, it } from "vitest";
import { completeEvidence } from "./matrix-evidence.test-helper";
import type {
  EvidenceEquity,
  EvidencePosition,
  EvidenceSummary,
  EvidenceTrade,
  RunEvidence,
} from "./matrix-invariants";
import { compareForDeterminism } from "./matrix-runner";

/**
 * Determinism, stated literally.
 *
 * "Two executions of the same case from the same pinned data are identical" is a claim about
 * **every** persisted financial field, and a comparison that reads a subset does not make it. The
 * one this replaces compared thirteen of a trade's fifteen fields, seven of an equity row's ten,
 * six of a position's twelve, and reduced the whole summary to a `JSON.stringify` that could say
 * only "summary differs".
 *
 * So each field gets its own mutation here: change exactly one, and the comparison has to name it.
 * A field nobody can make fail is a field nobody is really comparing.
 */

const BASE = completeEvidence({ runId: "run-1", caseId: "S01-L01-C01" });

function mutated(
  change: (evidence: RunEvidence) => RunEvidence,
): readonly string[] {
  return compareForDeterminism(BASE, change(structuredCloneEvidence(BASE)));
}

/** A deep-enough copy; `snapshot` and the maps are shared deliberately, as inputs rather than results. */
function structuredCloneEvidence(evidence: RunEvidence): RunEvidence {
  return {
    ...evidence,
    trades: evidence.trades.map((trade) => ({ ...trade })),
    equity: evidence.equity.map((point) => ({ ...point })),
    positions: evidence.positions.map((position) => ({ ...position })),
    summary: evidence.summary ? { ...evidence.summary } : null,
  };
}

describe("two identical executions", () => {
  it("differ in nothing", () => {
    expect(compareForDeterminism(BASE, structuredCloneEvidence(BASE))).toEqual(
      [],
    );
  });

  it("still differ in nothing when only the run id and case id differ", () => {
    // Operational identity is legitimately different every time. A comparison that flagged it
    // would be noise that trains a reader to ignore the check.
    const second = {
      ...structuredCloneEvidence(BASE),
      runId: "run-2",
      caseId: "S01-L01-C01",
    };
    expect(compareForDeterminism(BASE, second)).toEqual([]);
  });
});

describe("every persisted trade field", () => {
  const change = (field: keyof EvidenceTrade, value: unknown) =>
    mutated((evidence) => ({
      ...evidence,
      trades: [{ ...(evidence.trades[0] as EvidenceTrade), [field]: value }],
    }));

  const cases: readonly [keyof EvidenceTrade, unknown][] = [
    ["sequence", 2],
    ["date", "2026-01-05"],
    ["securityId", "sec-other"],
    ["symbol", "ZZZ"],
    ["name", "Something Else Inc."],
    ["action", "SELL"],
    ["levelId", "b50"],
    ["levelPercentage", 50],
    ["shares", "9.0000000000"],
    ["price", "51.00000000"],
    ["amount", "5000.000001"],
    ["fees", "0.000001"],
    ["realizedPnl", "1.000000"],
    ["realizedPnlPercent", "0.00000001"],
    ["cashAfter", "95000.000001"],
    ["sharesAfter", "10.0000000001"],
    ["averageCostAfter", "50.00000001"],
  ];

  for (const [field, value] of cases) {
    it(`detects a change to ${String(field)}`, () => {
      const differences = change(field, value);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.join("\n")).toContain(String(field));
    });
  }

  it("detects a trade that appeared", () => {
    expect(
      mutated((evidence) => ({
        ...evidence,
        trades: [
          ...evidence.trades,
          { ...(evidence.trades[0] as EvidenceTrade), sequence: 2 },
        ],
      })),
    ).not.toEqual([]);
  });
});

describe("every persisted equity field", () => {
  const change = (field: keyof EvidenceEquity, value: unknown) =>
    mutated((evidence) => ({
      ...evidence,
      equity: [{ ...(evidence.equity[0] as EvidenceEquity), [field]: value }],
    }));

  const cases: readonly [keyof EvidenceEquity, unknown][] = [
    ["date", "2026-01-05"],
    ["cash", "95000.000001"],
    ["positionsValue", "5000.000001"],
    ["totalValue", "100000.000001"],
    ["investedCapital", "100000.000001"],
    ["returnIndex", "1.0000000001"],
    ["benchmarkIndex", "1.0000000001"],
    ["benchmarkValue", "100000.000001"],
    ["cashBaselineValue", "100000.000001"],
    ["openPositions", 2],
  ];

  for (const [field, value] of cases) {
    it(`detects a change to ${String(field)}`, () => {
      const differences = change(field, value);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.join("\n")).toContain(String(field));
    });
  }
});

describe("every persisted position field", () => {
  const change = (field: keyof EvidencePosition, value: unknown) =>
    mutated((evidence) => ({
      ...evidence,
      positions: [
        { ...(evidence.positions[0] as EvidencePosition), [field]: value },
      ],
    }));

  const cases: readonly [keyof EvidencePosition, unknown][] = [
    ["securityId", "sec-other"],
    ["symbol", "ZZZ"],
    ["name", "Something Else Inc."],
    ["openedDate", "2026-01-05"],
    ["shares", "10.0000000001"],
    ["averageCost", "50.00000001"],
    ["lastPrice", "60.00000001"],
    ["lastPriceDate", "2026-01-05"],
    ["marketValue", "600.000001"],
    ["unrealizedPnl", "100.000001"],
    ["unrealizedPnlPercent", "20.00000001"],
    ["allocationPercent", "5.00000001"],
  ];

  for (const [field, value] of cases) {
    it(`detects a change to ${String(field)}`, () => {
      const differences = change(field, value);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.join("\n")).toContain(String(field));
    });
  }
});

describe("every persisted summary field", () => {
  const change = (field: keyof EvidenceSummary, value: unknown) =>
    mutated((evidence) => ({
      ...evidence,
      summary: { ...(evidence.summary as EvidenceSummary), [field]: value },
    }));

  const cases: readonly [keyof EvidenceSummary, unknown][] = [
    ["firstSimulatedDate", "2026-01-05"],
    ["lastSimulatedDate", "2026-01-06"],
    ["tradingDays", 3],
    ["investedCapital", "100000.000001"],
    ["finalCash", "95000.000001"],
    ["finalPositionsValue", "600.000001"],
    ["finalValue", "95600.000001"],
    ["netProfit", "1.000000"],
    ["portfolioReturnPercent", "0.00000001"],
    ["benchmarkReturnPercent", "0.00000001"],
    ["alphaPercent", "0.00000001"],
    ["portfolioCagrPercent", "0.00000001"],
    ["maxDrawdownPercent", "0.00000001"],
    ["benchmarkMaxDrawdownPercent", "0.00000001"],
    ["realizedPnl", "1.000000"],
    ["unrealizedPnl", "1.000000"],
    ["totalTrades", 2],
    ["buyTrades", 2],
    ["sellTrades", 1],
    ["finalExitTrades", 1],
    ["winningTrades", 1],
    ["losingTrades", 1],
    ["openPositions", 2],
  ];

  for (const [field, value] of cases) {
    it(`detects a change to ${String(field)}`, () => {
      const differences = change(field, value);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.join("\n")).toContain(String(field));
    });
  }

  it("detects a summary that stopped existing", () => {
    expect(mutated((evidence) => ({ ...evidence, summary: null }))).not.toEqual(
      [],
    );
  });
});

describe("run-level result fields", () => {
  it("detects a different terminal status", () => {
    expect(
      mutated((evidence) => ({ ...evidence, status: "FAILED" })),
    ).not.toEqual([]);
  });

  it("detects a different failure code", () => {
    expect(
      mutated((evidence) => ({ ...evidence, failureCode: "EXECUTION_FAILED" })),
    ).not.toEqual([]);
  });

  it("detects a shortened simulated period", () => {
    expect(
      mutated((evidence) => ({ ...evidence, startDate: "1996-09-10" })),
    ).not.toEqual([]);
  });
});

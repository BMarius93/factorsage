import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import {
  QA_MATRIX_ETF_STRATEGIES,
  QA_MATRIX_SECTOR_STRATEGIES,
  qaMatrixFixtures,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import { qaMatrixCases } from "./matrix-case";
import { buildOracleColumns, type OracleBar } from "./matrix-etf-oracle";
import type { RunEvidence } from "./matrix-invariants";
import { SourceCoverageAccumulator } from "./matrix-source-coverage";

/**
 * The behaviour-coverage expectations of the data-source dimensions, decided from synthetic evidence:
 * each expectation is shown met by a sweep that exercised it and unmet by one that did not.
 */

const ETF = qaMatrixFixtures("2026-10-15", undefined, QA_MATRIX_ETF_STRATEGIES);
const SECTOR = qaMatrixFixtures(
  "2026-10-15",
  undefined,
  QA_MATRIX_SECTOR_STRATEGIES,
);

/** A fund that rises for a year and then falls for a year, from 2024-01-01. */
function bars(from = "2024-01-01", sessions = 520): OracleBar[] {
  const out: OracleBar[] = [];
  let date = Date.parse(`${from}T00:00:00.000Z`);
  while (out.length < sessions) {
    const weekday = new Date(date).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const index = out.length;
      const close = index < sessions / 2 ? 100 + index : 100 + sessions - index;
      out.push({
        date: new Date(date).toISOString().slice(0, 10),
        open: close,
        high: close,
        low: close,
        close,
        volume: 1_000 + (index % 7) * 300,
      });
    }
    date += 86_400_000;
  }
  return out;
}

function evidenceFor(
  strategyId: string,
  fixtures: typeof ETF,
  options: { fundBars?: OracleBar[]; trades?: RunEvidence["trades"] } = {},
): {
  matrixCase: ReturnType<typeof qaMatrixCases>[number];
  evidence: RunEvidence;
} {
  const matrixCase = qaMatrixCases(fixtures).find(
    (entry) => entry.strategyId === strategyId,
  )!;
  const definition = matrixCase.combination.strategy.definition;
  const columns = buildOracleColumns(
    options.fundBars ?? bars(),
    () => new Set(),
  );
  const codes = new Set<string>();
  JSON.stringify(definition, (key, value) => {
    if (
      value &&
      typeof value === "object" &&
      value.kind === "ETF" &&
      typeof value.code === "string"
    ) {
      codes.add(value.code);
    }
    return value;
  });
  const sector =
    fixtures === SECTOR
      ? { name: "Technology", etfCode: "ETF_XLK" }
      : undefined;
  if (sector) codes.add("ETF_XLK");
  const snapshot = {
    strategy: { definition },
    securities: [
      { securityId: "sec-1", symbol: "AAPL", ...(sector ? { sector } : {}) },
    ],
    etfSeries: [...codes].map((code) => ({ code, seriesId: `series-${code}` })),
  } as unknown as BacktestRunSnapshot;
  const evidence = {
    status: "COMPLETED",
    snapshot,
    trades: options.trades ?? [],
    equity: columns.dates.map((date) => ({ date })),
    etf: {
      oracleBySeriesId: new Map(
        [...codes].map((code) => [`series-${code}`, columns]),
      ),
      diagnostics: [...codes].map((code) => ({ code, status: "READY" })),
      currentSectorBySecurityId: new Map([["sec-1", sector?.name ?? null]]),
    },
  } as unknown as RunEvidence;
  return { matrixCase, evidence };
}

describe("data-source behaviour coverage", () => {
  it("has no expectations for a partial selection or another dimension", () => {
    expect(
      new SourceCoverageAccumulator("ETF", ETF).expectations(false),
    ).toEqual([]);
    expect(
      new SourceCoverageAccumulator(
        "CORE",
        qaMatrixFixtures("2026-10-15"),
      ).expectations(true),
    ).toEqual([]);
  });

  it("measures the always-TRUE and never-TRUE probes' premises from the tallies", () => {
    const accumulator = new SourceCoverageAccumulator("ETF", ETF);
    for (const id of ["E08", "E10"]) {
      const { matrixCase, evidence } = evidenceFor(id, ETF);
      accumulator.add(matrixCase, evidence);
    }
    const expectations = accumulator.expectations(true);
    const always = expectations.find(
      (entry) =>
        entry.expectation.includes("E08") &&
        entry.expectation.includes("TRUE wherever"),
    );
    const never = expectations.find(
      (entry) =>
        entry.expectation.includes("E10") &&
        entry.expectation.includes("never TRUE"),
    );
    expect(always?.met).toBe(true);
    expect(never?.met).toBe(true);
    // The never-TRUE level never traded, which is what its expectation requires.
    expect(
      expectations.find((entry) =>
        entry.expectation.startsWith("E10 never traded"),
      )?.met,
    ).toBe(true);
  });

  it("fails a fixture whose ETF-gated levels never traded, and passes it once one did", () => {
    const idle = new SourceCoverageAccumulator("ETF", ETF);
    const { matrixCase, evidence } = evidenceFor("E01", ETF);
    idle.add(matrixCase, evidence);
    expect(
      idle
        .expectations(true)
        .find((entry) => entry.expectation.startsWith("E01 traded"))?.met,
    ).toBe(false);

    const traded = new SourceCoverageAccumulator("ETF", ETF);
    const levelId = matrixCase.combination.strategy.definition.buyLevels[0]!.id;
    const withTrade = evidenceFor("E01", ETF, {
      trades: [
        {
          sequence: 1,
          date: "2024-12-02",
          securityId: "sec-1",
          symbol: "AAPL",
          action: "BUY",
          levelId,
        } as RunEvidence["trades"][number],
      ],
    });
    traded.add(withTrade.matrixCase, withTrade.evidence);
    expect(
      traded
        .expectations(true)
        .find((entry) => entry.expectation.startsWith("E01 traded"))?.met,
    ).toBe(true);
  });

  it("requires a condition to have been both TRUE and FALSE", () => {
    const accumulator = new SourceCoverageAccumulator("ETF", ETF);
    // A fund that only rises: `Price above SMA 200D` is never FALSE once warmed up.
    const rising = bars("2024-01-01", 400).map((bar, index) => ({
      ...bar,
      close: 100 + index,
    }));
    const { matrixCase, evidence } = evidenceFor("E01", ETF, {
      fundBars: rising,
    });
    accumulator.add(matrixCase, evidence);
    const entry = accumulator
      .expectations(true)
      .find((item) => item.expectation.startsWith("E01 e01-buy1-c1"));
    expect(entry?.met).toBe(false);
  });

  it("requires Stock's Sector to read all eleven sector funds", () => {
    const accumulator = new SourceCoverageAccumulator("SECTOR", SECTOR);
    const { matrixCase, evidence } = evidenceFor("T01", SECTOR);
    accumulator.add(matrixCase, evidence);
    const entry = accumulator
      .expectations(true)
      .find((item) => item.expectation.includes("all eleven"));
    expect(entry?.met).toBe(false);
    expect(entry?.detail).toContain("ETF_XLU");
  });
});

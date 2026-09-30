import { FUNDAMENTAL_AUDIT_METRICS } from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import type { SecurityIndicators } from "../technicals/run-technicals-audit";
import type { BacktestArchive } from "./archive-reader";
import {
  FUNDAMENTAL_PROVENANCE_COLUMNS,
  FrameProvenance,
  referencedFundamentalIds,
  type FundamentalReference,
} from "./frame-provenance";

/**
 * The frame-provenance audit traces every `fundamental:*` column back to the persisted
 * `DailyDerivedState` value, and fails — never skips — on each defect class audit section 27 names:
 * a metric reading another's column, a metric missing from the frame, absence read as zero, a
 * percentage or a multiple scaled by 100, a value on the wrong session, an identity the tooling does
 * not recognise, and a frame session the stored history has no row for.
 */

const SECURITY = "provenance-security";
const DATES = [
  "2025-03-03",
  "2025-03-04",
  "2025-03-05",
  "2025-03-06",
  "2025-03-07",
];

/** Distinct per metric and session: positive, zero, negative, unavailable, positive. */
function storedValue(metricIndex: number, session: number): number | null {
  return (
    [
      11 + metricIndex / 100,
      0,
      -(2 + metricIndex / 10),
      null,
      30 + metricIndex,
    ][session] ?? null
  );
}

const reference: FundamentalReference = {
  dates: DATES,
  stored: Object.fromEntries(
    FUNDAMENTAL_AUDIT_METRICS.map((metric, metricIndex) => [
      metric.field,
      DATES.map((_date, session) => storedValue(metricIndex, session)),
    ]),
  ),
};

const technicals = new Map<string, SecurityIndicators>([
  [
    SECURITY,
    { dates: DATES, values: new Map(), weekStart: DATES.map(() => null) },
  ],
]);

function definitionNaming(ids: readonly string[]) {
  return {
    schemaVersion: 2,
    buyLevels: [
      {
        id: "buy",
        percentage: 100,
        signal: {
          conditions: ids.map((id, index) => ({
            id: `c${index}`,
            metric: { kind: "FUNDAMENTAL", metricId: id },
            operator: "IS_ABOVE",
            value: { kind: "PERCENT", value: 0 },
          })),
        },
      },
    ],
    sellLevels: [],
  };
}

function archive(
  operands: Record<string, (number | null)[]>,
  named: readonly string[] = FUNDAMENTAL_AUDIT_METRICS.map(
    (metric) => metric.id,
  ),
): BacktestArchive {
  return {
    path: "synthetic",
    manifest: {
      archiveSchemaVersion: 2,
      run: { runId: "run", attempt: 1, status: "COMPLETED" },
    },
    snapshot: {
      period: { startDate: DATES[0]!, endDate: DATES.at(-1)! },
      capital: { initialCapital: 1, monthlyContribution: 0 },
      allocation: { maximumPositions: 1, fullPositionFraction: 1 },
      strategy: { definition: definitionNaming(named), name: "provenance" },
      stockList: { name: "list" },
      securities: [],
      executionCalendar: { seriesId: "calendar" },
      benchmark: { seriesId: "benchmark", code: "SP500" },
    },
    calendar: DATES,
    benchmark: null,
    preparation: { securities: [] },
    frames: [
      {
        securityId: SECURITY,
        symbol: "PROV",
        year: "2025",
        contextRowCount: 0,
        dates: DATES,
        closes: DATES.map(() => 100),
        operands,
        window: { requestedFrom: DATES[0]!, requestedTo: DATES.at(-1)! },
      },
    ],
    contributions: [],
    result: { trades: [], equity: [], summary: null },
  } as unknown as BacktestArchive;
}

/** What a correct projector writes: the stored value, `null` (the archive's NaN) where absent. */
function correctOperands(): Record<string, (number | null)[]> {
  return Object.fromEntries(
    FUNDAMENTAL_AUDIT_METRICS.map((metric, metricIndex) => [
      `fundamental:${metric.id}`,
      DATES.map((_date, session) => storedValue(metricIndex, session)),
    ]),
  );
}

function audited(
  operands: Record<string, (number | null)[]>,
  named?: string[],
  references: ReadonlyMap<string, FundamentalReference> = new Map([
    [SECURITY, reference],
  ]),
) {
  const provenance = new FrameProvenance(technicals, new Map(), references);
  provenance.audit(archive(operands, named));
  return provenance;
}

describe("frame provenance of the Fundamental Metric columns", () => {
  it("passes a faithful projection of all fifteen, compared exactly and never skipped", () => {
    const provenance = audited(correctOperands());
    expect(provenance.ledger.failed).toBe(0);
    expect(provenance.ledger.skipped).toBe(0);
    expect(provenance.ledger.tolerancePasses).toBe(0);
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      expect(provenance.byKey[`fundamental:${metric.id}`], metric.id).toEqual({
        compared: DATES.length,
        failed: 0,
      });
    }
    expect(provenance.ledger.compared).toBe(15 * DATES.length);
  });

  const faults: [
    string,
    (operands: Record<string, (number | null)[]>) => string[] | void,
    string,
  ][] = [
    [
      "ROIC reading ROE's column",
      (operands) =>
        void (operands["fundamental:ROIC_TTM"] =
          operands["fundamental:ROE_TTM"]!),
      "fundamental:ROIC_TTM",
    ],
    [
      "Debt / Equity reading Current Ratio's column",
      (operands) =>
        void (operands["fundamental:DEBT_TO_EQUITY"] =
          operands["fundamental:CURRENT_RATIO"]!),
      "fundamental:DEBT_TO_EQUITY",
    ],
    [
      "absence read as zero",
      (operands) =>
        void (operands["fundamental:NET_MARGIN_TTM"] = operands[
          "fundamental:NET_MARGIN_TTM"
        ]!.map((value) => value ?? 0)),
      "fundamental:NET_MARGIN_TTM",
    ],
    [
      "a percentage divided by 100",
      (operands) =>
        void (operands["fundamental:ROIC_TTM"] = operands[
          "fundamental:ROIC_TTM"
        ]!.map((value) => (value === null ? null : value / 100))),
      "fundamental:ROIC_TTM",
    ],
    [
      "a percentage multiplied by 100",
      (operands) =>
        void (operands["fundamental:GROSS_MARGIN_TTM"] = operands[
          "fundamental:GROSS_MARGIN_TTM"
        ]!.map((value) => (value === null ? null : value * 100))),
      "fundamental:GROSS_MARGIN_TTM",
    ],
    [
      "a multiple scaled like a percentage",
      (operands) =>
        void (operands["fundamental:CURRENT_RATIO"] = operands[
          "fundamental:CURRENT_RATIO"
        ]!.map((value) => (value === null ? null : value * 100))),
      "fundamental:CURRENT_RATIO",
    ],
    [
      "a value on the wrong session",
      (operands) =>
        void (operands["fundamental:ASSET_TURNOVER_TTM"] = [
          null,
          ...operands["fundamental:ASSET_TURNOVER_TTM"]!.slice(0, -1),
        ]),
      "fundamental:ASSET_TURNOVER_TTM",
    ],
    [
      "a referenced Fundamental missing from the frame",
      (operands) => void delete operands["fundamental:INTEREST_COVERAGE_TTM"],
      "fundamental:INTEREST_COVERAGE_TTM",
    ],
    [
      "an identity the tooling does not recognise",
      (operands) => void (operands["fundamental:ROIC"] = DATES.map(() => 1)),
      "fundamental:ROIC",
    ],
  ];

  it.each(faults)("fails on %s", (_name, inject, key) => {
    const operands = correctOperands();
    inject(operands);
    const provenance = audited(operands);
    expect(provenance.ledger.failed, key).toBeGreaterThan(0);
    expect(provenance.byKey[key]?.failed, key).toBeGreaterThan(0);
  });

  it("fails on a frame session inside the stored history that has no stored row", () => {
    // The stored history lacks 2025-03-05; the frame still projects a value for it.
    const gapped: FundamentalReference = {
      dates: DATES.filter((_date, session) => session !== 2),
      stored: Object.fromEntries(
        Object.entries(reference.stored).map(([column, values]) => [
          column,
          values.filter((_value, session) => session !== 2),
        ]),
      ),
    };
    const provenance = audited(
      correctOperands(),
      undefined,
      new Map([[SECURITY, gapped]]),
    );
    expect(provenance.ledger.skipped).toBe(0);
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      expect(provenance.byKey[`fundamental:${metric.id}`], metric.id).toEqual({
        compared: DATES.length,
        failed: 1,
      });
    }
    expect(provenance.ledger.differences[0]?.path).toContain("2025-03-05");
  });

  it("fails, rather than skips, a Fundamental column of a security with no stored reference", () => {
    const provenance = audited(correctOperands(), undefined, new Map());
    expect(provenance.ledger.skipped).toBe(0);
    expect(provenance.ledger.failed).toBe(15 * DATES.length);
  });

  it("knows every audited identity, mapped to the ADR's storage field", () => {
    expect(FUNDAMENTAL_PROVENANCE_COLUMNS).toEqual(
      Object.fromEntries(
        FUNDAMENTAL_AUDIT_METRICS.map((metric) => [metric.id, metric.field]),
      ),
    );
  });

  it("reads the referenced identities from the definition document itself, FINAL EXIT included", () => {
    expect(
      referencedFundamentalIds({
        buyLevels: [
          {
            signal: {
              conditions: [
                { metric: { kind: "FUNDAMENTAL", metricId: "ROE_TTM" } },
              ],
            },
          },
        ],
        sellLevels: [
          { signal: { conditions: [{ metric: { kind: "PRICE" } }] } },
        ],
        finalExit: {
          rules: [
            {
              signal: {
                conditions: [
                  {
                    metric: {
                      kind: "FUNDAMENTAL",
                      metricId: "ASSET_TURNOVER_TTM",
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toEqual(["ASSET_TURNOVER_TTM", "ROE_TTM"]);
  });
});

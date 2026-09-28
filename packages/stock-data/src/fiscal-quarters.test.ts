import {
  selectFinancialStatements,
  type FinancialStatement,
} from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  alignedOpeningAndEndingStates,
  commonTrailingFiscalQuarterWindow,
  consecutiveFiscalQuarterRanks,
  fiscalQuarterOfRank,
  fiscalQuarterRank,
  indexFiscalQuarters,
  latestCommonFiscalQuarterRank,
  latestFiscalQuarterRank,
  latestFiscalQuarterStatement,
  statementsForFiscalQuarters,
  trailingFiscalQuarterWindow,
  trailingYearOverYearWindows,
  TTM_QUARTERS,
  type FiscalQuarterIndex,
} from "./fiscal-quarters.js";
import {
  quarter,
  quartersOf,
  shuffled,
  statement,
  type Quarter,
} from "./fundamental-metrics.test-helper.js";

/** The shared fiscal-window suite of `docs/development/fundamental-metrics-test-matrix.md`. */

function income(
  each: Quarter | { fiscalYear: number; period: "FY" },
  availableFromDate = "2026-01-05",
  overrides: Partial<FinancialStatement> = {},
): FinancialStatement {
  return statement(
    "INCOME",
    each,
    { revenue: 100 },
    availableFromDate,
    overrides,
  );
}

function identities(rows: readonly FinancialStatement[] | undefined) {
  return rows?.map((row) => `${row.fiscalYear}-${row.period}`);
}

function incomeIndex(rows: readonly FinancialStatement[]): FiscalQuarterIndex {
  return indexFiscalQuarters(rows, "INCOME");
}

describe("fiscal-quarter identity and adjacency", () => {
  it("steps Q1 -> Q2 -> Q3 -> Q4 within one fiscal year", () => {
    const ranks = quartersOf(2025).map(fiscalQuarterRank);

    expect(ranks.map((rank, index) => rank - (ranks[0] ?? 0) - index)).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it("makes Q4 immediately precede the next fiscal year's Q1", () => {
    expect(fiscalQuarterRank(quarter(2026, "Q1"))).toBe(
      fiscalQuarterRank(quarter(2025, "Q4")) + 1,
    );
  });

  it("round-trips a rank to its fiscal quarter", () => {
    for (const each of [
      quarter(1994, "Q1"),
      quarter(2025, "Q3"),
      quarter(2026, "Q4"),
    ]) {
      expect(fiscalQuarterOfRank(fiscalQuarterRank(each))).toEqual(each);
    }
    expect(() => fiscalQuarterOfRank(1.5)).toThrow("must be an integer");
  });

  it("builds consecutive ranks oldest first, across a fiscal-year boundary", () => {
    const end = fiscalQuarterRank(quarter(2026, "Q2"));

    expect(
      consecutiveFiscalQuarterRanks(end, 4).map(fiscalQuarterOfRank),
    ).toEqual([
      quarter(2025, "Q3"),
      quarter(2025, "Q4"),
      quarter(2026, "Q1"),
      quarter(2026, "Q2"),
    ]);
  });

  it("decides adjacency by fiscal identity even when fiscal dates are off the calendar", () => {
    // A January fiscal year-end: FY2026 Q1 ends in May 2025, FY2025 Q4 in February 2025.
    const rows = [
      income(quarter(2025, "Q3"), undefined, { fiscalDate: "2024-11-02" }),
      income(quarter(2025, "Q4"), undefined, { fiscalDate: "2025-02-01" }),
      income(quarter(2026, "Q1"), undefined, { fiscalDate: "2025-05-03" }),
      income(quarter(2026, "Q2"), undefined, { fiscalDate: "2025-08-02" }),
    ];

    expect(
      identities(trailingFiscalQuarterWindow(incomeIndex(rows), 4)?.statements),
    ).toEqual(["2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2"]);
  });
});

describe("indexing one family's quarters", () => {
  it("ignores FY rows and other statement families", () => {
    const rows = [
      income(quarter(2025, "Q1")),
      income({ fiscalYear: 2025, period: "FY" }),
      statement("CASH_FLOW", quarter(2025, "Q2"), {}, "2026-01-05"),
    ];
    const index = incomeIndex(rows);

    expect([...index.keys()]).toEqual([fiscalQuarterRank(quarter(2025, "Q1"))]);
  });

  it("represents a quarter by its later period end, whatever the input order", () => {
    const early = income(quarter(2025, "Q4"), undefined, {
      fiscalDate: "2025-12-27",
      contentHash: "early",
    });
    const late = income(quarter(2025, "Q4"), undefined, {
      fiscalDate: "2025-12-31",
      contentHash: "late",
    });

    for (const rows of [
      [early, late],
      [late, early],
    ]) {
      expect(
        incomeIndex(rows).get(fiscalQuarterRank(quarter(2025, "Q4")))
          ?.contentHash,
      ).toBe("late");
    }
  });
});

describe("exact trailing windows", () => {
  const eightQuarters = [...quartersOf(2024), ...quartersOf(2025)].map((each) =>
    income(each),
  );

  it("takes exactly four consecutive quarters ending at the latest one", () => {
    const window = trailingFiscalQuarterWindow(
      incomeIndex(eightQuarters),
      TTM_QUARTERS,
    );

    expect(identities(window?.statements)).toEqual([
      "2025-Q1",
      "2025-Q2",
      "2025-Q3",
      "2025-Q4",
    ]);
    expect(window?.endRank).toBe(fiscalQuarterRank(quarter(2025, "Q4")));
  });

  it("is unavailable when a middle quarter is missing", () => {
    const rows = eightQuarters.filter(
      (row) => !(row.fiscalYear === 2025 && row.period === "Q2"),
    );

    expect(trailingFiscalQuarterWindow(incomeIndex(rows), 4)).toBeUndefined();
  });

  it("never falls back to an older complete window behind a gap", () => {
    // FY2024 is complete, but the latest quarter FY2025 Q3 has FY2025 Q2 missing behind it.
    const rows = [
      ...quartersOf(2024).map((each) => income(each)),
      income(quarter(2025, "Q1")),
      income(quarter(2025, "Q3")),
    ];

    expect(trailingFiscalQuarterWindow(incomeIndex(rows), 4)).toBeUndefined();
  });

  it("never lets an FY row fill a missing quarter", () => {
    const rows = [
      income(quarter(2025, "Q1")),
      income(quarter(2025, "Q2")),
      income(quarter(2025, "Q4")),
      income({ fiscalYear: 2025, period: "FY" }),
    ];

    expect(trailingFiscalQuarterWindow(incomeIndex(rows), 4)).toBeUndefined();
  });

  it("splits eight consecutive quarters into the previous and current windows", () => {
    const windows = trailingYearOverYearWindows(incomeIndex(eightQuarters));

    expect(identities(windows?.previous)).toEqual([
      "2024-Q1",
      "2024-Q2",
      "2024-Q3",
      "2024-Q4",
    ]);
    expect(identities(windows?.current)).toEqual([
      "2025-Q1",
      "2025-Q2",
      "2025-Q3",
      "2025-Q4",
    ]);
  });

  it("chains eight quarters across fiscal-year boundaries that start mid-year", () => {
    const rows = [
      quarter(2024, "Q3"),
      quarter(2024, "Q4"),
      ...quartersOf(2025),
      quarter(2026, "Q1"),
      quarter(2026, "Q2"),
    ].map((each) => income(each));
    const windows = trailingYearOverYearWindows(incomeIndex(rows));

    expect(identities(windows?.previous)).toEqual([
      "2024-Q3",
      "2024-Q4",
      "2025-Q1",
      "2025-Q2",
    ]);
    expect(identities(windows?.current)).toEqual([
      "2025-Q3",
      "2025-Q4",
      "2026-Q1",
      "2026-Q2",
    ]);
  });

  it("requires all eight quarters: one missing in the previous window is enough", () => {
    const rows = eightQuarters.filter(
      (row) => !(row.fiscalYear === 2024 && row.period === "Q2"),
    );

    expect(trailingYearOverYearWindows(incomeIndex(rows))).toBeUndefined();
    // The current four-quarter window is still complete.
    expect(trailingFiscalQuarterWindow(incomeIndex(rows), 4)).toBeDefined();
  });

  it("is not altered by a ninth, older quarter", () => {
    const withNinth = [income(quarter(2023, "Q4")), ...eightQuarters];

    expect(trailingYearOverYearWindows(incomeIndex(withNinth))).toEqual(
      trailingYearOverYearWindows(incomeIndex(eightQuarters)),
    );
  });

  it("returns the statements of exactly the requested ranks in order, or nothing", () => {
    const index = incomeIndex(eightQuarters);
    const ranks = [
      fiscalQuarterRank(quarter(2024, "Q4")),
      fiscalQuarterRank(quarter(2025, "Q1")),
    ];

    expect(identities(statementsForFiscalQuarters(index, ranks))).toEqual([
      "2024-Q4",
      "2025-Q1",
    ]);
    expect(
      statementsForFiscalQuarters(index, [
        ...ranks,
        fiscalQuarterRank(quarter(2026, "Q1")),
      ]),
    ).toBeUndefined();
  });
});

describe("common cross-family windows", () => {
  const cashFlow = (each: Quarter) =>
    statement("CASH_FLOW", each, { operatingCashFlow: 10 }, "2026-01-05");

  it("anchors every family at the latest quarter they all hold", () => {
    const incomeRows = [...quartersOf(2025), quarter(2026, "Q1")].map((each) =>
      income(each),
    );
    const cashFlowRows = quartersOf(2025).map(cashFlow);
    const indexes = [
      incomeIndex(incomeRows),
      indexFiscalQuarters(cashFlowRows, "CASH_FLOW"),
    ];

    expect(latestCommonFiscalQuarterRank(indexes)).toBe(
      fiscalQuarterRank(quarter(2025, "Q4")),
    );
    const window = commonTrailingFiscalQuarterWindow(indexes, 4);
    expect(window?.statements.map(identities)).toEqual([
      ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4"],
      ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4"],
    ]);
  });

  it("is unavailable when any family lacks any quarter of the common window", () => {
    const incomeRows = quartersOf(2025).map((each) => income(each));
    const cashFlowRows = [
      quarter(2025, "Q1"),
      quarter(2025, "Q3"),
      quarter(2025, "Q4"),
    ].map(cashFlow);

    expect(
      commonTrailingFiscalQuarterWindow(
        [
          incomeIndex(incomeRows),
          indexFiscalQuarters(cashFlowRows, "CASH_FLOW"),
        ],
        4,
      ),
    ).toBeUndefined();
  });

  it("has no anchor without families or without a shared quarter", () => {
    expect(latestCommonFiscalQuarterRank([])).toBeUndefined();
    expect(
      latestCommonFiscalQuarterRank([
        incomeIndex([income(quarter(2025, "Q1"))]),
        indexFiscalQuarters([cashFlow(quarter(2025, "Q2"))], "CASH_FLOW"),
      ]),
    ).toBeUndefined();
  });
});

describe("aligned and latest states", () => {
  const balanceSheet = (each: Quarter, marker: number) =>
    statement("BALANCE_SHEET", each, { totalAssets: marker }, "2026-01-05");

  it("pairs the quarter before the window with the window's final quarter", () => {
    const index = indexFiscalQuarters(
      [
        balanceSheet(quarter(2024, "Q4"), 1),
        balanceSheet(quarter(2025, "Q2"), 2),
        balanceSheet(quarter(2025, "Q4"), 3),
        balanceSheet(quarter(2026, "Q1"), 4),
      ],
      "BALANCE_SHEET",
    );
    const states = alignedOpeningAndEndingStates(index, {
      endRank: fiscalQuarterRank(quarter(2025, "Q4")),
      count: 4,
    });

    // The newer FY2026 Q1 state is ignored; the interior quarters are not required.
    expect(states?.opening.values).toEqual({ totalAssets: 1 });
    expect(states?.ending.values).toEqual({ totalAssets: 3 });
  });

  it("is unavailable when the opening or the ending state is missing", () => {
    const window = {
      endRank: fiscalQuarterRank(quarter(2025, "Q4")),
      count: 4,
    };

    expect(
      alignedOpeningAndEndingStates(
        indexFiscalQuarters(
          [balanceSheet(quarter(2025, "Q4"), 3)],
          "BALANCE_SHEET",
        ),
        window,
      ),
    ).toBeUndefined();
    expect(
      alignedOpeningAndEndingStates(
        indexFiscalQuarters(
          [balanceSheet(quarter(2024, "Q4"), 1)],
          "BALANCE_SHEET",
        ),
        window,
      ),
    ).toBeUndefined();
  });

  it("takes the latest fiscal quarter as the latest state, not the latest filing", () => {
    const index = indexFiscalQuarters(
      [
        statement(
          "BALANCE_SHEET",
          quarter(2025, "Q4"),
          { totalAssets: 4 },
          "2026-02-01",
        ),
        // An older quarter restated much later is still an older state.
        statement(
          "BALANCE_SHEET",
          quarter(2025, "Q2"),
          { totalAssets: 2 },
          "2026-06-01",
        ),
      ],
      "BALANCE_SHEET",
    );

    expect(latestFiscalQuarterStatement(index)?.values).toEqual({
      totalAssets: 4,
    });
    expect(latestFiscalQuarterRank(new Map())).toBeUndefined();
    expect(latestFiscalQuarterStatement(new Map())).toBeUndefined();
  });
});

describe("windows over point-in-time selected revisions", () => {
  const history = [...quartersOf(2024), ...quartersOf(2025)].map((each) =>
    income(each, "2026-01-05"),
  );

  function windowAsOf(rows: readonly FinancialStatement[], asOf: string) {
    return trailingFiscalQuarterWindow(
      incomeIndex(selectFinancialStatements(rows, { asOf })),
      4,
    );
  }

  it("uses the revision eligible on the date, older or newer", () => {
    const revised = income(quarter(2025, "Q4"), "2026-03-02", {
      contentHash: "revised",
      values: { revenue: 150 },
    });
    const rows = [...history, revised];

    expect(windowAsOf(rows, "2026-03-01")?.statements.at(-1)?.values).toEqual({
      revenue: 100,
    });
    expect(windowAsOf(rows, "2026-03-02")?.statements.at(-1)?.values).toEqual({
      revenue: 150,
    });
  });

  it("does not see a stored revision or quarter that is not yet eligible", () => {
    const future = income(quarter(2026, "Q1"), "2026-05-01");
    const rows = [...history, future];

    expect(windowAsOf(rows, "2026-04-30")?.endRank).toBe(
      fiscalQuarterRank(quarter(2025, "Q4")),
    );
    expect(windowAsOf(rows, "2026-05-01")?.endRank).toBe(
      fiscalQuarterRank(quarter(2026, "Q1")),
    );
  });

  it("selects the same window from any ordering of the input", () => {
    const revised = income(quarter(2025, "Q2"), "2026-02-02", {
      contentHash: "revised-q2",
      values: { revenue: 120 },
    });
    const rows = [...history, revised];
    const expected = windowAsOf(rows, "2026-03-01");

    for (const seed of [3, 5, 8, 13]) {
      expect(windowAsOf(shuffled(rows, seed), "2026-03-01")).toEqual(expected);
    }
  });
});

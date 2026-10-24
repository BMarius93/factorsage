import type { LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  applyChangeLogCorrections,
  INDEX_CHANGE_LOG_CORRECTIONS,
  type IndexChangeLogCorrection,
} from "./change-log-corrections.js";
import type { StoredIndexChange } from "./ports.js";
import { membershipQualityReport } from "./quality.js";
import { reconstructIndexMembership } from "./reconstruction.js";

let sequence = 0;
function row(
  effectiveDate: string,
  added: [string, string] | null,
  removed: [string, string] | null,
): StoredIndexChange {
  sequence += 1;
  return {
    contentHash: `h${String(sequence).padStart(4, "0")}`,
    effectiveDate: effectiveDate as LocalDate,
    changeType: "replacement",
    addedTicker: added?.[0] ?? null,
    addedName: added?.[1] ?? null,
    removedTicker: removed?.[0] ?? null,
    removedName: removed?.[1] ?? null,
    reason: null,
    providerDateText: null,
  };
}

/**
 * The shape of the provider's Dow log around DowDuPont: DuPont replaced by DowDuPont, then
 * DowDuPont's removal recorded under its later ticker DD with no Dow Inc. addition, and Dow Inc.'s
 * own removal five years later.
 */
const DOW_LOG = [
  row("2017-09-01", ["DWDP", "DowDuPont"], ["DD", "Dupont De Nemours Inc"]),
  row("2019-04-02", null, ["DD", "Dupont De Nemours Inc"]),
  row("2024-11-08", ["SHW", "Sherwin-Williams"], ["DOW", "Dow Inc."]),
];
const CURRENT = [
  {
    symbol: "SHW",
    name: "Sherwin-Williams",
    cik: null,
    dateFirstAdded: "2024-11-08" as LocalDate,
  },
];

describe("change-log corrections", () => {
  it("replaces the provider's DowDuPont removal with the published Dow Inc. replacement", () => {
    const outcome = applyChangeLogCorrections("DOW30", DOW_LOG);
    expect(outcome.applied).toEqual(["DOW30:dow-inc-2019-04-02"]);
    expect(outcome.unmatched).toEqual([
      {
        id: "DOW30:travelers-group-1997-03-17",
        reason: "0 provider rows match 1998-10-08 +C --",
      },
    ]);
    expect(
      outcome.changes.map((change) => [
        change.effectiveDate,
        change.addedTicker,
        change.removedTicker,
      ]),
    ).toEqual([
      ["2017-09-01", "DWDP", "DD"],
      ["2019-04-02", "DOW", "DWDP"],
      ["2024-11-08", "SHW", "DOW"],
    ]);
  });

  it("turns two unmatched periods into confirmed ones, one line throughout", () => {
    const reconstruct = (changes: readonly StoredIndexChange[]) =>
      reconstructIndexMembership({
        current: CURRENT,
        changes,
        symbolChanges: [],
        asOf: "2026-10-24" as LocalDate,
      });
    const horizon = {
      floor: "2017-09-01" as LocalDate,
      asOf: "2026-10-24" as LocalDate,
    };
    const band = { min: 1, max: 1 };
    const raw = membershipQualityReport(
      reconstruct(DOW_LOG).constituents,
      horizon,
      undefined,
      band,
    );
    expect(raw.surpluses.length + raw.deficits.length).toBeGreaterThan(0);

    const corrected = reconstruct(
      applyChangeLogCorrections("DOW30", DOW_LOG).changes,
    );
    const report = membershipQualityReport(
      corrected.constituents,
      horizon,
      undefined,
      band,
    );
    // Nothing is held twice. An unconfirmed log date leaves one day between a removal and the
    // addition that replaces it (`additionStarts.deferred`); the List starts the addition on it.
    // SHW's addition is confirmed by the current list, so 2024-11-08 has no gap.
    expect(report.surpluses).toEqual([]);
    expect(report.deficits).toEqual([
      { from: "2017-09-01", to: "2017-09-01", minLines: 0, maxLines: 0 },
      { from: "2019-04-02", to: "2019-04-02", minLines: 0, maxLines: 0 },
    ]);
    const periods = corrected.constituents
      .filter(
        (constituent) =>
          constituent.ticker === "DWDP" || constituent.ticker === "DOW",
      )
      .map((constituent) => [
        constituent.ticker,
        constituent.periods.map((period) => period.quality),
      ]);
    expect(periods).toEqual(
      expect.arrayContaining([
        ["DWDP", ["CONFIRMED"]],
        ["DOW", ["CONFIRMED"]],
      ]),
    );
  });

  it("moves Travelers Group's addition to its published date", () => {
    const log = [
      row("1997-03-17", ["WMT", "Walmart Inc"], null),
      row("1998-10-08", ["C", "Citigroup Inc"], null),
    ];
    const outcome = applyChangeLogCorrections("DOW30", log);
    expect(outcome.applied).toContain("DOW30:travelers-group-1997-03-17");
    expect(
      outcome.changes
        .filter((change) => change.addedTicker === "C")
        .map((change) => change.effectiveDate),
    ).toEqual(["1997-03-17"]);
  });

  it("is refused, never half applied, when the provider already corrected its log", () => {
    const fixed = [
      row("2017-09-01", ["DWDP", "DowDuPont"], ["DD", "Dupont De Nemours Inc"]),
      row("2019-04-02", ["DOW", "Dow Inc."], ["DWDP", "DowDuPont"]),
      row("2019-04-02", null, ["DD", "Dupont De Nemours Inc"]),
    ];
    const outcome = applyChangeLogCorrections("DOW30", fixed);
    expect(outcome.applied).toEqual([]);
    expect(
      outcome.unmatched.find((entry) => entry.id === "DOW30:dow-inc-2019-04-02")
        ?.reason,
    ).toMatch(/already records/);
    expect(outcome.changes).toHaveLength(3);
  });

  it("is refused when the row it replaces is ambiguous, and applies to its own index only", () => {
    const correction: IndexChangeLogCorrection = {
      id: "TEST:ambiguous",
      indexKey: "NASDAQ100",
      replaces: [
        {
          effectiveDate: "2020-01-02" as LocalDate,
          addedTicker: "X",
          removedTicker: null,
        },
      ],
      rows: [],
      evidence: "test",
    };
    const log = [
      row("2020-01-02", ["X", "X"], null),
      row("2020-01-02", ["X", "X Corp"], null),
    ];
    expect(
      applyChangeLogCorrections("NASDAQ100", log, [correction]).unmatched,
    ).toEqual([
      {
        id: "TEST:ambiguous",
        reason: "2 provider rows match 2020-01-02 +X --",
      },
    ]);
    expect(applyChangeLogCorrections("SP500", DOW_LOG).applied).toEqual([]);
  });

  it("documents every correction", () => {
    for (const correction of INDEX_CHANGE_LOG_CORRECTIONS) {
      expect(correction.evidence.length).toBeGreaterThan(100);
      expect(correction.replaces.length).toBeGreaterThan(0);
    }
  });
});

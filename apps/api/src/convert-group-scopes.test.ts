import { describe, expect, it } from "vitest";
import type { GroupScopeConversionReport } from "./alternative-data/group-scope-conversion";
import {
  assertApplyConfirmed,
  databaseNameOf,
  describeReport,
  parseConvertArguments,
} from "./convert-group-scopes";

/**
 * The command's own guards.
 *
 * The conversion is exercised against PostgreSQL elsewhere; what is pinned here is what stands
 * between a person at a terminal and a write to the wrong database — the defaults, the confirmation,
 * and that nothing printed carries a connection string.
 */
describe("strategies:convert-group-scopes arguments", () => {
  it("is a dry run with no arguments", () => {
    expect(parseConvertArguments([])).toEqual({
      apply: false,
      includeMonitored: false,
      json: false,
      strategyIds: [],
    });
  });

  it("reads every flag, and each strategy once", () => {
    expect(
      parseConvertArguments([
        "--apply",
        "--confirm-database",
        "intrinsic_value",
        "--include-monitored",
        "--json",
        "--strategy",
        "s1",
        "--strategy",
        "s2",
        "--strategy",
        "s1",
      ]),
    ).toEqual({
      apply: true,
      includeMonitored: true,
      json: true,
      confirmDatabase: "intrinsic_value",
      strategyIds: ["s1", "s2"],
    });
  });

  it("refuses a flag it does not know rather than ignoring it", () => {
    expect(() => parseConvertArguments(["--aply"])).toThrow(/Unknown argument/);
    expect(() => parseConvertArguments(["--strategy"])).toThrow(/strategy id/);
    expect(() =>
      parseConvertArguments(["--confirm-database", "--apply"]),
    ).toThrow(/database's name/);
  });

  it("refuses --include-monitored on a dry run, where it would mean nothing", () => {
    expect(() => parseConvertArguments(["--include-monitored"])).toThrow(
      /only means something with --apply/,
    );
  });
});

describe("confirming the database before a write", () => {
  it("reads the database name and nothing else out of a connection string", () => {
    expect(
      databaseNameOf(
        "postgresql://user:secret@db.internal:5432/intrinsic_value?schema=public",
      ),
    ).toBe("intrinsic_value");
  });

  it("asks nothing of a dry run", () => {
    expect(() =>
      assertApplyConfirmed({ apply: false }, "intrinsic_value"),
    ).not.toThrow();
  });

  it("refuses to write until the database has been named", () => {
    expect(() =>
      assertApplyConfirmed({ apply: true }, "intrinsic_value"),
    ).toThrow(/--confirm-database intrinsic_value/);
  });

  it("refuses to write when the name given is not the database connected to", () => {
    expect(() =>
      assertApplyConfirmed(
        { apply: true, confirmDatabase: "intrinsic_value_staging" },
        "intrinsic_value",
      ),
    ).toThrow(/Nothing was changed/);
    expect(() =>
      assertApplyConfirmed(
        { apply: true, confirmDatabase: "intrinsic_value" },
        "intrinsic_value",
      ),
    ).not.toThrow();
  });
});

describe("the printed report", () => {
  const report: GroupScopeConversionReport = {
    mode: "DRY_RUN",
    strategiesScanned: 12,
    strategiesWithGroupScope: 2,
    convertible: 1,
    converted: 0,
    skipped: 1,
    skippedByReason: { GROUP_EMPTY: 1 },
    monitorsAffected: 1,
    statesReset: 30,
    activeSignalsClosed: 4,
    strategies: [
      {
        strategyId: "s1",
        name: "Follow the Hill",
        ownership: "USER",
        versionNumber: 3,
        outcome: "CONVERTIBLE",
        skipReasons: [],
        groups: [
          {
            groupId: "g1",
            name: "Leadership",
            memberCount: 5,
            status: "RESOLVED",
          },
        ],
        monitors: [
          {
            monitorId: "m1",
            name: "Hill watch",
            ownership: "USER",
            evaluated: true,
            levelsReset: 1,
            statesReset: 30,
            activeSignalsClosed: 4,
            pendingSetupsDropped: 0,
          },
        ],
      },
      {
        strategyId: "s2",
        name: "Being built",
        ownership: "USER",
        versionNumber: 1,
        outcome: "SKIPPED",
        skipReasons: ["GROUP_EMPTY"],
        groups: [
          { groupId: "g2", name: "Empty", memberCount: 0, status: "EMPTY" },
        ],
        monitors: [],
      },
    ],
  };

  it("says it changed nothing, what it would do, and what each Monitor would lose", () => {
    const text = describeReport(report, "intrinsic_value").join("\n");
    expect(text).toContain("DRY RUN, nothing was changed");
    expect(text).toContain("Database: intrinsic_value");
    expect(text).toContain("Would convert:                     1");
    expect(text).toContain("GROUP_EMPTY");
    expect(text).toContain(
      "1 level(s) reset, 30 state row(s), 4 active Signal(s) closed, 0 pending setup(s) dropped",
    );
    expect(text).toContain("--apply --confirm-database <name>");
  });

  it("reports an applied run as applied, with the version each strategy moved to", () => {
    const text = describeReport(
      {
        ...report,
        mode: "APPLY",
        convertible: 0,
        converted: 1,
        strategies: [
          {
            ...report.strategies[0]!,
            outcome: "CONVERTED",
            convertedVersionNumber: 4,
          },
        ],
      },
      "intrinsic_value",
    ).join("\n");
    expect(text).toContain("APPLIED");
    expect(text).toContain("Converted (new version appended):  1");
    expect(text).toContain("version 3 -> 4");
    expect(text).not.toContain("To convert:");
  });
});

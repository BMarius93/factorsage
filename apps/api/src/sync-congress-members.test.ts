import type {
  CongressMemberCatalogSyncState,
  CongressMemberCatalogSyncSummary,
} from "@intrinsic/stock-data";
import { describe, expect, it } from "vitest";
import {
  assertSyncTargetAllowed,
  databaseNameOf,
  describeResult,
  describeState,
  parseSyncMembersArguments,
  reportable,
} from "./sync-congress-members";

/**
 * The command's own guards and its report.
 *
 * The synchronization is exercised against PostgreSQL elsewhere; what is pinned here is what stands
 * between a person at a terminal and the wrong outcome — the defaults, the refusal of a fixture
 * database, and a report that says plainly what was and was not changed without carrying a
 * connection string.
 */
describe("data:congress-members:sync arguments", () => {
  it("synchronizes unconditionally with no arguments", () => {
    expect(parseSyncMembersArguments([])).toEqual({
      statusOnly: false,
      json: false,
    });
  });

  it("reads every flag", () => {
    expect(
      parseSyncMembersArguments(["--if-older-than-days", "7", "--json"]),
    ).toEqual({ statusOnly: false, json: true, ifOlderThanDays: 7 });
    expect(parseSyncMembersArguments(["--status"])).toEqual({
      statusOnly: true,
      json: false,
    });
  });

  it("refuses a flag it does not know rather than running anyway", () => {
    expect(() => parseSyncMembersArguments(["--staus"])).toThrow(
      /Unknown argument/,
    );
    expect(() => parseSyncMembersArguments(["now"])).toThrow(
      /Unknown argument/,
    );
  });

  it("refuses a freshness window that is not a positive number of days", () => {
    for (const value of [[], ["0"], ["-1"], ["soon"], ["--json"]]) {
      expect(() =>
        parseSyncMembersArguments(["--if-older-than-days", ...value]),
      ).toThrow(/positive number of days/);
    }
  });

  it("refuses a freshness window on a status read, where it would mean nothing", () => {
    expect(() =>
      parseSyncMembersArguments(["--status", "--if-older-than-days", "7"]),
    ).toThrow(/only means something for a run/);
  });
});

describe("the database a synchronization may write", () => {
  it("reads the database name and nothing else out of a connection string", () => {
    expect(
      databaseNameOf(
        "postgresql://user:secret@db.internal:5432/intrinsic_value?schema=public",
      ),
    ).toBe("intrinsic_value");
  });

  it("allows the development database and one named like production", () => {
    for (const name of [
      "intrinsic_value",
      "factorsage",
      "intrinsic_value_ci",
    ]) {
      expect(() =>
        assertSyncTargetAllowed(`postgresql://u:p@localhost:5432/${name}`),
      ).not.toThrow();
    }
  });

  it("refuses the fixture databases, and never echoes the connection string", () => {
    for (const name of ["intrinsic_value_test", "intrinsic_value_matrix"]) {
      let message = "";
      try {
        assertSyncTargetAllowed(
          `postgresql://user:hunter2@localhost:5432/${name}?schema=public`,
        );
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`Refusing to synchronize \`${name}\``);
      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("postgresql://");
    }
  });
});

const SUMMARY: CongressMemberCatalogSyncSummary = {
  providerRequests: 6,
  received: 1261,
  inOffice: 540,
  former: 721,
  created: 1040,
  updated: 217,
  relabelled: 0,
  unchanged: 0,
  declined: 4,
  declinedByReason: {
    MALFORMED_ID: 0,
    CONFLICTING_ROWS: 0,
    UNNAMED: 0,
    NO_CHAMBER: 4,
  },
  repeatedRows: 0,
  retained: 0,
};

describe("the printed report", () => {
  it("says what a complete run changed, and names every member it declined", () => {
    const text = describeResult({
      outcome: "COMPLETED",
      runSequence: 1,
      summary: SUMMARY,
      declined: [
        {
          externalId: "B000444",
          reason: "NO_CHAMBER",
          position: "President",
        },
      ],
    }).join("\n");
    expect(text).toContain("Synchronized (run 1), 6 provider request(s).");
    expect(text).toContain("1261 (540 in office, 721 former)");
    expect(text).toContain("Added to the catalog:  1040");
    expect(text).toContain("Updated:               217 (0 relabelled)");
    expect(text).toContain("NO_CHAMBER: 4");
    expect(text).toContain("declined B000444: NO_CHAMBER (President)");
    // A reason nothing was declined for is not printed as noise.
    expect(text).not.toContain("MALFORMED_ID");
  });

  it("says a failed run changed nothing and is safe to repeat", () => {
    const text = describeResult({
      outcome: "FAILED",
      runSequence: 2,
      code: "PROVIDER_UNAVAILABLE",
      message:
        "FmpTransientError (HTTP 503): Stock data provider is temporarily unavailable",
      providerRequests: 3,
      cause: new Error("apikey=super-secret"),
    }).join("\n");
    expect(text).toContain(
      "FAILED (PROVIDER_UNAVAILABLE) after 3 provider request(s).",
    );
    expect(text).toContain("The catalog is exactly as it was.");
    expect(text).not.toContain("super-secret");
  });

  it("leaves the original error out of a JSON report, and everything else in", () => {
    const failed = reportable({
      outcome: "FAILED",
      runSequence: 2,
      code: "PROVIDER_UNAVAILABLE",
      message: "FmpTransientError (HTTP 503)",
      providerRequests: 3,
      cause: new Error("apikey=super-secret"),
    });
    expect(failed).toEqual({
      outcome: "FAILED",
      runSequence: 2,
      code: "PROVIDER_UNAVAILABLE",
      message: "FmpTransientError (HTTP 503)",
      providerRequests: 3,
    });
    expect(JSON.stringify(failed)).not.toContain("super-secret");

    const completed = {
      outcome: "COMPLETED" as const,
      runSequence: 1,
      summary: SUMMARY,
      declined: [],
    };
    expect(reportable(completed)).toBe(completed);
  });

  it("says when the provider was not asked at all", () => {
    expect(
      describeResult({
        outcome: "UP_TO_DATE",
        lastCompletedAt: "2026-10-11T12:00:00.000Z",
      }).join("\n"),
    ).toContain("The provider was not asked.");
    expect(describeResult({ outcome: "ALREADY_RUNNING" }).join("\n")).toContain(
      "The provider was not asked; nothing was changed.",
    );
  });

  it("describes a catalog no run has ever filled as what it is", () => {
    const text = describeState(null, 217).join("\n");
    expect(text).toContain("Members in the catalog:        217");
    expect(text).toContain("Synchronized with the directory: never.");
    expect(text).toContain("only members a loaded disclosure named");
  });

  it("keeps the last complete run and a later failure apart", () => {
    const state: CongressMemberCatalogSyncState = {
      running: false,
      runSequence: 3,
      lastStartedAt: "2026-10-12T09:00:00.000Z",
      lastCompletedAt: "2026-10-11T12:00:00.000Z",
      lastFailedAt: "2026-10-12T09:00:01.000Z",
      consecutiveFailures: 1,
      lastError:
        "PROVIDER_UNAVAILABLE: FmpTransientError (HTTP 503): Stock data provider is temporarily unavailable",
      lastSummary: SUMMARY,
    };
    const text = describeState(state, 1257).join("\n");
    expect(text).toContain(
      "Synchronized with the directory: 2026-10-11T12:00:00.000Z",
    );
    expect(text).toContain(
      "Last failed run:               2026-10-12T09:00:01.000Z (1 in a row)",
    );
    expect(text).toContain(
      "Why:                           PROVIDER_UNAVAILABLE",
    );
    expect(text).toContain("1040 added, 217 updated, 4 declined");
  });

  it("says a failure was followed by a complete run", () => {
    const text = describeState(
      {
        running: false,
        runSequence: 2,
        lastStartedAt: null,
        lastCompletedAt: "2026-10-12T10:00:00.000Z",
        lastFailedAt: "2026-10-12T09:00:00.000Z",
        consecutiveFailures: 0,
        lastError: null,
        lastSummary: null,
      },
      3,
    ).join("\n");
    expect(text).toContain("(a later run completed)");
    expect(text).not.toContain("Why:");
  });
});

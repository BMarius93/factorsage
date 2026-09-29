import { describe, expect, it } from "vitest";
import {
  ORACLE_FUNDAMENTAL_METRICS,
  ORACLE_FUNDAMENTAL_UNAVAILABLE_REASONS,
} from "../oracle/fundamentals";
import { differentialAudit, type DifferentialReport } from "./differential";
import { AUDIT_HISTORY_PROFILES, generateHistory } from "./generated-history";

/**
 * The production materializer against the independent oracle on every trading day of eight seeded
 * histories — about a million metric-day comparisons (audit sections 11, 12 and 35).
 *
 * Each history spans thirty to thirty-five years of trading days with a different fiscal calendar
 * (December, September 52/53-week, January retailer labelled a year behind, June, March labelled a
 * year ahead, October) and a different mix of hostility: missing quarters, families that pause,
 * absent line items, losses, zero and negative denominators, restatements that invalidate and later
 * restore, moved period ends, two period ends delivered by one observation, weekend and holiday
 * availability, mixed and malformed currencies, exact cancellations and values beyond
 * `DECIMAL(20,8)`. The seeds are fixed, so every run compares the same histories.
 */

const reports: DifferentialReport[] = AUDIT_HISTORY_PROFILES.map((profile) =>
  differentialAudit(generateHistory(profile)),
);

describe("materializeDailyFundamentals against the independent oracle, every day of eight histories", () => {
  it.each(reports.map((report) => [report.history, report] as const))(
    "%s: every metric on every trading day agrees, availability exactly",
    (_name, report) => {
      expect(report.axisDefects).toEqual([]);
      expect(report.comparisons).toBe(report.tradingDays * 15);
      expect(report.sampleMismatches).toEqual([]);
      expect(report.mismatches).toBe(0);
      expect(report.available + report.unavailable).toBe(report.comparisons);
    },
  );

  it("compares hundreds of thousands of available readings and exercises every metric both ways", () => {
    const totals = reports.reduce(
      (sum, report) => ({
        comparisons: sum.comparisons + report.comparisons,
        available: sum.available + report.available,
        unavailable: sum.unavailable + report.unavailable,
      }),
      { comparisons: 0, available: 0, unavailable: 0 },
    );
    expect(totals.comparisons).toBeGreaterThan(900_000);
    expect(totals.available).toBeGreaterThan(500_000);
    expect(totals.unavailable).toBeGreaterThan(200_000);
    // An always-null column would agree with every unavailable reading and none of the others:
    // every metric must be compared available many times, and unavailable too.
    for (const metric of ORACLE_FUNDAMENTAL_METRICS) {
      const available = reports.reduce(
        (sum, report) => sum + report.byMetric[metric.id].available,
        0,
      );
      const unavailable = reports.reduce(
        (sum, report) => sum + report.byMetric[metric.id].unavailable,
        0,
      );
      expect(available, metric.id).toBeGreaterThan(10_000);
      expect(unavailable, metric.id).toBeGreaterThan(1_000);
    }
  });

  it("drives every way a metric becomes unavailable that a valid provider history can produce", () => {
    const reasons = new Set(
      reports.flatMap((report) => Object.keys(report.unavailableReasons)),
    );
    for (const reason of ORACLE_FUNDAMENTAL_UNAVAILABLE_REASONS) {
      if (
        reason === "NON_FINITE_INTERMEDIATE" ||
        reason === "NO_BALANCE_SHEET" ||
        reason === "NO_QUARTERLY_STATEMENT"
      ) {
        // Sums beyond 1.8e308 and securities with no quarterly statement at all are covered by the
        // targeted suite (`edge-matrix.test.ts`), not by a long history.
        continue;
      }
      expect(reasons, reason).toContain(reason);
    }
  });

  it("gives the same answer without the oracle's per-eligible-set memo", () => {
    const history = generateHistory(AUDIT_HISTORY_PROFILES[5]!);
    const direct = differentialAudit(history, { memoize: false });
    const memoized = reports[5]!;
    expect(direct.mismatches).toBe(0);
    expect(direct.oracleEvaluations).toBe(direct.tradingDays);
    expect({ ...direct, oracleEvaluations: 0 }).toEqual({
      ...memoized,
      oracleEvaluations: 0,
    });
  });

  it("is reproducible: a seed names exactly one history", () => {
    const profile = AUDIT_HISTORY_PROFILES[1]!;
    expect(JSON.stringify(generateHistory(profile))).toBe(
      JSON.stringify(generateHistory(profile)),
    );
  });
});

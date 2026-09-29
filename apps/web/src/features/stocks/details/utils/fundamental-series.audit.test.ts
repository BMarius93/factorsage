import {
  FUNDAMENTAL_METRIC_GROUPED,
  type DailyFundamentalMetricResponse,
  type FundamentalMetricId,
} from "@intrinsic/contracts";
import {
  FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED,
  FUNDAMENTAL_AUDIT_DRIFT_MESSAGE,
  FUNDAMENTAL_AUDIT_METRICS,
  fundamentalAuditAnchorExpected,
  fundamentalAuditAnchorSessions,
} from "@intrinsic/testing/fundamental-audit";
import { describe, expect, it } from "vitest";
import {
  buildFundamentalSeries,
  fundamentalRuns,
  fundamentalSteps,
} from "./fundamental-series";

/**
 * The chart's preparation of a Fundamental Metric, held to the audit's one persisted truth.
 *
 * `FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED` is the table every server layer is held to on every session —
 * PostgreSQL, Redis, the Strategy frame, the Monitor frame and the Stock Details API
 * (`apps/api/src/data-correctness-audit/fundamentals/anchor-parity.integration.test.ts`). Here the
 * API's rows are built from that same table in the contract's exact shape, and what the chart hands
 * to `series.setData` — one step series per stretch — must reproduce it on the price chart's own
 * session axis: the same number on every drawn session, nothing inside an unavailable interval, zero
 * and negative readings drawn, and no session the price chart does not carry.
 */

const SESSIONS = fundamentalAuditAnchorSessions();

/** What `GET /stocks/:symbol/fundamentals/daily` returns for the anchor: value omitted when absent. */
function apiRows(metricId: string): DailyFundamentalMetricResponse[] {
  return SESSIONS.map((date) => {
    const stored = fundamentalAuditAnchorExpected(metricId as never, date);
    return stored === null ? { date } : { date, value: Number(stored) };
  });
}

describe("the chart draws exactly the persisted value, session for session (audit sections 23-25)", () => {
  it("offers exactly the audited metrics in the picker, none unknown to the audit", () => {
    const offered = FUNDAMENTAL_METRIC_GROUPED.flatMap((group) =>
      group.metrics.map((metric) => metric.id),
    );
    expect([...offered].sort(), FUNDAMENTAL_AUDIT_DRIFT_MESSAGE).toEqual(
      FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.id).sort(),
    );
  });

  it.each(FUNDAMENTAL_AUDIT_METRICS.map((metric) => metric.id))(
    "%s: every drawn point is the persisted value, and every unavailable session is a gap",
    (metricId) => {
      const series = buildFundamentalSeries(
        metricId as FundamentalMetricId,
        apiRows(metricId),
        SESSIONS,
      );
      expect(series).toBeDefined();
      const runs = fundamentalRuns(series!.points);
      const drawn = new Map<string, number>();
      for (const run of runs) {
        for (const point of run) {
          expect(drawn.has(point.date), `${point.date} drawn twice`).toBe(
            false,
          );
          drawn.set(point.date, point.value);
        }
      }
      for (const session of SESSIONS) {
        const stored = fundamentalAuditAnchorExpected(
          metricId as never,
          session,
        );
        if (stored === null) {
          expect(
            drawn.has(session),
            `${metricId} ${session} must be a gap`,
          ).toBe(false);
          expect(
            series!.readings.get(session),
            `${metricId} ${session}`,
          ).toBeUndefined();
        } else {
          expect(
            Object.is(drawn.get(session), Number(stored)),
            `${metricId} ${session}: ${drawn.get(session)}`,
          ).toBe(true);
          expect(series!.readings.get(session)).toBe(Number(stored));
        }
      }
      // One step series per available stretch: a gap always ends a run, so no line bridges it.
      const stretches =
        FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED[
          metricId as keyof typeof FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED
        ];
      let expectedRuns = 0;
      let open = false;
      for (const [, stored] of stretches) {
        if (stored !== null && !open) {
          expectedRuns += 1;
        }
        open = stored !== null;
      }
      expect(runs.length).toBe(expectedRuns);
      for (const run of runs) {
        const first = SESSIONS.indexOf(run[0]!.date);
        run.forEach((point, offset) =>
          expect(point.date).toBe(SESSIONS[first + offset]),
        );
      }
    },
  );

  it("publishes a step contract that names every transition of the table, gaps included", () => {
    for (const metric of FUNDAMENTAL_AUDIT_METRICS) {
      const series = buildFundamentalSeries(
        metric.id as FundamentalMetricId,
        apiRows(metric.id),
        SESSIONS,
      )!;
      const expected: string[] = [];
      let previous: string | null | undefined = undefined;
      for (const [from, stored] of FUNDAMENTAL_AUDIT_ANCHOR_EXPECTED[
        metric.id
      ]) {
        if (stored !== previous) {
          expected.push(`${from}=${stored === null ? "" : Number(stored)}`);
          previous = stored;
        }
      }
      expect(fundamentalSteps(series.points), metric.id).toBe(
        expected.join(";"),
      );
    }
  });

  it("draws a real zero and a negative reading as values", () => {
    const growth = buildFundamentalSeries(
      "REVENUE_GROWTH_TTM_YOY",
      apiRows("REVENUE_GROWTH_TTM_YOY"),
      SESSIONS,
    )!;
    expect(
      growth.points.find((point) => point.date === "2023-01-03")?.value,
    ).toBe(0);
    expect(
      growth.points.find((point) => point.date === "2024-02-09")?.value,
    ).toBe(-9.09090909);
    const leverage = buildFundamentalSeries(
      "NET_DEBT_TO_EBITDA_TTM",
      apiRows("NET_DEBT_TO_EBITDA_TTM"),
      SESSIONS,
    )!;
    expect(
      leverage.points.find((point) => point.date === "2024-10-15")?.value,
    ).toBe(0);
    expect(
      leverage.points.find((point) => point.date === "2023-07-05")?.value,
    ).toBe(-0.33333333);
  });

  it("never draws a weekend, a holiday or a session the price chart does not carry", () => {
    const rows = [
      ...apiRows("ROIC_TTM"),
      // A Saturday, the 2024-07-04 holiday, and a session newer than the chart's last bar.
      { date: "2024-08-03", value: 99 },
      { date: "2024-07-04", value: 98 },
      { date: "2026-01-02", value: 97 },
    ].sort((left, right) => left.date.localeCompare(right.date));
    const series = buildFundamentalSeries("ROIC_TTM", rows, SESSIONS)!;
    const drawnDates = fundamentalRuns(series.points)
      .flat()
      .map((point) => point.date);
    for (const offAxis of ["2024-08-03", "2024-07-04", "2026-01-02"]) {
      expect(drawnDates).not.toContain(offAxis);
      expect(series.readings.has(offAxis)).toBe(false);
    }
    expect(drawnDates.every((date) => SESSIONS.includes(date))).toBe(true);
  });

  it("never carries a value into a session the API left without one", () => {
    // The history thinned to every tenth session: the sessions between are unknown to the chart,
    // and must stay gaps rather than inherit the previous reading.
    const sparse = apiRows("DEBT_TO_EQUITY").filter(
      (_row, index) => index % 10 === 0,
    );
    const series = buildFundamentalSeries("DEBT_TO_EQUITY", sparse, SESSIONS)!;
    const drawn = new Set(
      fundamentalRuns(series.points)
        .flat()
        .map((point) => point.date),
    );
    for (const row of apiRows("DEBT_TO_EQUITY")) {
      if (!sparse.some((kept) => kept.date === row.date)) {
        expect(drawn.has(row.date), row.date).toBe(false);
      }
    }
  });
});

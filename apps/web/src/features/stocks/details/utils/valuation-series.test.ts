import {
  VALUATION_RATIO_CATALOG,
  type DailyValuationRatioResponse,
  type ValuationRatioId,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { CHART_COLORS } from "./chart-theme";
import { sessionLineRuns, sessionLineStretches } from "./session-line";
import { buildValuationSeries } from "./valuation-series";

/** Ten consecutive trading days, the price chart's session axis for these cases. */
const SESSIONS = [
  "2026-08-17",
  "2026-08-18",
  "2026-08-19",
  "2026-08-20",
  "2026-08-21",
  "2026-08-24",
  "2026-08-25",
  "2026-08-26",
  "2026-08-27",
  "2026-08-28",
];

/** One row per session from a list of readings, `undefined` for an unavailable session. */
function rows(
  values: readonly (number | undefined)[],
): DailyValuationRatioResponse[] {
  return values.map((value, index) => {
    const date = SESSIONS[index] as string;
    return value === undefined ? { date } : { date, value };
  });
}

function series(
  values: readonly (number | undefined)[],
  ratioId: ValuationRatioId = "PRICE_TO_EARNINGS_TTM",
) {
  const built = buildValuationSeries(ratioId, rows(values), SESSIONS);
  if (!built) {
    throw new Error(`${ratioId} is not in the catalog`);
  }
  return built;
}

describe("buildValuationSeries", () => {
  it("draws an ordinary daily line: a reading on every session, in one stretch", () => {
    const daily = [18.2, 18.5, 18.1, 18.9, 19.3, 19, 18.7, 18.8, 19.4, 19.6];
    const built = series(daily);
    expect(built.points).toEqual(rows(daily));
    const runs = sessionLineRuns(built.points);
    expect(runs).toHaveLength(1);
    // Every session's own reading: the line moves with the close, never held flat.
    expect(runs[0]?.map((point) => point.value)).toEqual(daily);
    expect(sessionLineStretches(runs)).toBe("2026-08-17..2026-08-28");
  });

  it("breaks the line at one unavailable interval, never joining across it", () => {
    const built = series([
      18.2,
      18.5,
      18.1,
      undefined,
      undefined,
      19,
      18.7,
      18.8,
      19.4,
      19.6,
    ]);
    // The unavailable sessions stay on the axis as whitespace: no value, never zero, never carried.
    expect(built.points[3]).toEqual({ date: "2026-08-20" });
    expect(built.points[4]).toEqual({ date: "2026-08-21" });
    const runs = sessionLineRuns(built.points);
    expect(runs.map((run) => run.map((point) => point.date))).toEqual([
      ["2026-08-17", "2026-08-18", "2026-08-19"],
      ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"],
    ]);
    // No stretch reaches into the gap, so no segment can bridge it.
    for (const run of runs) {
      expect(
        run.some(
          (point) => point.date === "2026-08-20" || point.date === "2026-08-21",
        ),
      ).toBe(false);
    }
    expect(sessionLineStretches(runs)).toBe(
      "2026-08-17..2026-08-19;2026-08-24..2026-08-28",
    );
  });

  it("breaks the line at every unavailable interval", () => {
    const built = series([
      12,
      undefined,
      13,
      13.5,
      undefined,
      undefined,
      14,
      undefined,
      15,
      15.5,
    ]);
    const runs = sessionLineRuns(built.points);
    expect(sessionLineStretches(runs)).toBe(
      "2026-08-17..2026-08-17;2026-08-19..2026-08-20;2026-08-25..2026-08-25;2026-08-27..2026-08-28",
    );
    expect(
      built.points.filter((point) => point.value === undefined),
    ).toHaveLength(4);
  });

  it("draws a single available session as a stretch of its own", () => {
    const built = series([
      undefined,
      undefined,
      undefined,
      undefined,
      21.5,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // Nothing is drawn before the first reading or after the last one.
    expect(built.points).toEqual([{ date: "2026-08-21", value: 21.5 }]);
    expect(sessionLineRuns(built.points)).toEqual([
      [{ date: "2026-08-21", value: 21.5 }],
    ]);
  });

  it("keeps zero, negative, tiny and very large readings as readings", () => {
    const readings = [
      0, -1.25, -55.55, 0.004, 0.75, 1, 999_999_999_999.99, 15.2, 15, 1e-8,
    ];
    const built = series(readings, "EV_TO_EBITDA_TTM");
    expect(built.points.map((point) => point.value)).toEqual(readings);
    expect(sessionLineRuns(built.points)).toHaveLength(1);
    expect(built.readings.get("2026-08-17")).toBe(0);
    expect(built.readings.get("2026-08-18")).toBe(-1.25);
  });

  it("draws nothing for a ratio unavailable on every loaded session, and says so per session", () => {
    const built = series(new Array(SESSIONS.length).fill(undefined));
    expect(built.points).toEqual([]);
    expect(sessionLineRuns(built.points)).toEqual([]);
    expect(sessionLineStretches([])).toBe("");
    // The legend still knows every loaded session is unavailable, rather than unloaded.
    expect([...built.readings.keys()]).toEqual(SESSIONS);
    expect(
      [...built.readings.values()].every((value) => value === undefined),
    ).toBe(true);
  });

  it("draws only on the price chart's sessions: a returned session it lacks is neither drawn nor read", () => {
    const answered: DailyValuationRatioResponse[] = [
      ...rows([18.2, 18.5]),
      // A newer bar a later freshness check could have produced, which the chart does not hold.
      { date: "2026-08-31", value: 30 },
    ];
    const built = buildValuationSeries(
      "PRICE_TO_SALES_TTM",
      answered,
      SESSIONS.slice(0, 2),
    )!;
    expect(built.points.map((point) => point.date)).toEqual([
      "2026-08-17",
      "2026-08-18",
    ]);
    expect(built.readings.has("2026-08-31")).toBe(false);
  });

  it("names every ratio by its one catalog label and draws it in the valuation colour", () => {
    // Written out by hand: a sixth catalog ratio is a deliberate change to Stock Details too.
    expect(VALUATION_RATIO_CATALOG.map((entry) => entry.id)).toEqual([
      "PRICE_TO_EARNINGS_TTM",
      "PRICE_TO_SALES_TTM",
      "PRICE_TO_BOOK",
      "PRICE_TO_FCF_TTM",
      "EV_TO_EBITDA_TTM",
    ]);
    for (const entry of VALUATION_RATIO_CATALOG) {
      const built = series([5], entry.id);
      expect(built.id).toBe(entry.id);
      expect(built.label).toBe(entry.label);
      expect(built.color).toBe(CHART_COLORS.valuation);
    }
    // Never the fundamental's colour: the two lower panes read apart in the legend.
    expect(CHART_COLORS.valuation).not.toBe(CHART_COLORS.fundamental);
    expect(CHART_COLORS.valuation).not.toBe(CHART_COLORS.price);
  });

  it("draws no line under a guessed label for an identity the catalog does not define", () => {
    expect(
      buildValuationSeries("P/E" as ValuationRatioId, rows([5]), SESSIONS),
    ).toBeUndefined();
  });
});

import {
  FUNDAMENTAL_METRIC_CATALOG,
  FUNDAMENTAL_METRIC_IDS,
  type FundamentalMetricId,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { CHART_COLORS } from "./chart-theme";
import { formatFundamentalValue } from "./format";
import {
  buildFundamentalSeries,
  FUNDAMENTAL_GROUPS,
  fundamentalLinePoints,
  fundamentalRuns,
  fundamentalSteps,
} from "./fundamental-series";

/**
 * A metric's sessions as the API returns them: 12 on its first eligible session, 18 from a later
 * statement event, unavailable across an invalidating revision, and 21 once a later statement
 * restores it. Carried-forward sessions repeat the value, because the backend materialized them
 * that way.
 */
const HISTORY = [
  { date: "2024-02-08" },
  { date: "2024-02-09" },
  { date: "2024-02-12", value: 12 },
  { date: "2024-02-13", value: 12 },
  { date: "2024-05-10", value: 18 },
  { date: "2024-05-13", value: 18 },
  { date: "2024-08-19" },
  { date: "2024-08-20" },
  { date: "2024-11-05", value: 21 },
  { date: "2024-11-06", value: 21 },
  { date: "2024-11-07" },
];

/** The price chart's session axis for `HISTORY`: the same sessions, as the close series carries them. */
const SESSIONS = HISTORY.map((row) => row.date);

const dates = (rows: readonly { date: string }[]) =>
  rows.map((row) => row.date);

describe("fundamentalLinePoints", () => {
  it("keeps every session between the first and last value, unavailable ones as whitespace", () => {
    expect(fundamentalLinePoints(HISTORY, SESSIONS)).toEqual([
      { date: "2024-02-12", value: 12 },
      { date: "2024-02-13", value: 12 },
      { date: "2024-05-10", value: 18 },
      { date: "2024-05-13", value: 18 },
      { date: "2024-08-19" },
      { date: "2024-08-20" },
      { date: "2024-11-05", value: 21 },
      { date: "2024-11-06", value: 21 },
    ]);
  });

  it("never carries the last value through an unavailable interval", () => {
    const points = fundamentalLinePoints(HISTORY, SESSIONS);
    for (const date of ["2024-08-19", "2024-08-20"]) {
      const point = points.find((candidate) => candidate.date === date);
      expect(point).toEqual({ date });
      expect(Object.hasOwn(point as object, "value")).toBe(false);
    }
  });

  it("keeps a real zero and negative readings as values, never as gaps", () => {
    const rows = [
      { date: "2024-01-02", value: 0 },
      { date: "2024-01-03", value: -5 },
      { date: "2024-01-04", value: -0.4 },
    ];
    expect(fundamentalLinePoints(rows, dates(rows))).toEqual([
      { date: "2024-01-02", value: 0 },
      { date: "2024-01-03", value: -5 },
      { date: "2024-01-04", value: -0.4 },
    ]);
  });

  it("draws nothing for a history with no value at all", () => {
    const rows = [{ date: "2024-01-02" }, { date: "2024-01-03" }];
    expect(fundamentalLinePoints(rows, dates(rows))).toEqual([]);
    expect(fundamentalLinePoints([], [])).toEqual([]);
    expect(fundamentalLinePoints([], SESSIONS)).toEqual([]);
  });

  it("draws only on the price chart's sessions, never on one the price series does not carry", () => {
    // A newer session the backend answered for after the page loaded its prices, and a session
    // off the calendar entirely: neither may add a bar to the shared time scale.
    const rows = [
      ...HISTORY,
      { date: "2024-11-08", value: 21 },
      { date: "2024-11-09", value: 22 },
    ];
    const points = fundamentalLinePoints(rows, SESSIONS);
    expect(points.at(-1)).toEqual({ date: "2024-11-06", value: 21 });
    expect(dates(points).every((date) => SESSIONS.includes(date))).toBe(true);
    expect(fundamentalSteps(points)).toBe(
      "2024-02-12=12;2024-05-10=18;2024-08-19=;2024-11-05=21",
    );
  });

  it("leaves a price session the metric has no row for as a gap, never a carried value", () => {
    // The line stays on the price axis: a session the metric's history is silent about is not the
    // metric being unchanged, so it breaks the line rather than repeating the value before it.
    const sessions = [...SESSIONS, "2024-05-14"].sort();
    const points = fundamentalLinePoints(HISTORY, sessions);
    expect(points.find((point) => point.date === "2024-05-14")).toEqual({
      date: "2024-05-14",
    });
    expect(fundamentalSteps(points)).toBe(
      "2024-02-12=12;2024-05-10=18;2024-05-14=;2024-11-05=21",
    );
  });
});

describe("fundamentalRuns", () => {
  it("splits the line into its stretches of available sessions, so no gap is ever bridged", () => {
    expect(fundamentalRuns(fundamentalLinePoints(HISTORY, SESSIONS))).toEqual([
      [
        { date: "2024-02-12", value: 12 },
        { date: "2024-02-13", value: 12 },
        { date: "2024-05-10", value: 18 },
        { date: "2024-05-13", value: 18 },
      ],
      [
        { date: "2024-11-05", value: 21 },
        { date: "2024-11-06", value: 21 },
      ],
    ]);
  });

  it("keeps a single isolated session as a stretch of its own", () => {
    expect(
      fundamentalRuns([
        { date: "2024-01-02", value: 3 },
        { date: "2024-01-03" },
        { date: "2024-01-04", value: 4 },
      ]),
    ).toEqual([
      [{ date: "2024-01-02", value: 3 }],
      [{ date: "2024-01-04", value: 4 }],
    ]);
  });
});

describe("fundamentalSteps", () => {
  it("names the first eligible session, every step, every gap and every restoration", () => {
    expect(fundamentalSteps(fundamentalLinePoints(HISTORY, SESSIONS))).toBe(
      "2024-02-12=12;2024-05-10=18;2024-08-19=;2024-11-05=21",
    );
  });

  it("marks no transition where a carried value merely repeats", () => {
    expect(
      fundamentalSteps([
        { date: "2024-01-02", value: 0.75 },
        { date: "2024-01-03", value: 0.75 },
        { date: "2024-01-04", value: 0.75 },
      ]),
    ).toBe("2024-01-02=0.75");
  });
});

describe("buildFundamentalSeries", () => {
  it("draws every catalog metric under its own identity, label and unit", () => {
    // Exhaustive over the catalog, whose entries are the oracle for identity, label and unit: this
    // proves the adapter reads them from the catalog rather than from a copy of its own.
    expect(FUNDAMENTAL_METRIC_CATALOG.map((entry) => entry.id)).toEqual([
      ...FUNDAMENTAL_METRIC_IDS,
    ]);
    for (const entry of FUNDAMENTAL_METRIC_CATALOG) {
      const series = buildFundamentalSeries(
        entry.id,
        [{ date: "2024-01-02", value: 1.5 }],
        ["2024-01-02"],
      );
      expect(series, entry.id).toMatchObject({
        id: entry.id,
        label: entry.label,
        unit: entry.unit,
        color: CHART_COLORS.fundamental,
      });
      // The unit decides the reading: a percentage never reads `x`, a multiple never reads `%`.
      const reading = formatFundamentalValue(1.5, series!.unit);
      expect(reading, entry.id).toBe(
        entry.unit === "PERCENT" ? "1.5%" : "1.5x",
      );
    }
  });

  it("keeps every loaded session readable for the legend, unavailable ones included", () => {
    const series = buildFundamentalSeries("ROIC_TTM", HISTORY, SESSIONS);
    expect(series?.readings.size).toBe(HISTORY.length);
    expect(series?.readings.get("2024-02-08")).toBeUndefined();
    expect(series?.readings.has("2024-02-08")).toBe(true);
    expect(series?.readings.get("2024-05-10")).toBe(18);
    expect(series?.readings.has("2024-08-19")).toBe(true);
    expect(series?.readings.get("2024-08-19")).toBeUndefined();
    // A date that was never loaded is not a session the metric was unavailable on.
    expect(series?.readings.has("2024-01-02")).toBe(false);
  });

  it("reads nothing for a session the price chart does not carry", () => {
    const series = buildFundamentalSeries(
      "ROIC_TTM",
      [...HISTORY, { date: "2024-11-08", value: 21 }],
      SESSIONS,
    );
    expect(series?.readings.has("2024-11-08")).toBe(false);
    expect(series?.readings.size).toBe(HISTORY.length);
  });

  it("draws nothing under a guessed label for an identity the catalog does not define", () => {
    expect(
      buildFundamentalSeries(
        "roicTtm" as FundamentalMetricId,
        HISTORY,
        SESSIONS,
      ),
    ).toBeUndefined();
  });
});

describe("FUNDAMENTAL_GROUPS", () => {
  it("offers every catalog metric exactly once, in the catalog's own grouping", () => {
    const offered = FUNDAMENTAL_GROUPS.flatMap((group) =>
      group.metrics.map((metric) => metric.id),
    );
    expect(offered).toHaveLength(FUNDAMENTAL_METRIC_IDS.length);
    expect(new Set(offered)).toEqual(new Set(FUNDAMENTAL_METRIC_IDS));
    expect(FUNDAMENTAL_GROUPS.map((group) => group.label)).toEqual([
      "Growth",
      "Profitability",
      "Quality",
      "Leverage",
      "Liquidity",
      "Solvency",
      "Efficiency",
    ]);
  });
});

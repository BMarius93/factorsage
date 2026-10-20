import {
  MARKET_OVERVIEW_PERIODS,
  MARKET_OVERVIEW_SPARKLINE_MAX_POINTS,
} from "@intrinsic/contracts";
import { tradingSessionCloseInstant } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  buildPeriodSparkline,
  classifyInstruments,
  computeInstrumentPerformance,
  marketOverviewReadRange,
  periodAnchorDate,
  thinSessions,
  unavailableInstrument,
  type OverviewBar,
} from "./market-overview";

/**
 * The market overview's arithmetic, with no database, cache or clock in sight.
 *
 * Everything here is a rule that would be invisible if it were wrong: a return measured from the
 * wrong session still looks like a return, and a provisional close still looks like a close.
 */

const DELAY_MS = 30 * 60_000;

/** Long after every session in these fixtures closed. */
const LATER = new Date("2030-01-01T00:00:00.000Z");

/** Every weekday from `from` through `to`, except `holidays`, with `close(index, date)`. */
function weekdays(
  from: string,
  to: string,
  close: (index: number, date: string) => number = (index) => 100 + index,
  holidays: readonly string[] = [],
): OverviewBar[] {
  const bars: OverviewBar[] = [];
  const cursor = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.includes(date)) {
      bars.push({ date, close: close(bars.length, date) });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return bars;
}

function perform(
  bars: readonly OverviewBar[],
  options: {
    missing?: { from: string; to: string }[];
    now?: Date;
    lastTailSyncAt?: string;
  } = {},
) {
  return computeInstrumentPerformance({
    bars,
    missing: options.missing ?? [],
    now: options.now ?? LATER,
    publicationDelayMs: DELAY_MS,
    ...(options.lastTailSyncAt
      ? { lastTailSyncAt: options.lastTailSyncAt }
      : {}),
  });
}

function closeOn(bars: readonly OverviewBar[], date: string): number {
  const bar = bars.find((candidate) => candidate.date === date);
  if (!bar) {
    throw new Error(`no bar on ${date}`);
  }
  return bar.close;
}

describe("periodAnchorDate", () => {
  it("anchors each period by calendar arithmetic from the session", () => {
    expect(
      MARKET_OVERVIEW_PERIODS.map((period) => [
        period,
        periodAnchorDate(period, "2026-10-09"),
      ]),
    ).toEqual([
      ["1W", "2026-10-02"],
      ["1M", "2026-09-09"],
      ["3M", "2026-07-09"],
      ["6M", "2026-04-09"],
      ["YTD", "2025-12-31"],
      ["1Y", "2025-10-09"],
    ]);
  });

  it("clamps month ends rather than rolling into the next month", () => {
    expect(periodAnchorDate("1M", "2026-03-31")).toBe("2026-02-28");
    expect(periodAnchorDate("3M", "2026-05-31")).toBe("2026-02-28");
    expect(periodAnchorDate("6M", "2026-08-31")).toBe("2026-02-28");
    expect(periodAnchorDate("1M", "2026-07-31")).toBe("2026-06-30");
  });

  it("handles leap years in both directions", () => {
    expect(periodAnchorDate("1M", "2024-03-31")).toBe("2024-02-29");
    expect(periodAnchorDate("1Y", "2024-02-29")).toBe("2023-02-28");
    expect(periodAnchorDate("1Y", "2025-02-28")).toBe("2024-02-28");
    expect(periodAnchorDate("1W", "2024-03-04")).toBe("2024-02-26");
  });

  it("anchors YTD at the end of the previous year, even in January", () => {
    expect(periodAnchorDate("YTD", "2026-01-02")).toBe("2025-12-31");
    expect(periodAnchorDate("YTD", "2026-12-31")).toBe("2025-12-31");
  });
});

describe("marketOverviewReadRange", () => {
  it("reaches past the 1Y anchor and ends today", () => {
    expect(marketOverviewReadRange("2026-10-11")).toEqual({
      from: "2025-08-27",
      to: "2026-10-11",
    });
  });
});

describe("computeInstrumentPerformance", () => {
  it("measures every period from the most recent session on or before its anchor", () => {
    const bars = weekdays("2025-09-01", "2026-10-09");
    const result = perform(bars);

    expect(result.sessionDate).toBe("2026-10-09");
    // 2026-10-02 is a Friday, 2026-09-09 a Wednesday, 2026-07-09 a Thursday, 2026-04-09 a Thursday,
    // 2025-12-31 a Wednesday and 2025-10-09 a Thursday: every anchor is itself a session.
    expect(result.anchors).toEqual({
      "1W": "2026-10-02",
      "1M": "2026-09-09",
      "3M": "2026-07-09",
      "6M": "2026-04-09",
      YTD: "2025-12-31",
      "1Y": "2025-10-09",
    });
    const latest = closeOn(bars, "2026-10-09");
    for (const period of MARKET_OVERVIEW_PERIODS) {
      const anchor = closeOn(bars, result.anchors[period] as string);
      expect(result.returns[period]).toBe((latest / anchor - 1) * 100);
    }
  });

  it("keeps full precision: rounding is the display's decision", () => {
    const bars: OverviewBar[] = [
      { date: "2026-10-02", close: 3 },
      { date: "2026-10-09", close: 3.1 },
    ];
    const result = perform(bars);

    expect(result.returns["1W"]).toBe((3.1 / 3 - 1) * 100);
    expect(result.returns["1W"]).not.toBe(3.33);
  });

  it("uses the Friday before a weekend anchor, never the Monday after it", () => {
    // Latest Monday 2026-10-12: 1W anchors Monday 2026-10-05, 1M anchors Saturday 2026-09-12.
    const bars = weekdays("2026-08-03", "2026-10-12");
    const result = perform(bars);

    expect(result.anchors["1M"]).toBe("2026-09-11");
    expect(result.returns["1M"]).toBe(
      (closeOn(bars, "2026-10-12") / closeOn(bars, "2026-09-11") - 1) * 100,
    );
  });

  it("uses the session before an exchange holiday", () => {
    // Friday 2026-07-03 is the observed Independence Day holiday. From Monday 2026-10-05, 3M
    // anchors Sunday 2026-07-05: the closed Friday is skipped, never given an invented close.
    const bars = weekdays("2026-06-01", "2026-10-05", undefined, [
      "2026-07-03",
    ]);
    const result = perform(bars);

    expect(result.sessionDate).toBe("2026-10-05");
    expect(result.anchors["3M"]).toBe("2026-07-02");
  });

  it("anchors YTD at the last session of the previous year when 31 December is a weekend", () => {
    // 2022-12-31 was a Saturday; 2022-12-30 the last session of 2022.
    const bars = weekdays("2022-12-01", "2023-01-20", undefined, [
      "2023-01-02",
    ]);
    const result = perform(bars);

    expect(result.anchors.YTD).toBe("2022-12-30");
    expect(result.returns.YTD).toBe(
      (closeOn(bars, "2023-01-20") / closeOn(bars, "2022-12-30") - 1) * 100,
    );
  });

  it("measures YTD from the previous year's final close on the first session of a year", () => {
    const bars = weekdays("2025-12-01", "2026-01-02", undefined, [
      "2026-01-01",
    ]);
    const result = perform(bars);

    expect(result.sessionDate).toBe("2026-01-02");
    expect(result.anchors.YTD).toBe("2025-12-31");
  });

  it("measures 1Y from 28 February when the latest session is 29 February", () => {
    const bars = weekdays("2023-01-02", "2024-02-29");
    const result = perform(bars);

    expect(result.sessionDate).toBe("2024-02-29");
    expect(result.anchors["1Y"]).toBe("2023-02-28");
  });

  it("returns unavailable, never a shorter period, when history starts after the anchor", () => {
    // Eight months of history: 1W–6M and YTD exist; 1Y does not.
    const bars = weekdays("2026-02-02", "2026-10-09");
    const result = perform(bars);

    expect(result.returns["6M"]).not.toBeNull();
    expect(result.returns.YTD).toBeNull();
    expect(result.returns["1Y"]).toBeNull();
    expect(result.anchors["1Y"]).toBeNull();
  });

  it("does not satisfy a boundary with a later session", () => {
    // History starts Monday 2026-10-05; 1W from Friday 2026-10-09 anchors Friday 2026-10-02.
    const bars = weekdays("2026-10-05", "2026-10-09");
    const result = perform(bars);

    expect(result.returns["1W"]).toBeNull();
  });

  it("voids a boundary when coverage has a gap between its session and the anchor", () => {
    const bars = weekdays("2025-09-01", "2026-10-09").filter(
      (bar) => bar.date < "2026-09-01" || bar.date > "2026-09-15",
    );
    // The days around the 1M anchor (2026-09-09) were never stored: an older close must not stand in.
    const gapped = perform(bars, {
      missing: [{ from: "2026-09-01", to: "2026-09-15" }],
    });
    expect(gapped.returns["1M"]).toBeNull();
    expect(gapped.returns["1W"]).not.toBeNull();
    expect(gapped.returns["3M"]).not.toBeNull();

    // The same rows with the gap covered: the market really did not trade, so the session before
    // it is the anchor's session.
    const covered = perform(bars);
    expect(covered.anchors["1M"]).toBe("2026-08-31");
  });

  it("ignores missing coverage that does not touch a boundary", () => {
    const bars = weekdays("2025-09-01", "2026-10-09");
    const result = perform(bars, {
      // The provider has not published the newest session yet: after the latest bar.
      missing: [{ from: "2026-10-10", to: "2026-10-11" }],
    });

    expect(Object.values(result.returns).every((value) => value !== null)).toBe(
      true,
    );
  });

  it("never reports a session that has not closed and published", () => {
    const bars = weekdays("2026-09-01", "2026-10-09");
    const close = tradingSessionCloseInstant("2026-10-09").getTime();

    const trading = perform(bars, { now: new Date(close - 60 * 60_000) });
    expect(trading.sessionDate).toBe("2026-10-08");

    const publishing = perform(bars, { now: new Date(close + DELAY_MS - 1) });
    expect(publishing.sessionDate).toBe("2026-10-08");

    const published = perform(bars, { now: new Date(close + DELAY_MS) });
    expect(published.sessionDate).toBe("2026-10-09");
  });

  it("treats a close read before its session finalized as provisional", () => {
    const bars = weekdays("2026-09-01", "2026-10-09");
    const close = tradingSessionCloseInstant("2026-10-09").getTime();
    const now = new Date(close + 3 * 60 * 60_000);

    // Read mid-session and not read again since: the newest bar is the provider's intraday value.
    const readIntraday = perform(bars, {
      now,
      lastTailSyncAt: new Date(close - 2 * 60 * 60_000).toISOString(),
    });
    expect(readIntraday.sessionDate).toBe("2026-10-08");

    // Read again after the session finalized: now it is a close.
    const readFinal = perform(bars, {
      now,
      lastTailSyncAt: new Date(close + DELAY_MS + 60_000).toISOString(),
    });
    expect(readFinal.sessionDate).toBe("2026-10-09");
  });

  it("ignores unordered input, duplicate dates and unusable closes", () => {
    const bars: OverviewBar[] = [
      { date: "2026-10-09", close: 110 },
      { date: "2026-10-01", close: 0 },
      { date: "2026-10-02", close: 100 },
      { date: "2026-10-05", close: Number.NaN },
      { date: "2026-10-02", close: 100 },
    ];
    const result = perform(bars);

    expect(result.sessionDate).toBe("2026-10-09");
    expect(result.returns["1W"]).toBeCloseTo(10, 10);
  });

  it("has nothing to say without a completed session", () => {
    const result = perform([]);

    expect(result.sessionDate).toBeUndefined();
    expect(Object.values(result.returns)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(Object.values(result.sparklines)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("the period sparklines", () => {
  const year = weekdays(
    "2025-01-02",
    "2026-10-09",
    (index) => 100 + 10 * Math.sin(index / 9) + index * 0.05,
  );

  it("draws each period over exactly the window its return measures", () => {
    const result = perform(year);

    for (const period of MARKET_OVERVIEW_PERIODS) {
      const line = result.sparklines[period];
      const anchor = result.anchors[period] as string;
      expect(line?.startDate, period).toBe(anchor);
      expect(line?.endDate, period).toBe("2026-10-09");
      expect(line?.values[0], period).toBe(100);
      // The line's first-to-last change is the period's return, to the rebased line's precision,
      // so its direction can never contradict the number beside it.
      expect(line?.values.at(-1), period).toBeCloseTo(
        100 + (result.returns[period] as number),
        1,
      );
    }
  });

  it("gives a week and a month every daily close, not a weekly sample", () => {
    const result = perform(year);
    const sessionsFrom = (date: string) =>
      year.filter((bar) => bar.date >= date && bar.date <= "2026-10-09");

    // 2 Oct – 9 Oct: the anchor session and the five that follow it.
    expect(result.sparklines["1W"]?.values).toEqual(
      sessionsFrom("2026-10-02").map(
        (bar) =>
          Math.round((bar.close / closeOn(year, "2026-10-02")) * 10_000) / 100,
      ),
    );
    expect(result.sparklines["1W"]?.values).toHaveLength(6);
    // 9 Sep – 9 Oct: twenty-three sessions, every one of them.
    expect(result.sparklines["1M"]?.values).toHaveLength(
      sessionsFrom("2026-09-09").length,
    );
    expect(result.sparklines["1M"]?.values).toHaveLength(23);
  });

  it("thins three months and longer to the bound, and the six lines differ", () => {
    const result = perform(year);
    for (const period of ["3M", "6M", "YTD", "1Y"] as const) {
      expect(result.sparklines[period]?.values.length, period).toBe(
        MARKET_OVERVIEW_SPARKLINE_MAX_POINTS,
      );
    }
    const distinct = new Set(
      MARKET_OVERVIEW_PERIODS.map((period) =>
        JSON.stringify(result.sparklines[period]),
      ),
    );
    expect(distinct.size).toBe(6);
  });

  it("anchors YTD on the last session of the previous year", () => {
    const result = perform(year);
    expect(result.sparklines.YTD?.startDate).toBe("2025-12-31");
  });

  it("draws nothing for a period whose return is unavailable", () => {
    const result = perform(weekdays("2026-06-01", "2026-10-09"));

    expect(result.returns["3M"]).not.toBeNull();
    expect(result.sparklines["3M"]).not.toBeNull();
    for (const period of ["6M", "YTD", "1Y"] as const) {
      expect(result.returns[period], period).toBeNull();
      // Never a shorter history presented as the longer period.
      expect(result.sparklines[period], period).toBeNull();
    }
  });

  it("draws nothing across a gap in the stored coverage, and never fills it", () => {
    // 21–25 Sep was never stored: the month's return is sound (both ends are), its line is not.
    const holed = year.filter(
      (bar) => bar.date < "2026-09-21" || bar.date > "2026-09-25",
    );
    const result = perform(holed, {
      missing: [{ from: "2026-09-21", to: "2026-09-25" }],
    });

    expect(result.returns["1W"]).not.toBeNull();
    expect(result.sparklines["1W"]).not.toBeNull();
    expect(result.returns["1M"]).not.toBeNull();
    expect(result.sparklines["1M"]).toBeNull();
    expect(result.sparklines["1Y"]).toBeNull();
  });

  it("skips a holiday rather than inventing a close for it", () => {
    const bars = weekdays("2026-08-03", "2026-10-09", (index) => 100 + index, [
      "2026-10-07",
    ]);
    const line = perform(bars).sparklines["1W"];

    // 2, 5, 6, 8, 9 Oct: five sessions, the holiday is simply not a point.
    expect(line?.values).toHaveLength(5);
  });

  it("only selects stored closes, in session order, when it thins", () => {
    const window = year.slice(-130);
    const thinned = thinSessions(window, 48);

    expect(thinned).toHaveLength(48);
    expect(thinned[0]).toBe(window[0]);
    expect(thinned.at(-1)).toBe(window.at(-1));
    let previous = -1;
    for (const point of thinned) {
      const index = window.indexOf(point);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    // Deterministic: the same sessions always give the same line.
    expect(thinSessions(window, 48)).toEqual(thinned);
  });

  it("keeps the extremes a fixed stride would step over", () => {
    // A flat series with one spike that a stride of three would skip.
    const window = weekdays("2026-01-02", "2026-10-09", (index) =>
      index === 100 ? 140 : 100,
    );
    const thinned = thinSessions(window, 48);

    expect(Math.max(...thinned.map((bar) => bar.close))).toBe(140);
  });

  it("returns a short window whole", () => {
    const window = year.slice(-10);
    expect(thinSessions(window, 48)).toEqual(window);
  });

  it("draws nothing from a single session or an anchor that is not a session", () => {
    expect(
      Object.values(perform([{ date: "2026-10-09", close: 10 }]).sparklines),
    ).toEqual([null, null, null, null, null, null]);
    expect(buildPeriodSparkline(year, "2026-10-03", [])).toBeNull();
  });

  it("stays small: six lines for twenty funds fit the payload budget", () => {
    const bars = weekdays(
      "2025-01-02",
      "2026-10-09",
      (index) => 412.37 + index * 0.731,
    );
    const sparklines = perform(bars).sparklines;

    expect(JSON.stringify(sparklines).length * 20).toBeLessThan(40_000);
  });
});

describe("classifyInstruments", () => {
  it("references the newest session and marks anything behind it stale", () => {
    expect(
      classifyInstruments([
        "2026-10-09",
        "2026-10-08",
        undefined,
        "2026-10-09",
      ]),
    ).toEqual({
      asOf: "2026-10-09",
      statuses: ["AVAILABLE", "STALE", "UNAVAILABLE", "AVAILABLE"],
      status: "PARTIAL",
    });
  });

  it("is available only when every instrument is current", () => {
    expect(classifyInstruments(["2026-10-09", "2026-10-09"]).status).toBe(
      "AVAILABLE",
    );
  });

  it("is unavailable, with no reference session, when nothing has data", () => {
    expect(classifyInstruments([undefined, undefined])).toEqual({
      statuses: ["UNAVAILABLE", "UNAVAILABLE"],
      status: "UNAVAILABLE",
    });
  });
});

describe("unavailableInstrument", () => {
  it("keeps the instrument's identity and note with no numbers", () => {
    expect(
      unavailableInstrument("USO", "Oil futures", "Tracks futures, not spot."),
    ).toEqual({
      ticker: "USO",
      name: "Oil futures",
      note: "Tracks futures, not spot.",
      status: "UNAVAILABLE",
      returns: {
        "1W": null,
        "1M": null,
        "3M": null,
        "6M": null,
        YTD: null,
        "1Y": null,
      },
      sparklines: {
        "1W": null,
        "1M": null,
        "3M": null,
        "6M": null,
        YTD: null,
        "1Y": null,
      },
    });
  });
});

import { MARKET_OVERVIEW_PERIODS } from "@intrinsic/contracts";
import { tradingSessionCloseInstant } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  classifyInstruments,
  computeInstrumentPerformance,
  marketOverviewReadRange,
  periodAnchorDate,
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
    expect(result.sparkline).toBeNull();
  });
});

describe("the 1Y sparkline", () => {
  it("draws 53 weekly points from the 1Y baseline to the latest session", () => {
    const bars = weekdays(
      "2025-01-02",
      "2026-10-09",
      (index) => 50 + index * 0.25,
    );
    const result = perform(bars);
    const sparkline = result.sparkline;

    expect(sparkline?.values).toHaveLength(53);
    expect(sparkline?.startDate).toBe(result.anchors["1Y"]);
    expect(sparkline?.endDate).toBe("2026-10-09");
    expect(sparkline?.values[0]).toBe(100);
    // The line's first-to-last change is the 1Y return, to the rebased line's precision.
    expect(sparkline?.values.at(-1)).toBeCloseTo(
      100 + (result.returns["1Y"] as number),
      1,
    );
  });

  it("keeps real sessions in their real order", () => {
    const bars = weekdays(
      "2025-01-02",
      "2026-10-09",
      (index) => 100 + 10 * Math.sin(index / 9),
    );
    const sparkline = perform(bars).sparkline;
    expect(sparkline).not.toBeNull();
    // Rising monotonically through a sine would be a resampling bug; the shape survives.
    const values = sparkline?.values ?? [];
    expect(Math.max(...values)).toBeGreaterThan(values[0] as number);
    expect(Math.min(...values)).toBeLessThan(values[0] as number);
  });

  it("starts at the first session when the history is shorter than a year", () => {
    const bars = weekdays("2026-06-01", "2026-10-09");
    const sparkline = perform(bars).sparkline;

    expect(sparkline?.startDate).toBe("2026-06-01");
    expect(sparkline?.values.length).toBeGreaterThan(15);
    expect(sparkline?.values.length).toBeLessThan(53);
  });

  it("draws nothing from a single session", () => {
    expect(perform([{ date: "2026-10-09", close: 10 }]).sparkline).toBeNull();
  });

  it("stays small: twenty lines fit in a few kilobytes", () => {
    const bars = weekdays(
      "2025-01-02",
      "2026-10-09",
      (index) => 412.37 + index * 0.731,
    );
    const sparkline = perform(bars).sparkline;

    expect(JSON.stringify(sparkline).length * 20).toBeLessThan(12_000);
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
      sparkline: null,
    });
  });
});

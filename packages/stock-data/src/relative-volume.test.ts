import { DAILY_RELATIVE_VOLUMES, type DailyPrice } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  calculateDailyRelativeVolumes,
  calculateRelativeVolume,
} from "./relative-volume.js";

const SECURITY_ID = "sec-rvol";

/**
 * Trading days carrying the supplied volumes. Closes are held flat on purpose: Relative Volume is
 * a statement about participation and must not move with the price.
 */
function bars(volumes: readonly number[]): DailyPrice[] {
  return volumes.map((volume, index) => ({
    securityId: SECURITY_ID,
    date: sessionDate(index),
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume,
  }));
}

/**
 * The `index`-th **trading session**, laid out on consecutive weekdays.
 *
 * Deliberately not consecutive calendar days: the suite asserts that sessions are counted, and a
 * fixture on a calendar that never skips a weekend could not tell the two apart.
 */
function sessionDate(index: number): string {
  const start = Date.parse("2026-01-05T00:00:00Z"); // A Monday.
  const weekend = Math.floor(index / 5) * 2;
  return new Date(start + (index + weekend) * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** `count` sessions of exactly `volume`, so a baseline mean is knowable by inspection. */
function flat(count: number, volume: number): number[] {
  return Array.from({ length: count }, () => volume);
}

describe("relative volume", () => {
  it("divides the session's volume by the mean of the previous `period` sessions", () => {
    // Ten sessions of 1,000 give a baseline mean of exactly 1,000. The eleventh trades 2,500.
    const values = calculateRelativeVolume([...flat(10, 1_000), 2_500], 10);

    expect(values[10]).toBe(2.5);
  });

  it("excludes the session being measured from its own baseline", () => {
    // The decisive fixture. Ten quiet sessions, then one enormous one: including `t` in its own
    // average would pull the denominator up and report 11,000/1,090.9 = 10.08 instead of 11.
    const values = calculateRelativeVolume([...flat(10, 1_000), 11_000], 10);

    expect(values[10]).toBe(11);

    // And the general property, on a series with no repeated value: every reading equals the
    // ratio computed from a window that stops one session short of itself.
    const volumes = Array.from({ length: 40 }, (_unused, index) =>
      Math.round(1_000 + index * 137 + (index % 7) * 500),
    );
    const period = 10;
    const computed = calculateRelativeVolume(volumes, period);
    for (let index = period; index < volumes.length; index += 1) {
      const window = volumes.slice(index - period, index);
      expect(window).toHaveLength(period);
      expect(window).not.toContain(volumes[index]);
      const baseline = window.reduce((sum, value) => sum + value, 0) / period;
      expect(computed[index]).toBeCloseTo(volumes[index]! / baseline, 12);
    }
  });

  it("reads each registered period from its own window on one known series", () => {
    // Fifty sessions of 2,000 followed by ten of 4,000, then one of 6,000. Each period therefore
    // sees a different baseline, and the three answers are arithmetic anyone can check:
    //   RVOL 10: previous 10 sessions are all 4,000            -> 6,000 / 4,000 = 1.5
    //   RVOL 20: ten at 4,000 and ten at 2,000 -> mean 3,000   -> 6,000 / 3,000 = 2.0
    //   RVOL 50: ten at 4,000 and forty at 2,000 -> mean 2,400 -> 6,000 / 2,400 = 2.5
    const volumes = [...flat(50, 2_000), ...flat(10, 4_000), 6_000];
    const last = volumes.length - 1;

    expect(calculateRelativeVolume(volumes, 10)[last]).toBeCloseTo(1.5, 12);
    expect(calculateRelativeVolume(volumes, 20)[last]).toBeCloseTo(2.0, 12);
    expect(calculateRelativeVolume(volumes, 50)[last]).toBeCloseTo(2.5, 12);
  });

  it("requires the full lookback and never substitutes a shorter one", () => {
    // Seven previous sessions are not ten. An RVOL 10 built from them would be a different
    // indicator wearing the same name.
    const values = calculateRelativeVolume([...flat(7, 1_000), 2_000], 10);

    expect(values.every((value) => value === undefined)).toBe(true);
  });

  it("first produces a value on the session after its `period`-th predecessor", () => {
    for (const period of [10, 20, 50]) {
      const values = calculateRelativeVolume(flat(period + 1, 1_000), period);

      // Exactly `period` warm-up sessions: index `period` is the first with a full lookback.
      expect(values.slice(0, period)).toEqual(
        Array.from({ length: period }, () => undefined),
      );
      expect(values[period]).toBe(1);
    }
  });

  it("reports a quiet session as a value below one, never as absence", () => {
    const values = calculateRelativeVolume([...flat(10, 4_000), 2_000], 10);

    expect(values[10]).toBe(0.5);
  });

  it("treats a session that traded nothing as a real zero reading", () => {
    // Zero volume is a fact about the session, not a missing input: the ratio is defined and is
    // zero. Collapsing it to absence would hide a halted session behind "not warmed up yet".
    const values = calculateRelativeVolume([...flat(10, 1_000), 0], 10);

    expect(values[10]).toBe(0);
  });

  it("leaves the value absent when the baseline is zero", () => {
    // Ten sessions that traded nothing give a zero denominator. The ratio has no meaning there,
    // and an Infinity would satisfy every `is above` threshold a Strategy could name.
    const values = calculateRelativeVolume([...flat(10, 0), 5_000], 10);

    expect(values[10]).toBeUndefined();
  });

  it("makes a session with no usable volume absent, and every session it baselines", () => {
    // One unreadable session at index 5. It has no reading of its own, and the ten-session window
    // of every reading from index 6 through 15 contains it, so none of those has one either.
    const volumes = [...flat(5, 1_000), Number.NaN, ...flat(20, 1_000)];
    const values = calculateRelativeVolume(volumes, 10);

    expect(values[5]).toBeUndefined();
    for (let index = 6; index <= 15; index += 1) {
      expect(values[index]).toBeUndefined();
    }
    // Index 16's window is sessions 6..15, which is clear of it again.
    expect(values[16]).toBe(1);
  });

  it("counts trading observations, not calendar days", () => {
    // The same volume sequence laid out across weekends and a long gap produces the same values:
    // nothing here reads a date.
    const volumes = [...flat(10, 1_000), 3_000];
    const dense = calculateDailyRelativeVolumes(bars(volumes));
    const sparse = calculateDailyRelativeVolumes(
      bars(volumes).map((bar, index) => ({
        ...bar,
        date: new Date(
          Date.parse("2026-01-05T00:00:00Z") + index * 11 * 86_400_000,
        )
          .toISOString()
          .slice(0, 10),
      })),
    );

    expect(dense.map((row) => row.rvol10)).toEqual(
      sparse.map((row) => row.rvol10),
    );
    expect(dense.at(-1)?.rvol10).toBe(3);
  });

  it("does not look ahead: a prefix of history yields identical values for its own days", () => {
    const volumes = Array.from({ length: 80 }, (_unused, index) =>
      Math.round(900 + index * 91 + (index % 5) * 400),
    );
    const full = calculateDailyRelativeVolumes(bars(volumes));
    const prefix = calculateDailyRelativeVolumes(bars(volumes.slice(0, 60)));

    expect(prefix).toEqual(full.slice(0, 60));
  });

  it("is order-independent and never mutates or reorders its input", () => {
    const volumes = [...flat(10, 1_000), 2_000, 500];
    const ascending = bars(volumes);
    const shuffled = [...ascending].reverse();
    const snapshot = shuffled.map((bar) => ({ ...bar }));

    expect(calculateDailyRelativeVolumes(shuffled)).toEqual(
      calculateDailyRelativeVolumes(ascending),
    );
    expect(shuffled).toEqual(snapshot);
  });

  it("materializes every registered period, and only the registered periods", () => {
    expect(DAILY_RELATIVE_VOLUMES.length).toBeGreaterThan(0);
    const longest = Math.max(
      ...DAILY_RELATIVE_VOLUMES.map((entry) => entry.period),
    );
    const rows = calculateDailyRelativeVolumes(
      bars([...flat(longest, 1_000), 2_000]),
    );
    const last = rows.at(-1)!;

    for (const entry of DAILY_RELATIVE_VOLUMES) {
      expect(last[entry.field]).toBe(2);
    }
    // No stray field: the row carries its identity plus exactly the registered periods.
    expect(Object.keys(last).sort()).toEqual(
      [
        "date",
        "securityId",
        ...DAILY_RELATIVE_VOLUMES.map((e) => e.field),
      ].sort(),
    );
    expect(rows).toHaveLength(longest + 1);
  });

  it("narrows to a requested subset without changing any value", () => {
    const prices = bars([...flat(50, 2_000), ...flat(10, 4_000), 6_000]);
    const all = calculateDailyRelativeVolumes(prices);
    const only20 = calculateDailyRelativeVolumes(
      prices,
      DAILY_RELATIVE_VOLUMES.filter((entry) => entry.period === 20),
    );

    expect(only20.at(-1)?.rvol20).toBe(all.at(-1)?.rvol20);
    expect(only20.at(-1)?.rvol10).toBeUndefined();
    expect(only20.at(-1)?.rvol50).toBeUndefined();
  });

  it("refuses a period that is not a positive whole number of sessions", () => {
    expect(() => calculateRelativeVolume(flat(20, 1_000), 0)).toThrow();
    expect(() => calculateRelativeVolume(flat(20, 1_000), -10)).toThrow();
    expect(() => calculateRelativeVolume(flat(20, 1_000), 10.5)).toThrow();
  });

  it("agrees with a structurally independent slice-and-average oracle", () => {
    // The production kernel keeps one rolling sum, which is what makes it linear. The oracle
    // recomputes each window from scratch, so an off-by-one in the slide shows up as disagreement
    // rather than as two copies of the same mistake.
    const volumes = Array.from({ length: 200 }, (_unused, index) =>
      Math.round(500 + ((index * 7919) % 9_973)),
    );
    for (const period of [10, 20, 50]) {
      const actual = calculateRelativeVolume(volumes, period);
      const oracle = volumes.map((volume, index) => {
        if (index < period) {
          return undefined;
        }
        const window = volumes.slice(index - period, index);
        const mean = window.reduce((sum, value) => sum + value, 0) / period;
        return mean > 0 ? volume / mean : undefined;
      });
      actual.forEach((value, index) => {
        if (value === undefined) {
          expect(oracle[index]).toBeUndefined();
        } else {
          expect(value).toBeCloseTo(oracle[index]!, 10);
        }
      });
    }
  });
});

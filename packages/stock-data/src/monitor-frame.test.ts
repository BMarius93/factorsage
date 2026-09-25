import type {
  DailyDerivedState,
  DailyPrice,
  Security,
} from "@intrinsic/domain";
import {
  PRICE_OPERAND,
  marginOfSafetyOperand,
  readOperand,
  relativeVolumeOperand,
  seriesOperand,
} from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import {
  dailySeriesWarmupObservations,
  monitorWindowObservations,
  projectMonitorEvaluationFrame,
  requiredDailySeries,
} from "./monitor-frame.js";
import { calculateDailyTechnicals } from "./technicals.js";
import { calculateDailyOscillators } from "./oscillators.js";
import { calculateDailyRelativeVolumes } from "./relative-volume.js";

/**
 * The provisional current-day observation.
 *
 * `ai/product/monitors.md`: a Monitor evaluates persisted closed daily history plus the current
 * live price as the provisional current daily observation, so daily indicators may include it and
 * can move intraday. These tests pin that, and pin the two things that must NOT happen — a
 * fabricated bar when there is no current data, and a methodology seam between `t - 1` and `t`.
 */

const SECURITY: Security = {
  id: "sec-1",
  symbol: "TEST",
  name: "Test Security",
  exchangeCode: "NASDAQ",
  currency: "USD",
  type: "STOCK",
  isAdr: false,
  isActivelyTrading: true,
};

/** Consecutive weekday closes ending on the given date, so the window is a real trading calendar. */
function closedHistory(
  closes: readonly number[],
  volumes?: readonly number[],
): DailyPrice[] {
  const prices: DailyPrice[] = [];
  const cursor = new Date("2026-01-05T00:00:00.000Z"); // a Monday
  for (const [index, close] of closes.entries()) {
    prices.push({
      securityId: SECURITY.id,
      date: cursor.toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      volume: volumes?.[index] ?? 1_000,
    });
    do {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  }
  return prices;
}

/** The next weekday after the last closed bar: the provisional observation's own trading date. */
function nextTradingDate(prices: readonly DailyPrice[]): string {
  const cursor = new Date(`${prices[prices.length - 1]!.date}T00:00:00.000Z`);
  do {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
}

describe("daily series warm-up requirements", () => {
  it("is exact for an SMA and longer for the recursive series", () => {
    // An SMA is a plain window: `period` observations and it is exact.
    expect(
      dailySeriesWarmupObservations({
        kind: "MOVING_AVERAGE",
        type: "SMA",
        period: 50,
      }),
    ).toBe(50);

    // An EMA carries an exponentially decaying share of its seed, so it needs far more than its
    // period before a bounded window reproduces the canonical full-history value.
    const ema50 = dailySeriesWarmupObservations({
      kind: "MOVING_AVERAGE",
      type: "EMA",
      period: 50,
    });
    expect(ema50).toBeGreaterThan(50);

    // A longer EMA forgets its seed more slowly, so it needs a longer window.
    expect(
      dailySeriesWarmupObservations({
        kind: "MOVING_AVERAGE",
        type: "EMA",
        period: 200,
      }),
    ).toBeGreaterThan(ema50);

    // Wilder smoothing at alpha = 1/period converges much faster than an EMA of the same period.
    expect(
      dailySeriesWarmupObservations({ kind: "OSCILLATOR", period: 14 }),
    ).toBeLessThan(ema50);
  });

  it("is derived from the required series, not from a fixed horizon", () => {
    const rsiOnly = monitorWindowObservations(
      requiredDailySeries([PRICE_OPERAND, seriesOperand("RSI_14D")]),
    );
    const withEma200 = monitorWindowObservations(
      requiredDailySeries([PRICE_OPERAND, seriesOperand("EMA_200D")]),
    );
    // A Monitor that names only RSI does not pay for EMA 200D's convergence.
    expect(rsiOnly).toBeLessThan(withEma200);
  });

  it("still asks for a previous row when no daily series is required at all", () => {
    // `Price is below DCF` needs no daily indicator, but a Trigger still needs its `t - 1` value.
    const observations = monitorWindowObservations(
      requiredDailySeries([PRICE_OPERAND, marginOfSafetyOperand("DCF_FCFF")]),
    );
    expect(observations).toBeGreaterThanOrEqual(2);
  });
});

describe("requiredDailySeries", () => {
  it("resolves only the daily series the operands reference", () => {
    const required = requiredDailySeries([
      PRICE_OPERAND,
      seriesOperand("SMA_50D"),
      seriesOperand("RSI_14D"),
    ]);
    expect(required.movingAverages.map((entry) => entry.field)).toEqual([
      "sma50d",
    ]);
    expect(required.oscillators.map((entry) => entry.field)).toEqual(["rsi14d"]);
  });

  it("excludes weekly moving averages and intrinsic values", () => {
    // Neither can be recalculated from a bounded daily window; both are carried forward instead.
    const required = requiredDailySeries([
      seriesOperand("SMA_50W"),
      seriesOperand("DCF_FCFF"),
      marginOfSafetyOperand("DCF_FCFF"),
    ]);
    expect(required.movingAverages).toEqual([]);
    expect(required.oscillators).toEqual([]);
  });
});

describe("projectMonitorEvaluationFrame", () => {
  const operands = [PRICE_OPERAND, seriesOperand("SMA_20D")];

  it("appends the live price as the provisional current-day observation", () => {
    const prices = closedHistory(Array.from({ length: 40 }, () => 100));
    const observationDate = nextTradingDate(prices);

    const result = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands,
      observation: { price: 130 },
      observationDate,
    });

    expect(result).not.toBeNull();
    expect(result?.observationDate).toBe(observationDate);
    expect(result?.observationPrice).toBe(130);
    // The observation index is the last row, and its previous row is the last closed trading day.
    expect(result?.frame.dates[result.observationIndex]).toBe(observationDate);
    expect(result?.frame.dates[result.observationIndex - 1]).toBe(
      prices[prices.length - 1]!.date,
    );
  });

  it("moves a daily indicator intraday, because the provisional close is in its window", () => {
    const prices = closedHistory(Array.from({ length: 40 }, () => 100));
    const observationDate = nextTradingDate(prices);

    const flat = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands,
      observation: { price: 100 },
      observationDate,
    });
    const jumped = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands,
      observation: { price: 300 },
      observationDate,
    });

    const key = seriesOperand("SMA_20D");
    const flatSma = readOperand(flat!.frame, key, flat!.observationIndex);
    const jumpedSma = readOperand(jumped!.frame, key, jumped!.observationIndex);
    expect(flatSma).toBeCloseTo(100, 10);
    // One 300 inside a 20-bar window of 100s: (19 * 100 + 300) / 20 = 110.
    expect(jumpedSma).toBeCloseTo(110, 10);
  });

  it("has no observation at all when there is no current quote", () => {
    const prices = closedHistory(Array.from({ length: 40 }, () => 100));

    // Deliberately not a fallback to the last closed day. Swapping in a different observation would
    // let a provider outage resolve a live match and re-emit it on recovery; the caller reports
    // NOT_EVALUABLE instead, which leaves the durable latch untouched.
    expect(
      projectMonitorEvaluationFrame({
        security: SECURITY,
        prices,
        derived: [],
        operands,
        observation: null,
        observationDate: nextTradingDate(prices),
      }),
    ).toBeNull();
  });

  it("replaces, never duplicates, a trading day the provider has repriced", () => {
    const prices = closedHistory(Array.from({ length: 40 }, () => 100));
    const sameDay = prices[prices.length - 1]!.date;

    const result = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands,
      observation: { price: 120 },
      observationDate: sameDay,
    });

    // Two rows for one trading day would break the frame's strictly-ascending invariant and give a
    // Trigger a same-day `t - 1`.
    expect(result?.frame.dates).toHaveLength(prices.length);
    expect(result?.observationDate).toBe(sameDay);
    expect(result?.observationPrice).toBe(120);
  });

  it("rejects a quote dated before the newest persisted close", () => {
    const prices = closedHistory(Array.from({ length: 40 }, () => 100));

    // A stale quote is not a current observation, and back-dating the frame to accept it would be
    // worse than having none at all.
    expect(
      projectMonitorEvaluationFrame({
        security: SECURITY,
        prices,
        derived: [],
        operands,
        observation: { price: 500 },
        observationDate: prices[0]!.date,
      }),
    ).toBeNull();
  });

  it("has no observation at all for a security with no persisted history", () => {
    expect(
      projectMonitorEvaluationFrame({
        security: SECURITY,
        prices: [],
        derived: [],
        operands,
        observation: { price: 100 },
        observationDate: "2026-03-02",
      }),
    ).toBeNull();
  });

  it("produces t-1 and t from one methodology, so no seam can read as a crossing", () => {
    // A rising series: every row's SMA differs from the last, which is exactly where a seam
    // between a persisted value at `t - 1` and a recomputed one at `t` would show up.
    const closes = Array.from({ length: 60 }, (_, index) => 100 + index);
    const prices = closedHistory(closes);
    const observationDate = nextTradingDate(prices);

    const result = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands,
      observation: { price: 160 },
      observationDate,
    })!;

    // The whole window, including the provisional bar, equals one canonical computation over the
    // same price array — the property that makes a fabricated crossing impossible by construction.
    const provisional = [
      ...prices,
      {
        securityId: SECURITY.id,
        date: observationDate,
        open: 160,
        high: 160,
        low: 160,
        close: 160,
        volume: 0,
      },
    ];
    const canonical = calculateDailyTechnicals(provisional);
    const key = seriesOperand("SMA_20D");
    for (let index = 0; index < provisional.length; index += 1) {
      const expected = canonical[index]?.sma20d;
      const actual = readOperand(result.frame, key, index);
      if (expected === undefined) {
        expect(Number.isNaN(actual)).toBe(true);
      } else {
        expect(actual).toBeCloseTo(expected, 10);
      }
    }
  });

  it("computes only the required series and leaves the rest off the frame entirely", () => {
    const prices = closedHistory(Array.from({ length: 60 }, () => 100));
    const result = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, seriesOperand("SMA_20D")],
      observation: { price: 100 },
      observationDate: nextTradingDate(prices),
    })!;

    expect(result.frame.columns.has(seriesOperand("SMA_20D"))).toBe(true);
    // SMA 50D is a registered series that no operand asked for. It is never computed and never
    // projected, so a Monitor batch cannot pay for series it does not name.
    expect(result.frame.columns.has(seriesOperand("SMA_50D"))).toBe(false);
    expect(result.frame.columns.has(seriesOperand("RSI_14D"))).toBe(false);
  });

  it("carries weekly and intrinsic values forward onto the provisional day", () => {
    const prices = closedHistory(Array.from({ length: 40 }, () => 100));
    const lastClosed = prices[prices.length - 1]!;
    const observationDate = nextTradingDate(prices);
    const derived: DailyDerivedState[] = [
      {
        securityId: SECURITY.id,
        date: lastClosed.date,
        sma20w: 95,
        weeklySourceWeekStart: "2026-02-16",
        intrinsicValues: { DCF_FCFF: 200 },
        dcfFcffSourceAsOf: "2026-01-02T00:00:00.000Z",
        intrinsicCurrency: "USD",
      },
    ];

    const result = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived,
      operands: [
        PRICE_OPERAND,
        seriesOperand("SMA_20W"),
        seriesOperand("DCF_FCFF"),
        marginOfSafetyOperand("DCF_FCFF"),
      ],
      observation: { price: 150 },
      observationDate,
    })!;

    // Neither a completed week nor a newly eligible filing can take effect intraday, so both are
    // carried forward — which is the canonical rule for each of them, not a Monitor special case.
    expect(
      readOperand(result.frame, seriesOperand("SMA_20W"), result.observationIndex),
    ).toBe(95);
    expect(
      readOperand(result.frame, seriesOperand("DCF_FCFF"), result.observationIndex),
    ).toBe(200);
    // Margin of Safety is recomputed against the live price from that same carried intrinsic value:
    // (200 - 150) / 200 * 100 = 25. The valuation itself is never rerun.
    expect(
      readOperand(
        result.frame,
        marginOfSafetyOperand("DCF_FCFF"),
        result.observationIndex,
      ),
    ).toBeCloseTo(25, 10);
  });

  it("withholds an intrinsic value that has no provenance", () => {
    const prices = closedHistory(Array.from({ length: 40 }, () => 100));
    const derived: DailyDerivedState[] = [
      {
        securityId: SECURITY.id,
        date: prices[prices.length - 1]!.date,
        intrinsicValues: { DCF_FCFF: 200 },
        intrinsicCurrency: "USD",
      },
    ];

    const result = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived,
      operands: [PRICE_OPERAND, marginOfSafetyOperand("DCF_FCFF")],
      observation: { price: 150 },
      observationDate: nextTradingDate(prices),
    })!;

    // The provenance gate lives in the canonical projector and applies here unchanged.
    expect(
      Number.isNaN(
        readOperand(
          result.frame,
          marginOfSafetyOperand("DCF_FCFF"),
          result.observationIndex,
        ),
      ),
    ).toBe(true);
  });

  it("leaves a required series absent while it has not warmed up", () => {
    const prices = closedHistory(Array.from({ length: 5 }, () => 100));
    const result = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, seriesOperand("SMA_20D")],
      observation: { price: 100 },
      observationDate: nextTradingDate(prices),
    })!;

    // Six observations cannot produce a twenty-bar average. Absent, never zero.
    expect(
      Number.isNaN(
        readOperand(result.frame, seriesOperand("SMA_20D"), result.observationIndex),
      ),
    ).toBe(true);
  });

  it("recomputes RSI against the provisional close", () => {
    const closes = Array.from({ length: 60 }, (_, index) => 100 + index * 0.5);
    const prices = closedHistory(closes);
    const observationDate = nextTradingDate(prices);

    const up = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, seriesOperand("RSI_14D")],
      observation: { price: 200 },
      observationDate,
    })!;
    const down = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, seriesOperand("RSI_14D")],
      observation: { price: 50 },
      observationDate,
    })!;

    const key = seriesOperand("RSI_14D");
    const upRsi = readOperand(up.frame, key, up.observationIndex);
    const downRsi = readOperand(down.frame, key, down.observationIndex);
    expect(upRsi).toBeGreaterThan(downRsi);

    // And it equals the canonical kernel over the same provisional price array.
    const canonical = calculateDailyOscillators([
      ...prices,
      {
        securityId: SECURITY.id,
        date: observationDate,
        open: 200,
        high: 200,
        low: 200,
        close: 200,
        volume: 0,
      },
    ]);
    expect(upRsi).toBeCloseTo(canonical[canonical.length - 1]!.rsi14d!, 10);
  });
});

describe("relative volume in a monitor cycle", () => {
  const RVOL_20 = relativeVolumeOperand(20);

  /** Twenty-one closed sessions of 1,000 shares each: a baseline mean anyone can check. */
  function quietHistory(): DailyPrice[] {
    return closedHistory(Array.from({ length: 21 }, () => 100));
  }

  it("resolves only the periods the operands name", () => {
    const required = requiredDailySeries([RVOL_20]);

    expect(required.relativeVolumes.map((entry) => entry.period)).toEqual([20]);
    expect(required.movingAverages).toEqual([]);
    expect(required.oscillators).toEqual([]);
  });

  it("asks for the full lookback plus the provisional session", () => {
    // Exact, not approximate: RVOL carries no seed, so `period + 1` closed observations plus the
    // provisional row is genuinely all it needs to equal its canonical materialized value.
    expect(
      dailySeriesWarmupObservations({ kind: "RELATIVE_VOLUME", period: 20 }),
    ).toBe(21);
    expect(monitorWindowObservations(requiredDailySeries([RVOL_20]))).toBe(22);
  });

  it("measures the live session's volume against the twenty closed sessions before it", () => {
    const prices = quietHistory();
    const frame = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, RVOL_20],
      observation: { price: 100, volume: 2_500 },
      observationDate: nextTradingDate(prices),
    });

    expect(frame).not.toBeNull();
    expect(readOperand(frame!.frame, RVOL_20, frame!.observationIndex)).toBe(
      2.5,
    );
  });

  it("supersedes a repriced session rather than lengthening its own baseline", () => {
    // The provider has restated today, which is already persisted. The live bar replaces it, so
    // the twenty-session baseline is still the twenty sessions *before* it.
    const prices = quietHistory();
    const frame = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, RVOL_20],
      observation: { price: 100, volume: 3_000 },
      observationDate: prices.at(-1)!.date,
    });

    expect(frame).not.toBeNull();
    expect(frame!.closedObservations).toBe(prices.length - 1);
    expect(readOperand(frame!.frame, RVOL_20, frame!.observationIndex)).toBe(3);
  });

  it("is NOT_EVALUABLE when the quote reports no volume, never a zero reading", () => {
    // The regression this exists for: a missing field must not read as "this session has traded
    // nothing", which would match `RVOL 20 is below 0.5x` on every symbol the provider was quiet
    // about — a signal manufactured out of an absent field.
    const prices = quietHistory();
    const frame = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, RVOL_20],
      observation: { price: 100 },
      observationDate: nextTradingDate(prices),
    });

    expect(frame).not.toBeNull();
    // The price half of the observation is unaffected: only the volume-derived value is withheld.
    expect(readOperand(frame!.frame, PRICE_OPERAND, frame!.observationIndex)).toBe(100);
    expect(
      readOperand(frame!.frame, RVOL_20, frame!.observationIndex),
    ).toBeNaN();
  });

  it("is NOT_EVALUABLE while the closed history is shorter than the lookback", () => {
    const prices = closedHistory(Array.from({ length: 12 }, () => 100));
    const frame = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, RVOL_20],
      observation: { price: 100, volume: 5_000 },
      observationDate: nextTradingDate(prices),
    });

    expect(frame).not.toBeNull();
    expect(
      readOperand(frame!.frame, RVOL_20, frame!.observationIndex),
    ).toBeNaN();
  });

  it("never lets a persisted value survive next to a recomputed one", () => {
    // The persisted row says 9; this window's own calculation says 2.5. Reading the stale value
    // would put two methodologies on one frame, which is exactly what rule 1 of the projector
    // forbids for the daily families.
    const prices = quietHistory();
    const stale: DailyDerivedState = {
      securityId: SECURITY.id,
      date: prices.at(-1)!.date,
      rvol20: 9,
    };
    const frame = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [stale],
      operands: [PRICE_OPERAND, RVOL_20],
      observation: { price: 100, volume: 2_500 },
      observationDate: nextTradingDate(prices),
    });

    expect(frame).not.toBeNull();
    expect(
      readOperand(frame!.frame, RVOL_20, frame!.observationIndex - 1),
    ).toBe(1);
  });

  it("carries all three periods as separate columns, each equal to its own canonical value", () => {
    // The period-identity case, in the Monitor frame. `RVOL 10`, `RVOL 20` and `RVOL 50` once shared
    // one semantic identity, so a frame holding all three is where a column serving another period's
    // number would show. Each is compared with the canonical materialization of *its own* period, and
    // the three are required to differ — on this series they genuinely do, so three equal columns
    // would mean one value had been broadcast to all of them.
    const volumes = Array.from({ length: 80 }, (_unused, index) =>
      Math.round(1_000 + index * 137 + (index % 7) * 410),
    );
    const prices = closedHistory(
      Array.from({ length: 80 }, () => 100),
      volumes,
    );
    const canonical = calculateDailyRelativeVolumes(prices);
    const operands = [10, 20, 50].map((period) =>
      relativeVolumeOperand(period as 10 | 20 | 50),
    );
    const frame = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, ...operands],
      observation: { price: 100, volume: 12_000 },
      observationDate: nextTradingDate(prices),
    });

    expect(frame).not.toBeNull();
    const closedIndex = frame!.observationIndex - 1;
    const newest = canonical.at(-1)!;
    const read = (period: 10 | 20 | 50): number =>
      readOperand(frame!.frame, relativeVolumeOperand(period), closedIndex);

    expect(read(10)).toBeCloseTo(newest.rvol10!, 12);
    expect(read(20)).toBeCloseTo(newest.rvol20!, 12);
    expect(read(50)).toBeCloseTo(newest.rvol50!, 12);
    expect(new Set([read(10), read(20), read(50)]).size).toBe(3);

    // And on the provisional session, where the Monitor is the only thing that computes a value at
    // all: the same three baselines, measured against the live volume.
    const mean = (period: number): number =>
      volumes.slice(volumes.length - period).reduce((a, b) => a + b, 0) / period;
    for (const period of [10, 20, 50] as const) {
      expect(
        readOperand(
          frame!.frame,
          relativeVolumeOperand(period),
          frame!.observationIndex,
        ),
      ).toBeCloseTo(12_000 / mean(period), 10);
    }
  });

  it("agrees with the canonical materialized value for a closed session", () => {
    // The Monitor recomputes over a bounded window; ingestion computes over the whole history.
    // For a non-recursive series the two must be identical, not merely close.
    const volumes = Array.from({ length: 60 }, (_unused, index) =>
      Math.round(1_000 + index * 73 + (index % 6) * 250),
    );
    const prices = closedHistory(
      Array.from({ length: 60 }, () => 100),
      volumes,
    );
    const canonical = calculateDailyRelativeVolumes(prices);
    const frame = projectMonitorEvaluationFrame({
      security: SECURITY,
      prices,
      derived: [],
      operands: [PRICE_OPERAND, RVOL_20],
      observation: { price: 100, volume: 4_000 },
      observationDate: nextTradingDate(prices),
    });

    expect(frame).not.toBeNull();
    // The row before the provisional one is the newest closed session.
    expect(
      readOperand(frame!.frame, RVOL_20, frame!.observationIndex - 1),
    ).toBeCloseTo(canonical.at(-1)!.rvol20!, 12);
  });
});

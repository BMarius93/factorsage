import { describe, expect, it } from "vitest";
import {
  basisFactorAt,
  closesDiffer,
  comparePriceHistories,
  heldFromIndex,
  isPlainShareRatio,
  isSplitSizedMove,
  type PriceBasisEvent,
  type PriceComparisonRow,
} from "./price-basis.js";

const SECURITY = "security-1";
const DETECTED_AT = "2026-10-07T12:00:00.000Z";

/** Weekday sessions from `from`, `count` of them, at `close(index)`. */
function sessions(
  from: string,
  count: number,
  close: (index: number) => number,
): PriceComparisonRow[] {
  const rows: PriceComparisonRow[] = [];
  const day = new Date(`${from}T00:00:00.000Z`);
  while (rows.length < count) {
    const weekday = day.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      rows.push({
        date: day.toISOString().slice(0, 10),
        close: close(rows.length),
      });
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return rows;
}

/** A plausible as-traded path: a slow drift with a wobble, all far from a split-sized move. */
function path(index: number): number {
  return 100 + index * 0.05 + Math.sin(index / 3) * 2;
}

function compare(
  stored: readonly PriceComparisonRow[],
  fresh: readonly PriceComparisonRow[],
) {
  return comparePriceHistories({
    securityId: SECURITY,
    generation: 2,
    detectedAt: DETECTED_AT,
    stored,
    fresh,
  });
}

/** The provider's history after an event at `exDate`: every earlier row divided by `ratio`. */
function rebased(
  rows: readonly PriceComparisonRow[],
  exDate: string,
  ratio: number,
): PriceComparisonRow[] {
  return rows.map((row) =>
    row.date < exDate ? { date: row.date, close: row.close / ratio } : row,
  );
}

describe("closesDiffer", () => {
  it("allows half a cent per row at or above $1 and half a hundredth below", () => {
    expect(closesDiffer(100, 100.009)).toBe(false);
    expect(closesDiffer(100, 100.011)).toBe(true);
    expect(closesDiffer(0.5, 0.50009)).toBe(false);
    expect(closesDiffer(0.5, 0.5002)).toBe(true);
  });
});

describe("isSplitSizedMove", () => {
  it("is a 3:2 split or larger, either way, and nothing smaller", () => {
    expect(isSplitSizedMove(100, 66.67)).toBe(true);
    expect(isSplitSizedMove(100, 25)).toBe(true);
    expect(isSplitSizedMove(100, 200)).toBe(true);
    expect(isSplitSizedMove(100, 75)).toBe(false);
    expect(isSplitSizedMove(100, 135)).toBe(false);
    expect(isSplitSizedMove(100, 95.06)).toBe(false);
  });

  it("is never true for a missing or non-positive close", () => {
    expect(isSplitSizedMove(0, 25)).toBe(false);
    expect(isSplitSizedMove(100, Number.NaN)).toBe(false);
  });
});

describe("heldFromIndex", () => {
  const stored = { date: "2026-10-05", close: 200 };

  it("holds an ex-date row published in the new basis before the older rows are rewritten", () => {
    expect(
      heldFromIndex([stored, { date: "2026-10-06", close: 50.2 }], 1),
    ).toBe(1);
    expect(
      heldFromIndex(
        [
          stored,
          { date: "2026-10-06", close: 50.2 },
          { date: "2026-10-07", close: 51 },
          { date: "2026-10-08", close: 50.5 },
        ],
        1,
      ),
    ).toBe(1);
  });

  it("accepts the move as genuine once four sessions stand from it", () => {
    expect(
      heldFromIndex(
        [
          stored,
          { date: "2026-10-06", close: 50.2 },
          { date: "2026-10-07", close: 51 },
          { date: "2026-10-08", close: 50.5 },
          { date: "2026-10-09", close: 49 },
        ],
        1,
      ),
    ).toBeUndefined();
  });

  it("holds nothing for an ordinary move or a move among stored rows", () => {
    expect(heldFromIndex([stored, { date: "2026-10-06", close: 180 }], 1)).toBe(
      undefined,
    );
    expect(
      heldFromIndex(
        [
          { date: "2026-10-02", close: 800 },
          stored,
          { date: "2026-10-06", close: 201 },
        ],
        2,
      ),
    ).toBeUndefined();
  });

  it("holds the trailing move of a first load, whose rows are all new", () => {
    const rows = sessions("2026-09-01", 30, path);
    rows.push({ date: "2026-10-13", close: (rows.at(-1)!.close / 4) * 1.01 });
    expect(heldFromIndex(rows, 0)).toBe(30);
  });
});

describe("comparePriceHistories", () => {
  const history = sessions("2026-01-05", 200, path);

  it("reports nothing when every common session agrees", () => {
    const result = compare(history, history);
    expect(result).toEqual({
      comparedSessions: 200,
      changed: false,
      storedOnly: [],
      events: [],
    });
  });

  it("dates a split by the first unchanged session and measures its ratio", () => {
    const exDate = history[150]!.date;
    const result = compare(history, rebased(history, exDate, 4));
    expect(result.changed).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      securityId: SECURITY,
      generation: 2,
      kind: "MEASURED",
      effectiveDate: exDate,
      detectedAt: DETECTED_AT,
    });
    expect(result.events[0]!.priceRatio).toBeCloseTo(4, 9);
  });

  it("measures a reverse split and a spin-off the same way, without classifying them", () => {
    const exDate = history[120]!.date;
    const reverse = compare(history, rebased(history, exDate, 0.1));
    expect(reverse.events[0]).toMatchObject({
      kind: "MEASURED",
      effectiveDate: exDate,
    });
    expect(reverse.events[0]!.priceRatio).toBeCloseTo(0.1, 9);

    const spinOff = compare(history, rebased(history, exDate, 1.046));
    expect(spinOff.events[0]).toMatchObject({
      kind: "MEASURED",
      effectiveDate: exDate,
    });
    expect(spinOff.events[0]!.priceRatio).toBeCloseTo(1.046, 6);
  });

  it("measures two events between two reads, each with its own ratio", () => {
    const later = history[160]!.date;
    const earlier = history[60]!.date;
    const fresh = rebased(rebased(history, later, 2), earlier, 1.05);
    const result = compare(history, fresh);
    expect(result.events.map((event) => event.effectiveDate)).toEqual([
      later,
      earlier,
    ]);
    expect(result.events[0]!.priceRatio).toBeCloseTo(2, 9);
    expect(result.events[1]!.priceRatio).toBeCloseTo(1.05, 6);
  });

  it("dates an event that fell after the newest stored session by the one session after it", () => {
    const stored = history.slice(0, 199);
    const result = compare(stored, rebased(history, history[199]!.date, 4));
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "MEASURED",
      effectiveDate: history[199]!.date,
    });
    expect(result.events[0]!.priceRatio).toBeCloseTo(4, 9);
  });

  it("records an interval, never a guessed date, when several sessions followed the newest stored one", () => {
    const stored = history.slice(0, 190);
    const fresh = history.map((row) => ({ ...row, close: row.close / 3 }));
    const result = compare(stored, fresh);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "MEASURED",
      effectiveFrom: history[189]!.date,
      effectiveTo: history[199]!.date,
    });
    expect(result.events[0]!.effectiveDate).toBeUndefined();
    expect(result.events[0]!.priceRatio).toBeCloseTo(3, 9);
  });

  it("ends the interval at the detection when the provider re-based before publishing a session after it", () => {
    // Stored through 2026-09-25; detected on 2026-10-07 with nothing published after it.
    const stored = history.slice(0, 190);
    const fresh = stored.map((row) => ({ ...row, close: row.close / 2 }));
    const result = compare(stored, fresh);
    expect(result.events[0]).toMatchObject({
      kind: "MEASURED",
      effectiveFrom: stored[189]!.date,
      effectiveTo: DETECTED_AT.slice(0, 10),
    });
    expect(result.events[0]!.effectiveDate).toBeUndefined();
  });

  it("never ends such an interval on or before the newest stored session", () => {
    // Detected on the day of the newest stored session: the event is still after it.
    const fresh = history.map((row) => ({ ...row, close: row.close / 2 }));
    const result = comparePriceHistories({
      securityId: SECURITY,
      generation: 2,
      detectedAt: `${history[199]!.date}T23:30:00.000Z`,
      stored: history,
      fresh,
    });
    const nextDay = new Date(`${history[199]!.date}T00:00:00.000Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    expect(result.events[0]).toMatchObject({
      effectiveFrom: history[199]!.date,
      effectiveTo: nextDay.toISOString().slice(0, 10),
    });
    // The newest stored session is before the event, whatever the revision.
    expect(
      basisFactorAt({
        session: history[199]!.date,
        observedAt: "2027-01-04T00:00:00.000Z",
        events: [{ ...result.events[0]!, priceRatio: 1.046 }],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "BEFORE_DISTRIBUTION" });
  });

  it("treats a short block of corrected rows as corrections, never as events", () => {
    const fresh = history.map((row, index) =>
      index === 80 || index === 81 ? { ...row, close: row.close * 1.02 } : row,
    );
    const result = compare(history, fresh);
    expect(result.changed).toBe(true);
    expect(result.events).toEqual([]);
  });

  it("treats a corrected earliest row as a correction", () => {
    const fresh = history.map((row, index) =>
      index === 0 ? { ...row, close: row.close * 0.97 } : row,
    );
    expect(compare(history, fresh).events).toEqual([]);
  });

  it("dates a history mixed by a tail refresh after a split at the refresh's start", () => {
    // Stored before PR 1: the rows a tail refresh re-read after the provider re-based are new-basis,
    // everything before them old-basis. The current history is new-basis throughout.
    const exDate = history[170]!.date;
    const current = rebased(history, exDate, 2);
    const tailStart = 165;
    const stored = history.map((row, index) =>
      index >= tailStart ? current[index]! : row,
    );
    const result = compare(stored, current);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "MEASURED",
      effectiveDate: history[tailStart]!.date,
    });
    expect(result.events[0]!.priceRatio).toBeCloseTo(2, 9);
  });

  it("reports a prefix stored on a newer basis than the rows after it as unexplained", () => {
    // Stored before PR 1: a prefix widened after the split is new-basis, the middle old-basis.
    const exDate = history[150]!.date;
    const current = rebased(history, exDate, 2);
    const stored = history.map((row, index) =>
      index < 40 || index >= 150 ? current[index]! : row,
    );
    const result = compare(stored, current);
    expect(result.events.map((event) => event.kind)).toEqual([
      "MEASURED",
      "UNEXPLAINED",
    ]);
    expect(result.events[0]).toMatchObject({ effectiveDate: exDate });
    // It reaches back to the earliest compared session: unbounded below.
    expect(result.events[1]).toMatchObject({ effectiveTo: history[39]!.date });
    expect(result.events[1]!.effectiveFrom).toBeUndefined();
  });

  it("treats scattered single corrected rows as corrections, however many", () => {
    const fresh = history.map((row, index) =>
      index % 7 === 0 ? { ...row, close: row.close * (1 + index / 1000) } : row,
    );
    const result = compare(history, fresh);
    expect(result.changed).toBe(true);
    expect(result.events).toEqual([]);
  });

  it("reports a change with no step structure as one unexplained event", () => {
    // Every session moves by its own ratio: no run of one ratio, so nothing can be restored.
    const fresh = history.map((row, index) => ({
      ...row,
      close: row.close * (1 + (index + 1) / 1000),
    }));
    const result = compare(history, fresh);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: "UNEXPLAINED",
      effectiveTo: history[199]!.date,
    });
    expect(result.events[0]!.effectiveFrom).toBeUndefined();
    expect(result.events[0]!.priceRatio).toBeUndefined();
  });

  it("bounds an unexplained change that leaves the rows before it unchanged", () => {
    // Every session from the 50th on moves by its own ratio; the 49 before it are untouched.
    const fresh = history.map((row, index) =>
      index >= 50
        ? { ...row, close: row.close * (1 + (index + 1) / 1000) }
        : row,
    );
    const result = compare(history, fresh);
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: "UNEXPLAINED",
        effectiveFrom: history[50]!.date,
        effectiveTo: history[199]!.date,
      }),
    ]);
  });

  it("lists stored sessions the provider no longer returns", () => {
    const fresh = history.filter((_, index) => index !== 10 && index !== 11);
    const result = compare(history, fresh);
    expect(result.storedOnly).toEqual([history[10]!.date, history[11]!.date]);
    expect(result.changed).toBe(false);
  });

  it("records the runs it found as evidence", () => {
    const exDate = history[150]!.date;
    const result = compare(history, rebased(history, exDate, 4));
    expect(result.events[0]!.evidence).toMatchObject({
      comparedSessions: 200,
      changedSessions: 150,
      unfittedSessions: 0,
      runs: [
        { from: exDate, to: history[199]!.date, sessions: 50 },
        { from: history[0]!.date, to: history[149]!.date, sessions: 150 },
      ],
    });
  });
});

describe("comparePriceHistories on rounded histories", () => {
  /** A deterministic random walk: the true price of one security, session by session. */
  function walk(
    count: number,
    start: number,
    drift: number,
    seed: number,
  ): number[] {
    let state = seed;
    const random = () => {
      state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
      return state / 2_147_483_648;
    };
    const prices: number[] = [];
    let price = start;
    for (let index = 0; index < count; index += 1) {
      price *= 1 + drift + (random() - 0.5) * 0.04;
      prices.push(price);
    }
    return prices;
  }

  /** How the provider prints a close: cents at or above $1, four decimals below. */
  const printed = (value: number) =>
    value >= 1
      ? Math.round(value * 100) / 100
      : Math.round(value * 10_000) / 10_000;

  // The provider rounds each re-based row on its own, so no two sessions give exactly one ratio.
  for (const [label, factor, start, drift] of [
    ["2:1 split", 2, 20, 0.0004],
    ["3:2 split", 1.5, 20, 0.0004],
    ["4:1 split", 4, 20, 0.0004],
    ["10:1 split", 10, 50, 0.0004],
    ["1.046 spin-off", 1.046, 50, 0.0002],
    ["1:10 reverse split", 0.1, 8, -0.0008],
  ] as const) {
    it(`measures one event for a ${label} after the newest stored session`, () => {
      for (let seed = 1; seed <= 40; seed += 1) {
        const truth = walk(1_500, start, drift, seed);
        const days = sessions("2020-01-06", truth.length + 1, () => 0).map(
          (row) => row.date,
        );
        const stored = truth.map((price, index) => ({
          date: days[index]!,
          close: printed(price * factor),
        }));
        const fresh = [
          ...truth.map((price, index) => ({
            date: days[index]!,
            close: printed(price),
          })),
          { date: days.at(-1)!, close: printed(truth.at(-1)!) },
        ];
        const result = compare(stored, fresh);
        const message = `${label}, seed ${seed}`;
        expect(result.events, message).toHaveLength(1);
        expect(result.events[0], message).toMatchObject({
          kind: "MEASURED",
          effectiveDate: days.at(-1),
        });
        const ratio = result.events[0]!.priceRatio!;
        expect(Math.abs(ratio / factor - 1), message).toBeLessThan(0.001);
        expect(isPlainShareRatio(ratio), message).toBe(
          isPlainShareRatio(factor),
        );
        // Every stored session keeps a value for a revision observed before the event.
        const kept = days.slice(0, -1).filter((session) => {
          const basis = basisFactorAt({
            session,
            observedAt: `${days[0]}T12:00:00.000Z`,
            events: result.events,
          });
          return (
            basis.kind === "FACTOR" &&
            Math.abs(basis.factor / factor - 1) < 0.001
          );
        });
        expect(kept, message).toHaveLength(truth.length);
      }
    });
  }

  // A small distribution on a cheap stretch changes many closes by less than the rounding: those
  // sessions admit both 1 and the ratio, and must not read as a history stored on two bases.
  for (const [factor, start, drift] of [
    [1.005, 2, 0.0002],
    [1.011, 0.3, 0.0002],
    [1.003, 10, -0.0002],
    [1.001, 40, -0.0004],
  ] as const) {
    it(`measures a ${factor} distribution on a cheap history as one event, never an unexplained one`, () => {
      for (let seed = 1; seed <= 20; seed += 1) {
        const truth = walk(1_500, start, drift, seed);
        const days = sessions("2020-01-06", truth.length + 1, () => 0).map(
          (row) => row.date,
        );
        const stored = truth.map((price, index) => ({
          date: days[index]!,
          close: printed(price * factor),
        }));
        const fresh = [
          ...truth.map((price, index) => ({
            date: days[index]!,
            close: printed(price),
          })),
          { date: days.at(-1)!, close: printed(truth.at(-1)!) },
        ];
        const result = compare(stored, fresh);
        const message = `${factor}, seed ${seed}`;
        if (!result.changed) {
          continue;
        }
        expect(
          result.events.map((event) => event.kind),
          message,
        ).toEqual(["MEASURED"]);
        const event = result.events[0]!;
        // Measured as precisely as cent-rounded closes of a few dollars allow.
        expect(Math.abs(event.priceRatio! / factor - 1), message).toBeLessThan(
          0.003,
        );
        // Sessions certainly before it keep the measured factor for an older revision.
        const before = event.effectiveDate
          ? days.filter((day) => day < event.effectiveDate!)
          : days.filter((day) => day <= event.effectiveFrom!);
        for (const session of before.slice(0, 50)) {
          const basis = basisFactorAt({
            session,
            observedAt: `${days[0]}T12:00:00.000Z`,
            events: result.events,
          });
          expect(basis.kind, message).toBe("FACTOR");
        }
      }
    });
  }

  it("dates an event behind corrected newest sessions by the unchanged sessions after it", () => {
    const history = sessions("2026-01-05", 300, (index) =>
      printed(40 + Math.sin(index / 5) * 3),
    );
    const exIndex = 296;
    // Re-based for a 1.046 distribution on the 297th session; then the provider corrected the newest
    // stored session, or two of them.
    for (const corrected of [[299], [298, 299]]) {
      const current = history.map((row, index) =>
        index < exIndex ? { ...row, close: printed(row.close / 1.046) } : row,
      );
      const stored = history.map((row, index) =>
        corrected.includes(index)
          ? { ...row, close: printed(row.close * 1.01) }
          : row,
      );
      const result = compare(stored, current);
      expect(result.events, `${corrected}`).toHaveLength(1);
      expect(result.events[0], `${corrected}`).toMatchObject({
        kind: "MEASURED",
        effectiveDate: history[exIndex]!.date,
      });
    }
  });

  it("dates a split inside a history mixed before verification, whatever the rounding", () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const truth = walk(1_200, 30, 0.0003, seed);
      const days = sessions("2020-01-06", truth.length, () => 0).map(
        (row) => row.date,
      );
      // Rows stored before the split's ex-date on the old basis, from it on as traded.
      const exIndex = 1_000;
      const stored = truth.map((price, index) => ({
        date: days[index]!,
        close: printed(index < exIndex ? price * 2 : price),
      }));
      const fresh = truth.map((price, index) => ({
        date: days[index]!,
        close: printed(price),
      }));
      const result = compare(stored, fresh);
      expect(result.events, `seed ${seed}`).toHaveLength(1);
      expect(result.events[0], `seed ${seed}`).toMatchObject({
        kind: "MEASURED",
        effectiveDate: days[exIndex],
      });
      expect(result.events[0]!.priceRatio).toBeCloseTo(2, 2);
    }
  });

  it("treats corrected rows with ratios of their own as corrections", () => {
    const history = sessions("2026-01-05", 400, (index) =>
      printed(100 + (index % 7)),
    );
    const adjacent = history.map((row, index) =>
      index === 200
        ? { ...row, close: printed(row.close * 1.02) }
        : index === 201
          ? { ...row, close: printed(row.close * 0.97) }
          : row,
    );
    expect(compare(history, adjacent).events).toEqual([]);
    const newest = history.map((row, index) =>
      index >= 397
        ? { ...row, close: printed(row.close * (1 + (index - 396) / 200)) }
        : row,
    );
    expect(compare(history, newest).events).toEqual([]);
  });
});

describe("isPlainShareRatio", () => {
  it("passes ordinary splits and reverse splits, within half a percent", () => {
    for (const ratio of [
      2,
      1.5,
      4,
      0.1,
      20,
      1 / 32,
      3,
      0.5,
      1.25,
      7,
      4.0013,
      9.9899,
    ]) {
      expect(isPlainShareRatio(ratio)).toBe(true);
    }
  });

  it("fails every observed distribution, combined event and stock dividend, and no change", () => {
    for (const ratio of [
      523 / 500,
      131 / 125,
      1323 / 1000,
      10000 / 8753,
      1011 / 1000,
      1907 / 2000,
      5000 / 2399,
      331 / 250,
      1.1963,
      51 / 50,
      11 / 10,
      8 / 7,
      9 / 5,
      1,
      0,
      Number.NaN,
    ]) {
      expect(isPlainShareRatio(ratio)).toBe(false);
    }
  });
});

describe("basisFactorAt", () => {
  const event = (fields: Partial<PriceBasisEvent>): PriceBasisEvent => ({
    securityId: SECURITY,
    generation: 2,
    kind: "MEASURED",
    detectedAt: "2026-10-07T12:00:00.000Z",
    evidence: {
      runs: [],
      comparedSessions: 0,
      changedSessions: 0,
      unfittedSessions: 0,
    },
    ...fields,
  });
  const split = event({ effectiveDate: "2026-10-06", priceRatio: 4 });

  it("is 1 with no re-base, or with one detected before the revision was observed", () => {
    expect(
      basisFactorAt({
        session: "2020-01-02",
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [],
      }),
    ).toEqual({ kind: "FACTOR", factor: 1 });
    expect(
      basisFactorAt({
        session: "2020-01-02",
        observedAt: "2026-10-08T00:00:00.000Z",
        events: [split],
      }),
    ).toEqual({ kind: "FACTOR", factor: 1 });
  });

  it("restores the close a revision observed before the event was read against", () => {
    expect(
      basisFactorAt({
        session: "2026-10-05",
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [split],
      }),
    ).toEqual({ kind: "FACTOR", factor: 4 });
  });

  it("withholds a session on or after the event when the revision predates its detection", () => {
    expect(
      basisFactorAt({
        session: "2026-10-06",
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [split],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "AFTER_REBASE" });
  });

  it("withholds a revision observed between the event's date and its detection", () => {
    expect(
      basisFactorAt({
        session: "2026-10-02",
        observedAt: "2026-10-06T23:00:00.000Z",
        events: [split],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "OBSERVED_DURING_REBASE" });
  });

  it("applies an undated event only where both the session and the observation precede its interval", () => {
    const undated = event({
      effectiveFrom: "2026-09-28",
      effectiveTo: "2026-10-06",
      priceRatio: 3,
    });
    expect(
      basisFactorAt({
        session: "2026-09-28",
        observedAt: "2026-09-28T20:00:00.000Z",
        events: [undated],
      }),
    ).toEqual({ kind: "FACTOR", factor: 3 });
    expect(
      basisFactorAt({
        session: "2026-09-29",
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [undated],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "UNDATED_REBASE" });
    expect(
      basisFactorAt({
        session: "2026-09-01",
        observedAt: "2026-09-30T00:00:00.000Z",
        events: [undated],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "UNDATED_REBASE" });
    // The interval's last session is on the new basis.
    expect(
      basisFactorAt({
        session: "2026-10-06",
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [undated],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "AFTER_REBASE" });
    expect(
      basisFactorAt({
        session: "2026-10-06",
        observedAt: "2026-10-08T00:00:00.000Z",
        events: [undated],
      }),
    ).toEqual({ kind: "FACTOR", factor: 1 });
  });

  it("stops withholding after an interval the detection ended", () => {
    // Re-based before the provider published a session after the newest stored one.
    const ahead = event({
      effectiveFrom: "2026-10-01",
      effectiveTo: "2026-10-07",
      priceRatio: 1.046,
    });
    expect(
      basisFactorAt({
        session: "2027-06-01",
        observedAt: "2027-05-01T00:00:00.000Z",
        events: [ahead],
      }),
    ).toEqual({ kind: "FACTOR", factor: 1 });
    expect(
      basisFactorAt({
        session: "2026-10-02",
        observedAt: "2027-05-01T00:00:00.000Z",
        events: [ahead],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "UNDATED_REBASE" });
  });

  it("withholds every session an unbounded unexplained change may reach", () => {
    expect(
      basisFactorAt({
        session: "2001-01-02",
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [event({ kind: "UNEXPLAINED", effectiveTo: "2005-03-01" })],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "UNEXPLAINED_REBASE" });
    expect(
      basisFactorAt({
        session: "2020-01-02",
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [event({ kind: "UNEXPLAINED", effectiveTo: "2005-03-01" })],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "UNEXPLAINED_REBASE" });
  });

  it("withholds only the sessions a bounded unexplained change touched", () => {
    const block = event({
      kind: "UNEXPLAINED",
      effectiveFrom: "2005-01-03",
      effectiveTo: "2005-03-01",
    });
    const at = (session: string) =>
      basisFactorAt({
        session,
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [block],
      });
    expect(at("2001-01-02")).toEqual({ kind: "FACTOR", factor: 1 });
    expect(at("2005-02-01")).toEqual({
      kind: "WITHHELD",
      reason: "UNEXPLAINED_REBASE",
    });
    expect(at("2010-01-04")).toEqual({ kind: "FACTOR", factor: 1 });
  });

  it("needs nothing for a revision observed after a measured split, on either side of it", () => {
    for (const session of ["2026-10-02", "2026-10-09"]) {
      expect(
        basisFactorAt({
          session,
          observedAt: "2026-10-08T00:00:00.000Z",
          events: [split],
        }),
      ).toEqual({ kind: "FACTOR", factor: 1 });
    }
  });

  it("withholds a session before a possible distribution for a revision observed after it", () => {
    // A quarter filed before the event but first observed after its detection: its count is
    // unchanged by a distribution, while the close before the event carries the factor.
    const spinOff = event({ effectiveDate: "2026-10-06", priceRatio: 1.046 });
    expect(
      basisFactorAt({
        session: "2026-10-02",
        observedAt: "2026-10-08T00:00:00.000Z",
        events: [spinOff],
      }),
    ).toEqual({ kind: "WITHHELD", reason: "BEFORE_DISTRIBUTION" });
    expect(
      basisFactorAt({
        session: "2026-10-09",
        observedAt: "2026-10-08T00:00:00.000Z",
        events: [spinOff],
      }),
    ).toEqual({ kind: "FACTOR", factor: 1 });
  });

  it("multiplies the ratios of every later event", () => {
    expect(
      basisFactorAt({
        session: "2020-01-02",
        observedAt: "2026-09-01T00:00:00.000Z",
        events: [
          split,
          event({
            effectiveDate: "2027-03-01",
            priceRatio: 1.05,
            detectedAt: "2027-03-01T15:00:00.000Z",
          }),
        ],
      }),
    ).toEqual({ kind: "FACTOR", factor: 4 * 1.05 });
  });
});

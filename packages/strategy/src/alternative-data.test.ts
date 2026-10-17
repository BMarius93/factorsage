import {
  alternativeDataMetricSignature,
  type AlternativeDataMetric,
} from "@intrinsic/contracts";
import { alternativeDataAvailabilityDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  alternativeDataColumnRequest,
  alternativeDataOperand,
  alternativeDataRequests,
  buildAlternativeDataColumn,
  operandAlternativeDataMetric,
  requiredAlternativeDataLeadingSessions,
  type AlternativeDataObservation,
} from "./alternative-data.js";
import { collectOperands, metricOperand, PRICE_OPERAND } from "./operands.js";
import { evaluateConditionValues } from "./predicates.js";
import { Evaluability } from "./evaluability.js";

/**
 * The pure alternative-data evaluator.
 *
 * Every point-in-time guarantee this feature makes is decided in `buildAlternativeDataColumn`, so
 * this suite is where they are proved: that a disclosure never counts before it was public, that the
 * observable session is the next session the frame actually holds, that a window partly outside the
 * ingested history is NOT_EVALUABLE rather than short, and that a genuine zero stays a zero.
 */

/** Ten consecutive weekdays, Monday to Friday twice, as a frame axis. */
const WEEK_ONE: readonly string[] = [
  "2026-03-02",
  "2026-03-03",
  "2026-03-04",
  "2026-03-05",
  "2026-03-06",
  "2026-03-09",
  "2026-03-10",
  "2026-03-11",
  "2026-03-12",
  "2026-03-13",
];

function column(
  input: {
    dates?: readonly string[];
    lookbackSessions?: number;
    aggregation?: Parameters<
      typeof buildAlternativeDataColumn
    >[0]["request"]["aggregation"];
    coverage?: { from: string; to: string } | null;
    observations?: readonly AlternativeDataObservation[];
  } = {},
): number[] {
  const dates = input.dates ?? WEEK_ONE;
  return [
    ...buildAlternativeDataColumn({
      dates,
      request: {
        lookbackSessions: input.lookbackSessions ?? 3,
        aggregation: input.aggregation ?? "DISTINCT_ACTORS",
      },
      facts: {
        coverage:
          input.coverage === undefined
            ? { from: dates[0] as string, to: dates[dates.length - 1] as string }
            : input.coverage,
        observations: input.observations ?? [],
      },
    }),
  ];
}

const nan = Number.NaN;

// ---------------------------------------------------------------------------
// Operand identity
// ---------------------------------------------------------------------------

const insiderBuyers20: AlternativeDataMetric = {
  kind: "INSIDER_ACTIVITY",
  measure: "BUYERS",
  lookback: 20,
};

const congressPurchases30: AlternativeDataMetric = {
  kind: "CONGRESS_ACTIVITY",
  measure: "PURCHASES",
  lookback: 30,
  scope: { kind: "GROUP", groupId: "group-1" },
  chamber: "SENATE",
};

describe("alternative-data operand keys", () => {
  it("prefixes the canonical signature and round-trips", () => {
    const key = alternativeDataOperand(insiderBuyers20);
    expect(key).toBe(`alt:${alternativeDataMetricSignature(insiderBuyers20)}`);
    expect(operandAlternativeDataMetric(key)).toEqual(insiderBuyers20);
  });

  it("is what `metricOperand` answers for an alternative-data metric", () => {
    expect(metricOperand(insiderBuyers20)).toBe(
      alternativeDataOperand(insiderBuyers20),
    );
    expect(metricOperand(congressPurchases30)).toBe(
      alternativeDataOperand(congressPurchases30),
    );
  });

  it("answers null for a key that addresses something else", () => {
    expect(operandAlternativeDataMetric(PRICE_OPERAND)).toBeNull();
    expect(operandAlternativeDataMetric("series:SMA_50D")).toBeNull();
    expect(operandAlternativeDataMetric("relative-volume:20")).toBeNull();
    // A drifted or hand-written key is refused rather than decoded into something else.
    expect(operandAlternativeDataMetric("alt:NOT_A_METRIC|X|1")).toBeNull();
  });

  it("gives one column to two strategies naming one configured metric", () => {
    expect(alternativeDataOperand({ ...insiderBuyers20 })).toBe(
      alternativeDataOperand(insiderBuyers20),
    );
    expect(
      alternativeDataOperand({ ...insiderBuyers20, lookback: 60 }),
    ).not.toBe(alternativeDataOperand(insiderBuyers20));
  });

  it("is collected from a strategy definition beside every other operand", () => {
    const operands = collectOperands({
      schemaVersion: 2,
      buyLevels: [
        {
          id: "b1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c1",
                metric: insiderBuyers20,
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 1 },
              },
              {
                id: "c2",
                metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
                operator: "IS_BELOW",
                value: { kind: "NUMBER", value: 30 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
      finalExit: {
        id: "fx",
        rules: [
          {
            id: "r1",
            signal: {
              conditions: [
                {
                  id: "c3",
                  metric: congressPurchases30,
                  operator: "IS_ABOVE",
                  value: { kind: "NUMBER", value: 0 },
                },
              ],
            },
          },
        ],
      },
    });
    expect(operands).toContain(alternativeDataOperand(insiderBuyers20));
    expect(operands).toContain(alternativeDataOperand(congressPurchases30));
    expect(operands).toContain(PRICE_OPERAND);
    expect(operands).toContain("series:RSI_14D");
    // Stable and deduplicated, so two runs of one definition request identical projections.
    expect(operands).toEqual([...operands].sort());
  });

  it("reports the widest lookback a set of operands needs as leading context", () => {
    expect(
      requiredAlternativeDataLeadingSessions([
        PRICE_OPERAND,
        "series:SMA_200D",
        alternativeDataOperand(insiderBuyers20),
        alternativeDataOperand(congressPurchases30),
      ]),
    ).toBe(30);
    expect(
      requiredAlternativeDataLeadingSessions([PRICE_OPERAND, "series:SMA_200D"]),
    ).toBe(0);
  });

  it("resolves the aggregation and window from the metric's registry entry", () => {
    expect(alternativeDataColumnRequest(insiderBuyers20)).toEqual({
      lookbackSessions: 20,
      aggregation: "DISTINCT_ACTORS",
    });
    expect(
      alternativeDataColumnRequest({
        kind: "INSIDER_ACTIVITY",
        measure: "PURCHASE_VALUE",
        lookback: 20,
      }),
    ).toEqual({ lookbackSessions: 20, aggregation: "SUM_AMOUNT" });
    expect(
      alternativeDataRequests([
        PRICE_OPERAND,
        alternativeDataOperand(insiderBuyers20),
      ]),
    ).toEqual([
      {
        key: alternativeDataOperand(insiderBuyers20),
        metric: insiderBuyers20,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// No look-ahead
// ---------------------------------------------------------------------------

describe("no look-ahead across transaction date and disclosure date", () => {
  it("counts a disclosure from the session after it was published, never from the trade", () => {
    // Traded on the 3rd, filed on the 10th: a reader on the 4th knew nothing.
    const observations = [
      {
        observableFrom: alternativeDataAvailabilityDate("2026-03-10"),
        actorKey: "cik-1",
      },
    ];
    expect(column({ lookbackSessions: 3, observations })).toEqual([
      nan,
      nan,
      0,
      0,
      0,
      0,
      0,
      // 2026-03-11 is the session on or after the availability date 2026-03-11.
      1,
      1,
      1,
    ]);
  });

  it("never credits the publication date itself", () => {
    // Filed on the 4th. The filing date carries no time, so the 4th cannot be proven; the 5th can.
    const observations = [
      {
        observableFrom: alternativeDataAvailabilityDate("2026-03-04"),
        actorKey: "cik-1",
      },
    ];
    const values = column({ lookbackSessions: 1, observations });
    expect(values[2]).toBe(0);
    expect(values[3]).toBe(1);
  });

  it("drops a disclosure out of the window once the lookback has passed", () => {
    const observations = [
      { observableFrom: "2026-03-04", actorKey: "cik-1" },
    ];
    expect(column({ lookbackSessions: 3, observations })).toEqual([
      nan,
      nan,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
    ]);
  });
});

describe("the observable session", () => {
  it("is the next session when a filing publishes over a weekend", () => {
    // Published Saturday 2026-03-07 -> available Sunday the 8th -> first session Monday the 9th.
    const values = column({
      lookbackSessions: 1,
      observations: [{ observableFrom: "2026-03-08", actorKey: "cik-1" }],
    });
    expect(values[4]).toBe(0);
    expect(values[5]).toBe(1);
  });

  it("is the next session when a filing publishes on an exchange holiday", () => {
    // A frame whose axis simply has no row for the closed day is all the calendar knowledge needed.
    const dates = [
      "2026-11-24",
      "2026-11-25",
      // 2026-11-26 is Thanksgiving: the venue does not open and the axis has no row.
      "2026-11-27",
      "2026-11-30",
    ];
    const values = column({
      dates,
      lookbackSessions: 1,
      coverage: { from: "2026-11-24", to: "2026-11-30" },
      observations: [{ observableFrom: "2026-11-26", actorKey: "cik-1" }],
    });
    expect(values).toEqual([0, 0, 1, 0]);
  });

  it("ignores a disclosure that only becomes public after the frame ends", () => {
    expect(
      column({
        lookbackSessions: 3,
        observations: [{ observableFrom: "2026-04-01", actorKey: "cik-1" }],
      }).slice(2),
    ).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("ignores a disclosure whose own session precedes the frame", () => {
    // Its observable session is a day the frame does not contain, so pulling it onto index 0 would
    // count it inside windows it was never in.
    expect(
      column({
        lookbackSessions: 3,
        coverage: { from: "2026-01-01", to: "2026-03-13" },
        observations: [{ observableFrom: "2026-02-02", actorKey: "cik-1" }],
      })[2],
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

describe("coverage", () => {
  it("reports nothing at all without coverage", () => {
    expect(column({ coverage: null, observations: [] })).toEqual(
      new Array(10).fill(nan),
    );
  });

  it("is NOT_EVALUABLE, never zero, before the history the product holds", () => {
    const values = column({
      lookbackSessions: 3,
      coverage: { from: "2026-03-06", to: "2026-03-13" },
    });
    // A window reaching back before 2026-03-06 cannot be counted completely. The first session whose
    // whole three-session window sits inside coverage is 2026-03-10, whose window opens on the 6th.
    expect(values.slice(0, 6)).toEqual([nan, nan, nan, nan, nan, nan]);
    expect(values.slice(6)).toEqual([0, 0, 0, 0]);
  });

  it("is NOT_EVALUABLE after the last refresh", () => {
    const values = column({
      lookbackSessions: 3,
      coverage: { from: "2026-03-02", to: "2026-03-10" },
    });
    expect(values.slice(2, 7)).toEqual([0, 0, 0, 0, 0]);
    expect(values.slice(7)).toEqual([nan, nan, nan]);
  });

  it("is NOT_EVALUABLE while the frame has no complete window", () => {
    expect(column({ lookbackSessions: 5 }).slice(0, 4)).toEqual([
      nan,
      nan,
      nan,
      nan,
    ]);
    expect(column({ lookbackSessions: 5 })[4]).toBe(0);
  });

  it("keeps a real zero a zero, so a rule can act on the absence of activity", () => {
    const values = column({ lookbackSessions: 3, observations: [] });
    expect(values[9]).toBe(0);
    // "No insider sold" is `is below 1` on a whole-number count.
    expect(evaluateConditionValues("IS_BELOW", values[9] as number, 1)).toBe(
      Evaluability.TRUE,
    );
    expect(evaluateConditionValues("IS_BELOW", values[0] as number, 1)).toBe(
      Evaluability.NOT_EVALUABLE,
    );
  });
});

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

describe("aggregations", () => {
  const observations: AlternativeDataObservation[] = [
    { observableFrom: "2026-03-04", actorKey: "cik-1", amount: 100 },
    { observableFrom: "2026-03-04", actorKey: "cik-1", amount: 250 },
    { observableFrom: "2026-03-05", actorKey: "cik-2", amount: 50 },
    // No amount at all: the source priced it at zero, so it adds nothing rather than $0.
    { observableFrom: "2026-03-05", actorKey: "cik-3" },
  ];

  it("counts distinct actors, so one person filing twice counts once", () => {
    expect(
      column({ lookbackSessions: 3, aggregation: "DISTINCT_ACTORS", observations }),
    ).toEqual([nan, nan, 1, 3, 3, 2, 0, 0, 0, 0]);
  });

  it("counts events, so one person filing twice counts twice", () => {
    expect(
      column({ lookbackSessions: 3, aggregation: "EVENT_COUNT", observations }),
    ).toEqual([nan, nan, 2, 4, 4, 2, 0, 0, 0, 0]);
  });

  it("sums amounts and skips the facts that state none", () => {
    expect(
      column({ lookbackSessions: 3, aggregation: "SUM_AMOUNT", observations }),
    ).toEqual([nan, nan, 350, 400, 400, 50, 0, 0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe("determinism", () => {
  const observations: AlternativeDataObservation[] = [
    { observableFrom: "2026-03-11", actorKey: "c", amount: 3 },
    { observableFrom: "2026-03-04", actorKey: "a", amount: 1 },
    { observableFrom: "2026-03-06", actorKey: "b", amount: 2 },
    { observableFrom: "2026-03-04", actorKey: "b", amount: 4 },
  ];

  it("does not depend on the order observations arrive in", () => {
    const forwards = column({ lookbackSessions: 4, observations });
    const backwards = column({
      lookbackSessions: 4,
      observations: [...observations].reverse(),
    });
    expect(backwards).toEqual(forwards);
  });

  it("gives the same column twice for the same input", () => {
    expect(column({ lookbackSessions: 4, observations })).toEqual(
      column({ lookbackSessions: 4, observations }),
    );
  });

  it("agrees with a naive per-session recount", () => {
    // The sliding window is an optimization; this is the definition it must match.
    const dates = WEEK_ONE;
    const lookback = 4;
    const built = column({ lookbackSessions: lookback, observations });
    for (let index = 0; index < dates.length; index += 1) {
      if (index < lookback - 1) {
        expect(built[index]).toBeNaN();
        continue;
      }
      const start = dates[index - lookback + 1] as string;
      const end = dates[index] as string;
      const expected = new Set(
        observations
          .filter(
            (observation) =>
              observation.observableFrom > (dates[index - lookback] ?? "") &&
              observation.observableFrom <= end &&
              observation.observableFrom >= start,
          )
          .map((observation) => observation.actorKey),
      ).size;
      expect(built[index], `${end}`).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Chunked execution: a calendar-year window must read what the whole period reads
// ---------------------------------------------------------------------------

/**
 * The invariant the annual execution window depends on.
 *
 * A backtest does not project its whole period at once: it reads one calendar year at a time, each
 * widened by leading context, and the day loop consumes the windows in order. So every column the
 * engine evaluates inside year *N* is built from a frame that begins shortly before year *N*, not
 * from the run's first session — and if that widening is not at least the metric's own lookback, the
 * first sessions of **every year after the first** report NOT_EVALUABLE instead of a count.
 *
 * That failure is close to invisible: the run completes, the numbers look plausible, and a strategy
 * naming a 90-session insider window simply never fires in January. These cases state the property
 * directly — a windowed read agrees with a whole-period read, session for session — and then show
 * what happens when the widening is one session short, so the test cannot pass for the wrong reason.
 */
describe("chunked windows agree with the whole period", () => {
  /** Three years of weekday sessions, which is enough for two year boundaries. */
  const SESSIONS: readonly string[] = (() => {
    const dates: string[] = [];
    for (
      let day = Date.UTC(2024, 0, 1);
      day <= Date.UTC(2026, 11, 31);
      day += 86_400_000
    ) {
      const date = new Date(day);
      const weekday = date.getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        dates.push(date.toISOString().slice(0, 10));
      }
    }
    return dates;
  })();

  /** One disclosure every eleven sessions, by rotating actors, across the whole axis. */
  const OBSERVATIONS: readonly AlternativeDataObservation[] = SESSIONS.filter(
    (_, index) => index % 11 === 0,
  ).map((date, index) => ({
    observableFrom: date,
    actorKey: `actor-${index % 4}`,
    amount: 1_000 * (index + 1),
  }));

  const COVERAGE = {
    from: SESSIONS[0] as string,
    to: SESSIONS[SESSIONS.length - 1] as string,
  };

  const build = (
    dates: readonly string[],
    lookbackSessions: number,
    aggregation: Parameters<
      typeof buildAlternativeDataColumn
    >[0]["request"]["aggregation"],
  ): number[] => [
    ...buildAlternativeDataColumn({
      dates,
      request: { lookbackSessions, aggregation },
      facts: { coverage: COVERAGE, observations: OBSERVATIONS },
    }),
  ];

  /** The sessions of one calendar year, plus `leading` sessions of context before it. */
  function windowFor(
    year: number,
    leading: number,
  ): { dates: readonly string[]; firstEvaluated: number } {
    const start = SESSIONS.findIndex((date) => date.startsWith(`${year}-`));
    const endExclusive =
      SESSIONS.findIndex((date) => date > `${year}-12-31`) === -1
        ? SESSIONS.length
        : SESSIONS.findIndex((date) => date > `${year}-12-31`);
    const from = Math.max(0, start - leading);
    return {
      dates: SESSIONS.slice(from, endExclusive),
      firstEvaluated: start - from,
    };
  }

  for (const aggregation of [
    "DISTINCT_ACTORS",
    "EVENT_COUNT",
    "SUM_AMOUNT",
  ] as const) {
    for (const lookback of [20, 90, 250]) {
      it(`reads ${aggregation} ${lookback}D identically in every year when widened by its lookback`, () => {
        const whole = build(SESSIONS, lookback, aggregation);
        for (const year of [2025, 2026]) {
          // `requiredAlternativeDataLeadingSessions` is what the loader widens by, so the widening
          // under test is the product's own answer rather than a number this test chose.
          const leading = requiredAlternativeDataLeadingSessions([
            alternativeDataOperand({
              kind: "INSIDER_ACTIVITY",
              measure: "BUYERS",
              lookback: lookback as 20 | 90 | 250,
            }),
          ]);
          expect(leading).toBe(lookback);
          const window = windowFor(year, leading);
          const chunk = build(window.dates, lookback, aggregation);
          const offset = SESSIONS.indexOf(window.dates[0] as string);
          for (
            let index = window.firstEvaluated;
            index < window.dates.length;
            index += 1
          ) {
            expect(chunk[index]).toBe(whole[offset + index]);
          }
        }
      });
    }
  }

  it("reports NOT_EVALUABLE in year two when the widening is too short", () => {
    // The counterpart, so the agreement above is a property of the widening rather than of the data.
    // A window of `lookback` sessions ending on the year's first evaluated session needs
    // `lookback - 1` sessions of context; the product widens by `lookback`, which is that plus one
    // session of margin. At `lookback - 2` the window no longer fits and the session is undecidable —
    // which is exactly the silent January-shaped hole a too-narrow widening would produce.
    const lookback = 90;
    const window = windowFor(2025, lookback - 2);
    const chunk = build(window.dates, lookback, "EVENT_COUNT");
    expect(chunk[window.firstEvaluated]).toBeNaN();
    const whole = build(SESSIONS, lookback, "EVENT_COUNT");
    const offset = SESSIONS.indexOf(window.dates[0] as string);
    expect(whole[offset + window.firstEvaluated]).not.toBeNaN();
  });

  it("counts a disclosure once, never twice, when consecutive windows overlap", () => {
    // Consecutive years share their leading context, so one disclosure appears in two frames. It
    // must still be one event in each — a window that accumulated across chunks would double it.
    const lookback = 20;
    const first = windowFor(2025, lookback);
    const second = windowFor(2026, lookback);
    const overlap = first.dates.filter((date) => second.dates.includes(date));
    expect(overlap.length).toBeGreaterThan(0);
    const firstColumn = build(first.dates, lookback, "EVENT_COUNT");
    const secondColumn = build(second.dates, lookback, "EVENT_COUNT");
    for (const date of overlap) {
      const inFirst = firstColumn[first.dates.indexOf(date)];
      const inSecond = secondColumn[second.dates.indexOf(date)];
      // Both frames physically contain the whole window for a shared session only where the second
      // frame's own leading context reaches back far enough; where it does, the counts must agree.
      if (
        inFirst !== undefined &&
        inSecond !== undefined &&
        !Number.isNaN(inFirst) &&
        !Number.isNaN(inSecond)
      ) {
        expect(inSecond).toBe(inFirst);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Directly selected members
// ---------------------------------------------------------------------------

describe("a selection of members", () => {
  const scopedTo = (
    scope: Extract<AlternativeDataMetric, { kind: "CONGRESS_ACTIVITY" }>["scope"],
  ): AlternativeDataMetric => ({
    kind: "CONGRESS_ACTIVITY",
    measure: "PURCHASES",
    lookback: 30,
    scope,
    chamber: "ANY",
  });

  it("addresses one column however the selection was written", () => {
    const key = alternativeDataOperand(
      scopedTo({ kind: "ACTORS", actorIds: ["m-2", "m-1", "m-2"] }),
    );
    expect(key).toBe(
      alternativeDataOperand(
        scopedTo({ kind: "ACTORS", actorIds: ["m-1", "m-2"] }),
      ),
    );
    // The key carries the selection, so the loader needs nothing but the key to know whom to read.
    expect(operandAlternativeDataMetric(key)).toEqual(
      scopedTo({ kind: "ACTORS", actorIds: ["m-1", "m-2"] }),
    );
  });

  it("shares its column with the legacy single-actor rule it replaces", () => {
    const legacy = alternativeDataOperand(
      scopedTo({ kind: "ACTOR", actorId: "m-1" }),
    );
    const selected = alternativeDataOperand(
      scopedTo({ kind: "ACTORS", actorIds: ["m-1"] }),
    );
    expect(selected).toBe(legacy);
    expect(operandAlternativeDataMetric(legacy)).toEqual(
      scopedTo({ kind: "ACTORS", actorIds: ["m-1"] }),
    );
  });

  it("gives two different selections two columns", () => {
    const keys = new Set(
      [
        scopedTo({ kind: "ANY" }),
        scopedTo({ kind: "ACTORS", actorIds: ["m-1"] }),
        scopedTo({ kind: "ACTORS", actorIds: ["m-2"] }),
        scopedTo({ kind: "ACTORS", actorIds: ["m-1", "m-2"] }),
        scopedTo({ kind: "GROUP", groupId: "group-1" }),
      ].map(alternativeDataOperand),
    );
    expect(keys.size).toBe(5);
  });

  it("refuses to build a key for a scope it cannot interpret", () => {
    expect(() =>
      alternativeDataOperand(
        scopedTo({ kind: "COMMITTEE" } as unknown as { kind: "ANY" }),
      ),
    ).toThrow(/Unsupported actor scope kind/);
  });

  it("is collected and requested like any other configured metric", () => {
    const metric = scopedTo({ kind: "ACTORS", actorIds: ["m-2", "m-1"] });
    const operands = collectOperands({
      schemaVersion: 2,
      buyLevels: [
        {
          id: "b1",
          percentage: 100,
          signal: {
            conditions: [
              {
                id: "c1",
                metric,
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 1 },
              },
            ],
          },
        },
      ],
      sellLevels: [],
    });
    expect(operands).toContain(alternativeDataOperand(metric));
    expect(requiredAlternativeDataLeadingSessions(operands)).toBe(30);
    expect(
      alternativeDataRequests(operands).map((request) => request.metric),
    ).toEqual([scopedTo({ kind: "ACTORS", actorIds: ["m-1", "m-2"] })]);
  });

  /**
   * The selection is a membership filter and the measure aggregates the pool. With one purchase
   * each from two selected members, `Congress purchases is above 1` holds — the count is two — where
   * an OR between two separately evaluated rules would never hold, each side being one.
   */
  it("pools the selected members' disclosures into one metric", () => {
    const pooled: AlternativeDataObservation[] = [
      { observableFrom: "2026-03-03", actorKey: "m-1", amount: 1_001 },
      { observableFrom: "2026-03-04", actorKey: "m-2", amount: 15_001 },
    ];
    const read = (
      aggregation: "EVENT_COUNT" | "DISTINCT_ACTORS" | "SUM_AMOUNT",
      observations: readonly AlternativeDataObservation[],
    ) => column({ aggregation, observations, lookbackSessions: 5 });

    const events = read("EVENT_COUNT", pooled);
    expect(events.slice(4, 6)).toEqual([2, 2]);
    expect(read("DISTINCT_ACTORS", pooled).slice(4, 6)).toEqual([2, 2]);
    expect(read("SUM_AMOUNT", pooled).slice(4, 6)).toEqual([16_002, 16_002]);

    const isAboveOne = (values: number[]) =>
      values.map((value) =>
        evaluateConditionValues("IS_ABOVE", value, 1),
      );
    // Pooled: true once both disclosures are inside the window.
    expect(isAboveOne(events)[4]).toBe(Evaluability.TRUE);
    // Each member alone never clears the threshold, so ORing the two would never be true.
    for (const alone of [[pooled[0]!], [pooled[1]!]]) {
      expect(
        isAboveOne(read("EVENT_COUNT", alone)).filter(
          (result) => result === Evaluability.TRUE,
        ),
      ).toEqual([]);
    }
  });
});

/**
 * Pre-release audit 2026-10-16, finding ALT-01 (`docs/audits/pre-release-audit-2026-10-16.md`).
 *
 * The money measures keep a running float total that adds each disclosure as it enters the window
 * and subtracts it as it leaves. Amounts with cents are not dyadic, so after a window empties the
 * total is a residue of the order of 1e-12 rather than exactly zero, and `purchase value is above
 * $0` — the natural "any purchase" rule, whose MONEY domain starts at 0 — reads TRUE on a session
 * whose window holds no purchase at all. The residue also depends on where the frame starts, so a
 * backtest's year windows and a Monitor's read can disagree on the same session.
 *
 * Both cases are written as the product's own promise ("a genuine zero stays a zero"). They failed on
 * `bebf3dc7`; the window now sums whole ten-thousandths of a dollar.
 */
describe("ALT-01: an emptied money window reads exactly zero", () => {
  const dates = [
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
    "2026-01-08",
    "2026-01-09",
    "2026-01-12",
  ];
  const coverage = { from: "2026-01-01", to: "2026-01-31" };
  const purchases: AlternativeDataObservation[] = [
    { observableFrom: "2026-01-05", actorKey: "a", amount: 52_341.25 },
    { observableFrom: "2026-01-06", actorKey: "b", amount: 1_817.33 },
    { observableFrom: "2026-01-07", actorKey: "c", amount: 99_999.99 },
    { observableFrom: "2026-01-08", actorKey: "d", amount: 12.07 },
  ];

  it("reads 0 on the first session whose two-session window holds no disclosure", () => {
    const column = buildAlternativeDataColumn({
      dates,
      request: { lookbackSessions: 2, aggregation: "SUM_AMOUNT" },
      facts: { coverage, observations: purchases },
    });
    const events = buildAlternativeDataColumn({
      dates,
      request: { lookbackSessions: 2, aggregation: "EVENT_COUNT" },
      facts: { coverage, observations: purchases },
    });
    expect(events[5]).toBe(0);
    expect(Object.is(column[5], 0)).toBe(true);
  });

  it("never satisfies `is above $0` on a session with no disclosure in its window", () => {
    const column = buildAlternativeDataColumn({
      dates,
      request: { lookbackSessions: 2, aggregation: "SUM_AMOUNT" },
      facts: { coverage, observations: purchases },
    });
    expect(
      evaluateConditionValues("IS_ABOVE", column[5] as number, 0),
    ).toBe(Evaluability.FALSE);
  });
});

/**
 * ALT-01, against an independent arithmetic: every session's money window recomputed from scratch in
 * `BigInt` ten-thousandths, over seeded amounts with cents and fractional cents (stored
 * `Decimal(24,4)` money), several disclosures a session, several lookbacks and frame starts. The
 * production column must equal the exact sum to the last bit — and be exactly 0 wherever the window
 * holds no amount — whichever session the frame starts on.
 */
describe("money windows equal an exact, independent sum", () => {
  function seeded(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 4_294_967_296;
    };
  }

  const random = seeded(20_261_016);
  const sessions: string[] = [];
  for (
    let day = Date.UTC(2025, 0, 1);
    day <= Date.UTC(2026, 5, 30);
    day += 86_400_000
  ) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      sessions.push(new Date(day).toISOString().slice(0, 10));
    }
  }
  /** Ten-thousandths, as stored: 0.0001 to 250,000.0000, many of them not dyadic. */
  const observations: AlternativeDataObservation[] = [];
  for (const date of sessions) {
    const count = random() < 0.35 ? Math.floor(random() * 4) : 0;
    for (let index = 0; index < count; index += 1) {
      const units = 1 + Math.floor(random() * 2_500_000_000);
      observations.push({
        observableFrom: date,
        actorKey: `actor-${Math.floor(random() * 6)}`,
        amount: units / 10_000,
      });
    }
  }
  const coverage = {
    from: sessions[0] as string,
    to: sessions[sessions.length - 1] as string,
  };

  /** The exact window sum, recomputed from nothing for one session. */
  function exactSum(dates: readonly string[], index: number, lookback: number) {
    const from = dates[index - lookback + 1] as string;
    const to = dates[index] as string;
    let units = 0n;
    for (const observation of observations) {
      if (observation.observableFrom >= from && observation.observableFrom <= to) {
        units += BigInt(Math.round((observation.amount ?? 0) * 10_000));
      }
    }
    return units;
  }

  for (const lookback of [1, 5, 20, 90]) {
    for (const start of [0, 37, 211]) {
      it(`SUM_AMOUNT ${lookback}D from session ${start} is exact on every session`, () => {
        const dates = sessions.slice(start);
        const column = buildAlternativeDataColumn({
          dates,
          request: { lookbackSessions: lookback, aggregation: "SUM_AMOUNT" },
          facts: { coverage, observations },
        });
        let emptied = 0;
        for (let index = lookback - 1; index < dates.length; index += 1) {
          const exact = exactSum(dates, index, lookback);
          expect(column[index]).toBe(Number(exact) / 10_000);
          if (exact === 0n) {
            emptied += 1;
            expect(Object.is(column[index], 0)).toBe(true);
            expect(evaluateConditionValues("IS_ABOVE", column[index] as number, 0)).toBe(
              Evaluability.FALSE,
            );
          }
        }
        if (lookback <= 5) {
          // The premise of ALT-01 is reached: windows do empty after holding money.
          expect(emptied).toBeGreaterThan(0);
        }
      });
    }
  }
});

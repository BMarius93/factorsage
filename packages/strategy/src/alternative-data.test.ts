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
                operator: "IS_AT_LEAST",
                value: { kind: "NUMBER", value: 2 },
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
                  operator: "IS_AT_LEAST",
                  value: { kind: "NUMBER", value: 1 },
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
    expect(
      evaluateConditionValues("IS_AT_MOST", values[9] as number, 0),
    ).toBe(Evaluability.TRUE);
    expect(
      evaluateConditionValues("IS_AT_MOST", values[0] as number, 0),
    ).toBe(Evaluability.NOT_EVALUABLE);
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

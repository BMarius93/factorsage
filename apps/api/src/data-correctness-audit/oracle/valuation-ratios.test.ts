import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createValuationOracle,
  oracleCompare,
  oracleDecimal,
  oracleExactDouble,
  oracleNearestDouble,
  oracleRational,
  type OracleValuationOutcome,
  type OracleValuationSecurity,
  type OracleValuationStatement,
} from "./valuation-ratios";
import {
  HAND_RATIO_IDS,
  RESTATEMENT_THRESHOLDS,
  SHARE_LEVEL_WALKS,
  VALUATION_HAND_MATRIX,
  type HandExpectation,
  type HandRatio,
} from "./valuation-ratios.hand-matrix";

/**
 * The reference valuation ratios must reproduce the hand-computed anchor matrix exactly before any
 * full-scale comparison is trusted. Every expectation is a literal from
 * `valuation-ratios.hand-matrix.ts`, worked out by hand; none is read off the oracle.
 */

function fraction(text: string): { n: bigint; d: bigint } {
  const [numerator, denominator = "1"] = text.split("/");
  return oracleRational(BigInt(numerator as string), BigInt(denominator));
}

function describeOutcome(outcome: OracleValuationOutcome): string {
  return outcome.available
    ? `${outcome.value.n}/${outcome.value.d}`
    : `unavailable ${outcome.failing.join(",")}`;
}

function check(
  outcome: OracleValuationOutcome,
  expected: HandExpectation,
  label: string,
): void {
  if (typeof expected === "string") {
    expect(
      outcome.available,
      `${label}: expected ${expected}, got ${describeOutcome(outcome)}`,
    ).toBe(true);
    if (outcome.available) {
      const want = fraction(expected);
      expect(
        `${outcome.value.n}/${outcome.value.d}`,
        `${label}: exact value`,
      ).toBe(`${want.n}/${want.d}`);
    }
    return;
  }
  expect(
    outcome.available,
    `${label}: expected ${expected.unavailable}, got ${describeOutcome(outcome)}`,
  ).toBe(false);
  if (!outcome.available) {
    expect(
      outcome.reason,
      `${label}: primary reason (failing ${outcome.failing.join(",")})`,
    ).toBe(expected.unavailable);
    if (expected.alsoFailing) {
      expect(outcome.failing, `${label}: every failing rule`).toEqual([
        expected.unavailable,
        ...expected.alsoFailing,
      ]);
    }
  }
}

describe("reference valuation ratios: the hand-computed anchor matrix", () => {
  for (const handCase of VALUATION_HAND_MATRIX) {
    it(`${handCase.id} ${handCase.title}`, () => {
      const oracle = createValuationOracle(handCase.security);
      for (const observation of handCase.observations) {
        const reading = oracle.reading(observation.session, observation.close, {
          ...(observation.statementDate !== undefined
            ? { statementDate: observation.statementDate }
            : {}),
        });
        for (const [ratio, id] of Object.entries(HAND_RATIO_IDS) as [
          HandRatio,
          keyof typeof reading,
        ][]) {
          check(
            reading[id],
            observation.expect[ratio],
            `${handCase.id} ${observation.session}${observation.statementDate ? ` (statements ${observation.statementDate})` : ""} ${ratio}`,
          );
        }
      }
    });
  }

  it("covers every anchor case the audit brief lists, except the integration-only generation race", () => {
    const covered = new Set(
      VALUATION_HAND_MATRIX.flatMap((handCase) => handCase.covers),
    );
    const missing = Array.from({ length: 40 }, (_, index) => index + 1).filter(
      (number) => !covered.has(number),
    );
    expect(missing).toEqual([]);
  });
});

/** The base company's statements with one diluted share count per quarter, from 2023Q1. */
function walkSecurity(counts: readonly (number | null)[]): {
  security: OracleValuationSecurity;
  sessions: string[];
} {
  const base = VALUATION_HAND_MATRIX.find((handCase) => handCase.id === "C01");
  if (base === undefined) {
    throw new Error("C01 missing");
  }
  const quarters = [
    ...new Set(
      base.security.statements.map(
        (statement) => `${statement.fiscalYear}${statement.period}`,
      ),
    ),
  ].sort();
  const statements: OracleValuationStatement[] = base.security.statements.map(
    (statement) => {
      const index = quarters.indexOf(
        `${statement.fiscalYear}${statement.period}`,
      );
      if (statement.statementType !== "INCOME" || index >= counts.length) {
        return statement;
      }
      const values: Record<string, unknown> = { ...statement.values };
      const count = counts[index];
      if (count === null) {
        delete values.weightedAverageShsOutDil;
      } else {
        values.weightedAverageShsOutDil = count;
      }
      return { ...statement, values };
    },
  );
  const sessions = quarters.slice(0, counts.length).map((quarter) => {
    const income = statements.find(
      (statement) =>
        statement.statementType === "INCOME" &&
        `${statement.fiscalYear}${statement.period}` === quarter,
    );
    return income?.availableFromDate as string;
  });
  return { security: { ...base.security, statements }, sessions };
}

describe("reference valuation ratios: the share-level walk (rule 2)", () => {
  for (const walk of SHARE_LEVEL_WALKS) {
    it(walk.title, () => {
      const { security, sessions } = walkSecurity(walk.counts);
      const oracle = createValuationOracle(security);
      const accepted = sessions.map((session) => {
        const outcome = oracle.reading(session, "12").PRICE_TO_BOOK;
        if (outcome.available) {
          return true;
        }
        if (
          outcome.reason === "MISSING_SHARE_COUNT" ||
          outcome.reason === "NON_POSITIVE_SHARE_COUNT"
        ) {
          return null;
        }
        expect(outcome.reason).toBe("SHARE_LEVEL_UNSAFE");
        return false;
      });
      expect(accepted).toEqual(walk.accepted);
    });
  }
});

describe("reference valuation ratios: the restatement threshold (rule 3)", () => {
  for (const { restated, available } of RESTATEMENT_THRESHOLDS) {
    it(`10 restated to ${restated} is ${available ? "within" : "beyond"} 2 %`, () => {
      const base = VALUATION_HAND_MATRIX.find(
        (handCase) => handCase.id === "C01",
      );
      if (base === undefined) {
        throw new Error("C01 missing");
      }
      const original = base.security.statements.find(
        (statement) =>
          statement.statementType === "INCOME" &&
          statement.fiscalDate === "2024-12-31",
      ) as OracleValuationStatement;
      const security: OracleValuationSecurity = {
        ...base.security,
        statements: [
          ...base.security.statements.map((statement) =>
            statement === original
              ? { ...statement, observedAt: "2025-03-03T12:00:00.000Z" }
              : statement,
          ),
          {
            ...original,
            availableFromDate: "2025-04-01",
            observedAt: "2025-04-01T12:00:00.000Z",
            contentHash: "INCOME-2024Q4-restated",
            values: { ...original.values, weightedAverageShsOutDil: restated },
          },
        ],
      };
      const outcome = createValuationOracle(security).reading(
        "2025-04-01",
        "12",
      ).PRICE_TO_BOOK;
      expect(outcome.available).toBe(available);
      if (!outcome.available) {
        expect(outcome.reason).toBe("SHARE_RESTATEMENT_UNEXPLAINED");
      }
    });
  }
});

function handCase(id: string): (typeof VALUATION_HAND_MATRIX)[number] {
  const found = VALUATION_HAND_MATRIX.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`${id} missing`);
  }
  return found;
}

/** The diagnostics an outcome carries, for comparison with a literal. */
function diagnostics(outcome: OracleValuationOutcome): Record<string, boolean> {
  return outcome.available
    ? {
        available: true,
        explainedRestatement: outcome.terms.explainedRestatement,
        anchorBeyondPrevious: outcome.terms.anchorBeyondPrevious,
      }
    : {
        available: false,
        anchorBeyondPrevious: outcome.anchorBeyondPrevious,
        firstLevelUnconfirmed: outcome.firstLevelUnconfirmed,
      };
}

describe("reference valuation ratios: the rulings' diagnostics", () => {
  // Worked out by hand from each case's comment in the matrix: the anchor of `R` and the revision
  // it superseded, and whether the walk had set a level at `R`'s quarter.
  const expectations: readonly {
    id: string;
    session: string;
    close: string;
    expected: Record<string, boolean>;
  }[] = [
    // "a" is 2025Q2's only revision: no anchor.
    {
      id: "G1a",
      session: "2025-08-29",
      close: "12",
      expected: {
        available: true,
        explainedRestatement: false,
        anchorBeyondPrevious: false,
      },
    },
    // "r" against "a", the revision it superseded.
    {
      id: "G1a",
      session: "2025-09-02",
      close: "12",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: false,
      },
    },
    // "s" against "a": "r", the revision it superseded, was not accepted.
    {
      id: "G1a",
      session: "2025-09-10",
      close: "12",
      expected: {
        available: false,
        anchorBeyondPrevious: true,
        firstLevelUnconfirmed: false,
      },
    },
    // "t" against "a", past the unaccepted "r" and "s", explained by the measured 2:1.
    {
      id: "G1c",
      session: "2025-11-03",
      close: "6",
      expected: {
        available: true,
        explainedRestatement: true,
        anchorBeyondPrevious: true,
      },
    },
    // "u" against "t", the revision it superseded, within 2 %.
    {
      id: "G1c",
      session: "2025-12-01",
      close: "6",
      expected: {
        available: true,
        explainedRestatement: false,
        anchorBeyondPrevious: false,
      },
    },
    // "s" (10) against "a" (10), past the unaccepted "r": no restatement.
    {
      id: "G1d",
      session: "2025-09-10",
      close: "12",
      expected: {
        available: true,
        explainedRestatement: false,
        anchorBeyondPrevious: true,
      },
    },
    // "q" has no usable count.
    {
      id: "G2",
      session: "2025-09-02",
      close: "12",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: false,
      },
    },
    // "r" against "a", past the count-less "q".
    {
      id: "G2",
      session: "2025-09-10",
      close: "12",
      expected: {
        available: false,
        anchorBeyondPrevious: true,
        firstLevelUnconfirmed: false,
      },
    },
    // 2023Q1's 6 alone, then 6 and 10 (two runs): no level yet.
    {
      id: "G3",
      session: "2023-05-16",
      close: "12",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: true,
      },
    },
    {
      id: "G3",
      session: "2023-08-15",
      close: "12",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: true,
      },
    },
    // 6, 10, 10: the second run's second quarter, still no level.
    {
      id: "G3",
      session: "2024-02-29",
      close: "12",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: true,
      },
    },
    // "m" against "a", observed before it; "m" is withheld by rules 2 and 5, not rule 3.
    {
      id: "G1e",
      session: "2025-09-08",
      close: "6",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: false,
      },
    },
    // "r" against "a", the revision observed just before it: "m", though public earlier, was
    // observed after "r" and is not in its walk.
    {
      id: "G1e",
      session: "2025-09-15",
      close: "6",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: false,
      },
    },
    // "b" against "a".
    {
      id: "G1f",
      session: "2025-11-05",
      close: "6",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: false,
      },
    },
    // "r" against "a", past the unaccepted "b", explained by the measured 2:1.
    {
      id: "G1f",
      session: "2025-11-20",
      close: "6",
      expected: {
        available: true,
        explainedRestatement: true,
        anchorBeyondPrevious: true,
      },
    },
    // An unexplained restatement of the revision it superseded, at an existing level.
    {
      id: "C24",
      session: "2025-04-01",
      close: "12",
      expected: {
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: false,
      },
    },
  ];
  for (const { id, session, close, expected } of expectations) {
    it(`${id} ${session}`, () => {
      const reading = createValuationOracle(handCase(id).security).reading(
        session,
        close,
      );
      // Statement-level diagnostics: P/B (the ratio with no trailing window) stands for all five.
      expect(diagnostics(reading.PRICE_TO_BOOK)).toEqual(expected);
    });
  }

  it("marks a withheld count at an existing level as not the first level", () => {
    // 10, 10, 10, 10, 15: the level is 10 from 2023Q3; 15 is outside it (first disagreeing quarter).
    const { security, sessions } = walkSecurity([10, 10, 10, 10, 15]);
    const oracle = createValuationOracle(security);
    const first = oracle.reading(sessions[0] as string, "12").PRICE_TO_BOOK;
    const outside = oracle.reading(sessions[4] as string, "12").PRICE_TO_BOOK;
    expect(first.available ? undefined : first.reason).toBe(
      "SHARE_LEVEL_UNSAFE",
    );
    expect(diagnostics(first)).toEqual({
      available: false,
      anchorBeyondPrevious: false,
      firstLevelUnconfirmed: true,
    });
    expect(outside.available ? undefined : outside.reason).toBe(
      "SHARE_LEVEL_UNSAFE",
    );
    expect(diagnostics(outside)).toEqual({
      available: false,
      anchorBeyondPrevious: false,
      firstLevelUnconfirmed: false,
    });
  });
});

describe("reference valuation ratios: rule 3's anchor", () => {
  const base = handCase("C01").security;
  const original = base.statements.find(
    (statement) =>
      statement.statementType === "INCOME" &&
      statement.fiscalDate === "2025-06-30",
  ) as OracleValuationStatement;
  /** A revision of 2025Q2's Income: public from `at`, observed at noon that day unless given. */
  const later = (
    at: string,
    hash: string,
    values: Record<string, unknown>,
    observedAt = `${at}T12:00:00.000Z`,
  ): OracleValuationStatement => ({
    ...original,
    availableFromDate: at,
    observedAt,
    contentHash: `INCOME-2025Q2-${hash}`,
    values: { ...original.values, ...values },
  });
  /** The base company plus `revisions`, its 2025Q2 Income "a" observed at `originalObservedAt`. */
  const withRevisions = (
    revisions: readonly OracleValuationStatement[],
    originalObservedAt: string,
    events: OracleValuationSecurity["events"] = [],
  ): OracleValuationSecurity => ({
    ...base,
    statements: [
      ...base.statements.map((statement) =>
        statement === original
          ? { ...statement, observedAt: originalObservedAt }
          : statement,
      ),
      ...revisions,
    ],
    events,
  });
  /** Every ratio withheld by rule 3 alone, with neither diagnostic set. */
  const expectRestatedOnly = (
    reading: Record<string, OracleValuationOutcome>,
  ) => {
    for (const outcome of Object.values(reading)) {
      expect(outcome.available).toBe(false);
      if (!outcome.available) {
        expect(outcome.failing).toEqual(["SHARE_RESTATEMENT_UNEXPLAINED"]);
      }
      expect(diagnostics(outcome)).toEqual({
        available: false,
        anchorBeyondPrevious: false,
        firstLevelUnconfirmed: false,
      });
    }
  };
  /** Every ratio at `readings`, and the two available-side diagnostics. */
  const expectReadings = (
    reading: Record<string, OracleValuationOutcome>,
    readings: Record<HandRatio, string>,
    explainedRestatement: boolean,
    anchorBeyondPrevious: boolean,
    label: string,
  ) => {
    for (const [ratio, id] of Object.entries(HAND_RATIO_IDS) as [
      HandRatio,
      string,
    ][]) {
      check(
        reading[id] as OracleValuationOutcome,
        readings[ratio],
        `${label} ${ratio}`,
      );
      expect(
        diagnostics(reading[id] as OracleValuationOutcome),
        `${label} ${ratio}`,
      ).toEqual({
        available: true,
        explainedRestatement,
        anchorBeyondPrevious,
      });
    }
  };

  it("explains a restatement against the anchor, not against an unaccepted predecessor", () => {
    // The base company with 2025Q2's Income "a" (10 shares) observed 2025-08-14. On 2025-09-02
    // "r" restates it to 11 (x1.1, beyond 2 %; no re-base of that ratio): unexplained, so not
    // accepted. A 5:4 re-base (ratio 1.25, plain) is dated 2025-09-15 and detected 2025-09-16. On
    // 2025-11-03 "b" reports 12.5. Its anchor is "a", not "r": 12.5 / 10 = 1.25 is the re-base's
    // ratio, and the re-base is new to "a" (detected after "a" was observed), dated less than 30
    // days before that observation (it is after it), and detected before "b" was observed:
    // explained, and "b" is accepted. (Against "r", 12.5 / 11 = 25/22 is 0.114 from 1.25, beyond
    // 2 % of it, 0.025: unexplained.) Rule 2 holds: 12.5 is exactly +25 % of the level 10.
    // "b" is observed after the detection, on a session after the event: K = 1; 49 days after the
    // event, rule 5 is past. MC = 12 x 12.5 = 150: P/E 150/50 = 3, P/S 150/418 = 75/209, P/B
    // 150/260 = 15/26, P/FCF 150/54 = 25/9, EV/EBITDA (150 + 30)/106 = 90/53.
    // On 2025-12-01 "c" (12.5, another field) is compared with its anchor "b", the revision it
    // superseded: no restatement, the same readings.
    // On 2025-09-02 "r" is read alone against "a": unexplained, and nothing else fails — observed
    // before the event and its detection, a session before the event takes K = 1.25, and the
    // event is not yet dated when "r" is observed (rule 5).
    const oracle = createValuationOracle(
      withRevisions(
        [
          later("2025-09-02", "r", { weightedAverageShsOutDil: 11 }),
          later("2025-11-03", "b", { weightedAverageShsOutDil: 12.5 }),
          later("2025-12-01", "c", {
            weightedAverageShsOutDil: 12.5,
            grossProfit: 1,
          }),
        ],
        "2025-08-14T12:00:00.000Z",
        [
          {
            kind: "MEASURED",
            effectiveDate: "2025-09-15",
            priceRatio: "1.25",
            detectedAt: "2025-09-16T06:00:00.000Z",
          },
        ],
      ),
    );
    const readings = {
      PE: "3",
      PS: "75/209",
      PB: "15/26",
      PFCF: "25/9",
      EV: "90/53",
    };
    expectRestatedOnly(oracle.reading("2025-09-02", "12"));
    expectReadings(
      oracle.reading("2025-11-03", "12"),
      readings,
      true,
      true,
      "2025-11-03",
    );
    expectReadings(
      oracle.reading("2025-12-01", "12"),
      readings,
      false,
      false,
      "2025-12-01",
    );
  });

  it("orders the revisions one observation delivered as the representing order does", () => {
    // A first load: 2025Q2's Income "a" (10, public 2025-08-14) and an amendment (11, public
    // 2025-09-06) are both observed on 2026-08-31 at 12:00. By one observation the order is the
    // representing one, which puts the earlier `availableFromDate` first, so "a" is the
    // amendment's anchor — whatever the content hashes say (the amendment's, "-0", sorts first).
    // 11 against 10 is 10 %, beyond 2 %, with no re-base: unexplained. Rule 2 holds (11 is inside
    // the level 10's 25 %), and with no event nothing else applies. On 2025-09-05 the amendment is
    // not public: "a" alone, the readings as of 2025Q2.
    const oracle = createValuationOracle(
      withRevisions(
        [
          later(
            "2025-09-06",
            "0",
            { weightedAverageShsOutDil: 11 },
            "2026-08-31T12:00:00.000Z",
          ),
        ],
        "2026-08-31T12:00:00.000Z",
      ),
    );
    expectReadings(
      oracle.reading("2025-09-05", "12"),
      { PE: "12/5", PS: "60/209", PB: "6/13", PFCF: "20/9", EV: "75/53" },
      false,
      false,
      "2025-09-05",
    );
    expectRestatedOnly(oracle.reading("2025-09-08", "12"));
  });

  it("walks only the revisions public on the statement date", () => {
    // 2025Q2's Income "a" (10) is observed 2025-08-14. "x" (10.2) is observed 2025-09-09 but the
    // loader makes it public only from 2025-09-11; "y" (10.4) is observed and public 2025-09-10.
    // On 2025-09-10 "y" represents the quarter and "x" is not public, so "y"'s anchor is "a":
    // |10.4 - 10| = 0.4 > 0.2, unexplained. (Were "x" in the walk, it would be accepted — exactly
    // 2 % from "a" — and anchor "y", 0.2 <= 0.204 from it: available.) On 2025-09-11 "x"
    // represents the quarter (the later `availableFromDate`); "y" was observed after it and is not
    // in its walk, so "x" is judged against "a": exactly 2 %, accepted. Rule 2 holds for both.
    // MC = 12 x 10.2 = 122.4: P/E 122.4/50 = 306/125, P/S 122.4/418 = 306/1045, P/B 122.4/260 =
    // 153/325, P/FCF 122.4/54 = 34/15, EV/EBITDA (122.4 + 30)/106 = 381/265.
    const oracle = createValuationOracle(
      withRevisions(
        [
          later(
            "2025-09-11",
            "x",
            { weightedAverageShsOutDil: 10.2 },
            "2025-09-09T12:00:00.000Z",
          ),
          later("2025-09-10", "y", { weightedAverageShsOutDil: 10.4 }),
        ],
        "2025-08-14T12:00:00.000Z",
      ),
    );
    expectRestatedOnly(oracle.reading("2025-09-10", "12"));
    expectReadings(
      oracle.reading("2025-09-11", "12"),
      {
        PE: "306/125",
        PS: "306/1045",
        PB: "153/325",
        PFCF: "34/15",
        EV: "381/265",
      },
      false,
      false,
      "2025-09-11",
    );
  });
});

describe("reference valuation ratios: exact arithmetic", () => {
  it("reads decimal text exactly", () => {
    expect(oracleDecimal("12.34000000")).toEqual(oracleRational(617n, 50n));
    expect(oracleDecimal("-1.5e-7")).toEqual(oracleRational(-3n, 20000000n));
    expect(oracleDecimal("1323.000000000000")).toEqual(oracleRational(1323n));
    expect(oracleDecimal("abc")).toBeUndefined();
  });

  it("takes every double at its exact binary value", () => {
    // 0.1 is 3602879701896397 / 2^55.
    expect(oracleExactDouble(0.1)).toEqual(
      oracleRational(3602879701896397n, 36028797018963968n),
    );
    expect(oracleExactDouble(-2.5)).toEqual(oracleRational(-5n, 2n));
    expect(oracleExactDouble(Number.MIN_VALUE)).toEqual(
      oracleRational(1n, 1n << 1074n),
    );
  });

  it("rounds to the nearest double, ties to even, against the platform's own division", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let index = 0; index < 2000; index += 1) {
      const n = next() - 1073741824;
      const d = (next() % 100000) + 1;
      expect(oracleNearestDouble(oracleRational(BigInt(n), BigInt(d)))).toBe(
        n / d,
      );
    }
    // 2^53 + 1 is a tie between 2^53 and 2^53 + 2: even wins.
    expect(oracleNearestDouble(oracleRational((1n << 53n) + 1n))).toBe(2 ** 53);
    expect(oracleNearestDouble(oracleRational((1n << 53n) + 3n))).toBe(
      2 ** 53 + 4,
    );
    expect(oracleNearestDouble(oracleRational(1n, 3n))).toBe(1 / 3);
    expect(oracleNearestDouble(oracleRational(1n, 1n << 1080n))).toBe(0);
    expect(oracleNearestDouble(oracleRational(1n << 1100n))).toBe(Infinity);
    expect(
      oracleCompare(oracleExactDouble(1 / 3), oracleRational(1n, 3n)),
    ).toBe(-1);
  });
});

describe("reference valuation ratios: independence", () => {
  it("imports nothing but itself (ESLint enforces the same over the directory)", () => {
    const source = readFileSync(join(__dirname, "valuation-ratios.ts"), "utf8");
    const imports = [
      ...source.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gms),
    ].map((match) => match[1]);
    const requires = [
      ...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    expect([...imports, ...requires]).toEqual([]);
    for (const forbidden of [
      "buildValuationTimeline",
      "valuationRatioColumns",
      "basisFactorAt",
      "isPlainShareRatio",
      "selectFinancialStatements",
      "@intrinsic",
    ]) {
      expect(source.includes(forbidden), forbidden).toBe(false);
    }
  });
});

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

const baseCompany = handCase("C01").security;
const income2025Q2 = baseCompany.statements.find(
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
  ...income2025Q2,
  availableFromDate: at,
  observedAt,
  contentHash: `INCOME-2025Q2-${hash}`,
  values: { ...income2025Q2.values, ...values },
});
/** The base company plus `revisions`, its 2025Q2 Income "a" observed at `originalObservedAt`. */
const withRevisions = (
  revisions: readonly OracleValuationStatement[],
  originalObservedAt: string,
  events: OracleValuationSecurity["events"] = [],
): OracleValuationSecurity => ({
  ...baseCompany,
  statements: [
    ...baseCompany.statements.map((statement) =>
      statement === income2025Q2
        ? { ...statement, observedAt: originalObservedAt }
        : statement,
    ),
    ...revisions,
  ],
  events,
});
/** Every ratio withheld by exactly `failing` (rule 3 alone by default), neither diagnostic set. */
const expectWithheld = (
  reading: Record<string, OracleValuationOutcome>,
  failing: readonly string[] = ["SHARE_RESTATEMENT_UNEXPLAINED"],
) => {
  for (const outcome of Object.values(reading)) {
    expect(outcome.available).toBe(false);
    if (!outcome.available) {
      expect(outcome.failing).toEqual(failing);
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

describe("reference valuation ratios: rule 3's anchor", () => {
  it("explains a restatement against the anchor, not against an unaccepted predecessor", () => {
    // The base company with 2025Q2's Income "a" (10 shares) observed 2025-08-14. On 2025-09-02
    // "r" restates it to 11 (x1.1, beyond 2 %; no re-base of that ratio): unexplained, so not
    // accepted. A 5:4 re-base (ratio 1.25, plain) is dated 2025-09-15 and detected 2025-09-16. On
    // 2025-11-03 "b" reports 12.5. Its anchor is "a", not "r": 12.5 / 10 = 1.25 is the re-base's
    // ratio, and the re-base is new to "a" (detected after "a" was observed), dated less than 30
    // days before that observation (it is after it), and detected before "b" was observed:
    // explained, and "b" is accepted — the 5:4 separates "b" from "a" (2025Q2 ended before it, "a"
    // was observed before its detection, "b" after), and an explained restatement is what is
    // accepted across it. (Against "r", 12.5 / 11 = 25/22 is 0.114 from 1.25, beyond 2 % of it,
    // 0.025: unexplained.) Rule 2 holds: 12.5 is exactly +25 % of the level 10.
    // "b" is observed after the detection, on a session after the event: K = 1; 49 days after the
    // event, rule 5 is past. MC = 12 x 12.5 = 150: P/E 150/50 = 3, P/S 150/418 = 75/209, P/B
    // 150/260 = 15/26, P/FCF 150/54 = 25/9, EV/EBITDA (150 + 30)/106 = 90/53.
    // On 2025-12-01 "c" (12.5, another field) is compared with its anchor "b", the revision it
    // superseded: no restatement — and "b" was observed after the detection, so the 5:4 does not
    // separate them — the same readings.
    // On 2025-09-02 "r" is read against "a": unexplained. Rule 5 before the event withholds it as
    // well: not accepted, its count was first observed on 2025-09-02 itself, within the 30 days
    // before 2025-09-15 (from 2025-08-16), for a quarter that ended before it, on a session before
    // it. Nothing else fails: observed before the event and its detection, a session before the
    // event takes K = 1.25, and rule 5's month after the event has not begun.
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
    expectWithheld(oracle.reading("2025-09-02", "12"), [
      "SHARE_RESTATEMENT_UNEXPLAINED",
      "COUNT_BEFORE_EVENT",
    ]);
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
    expectWithheld(oracle.reading("2025-09-08", "12"));
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
    expectWithheld(oracle.reading("2025-09-10", "12"));
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

  it("refuses a restatement a measured re-base explains when a provider entry separates it", () => {
    // 2025Q2's Income "a" (10) observed 2025-08-14; a 5:4 provider entry dated 2025-09-15 (history
    // under the 2026-10-02 verification) and a measured 5:4 re-base (1.25) dated 2025-10-01,
    // detected 2025-10-02 06:00 — 16 days from the entry, so it does not supersede it. "r" (12.5)
    // is observed 2025-11-03. Against "a", 12.5 / 10 = 1.25: the re-base explains it on rule 3's
    // terms. But the entry is a share-changing event that separates "r" from "a" (2025Q2 ended
    // before 2025-09-15, "a" was observed before it, "r" on or after it), and "across a separating
    // entry X is not accepted at all": SHARE_BASIS_UNCONFIRMED, and nothing else fails — rule 4.2
    // looks at "r" (observed after the entry), rules 5 are past (the entry's month ended
    // 2025-10-14, the re-base's 2025-10-30), K = 1 (observed after the detection, on a session
    // after the event), and 12.5 is inside the level 10's 25 %. Without the entry the measured
    // re-base alone separates them, and an explained restatement is accepted across it: MC = 12 x
    // 12.5 = 150, P/E 3, P/S 75/209, P/B 15/26, P/FCF 25/9, EV/EBITDA 90/53.
    const security = withRevisions(
      [later("2025-11-03", "r", { weightedAverageShsOutDil: 12.5 })],
      "2025-08-14T12:00:00.000Z",
      [
        {
          kind: "MEASURED",
          effectiveDate: "2025-10-01",
          priceRatio: "1.25",
          detectedAt: "2025-10-02T06:00:00.000Z",
        },
      ],
    );
    expectWithheld(
      createValuationOracle({
        ...security,
        splits: [
          {
            date: "2025-09-15",
            numerator: "5",
            denominator: "4",
            label: "stock-split",
          },
        ],
      }).reading("2025-11-03", "12"),
      ["SHARE_BASIS_UNCONFIRMED"],
    );
    expectReadings(
      createValuationOracle(security).reading("2025-11-03", "12"),
      { PE: "3", PS: "75/209", PB: "15/26", PFCF: "25/9", EV: "90/53" },
      true,
      false,
      "without the entry",
    );
  });

  it("follows the first observation back through every agreeing, accepted anchor", () => {
    // Verified 2025-06-01; a 2:1 entry listed for 2025-10-01, never measured. 2025Q2's Income
    // "a" (10) observed 2025-08-14, "s" (10.1) on 2025-09-05 and "t" (10.2) on 2025-09-20, each
    // public when observed. "s" agrees with "a" (0.1 <= 0.2) and "t" with "s" (0.1 <= 0.202); the
    // entry separates neither (both observed before it): both accepted. "t"'s count was therefore
    // first observed with "a" on 2025-08-14, outside the 30 days before 2025-10-01 (from
    // 2025-09-01), though "s" and "t" lie inside them. (Stopping one link back, at "s", would
    // withhold it.) On 2025-09-20 nothing withholds "t": MC = 12 x 10.2 = 122.4, P/E 306/125, P/S
    // 306/1045, P/B 153/325, P/FCF 34/15, EV/EBITDA 381/265.
    const oracle = createValuationOracle({
      ...withRevisions(
        [
          later("2025-09-05", "s", { weightedAverageShsOutDil: 10.1 }),
          later("2025-09-20", "t", { weightedAverageShsOutDil: 10.2 }),
        ],
        "2025-08-14T12:00:00.000Z",
      ),
      verifiedAt: "2025-06-01T05:00:00.000Z",
      splits: [
        {
          date: "2025-10-01",
          numerator: "2",
          denominator: "1",
          label: "stock-split",
        },
      ],
    });
    expectReadings(
      oracle.reading("2025-09-20", "12"),
      {
        PE: "306/125",
        PS: "306/1045",
        PB: "153/325",
        PFCF: "34/15",
        EV: "381/265",
      },
      false,
      false,
      "2025-09-20",
    );
  });
});

describe("reference valuation ratios: rule 5 before the event", () => {
  it("reads a Monitor provisional row's session on its own date", () => {
    // M3b: 2025Q2 first observed 2025-08-14, within the 30 days before the 2:1 entry listed for
    // 2025-09-08. A provisional row on 2025-09-08 reading the statements of 2025-09-05 is on the
    // event's date, not before it: only rule 8 holds it. One on 2025-09-05 reading those of
    // 2025-09-04 is before it: rule 5 before the event.
    const oracle = createValuationOracle(handCase("M3b").security);
    expectWithheld(
      oracle.reading("2025-09-08", "12", { statementDate: "2025-09-05" }),
      ["FORWARD_EVENT_UNMEASURED"],
    );
    expectWithheld(
      oracle.reading("2025-09-05", "12", { statementDate: "2025-09-04" }),
      ["COUNT_BEFORE_EVENT"],
    );
  });

  it("opens an undated re-base's window 30 days before its first day and holds up to its last", () => {
    // 2025Q2's Income "a" (10) observed 2025-08-14 (the base company otherwise). A 2:1 re-base
    // measured undated after 2025-09-10 and no later than 2025-09-20 — its first possible day
    // 2025-09-11, its last 2025-09-20 — detected 2025-09-21 06:00. The window starts on
    // 2025-08-12 (30 days before 2025-09-11), so the count first observed on 2025-08-14 is in it
    // (from the last day, 2025-08-21, it would not be), and 2025Q2 ended before 2025-09-20; the
    // sessions before 2025-09-20 are withheld.
    // - 2025-09-10: before the interval, "a" (observed before it and its detection) takes K = 2;
    //   only rule 5 before the event withholds.
    // - 2025-09-15: inside the interval: rule 6 withholds too.
    // - 2025-09-20: the last possible day is not before the event: rule 6 alone.
    const oracle = createValuationOracle(
      withRevisions([], "2025-08-14T12:00:00.000Z", [
        {
          kind: "MEASURED",
          effectiveFrom: "2025-09-10",
          effectiveTo: "2025-09-20",
          priceRatio: "2",
          detectedAt: "2025-09-21T06:00:00.000Z",
        },
      ]),
    );
    expectWithheld(oracle.reading("2025-09-10", "6"), ["COUNT_BEFORE_EVENT"]);
    expectWithheld(oracle.reading("2025-09-15", "6"), [
      "COUNT_BEFORE_EVENT",
      "BASIS_WITHHELD",
    ]);
    expectWithheld(oracle.reading("2025-09-20", "6"), ["BASIS_WITHHELD"]);
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

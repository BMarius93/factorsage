import { describe, expect, it } from "vitest";
import {
  createValuationOracle,
  ORACLE_VALUATION_RATIO_IDS,
  oracleRational,
  type OracleValuationOutcome,
  type OracleValuationStatement,
} from "../oracle/valuation-ratios";
import {
  HAND_RATIO_IDS,
  RESTATEMENT_THRESHOLDS,
  SHARE_LEVEL_WALKS,
  VALUATION_HAND_MATRIX,
  type HandRatio,
} from "../oracle/valuation-ratios.hand-matrix";
import { compareCell } from "./compare";
import { productColumns, productTimeline } from "./production-adapter";

/**
 * The hand-computed anchor matrix held against the product's calculation.
 *
 * Every literal comes from `oracle/valuation-ratios.hand-matrix.ts` (worked out by hand). A reading
 * the matrix makes available must be the product's double within the named float tolerance of the
 * exact fraction; a withheld one must be `NaN`. The product reports no reason, so only presence and
 * value are compared here.
 */

function literalOutcome(
  text: string,
): Extract<OracleValuationOutcome, { available: true }> {
  const [numerator, denominator = "1"] = text.split("/");
  const value = oracleRational(
    BigInt(numerator as string),
    BigInt(denominator),
  );
  // A literal carries no terms: a tolerance of 2^-48 of its own magnitude (plus one in 2^48 of
  // unity for zero) stands in for the full bound; every literal's operands are small and exact.
  return {
    available: true,
    value,
    double: Number(numerator) / Number(denominator),
    terms: {
      close: value,
      basisFactor: oracleRational(1n),
      basisFactorCount: 0,
      shares: oracleRational(1n),
      marketCapitalisation: value.n === 0n ? oracleRational(1n) : value,
      addend: oracleRational(0n),
      denominator: oracleRational(1n),
      denominatorMagnitude: oracleRational(1n),
    },
  };
}

describe("the product against the hand-computed anchor matrix", () => {
  for (const handCase of VALUATION_HAND_MATRIX) {
    it(`${handCase.id} ${handCase.title}`, () => {
      const timeline = productTimeline(handCase.security);
      const oracle = createValuationOracle(handCase.security);
      for (const observation of handCase.observations) {
        const columns = productColumns({
          timeline,
          dates: [observation.session],
          closes: [observation.close],
          ratios: ORACLE_VALUATION_RATIO_IDS,
          ...(observation.statementDate !== undefined
            ? { statementDateOf: () => observation.statementDate as string }
            : {}),
        });
        const reading = oracle.reading(observation.session, observation.close, {
          ...(observation.statementDate !== undefined
            ? { statementDate: observation.statementDate }
            : {}),
        });
        for (const [ratio, id] of Object.entries(HAND_RATIO_IDS) as [
          HandRatio,
          (typeof HAND_RATIO_IDS)[HandRatio],
        ][]) {
          const product = (columns.get(id) as Float64Array)[0] as number;
          const expected = observation.expect[ratio];
          const label = `${handCase.id} ${observation.session} ${ratio}`;
          if (typeof expected === "string") {
            // The literal, with the full float error bound of this observation's terms (the oracle
            // reproduces every literal exactly: `oracle/valuation-ratios.test.ts`).
            const oracleOutcome = reading[id];
            const literal = literalOutcome(expected);
            expect(
              oracleOutcome.available,
              `${label}: oracle disagrees with the hand`,
            ).toBe(true);
            const outcome = oracleOutcome.available
              ? { ...oracleOutcome, value: literal.value }
              : literal;
            const comparison = compareCell(product, outcome);
            expect(
              comparison.cls,
              `${label}: product ${product}, hand ${expected}`,
            ).toBe("AVAILABLE_MATCH");
          } else {
            expect(
              product,
              `${label}: product shows ${product}, hand withholds (${expected.unavailable})`,
            ).toBeNaN();
          }
        }
      }
    });
  }
});

describe("the product against the hand-computed rule 2 walks and rule 3 thresholds", () => {
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

  for (const walk of SHARE_LEVEL_WALKS) {
    it(`walk: ${walk.title}`, () => {
      const statements = base.security.statements.map((statement) => {
        const index = quarters.indexOf(
          `${statement.fiscalYear}${statement.period}`,
        );
        if (
          statement.statementType !== "INCOME" ||
          index >= walk.counts.length
        ) {
          return statement;
        }
        const values: Record<string, unknown> = { ...statement.values };
        const count = walk.counts[index];
        if (count === null) {
          delete values.weightedAverageShsOutDil;
        } else {
          values.weightedAverageShsOutDil = count;
        }
        return { ...statement, values };
      });
      const security = { ...base.security, statements };
      const sessions = quarters
        .slice(0, walk.counts.length)
        .map(
          (quarter) =>
            statements.find(
              (statement) =>
                statement.statementType === "INCOME" &&
                `${statement.fiscalYear}${statement.period}` === quarter,
            )?.availableFromDate as string,
        );
      const column = productColumns({
        timeline: productTimeline(security),
        dates: sessions,
        closes: sessions.map(() => "12"),
        ratios: ["PRICE_TO_BOOK"],
      }).get("PRICE_TO_BOOK") as Float64Array;
      expect(
        Array.from(column, (value, index) =>
          walk.accepted[index] === null ? null : !Number.isNaN(value),
        ),
      ).toEqual(walk.accepted);
    });
  }

  for (const { restated, available } of RESTATEMENT_THRESHOLDS) {
    it(`restatement: 10 restated to ${restated} is ${available ? "within" : "beyond"} 2 %`, () => {
      const original = base.security.statements.find(
        (statement) =>
          statement.statementType === "INCOME" &&
          statement.fiscalDate === "2024-12-31",
      ) as OracleValuationStatement;
      const security = {
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
      const column = productColumns({
        timeline: productTimeline(security),
        dates: ["2025-04-01"],
        closes: ["12"],
        ratios: ["PRICE_TO_BOOK"],
      }).get("PRICE_TO_BOOK") as Float64Array;
      expect(!Number.isNaN(column[0] as number)).toBe(available);
    });
  }
});

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

import type { FinancialStatement } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import type { DailyIntrinsicState } from "./intrinsic-value-materializer.js";
import type { PriceBasisEvent } from "./price-basis.js";
import {
  applyPriceBasisToIntrinsicStates,
  shareRevisionsByDate,
} from "./share-basis.js";

const SECURITY = "security-1";

function income(input: {
  fiscalDate: string;
  fiscalYear: number;
  period: "Q1" | "Q2" | "Q3" | "Q4";
  availableFromDate: string;
  observedAt: string;
  shares: number;
}): FinancialStatement {
  return {
    securityId: SECURITY,
    statementType: "INCOME",
    fiscalDate: input.fiscalDate,
    fiscalYear: input.fiscalYear,
    period: input.period,
    reportedCurrency: "USD",
    filingDate: input.availableFromDate,
    availableFromDate: input.availableFromDate,
    observedAt: input.observedAt,
    contentHash: `${input.fiscalDate}:${input.observedAt}`,
    values: { weightedAverageShsOutDil: input.shares },
  } as FinancialStatement;
}

function state(date: string, value: number): DailyIntrinsicState {
  return {
    date,
    intrinsicValues: { DCF_FCFF: value, GRAHAM: value * 2 },
    intrinsicValueBlends: { BALANCED: value * 1.5 },
    dcfFcffSourceAsOf: "2026-01-01T00:00:00.000Z",
    grahamSourceAsOf: "2026-01-01T00:00:00.000Z",
    intrinsicCurrency: "USD",
  };
}

const evidence = {
  runs: [],
  comparedSessions: 0,
  changedSessions: 0,
  unfittedSessions: 0,
};

/** A 4:1 split on 2026-10-06, measured the next day. */
const split: PriceBasisEvent = {
  securityId: SECURITY,
  generation: 2,
  kind: "MEASURED",
  effectiveDate: "2026-10-06",
  priceRatio: 4,
  detectedAt: "2026-10-07T12:00:00.000Z",
  evidence,
};

/** Observed at first load, before the split. */
const q2 = income({
  fiscalDate: "2026-06-30",
  fiscalYear: 2026,
  period: "Q2",
  availableFromDate: "2026-08-01",
  observedAt: "2026-09-01T00:00:00.000Z",
  shares: 100,
});
/** The same quarter restated by the provider for the split, observed after its detection. */
const q2Restated = income({
  fiscalDate: "2026-06-30",
  fiscalYear: 2026,
  period: "Q2",
  availableFromDate: "2026-10-08",
  observedAt: "2026-10-08T00:00:00.000Z",
  shares: 400,
});

describe("shareRevisionsByDate", () => {
  it("is the latest point-in-time Income quarter of each day, carried between events", () => {
    const q1 = income({
      fiscalDate: "2026-03-31",
      fiscalYear: 2026,
      period: "Q1",
      availableFromDate: "2026-05-01",
      observedAt: "2026-09-01T00:00:00.000Z",
      shares: 99,
    });
    const revisions = shareRevisionsByDate({
      securityId: SECURITY,
      tradingDates: ["2026-05-01", "2026-07-31", "2026-08-03", "2026-10-08"],
      statements: [q1, q2, q2Restated],
    });
    expect(revisions.get("2026-05-01")).toBe(q1);
    expect(revisions.get("2026-07-31")).toBe(q1);
    expect(revisions.get("2026-08-03")).toBe(q2);
    expect(revisions.get("2026-10-08")).toBe(q2Restated);
  });
});

describe("applyPriceBasisToIntrinsicStates", () => {
  const dates = [
    "2026-10-02",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
  ];
  const states = dates.map((date) => state(date, 80));

  it("changes nothing when no re-base was measured", () => {
    expect(
      applyPriceBasisToIntrinsicStates(states, {
        securityId: SECURITY,
        statements: [q2, q2Restated],
        events: [],
      }),
    ).toEqual(states);
  });

  it("puts values before the event on the re-based close and withholds the window after it", () => {
    const adjusted = applyPriceBasisToIntrinsicStates(states, {
      securityId: SECURITY,
      statements: [q2, q2Restated],
      events: [split],
    });
    // Before the ex-date: old-unit statements against a close the re-base divided by 4.
    expect(adjusted[0]).toEqual({
      ...states[0],
      intrinsicValues: { DCF_FCFF: 20, GRAHAM: 40 },
      intrinsicValueBlends: { BALANCED: 30 },
    });
    expect(adjusted[1]?.intrinsicValues?.DCF_FCFF).toBe(20);
    // From the ex-date until a revision observed after the detection: units unknown, so absent.
    expect(adjusted[2]).toEqual({ date: "2026-10-06" });
    expect(adjusted[3]).toEqual({ date: "2026-10-07" });
    // The restated revision is in the new units: the value stands as computed.
    expect(adjusted[4]).toEqual(states[4]);
  });

  it("keeps Margin of Safety exactly as it was before the re-base", () => {
    // Before PR 1 the stored close of 2026-10-02 was 200 against an intrinsic value of 80; the
    // replacement stores 50. Both readings are the same margin.
    const [adjusted] = applyPriceBasisToIntrinsicStates([states[0]!], {
      securityId: SECURITY,
      statements: [q2],
      events: [split],
    });
    const before = (80 - 200) / 80;
    const after =
      ((adjusted!.intrinsicValues!.DCF_FCFF as number) - 50) /
      (adjusted!.intrinsicValues!.DCF_FCFF as number);
    expect(after).toBeCloseTo(before, 12);
  });

  it("withholds a value with no share revision behind it once a re-base exists", () => {
    expect(
      applyPriceBasisToIntrinsicStates([state("2026-10-02", 80)], {
        securityId: SECURITY,
        statements: [],
        events: [split],
      }),
    ).toEqual([{ date: "2026-10-02" }]);
  });

  it("leaves a day without intrinsic values untouched", () => {
    const empty = { date: "2026-10-02" };
    expect(
      applyPriceBasisToIntrinsicStates([empty], {
        securityId: SECURITY,
        statements: [q2],
        events: [split],
      }),
    ).toEqual([empty]);
  });
});

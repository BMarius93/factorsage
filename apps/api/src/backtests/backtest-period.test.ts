import { BACKTEST_MAX_PERIOD_YEARS, subtractYears } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  earliestSelectableBacktestStart,
  parseCreateBacktestRunRequest,
} from "./backtest-requests";

/**
 * The period a submission is allowed to name.
 *
 * The rule that was missing: a period had to be at most thirty years long and end no later than
 * today, but its *start* was unbounded. So `1985-01-01` to `1990-01-01` was accepted — five years,
 * ending in the past — for a product that keeps thirty years of history and has no data there at
 * all. Nothing rejected it, and the run was then quietly narrowed at execution time to whatever
 * the clock allowed, completed, and reported a period it had not simulated.
 *
 * Two halves of one contract: the API refuses a period the product cannot supply, and execution
 * then runs exactly what was accepted. Either half alone leaves the same defect.
 */

const TODAY = "2026-08-24";

const submission = (overrides: Record<string, unknown> = {}) => ({
  strategyId: "11111111-1111-4111-8111-111111111111",
  stockListId: "22222222-2222-4222-8222-222222222222",
  startDate: "2016-08-24",
  endDate: "2026-08-24",
  initialCapital: 100_000,
  maximumPositions: 10,
  ...overrides,
});

const parse = (overrides: Record<string, unknown> = {}, today = TODAY) =>
  parseCreateBacktestRunRequest(submission(overrides), today);

describe("the selectable horizon", () => {
  it("is the same day the New Backtest form offers, from the same shared arithmetic", () => {
    expect(earliestSelectableBacktestStart(TODAY)).toBe(
      subtractYears(TODAY, BACKTEST_MAX_PERIOD_YEARS),
    );
    expect(earliestSelectableBacktestStart(TODAY)).toBe("1996-08-24");
  });

  it("clamps 29 February rather than rolling it forward", () => {
    // A naive `setUTCFullYear` lands on 1 March and the horizon moves every fourth year.
    expect(earliestSelectableBacktestStart("2028-02-29")).toBe("1998-02-28");
  });

  it("accepts a period that starts exactly on the boundary", () => {
    const parsed = parse({ startDate: "1996-08-24", endDate: "2026-08-24" });
    expect(parsed.startDate).toBe("1996-08-24");
    expect(parsed.endDate).toBe("2026-08-24");
  });
});

describe("a request outside the horizon is refused at submission", () => {
  it("rejects a period that begins one day too early", () => {
    expect(() =>
      parse({ startDate: "1996-08-23", endDate: "2026-08-23" }),
    ).toThrow(/cannot start before 1996-08-24/);
  });

  it("rejects a partially out-of-horizon period", () => {
    // Ends inside the horizon, starts well outside it. This one used to be accepted and then
    // silently truncated by more than five years at execution time.
    expect(() =>
      parse({ startDate: "1990-01-01", endDate: "2010-01-01" }),
    ).toThrow(/cannot start before 1996-08-24/);
  });

  it("rejects a completely out-of-horizon period", () => {
    expect(() =>
      parse({ startDate: "1985-01-01", endDate: "1990-01-01" }),
    ).toThrow(/cannot start before 1996-08-24/);
  });

  it("still rejects a period longer than the maximum, and one ending in the future", () => {
    expect(() =>
      parse({ startDate: "1980-01-01", endDate: "2020-12-31" }),
    ).toThrow(new RegExp(`at most ${BACKTEST_MAX_PERIOD_YEARS} years`));
    expect(() => parse({ endDate: "2026-08-25" })).toThrow(
      /cannot end in the future/,
    );
  });
});

describe("the boundary moves with the clock, and the refusal moves with it", () => {
  it("accepts on the day it is valid and refuses the next day", () => {
    const period = { startDate: "1996-08-24", endDate: "2026-08-24" };
    expect(parse(period, "2026-08-24").startDate).toBe("1996-08-24");
    // One second past UTC midnight the same submission is no longer offered — which is exactly
    // why a run already accepted must keep executing its own snapshot rather than being
    // re-measured against this bound. See `projectionRange`'s BACKTEST case.
    expect(() => parse(period, "2026-08-25")).toThrow(
      /cannot start before 1996-08-25/,
    );
  });
});

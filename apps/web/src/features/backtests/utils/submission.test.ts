import {
  BACKTEST_MAX_MAXIMUM_POSITIONS,
  BACKTEST_MAX_PERIOD_YEARS,
} from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import {
  defaultBacktestPeriod,
  fullPositionHelpText,
  validateBacktestForm,
  type BacktestFormValues,
} from "./submission";

const VALID: BacktestFormValues = {
  strategyId: "strategy-1",
  stockListId: "list-1",
  benchmarkCode: "SP500",
  startDate: "2021-01-04",
  endDate: "2026-01-02",
  initialCapital: "10000",
  monthlyContribution: "",
  maximumPositions: "10",
};

describe("validateBacktestForm", () => {
  it("builds the request and omits a contribution that was never entered", () => {
    const { errors, request } = validateBacktestForm(VALID);

    expect(errors).toEqual({});
    expect(request).toEqual({
      strategyId: "strategy-1",
      stockListId: "list-1",
      benchmarkCode: "SP500",
      startDate: "2021-01-04",
      endDate: "2026-01-02",
      initialCapital: 10_000,
      maximumPositions: 10,
    });
  });

  it("carries a contribution the user entered", () => {
    const { request } = validateBacktestForm({
      ...VALID,
      monthlyContribution: "250",
    });

    expect(request?.monthlyContribution).toBe(250);
  });

  it("rejects a period that is not a period", () => {
    expect(
      validateBacktestForm({ ...VALID, endDate: "2021-01-04" }).errors.endDate,
    ).toBe("The end date must be after the start date.");
    expect(
      validateBacktestForm({ ...VALID, startDate: "" }).errors.startDate,
    ).toBe("A backtest needs a start date.");
  });

  it("rejects a period longer than the shared retention horizon", () => {
    const { errors, request } = validateBacktestForm({
      ...VALID,
      startDate: "1980-01-02",
    });

    expect(errors.endDate).toContain(String(BACKTEST_MAX_PERIOD_YEARS));
    expect(request).toBeNull();
  });

  it("rejects capital and position limits outside the shared bounds", () => {
    expect(
      validateBacktestForm({ ...VALID, initialCapital: "0" }).errors
        .initialCapital,
    ).toBeDefined();
    expect(
      validateBacktestForm({
        ...VALID,
        maximumPositions: String(BACKTEST_MAX_MAXIMUM_POSITIONS + 1),
      }).errors.maximumPositions,
    ).toBeDefined();
    // A position slot is occupied whole or not at all; a fraction of one is not a configuration.
    expect(
      validateBacktestForm({ ...VALID, maximumPositions: "2.5" }).errors
        .maximumPositions,
    ).toBeDefined();
  });

  it("requires the run's three selections", () => {
    const { errors } = validateBacktestForm({
      ...VALID,
      strategyId: "",
      stockListId: "",
      benchmarkCode: "",
    });

    expect(errors.strategyId).toBeDefined();
    expect(errors.stockListId).toBeDefined();
    expect(errors.benchmarkCode).toBeDefined();
  });
});

describe("fullPositionHelpText", () => {
  it("spells out the derived full position and what a BUY level of it targets", () => {
    expect(fullPositionHelpText(10)).toBe(
      "10 positions → a full position is 10% of the portfolio; a 25% BUY level targets 2.5%",
    );
    expect(fullPositionHelpText(4)).toBe(
      "4 positions → a full position is 25% of the portfolio; a 25% BUY level targets 6.25%",
    );
    expect(fullPositionHelpText(1)).toBe(
      "1 position → a full position is 100% of the portfolio; a 25% BUY level targets 25%",
    );
  });
});

describe("defaultBacktestPeriod", () => {
  it("opens on the last five years, ending today", () => {
    expect(defaultBacktestPeriod(new Date("2026-09-07T12:00:00.000Z"))).toEqual(
      {
        startDate: "2021-09-07",
        endDate: "2026-09-07",
      },
    );
  });
});

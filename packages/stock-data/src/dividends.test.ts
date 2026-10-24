import type { LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  indicatedAnnualDividend,
  paymentsPerYear,
  paymentsPerYearFor,
  type DividendRow,
} from "./dividends.js";

function dividend(
  exDate: string,
  adjustedAmount: number,
  frequency: string | null = "Quarterly",
): DividendRow {
  return {
    exDate: exDate as LocalDate,
    recordDate: null,
    paymentDate: null,
    declarationDate: null,
    amount: adjustedAmount * 2,
    adjustedAmount,
    frequency,
  };
}

const on = (date: string) => date as LocalDate;

describe("indicated annual dividend", () => {
  const history = [
    dividend("2023-02-10", 0.2),
    dividend("2023-05-12", 0.2),
    dividend("2023-08-11", 0.22),
    dividend("2023-11-10", 0.22),
    dividend("2023-12-15", 3, "Special"),
    dividend("2024-02-09", 0.24),
  ];

  it("annualizes the latest regular dividend whose ex-date has passed, split-adjusted", () => {
    expect(indicatedAnnualDividend(history, on("2023-12-31"))).toBeCloseTo(
      0.88,
    );
    expect(indicatedAnnualDividend(history, on("2024-02-09"))).toBeCloseTo(
      0.96,
    );
  });

  it("never reads a dividend before its ex-date", () => {
    expect(indicatedAnnualDividend(history, on("2024-02-08"))).toBeCloseTo(
      0.88,
    );
    expect(indicatedAnnualDividend(history, on("2023-02-09"))).toBeNull();
  });

  it("leaves special and irregular payments out", () => {
    expect(
      indicatedAnnualDividend(
        [dividend("2023-12-15", 3, "Special")],
        on("2023-12-31"),
      ),
    ).toBeNull();
    expect(
      indicatedAnnualDividend(
        [dividend("2023-12-15", 3, "Irregular")],
        on("2023-12-31"),
      ),
    ).toBeNull();
  });

  it("indicates nothing once the latest regular dividend is more than 400 days old", () => {
    expect(indicatedAnnualDividend(history, on("2025-03-14"))).toBeCloseTo(
      0.96,
    );
    expect(indicatedAnnualDividend(history, on("2025-03-16"))).toBeNull();
  });

  it("infers the frequency from the trailing year when the label is missing", () => {
    const unlabeled = history
      .filter((row) => row.frequency !== "Special")
      .map((row) => ({ ...row, frequency: null }));
    expect(indicatedAnnualDividend(unlabeled, on("2023-12-31"))).toBeCloseTo(
      0.88,
    );
    const monthly = Array.from({ length: 12 }, (_, index) =>
      dividend(`2023-${String(index + 1).padStart(2, "0")}-05`, 0.1, null),
    );
    expect(indicatedAnnualDividend(monthly, on("2023-12-31"))).toBeCloseTo(1.2);
  });

  it("reads the provider's frequency labels", () => {
    expect(paymentsPerYear("Monthly")).toBe(12);
    expect(paymentsPerYear("Quarterly")).toBe(4);
    expect(paymentsPerYear("Semi-Annual")).toBe(2);
    expect(paymentsPerYear("Annual")).toBe(1);
    expect(paymentsPerYear("Irregular")).toBeNull();
    expect(paymentsPerYear(null)).toBeNull();
  });

  it("distrusts a frequency label the year's payments contradict", () => {
    // Quarterly payments, then a one-off $0.01 the provider labels monthly (XOM, 2001-06-18).
    const mislabeled = [
      dividend("2000-05-11", 0.22),
      dividend("2000-08-10", 0.22),
      dividend("2000-11-09", 0.22),
      dividend("2001-02-07", 0.22),
      dividend("2001-05-10", 0.22),
      dividend("2001-06-18", 0.01, "Monthly"),
    ];
    expect(indicatedAnnualDividend(mislabeled, on("2001-06-29"))).toBeCloseTo(
      0.88,
    );
    // A real cut is a cut: the latest rate is read when it is not out of cycle.
    const cut = [
      ...history.filter((row) => row.frequency !== "Special"),
      dividend("2024-05-10", 0.15),
    ];
    expect(indicatedAnnualDividend(cut, on("2024-05-31"))).toBeCloseTo(0.6);
  });

  it("takes payments per year from a label only when the count agrees", () => {
    expect(paymentsPerYearFor(4, 4)).toBe(4);
    expect(paymentsPerYearFor(4, 5)).toBe(4);
    expect(paymentsPerYearFor(12, 5)).toBe(4);
    expect(paymentsPerYearFor(12, 11)).toBe(12);
    expect(paymentsPerYearFor(null, 8)).toBeNull();
    expect(paymentsPerYearFor(12, 8)).toBe(12);
    expect(paymentsPerYearFor(1, 1)).toBe(1);
    expect(paymentsPerYearFor(null, 0)).toBeNull();
    // A new payer's first quarterly payment, and a year without one, cannot contradict the label.
    expect(paymentsPerYearFor(4, 1, true)).toBe(4);
    expect(paymentsPerYearFor(4, 0)).toBe(4);
    expect(paymentsPerYearFor(4, 1)).toBe(1);
  });
});

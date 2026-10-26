import { describe, expect, it } from "vitest";
import { mapFmpDividends } from "./dividend-mapping.js";

describe("FMP dividend mapping", () => {
  it("maps the provider's rows, ascending by ex-date, with both amounts and every date", () => {
    const mapped = mapFmpDividends([
      {
        symbol: "AAPL",
        date: "2026-08-10",
        recordDate: "2026-08-10",
        paymentDate: "2026-08-13",
        declarationDate: "2026-07-30",
        adjDividend: 0.27,
        dividend: 0.27,
        yield: 0.42,
        frequency: "Quarterly",
      },
      {
        symbol: "AAPL",
        date: "1995-11-21",
        recordDate: "",
        paymentDate: "",
        declarationDate: "1995-10-09",
        adjDividend: 0.00107143,
        dividend: 0.12,
        yield: 0,
        frequency: "Irregular",
      },
    ]);
    expect(mapped.dropped).toBe(0);
    expect(mapped.rows).toEqual([
      {
        exDate: "1995-11-21",
        recordDate: null,
        paymentDate: null,
        declarationDate: "1995-10-09",
        amount: 0.12,
        adjustedAmount: 0.00107143,
        frequency: "Irregular",
      },
      {
        exDate: "2026-08-10",
        recordDate: "2026-08-10",
        paymentDate: "2026-08-13",
        declarationDate: "2026-07-30",
        amount: 0.27,
        adjustedAmount: 0.27,
        frequency: "Quarterly",
      },
    ]);
  });

  it("drops a row without an ex-date or without both positive amounts, and counts it", () => {
    const mapped = mapFmpDividends([
      { symbol: "X", date: "not a date", dividend: 1, adjDividend: 1 },
      { symbol: "X", date: "2020-01-02", dividend: 1 },
      { symbol: "X", date: "2020-01-02", dividend: 0, adjDividend: 0 },
      {
        symbol: "X",
        date: "2020-04-02",
        dividend: 1,
        adjDividend: 0.5,
        frequency: " ",
      },
    ]);
    expect(mapped.dropped).toBe(3);
    expect(mapped.rows).toEqual([
      expect.objectContaining({
        exDate: "2020-04-02",
        adjustedAmount: 0.5,
        frequency: null,
      }),
    ]);
  });
});

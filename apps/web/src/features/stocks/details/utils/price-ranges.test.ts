import { describe, expect, it } from "vitest";
import {
  shiftLocalDate,
  shiftLocalDateDays,
  todayLocalDate,
} from "./local-dates";
import { rangeStartDate } from "./price-ranges";

describe("shiftLocalDate", () => {
  it("shifts whole months and years", () => {
    expect(shiftLocalDate("2026-08-28", { months: -1 })).toBe("2026-07-28");
    expect(shiftLocalDate("2026-08-28", { years: -5 })).toBe("2021-08-28");
  });

  it("clamps to the end of a shorter month instead of rolling over", () => {
    expect(shiftLocalDate("2026-03-31", { months: -1 })).toBe("2026-02-28");
    expect(shiftLocalDate("2024-03-31", { months: -1 })).toBe("2024-02-29");
    expect(shiftLocalDate("2024-02-29", { years: -1 })).toBe("2023-02-28");
  });

  it("crosses year boundaries", () => {
    expect(shiftLocalDate("2026-01-15", { months: -3 })).toBe("2025-10-15");
  });

  it("rejects invalid dates", () => {
    expect(() => shiftLocalDate("garbage", { months: -1 })).toThrow();
  });
});

describe("shiftLocalDateDays", () => {
  it("shifts whole calendar days across month and year boundaries", () => {
    expect(shiftLocalDateDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftLocalDateDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftLocalDateDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftLocalDateDays("2026-08-28", -365)).toBe("2025-08-28");
  });

  it("rejects invalid dates", () => {
    expect(() => shiftLocalDateDays("garbage", -1)).toThrow();
  });
});

describe("todayLocalDate", () => {
  it("uses the UTC calendar date", () => {
    expect(todayLocalDate(() => new Date("2026-08-28T23:30:00.000Z"))).toBe(
      "2026-08-28",
    );
  });
});

describe("rangeStartDate", () => {
  it("is calendar-based, anchored to the latest trading day", () => {
    expect(rangeStartDate("1M", "2026-08-28")).toBe("2026-07-28");
    expect(rangeStartDate("3M", "2026-08-28")).toBe("2026-05-28");
    expect(rangeStartDate("6M", "2026-08-28")).toBe("2026-02-28");
    expect(rangeStartDate("1Y", "2026-08-28")).toBe("2025-08-28");
    expect(rangeStartDate("5Y", "2026-08-28")).toBe("2021-08-28");
  });

  it("has no calendar shift of its own for MAX", () => {
    // MAX starts at the security's permitted history bound, which the API reports.
    expect(rangeStartDate("MAX", "2026-08-28")).toBeUndefined();
  });
});

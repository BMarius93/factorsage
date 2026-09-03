import { describe, expect, it } from "vitest";
import { shiftLocalDate, todayLocalDate } from "./local-dates";
import {
  rangeExceedsWindow,
  rangeStartDate,
  sliceFromDate,
} from "./price-ranges";

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

  it("has no lower bound for MAX", () => {
    expect(rangeStartDate("MAX", "2026-08-28")).toBeUndefined();
  });
});

describe("rangeExceedsWindow", () => {
  const windowStart = "2025-08-28";
  const windowEnd = "2026-08-28";

  it("keeps ranges inside a one-year window client-side", () => {
    expect(rangeExceedsWindow("1M", windowStart, windowEnd)).toBe(false);
    expect(rangeExceedsWindow("6M", windowStart, windowEnd)).toBe(false);
    expect(rangeExceedsWindow("1Y", windowStart, windowEnd)).toBe(false);
  });

  it("flags ranges that reach beyond the loaded window", () => {
    expect(rangeExceedsWindow("5Y", windowStart, windowEnd)).toBe(true);
    expect(rangeExceedsWindow("MAX", windowStart, windowEnd)).toBe(true);
  });

  it("does not make the default range look oversized while the market is closed", () => {
    // The window still ends today; the last close is days old. Anchoring the range to that close
    // used to place its start before the window and pull the entire history in on every open.
    expect(rangeExceedsWindow("1Y", windowStart, windowEnd)).toBe(false);
    expect(rangeStartDate("1Y", "2026-08-24")).toBe("2025-08-24");
    expect(rangeStartDate("1Y", "2026-08-24")! < windowStart).toBe(true);
  });
});

describe("sliceFromDate", () => {
  const rows = [
    { date: "2026-05-27" },
    { date: "2026-05-28" },
    { date: "2026-08-28" },
  ];

  it("keeps rows on or after the boundary", () => {
    expect(sliceFromDate(rows, "2026-05-28", (row) => row.date)).toEqual([
      { date: "2026-05-28" },
      { date: "2026-08-28" },
    ]);
  });

  it("returns everything when the boundary is open (MAX)", () => {
    expect(sliceFromDate(rows, undefined, (row) => row.date)).toEqual(rows);
  });

  it("returns an empty list when nothing falls inside the range", () => {
    expect(sliceFromDate(rows, "2027-01-01", (row) => row.date)).toEqual([]);
  });
});

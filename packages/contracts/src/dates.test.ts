import { describe, expect, it } from "vitest";
import { newYorkDate, subtractMonths } from "./dates.js";

describe("subtractMonths", () => {
  it("moves back whole calendar months on the same day", () => {
    expect(subtractMonths("2026-10-09", 1)).toBe("2026-09-09");
    expect(subtractMonths("2026-10-09", 3)).toBe("2026-07-09");
    expect(subtractMonths("2026-10-09", 6)).toBe("2026-04-09");
  });

  it("crosses a year boundary", () => {
    expect(subtractMonths("2026-01-15", 1)).toBe("2025-12-15");
    expect(subtractMonths("2026-02-10", 6)).toBe("2025-08-10");
  });

  it("clamps to the last day of a shorter month instead of rolling over", () => {
    expect(subtractMonths("2026-03-31", 1)).toBe("2026-02-28");
    expect(subtractMonths("2026-05-31", 1)).toBe("2026-04-30");
    expect(subtractMonths("2026-12-31", 6)).toBe("2026-06-30");
    expect(subtractMonths("2026-08-31", 6)).toBe("2026-02-28");
  });

  it("lands on 29 February in a leap year", () => {
    expect(subtractMonths("2024-03-31", 1)).toBe("2024-02-29");
    expect(subtractMonths("2024-05-29", 3)).toBe("2024-02-29");
    expect(subtractMonths("2028-08-30", 6)).toBe("2028-02-29");
  });

  it("refuses a date that is not a calendar date", () => {
    expect(() => subtractMonths("2026-02-30", 1)).toThrow();
    expect(() => subtractMonths("20261009", 1)).toThrow();
  });
});

describe("newYorkDate", () => {
  it("is the New York day, not the UTC one, in the evening hours where they differ", () => {
    // 22:00 in New York (EDT) is already the next day in UTC.
    expect(newYorkDate(new Date("2026-10-15T02:00:00.000Z"))).toBe(
      "2026-10-14",
    );
    // 19:00 in New York (EST).
    expect(newYorkDate(new Date("2026-01-16T00:00:00.000Z"))).toBe(
      "2026-01-15",
    );
    expect(newYorkDate(new Date("2026-10-14T15:00:00.000Z"))).toBe(
      "2026-10-14",
    );
  });

  it("turns at New York midnight on both sides of a DST change", () => {
    expect(newYorkDate(new Date("2026-03-08T04:59:59.000Z"))).toBe(
      "2026-03-07",
    );
    expect(newYorkDate(new Date("2026-03-08T05:00:00.000Z"))).toBe(
      "2026-03-08",
    );
    expect(newYorkDate(new Date("2026-11-01T03:59:59.000Z"))).toBe(
      "2026-10-31",
    );
    expect(newYorkDate(new Date("2026-11-01T04:00:00.000Z"))).toBe(
      "2026-11-01",
    );
  });
});

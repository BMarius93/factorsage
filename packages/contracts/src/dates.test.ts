import { describe, expect, it } from "vitest";
import { subtractMonths } from "./dates.js";

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

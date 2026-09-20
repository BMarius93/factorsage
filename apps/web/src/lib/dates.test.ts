import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDay, formatRelative } from "./dates";

describe("dates (UI-049)", () => {
  it("writes a calendar day in UTC, so no timezone can move it", () => {
    expect(formatDay("1982-11-30")).toBe("Nov 30, 1982");
    expect(formatDay("2020-01-01")).toBe("Jan 1, 2020");
  });

  it("writes instants in one product locale", () => {
    expect(formatDate("2026-03-04T12:00:00.000Z")).toMatch(/^Mar [34], 2026$/);
    expect(formatDateTime("2026-03-04T12:00:00.000Z")).toMatch(
      /^Mar [34], 2026, \d{1,2}:\d{2} (AM|PM)$/,
    );
  });

  it("returns an unparsable value unchanged", () => {
    expect(formatDay("n/a")).toBe("n/a");
    expect(formatDate("n/a")).toBe("n/a");
    expect(formatDateTime("n/a")).toBe("n/a");
  });

  it("says how long ago, in words", () => {
    const now = new Date("2026-09-19T12:00:00.000Z");
    expect(formatRelative("2026-09-19T11:59:40.000Z", now)).toBe("just now");
    expect(formatRelative("2026-09-19T11:48:00.000Z", now)).toBe("12 min ago");
    expect(formatRelative("2026-09-19T09:00:00.000Z", now)).toBe("3 h ago");
    expect(formatRelative("2026-09-18T00:00:00.000Z", now)).toBe("36 h ago");
    expect(formatRelative("2026-09-16T12:00:00.000Z", now)).toBe("3 days ago");
    expect(formatRelative("2026-09-17T12:00:00.000Z", now)).toBe("2 days ago");
  });
});

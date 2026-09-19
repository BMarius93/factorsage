import { describe, expect, it } from "vitest";
import {
  EMPTY_MEMBERSHIP,
  formatMembershipPeriod,
  membershipError,
  membershipHeadline,
  membershipSummary,
  previewMembershipPeriod,
  toEditableMembership,
  toRequestRange,
} from "./buy-windows";

describe("formatMembershipPeriod", () => {
  it("renders an open-ended period as Present, never null or a placeholder", () => {
    expect(
      formatMembershipPeriod({ startDate: "1982-11-30", endDate: null }),
    ).toBe("Nov 30, 1982 → Present");
  });

  it("renders a bounded period with both dates", () => {
    expect(
      formatMembershipPeriod({
        startDate: "2001-03-10",
        endDate: "2008-07-15",
      }),
    ).toBe("Mar 10, 2001 → Jul 15, 2008");
  });

  it("formats in UTC so a western timezone cannot render the previous day", () => {
    expect(
      formatMembershipPeriod({ startDate: "2020-01-01", endDate: null }),
    ).toContain("Jan 1, 2020");
  });
});

describe("membershipSummary (UI-019)", () => {
  const TODAY = "2026-09-19";
  const summarise = (
    buyWindows: { startDate: string; endDate: string | null }[],
  ) => membershipSummary({ buyWindowMode: "CUSTOM", buyWindows }, TODAY);

  it("reports FULL as always eligible, with no period to lead with", () => {
    const summary = membershipSummary(
      { buyWindowMode: "FULL", buyWindows: [] },
      TODAY,
    );
    expect(summary.leading).toBeNull();
    expect(membershipHeadline(summary)).toBe("Always eligible");
  });

  it("leads with an open period covering today", () => {
    const summary = summarise([{ startDate: "2025-09-19", endDate: null }]);
    expect(summary.state).toBe("CURRENT");
    expect(membershipHeadline(summary)).toBe("Member now · since Sep 19, 2025");
  });

  it("leads with a bounded period covering today, and says when it ends", () => {
    const summary = summarise([
      { startDate: "2025-01-02", endDate: "2026-12-31" },
    ]);
    expect(summary.state).toBe("CURRENT");
    expect(membershipHeadline(summary)).toBe("Member now · until Dec 31, 2026");
  });

  it("says when a future-only membership starts", () => {
    const summary = summarise([{ startDate: "2027-01-04", endDate: null }]);
    expect(summary.state).toBe("UPCOMING");
    expect(membershipHeadline(summary)).toBe("Joins Jan 4, 2027");
  });

  it("says when an expired-only membership ended — the most recent period, not the oldest", () => {
    const summary = summarise([
      { startDate: "2010-01-04", endDate: "2012-06-29" },
      { startDate: "2015-01-02", endDate: "2018-06-29" },
    ]);
    expect(summary.state).toBe("ENDED");
    expect(membershipHeadline(summary)).toBe("Ended Jun 29, 2018");
  });

  it("puts today's period first for a member that left and rejoined", () => {
    // Stored oldest first: the old UI showed "Jan 2, 2015 → Jun 29, 2018 +2 more" for a stock
    // that is a member today.
    const summary = summarise([
      { startDate: "2015-01-02", endDate: "2018-06-29" },
      { startDate: "2020-03-02", endDate: "2021-12-31" },
      { startDate: "2025-09-19", endDate: null },
    ]);
    expect(summary.state).toBe("CURRENT");
    expect(summary.leading).toEqual({ startDate: "2025-09-19", endDate: null });
    expect(summary.periods).toHaveLength(3);
  });
});

describe("toEditableMembership", () => {
  it("defaults an unrestricted member to an open-ended, undated period", () => {
    expect(toEditableMembership([])).toEqual(EMPTY_MEMBERSHIP);
    expect(EMPTY_MEMBERSHIP.present).toBe(true);
  });

  it("marks a null end date as Present rather than as an empty end input", () => {
    expect(
      toEditableMembership([{ startDate: "1982-11-30", endDate: null }]),
    ).toEqual({ startDate: "1982-11-30", endDate: "", present: true });
  });

  it("seeds from the first period only, which is why the editor guards multi-period items", () => {
    expect(
      toEditableMembership([
        { startDate: "2001-03-10", endDate: "2008-07-15" },
        { startDate: "2012-05-01", endDate: null },
      ]),
    ).toEqual({
      startDate: "2001-03-10",
      endDate: "2008-07-15",
      present: false,
    });
  });
});

describe("toRequestRange", () => {
  it("sends Present as an explicit null end date", () => {
    expect(
      toRequestRange({ startDate: "1982-11-30", endDate: "", present: true }),
    ).toEqual({ startDate: "1982-11-30", endDate: null });
  });

  it("ignores a stale end date once Present is chosen", () => {
    expect(
      toRequestRange({
        startDate: "2001-03-10",
        endDate: "2008-07-15",
        present: true,
      }),
    ).toEqual({ startDate: "2001-03-10", endDate: null });
  });

  it("sends a bounded period as both dates", () => {
    expect(
      toRequestRange({
        startDate: "2001-03-10",
        endDate: "2008-07-15",
        present: false,
      }),
    ).toEqual({ startDate: "2001-03-10", endDate: "2008-07-15" });
  });
});

describe("membershipError", () => {
  it("requires a start date", () => {
    expect(
      membershipError({ startDate: "", endDate: "", present: true }),
    ).toEqual({
      field: "startDate",
      message: "Pick the date membership starts",
    });
  });

  it("requires an end date unless Present is chosen", () => {
    expect(
      membershipError({
        startDate: "2020-01-01",
        endDate: "",
        present: false,
      }),
    ).toEqual({
      field: "endDate",
      message: "Pick the date membership ends, or choose Present",
    });
  });

  it("rejects an end before the start, the same rule the domain enforces", () => {
    expect(
      membershipError({
        startDate: "2020-01-01",
        endDate: "2019-01-01",
        present: false,
      }),
    ).toEqual({
      field: "endDate",
      message: "Membership cannot end before it starts",
    });
  });

  it("accepts a single-day, a bounded and an open-ended period", () => {
    expect(
      membershipError({
        startDate: "2020-01-01",
        endDate: "2020-01-01",
        present: false,
      }),
    ).toBeNull();
    expect(
      membershipError({
        startDate: "2020-01-01",
        endDate: "2020-12-31",
        present: false,
      }),
    ).toBeNull();
    expect(
      membershipError({ startDate: "2020-01-01", endDate: "", present: true }),
    ).toBeNull();
  });
});

describe("previewMembershipPeriod", () => {
  it("previews what will be saved once the period is valid", () => {
    expect(
      previewMembershipPeriod({
        startDate: "1982-11-30",
        endDate: "",
        present: true,
      }),
    ).toBe("Nov 30, 1982 → Present");
  });

  it("previews nothing while the period is incomplete or invalid", () => {
    expect(previewMembershipPeriod(EMPTY_MEMBERSHIP)).toBeNull();
    expect(
      previewMembershipPeriod({
        startDate: "2020-01-01",
        endDate: "2019-01-01",
        present: false,
      }),
    ).toBeNull();
  });
});

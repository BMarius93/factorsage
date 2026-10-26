import type { LocalDate } from "@intrinsic/domain";
import { RECONSTITUTION } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  addCalendarDays,
  compositeScores,
  intersectRanges,
  measurePeriods,
  membersOn,
  membershipPeriods,
  normalizeRanges,
  percentileRanks,
  reconstitutionDates,
  selectTop,
  type MembershipRange,
} from "./engine.js";

const d = (value: string) => value as LocalDate;

/** Weekday sessions between two dates, inclusive, without holidays. */
function weekdays(from: string, to: string): LocalDate[] {
  const sessions: LocalDate[] = [];
  for (let day = d(from); day <= to; day = addCalendarDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) sessions.push(day);
  }
  return sessions;
}

describe("historical universes engine: reconstitution dates", () => {
  it("is the last observed session of each listed month, effective the next day", () => {
    const sessions = weekdays("2024-01-01", "2024-07-15");
    const dates = reconstitutionDates({
      sessions,
      reconstitution: RECONSTITUTION.QUARTERLY,
      from: d("2024-01-01"),
      to: d("2024-12-31"),
    });
    expect(dates).toEqual([
      { date: "2024-03-29", effectiveDate: "2024-03-30" },
      { date: "2024-06-28", effectiveDate: "2024-06-29" },
    ]);
  });

  it("follows the observed calendar: a holiday on the last weekday moves the date earlier", () => {
    // 2024-05-31 is missing: the provider printed no session that day.
    const sessions = weekdays("2024-05-01", "2024-06-10").filter(
      (day) => day !== "2024-05-31",
    );
    const dates = reconstitutionDates({
      sessions,
      reconstitution: RECONSTITUTION.MONTHLY,
      from: d("2024-05-01"),
      to: d("2024-06-30"),
    });
    expect(dates).toEqual([
      { date: "2024-05-30", effectiveDate: "2024-05-31" },
    ]);
  });

  it("never treats the latest, possibly unfinished, month as complete", () => {
    const sessions = weekdays("2024-01-01", "2024-03-29");
    const monthly = (sessionsComplete?: boolean) =>
      reconstitutionDates({
        sessions,
        reconstitution: RECONSTITUTION.MONTHLY,
        from: d("2024-01-01"),
        to: d("2024-12-31"),
        ...(sessionsComplete === undefined ? {} : { sessionsComplete }),
      }).map((date) => date.date);
    expect(monthly()).toEqual(["2024-01-31", "2024-02-29"]);
    expect(monthly(true)).toEqual(["2024-01-31", "2024-02-29", "2024-03-29"]);
  });

  it("selects annual dates in December only and respects the range", () => {
    const sessions = weekdays("2021-01-01", "2024-02-15");
    const dates = reconstitutionDates({
      sessions,
      reconstitution: RECONSTITUTION.ANNUAL,
      from: d("2022-01-01"),
      to: d("2024-12-31"),
    });
    expect(dates.map((date) => date.date)).toEqual([
      "2022-12-30",
      "2023-12-29",
    ]);
  });
});

describe("historical universes engine: ranking", () => {
  it("ranks the highest values first, ties by the larger tie-break, then the security id", () => {
    const outcome = selectTop(
      [
        { securityId: "c", value: 2, tieBreak: 10 },
        { securityId: "b", value: 2, tieBreak: 20 },
        { securityId: "a", value: 2, tieBreak: 20 },
        { securityId: "d", value: 3, tieBreak: null },
        { securityId: "e", value: null, tieBreak: 99 },
        { securityId: "f", value: Number.NaN, tieBreak: 99 },
      ],
      { order: "HIGHEST", select: { count: 3 } },
    );
    expect(outcome.selected).toEqual([
      { securityId: "d", rank: 1, value: 3 },
      { securityId: "a", rank: 2, value: 2 },
      { securityId: "b", rank: 3, value: 2 },
    ]);
    expect(outcome.withValue).toBe(4);
    expect(outcome.expected).toBe(3);
  });

  it("ranks the lowest values first for a LOWEST rule, with the same tie order", () => {
    const outcome = selectTop(
      [
        { securityId: "x", value: 5, tieBreak: 1 },
        { securityId: "y", value: 1, tieBreak: 1 },
        { securityId: "z", value: 1, tieBreak: 2 },
      ],
      { order: "LOWEST", select: { count: 2 } },
    );
    expect(outcome.selected.map((entry) => entry.securityId)).toEqual([
      "z",
      "y",
    ]);
  });

  it("is independent of the candidates' input order", () => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({
      securityId: `s${String(index).padStart(2, "0")}`,
      value: index % 7,
      tieBreak: index % 3,
    }));
    const forward = selectTop(candidates, {
      order: "HIGHEST",
      select: { count: 10 },
    });
    const reversed = selectTop([...candidates].reverse(), {
      order: "HIGHEST",
      select: { count: 10 },
    });
    expect(reversed).toEqual(forward);
  });

  it("asks for a fraction of the candidates with a value, rounded half up", () => {
    const candidates = Array.from({ length: 10 }, (_, index) => ({
      securityId: `s${index}`,
      value: index,
      tieBreak: null,
    }));
    expect(
      selectTop(candidates, { order: "HIGHEST", select: { fraction: 1 / 3 } })
        .expected,
    ).toBe(3);
    expect(
      selectTop(
        [
          ...candidates,
          { securityId: "s10", value: 10, tieBreak: null },
          { securityId: "s11", value: 11, tieBreak: null },
        ],
        {
          order: "HIGHEST",
          select: { fraction: 1 / 3 },
        },
      ).expected,
    ).toBe(4);
  });

  it("drops zero and negative values when the rule takes positive values only", () => {
    const outcome = selectTop(
      [
        { securityId: "a", value: 0, tieBreak: null },
        { securityId: "b", value: -1, tieBreak: null },
        { securityId: "c", value: 0.02, tieBreak: null },
      ],
      { order: "HIGHEST", select: { count: 3 }, positiveOnly: true },
    );
    expect(outcome.selected.map((entry) => entry.securityId)).toEqual(["c"]);
    expect(outcome.withValue).toBe(1);
    expect(outcome.expected).toBe(3);
  });

  it("shares percentile ranks between ties and composes only candidates with enough components", () => {
    expect(
      percentileRanks(
        new Map([
          ["a", 1],
          ["b", 2],
          ["c", 2],
          ["d", 4],
          ["e", null],
        ]),
      ),
    ).toEqual(
      new Map([
        ["a", 0],
        ["b", 0.5],
        ["c", 0.5],
        ["d", 1],
      ]),
    );
    expect(percentileRanks(new Map([["only", 3]]))).toEqual(
      new Map([["only", 0.5]]),
    );
    const scores = compositeScores(
      [
        new Map([
          ["a", 1],
          ["b", 2],
          ["c", 3],
        ]),
        new Map<string, number | null>([
          ["a", 3],
          ["b", null],
          ["c", 1],
        ]),
      ],
      2,
    );
    expect(scores).toEqual(
      new Map<string, number | null>([
        ["a", 0.5],
        ["b", null],
        ["c", 0.5],
      ]),
    );
  });
});

describe("historical universes engine: membership periods", () => {
  const parent = new Map<string, MembershipRange[]>([
    ["a", [{ startDate: d("1990-01-01"), endDate: null }]],
    ["b", [{ startDate: d("1990-01-01"), endDate: d("2024-05-15") }]],
    ["c", [{ startDate: d("2024-02-10"), endDate: null }]],
  ]);
  const selections = [
    {
      date: d("2024-01-31"),
      effectiveDate: d("2024-02-01"),
      securityIds: ["a", "b"],
    },
    {
      date: d("2024-02-29"),
      effectiveDate: d("2024-03-01"),
      securityIds: ["a", "c"],
    },
    {
      date: d("2024-03-28"),
      effectiveDate: d("2024-03-29"),
      securityIds: ["b", "c"],
    },
    {
      date: d("2024-04-30"),
      effectiveDate: d("2024-05-01"),
      securityIds: ["a", "b"],
    },
  ];

  it("runs each selection from its effective date through the next reconstitution date", () => {
    const periods = membershipPeriods({
      selections,
      parent,
      floor: d("1996-01-02"),
    });
    expect(periods.get("a")).toEqual([
      { startDate: "2024-02-01", endDate: "2024-03-28" },
      // Re-entry: dropped at the March reconstitution, selected again in April.
      { startDate: "2024-05-01", endDate: null },
    ]);
    expect(periods.get("c")).toEqual([
      { startDate: "2024-03-01", endDate: "2024-04-30" },
    ]);
  });

  it("clips a selection to the member's parent membership", () => {
    const periods = membershipPeriods({
      selections,
      parent,
      floor: d("1996-01-02"),
    });
    // b left the parent on 2024-05-15, inside its last selection.
    expect(periods.get("b")).toEqual([
      { startDate: "2024-02-01", endDate: "2024-02-29" },
      { startDate: "2024-03-29", endDate: "2024-05-15" },
    ]);
  });

  it("clips to the floor and drops ranges that end before it", () => {
    const periods = membershipPeriods({
      selections: [
        {
          date: d("1995-11-30"),
          effectiveDate: d("1995-12-01"),
          securityIds: ["b"],
        },
        {
          date: d("1995-12-29"),
          effectiveDate: d("1995-12-30"),
          securityIds: ["a"],
        },
        {
          date: d("1996-01-31"),
          effectiveDate: d("1996-02-01"),
          securityIds: ["a"],
        },
      ],
      parent,
      floor: d("1996-01-02"),
    });
    expect(periods.get("a")).toEqual([
      { startDate: "1996-01-02", endDate: null },
    ]);
    expect(periods.has("b")).toBe(false);
  });

  it("measures the peak of simultaneous members and the distinct securities", () => {
    const periods = membershipPeriods({
      selections,
      parent,
      floor: d("1996-01-02"),
    });
    expect(measurePeriods(periods)).toEqual({
      distinctSecurities: 3,
      peakSimultaneousMembers: 2,
      peakDate: "2024-02-01",
    });
  });

  it("lists the parent's members on a date, sorted", () => {
    expect(membersOn(parent, d("2024-03-01"))).toEqual(["a", "b", "c"]);
    expect(membersOn(parent, d("2024-06-01"))).toEqual(["a", "c"]);
  });

  it("intersects and normalizes ranges", () => {
    expect(
      intersectRanges(
        [{ startDate: d("2024-01-01"), endDate: d("2024-03-31") }],
        [
          { startDate: d("2023-01-01"), endDate: d("2024-01-15") },
          { startDate: d("2024-03-01"), endDate: null },
        ],
      ),
    ).toEqual([
      { startDate: "2024-01-01", endDate: "2024-01-15" },
      { startDate: "2024-03-01", endDate: "2024-03-31" },
    ]);
    expect(
      normalizeRanges([
        { startDate: d("2024-02-01"), endDate: null },
        { startDate: d("2024-01-01"), endDate: d("2024-01-31") },
        { startDate: d("2023-01-01"), endDate: d("2023-02-01") },
      ]),
    ).toEqual([
      { startDate: "2023-01-01", endDate: "2023-02-01" },
      { startDate: "2024-01-01", endDate: null },
    ]);
  });
});

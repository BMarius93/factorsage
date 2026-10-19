import { describe, expect, it } from "vitest";
import type { StoredMembershipPeriod } from "./ports.js";
import { membershipQualityReport, projectIndexList } from "./quality.js";

/**
 * The built-in List is a projection of the canonical membership
 * (`docs/decisions/sp500-historical-pit-v1.md` §5): every resolved constituent — current **and
 * former** — with buy windows exactly as long as its memberships, and nothing for a constituent the
 * provider could not price or identify. Survivorship is decided here: a former member must stay in,
 * an unresolved one must not be replaced by anything.
 */

const FLOOR = "1996-01-02";

const period = (
  startDate: string | null,
  endDate: string | null,
  quality: StoredMembershipPeriod["quality"] = "CONFIRMED",
): StoredMembershipPeriod => ({
  startDate,
  startLogDate: startDate,
  endDate,
  endLogDate: endDate,
  quality,
  startChangeHash: null,
  endChangeHash: null,
  startMatch: null,
});

const constituent = (
  constituentKey: string,
  securityId: string | null,
  resolution: "RESOLVED" | "RESOLVED_PARTIAL" | "NO_PROVIDER_DATA" | "IDENTITY_REJECTED",
  periods: StoredMembershipPeriod[],
) => ({ constituentKey, securityId, resolution, periods });

describe("projectIndexList", () => {
  it("keeps former members with their closed windows, and current ones open", () => {
    const members = projectIndexList(
      [
        constituent("CURRENT:AAPL", "aapl", "RESOLVED", [period("1982-11-30", null, "START_BEFORE_LOG")]),
        // Lehman: a member until the day before its 2008 removal took effect.
        constituent("REMOVAL:leh", "leh", "RESOLVED", [period("1994-05-31", "2008-09-15")]),
        constituent("CURRENT:UBER", "uber", "RESOLVED_PARTIAL", [period("2023-12-18", null)]),
      ],
      FLOOR,
    );
    expect(members).toEqual([
      { securityId: "aapl", ranges: [{ startDate: FLOOR, endDate: null }], constituentKeys: ["CURRENT:AAPL"] },
      { securityId: "leh", ranges: [{ startDate: FLOOR, endDate: "2008-09-15" }], constituentKeys: ["REMOVAL:leh"] },
      { securityId: "uber", ranges: [{ startDate: "2023-12-18", endDate: null }], constituentKeys: ["CURRENT:UBER"] },
    ]);
  });

  it("never substitutes anything for a constituent the provider could not price or identify", () => {
    expect(
      projectIndexList(
        [
          constituent("REMOVAL:enron", null, "NO_PROVIDER_DATA", [period("1996-01-02", "2001-11-29")]),
          // A rejected identity keeps no security, even if the evidence named one.
          constituent("REMOVAL:par", "par-technology", "IDENTITY_REJECTED", [period("1997-01-02", "1998-01-02")]),
        ],
        FLOOR,
      ),
    ).toEqual([]);
  });

  it("projects no period whose end is unknown, and none that ended before the floor", () => {
    expect(
      projectIndexList(
        [
          constituent("ADDITION:orphan", "orphan", "RESOLVED", [period("2004-01-02", null, "END_UNKNOWN")]),
          constituent("REMOVAL:old", "old", "RESOLVED", [period("1980-01-02", "1990-06-30")]),
        ],
        FLOOR,
      ),
    ).toEqual([]);
  });

  it("gives one member per security, its stints as separate windows, in canonical order", () => {
    // An issuer that left the index and rejoined; and one security carrying two consecutive
    // constituents (a successor ticker), whose adjacent windows merge.
    const [left, carried] = projectIndexList(
      [
        constituent("REMOVAL:a-2", "a", "RESOLVED", [period("2015-03-23", null)]),
        constituent("REMOVAL:a-1", "a", "RESOLVED", [period("2001-06-01", "2009-03-01")]),
        constituent("REMOVAL:b-old", "b", "RESOLVED", [period("1999-01-04", "2005-06-30")]),
        constituent("CURRENT:B", "b", "RESOLVED", [period("2005-07-01", null)]),
      ],
      FLOOR,
    );
    expect(left).toEqual({
      securityId: "a",
      ranges: [
        { startDate: "2001-06-01", endDate: "2009-03-01" },
        { startDate: "2015-03-23", endDate: null },
      ],
      constituentKeys: ["REMOVAL:a-1", "REMOVAL:a-2"],
    });
    expect(carried?.ranges).toEqual([{ startDate: "1999-01-04", endDate: null }]);
  });

  it("keeps a security a member on an unconfirmed date it both left and rejoined on", () => {
    // DuPont: E. I. du Pont left on the 2017-08-31 log date and DowDuPont, the same security,
    // joined on it. Whichever session that date names, the security was in the index on it; an
    // unrelated security's deferred start is left alone.
    const leaves: StoredMembershipPeriod = {
      ...period("1996-01-02", "2017-08-30"),
      endLogDate: null,
    };
    const rejoins: StoredMembershipPeriod = {
      ...period("2017-09-01", null),
      startLogDate: "2017-08-31",
    };
    const unrelated: StoredMembershipPeriod = {
      ...period("2017-09-01", null),
      startLogDate: "2017-08-31",
    };
    const [dd, other] = projectIndexList(
      [
        constituent("REMOVAL:dd", "dd", "RESOLVED", [leaves]),
        constituent("CURRENT:DD", "dd", "RESOLVED", [rejoins]),
        constituent("CURRENT:X", "x", "RESOLVED", [unrelated]),
      ],
      FLOOR,
    );
    expect(dd?.ranges).toEqual([{ startDate: FLOOR, endDate: null }]);
    expect(other?.ranges).toEqual([{ startDate: "2017-09-01", endDate: null }]);
  });
});

describe("membershipQualityReport", () => {
  it("counts the lines on every day and reports where they leave the band", () => {
    const report = membershipQualityReport(
      [
        { constituentKey: "A", ticker: "A", periods: [period("1996-01-02", null)] },
        {
          constituentKey: "B",
          ticker: "B",
          periods: [period("1996-01-02", "1996-01-10")],
        },
      ],
      { floor: "1996-01-02", asOf: "1996-01-31" },
    );
    expect(report.minimum.lines).toBe(1);
    expect(report.maximum.lines).toBe(2);
  });
});

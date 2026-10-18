import { describe, expect, it } from "vitest";
import {
  decideConstituentResolution,
  expectedSessions,
  INDEX_ADDITION_MIN_MARKET_CAP,
  INDEX_LEGACY_MEMBER_MIN_MARKET_CAP,
  medianDollarVolume,
  membershipWithinHorizon,
  overlappingClaims,
  plausibilityRefusal,
  resolutionCandidates,
  type CandidateEvidence,
} from "./resolution.js";

const horizon = { floor: "1996-01-02", asOf: "2026-10-16" };

const evidence = (
  overrides: Partial<CandidateEvidence> & Pick<CandidateEvidence, "symbol">,
): CandidateEvidence => ({
  sessionsInMembership: 0,
  expectedSessions: 100,
  firstSessionInMembership: null,
  lastSessionInMembership: null,
  marketCapAtFirstSession: null,
  medianDollarVolume: null,
  marketCapTrusted: null,
  marketCapFloor: INDEX_ADDITION_MIN_MARKET_CAP,
  listingName: null,
  nameSimilarity: 0,
  refusal: null,
  ...overrides,
});

describe("membershipWithinHorizon", () => {
  it("clips periods to the horizon and drops unknown ends", () => {
    expect(
      membershipWithinHorizon(
        [
          { startDate: null, endDate: "1990-01-01", quality: "START_BEFORE_LOG" },
          { startDate: null, endDate: "2001-05-04", quality: "START_BEFORE_LOG" },
          { startDate: "2010-03-01", endDate: null, quality: "CONFIRMED" },
          { startDate: "2004-01-01", endDate: null, quality: "END_UNKNOWN" },
        ],
        horizon,
      ),
    ).toEqual([
      { from: "1996-01-02", to: "2001-05-04" },
      { from: "2010-03-01", to: "2026-10-16" },
    ]);
  });
});

describe("resolutionCandidates", () => {
  it("is a current member's own symbol and nothing else", () => {
    expect(
      resolutionCandidates(
        { origin: "CURRENT", ticker: "META", tickerHistory: [{ ticker: "FB", from: null, to: null }] },
        "2026-10-16",
        [],
      ),
    ).toEqual(["META"]);
  });

  it("follows a removed issuer forward through its later renames, then its older tickers", () => {
    expect(
      resolutionCandidates(
        {
          origin: "REMOVAL",
          ticker: "YHOO",
          tickerHistory: [
            { ticker: "YHOO", from: null, to: null },
            { ticker: "OLDY", from: null, to: null },
          ],
        },
        "2017-06-16",
        [
          { date: "2017-06-19", oldSymbol: "YHOO", newSymbol: "AABA" },
          { date: "2010-01-01", oldSymbol: "YHOO", newSymbol: "BEFORE" },
        ],
      ),
    ).toEqual(["YHOO", "AABA", "OLDY"]);
  });
});

describe("plausibility of a candidate history", () => {
  it("refuses a small company's history the log names for a member (PAR Technology, 1997)", () => {
    expect(
      plausibilityRefusal({
        marketCap: 88_000_000,
        marketCapFloor: INDEX_ADDITION_MIN_MARKET_CAP,
        medianDollarVolume: 110_000,
      }),
    ).toEqual({ refusal: "IMPLAUSIBLE_MARKET_CAP", marketCapTrusted: true });
  });

  it("ignores a market capitalization inconsistent with the stock's own trading (Janus, 2003)", () => {
    // $18M of market capitalization against $26.7M traded every day: the capitalization is broken.
    expect(
      plausibilityRefusal({
        marketCap: 18_000_000,
        marketCapFloor: INDEX_ADDITION_MIN_MARKET_CAP,
        medianDollarVolume: 26_730_000,
      }),
    ).toEqual({ refusal: null, marketCapTrusted: false });
    // A $0 capitalization (Niagara Mohawk, 1996) with real trading.
    expect(
      plausibilityRefusal({
        marketCap: 0,
        marketCapFloor: INDEX_LEGACY_MEMBER_MIN_MARKET_CAP,
        medianDollarVolume: 3_770_000,
      }),
    ).toEqual({ refusal: null, marketCapTrusted: false });
  });

  it("refuses a history that barely trades when the capitalization cannot decide (Sovereign, 2004)", () => {
    expect(
      plausibilityRefusal({
        marketCap: 0,
        marketCapFloor: INDEX_ADDITION_MIN_MARKET_CAP,
        medianDollarVolume: 1_000,
      }),
    ).toEqual({ refusal: "IMPLAUSIBLE_TRADING", marketCapTrusted: false });
    expect(
      plausibilityRefusal({
        marketCap: null,
        marketCapFloor: INDEX_ADDITION_MIN_MARKET_CAP,
        medianDollarVolume: null,
      }),
    ).toEqual({ refusal: "IMPLAUSIBLE_TRADING", marketCapTrusted: null });
  });

  it("keeps a re-split history with a trusted, implausible capitalization out (Compuware's ticker, 2006)", () => {
    expect(
      plausibilityRefusal({
        marketCap: 171_000_000,
        marketCapFloor: INDEX_ADDITION_MIN_MARKET_CAP,
        medianDollarVolume: 23_570_000,
      }).refusal,
    ).toBe("IMPLAUSIBLE_MARKET_CAP");
  });

  it("measures traded value over the first membership sessions only", () => {
    expect(
      medianDollarVolume(
        [
          { date: "1995-12-29", close: 1000, volume: 1000 },
          { date: "1996-01-02", close: 10, volume: 100 },
          { date: "1996-01-03", close: 10, volume: 300 },
          { date: "1996-01-04", close: 10, volume: 200 },
        ],
        [{ from: "1996-01-02", to: "1996-12-31" }],
      ),
    ).toBe(2000);
    expect(medianDollarVolume([], [{ from: "1996-01-02", to: "1996-12-31" }])).toBeNull();
  });
});

describe("decideConstituentResolution", () => {
  it("takes the first usable candidate and grades its coverage", () => {
    const decision = decideConstituentResolution([
      evidence({ symbol: "WB", refusal: "NO_PRICES_IN_MEMBERSHIP" }),
      evidence({
        symbol: "WACH",
        sessionsInMembership: 95,
        firstSessionInMembership: "2001-09-04",
        lastSessionInMembership: "2008-12-31",
      }),
    ]);
    expect(decision).toEqual(
      expect.objectContaining({ resolution: "RESOLVED", symbol: "WACH", coverage: 0.95 }),
    );
    expect(
      decideConstituentResolution([
        evidence({
          symbol: "CELG",
          sessionsInMembership: 40,
          firstSessionInMembership: "2003-09-10",
          lastSessionInMembership: "2019-11-20",
        }),
      ]),
    ).toEqual(expect.objectContaining({ resolution: "RESOLVED_PARTIAL", coverage: 0.4 }));
  });

  it("reports a rejected identity apart from missing data", () => {
    expect(
      decideConstituentResolution([
        evidence({ symbol: "PAR", refusal: "IMPLAUSIBLE_MARKET_CAP", marketCapAtFirstSession: 88e6 }),
      ]).resolution,
    ).toBe("IDENTITY_REJECTED");
    expect(
      decideConstituentResolution([
        evidence({ symbol: "LEH", refusal: "NO_PRICES_IN_MEMBERSHIP" }),
      ]).resolution,
    ).toBe("NO_PROVIDER_DATA");
    expect(decideConstituentResolution([]).resolution).toBe("NO_PROVIDER_DATA");
  });
});

describe("overlappingClaims", () => {
  const claim = (
    constituentKey: string,
    windows: { from: string; to: string }[],
    overrides: Partial<Parameters<typeof overlappingClaims>[0][number]> = {},
  ) => ({
    constituentKey,
    current: false,
    symbol: "T",
    windows,
    ownTicker: true,
    nameSimilarity: 1,
    coverage: 1,
    ...overrides,
  });

  it("lets the current member keep its own symbol against a simultaneous member it absorbed", () => {
    // AT&T Inc. (current, formerly SBC) and AT&T Corp. (removed 2005) both claim `T`.
    expect(
      overlappingClaims([
        claim("REMOVAL:att-corp", [{ from: "1996-01-02", to: "2005-11-17" }]),
        claim("CURRENT:T", [{ from: "1996-01-02", to: "2026-10-16" }], {
          current: true,
          coverage: 0.99,
        }),
      ]),
    ).toEqual([
      {
        symbol: "T",
        kept: "CURRENT:T",
        refused: "REMOVAL:att-corp",
        overlap: { from: "1996-01-02", to: "2005-11-17" },
      },
    ]);
  });

  it("allows one security to carry consecutive constituents", () => {
    expect(
      overlappingClaims([
        claim("REMOVAL:a", [{ from: "2001-01-01", to: "2008-04-30" }]),
        claim("CURRENT:T", [{ from: "2015-01-02", to: "2026-10-16" }], { current: true }),
      ]),
    ).toEqual([]);
  });
});

describe("expectedSessions", () => {
  it("counts weekdays, less the holiday share", () => {
    // 2024: 262 weekdays, 252 sessions.
    expect(expectedSessions([{ from: "2024-01-01", to: "2024-12-31" }])).toBe(253);
    expect(expectedSessions([{ from: "2024-01-06", to: "2024-01-07" }])).toBe(0);
  });
});

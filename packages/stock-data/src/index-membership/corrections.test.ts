import type { DailyPrice, LocalDate } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { addDays } from "../dates.js";
import {
  INDEX_IDENTITY_CORRECTIONS,
  matchIdentityCorrections,
  type IndexIdentityCorrection,
  membershipLogDates,
  windowsFrom,
} from "./corrections.js";
import type {
  ConstituentResolutionWrite,
  IndexMembershipStore,
  StoredIndexConstituent,
  StoredMembershipPeriod,
} from "./ports.js";
import { projectIndexList } from "./quality.js";
import {
  IndexMembershipSyncService,
  type IndexMembershipProvider,
  type IndexUniverseListing,
} from "./sync-service.js";

/**
 * The three recoverable historical constituents (`corrections.ts`), on the shapes PostgreSQL holds
 * them in after the 2026-10-17 synchronization — keys, tickers, names and dates exactly as stored.
 */
function period(
  input: Partial<StoredMembershipPeriod>,
): StoredMembershipPeriod {
  return {
    startDate: null,
    startLogDate: null,
    endDate: null,
    endLogDate: null,
    quality: "CONFIRMED",
    startChangeHash: null,
    endChangeHash: null,
    startMatch: "EXACT_TICKER",
    ...input,
  };
}

function constituent(
  key: string,
  ticker: string,
  name: string,
  origin: StoredIndexConstituent["origin"],
  periods: StoredMembershipPeriod[],
  resolution: StoredIndexConstituent["resolution"] = "NO_PROVIDER_DATA",
  securityId: string | null = null,
): StoredIndexConstituent {
  return {
    id: key,
    constituentKey: key,
    origin,
    ticker,
    name,
    cik: null,
    tickerHistory: [{ ticker, from: null, to: null }],
    securityId,
    securityFrom: null,
    resolution,
    resolutionEvidence:
      resolution === "RESOLVED"
        ? { symbol: ticker, coverage: 1, candidates: [] }
        : null,
    periods,
  };
}

const STORED: StoredIndexConstituent[] = [
  constituent(
    "REMOVAL:fc1662cc",
    "RMG",
    "Cablevision Systems Corp.",
    "REMOVAL",
    [
      period({
        startDate: "2010-12-20",
        startLogDate: "2010-12-17",
        endDate: "2016-06-22",
      }),
    ],
  ),
  constituent("REMOVAL:dfbd402a", "DNB", "Dun & Bradstreet Corp", "REMOVAL", [
    period({
      startDate: "1979-12-28",
      startLogDate: "1979-12-27",
      endDate: "2000-10-01",
    }),
  ]),
  // The spun-off Dun & Bradstreet: same ticker and name, a different company. Never matched.
  constituent("REMOVAL:3661f7c0", "DNB", "Dun & Bradstreet Corp", "REMOVAL", [
    period({
      startDate: "2008-12-02",
      startLogDate: "2008-12-01",
      endDate: "2017-04-04",
      endLogDate: "2017-04-03",
    }),
  ]),
  constituent(
    "REMOVAL:6fbca9da",
    "DWD",
    "Dean Witter Discover & Co.",
    "REMOVAL",
    [
      period({
        startDate: "1993-07-13",
        startLogDate: "1993-07-12",
        endDate: "1997-06-01",
        endLogDate: "1997-05-29",
      }),
    ],
  ),
  constituent(
    "CURRENT:MS",
    "MS",
    "Morgan Stanley",
    "CURRENT",
    [
      period({
        startDate: "1995-09-22",
        startLogDate: "1995-09-21",
        startMatch: "TICKER_HISTORY",
      }),
    ],
    "RESOLVED",
    "security-ms",
  ),
  constituent(
    "CURRENT:MCO",
    "MCO",
    "Moody's Corporation",
    "CURRENT",
    [period({ startDate: "2000-10-03", startLogDate: "2000-10-02" })],
    "RESOLVED",
    "security-mco",
  ),
];

/** Listing spans the fake provider holds prices for; anything else has none. */
const LISTINGS: Record<
  string,
  { from: LocalDate; to: LocalDate; name: string }
> = {
  CVC: {
    from: "2010-12-20",
    to: "2016-06-20",
    name: "Cablevision Systems Corporation",
  },
  MCO: { from: "1994-10-31", to: "2026-10-16", name: "Moody's Corporation" },
  MS: { from: "1993-02-23", to: "2026-10-16", name: "Morgan Stanley" },
  // Romeo Power's history under the ticker the log mislabels Cablevision with.
  RMG: { from: "2020-12-29", to: "2021-02-08", name: "Romeo Power, Inc." },
  RMO: { from: "2021-02-09", to: "2022-10-14", name: "Romeo Power, Inc." },
};

class FakeProvider implements IndexMembershipProvider {
  readonly priceRequests: string[] = [];
  readonly profileRequests: string[] = [];
  async getIndexConstituents(): Promise<never> {
    throw new Error("not used");
  }
  async getIndexChanges(): Promise<never> {
    throw new Error("not used");
  }
  async getSymbolChanges(): Promise<never> {
    throw new Error("not used");
  }
  async getDelistedCompanies() {
    return { providerRowCount: 0, rows: [] };
  }
  async getHistoricalMarketCapitalization(
    symbol: string,
    range: { from: string },
  ) {
    return LISTINGS[symbol] ? [{ date: range.from, marketCap: 9e9 }] : [];
  }
  async getProfile(symbol: string) {
    this.profileRequests.push(symbol);
    const listing = LISTINGS[symbol];
    return listing
      ? ({
          providerSymbol: symbol,
          security: {
            symbol,
            name: listing.name,
            exchangeCode: "NYSE",
            currency: "USD",
            type: "STOCK",
            isAdr: false,
            isActivelyTrading: true,
          },
          profile: {},
        } as never)
      : null;
  }
  async getDailyPrices(
    symbol: string,
    securityId: string,
    range: { from?: string; to?: string },
  ) {
    this.priceRequests.push(symbol);
    const listing = LISTINGS[symbol];
    if (!listing) {
      return [];
    }
    const rows: DailyPrice[] = [];
    let date = range.from! > listing.from ? range.from! : listing.from;
    const to = range.to! < listing.to ? range.to! : listing.to;
    while (date <= to) {
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (weekday !== 0 && weekday !== 6) {
        rows.push({
          securityId,
          date,
          open: 50,
          high: 50,
          low: 50,
          close: 50,
          volume: 1_000_000,
        });
      }
      date = addDays(date, 1);
    }
    return rows;
  }
}

class MemoryStore {
  writes: ConstituentResolutionWrite[] = [];
  constructor(readonly constituents: StoredIndexConstituent[]) {}
  async loadConstituents() {
    return this.constituents;
  }
  async loadSymbolChanges() {
    return [
      {
        date: "2010-02-01",
        oldSymbol: "RMG",
        newSymbol: "RISK",
        contentHash: "a",
        companyName: "RiskMetrics",
      },
      {
        date: "2021-02-09",
        oldSymbol: "RMG",
        newSymbol: "RMO",
        contentHash: "b",
        companyName: "Romeo Power",
      },
    ];
  }
  async saveProbe() {}
  async saveResolutions(
    _indexKey: string,
    writes: readonly ConstituentResolutionWrite[],
  ) {
    this.writes.push(...writes);
  }
}

async function resolveAll(
  constituents = STORED,
  identityCorrections: readonly IndexIdentityCorrection[] = INDEX_IDENTITY_CORRECTIONS,
) {
  const store = new MemoryStore(constituents);
  const provider = new FakeProvider();
  const service = new IndexMembershipSyncService(
    store as unknown as IndexMembershipStore,
    provider,
    {
      now: () => new Date("2026-10-19T00:00:00Z"),
      probeConcurrency: 1,
      identityCorrections,
    },
  );
  const admitted: IndexUniverseListing[] = [];
  const result = await service.resolve({
    indexKey: "SP500",
    floor: "1996-01-02",
    asOf: "2026-10-16",
    admit: async (listings) => {
      admitted.push(...listings);
      return listings.map((listing) => ({
        symbol: listing.symbol,
        securityId: `security-${listing.symbol.toLowerCase()}`,
      }));
    },
  });
  const byKey = new Map(
    store.writes.map((write) => [write.constituentKey, write]),
  );
  return { result, byKey, provider, admitted };
}

describe("identity corrections", () => {
  it("matches each correction to exactly one stored constituent, and never the spun-off D&B", () => {
    const { applied, unmatched } = matchIdentityCorrections("SP500", STORED);
    expect(unmatched).toEqual([]);
    expect(
      Object.fromEntries(
        [...applied].map(([key, correction]) => [key, correction.symbol]),
      ),
    ).toEqual({
      "REMOVAL:fc1662cc": "CVC",
      "REMOVAL:dfbd402a": "MCO",
      "REMOVAL:6fbca9da": "MS",
      "CURRENT:MS": "MS",
    });
    expect(applied.has("REMOVAL:3661f7c0")).toBe(false);
    expect(membershipLogDates(STORED[3]!)).toEqual({
      addedOn: "1993-07-12",
      removedOn: "1997-05-30",
    });
  });

  it("is never applied to a constituent whose dates differ, nor when two match", () => {
    const moved = STORED.map((entry) =>
      entry.constituentKey === "REMOVAL:fc1662cc"
        ? {
            ...entry,
            periods: [
              period({
                startDate: "2010-12-21",
                startLogDate: "2010-12-20",
                endDate: "2016-06-22",
              }),
            ],
          }
        : entry,
    );
    const twice = [
      ...STORED,
      { ...STORED[3]!, constituentKey: "REMOVAL:copy" },
    ];
    expect(matchIdentityCorrections("SP500", moved).unmatched).toEqual([
      { id: "SP500:cablevision-1:CVC", matches: 0 },
    ]);
    expect(matchIdentityCorrections("SP500", twice).unmatched).toEqual([
      { id: "SP500:dean-witter-discover-1993:MS", matches: 2 },
    ]);
    expect(
      INDEX_IDENTITY_CORRECTIONS.every(
        (correction) => correction.evidence.length > 100,
      ),
    ).toBe(true);
  });

  it("clips membership windows at the first day the prices are the constituent's", () => {
    const windows = [
      { from: "1996-01-02", to: "1996-12-31" },
      { from: "1997-01-02", to: "2026-10-16" },
    ];
    expect(windowsFrom(windows, "1997-06-02")).toEqual([
      { from: "1997-06-02", to: "2026-10-16" },
    ]);
    expect(windowsFrom(windows, null)).toEqual(windows);
  });

  it("resolves Cablevision under CVC alone, never probing Romeo Power's RMG or RMO", async () => {
    const { byKey, provider, admitted } = await resolveAll();
    const cablevision = byKey.get("REMOVAL:fc1662cc");
    expect(cablevision).toMatchObject({
      resolution: "RESOLVED",
      securityId: "security-cvc",
      securityFrom: null,
    });
    expect(provider.priceRequests).not.toContain("RMG");
    expect(provider.priceRequests).not.toContain("RMO");
    expect(admitted.map((listing) => listing.symbol)).toContain("CVC");
    expect(
      (cablevision?.evidence as { correction: { id: string } }).correction.id,
    ).toBe("SP500:cablevision-1:CVC");
  });

  it("reads listings only for the symbols decided this run, never for every resolved one", async () => {
    const { admitted, provider } = await resolveAll();
    expect(admitted.map((listing) => listing.symbol).sort()).toEqual([
      "CVC",
      "MCO",
      "MS",
    ]);
    expect(provider.profileRequests.sort()).toEqual(["CVC", "MCO", "MS"]);
  });

  it("gives the old Dun & Bradstreet Moody's history, and leaves the spun-off one unresolved", async () => {
    const { byKey } = await resolveAll();
    expect(byKey.get("REMOVAL:dfbd402a")).toMatchObject({
      resolution: "RESOLVED",
      securityId: "security-mco",
    });
    // Not re-probed (no correction, nothing changed), so not rewritten either.
    expect(byKey.get("REMOVAL:3661f7c0")).toBeUndefined();
  });

  it("gives Dean Witter Discover the MS history and Morgan Stanley Group none of it before the merger", async () => {
    const { byKey, result } = await resolveAll();
    expect(result.conflicts).toBe(0);
    expect(byKey.get("REMOVAL:6fbca9da")).toMatchObject({
      resolution: "RESOLVED",
      securityId: "security-ms",
      securityFrom: null,
    });
    const ms = byKey.get("CURRENT:MS");
    expect(ms).toMatchObject({
      resolution: "RESOLVED",
      securityId: "security-ms",
      securityFrom: "1997-06-02",
    });
    const chosen = (
      ms?.evidence as { candidates: { firstSessionInMembership: string }[] }
    ).candidates[0];
    expect(chosen?.firstSessionInMembership).toBe("1997-06-02");
  });

  it("would refuse Dean Witter without Morgan Stanley's start: two simultaneous members never share prices", async () => {
    // Without the merger date, Dean Witter's and Morgan Stanley Group's memberships both claim MS
    // from 1996 to 1997: the current member keeps it and Dean Witter is refused, as before.
    const { result, byKey } = await resolveAll(
      STORED,
      INDEX_IDENTITY_CORRECTIONS.filter(
        (correction) => !correction.id.startsWith("SP500:morgan-stanley"),
      ),
    );
    expect(result.conflicts).toBe(1);
    expect(byKey.get("REMOVAL:6fbca9da")).toMatchObject({
      resolution: "IDENTITY_REJECTED",
      securityId: null,
    });
    expect(result.corrections.applied).toHaveLength(3);
  });

  it("projects one continuous MS membership from Dean Witter into Morgan Stanley, and MCO from old D&B into Moody's", async () => {
    const { byKey } = await resolveAll();
    const decided = STORED.map((entry) => {
      const write = byKey.get(entry.constituentKey);
      return write
        ? {
            ...entry,
            securityId: write.securityId,
            securityFrom: write.securityFrom,
            resolution: write.resolution,
          }
        : entry;
    });
    const members = new Map(
      projectIndexList(decided, "1996-01-02").map((member) => [
        member.securityId,
        member,
      ]),
    );
    expect(members.get("security-ms")?.ranges).toEqual([
      { startDate: "1996-01-02", endDate: null },
    ]);
    expect(members.get("security-ms")?.constituentKeys).toEqual([
      "CURRENT:MS",
      "REMOVAL:6fbca9da",
    ]);
    // The deferred Moody's start is restored where the old D&B line ended on the same log date.
    expect(members.get("security-mco")?.ranges).toEqual([
      { startDate: "1996-01-02", endDate: null },
    ]);
    expect(members.get("security-cvc")?.ranges).toEqual([
      { startDate: "2010-12-20", endDate: "2016-06-22" },
    ]);
  });
});

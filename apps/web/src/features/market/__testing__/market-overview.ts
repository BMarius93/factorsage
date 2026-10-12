import type {
  MarketOverviewGroupResponse,
  MarketOverviewInstrumentResponse,
  MarketOverviewResponse,
  MarketOverviewReturns,
} from "@intrinsic/contracts";

/**
 * A complete `GET /market-overview` response for component tests: twenty instruments in the three
 * groups, every return available, trend lines of 53 points. Numbers are illustrative test data, never
 * shown outside tests.
 */

const GROUPS: readonly {
  id: MarketOverviewGroupResponse["id"];
  label: string;
  shortLabel: string;
  instruments: readonly [ticker: string, name: string, note?: string][];
}[] = [
  {
    id: "BENCHMARKS",
    label: "Benchmarks",
    shortLabel: "Benchmarks",
    instruments: [
      ["SPY", "S&P 500"],
      ["QQQ", "Nasdaq-100"],
      ["DIA", "Dow Jones"],
      ["IWM", "Russell 2000"],
      ["RSP", "S&P 500 Equal Weight"],
    ],
  },
  {
    id: "US_SECTORS",
    label: "Sector Performance",
    shortLabel: "Sectors",
    instruments: [
      ["XLK", "Technology"],
      ["XLF", "Financials"],
      ["XLE", "Energy"],
      ["XLV", "Healthcare"],
      ["XLI", "Industrials"],
      ["XLY", "Consumer Discretionary"],
      ["XLP", "Consumer Staples"],
      ["XLU", "Utilities"],
      ["XLB", "Materials"],
      ["XLRE", "Real Estate"],
      ["XLC", "Communication Services"],
    ],
  },
  {
    id: "MACRO_ALTERNATIVES",
    label: "Macro & Alternatives",
    shortLabel: "Macro",
    instruments: [
      ["GLD", "Gold"],
      ["USO", "Oil Futures", "Tracks near-month WTI crude oil futures, not the spot price of oil."],
      ["TLT", "Long-Term Treasuries"],
      ["HYG", "High-Yield Bonds"],
    ],
  },
];

export const FIXTURE_AS_OF = "2026-10-09";

/** Returns that differ per instrument, so a sort has something to order. */
export function fixtureReturns(seed: number): MarketOverviewReturns {
  const sign = seed % 3 === 0 ? -1 : 1;
  return {
    "1W": sign * (0.3 + seed * 0.11),
    "1M": sign * (1.2 + seed * 0.23),
    "3M": sign * (2.5 + seed * 0.37),
    "6M": sign * (4.1 + seed * 0.41),
    YTD: sign * (6.4 + seed * 0.53),
    "1Y": sign * (8.8 + seed * 0.61),
  };
}

function sparkline(seed: number, yearReturn: number) {
  const values = Array.from({ length: 53 }, (_, index) =>
    Math.round((100 + (yearReturn * index) / 52 + Math.sin(index / 4 + seed) * 2) * 100) / 100,
  );
  values[0] = 100;
  return { startDate: "2025-10-09", endDate: FIXTURE_AS_OF, values };
}

export function marketOverviewFixture(
  overrides: {
    instruments?: Record<string, Partial<MarketOverviewInstrumentResponse>>;
    response?: Partial<MarketOverviewResponse>;
  } = {},
): MarketOverviewResponse {
  let seed = 0;
  const groups = GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    shortLabel: group.shortLabel,
    instruments: group.instruments.map(([ticker, name, note]) => {
      seed += 1;
      const returns = fixtureReturns(seed);
      const instrument: MarketOverviewInstrumentResponse = {
        ticker,
        name,
        ...(note ? { note } : {}),
        status: "AVAILABLE",
        sessionDate: FIXTURE_AS_OF,
        returns,
        sparkline: sparkline(seed, returns["1Y"] as number),
        ...overrides.instruments?.[ticker],
      };
      return instrument;
    }),
  }));
  const statuses = groups.flatMap((group) => group.instruments.map((one) => one.status));
  return {
    generatedAt: "2026-10-10T18:30:00.000Z",
    basis: "END_OF_DAY",
    returnBasis: "PRICE_RETURN",
    status: statuses.every((status) => status === "AVAILABLE") ? "AVAILABLE" : "PARTIAL",
    asOf: FIXTURE_AS_OF,
    groups,
    ...overrides.response,
  };
}

/** Every return unavailable: an environment whose ETF histories were never loaded. */
export function unavailableMarketOverview(): MarketOverviewResponse {
  const response = marketOverviewFixture();
  return {
    generatedAt: response.generatedAt,
    basis: response.basis,
    returnBasis: response.returnBasis,
    status: "UNAVAILABLE",
    groups: response.groups.map((group) => ({
      ...group,
      instruments: group.instruments.map((instrument) => ({
        ticker: instrument.ticker,
        name: instrument.name,
        ...(instrument.note ? { note: instrument.note } : {}),
        status: "UNAVAILABLE" as const,
        returns: { "1W": null, "1M": null, "3M": null, "6M": null, YTD: null, "1Y": null },
        sparkline: null,
      })),
    })),
  };
}

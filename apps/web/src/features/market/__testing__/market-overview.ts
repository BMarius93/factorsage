import {
  MARKET_OVERVIEW_PERIODS,
  type MarketOverviewGroupResponse,
  type MarketOverviewInstrumentResponse,
  type MarketOverviewPeriod,
  type MarketOverviewResponse,
  type MarketOverviewReturns,
  type MarketOverviewSparklines,
} from "@intrinsic/contracts";

/**
 * A complete `GET /market-overview` response for component tests: twenty instruments in the three
 * groups, every return available, and one trend line per period whose last point is that period's
 * return — a week of six closes, a month of twenty-three, the longer periods at the 48-point bound,
 * each a different shape. Numbers are illustrative test data, never shown outside tests.
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

/** Points per period, as the API sends them: daily for a week and a month, thinned beyond. */
export const FIXTURE_SPARKLINE_POINTS: Record<MarketOverviewPeriod, number> = {
  "1W": 6,
  "1M": 23,
  "3M": 48,
  "6M": 48,
  YTD: 48,
  "1Y": 48,
};

const FIXTURE_PERIOD_STARTS: Record<MarketOverviewPeriod, string> = {
  "1W": "2026-10-02",
  "1M": "2026-09-09",
  "3M": "2026-07-09",
  "6M": "2026-04-09",
  YTD: "2025-12-31",
  "1Y": "2025-10-09",
};

/** Each period's line: 100 at its anchor, `100 × (1 + return)` at the end, a wave in between. */
function sparklines(
  seed: number,
  returns: MarketOverviewReturns,
): MarketOverviewSparklines {
  return Object.fromEntries(
    MARKET_OVERVIEW_PERIODS.map((period, index) => {
      const points = FIXTURE_SPARKLINE_POINTS[period];
      const total = returns[period] as number;
      const values = Array.from(
        { length: points },
        (_, at) =>
          Math.round(
            (100 +
              (total * at) / (points - 1) +
              Math.sin(at / 3 + seed + index) * 1.5 * Math.sin((Math.PI * at) / (points - 1))) *
              100,
          ) / 100,
      );
      return [
        period,
        { startDate: FIXTURE_PERIOD_STARTS[period], endDate: FIXTURE_AS_OF, values },
      ];
    }),
  ) as MarketOverviewSparklines;
}

/** No line for any period. */
export function noSparklines(): MarketOverviewSparklines {
  return { "1W": null, "1M": null, "3M": null, "6M": null, YTD: null, "1Y": null };
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
        sparklines: sparklines(seed, returns),
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
        sparklines: noSparklines(),
      })),
    })),
  };
}

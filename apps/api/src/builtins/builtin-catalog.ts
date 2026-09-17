import {
  STRATEGY_SCHEMA_VERSION,
  type BuyWindowMode,
  type StrategyCondition,
  type StrategyDefinition,
  type StrategyTrigger,
} from "@intrinsic/contracts";

/**
 * The V1 built-in content: exactly 3 Lists, 2 Strategies and 3 Monitors.
 *
 * `docs/decisions/builtin-dashboard-signals-v1.md` sections 8–10 are the product selection; this is
 * its canonical seed data. `systemKey` — never a display name — is the bootstrap identity. Every
 * historical date below was verified against the authoritative source named beside it on
 * 2026-09-17; `docs/development/builtin-content.md` records the verification.
 *
 * Every id in a Strategy definition is permanent: a level id is Monitor identity
 * (`ai/architecture/deep-discovery.md` investigation 1), so renaming one would reset live state.
 */

export type BuiltInListMember = {
  symbol: string;
  /** `null` is `FULL` ("Always eligible"); a date is an open-ended CUSTOM window from that day. */
  eligibleFrom: string | null;
  /** Where `eligibleFrom` comes from. */
  source?: string;
};

export type BuiltInList = {
  systemKey: string;
  name: string;
  description: string;
  displayOrder: number;
  members: readonly BuiltInListMember[];
};

export type BuiltInStrategy = {
  systemKey: string;
  name: string;
  description: string;
  displayOrder: number;
  definition: StrategyDefinition;
};

export type BuiltInMonitor = {
  systemKey: string;
  name: string;
  displayOrder: number;
  listKey: string;
  strategyKey: string;
};

const SPGLOBAL = "https://press.spglobal.com";
const NASDAQ_ANNUAL_2021 =
  "https://www.globenewswire.com/news-release/2021/12/11/2350269/0/en/Annual-Changes-to-the-Nasdaq-100-Index.html";

export const BUILT_IN_LISTS: readonly BuiltInList[] = [
  {
    systemKey: "sp500-growth-leaders",
    name: "S&P 500 Growth Leaders",
    description:
      "A curated set of large-cap growth companies in the S&P 500. Long-standing members are always eligible; recent additions become eligible from their S&P 500 inclusion date.",
    displayOrder: 1,
    members: [
      { symbol: "AAPL", eligibleFrom: null },
      { symbol: "MSFT", eligibleFrom: null },
      { symbol: "NVDA", eligibleFrom: null },
      { symbol: "AMD", eligibleFrom: null },
      { symbol: "META", eligibleFrom: null },
      {
        symbol: "PANW",
        eligibleFrom: "2023-06-20",
        source: `${SPGLOBAL}/2023-06-02-Palo-Alto-Networks-Set-to-S-P-500-Others-to-Join-S-P-MidCap-400-and-S-P-SmallCap-600`,
      },
      {
        symbol: "ABNB",
        eligibleFrom: "2023-09-18",
        source: `${SPGLOBAL}/2023-09-01-Blackstone-and-Airbnb-Set-to-Join-S-P-500-Others-to-Join-S-P-100,-S-P-MidCap-400-and-S-P-SmallCap-600`,
      },
      {
        symbol: "UBER",
        eligibleFrom: "2023-12-18",
        source: `${SPGLOBAL}/2023-12-01-Uber-Technologies,-Jabil-and-Builders-FirstSource-Set-to-Join-S-P-500-Others-to-Join-S-P-MidCap-400-and-S-P-SmallCap-600`,
      },
      {
        symbol: "CRWD",
        eligibleFrom: "2024-06-24",
        source: `${SPGLOBAL}/2024-06-07-KKR,-CrowdStrike-Holdings-and-GoDaddy-Set-to-Join-S-P-500-Others-to-Join-S-P-MidCap-400-and-S-P-SmallCap-600`,
      },
      {
        symbol: "PLTR",
        eligibleFrom: "2024-09-23",
        source: `${SPGLOBAL}/2024-09-06-Palantir-Technologies,-Dell-Technologies,-and-Erie-Indemnity-Set-to-Join-S-P-500-Others-to-Join-S-P-MidCap-400-and-S-P-SmallCap-600`,
      },
    ],
  },
  {
    systemKey: "nasdaq100-newcomers",
    name: "Nasdaq-100 Newcomers",
    description:
      "Selected Nasdaq-100 additions from recent reconstitutions. Each company becomes buy-eligible from its Nasdaq-100 inclusion date.",
    displayOrder: 2,
    // Verified: none of these left the Nasdaq-100 between inclusion and 2026-09-17, so every
    // window is open-ended.
    members: [
      {
        symbol: "HON",
        eligibleFrom: "2021-07-21",
        source:
          "https://www.globenewswire.com/news-release/2021/07/15/2263173/6948/en/Honeywell-International-Inc-to-Join-the-NASDAQ-100-Index-Beginning-July-21-2021.html",
      },
      {
        symbol: "FTNT",
        eligibleFrom: "2021-12-20",
        source: NASDAQ_ANNUAL_2021,
      },
      {
        symbol: "DDOG",
        eligibleFrom: "2021-12-20",
        source: NASDAQ_ANNUAL_2021,
      },
      {
        symbol: "ODFL",
        eligibleFrom: "2022-01-24",
        source:
          "https://ir.nasdaq.com/news-releases/news-release-details/old-dominion-freight-line-inc-join-nasdaq-100-index-beginning",
      },
      {
        symbol: "FANG",
        eligibleFrom: "2022-12-19",
        source:
          "https://www.globenewswire.com/news-release/2022/12/10/2571355/0/en/Annual-Changes-to-the-Nasdaq-100-Index.html",
      },
      {
        symbol: "ROP",
        eligibleFrom: "2023-12-18",
        source:
          "https://www.globenewswire.com/news-release/2023/12/09/2793414/0/en/Annual-Changes-to-the-Nasdaq-100-Index.html",
      },
      {
        symbol: "AXON",
        eligibleFrom: "2024-12-23",
        source:
          "https://www.nasdaq.com/press-release/annual-changes-nasdaq-100-indexr-2024-12-13",
      },
      {
        symbol: "MSTR",
        eligibleFrom: "2024-12-23",
        source:
          "https://www.nasdaq.com/press-release/annual-changes-nasdaq-100-indexr-2024-12-13",
      },
      {
        symbol: "MPWR",
        eligibleFrom: "2025-12-22",
        source:
          "https://www.globenewswire.com/news-release/2025/12/13/3204942/6948/en/annual-changes-to-the-nasdaq-100-index.html",
      },
      {
        symbol: "WDC",
        eligibleFrom: "2025-12-22",
        source:
          "https://www.globenewswire.com/news-release/2025/12/13/3204942/6948/en/annual-changes-to-the-nasdaq-100-index.html",
      },
    ],
  },
  {
    systemKey: "recent-market-debuts",
    name: "Recent Market Debuts",
    description:
      "Ten notable public-market debuts since 2021. Each company becomes buy-eligible from its first public trading day.",
    displayOrder: 3,
    members: [
      {
        symbol: "HOOD",
        eligibleFrom: "2021-07-29",
        source:
          "https://www.globenewswire.com/news-release/2021/07/29/2270831/0/en/Robinhood-Markets-Inc-Announces-Pricing-of-Initial-Public-Offering.html",
      },
      {
        symbol: "RIVN",
        eligibleFrom: "2021-11-10",
        source:
          "https://www.cnbc.com/2021/11/09/rivian-prices-ipo-at-78-a-share-valuing-company-at-66point5-billion.html",
      },
      {
        symbol: "MBLY",
        eligibleFrom: "2022-10-26",
        source:
          "https://ir.mobileye.com/news-releases/news-release-details/mobileye-announces-pricing-initial-public-offering",
      },
      {
        symbol: "CAVA",
        eligibleFrom: "2023-06-15",
        source:
          "https://www.businesswire.com/news/home/20230614298815/en/CAVA-Announces-Pricing-of-Initial-Public-Offering",
      },
      {
        symbol: "ARM",
        eligibleFrom: "2023-09-14",
        source:
          "https://newsroom.arm.com/news/arm-announces-pricing-of-initial-public-offering",
      },
      {
        symbol: "ALAB",
        eligibleFrom: "2024-03-20",
        source:
          "https://www.asteralabs.com/news/astera-labs-announces-pricing-of-initial-public-offering/",
      },
      {
        symbol: "RDDT",
        eligibleFrom: "2024-03-21",
        source:
          "https://www.nasdaq.com/press-release/reddit-announces-pricing-of-initial-public-offering-2024-03-20",
      },
      {
        symbol: "CRWV",
        eligibleFrom: "2025-03-28",
        source:
          "https://investors.coreweave.com/news/news-details/2025/CoreWeave-Announces-Pricing-of-Initial-Public-Offering/default.aspx",
      },
      {
        symbol: "CRCL",
        eligibleFrom: "2025-06-05",
        source:
          "https://investor.circle.com/news/news-details/2025/Circle-Announces-Pricing-of-Upsized-Initial-Public-Offering/default.aspx",
      },
      {
        symbol: "FIG",
        eligibleFrom: "2025-07-31",
        source:
          "https://investor.figma.com/news-events/news/news-details/2025/Figma-Announces-Pricing-of-Initial-Public-Offering/default.aspx",
      },
    ],
  },
];

const price = { kind: "PRICE" } as const;
const sma = (days: 20 | 50 | 200) =>
  ({ kind: "SERIES", seriesId: `SMA_${days}D` }) as const;

function condition(
  id: string,
  body: Omit<StrategyCondition, "id">,
): StrategyCondition {
  return { id, ...body };
}

function trigger(
  id: string,
  body: Omit<StrategyTrigger, "id">,
): StrategyTrigger {
  return { id, ...body };
}

/** The Margin of Safety thresholds of `Value & Trend` (section 9.1; section 12 allows tuning). */
export const VALUE_AND_TREND_BUY_MARGIN = 5;
export const VALUE_AND_TREND_SELL_MARGIN = -15;

export const BUILT_IN_STRATEGIES: readonly BuiltInStrategy[] = [
  {
    systemKey: "value-and-trend",
    name: "Value & Trend",
    description:
      "Looks for discounted stocks in a healthy long-term trend, trims when valuation becomes stretched, and exits when the long-term trend breaks.",
    displayOrder: 1,
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "value-and-trend-buy",
          percentage: 100,
          signal: {
            conditions: [
              condition("value-and-trend-buy-margin", {
                metric: { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: VALUE_AND_TREND_BUY_MARGIN },
              }),
              condition("value-and-trend-buy-trend", {
                metric: price,
                operator: "IS_ABOVE",
                value: sma(200),
              }),
            ],
          },
        },
      ],
      sellLevels: [
        {
          id: "value-and-trend-sell",
          percentage: 50,
          signal: {
            conditions: [
              condition("value-and-trend-sell-margin", {
                metric: { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED" },
                operator: "IS_BELOW",
                value: { kind: "PERCENT", value: VALUE_AND_TREND_SELL_MARGIN },
              }),
              condition("value-and-trend-sell-trend", {
                metric: price,
                operator: "IS_ABOVE",
                value: sma(200),
              }),
            ],
          },
        },
      ],
      finalExit: {
        id: "value-and-trend-exit",
        rules: [
          {
            id: "value-and-trend-exit-trend-break",
            signal: {
              conditions: [
                condition("value-and-trend-exit-below-trend", {
                  metric: price,
                  operator: "IS_BELOW",
                  value: sma(200),
                }),
              ],
            },
          },
        ],
      },
    },
  },
  {
    systemKey: "trend-confirmation",
    name: "Trend Confirmation",
    description:
      "Waits for short-term momentum to recover inside an established long-term uptrend, and exits when price breaks below its 200-day average.",
    displayOrder: 2,
    definition: {
      schemaVersion: STRATEGY_SCHEMA_VERSION,
      buyLevels: [
        {
          id: "trend-confirmation-buy",
          percentage: 100,
          signal: {
            conditions: [
              condition("trend-confirmation-buy-golden", {
                metric: { kind: "MOVING_AVERAGE", seriesId: "SMA_50D" },
                operator: "IS_ABOVE",
                value: sma(200),
              }),
              condition("trend-confirmation-buy-trend", {
                metric: price,
                operator: "IS_ABOVE",
                value: sma(200),
              }),
            ],
            trigger: trigger("trend-confirmation-buy-momentum", {
              metric: price,
              operator: "CROSSES_ABOVE",
              value: sma(20),
            }),
          },
        },
      ],
      sellLevels: [],
      finalExit: {
        id: "trend-confirmation-exit",
        rules: [
          {
            id: "trend-confirmation-exit-trend-break",
            signal: {
              conditions: [],
              trigger: trigger("trend-confirmation-exit-cross", {
                metric: price,
                operator: "CROSSES_BELOW",
                value: sma(200),
              }),
            },
          },
        ],
      },
    },
  },
];

export const BUILT_IN_MONITORS: readonly BuiltInMonitor[] = [
  {
    systemKey: "sp500-value-and-trend",
    name: "S&P Value & Trend",
    displayOrder: 1,
    listKey: "sp500-growth-leaders",
    strategyKey: "value-and-trend",
  },
  {
    systemKey: "nasdaq-trend-confirmation",
    name: "Nasdaq Trend Confirmation",
    displayOrder: 2,
    listKey: "nasdaq100-newcomers",
    strategyKey: "trend-confirmation",
  },
  {
    systemKey: "new-listings-trend-confirmation",
    name: "New Listings Trend Confirmation",
    displayOrder: 3,
    listKey: "recent-market-debuts",
    strategyKey: "trend-confirmation",
  },
];

/** The canonical buy-window configuration of one member. */
export function memberWindows(member: BuiltInListMember): {
  mode: BuyWindowMode;
  ranges: { startDate: string; endDate: null }[];
} {
  return member.eligibleFrom === null
    ? { mode: "FULL", ranges: [] }
    : {
        mode: "CUSTOM",
        ranges: [{ startDate: member.eligibleFrom, endDate: null }],
      };
}

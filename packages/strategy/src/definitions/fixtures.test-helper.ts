import type { StrategyDefinition } from "@intrinsic/contracts";

/** Actor ids as this database holds them, and who each one is. */
export const ACTOR_PELOSI = "5f3c1a9e-0000-4000-8000-000000000001";
export const ACTOR_TUBERVILLE = "5f3c1a9e-0000-4000-8000-000000000002";
export const ACTOR_KHANNA = "5f3c1a9e-0000-4000-8000-000000000003";

export const ACTOR_IDENTITIES = new Map([
  [ACTOR_PELOSI, { externalId: "P000197", displayName: "Nancy Pelosi" }],
  [
    ACTOR_TUBERVILLE,
    { externalId: "T000278", displayName: "Tommy Tuberville" },
  ],
  [ACTOR_KHANNA, { externalId: "K000389", displayName: "Ro Khanna" }],
]);

/**
 * A strategy touching every metric family the platform defines: price, moving averages, RSI,
 * Relative Volume, Margin of Safety, a valuation ratio, fundamentals, Gain and Loss, insider and
 * Congressional activity (a selection, a legacy single member and filters), ETF and Stock's Sector
 * sources, `is close to`, Triggers, two BUY levels, a SELL level and three FINAL EXIT rules.
 */
export function everyFamilyDefinition(): StrategyDefinition {
  return {
    schemaVersion: 2,
    buyLevels: [
      {
        id: "b1",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "b1c1",
              metric: {
                kind: "VALUATION_RATIO",
                ratioId: "PRICE_TO_EARNINGS_TTM",
              },
              operator: "IS_BELOW",
              value: { kind: "MULTIPLE", value: 15 },
            },
            {
              id: "b1c2",
              metric: { kind: "FUNDAMENTAL", metricId: "ROE_TTM" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 15 },
            },
            {
              id: "b1c3",
              metric: { kind: "PRICE" },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          ],
          trigger: {
            id: "b1t",
            metric: { kind: "OSCILLATOR", seriesId: "RSI_14D" },
            operator: "CROSSES_ABOVE",
            value: { kind: "NUMBER", value: 30 },
          },
        },
      },
      {
        id: "b2",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "b2c1",
              metric: { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 20 },
            },
            {
              id: "b2c2",
              metric: {
                kind: "OSCILLATOR",
                seriesId: "RSI_14D",
                source: { kind: "ETF", code: "ETF_XLK" },
              },
              operator: "IS_ABOVE",
              value: { kind: "NUMBER", value: 50 },
            },
            {
              id: "b2c3",
              metric: { kind: "PRICE", source: { kind: "STOCK_SECTOR" } },
              operator: "IS_ABOVE",
              value: { kind: "SERIES", seriesId: "SMA_50D" },
            },
            {
              id: "b2c4",
              metric: { kind: "PRICE" },
              operator: "IS_CLOSE_TO",
              value: { kind: "SERIES", seriesId: "EMA_50D" },
            },
            {
              id: "b2c5",
              metric: {
                kind: "INSIDER_ACTIVITY",
                measure: "BUYERS",
                lookback: 90,
                roles: ["CEO", "CFO"],
              },
              operator: "IS_ABOVE",
              value: { kind: "NUMBER", value: 1 },
            },
          ],
        },
      },
    ],
    sellLevels: [
      {
        id: "s1",
        percentage: 50,
        signal: {
          conditions: [
            {
              id: "s1c1",
              metric: { kind: "GAIN" },
              operator: "IS_ABOVE",
              value: { kind: "PERCENT", value: 25 },
            },
            {
              id: "s1c2",
              metric: { kind: "RELATIVE_VOLUME", period: 20 },
              operator: "IS_ABOVE",
              value: { kind: "MULTIPLE", value: 2 },
            },
          ],
        },
      },
    ],
    finalExit: {
      id: "fx",
      rules: [
        {
          id: "fx1",
          signal: {
            conditions: [
              {
                id: "fx1c1",
                metric: { kind: "LOSS" },
                operator: "IS_ABOVE",
                value: { kind: "PERCENT", value: 10 },
              },
            ],
          },
        },
        {
          id: "fx2",
          signal: {
            conditions: [
              {
                id: "fx2c1",
                metric: {
                  kind: "INSIDER_ACTIVITY",
                  measure: "SELLERS",
                  lookback: 180,
                  roles: ["CEO", "CFO"],
                },
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 2 },
              },
            ],
            trigger: {
              id: "fx2t",
              metric: { kind: "PRICE" },
              operator: "CROSSES_BELOW",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          },
        },
        {
          id: "fx3",
          signal: {
            conditions: [
              {
                id: "fx3c1",
                metric: {
                  kind: "CONGRESS_ACTIVITY",
                  measure: "SALES",
                  lookback: 30,
                  scope: {
                    kind: "ACTORS",
                    actorIds: [ACTOR_PELOSI, ACTOR_TUBERVILLE],
                  },
                  chamber: "ANY",
                  owners: ["SELF", "SPOUSE"],
                },
                operator: "IS_ABOVE",
                value: { kind: "NUMBER", value: 1 },
              },
              {
                id: "fx3c2",
                metric: {
                  kind: "CONGRESS_ACTIVITY",
                  measure: "MINIMUM_PURCHASE_VALUE",
                  lookback: 60,
                  scope: { kind: "ACTOR", actorId: ACTOR_KHANNA },
                  chamber: "HOUSE",
                },
                operator: "IS_BELOW",
                value: { kind: "MONEY", value: 50000 },
              },
            ],
          },
        },
      ],
    },
  } as unknown as StrategyDefinition;
}

/**
 * A JSON document a test is about to corrupt. Deliberately untyped: the point of those tests is to
 * write shapes no type would allow.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MutableJson = any;

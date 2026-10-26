import type { StrategyDefinition } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { describeDefinition } from "./describe.js";
import {
  ACTOR_IDENTITIES,
  everyFamilyDefinition,
} from "./fixtures.test-helper.js";
import { CanonicalDefinitionError } from "./issues.js";
import { serializeList, type ListMemberInput } from "./list-codec.js";
import { serializeStrategy } from "./strategy-codec.js";

const UNKNOWN = { origin: "unknown" } as const;

/** The built-in `Value & Trend` logic, as `builtin-catalog.ts` defines it. */
const VALUE_AND_TREND = {
  schemaVersion: 2,
  buyLevels: [
    {
      id: "value-and-trend-buy",
      percentage: 100,
      signal: {
        conditions: [
          {
            id: "value-and-trend-buy-margin",
            metric: { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED" },
            operator: "IS_ABOVE",
            value: { kind: "PERCENT", value: 5 },
          },
          {
            id: "value-and-trend-buy-trend",
            metric: { kind: "PRICE" },
            operator: "IS_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_200D" },
          },
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
          {
            id: "value-and-trend-sell-margin",
            metric: { kind: "MARGIN_OF_SAFETY", sourceId: "BALANCED" },
            operator: "IS_BELOW",
            value: { kind: "PERCENT", value: -15 },
          },
          {
            id: "value-and-trend-sell-trend",
            metric: { kind: "PRICE" },
            operator: "IS_ABOVE",
            value: { kind: "SERIES", seriesId: "SMA_200D" },
          },
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
            {
              id: "value-and-trend-exit-below-trend",
              metric: { kind: "PRICE" },
              operator: "IS_BELOW",
              value: { kind: "SERIES", seriesId: "SMA_200D" },
            },
          ],
        },
      },
    ],
  },
} as unknown as StrategyDefinition;

function strategy(definition: unknown) {
  return serializeStrategy({
    metadata: { name: "Private name" },
    provenance: UNKNOWN,
    definition,
    actors: ACTOR_IDENTITIES,
  });
}

function list(members: ListMemberInput[]) {
  return serializeList({
    metadata: { name: "Private list name" },
    provenance: UNKNOWN,
    membership: { kind: "members", members },
  });
}

describe("describing a strategy", () => {
  it("words a built-in strategy's real rules, exactly", () => {
    expect(describeDefinition(strategy(VALUE_AND_TREND))).toEqual({
      short:
        "Buys when Margin of Safety · Balanced is above 5% and Price is above SMA 200D. Sells in 1 level and closes the position when Price is below SMA 200D.",
      detailed: [
        "BUY: buys 100% of a full position when Margin of Safety · Balanced is above 5% and Price is above SMA 200D.",
        "SELL: sells 50% of the remaining position when Margin of Safety · Balanced is below -15% and Price is above SMA 200D.",
        "FINAL EXIT: closes the whole remaining position when Price is below SMA 200D.",
        "Within a level, every condition must hold on the same session. Rules are evaluated on finalized end-of-day data.",
      ].join("\n"),
    });
  });

  it("names every condition, operator, metric and value, with its configuration and grouping", () => {
    const { short, detailed } = describeDefinition(
      strategy(everyFamilyDefinition()),
    );
    expect(short).toBe(
      "Buys in 2 levels, the first when P/E is below 15.0x and ROE TTM is above 15%, plus 1 more condition and a trigger. Sells in 1 level and closes the position when any of 3 exit rules matches.",
    );
    const lines = detailed.split("\n");
    expect(lines[0]).toBe(
      "BUY level 1: buys 50% of a full position when P/E is below 15.0x and ROE TTM is above 15% and Price is above SMA 200D and RSI 14D crosses above 30.",
    );
    expect(lines[1]).toBe(
      "BUY level 2: buys 50% of a full position when Margin of Safety · Balanced is above 20% and XLK · RSI 14D is above 50 and Stock's Sector · Price is above SMA 50D and Price is close to EMA 50D and Insider buyers is above 1 (90D · CEO, CFO).",
    );
    expect(lines[2]).toBe(
      "SELL: sells 50% of the remaining position when Gain is above 25% and RVOL 20 is above 2.0x.",
    );
    // OR of AND groups: each Exit Rule numbered, its own conditions ANDed inside it.
    expect(lines[3]).toBe(
      "FINAL EXIT: closes the whole remaining position when any one of 3 exit rules matches — (1) Loss is above 10%; (2) Insider sellers is above 2 (180D · CEO, CFO) and Price crosses below SMA 200D; (3) Congress sales is above 1 (30D · Nancy Pelosi, Tommy Tuberville · Self, Spouse) and Congress minimum disclosed purchase value is below $50,000 (60D · Ro Khanna · House).",
    );
    expect(lines[4]).toBe(
      'Within a level, every condition must hold on the same session; where a level has a trigger, it must fire on that session too. "is close to" means within 2% of the value. A rule that names an ETF reads that ETF\'s own history, not the stock\'s. A "Stock\'s Sector" rule reads the sector ETF of each stock it evaluates. Gain and Loss are measured on the open position. Rules are evaluated on finalized end-of-day data.',
    );
  });

  it("never names the strategy, and is the same text every time", () => {
    const document = strategy(everyFamilyDefinition());
    const first = describeDefinition(document);
    expect(JSON.stringify(first)).not.toContain("Private name");
    expect(describeDefinition(JSON.parse(JSON.stringify(document)))).toEqual(
      first,
    );
  });

  it("says plainly when a strategy has no exit", () => {
    const definition = {
      ...VALUE_AND_TREND,
      sellLevels: [],
      finalExit: undefined,
    } as unknown as StrategyDefinition;
    const { short, detailed } = describeDefinition(strategy(definition));
    expect(short).toBe(
      "Buys when Margin of Safety · Balanced is above 5% and Price is above SMA 200D. It has no sell level and no final exit.",
    );
    expect(detailed).toContain("There is no sell level and no final exit.");
  });

  it("describes only a valid document", () => {
    const document = JSON.parse(JSON.stringify(strategy(VALUE_AND_TREND)));
    document.schemaVersion = 7;
    expect(() => describeDefinition(document)).toThrow(
      CanonicalDefinitionError,
    );
  });
});

describe("describing a list", () => {
  it("states membership semantics without naming a security", () => {
    const { short, detailed } = describeDefinition(
      list([
        {
          security: { symbol: "NVDA", exchange: "NASDAQ" },
          buyWindow: { mode: "FULL", ranges: [] },
        },
        {
          security: { symbol: "PLTR", exchange: "NASDAQ" },
          buyWindow: {
            mode: "CUSTOM",
            ranges: [{ startDate: "2019-04-01", endDate: null }],
          },
        },
        {
          security: { symbol: "AAPL", exchange: "NASDAQ" },
          buyWindow: {
            mode: "CUSTOM",
            ranges: [
              { startDate: "2001-03-10", endDate: "2008-07-15" },
              { startDate: "2012-05-01", endDate: null },
            ],
          },
        },
      ]),
    );
    expect(short).toBe(
      "3 securities: 1 eligible to buy on any date, 2 only during their membership periods.",
    );
    expect(detailed).toBe(
      "A list of 3 securities. 1 may be bought on any date. 2 may be bought only inside their membership periods: 3 periods in total, the earliest starting Mar 10, 2001; 2 are still open-ended. Membership limits new buys only: a holding is not sold when its membership period ends.",
    );
    for (const text of [short, detailed]) {
      expect(text).not.toMatch(/NVDA|PLTR|AAPL|NASDAQ|Private list name/);
    }
  });

  it("words an always-eligible list and a windowed list", () => {
    const always = describeDefinition(
      list([
        {
          security: { symbol: "A", exchange: "NYSE" },
          buyWindow: { mode: "FULL", ranges: [] },
        },
        {
          security: { symbol: "B", exchange: "NYSE" },
          buyWindow: { mode: "FULL", ranges: [] },
        },
      ]),
    );
    expect(always).toEqual({
      short: "2 securities, each eligible to buy on any date.",
      detailed: "A list of 2 securities. Every one may be bought on any date.",
    });
    const windowed = describeDefinition(
      list([
        {
          security: { symbol: "A", exchange: "NYSE" },
          buyWindow: {
            mode: "CUSTOM",
            ranges: [{ startDate: "2015-06-01", endDate: "2016-06-01" }],
          },
        },
      ]),
    );
    expect(windowed).toEqual({
      short:
        "1 security, each eligible to buy only during its membership periods.",
      detailed:
        "A list of 1 security. Every one may be bought only inside its membership periods: 1 period in total, the earliest starting Jun 1, 2015. Membership limits new buys only: a holding is not sold when its membership period ends.",
    });
  });

  it("describes a point-in-time universe by its historical semantics and its pinned size", () => {
    const document = serializeList({
      metadata: { name: "S&P 500 — Historical PIT" },
      provenance: UNKNOWN,
      membership: {
        kind: "point_in_time_index",
        index: "SP500",
        period: { startDate: "1996-01-02", endDate: "2025-12-31" },
        members: [
          {
            security: { symbol: "A", exchange: "NYSE" },
            buyWindow: {
              mode: "CUSTOM",
              ranges: [{ startDate: "1996-01-02", endDate: null }],
            },
          },
          {
            security: { symbol: "B", exchange: "NYSE" },
            buyWindow: {
              mode: "CUSTOM",
              ranges: [
                { startDate: "2001-03-10", endDate: "2008-07-15" },
                { startDate: "2012-05-01", endDate: null },
              ],
            },
          },
        ],
      },
    });
    expect(describeDefinition(document)).toEqual({
      short:
        "Uses historical S&P 500 membership to determine eligible securities at each point in time.",
      detailed:
        "Uses the point-in-time membership of the S&P 500: a security is eligible to buy only on dates it was an index member, so the universe follows the index's actual history rather than today's constituents. Between Jan 2, 1996 and Dec 31, 2025, the pinned membership holds 2 securities that were index members at some point, at most 2 at the same time, across 3 membership periods. Former constituents without price history cannot be traded and are never substituted. Membership limits new buys only: a holding is not sold when its company leaves the index. The membership is pinned, so later corrections to the index history do not change it.",
    });
  });
});

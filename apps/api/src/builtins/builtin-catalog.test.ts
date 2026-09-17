import {
  describeCondition,
  describeTrigger,
  normalizeStrategyDefinition,
} from "@intrinsic/contracts";
import { monitorStrategyLevels } from "@intrinsic/strategy";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_LISTS,
  BUILT_IN_MONITORS,
  BUILT_IN_STRATEGIES,
} from "./builtin-catalog";

/**
 * The canonical built-in catalog, pinned to `docs/decisions/builtin-dashboard-signals-v1.md`
 * sections 8–10. Values are written as literals so the suite cannot agree with a wrong catalog.
 */
describe("built-in catalog", () => {
  it("ships exactly the three lists, ten members each, with their eligibility dates", () => {
    const lists = Object.fromEntries(
      BUILT_IN_LISTS.map((list) => [
        list.systemKey,
        list.members.map(
          (member) => `${member.symbol}:${member.eligibleFrom ?? "ALWAYS"}`,
        ),
      ]),
    );
    expect(lists).toEqual({
      "sp500-growth-leaders": [
        "AAPL:ALWAYS",
        "MSFT:ALWAYS",
        "NVDA:ALWAYS",
        "AMD:ALWAYS",
        "META:ALWAYS",
        "PANW:2023-06-20",
        "ABNB:2023-09-18",
        "UBER:2023-12-18",
        "CRWD:2024-06-24",
        "PLTR:2024-09-23",
      ],
      "nasdaq100-newcomers": [
        "HON:2021-07-21",
        "FTNT:2021-12-20",
        "DDOG:2021-12-20",
        "ODFL:2022-01-24",
        "FANG:2022-12-19",
        "ROP:2023-12-18",
        "AXON:2024-12-23",
        "MSTR:2024-12-23",
        "MPWR:2025-12-22",
        "WDC:2025-12-22",
      ],
      "recent-market-debuts": [
        "HOOD:2021-07-29",
        "RIVN:2021-11-10",
        "MBLY:2022-10-26",
        "CAVA:2023-06-15",
        "ARM:2023-09-14",
        "ALAB:2024-03-20",
        "RDDT:2024-03-21",
        "CRWV:2025-03-28",
        "CRCL:2025-06-05",
        "FIG:2025-07-31",
      ],
    });
    expect(BUILT_IN_LISTS.map((list) => list.name)).toEqual([
      "S&P 500 Growth Leaders",
      "Nasdaq-100 Newcomers",
      "Recent Market Debuts",
    ]);
    // Every dated member records the authoritative source it was verified against.
    for (const list of BUILT_IN_LISTS) {
      for (const member of list.members) {
        expect(
          member.eligibleFrom === null || member.source?.startsWith("https://"),
        ).toBe(true);
      }
    }
  });

  it("defines both strategies through the canonical validator, in the accepted logic", () => {
    const logic = Object.fromEntries(
      BUILT_IN_STRATEGIES.map((strategy) => {
        const definition = normalizeStrategyDefinition(strategy.definition);
        const describe = (
          signal: (typeof definition.buyLevels)[number]["signal"],
        ) => ({
          conditions: signal.conditions.map(describeCondition),
          trigger: signal.trigger ? describeTrigger(signal.trigger) : null,
        });
        return [
          strategy.systemKey,
          {
            buy: definition.buyLevels.map((level) => [
              level.percentage,
              describe(level.signal),
            ]),
            sell: definition.sellLevels.map((level) => [
              level.percentage,
              describe(level.signal),
            ]),
            exit: definition.finalExit?.rules.map((rule) =>
              describe(rule.signal),
            ),
          },
        ];
      }),
    );
    expect(logic).toEqual({
      "value-and-trend": {
        buy: [
          [
            100,
            {
              conditions: [
                "Margin of Safety (Balanced) is above 5%",
                "Price is above SMA 200D",
              ],
              trigger: null,
            },
          ],
        ],
        sell: [
          [
            50,
            {
              conditions: [
                "Margin of Safety (Balanced) is below -15%",
                "Price is above SMA 200D",
              ],
              trigger: null,
            },
          ],
        ],
        exit: [{ conditions: ["Price is below SMA 200D"], trigger: null }],
      },
      "trend-confirmation": {
        buy: [
          [
            100,
            {
              conditions: [
                "SMA 50D is above SMA 200D",
                "Price is above SMA 200D",
              ],
              trigger: "Price crosses above SMA 20D",
            },
          ],
        ],
        sell: [],
        exit: [{ conditions: [], trigger: "Price crosses below SMA 200D" }],
      },
    });
    // Every level is Monitor-evaluable: nothing depends on a position.
    for (const strategy of BUILT_IN_STRATEGIES) {
      const definition = normalizeStrategyDefinition(strategy.definition);
      expect(monitorStrategyLevels(definition)).toHaveLength(
        definition.buyLevels.length +
          definition.sellLevels.length +
          (definition.finalExit ? 1 : 0),
      );
    }
  });

  it("binds three monitors, one per list, reusing Trend Confirmation twice", () => {
    expect(
      BUILT_IN_MONITORS.map((monitor) => [
        monitor.systemKey,
        monitor.name,
        monitor.listKey,
        monitor.strategyKey,
      ]),
    ).toEqual([
      [
        "sp500-value-and-trend",
        "S&P Value & Trend",
        "sp500-growth-leaders",
        "value-and-trend",
      ],
      [
        "nasdaq-trend-confirmation",
        "Nasdaq Trend Confirmation",
        "nasdaq100-newcomers",
        "trend-confirmation",
      ],
      [
        "new-listings-trend-confirmation",
        "New Listings Trend Confirmation",
        "recent-market-debuts",
        "trend-confirmation",
      ],
    ]);
  });
});

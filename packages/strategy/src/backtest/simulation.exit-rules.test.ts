import { describe, expect, it } from "vitest";
import { seriesOperand } from "../operands.js";
import {
  buyLevel,
  definitionOf,
  executionInput,
  finalExit,
  finalExitRules,
  frameOf,
  lossAboveSignal,
  seriesAboveSignal,
  priceAboveSignal,
  priceCrossesAboveSignal,
  securityInput,
  sellLevel,
  tradingDates,
} from "./backtest.test-helper.js";
import { simulateBacktest } from "./simulate.js";

/**
 * FINAL EXIT over data: `(A AND B) OR (C AND D)`, one action however many rules match.
 *
 * `ai/product/strategies.md` fixes the semantics — conditions AND inside a rule, rules OR across
 * the action, each rule owning its own optional trigger. This suite drives them from four
 * independently movable market predicates so every row of the truth table is reachable, and then
 * proves the thing a ledger cannot survive being wrong about: a date where two rules match closes
 * the position **once**.
 */

const DATES = tradingDates("2020-01-06", 4);

/** True on a date exactly when that series reads 90; false when it reads 10. */
const HIGH = 90;
const LOW = 10;
const THRESHOLD = 50;

/**
 * Closes that buy on day one and never again.
 *
 * The day loop runs exits before entries, so a position cannot exit on the date it was opened, and
 * a security whose position closes cannot be re-entered the same day. Both matter for a fixture
 * about *how many* exits happen: a BUY that kept matching would re-enter on a later day and exit a
 * second time, which is a second position's exit rather than a duplicate of the first.
 */
const CLOSES = [100, 90, 90, 90];
/** `Price is above 95` — true only on day one, so exactly one position is ever opened. */
const BUY_ONCE = priceAboveSignal(95);

/** `A`, `B`, `C`, `D` — four RSI series, each moved on its own. */
function frameWith(input: {
  a: readonly number[];
  b: readonly number[];
  c: readonly number[];
  d?: readonly number[];
  closes?: readonly number[];
  dates?: readonly string[];
}) {
  return frameOf({
    symbol: "AAA",
    dates: (input.dates ?? DATES) as never,
    closes: input.closes ?? CLOSES,
    columns: {
      [seriesOperand("RSI_7D")]: [...input.a],
      [seriesOperand("RSI_14D")]: [...input.b],
      [seriesOperand("RSI_21D")]: [...input.c],
      [seriesOperand("SMA_20D")]: [...(input.d ?? input.c)],
    },
  });
}

/** One row of the truth table, with each predicate held at its value for the whole fixture. */
async function finalExitFires(
  a: boolean,
  b: boolean,
  c: boolean,
  d: boolean,
): Promise<boolean> {
  const held = (on: boolean) => Array(DATES.length).fill(on ? HIGH : LOW);
  const result = await simulateBacktest(
    executionInput({
      definition: definitionOf({
        buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
        // Rule 1 = A AND B, rule 2 = C AND D.
        finalExit: finalExitRules(
          "exit-1",
          seriesAboveSignal(["RSI_7D", "RSI_14D"], THRESHOLD),
          seriesAboveSignal(["RSI_21D", "SMA_20D"], THRESHOLD),
        ),
      }),
      securities: [
        securityInput(
          frameWith({ a: held(a), b: held(b), c: held(c), d: held(d) }),
        ),
      ],
      initialCapital: 100_000,
      maximumPositions: 1,
    }),
  );
  return result.trades.some((trade) => trade.action === "FINAL_EXIT");
}

describe("Exit Rule truth table", () => {
  it("ANDs the conditions inside one rule and ORs the rules across the action", async () => {
    // Rule 1 = A AND B, rule 2 = C AND D.
    for (const [a, b, c, d, expected] of [
      [true, true, false, false, true],
      [false, false, true, true, true],
      [true, false, true, false, false],
      [true, true, true, true, true],
      [false, false, false, false, false],
      [false, true, false, true, false],
      [true, false, false, true, false],
    ] as const) {
      expect(
        await finalExitFires(a, b, c, d),
        `A=${a} B=${b} C=${c} D=${d}`,
      ).toBe(expected);
    }
  });
});

describe("one Final Exit, however many rules match", () => {
  /**
   * The invariant a trade ledger cannot survive being wrong about.
   *
   * Both rules are deliberately true on the same date. A per-rule exit loop would sell the position
   * once for rule 1 and then again — for zero shares, or worse, for a second full position — under
   * rule 2. The position closes once, and every rule that matched contributed to that one decision.
   */
  it("closes the position exactly once when two overlapping rules match on one date", async () => {
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
          finalExit: finalExitRules(
            "exit-1",
            // Deliberately overlapping: on day two both are unambiguously true.
            seriesAboveSignal(["RSI_7D"], THRESHOLD),
            seriesAboveSignal(["RSI_14D"], THRESHOLD),
          ),
        }),
        securities: [
          securityInput(
            frameWith({
              a: [LOW, HIGH, HIGH, HIGH],
              b: [LOW, HIGH, HIGH, HIGH],
              c: [LOW, LOW, LOW, LOW],
            }),
          ),
        ],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    const exits = result.trades.filter((trade) => trade.action === "FINAL_EXIT");
    expect(exits).toHaveLength(1);
    expect(exits[0]?.date).toBe(DATES[1]);
    expect(result.summary.finalExitTrades).toBe(1);
    // One level id, because FINAL EXIT is one level whichever rule reached it.
    expect(exits[0]?.levelId).toBe("exit-1");
    expect(exits[0]?.levelPercentage).toBeNull();
    expect(result.summary.openPositions).toBe(0);
  });

  it("still exits once when three rules match together", async () => {
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
          finalExit: finalExitRules(
            "exit-1",
            seriesAboveSignal(["RSI_7D"], THRESHOLD),
            seriesAboveSignal(["RSI_14D"], THRESHOLD),
            seriesAboveSignal(["RSI_21D"], THRESHOLD),
          ),
        }),
        securities: [
          securityInput(
            frameWith({
              a: [LOW, HIGH, HIGH, HIGH],
              b: [LOW, HIGH, HIGH, HIGH],
              c: [LOW, HIGH, HIGH, HIGH],
            }),
          ),
        ],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    expect(
      result.trades.filter((trade) => trade.action === "FINAL_EXIT"),
    ).toHaveLength(1);
  });

  it("exits on rule 2 alone when rule 1 never matches, and the reverse", async () => {
    const run = (first: boolean) =>
      simulateBacktest(
        executionInput({
          definition: definitionOf({
            buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
            finalExit: finalExitRules(
              "exit-1",
              seriesAboveSignal(["RSI_7D"], THRESHOLD),
              seriesAboveSignal(["RSI_14D"], THRESHOLD),
            ),
          }),
          securities: [
            securityInput(
              frameWith({
                a: first ? [LOW, HIGH, HIGH, HIGH] : [LOW, LOW, LOW, LOW],
                b: first ? [LOW, LOW, LOW, LOW] : [LOW, HIGH, HIGH, HIGH],
                c: [LOW, LOW, LOW, LOW],
              }),
            ),
          ],
          initialCapital: 100_000,
          maximumPositions: 1,
        }),
      );

    for (const first of [true, false]) {
      const exits = (await run(first)).trades.filter(
        (trade) => trade.action === "FINAL_EXIT",
      );
      expect(exits).toHaveLength(1);
      expect(exits[0]?.date).toBe(DATES[1]);
    }
  });

  it("does not exit at all when no rule matches", async () => {
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
          finalExit: finalExitRules(
            "exit-1",
            seriesAboveSignal(["RSI_7D"], THRESHOLD),
            seriesAboveSignal(["RSI_14D"], THRESHOLD),
          ),
        }),
        securities: [
          securityInput(
            frameWith({
              a: [LOW, LOW, LOW, LOW],
              b: [LOW, LOW, LOW, LOW],
              c: [LOW, LOW, LOW, LOW],
            }),
          ),
        ],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    expect(result.trades.filter((t) => t.action === "FINAL_EXIT")).toEqual([]);
    // The position survived the strategy and was closed only because the period ended — an
    // end-of-backtest liquidation, which is execution methodology and never a FINAL EXIT.
    const closeOut = result.trades.filter(
      (t) => t.source === "END_OF_BACKTEST",
    );
    expect(closeOut).toHaveLength(1);
    expect(closeOut[0]?.action).toBe("SELL");
    expect(result.summary.openPositions).toBe(0);
  });
});

describe("each Exit Rule owns its own trigger", () => {
  /**
   * The wrong implementation this proves absent is
   * `((rule 1 conditions) OR (rule 2 conditions)) AND one global trigger`.
   *
   * Rule 1 is a crossing — TRUE on exactly one date. Rule 2 is a plain condition and must be able
   * to match on days where rule 1's crossing did not happen.
   */
  it("lets a rule with no trigger match on a day the other rule's trigger did not fire", async () => {
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
          finalExit: finalExitRules(
            "exit-1",
            // Never crosses: the close is flat at 100 for the whole fixture.
            priceCrossesAboveSignal(150),
            seriesAboveSignal(["RSI_14D"], THRESHOLD),
          ),
        }),
        securities: [
          securityInput(
            frameWith({
              a: [LOW, LOW, LOW, LOW],
              b: [LOW, LOW, HIGH, HIGH],
              c: [LOW, LOW, LOW, LOW],
            }),
          ),
        ],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    const exits = result.trades.filter((t) => t.action === "FINAL_EXIT");
    expect(exits).toHaveLength(1);
    expect(exits[0]?.date).toBe(DATES[2]);
  });

  /**
   * And the mirror: a triggered rule keeps its event semantics. Its conditions are true for three
   * days but the crossing happens once, so the rule matches only on the crossing date — it does not
   * borrow the other rule's condition-only persistence.
   */
  it("keeps a triggered rule an event, not a state borrowed from the other rule", async () => {
    const dates = tradingDates("2020-01-06", 4);
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
          sellLevels: [
            // A SELL that never fires, present only to prove FINAL EXIT outranks nothing here.
            sellLevel("s1", 25, priceAboveSignal(10_000)),
          ],
          finalExit: finalExitRules(
            "exit-1",
            {
              ...seriesAboveSignal(["RSI_14D"], THRESHOLD),
              trigger: priceCrossesAboveSignal(105).trigger,
            },
            seriesAboveSignal(["RSI_21D"], 200),
          ),
        }),
        securities: [
          securityInput(
            frameWith({
              dates,
              // Crosses 105 on day three only; `Price is above 95` buys on day one only.
              closes: [100, 90, 110, 110],
              a: [LOW, LOW, LOW, LOW],
              b: [HIGH, HIGH, HIGH, HIGH],
              c: [LOW, LOW, LOW, LOW],
            }),
          ),
        ],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    const exits = result.trades.filter((t) => t.action === "FINAL_EXIT");
    expect(exits).toHaveLength(1);
    // Day three, the crossing — not day one, where only the condition half held.
    expect(exits[0]?.date).toBe(dates[2]);
  });
});

describe("position-dependent rules stay per-rule", () => {
  /**
   * `Loss > 20%` and a market rule as alternatives. Each rule's position half is ANDed with *its
   * own* market half before the OR, so a market condition belonging to rule 2 can never satisfy
   * rule 1's Loss requirement.
   */
  it("ANDs each rule's position half with its own market half", async () => {
    const dates = tradingDates("2020-01-06", 3);
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
          finalExit: finalExitRules(
            "exit-1",
            // Rule 1: a market condition that is true from day two, ANDed with a 20% loss.
            {
              conditions: [
                ...seriesAboveSignal(["RSI_7D"], THRESHOLD).conditions,
                ...lossAboveSignal(20).conditions,
              ],
            },
            // Rule 2: a market condition that never holds.
            seriesAboveSignal(["RSI_21D"], 200),
          ),
        }),
        securities: [
          securityInput(
            frameWith({
              dates,
              // Day two is only a 5% drawdown; day three is 30%.
              closes: [100, 95, 70],
              a: [LOW, HIGH, HIGH],
              b: [LOW, LOW, LOW],
              c: [LOW, LOW, LOW],
            }),
          ),
        ],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    const exits = result.trades.filter((t) => t.action === "FINAL_EXIT");
    expect(exits).toHaveLength(1);
    // Not day two: the market half held but the position half did not.
    expect(exits[0]?.date).toBe(dates[2]);
  });
});

describe("a single-rule FINAL EXIT behaves exactly as it always has", () => {
  it("produces the same trades as the same logic did before Exit Rules existed", async () => {
    const securities = () => [
      securityInput(
        frameWith({
          a: [LOW, LOW, HIGH, HIGH],
          b: [LOW, LOW, LOW, LOW],
          c: [LOW, LOW, LOW, LOW],
        }),
      ),
    ];
    const signal = seriesAboveSignal(["RSI_7D"], THRESHOLD);

    const [single, viaRules] = await Promise.all([
      simulateBacktest(
        executionInput({
          definition: definitionOf({
            buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
            finalExit: finalExit("exit-1", signal),
          }),
          securities: securities(),
          initialCapital: 100_000,
          maximumPositions: 1,
        }),
      ),
      simulateBacktest(
        executionInput({
          definition: definitionOf({
            buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
            finalExit: finalExitRules("exit-1", signal),
          }),
          securities: securities(),
          initialCapital: 100_000,
          maximumPositions: 1,
        }),
      ),
    ]);

    // Everything but the recorded rule identity is identical. The two fixtures name their single
    // alternative differently — the v1 upcast reuses the FINAL EXIT's own id, while a hand-written
    // multi-rule FINAL EXIT numbers its rules — and that identity is what the trade records so a
    // trade log can say which alternative matched. The logic, the fills and the ledger are the
    // same.
    const withoutRuleIdentity = (trades: typeof single.trades) =>
      trades.map(({ exitRuleId: _ignored, ...rest }) => rest);
    expect(withoutRuleIdentity(viaRules.trades)).toEqual(
      withoutRuleIdentity(single.trades),
    );
    expect(viaRules.summary).toEqual(single.summary);
    const exitIdOf = (trades: typeof single.trades) =>
      trades.find((trade) => trade.action === "FINAL_EXIT")?.exitRuleId;
    expect(exitIdOf(single.trades)).toBe("exit-1");
    expect(exitIdOf(viaRules.trades)).toBe("exit-1-rule-1");
  });
});

describe("FINAL EXIT still outranks a matching partial SELL", () => {
  it("closes the position on the exit rule rather than selling part of it", async () => {
    const result = await simulateBacktest(
      executionInput({
        definition: definitionOf({
          buyLevels: [buyLevel("b1", 100, BUY_ONCE)],
          sellLevels: [sellLevel("s1", 50, priceAboveSignal(0))],
          finalExit: finalExitRules(
            "exit-1",
            seriesAboveSignal(["RSI_7D"], THRESHOLD),
            seriesAboveSignal(["RSI_14D"], THRESHOLD),
          ),
        }),
        securities: [
          securityInput(
            frameWith({
              a: [HIGH, HIGH, HIGH, HIGH],
              b: [HIGH, HIGH, HIGH, HIGH],
              c: [LOW, LOW, LOW, LOW],
            }),
          ),
        ],
        initialCapital: 100_000,
        maximumPositions: 1,
      }),
    );

    // Day one buys and immediately final-exits; the SELL level never gets the position.
    expect(result.trades.map((trade) => trade.action)).toEqual([
      "BUY",
      "FINAL_EXIT",
    ]);
  });
});

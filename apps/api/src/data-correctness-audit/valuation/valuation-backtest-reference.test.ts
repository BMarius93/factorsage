import {
  VALUATION_AUDIT_BACKTESTS,
  VALUATION_AUDIT_EXPECTED_TRADES,
} from "@intrinsic/testing";
import { describe, expect, it } from "vitest";
import {
  referenceValuationTrades,
  valuationAuditRows,
} from "./backtest-reference";

/**
 * The valuation backtest audit's reference side: the clean-room oracles and the reference
 * backtester, over the anchor's stored rows, must produce exactly the trades the anchor records —
 * the same literals the worker's audit holds the real `BacktestProcessor` to. So the product's
 * trades equal the oracle's, through one shared literal, without either app importing the other.
 */
describe("valuation backtests: the reference over the anchor", () => {
  const rows = valuationAuditRows();
  const trades = referenceValuationTrades();

  it("produces exactly the anchor's recorded trades for every case", () => {
    expect(Object.keys(trades).sort()).toEqual(
      VALUATION_AUDIT_BACKTESTS.map((backtest) => backtest.id).sort(),
    );
    for (const backtest of VALUATION_AUDIT_BACKTESTS) {
      expect(trades[backtest.id], backtest.id).toEqual(
        VALUATION_AUDIT_EXPECTED_TRADES[backtest.id],
      );
    }
  });

  it("never acts on a session whose ratio is unavailable", () => {
    const byDate = new Map(rows.map((row) => [row.date, row]));
    for (const backtest of VALUATION_AUDIT_BACKTESTS) {
      const definition = backtest.definition as {
        buyLevels: {
          id: string;
          signal: {
            conditions: { metric: { kind: string; ratioId?: string } }[];
          };
        }[];
        sellLevels: {
          id: string;
          signal: {
            conditions: { metric: { kind: string; ratioId?: string } }[];
          };
        }[];
        finalExit: {
          rules: {
            id: string;
            signal: {
              conditions: { metric: { kind: string; ratioId?: string } }[];
            };
          }[];
        } | null;
      };
      const signals = new Map<
        string,
        { metric: { kind: string; ratioId?: string } }[]
      >([
        ...definition.buyLevels.map(
          (level) => [level.id, level.signal.conditions] as const,
        ),
        ...definition.sellLevels.map(
          (level) => [level.id, level.signal.conditions] as const,
        ),
        ...(definition.finalExit?.rules ?? []).map(
          (rule) => [rule.id, rule.signal.conditions] as const,
        ),
      ]);
      for (const [date, action, levelId] of trades[backtest.id] ?? []) {
        // A FINAL EXIT names its level; its single rule is "r1".
        const conditions =
          signals.get(action === "FINAL_EXIT" ? "r1" : levelId) ?? [];
        for (const condition of conditions) {
          if (condition.metric.kind === "VALUATION_RATIO") {
            expect(
              byDate
                .get(date)
                ?.values.has(`valuation:${condition.metric.ratioId}`),
              `${backtest.id} ${action} ${date} on an unavailable ${condition.metric.ratioId}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("buys on the first session after the listed distribution's mask, and not before (worked by hand)", () => {
    // V06's condition, P/E below a million, is true whenever P/E is available. 2021Q2's statements,
    // the first whose period ends after the 2021-06-03 entry, are public from 2021-08-11 (filed 41
    // days after 2021-06-30): every earlier session is withheld by rule 4.1.
    expect(trades.V06).toEqual([["2021-08-11", "BUY", "b1"]]);
    const pe = (date: string) =>
      rows
        .find((row) => row.date === date)
        ?.values.get("valuation:PRICE_TO_EARNINGS_TTM");
    expect(pe("2021-08-10")).toBeUndefined();
    expect(pe("2021-08-11")).toBeGreaterThan(0);
  });

  it("buys on negative EV/EBITDA only while the net-cash balance sheet is in force (worked by hand)", () => {
    // 2023Q3's balance sheet (net cash 40,000) is public from Saturday 2023-11-11: first session
    // Monday 2023-11-13. 2023Q4's (net debt 3,000) from Saturday 2024-03-02: first session Monday
    // 2024-03-04, when EV/EBITDA is above 4 again.
    expect(trades.V05).toEqual([
      ["2023-11-13", "BUY", "b1"],
      ["2024-03-04", "FINAL_EXIT", "x1"],
    ]);
  });
});

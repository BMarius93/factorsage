import type { StrategySummaryResponse } from "@intrinsic/contracts";
import { formatDate } from "../../../lib/dates";

/** The product's one date format (`lib/dates`), so every collection reads the same way. */
export function formatStrategyDate(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? "—" : formatDate(iso);
}

/**
 * A strategy's shape at a glance: how many BUY and SELL levels it has, and whether it ends with a
 * FINAL EXIT. Derived from the summary counts so the collection never loads a definition.
 */
export function strategyShapeLabel(
  strategy: Pick<
    StrategySummaryResponse,
    "buyLevelCount" | "sellLevelCount" | "hasFinalExit"
  >,
): string {
  const parts = [
    `${strategy.buyLevelCount} ${strategy.buyLevelCount === 1 ? "buy" : "buys"}`,
  ];
  if (strategy.sellLevelCount > 0) {
    parts.push(
      `${strategy.sellLevelCount} ${strategy.sellLevelCount === 1 ? "sell" : "sells"}`,
    );
  }
  if (strategy.hasFinalExit) {
    parts.push("final exit");
  }
  return parts.join(" · ");
}

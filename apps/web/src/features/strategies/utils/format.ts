import type { StrategySummaryResponse } from "@intrinsic/contracts";

/** Matches the lists feature's date presentation so two collections read the same way. */
export function formatStrategyDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return "—";
  }
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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

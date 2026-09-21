import type {
  StrategyLevelKind,
  StrategySummaryResponse,
} from "@intrinsic/contracts";
import type { StatusTone } from "../../../components/ui/StatusBadge";
import { formatDate } from "../../../lib/dates";

/** The product's one date format (`lib/dates`), so every collection reads the same way. */
export function formatStrategyDate(iso: string): string {
  return Number.isNaN(Date.parse(iso)) ? "—" : formatDate(iso);
}

/**
 * The one colour for each level kind, wherever the product shows one: BUY positive, SELL negative,
 * FINAL EXIT warning — the Builder's own mapping, so a Buy reads in the same green on the
 * Strategies collection, a Dashboard match, a Monitor's Signals and a Backtest's trades.
 */
export const LEVEL_KIND_TONES = {
  BUY: "positive",
  SELL: "negative",
  FINAL_EXIT: "warning",
} as const satisfies Record<StrategyLevelKind, StatusTone>;

export type StrategyLevelBadge = {
  readonly kind: StrategyLevelKind;
  readonly label: string;
};

/**
 * A strategy's shape at a glance, as one badge per level kind it has: `3 buys`, `1 sell`,
 * `Final exit`. Derived from the summary counts so the collection never loads a definition; a
 * kind the strategy does not have is left out rather than shown as zero.
 */
export function strategyLevelBadges(
  strategy: Pick<
    StrategySummaryResponse,
    "buyLevelCount" | "sellLevelCount" | "hasFinalExit"
  >,
): readonly StrategyLevelBadge[] {
  const badges: StrategyLevelBadge[] = [];
  if (strategy.buyLevelCount > 0) {
    badges.push({
      kind: "BUY",
      label: `${strategy.buyLevelCount} ${strategy.buyLevelCount === 1 ? "buy" : "buys"}`,
    });
  }
  if (strategy.sellLevelCount > 0) {
    badges.push({
      kind: "SELL",
      label: `${strategy.sellLevelCount} ${strategy.sellLevelCount === 1 ? "sell" : "sells"}`,
    });
  }
  if (strategy.hasFinalExit) {
    badges.push({ kind: "FINAL_EXIT", label: "Final exit" });
  }
  return badges;
}

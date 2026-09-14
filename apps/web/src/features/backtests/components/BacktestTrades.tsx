import type {
  BacktestTradeAction,
  BacktestTradeResponse,
} from "@intrinsic/contracts";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SectionCard } from "../../../components/ui/SectionCard";
import {
  StatusBadge,
  type StatusTone,
} from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import {
  formatDay,
  formatMoney,
  formatShares,
  formatSignedMoney,
  formatSignedPercent,
} from "../utils/format";
import styles from "./BacktestTrades.module.css";

/** One product label per action; the tone follows the established buy/sell/final-exit colours. */
const ACTION_LABELS = {
  BUY: "Buy",
  SELL: "Sell",
  FINAL_EXIT: "Final exit",
} as const satisfies Record<BacktestTradeAction, string>;

const ACTION_TONES = {
  BUY: "positive",
  SELL: "negative",
  FINAL_EXIT: "warning",
} as const satisfies Record<BacktestTradeAction, StatusTone>;

export type BacktestTradesProps = {
  readonly trades: readonly BacktestTradeResponse[];
  readonly title: string;
  readonly emptyMessage: string;
  /** True when the run's true trade count exceeds what the payload carries. */
  readonly truncatedFrom?: number;
};

/**
 * The trade log, newest first.
 *
 * The same component serves the running page's recent trades and a completed run's full log: they
 * differ only in how many rows the payload carries, never in what a trade means.
 */
export function BacktestTrades({
  trades,
  title,
  emptyMessage,
  truncatedFrom,
}: BacktestTradesProps) {
  const shown = [...trades].sort(
    (left, right) => right.sequence - left.sequence,
  );
  const truncated =
    truncatedFrom !== undefined && truncatedFrom > trades.length
      ? truncatedFrom
      : undefined;

  const columns: readonly DataTableColumn<BacktestTradeResponse>[] = [
    {
      key: "stock",
      header: "Stock",
      cardRole: "identity",
      render: (trade) => (
        <StockIdentity
          symbol={trade.symbol}
          size="sm"
          secondary={formatDay(trade.date)}
          href={`/stocks/${encodeURIComponent(trade.symbol)}`}
        />
      ),
    },
    {
      key: "action",
      header: "Action",
      cardRole: "status",
      nowrap: true,
      render: (trade) => (
        <StatusBadge
          tone={ACTION_TONES[trade.action]}
          dataAttributes={{ "data-action": trade.action }}
        >
          {ACTION_LABELS[trade.action]}
          {trade.levelPercentage === null ? null : ` ${trade.levelPercentage}%`}
        </StatusBadge>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (trade) => formatMoney(trade.amount),
    },
    {
      key: "execution",
      header: "Shares @ price",
      cardLabel: "Execution",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (trade) =>
        `${formatShares(trade.shares)} @ ${formatMoney(trade.price)}`,
    },
    {
      key: "realized",
      header: "Realized",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (trade) =>
        // A buy realizes nothing; an empty cell is the truthful answer, not a zero.
        trade.realizedPnl === null ? (
          <span className={styles.placeholder}>—</span>
        ) : (
          <span
            className={styles.realized}
            data-tone={
              trade.realizedPnl === 0
                ? undefined
                : trade.realizedPnl > 0
                  ? "positive"
                  : "negative"
            }
          >
            {formatSignedMoney(trade.realizedPnl)}
            {trade.realizedPnlPercent === null
              ? null
              : ` · ${formatSignedPercent(trade.realizedPnlPercent)}`}
          </span>
        ),
    },
  ];

  return (
    <SectionCard
      id="backtest-trades"
      title={title}
      aside={
        truncated === undefined
          ? `${trades.length}`
          : `${trades.length} of ${truncated}`
      }
      flush={shown.length > 0}
    >
      <DataTable
        label={title}
        testId="backtest-trades"
        rowTestId="backtest-trade-row"
        columns={columns}
        rows={shown}
        getRowKey={(trade) => String(trade.sequence)}
        emptyState={
          <EmptyState
            variant="compact"
            testId="backtest-trades-empty"
            title="No trades"
            body={<p>{emptyMessage}</p>}
          />
        }
      />
    </SectionCard>
  );
}

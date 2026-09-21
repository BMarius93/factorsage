import type {
  BacktestTradeAction,
  BacktestTradeReason,
  BacktestTradeResponse,
} from "@intrinsic/contracts";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { CollectionFooter } from "../../../components/ui/CollectionFooter";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import {
  formatDay,
  formatMoney,
  formatShares,
  formatSignedMoney,
  formatSignedPercent,
} from "../utils/format";
import { LEVEL_KIND_TONES } from "../../strategies/utils/format";
import styles from "./BacktestTrades.module.css";

/** One product label per action; the tone is the product's one buy/sell/final-exit map. */
const ACTION_LABELS = {
  BUY: "Buy",
  SELL: "Sell",
  FINAL_EXIT: "Final exit",
} as const satisfies Record<BacktestTradeAction, string>;

/**
 * What the end-of-backtest liquidation is called where a user reads it.
 *
 * Deliberately not "Final exit": `FINAL EXIT` is a Strategy level with its own meaning, and this is
 * the simulation period ending. The action stays `Sell`, because that is what happened.
 */
const END_OF_BACKTEST_REASON = "End of backtest";

/**
 * Why a trade happened, in the canonical Strategy description language.
 *
 * The server resolves which rule fired from the run's own immutable snapshot; this only draws it.
 * A trade the run could not attribute renders as an em dash rather than a guess.
 */
function ReasonCell({ trade }: { readonly trade: BacktestTradeResponse }) {
  const reason: BacktestTradeReason | null = trade.reason;
  if (reason === null) {
    return <span className={styles.placeholder}>—</span>;
  }
  if (reason.kind === "END_OF_BACKTEST") {
    return (
      <span
        className={styles.reason}
        data-testid="backtest-trade-reason"
        data-kind="END_OF_BACKTEST"
      >
        {END_OF_BACKTEST_REASON}
      </span>
    );
  }
  return (
    <span
      className={styles.reason}
      data-testid="backtest-trade-reason"
      data-kind="STRATEGY"
    >
      {reason.exitRule === undefined ? null : (
        <span className={styles.reasonRule}>Exit rule {reason.exitRule}: </span>
      )}
      {reason.conditions.join(" and ")}
      {reason.trigger ? (
        <span className={styles.reasonTrigger}>
          {reason.conditions.length > 0 ? " · " : ""}
          Triggered: {reason.trigger}
        </span>
      ) : null}
    </span>
  );
}

export type BacktestTradesProps = {
  readonly trades: readonly BacktestTradeResponse[];
  readonly title: string;
  readonly emptyMessage: string;
  /** True when the run's true trade count exceeds what the payload carries. */
  readonly truncatedFrom?: number;
  /** Server-side paging. Omitted for the running page's bounded recent-trades list. */
  readonly paging?: {
    readonly page: number;
    readonly pageSize: number;
    readonly totalCount: number;
    readonly onPageChange: (page: number) => void;
    readonly onPageSizeChange: (pageSize: number) => void;
    /** True while a page request is in flight, so the table can dim rather than blank out. */
    readonly loading?: boolean;
  };
};

/**
 * The trade log, newest first.
 *
 * The same component serves the running page's recent trades and a completed run's full log. They
 * differ in one thing: a completed log is **paged in the database**, so the rows on screen are one
 * page of possibly tens of thousands rather than a bounded tail of them.
 */
export function BacktestTrades({
  trades,
  title,
  emptyMessage,
  truncatedFrom,
  paging,
}: BacktestTradesProps) {
  const shown = [...trades].sort(
    (left, right) => right.sequence - left.sequence,
  );
  const truncated =
    truncatedFrom !== undefined && truncatedFrom > trades.length
      ? truncatedFrom
      : undefined;
  const loadingFirstPage = (paging?.loading ?? false) && shown.length === 0;

  const columns: readonly DataTableColumn<BacktestTradeResponse>[] = [
    {
      key: "stock",
      header: "Stock",
      cardRole: "identity",
      minWidth: "9rem",
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
          tone={LEVEL_KIND_TONES[trade.action]}
          dataAttributes={{
            "data-action": trade.action,
            // The execution source travels beside the action so a test can tell a strategy sale
            // from the end-of-period liquidation without reading prose.
            "data-source": trade.source,
          }}
        >
          {ACTION_LABELS[trade.action]}
          {trade.levelPercentage === null ? null : ` ${trade.levelPercentage}%`}
          {trade.source === "END_OF_BACKTEST" ? " 100%" : null}
        </StatusBadge>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      // The widest column on purpose: a strategy rule is a sentence, and truncating it to a chip
      // would remove the one thing the column exists to say.
      minWidth: "16rem",
      width: "34%",
      // On a phone the label would only be height: the value is already a sentence about why.
      cardLabel: null,
      stacked: true,
      render: (trade) => <ReasonCell trade={trade} />,
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
        paging
          ? undefined
          : truncated === undefined
            ? `${trades.length}`
            : `${trades.length} of ${truncated}`
      }
      flush={shown.length > 0}
    >
      {/* A page request dims the rows it is replacing rather than blanking the table: a trade log
          that emptied itself between pages would read as a run that lost its history. The very
          first page has nothing to dim, and "No trades" is the one thing it must not say while it
          is still being fetched — a run that traded nothing and a run whose log has not arrived are
          different facts. */}
      {loadingFirstPage ? (
        <SkeletonList rows={5} rowHeight="52px" />
      ) : (
        <div
          className={styles.rows}
          data-loading={paging?.loading ? "true" : undefined}
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
        </div>
      )}
      {paging && paging.totalCount > 0 ? (
        <CollectionFooter
          testId="backtest-trades-footer"
          noun="trades"
          total={paging.totalCount}
          page={paging.page}
          pageSize={paging.pageSize}
          onPageChange={paging.onPageChange}
          onPageSizeChange={paging.onPageSizeChange}
        />
      ) : null}
    </SectionCard>
  );
}

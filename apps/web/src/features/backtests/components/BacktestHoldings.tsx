import type { BacktestHoldingResponse } from "@intrinsic/contracts";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { SectionCard } from "../../../components/ui/SectionCard";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import {
  formatMoney,
  formatPercent,
  formatShares,
  formatSignedPercent,
} from "../utils/format";
import styles from "./BacktestHoldings.module.css";

export type BacktestHoldingsProps = {
  readonly holdings: readonly BacktestHoldingResponse[];
  readonly title: string;
  readonly emptyMessage: string;
  /**
   * The date the run has simulated through. A holding priced before it is being carried at its
   * last real close because the security stopped producing prices, which is worth saying out loud
   * rather than presenting a stale mark as current.
   */
  readonly asOf?: string;
};

/**
 * Current holdings and how the portfolio is allocated across them.
 *
 * A dense table on desktop and one card per position on a phone, through the shared `DataTable` —
 * allocation stays the number that matters and stays readable at 390px, without this surface
 * owning a second answer to the responsive question.
 */
export function BacktestHoldings({
  holdings,
  title,
  emptyMessage,
  asOf,
}: BacktestHoldingsProps) {
  const columns: readonly DataTableColumn<BacktestHoldingResponse>[] = [
    {
      key: "stock",
      header: "Stock",
      cardRole: "identity",
      render: (holding) => (
        <StockIdentity
          symbol={holding.symbol}
          name={holding.name}
          href={`/stocks/${encodeURIComponent(holding.symbol)}`}
        />
      ),
    },
    {
      key: "pnl",
      header: "Unrealized",
      cardRole: "status",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (holding) => (
        <span
          className={styles.change}
          data-tone={
            holding.unrealizedPnlPercent === 0
              ? undefined
              : holding.unrealizedPnlPercent > 0
                ? "positive"
                : "negative"
          }
        >
          {formatSignedPercent(holding.unrealizedPnlPercent)}
        </span>
      ),
    },
    {
      key: "value",
      header: "Market value",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (holding) => formatMoney(holding.marketValue),
    },
    {
      key: "allocation",
      header: "Allocation",
      align: "right",
      numeric: true,
      width: "9rem",
      render: (holding) => (
        <span className={styles.allocation}>
          {formatPercent(holding.allocationPercent)}
          {/* Allocation is the reason this panel exists; the bar makes concentration
              visible without the user comparing eight percentages by eye. */}
          <span
            className={styles.allocationTrack}
            role="presentation"
            aria-hidden="true"
          >
            <span
              className={styles.allocationFill}
              style={{
                width: `${Math.min(100, Math.max(0, holding.allocationPercent))}%`,
              }}
            />
          </span>
        </span>
      ),
    },
    {
      key: "shares",
      header: "Shares",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (holding) => formatShares(holding.shares),
    },
    {
      key: "cost",
      header: "Avg cost",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (holding) => formatMoney(holding.averageCost),
    },
    {
      key: "last",
      header: "Last",
      align: "right",
      numeric: true,
      render: (holding) => (
        <span className={styles.last}>
          {formatMoney(holding.lastPrice)}
          {asOf !== undefined && holding.lastPriceDate < asOf ? (
            <span
              className={styles.stale}
              data-testid={`backtest-holding-stale-${holding.symbol}`}
            >
              Priced at its last available close, {holding.lastPriceDate}. No
              later price exists for this security in the run.
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  return (
    <SectionCard
      id="backtest-holdings"
      title={title}
      aside={`${holdings.length}`}
      flush={holdings.length > 0}
    >
      <DataTable
        label={title}
        testId="backtest-holdings"
        rowTestId="backtest-holding-row"
        columns={columns}
        rows={holdings}
        getRowKey={(holding) => holding.symbol}
        emptyState={
          <EmptyState
            variant="compact"
            testId="backtest-holdings-empty"
            title="No positions"
            body={<p>{emptyMessage}</p>}
          />
        }
      />
    </SectionCard>
  );
}

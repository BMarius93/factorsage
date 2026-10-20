"use client";

import {
  BACKTEST_TRADE_ACTIONS,
  type BacktestTradeAction,
  type BacktestTradeOrder,
  type BacktestTradeReason,
  type BacktestTradeResponse,
} from "@intrinsic/contracts";
import { useId } from "react";
import actions from "../../../components/ui/actions.module.css";
import {
  DataTable,
  IntermediateOnly,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import forms from "../../../components/ui/forms.module.css";
import { InfoTip } from "../../../components/ui/InfoTip";
import { Notice } from "../../../components/ui/Notice";
import { SectionCard } from "../../../components/ui/SectionCard";
import {
  SegmentedControl,
  type SegmentedOption,
} from "../../../components/ui/SegmentedControl";
import { SelectControl } from "../../../components/ui/SelectControl";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { CollectionFooter } from "../../../components/ui/CollectionFooter";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import type { BacktestTradeLogControls } from "../hooks/use-backtest-trades";
import {
  formatCount,
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

type ActionView = BacktestTradeAction | "ALL";

/**
 * The action filter. `Sell` includes the end-of-backtest liquidations, because they are sales and
 * the log labels them `Sell 100%`; `Final exit` is only the strategy's own FINAL EXIT.
 */
const ACTION_VIEWS: readonly SegmentedOption<ActionView>[] = [
  { value: "ALL", label: "All" },
  ...BACKTEST_TRADE_ACTIONS.map((action) => ({
    value: action,
    label: ACTION_LABELS[action],
  })),
];

const ORDER_OPTIONS: readonly {
  readonly value: BacktestTradeOrder;
  readonly label: string;
}[] = [
  { value: "desc", label: "Newest first" },
  { value: "asc", label: "Oldest first" },
];

/**
 * What a level's percentage means, from the execution methodology
 * (`ai/architecture/backtest-execution.md`): a BUY percentage is a target fill of the full-position
 * budget, `1 / maximumPositions` of the portfolio's value, and a SELL percentage is a fraction of
 * the position remaining when it executes.
 */
const PERCENTAGES_EXPLANATION =
  "Buy 25% fills a position up to a quarter of a full position: the portfolio's value divided " +
  "by the run's maximum positions (10% of it with 10). Sell 50% sells half of the shares still " +
  "held; Final exit and End of backtest sell them all.";

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

/**
 * The completed log's filter, order and export, above the table.
 *
 * The action filter is the view (pills); the stock and the order refine it (dropdowns), so the two
 * shapes never read as competing tab systems. The percentages' explanation sits beside the action
 * filter rather than in a column header, because a phone's card layout hides the header row.
 */
function TradeLogToolbar({
  controls,
  totalCount,
}: {
  readonly controls: BacktestTradeLogControls;
  readonly totalCount: number;
}) {
  const baseId = useId();
  const filtering = controls.symbol !== null || controls.action !== null;
  const matchSummary =
    filtering && controls.unfilteredCount !== null
      ? `${formatCount(totalCount)} of ${formatCount(controls.unfilteredCount)} trades match`
      : null;
  // A symbol from the URL is offered even before the run's list arrives, so the control never
  // shows a value it cannot name.
  const symbols =
    controls.symbol !== null && !controls.symbols.includes(controls.symbol)
      ? [...controls.symbols, controls.symbol]
      : controls.symbols;

  return (
    <div className={styles.toolbar} data-testid="backtest-trades-toolbar">
      <div className={styles.filters}>
        <span className={styles.actionFilter}>
          <SegmentedControl
            label="Filter by action"
            testId="backtest-trades-action-filter"
            value={controls.action ?? "ALL"}
            onChange={(next) =>
              controls.setAction(next === "ALL" ? null : next)
            }
            options={ACTION_VIEWS}
          />
          <InfoTip
            label="buy and sell percentages"
            testId="backtest-trades-percentages-tip"
          >
            {PERCENTAGES_EXPLANATION}
          </InfoTip>
        </span>
        <SelectControl
          id={`${baseId}-symbol`}
          label="Stock"
          value={controls.symbol ?? ""}
          onChange={(next) => controls.setSymbol(next === "" ? null : next)}
          options={[
            { value: "", label: "All stocks" },
            ...symbols.map((symbol) => ({ value: symbol, label: symbol })),
          ]}
          testId="backtest-trades-symbol-filter"
        />
        <SelectControl
          id={`${baseId}-order`}
          label="Sort"
          value={controls.order}
          onChange={(next) =>
            controls.setOrder(next === "asc" ? "asc" : "desc")
          }
          options={ORDER_OPTIONS}
          testId="backtest-trades-order"
        />
      </div>
      {/* The result of a filter, said once for assistive technology. Always present, so a screen
          reader hears the count change rather than a region appear; the line below shows it. */}
      <span className={styles.srOnly} role="status">
        {matchSummary ?? ""}
      </span>
      {matchSummary === null ? null : (
        <div
          className={styles.filterSummary}
          data-testid="backtest-trades-filter-summary"
        >
          <span>{matchSummary}</span>
          {/* Filtered to nothing, the empty state below carries the reset; one button is enough. */}
          {totalCount > 0 ? (
            <button
              type="button"
              className={actions.action}
              onClick={controls.clearFilters}
              data-testid="backtest-trades-clear-filters"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      )}
      {controls.exportError ? (
        <Notice
          tone="error"
          announce="alert"
          testId="backtest-trades-export-error"
        >
          {controls.exportError}
        </Notice>
      ) : null}
    </div>
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
  /**
   * The completed log's filter, order and export. Only meaningful with `paging`: the running
   * page's recent trades are a bounded tail and offer none of it.
   */
  readonly controls?: BacktestTradeLogControls;
};

/**
 * The trade log, newest first unless the reader turns it around.
 *
 * The same component serves the running page's recent trades and a completed run's full log. They
 * differ in what the completed log adds: it is **paged in the database**, so the rows on screen are
 * one page of possibly tens of thousands rather than a bounded tail of them, and it can be
 * filtered, re-ordered and exported — all of which the server applies to the whole log, never to
 * the rows on screen. The running list stays exactly as it was.
 */
export function BacktestTrades({
  trades,
  title,
  emptyMessage,
  truncatedFrom,
  paging,
  controls,
}: BacktestTradesProps) {
  const log = paging && controls ? controls : undefined;
  const order = log?.order ?? "desc";
  // The server has already ordered a page; this only keeps a bounded tail newest-first.
  const shown = [...trades].sort((left, right) =>
    order === "asc"
      ? left.sequence - right.sequence
      : right.sequence - left.sequence,
  );
  const truncated =
    truncatedFrom !== undefined && truncatedFrom > trades.length
      ? truncatedFrom
      : undefined;
  const loadingFirstPage = (paging?.loading ?? false) && shown.length === 0;
  const filtering =
    log !== undefined && (log.symbol !== null || log.action !== null);

  const columns: readonly DataTableColumn<BacktestTradeResponse>[] = [
    // The completed log reads its date as a column of its own, sortable like a transaction
    // history; the running list keeps it under the symbol.
    ...(log
      ? [
          {
            key: "date",
            header: "Date",
            // On a phone the date is a summary line under the identity: it says what it is.
            cardRole: "summary" as const,
            // Between 880 and 1,279px it folds back under the stock, so the log keeps the width
            // it had before the column existed; the order control above the table still sorts.
            foldIntermediate: true,
            nowrap: true,
            sortable: true,
            render: (trade: BacktestTradeResponse) => (
              <time dateTime={trade.date} data-testid="backtest-trade-date">
                {formatDay(trade.date)}
              </time>
            ),
          },
        ]
      : []),
    {
      key: "stock",
      header: "Stock",
      cardRole: "identity",
      minWidth: "9rem",
      render: (trade) =>
        log ? (
          <>
            <StockIdentity
              symbol={trade.symbol}
              name={trade.name}
              size="sm"
              href={`/stocks/${encodeURIComponent(trade.symbol)}`}
            />
            <IntermediateOnly testId="backtest-trade-folded-date">
              <time className={styles.foldedDate} dateTime={trade.date}>
                {formatDay(trade.date)}
              </time>
            </IntermediateOnly>
          </>
        ) : (
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
        log ? (
          <button
            type="button"
            className={actions.action}
            onClick={log.exportCsv}
            disabled={log.exporting}
            aria-busy={log.exporting}
            data-testid="backtest-trades-export"
          >
            {log.exporting ? "Exporting…" : "Export CSV"}
          </button>
        ) : paging ? undefined : truncated === undefined ? (
          `${trades.length}`
        ) : (
          `${trades.length} of ${truncated}`
        )
      }
      toolbar={
        log ? (
          <TradeLogToolbar
            controls={log}
            totalCount={paging?.totalCount ?? 0}
          />
        ) : undefined
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
            {...(log
              ? {
                  sort: { key: "date", direction: order },
                  onSortChange: (key: string) => {
                    if (key === "date") {
                      log.setOrder(order === "desc" ? "asc" : "desc");
                    }
                  },
                }
              : {})}
            emptyState={
              filtering ? (
                // Filtered to nothing is not "no trades": the run traded, and the way back is one
                // press away.
                <EmptyState
                  variant="compact"
                  testId="backtest-trades-filtered-empty"
                  title="No trades match these filters"
                  actions={
                    <button
                      type="button"
                      className={forms.secondaryButton}
                      onClick={log?.clearFilters}
                    >
                      Clear filters
                    </button>
                  }
                />
              ) : (
                <EmptyState
                  variant="compact"
                  testId="backtest-trades-empty"
                  title="No trades"
                  body={<p>{emptyMessage}</p>}
                />
              )
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

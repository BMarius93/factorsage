"use client";

import {
  describeCondition,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import actionStyles from "../../../components/ui/actions.module.css";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { deleteStrategy } from "../api/strategies-api";
import { useStrategies } from "../hooks/use-strategies";
import { formatStrategyDate, strategyShapeLabel } from "../utils/format";
import styles from "./StrategiesPage.module.css";
import { StrategyRenameDialog } from "./StrategyRenameDialog";

/**
 * One illustrative rule for the empty state, composed from the canonical labels rather than typed
 * out, so the copy cannot drift from the series catalog.
 */
const EXAMPLE_CONDITION = describeCondition({
  id: "example",
  metric: { kind: "PRICE" },
  operator: "IS_ABOVE",
  value: { kind: "SERIES", seriesId: "EMA_200D" },
});

type DialogState =
  | { kind: "closed" }
  | { kind: "rename"; strategy: StrategySummaryResponse }
  | { kind: "delete"; strategy: StrategySummaryResponse };

/**
 * The signed-in user's strategies: reusable BUY / SELL / FINAL EXIT logic.
 *
 * Creating goes through the Builder rather than a dialog, because a strategy is not saveable until
 * it has at least one BUY level — there is no name-only strategy to create here. Rendering needs
 * only the summary counts, never a definition.
 */
export function StrategiesPage() {
  const { status, strategies, retry, applyUpdated, applyDeleted } =
    useStrategies();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });

  const columns: readonly DataTableColumn<StrategySummaryResponse>[] = [
    {
      key: "name",
      header: "Name",
      cardRole: "identity",
      render: (strategy) => (
        <Link className={styles.nameLink} href={`/strategies/${strategy.id}`}>
          <span className={styles.name}>{strategy.name}</span>
          {strategy.description ? (
            <span className={styles.description}>{strategy.description}</span>
          ) : null}
        </Link>
      ),
    },
    {
      key: "shape",
      header: "Levels",
      cardRole: "status",
      render: (strategy) => (
        <StatusBadge tone="neutral" variant="outline">
          {strategyShapeLabel(strategy)}
        </StatusBadge>
      ),
    },
    {
      key: "version",
      header: "Version",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (strategy) => `v${strategy.versionNumber}`,
    },
    {
      key: "updated",
      header: "Updated",
      nowrap: true,
      render: (strategy) => formatStrategyDate(strategy.updatedAt),
    },
    {
      key: "actions",
      header: "Actions",
      cardRole: "actions",
      align: "right",
      nowrap: true,
      render: (strategy) => (
        <span className={actionStyles.group}>
          <button
            type="button"
            className={actionStyles.action}
            onClick={() => setDialog({ kind: "rename", strategy })}
          >
            Rename
          </button>
          <button
            type="button"
            className={actionStyles.actionDanger}
            onClick={() => setDialog({ kind: "delete", strategy })}
          >
            Delete
          </button>
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <div className={styles.page} data-testid="strategies-page">
        <PageHeader
          title="Strategies"
          lead="Reusable buy, sell and final-exit logic for backtests and monitors."
          actions={
            status === "ready" && strategies.length > 0 ? (
              <Link
                className={forms.primaryButton}
                href="/strategies/new"
                data-testid="new-strategy-button"
              >
                New strategy
              </Link>
            ) : null
          }
        />

        {status === "loading" ? (
          <SectionCard ariaLabel="Loading strategies">
            <SkeletonList rows={4} />
          </SectionCard>
        ) : null}

        {status === "error" ? (
          <EmptyState
            variant="error"
            title="Your strategies could not be loaded"
            body={<p>This is usually temporary — try again in a moment.</p>}
            actions={
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={retry}
              >
                Try again
              </button>
            }
          />
        ) : null}

        {status === "ready" && strategies.length === 0 ? (
          <EmptyState
            testId="strategies-empty"
            title="No strategies yet"
            body={
              <p>
                A strategy is the reusable logic that decides when to buy and
                when to sell — conditions such as <em>{EXAMPLE_CONDITION}</em>,
                and the event that fires them.
              </p>
            }
            actions={
              <Link
                className={forms.primaryButton}
                href="/strategies/new"
                data-testid="new-strategy-button"
              >
                Create your first strategy
              </Link>
            }
          />
        ) : null}

        {status === "ready" && strategies.length > 0 ? (
          <SectionCard
            id="strategies"
            title="Your strategies"
            aside={`${strategies.length} ${
              strategies.length === 1 ? "strategy" : "strategies"
            }`}
            flush
          >
            <DataTable
              label="Strategies"
              testId="strategies-grid"
              rowTestId="strategy-row"
              columns={columns}
              rows={strategies}
              getRowKey={(strategy) => strategy.id}
              clickableRows
            />
          </SectionCard>
        ) : null}
      </div>

      {dialog.kind === "rename" ? (
        <StrategyRenameDialog
          strategy={dialog.strategy}
          onClose={closeDialog}
          onUpdated={(summary) => {
            applyUpdated(summary);
            closeDialog();
          }}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <ConfirmDialog
          title="Delete strategy"
          body={
            <p className={styles.confirmBody}>
              Delete <strong>{dialog.strategy.name}</strong> and its saved
              versions? This cannot be undone.
            </p>
          }
          confirmLabel="Delete strategy"
          pendingLabel="Deleting…"
          onClose={closeDialog}
          onConfirm={async () => {
            await deleteStrategy(dialog.strategy.id);
            applyDeleted(dialog.strategy.id);
            closeDialog();
          }}
        />
      ) : null}
    </PageContainer>
  );
}

"use client";

import {
  describeCondition,
  STRATEGY_NAME_MAX_LENGTH,
  type StrategySummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import actionStyles from "../../../components/ui/actions.module.css";
import {
  byName,
  byNewest,
  type CollectionSort,
} from "../../../components/ui/Collection";
import type { DataTableColumn } from "../../../components/ui/DataTable";
import { DuplicateDialog } from "../../../components/ui/DuplicateDialog";
import { EmptyState } from "../../../components/ui/EmptyState";
import { OverflowMenu } from "../../../components/ui/OverflowMenu";
import {
  CollectionSection,
  partitionByOwnership,
} from "../../../components/ui/OwnedCollection";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import forms from "../../../components/ui/forms.module.css";
import { useSignInPrompt } from "../../auth/hooks/use-sign-in-prompt";
import { deleteStrategy, duplicateStrategy } from "../api/strategies-api";
import { useStrategies } from "../hooks/use-strategies";
import {
  LEVEL_KIND_TONES,
  formatStrategyDate,
  strategyLevelBadges,
} from "../utils/format";
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

const SIGN_IN_TO_CREATE = {
  title: "Sign in to create a strategy",
  body: "Built-in strategies are free to read. Your own buy, sell and final-exit logic is saved to your account, so creating one needs somewhere to keep it.",
};

const SIGN_IN_TO_DUPLICATE = {
  title: "Sign in to duplicate a strategy",
  body: "Built-in strategies are free to read. A copy is a strategy of your own that you can edit, so making one needs an account to keep it in.",
};

type DialogState =
  | { kind: "closed" }
  | { kind: "rename"; strategy: StrategySummaryResponse }
  | { kind: "duplicate"; strategy: StrategySummaryResponse }
  | { kind: "delete"; strategy: StrategySummaryResponse };

/**
 * Strategies: the viewer's own reusable BUY / SELL / FINAL EXIT logic, and FactorSage's built-in
 * ones.
 *
 * Two sections rather than one mixed table, because the two are owned differently and only one of
 * them can be edited. A Guest reads the built-in section — public product content — and is asked
 * for an account when they reach for the Builder or for a copy, not on arrival.
 *
 * Creating goes through the Builder rather than a dialog, because a strategy is not saveable until
 * it has at least one BUY level — there is no name-only strategy to create here. Rendering needs
 * only the summary counts, never a definition.
 */
/** The orders a customer's own strategies can be read in; the API's newest-first comes first. */
const STRATEGY_SORTS: readonly CollectionSort<StrategySummaryResponse>[] = [
  { id: "newest", label: "Newest" },
  {
    id: "updated",
    label: "Recently updated",
    compare: byNewest((strategy) => strategy.updatedAt),
  },
  { id: "name", label: "Name A–Z", compare: byName },
];

export function StrategiesPage() {
  const router = useRouter();
  const { status, strategies, retry, applyUpdated, applyDeleted } =
    useStrategies();
  const gate = useSignInPrompt();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });
  const { own, builtIn } = partitionByOwnership(strategies);

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
      width: "14rem",
      header: "Levels",
      cardRole: "status",
      // One badge per level kind, in the Builder's colours: green buys, red sells, amber final exit.
      render: (strategy) => (
        <span className={styles.levels} data-testid="strategy-levels">
          {strategyLevelBadges(strategy).map((badge) => (
            <StatusBadge
              key={badge.kind}
              tone={LEVEL_KIND_TONES[badge.kind]}
              variant="outline"
              dataAttributes={{ "data-level": badge.kind }}
            >
              {badge.label}
            </StatusBadge>
          ))}
        </span>
      ),
    },
    {
      key: "version",
      width: "6rem",
      header: "Version",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (strategy) => `v${strategy.versionNumber}`,
    },
    {
      key: "updated",
      width: "9rem",
      header: "Updated",
      nowrap: true,
      render: (strategy) => formatStrategyDate(strategy.updatedAt),
    },
    {
      key: "actions",
      width: "9rem",
      header: "Actions",
      cardRole: "actions",
      align: "right",
      nowrap: true,
      render: (strategy) => (
        <span className={actionStyles.group}>
          <Link
            className={actionStyles.action}
            href={`/strategies/${strategy.id}`}
            aria-label={`Open ${strategy.name}`}
          >
            Open
          </Link>
          <OverflowMenu
            label={strategy.name}
            testId="strategy-actions"
            items={[
              ...(strategy.canEdit
                ? [
                    {
                      label: "Rename",
                      onSelect: () => setDialog({ kind: "rename", strategy }),
                    },
                  ]
                : []),
              // Any strategy the viewer can read can be copied into one they own, a built-in
              // included; a Guest is asked for an account first.
              {
                label: "Duplicate",
                disabled: !gate.resolved,
                onSelect: () =>
                  gate.attempt(SIGN_IN_TO_DUPLICATE, () =>
                    setDialog({ kind: "duplicate", strategy }),
                  ),
              },
              // Built-in strategies are never deleted, not even by an administrator.
              ...(strategy.canEdit && strategy.ownership !== "SYSTEM"
                ? [
                    {
                      label: "Delete",
                      tone: "danger" as const,
                      separated: true,
                      onSelect: () => setDialog({ kind: "delete", strategy }),
                    },
                  ]
                : []),
            ]}
          />
        </span>
      ),
    },
  ];

  /**
   * "New strategy" is navigation for a customer and a question for a Guest, so it is a link for
   * one and a button for the other rather than a link that quietly refuses.
   */
  const newStrategyAction = (className: string | undefined) =>
    gate.signedIn ? (
      <Link
        className={className}
        href="/strategies/new"
        data-testid="new-strategy-button"
      >
        New strategy
      </Link>
    ) : (
      <button
        type="button"
        className={className}
        data-testid="new-strategy-button"
        onClick={() =>
          gate.attempt(SIGN_IN_TO_CREATE, () => router.push("/strategies/new"))
        }
      >
        New strategy
      </button>
    );

  // "New strategy" lives in the header in every state (UI-030). Until the session resolves it is a
  // disabled button, because it is a link for a customer and a question for a Guest.
  const headerAction = gate.resolved ? (
    newStrategyAction(forms.tintedButton)
  ) : (
    <button
      type="button"
      className={forms.tintedButton}
      data-testid="new-strategy-button"
      disabled
    >
      New strategy
    </button>
  );

  return (
    <PageContainer>
      <div className={styles.page} data-testid="strategies-page">
        <PageHeader
          title="Strategies"
          lead="Reusable buy, sell and final-exit logic for backtests and monitors."
          actions={headerAction}
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

        {status === "ready" && gate.signedIn ? (
          <CollectionSection
            title="Your strategies"
            label="Your strategies"
            noun="strategies"
            testId="your-strategies"
            tableTestId="strategies-grid"
            rowTestId="strategy-row"
            footerTestId="strategies-footer"
            columns={columns}
            rows={own}
            getRowKey={(strategy) => strategy.id}
            searchText={(strategy) => strategy.name}
            sorts={STRATEGY_SORTS}
            clickableRows
            emptyState={
              <EmptyState
                variant="compact"
                testId="strategies-empty"
                title="You haven't created any strategies yet"
                body={
                  <p>
                    A strategy is the reusable logic that decides when to buy
                    and when to sell — conditions such as{" "}
                    <em>{EXAMPLE_CONDITION}</em>, and the event that fires them.
                    Start with <strong>New strategy</strong> above.
                  </p>
                }
              />
            }
          />
        ) : null}

        {status === "ready" && builtIn.length > 0 ? (
          <CollectionSection
            title="Built-in strategies"
            caption="FactorSage's own logic. Everyone can read and backtest it; only FactorSage changes it."
            label="Built-in strategies"
            noun="strategies"
            testId="built-in-strategies"
            tableTestId="built-in-strategies-grid"
            rowTestId="strategy-row"
            footerTestId="built-in-strategies-footer"
            columns={columns}
            rows={builtIn}
            getRowKey={(strategy) => strategy.id}
            searchText={(strategy) => strategy.name}
            clickableRows
          />
        ) : null}
      </div>

      {gate.prompt}

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

      {dialog.kind === "duplicate" ? (
        <DuplicateDialog
          thing="strategy"
          sourceName={dialog.strategy.name}
          maxNameLength={STRATEGY_NAME_MAX_LENGTH}
          onClose={closeDialog}
          onDuplicate={async (name) => {
            const copy = await duplicateStrategy(dialog.strategy.id, { name });
            closeDialog();
            // Straight into the Builder for the copy.
            router.push(`/strategies/${copy.id}`);
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

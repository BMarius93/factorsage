"use client";

import type { StrategySummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import forms from "../../../components/ui/forms.module.css";
import { deleteStrategy } from "../api/strategies-api";
import { useStrategies } from "../hooks/use-strategies";
import { formatStrategyDate, strategyShapeLabel } from "../utils/format";
import styles from "./StrategiesPage.module.css";
import { StrategyRenameDialog } from "./StrategyRenameDialog";

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

  return (
    <PageContainer>
      <div className={styles.page} data-testid="strategies-page">
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Strategies</h1>
            <p className={styles.lead}>
              Reusable buy, sell and final-exit logic for backtests and
              monitors.
            </p>
          </div>
          {status === "ready" && strategies.length > 0 ? (
            <Link
              className={styles.primaryLink}
              href="/strategies/new"
              data-testid="new-strategy-button"
            >
              New strategy
            </Link>
          ) : null}
        </header>

        {status === "loading" ? (
          <div className={styles.grid} aria-hidden="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className={styles.skeletonCard} />
            ))}
          </div>
        ) : null}

        {status === "error" ? (
          <div className={styles.statusPanel} role="alert">
            <h2 className={styles.statusTitle}>
              Your strategies could not be loaded
            </h2>
            <p className={styles.statusBody}>
              This is usually temporary — try again in a moment.
            </p>
            <button
              type="button"
              className={forms.secondaryButton}
              onClick={retry}
            >
              Try again
            </button>
          </div>
        ) : null}

        {status === "ready" && strategies.length === 0 ? (
          <div className={styles.statusPanel} data-testid="strategies-empty">
            <h2 className={styles.statusTitle}>No strategies yet</h2>
            <p className={styles.statusBody}>
              A strategy is the reusable logic that decides when to buy and when
              to sell — conditions such as <em>Price is above EMA 200D</em>, and
              the event that fires them.
            </p>
            <Link
              className={styles.primaryLink}
              href="/strategies/new"
              data-testid="new-strategy-button"
            >
              Create your first strategy
            </Link>
          </div>
        ) : null}

        {status === "ready" && strategies.length > 0 ? (
          <ul className={styles.grid} data-testid="strategies-grid">
            {strategies.map((strategy) => (
              <li key={strategy.id} className={styles.card}>
                <Link
                  className={styles.cardLink}
                  href={`/strategies/${strategy.id}`}
                >
                  <span className={styles.cardName}>{strategy.name}</span>
                  {strategy.description ? (
                    <span className={styles.cardDescription}>
                      {strategy.description}
                    </span>
                  ) : null}
                  <span className={styles.cardMeta}>
                    <span className={styles.cardShape}>
                      {strategyShapeLabel(strategy)}
                    </span>
                    <span>
                      Updated {formatStrategyDate(strategy.updatedAt)}
                    </span>
                  </span>
                </Link>
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.cardAction}
                    onClick={() => setDialog({ kind: "rename", strategy })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className={styles.cardActionDanger}
                    onClick={() => setDialog({ kind: "delete", strategy })}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
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

"use client";

import type { StockListSummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { deleteStockList } from "../api/stock-lists-api";
import { useStockLists } from "../hooks/use-stock-lists";
import { formatListDate, stockCountLabel } from "../utils/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { ListFormDialog } from "./ListFormDialog";
import forms from "./lists-forms.module.css";
import styles from "./ListsPage.module.css";

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "rename"; list: StockListSummaryResponse }
  | { kind: "delete"; list: StockListSummaryResponse };

/**
 * The signed-in user's stock lists: reusable universes for future strategies, backtests, and
 * monitors. Rendering needs only list metadata — never stock data hydration.
 */
export function ListsPage() {
  const router = useRouter();
  const { status, lists, retry, applyCreated, applyUpdated, applyDeleted } =
    useStockLists();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });

  return (
    <PageContainer>
      <div className={styles.page} data-testid="lists-page">
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>Lists</h1>
            <p className={styles.lead}>
              Reusable stock universes for strategies, backtests, and monitors.
            </p>
          </div>
          {status === "ready" && lists.length > 0 ? (
            <button
              type="button"
              className={forms.primaryButton}
              data-testid="new-list-button"
              onClick={() => setDialog({ kind: "create" })}
            >
              New list
            </button>
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
            <h2 className={styles.statusTitle}>Your lists could not be loaded</h2>
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

        {status === "ready" && lists.length === 0 ? (
          <div className={styles.statusPanel} data-testid="lists-empty">
            <h2 className={styles.statusTitle}>No lists yet</h2>
            <p className={styles.statusBody}>
              Group the stocks you care about into a named list, then restrict
              per-stock buy windows whenever a universe needs them.
            </p>
            <button
              type="button"
              className={forms.primaryButton}
              data-testid="new-list-button"
              onClick={() => setDialog({ kind: "create" })}
            >
              Create your first list
            </button>
          </div>
        ) : null}

        {status === "ready" && lists.length > 0 ? (
          <ul className={styles.grid} data-testid="lists-grid">
            {lists.map((list) => (
              <li key={list.id} className={styles.card}>
                <Link className={styles.cardLink} href={`/lists/${list.id}`}>
                  <span className={styles.cardName}>{list.name}</span>
                  {list.description ? (
                    <span className={styles.cardDescription}>
                      {list.description}
                    </span>
                  ) : null}
                  <span className={styles.cardMeta}>
                    <span className={styles.cardCount}>
                      {stockCountLabel(list.itemCount)}
                    </span>
                    <span>Updated {formatListDate(list.updatedAt)}</span>
                  </span>
                </Link>
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    className={styles.cardAction}
                    onClick={() => setDialog({ kind: "rename", list })}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className={styles.cardActionDanger}
                    onClick={() => setDialog({ kind: "delete", list })}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {dialog.kind === "create" ? (
        <ListFormDialog
          mode="create"
          onClose={closeDialog}
          onCreated={(detail) => {
            applyCreated(detail);
            closeDialog();
            router.push(`/lists/${detail.id}`);
          }}
        />
      ) : null}

      {dialog.kind === "rename" ? (
        <ListFormDialog
          mode="rename"
          list={dialog.list}
          onClose={closeDialog}
          onUpdated={(summary) => {
            applyUpdated(summary);
            closeDialog();
          }}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <ConfirmDialog
          title="Delete list"
          body={
            <p className={styles.confirmBody}>
              Delete <strong>{dialog.list.name}</strong> and its buy-window
              configuration? This cannot be undone.
            </p>
          }
          confirmLabel="Delete list"
          pendingLabel="Deleting…"
          onClose={closeDialog}
          onConfirm={async () => {
            await deleteStockList(dialog.list.id);
            applyDeleted(dialog.list.id);
            closeDialog();
          }}
        />
      ) : null}
    </PageContainer>
  );
}

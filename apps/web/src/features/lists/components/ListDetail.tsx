"use client";

import type {
  StockListItemResponse,
  StockListSecurityResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import { ApiError } from "../../../lib/api/client";
import {
  addStockListItems,
  deleteStockList,
  removeStockListItem,
} from "../api/stock-lists-api";
import { useStockList } from "../hooks/use-stock-list";
import { buyWindowLabel } from "../utils/buy-windows";
import { stockCountLabel } from "../utils/format";
import { BuyWindowEditor } from "./BuyWindowEditor";
import { ConfirmDialog } from "./ConfirmDialog";
import { ListFormDialog } from "./ListFormDialog";
import forms from "./lists-forms.module.css";
import { SecurityMultiSelect } from "./SecurityMultiSelect";
import styles from "./ListDetail.module.css";

type ListDetailProps = {
  readonly listId: string;
};

type DialogState =
  | { kind: "closed" }
  | { kind: "rename" }
  | { kind: "delete-list" }
  | { kind: "remove-item"; item: StockListItemResponse }
  | { kind: "buy-windows"; item: StockListItemResponse };

/**
 * One list: identity, membership, and per-stock buy eligibility. Everything renders from list
 * data plus the local catalog identity of each member — deliberately no prices, fundamentals, or
 * other heavy stock hydration.
 */
export function ListDetail({ listId }: ListDetailProps) {
  const router = useRouter();
  const {
    status,
    detail,
    retry,
    applyDetail,
    applyItem,
    applyItemRemoved,
    applyMeta,
  } = useStockList(listId);
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });
  const [pendingAdd, setPendingAdd] = useState<StockListSecurityResponse[]>([]);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const memberIds = useMemo(
    () => new Set(detail?.items.map((item) => item.security.id) ?? []),
    [detail],
  );

  const closeDialog = () => setDialog({ kind: "closed" });

  if (status === "loading") {
    return (
      <PageContainer>
        <div className={styles.page} aria-hidden="true">
          <div className={styles.skeletonHeader} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} />
        </div>
      </PageContainer>
    );
  }

  if (status === "not-found") {
    return (
      <PageContainer>
        <div className={styles.statusPanel} data-testid="list-not-found">
          <h1 className={styles.statusTitle}>List not found</h1>
          <p className={styles.statusBody}>
            This list does not exist or belongs to a different account.
          </p>
          <Link className={forms.secondaryButton} href="/lists">
            Back to Lists
          </Link>
        </div>
      </PageContainer>
    );
  }

  if (status === "error" || !detail) {
    return (
      <PageContainer>
        <div className={styles.statusPanel} role="alert">
          <h1 className={styles.statusTitle}>Something went wrong</h1>
          <p className={styles.statusBody}>
            The list could not be loaded right now. This is usually temporary.
          </p>
          <button type="button" className={forms.secondaryButton} onClick={retry}>
            Try again
          </button>
        </div>
      </PageContainer>
    );
  }

  const submitAdd = async () => {
    if (pendingAdd.length === 0 || adding) {
      return;
    }
    setAdding(true);
    setAddError(null);
    try {
      const updated = await addStockListItems(detail.id, {
        securityIds: pendingAdd.map((entry) => entry.id),
      });
      applyDetail(updated);
      setPendingAdd([]);
    } catch (error) {
      setAddError(
        error instanceof ApiError && error.status === 400
          ? error.message
          : "The stocks could not be added right now. Try again in a moment.",
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <PageContainer>
      <div className={styles.page} data-testid="list-detail">
        <nav className={styles.breadcrumb}>
          <Link className={styles.backLink} href="/lists">
            ← Lists
          </Link>
        </nav>

        <header className={styles.header}>
          <div className={styles.identity}>
            <h1 className={styles.title}>{detail.name}</h1>
            {detail.description ? (
              <p className={styles.description}>{detail.description}</p>
            ) : null}
            <p className={styles.meta}>{stockCountLabel(detail.items.length)}</p>
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.headerAction}
              onClick={() => setDialog({ kind: "rename" })}
            >
              Edit
            </button>
            <button
              type="button"
              className={styles.headerActionDanger}
              data-testid="delete-list-button"
              onClick={() => setDialog({ kind: "delete-list" })}
            >
              Delete
            </button>
          </div>
        </header>

        <section className={styles.addSection} aria-label="Add stocks">
          <div className={styles.addControl}>
            <div className={styles.addSearch}>
              <SecurityMultiSelect
                selected={pendingAdd}
                onChange={(next) => {
                  setPendingAdd(next);
                  setAddError(null);
                }}
                excludedIds={memberIds}
                inputLabel="Search stocks to add to this list"
              />
            </div>
            <button
              type="button"
              className={forms.primaryButton}
              data-testid="add-stocks-button"
              disabled={pendingAdd.length === 0 || adding}
              onClick={submitAdd}
            >
              {adding
                ? "Adding…"
                : pendingAdd.length > 1
                  ? `Add ${pendingAdd.length} stocks`
                  : "Add to list"}
            </button>
          </div>
          {addError ? (
            <p className={forms.error} role="alert">
              {addError}
            </p>
          ) : null}
        </section>

        {detail.items.length === 0 ? (
          <div className={styles.statusPanel} data-testid="list-items-empty">
            <h2 className={styles.statusTitle}>No stocks yet</h2>
            <p className={styles.statusBody}>
              Search above to add supported stocks to this list.
            </p>
          </div>
        ) : (
          <ul className={styles.items} data-testid="list-items">
            {detail.items.map((item) => (
              <li key={item.id} className={styles.item}>
                <div className={styles.itemIdentity}>
                  <span className={styles.itemSymbol}>
                    {item.security.symbol}
                  </span>
                  <span className={styles.itemName}>{item.security.name}</span>
                  <span className={styles.itemExchange}>
                    {item.security.exchangeName ?? item.security.exchangeCode}
                  </span>
                </div>
                <span
                  className={styles.itemEligibility}
                  data-mode={item.buyWindowMode}
                >
                  {buyWindowLabel(item)}
                </span>
                <div className={styles.itemActions}>
                  <button
                    type="button"
                    className={styles.itemAction}
                    onClick={() => setDialog({ kind: "buy-windows", item })}
                  >
                    Buy windows
                  </button>
                  <button
                    type="button"
                    className={styles.itemActionDanger}
                    aria-label={`Remove ${item.security.symbol} from list`}
                    onClick={() => setDialog({ kind: "remove-item", item })}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {dialog.kind === "rename" ? (
        <ListFormDialog
          mode="rename"
          list={{
            id: detail.id,
            name: detail.name,
            ...(detail.description === undefined
              ? {}
              : { description: detail.description }),
          }}
          onClose={closeDialog}
          onUpdated={(summary) => {
            applyMeta(summary);
            closeDialog();
          }}
        />
      ) : null}

      {dialog.kind === "delete-list" ? (
        <ConfirmDialog
          title="Delete list"
          body={
            <p className={styles.confirmBody}>
              Delete <strong>{detail.name}</strong> and its buy-window
              configuration? This cannot be undone.
            </p>
          }
          confirmLabel="Delete list"
          pendingLabel="Deleting…"
          onClose={closeDialog}
          onConfirm={async () => {
            await deleteStockList(detail.id);
            router.push("/lists");
          }}
        />
      ) : null}

      {dialog.kind === "remove-item" ? (
        <ConfirmDialog
          title="Remove stock"
          body={
            <p className={styles.confirmBody}>
              Remove <strong>{dialog.item.security.symbol}</strong> and its buy
              windows from this list?
            </p>
          }
          confirmLabel="Remove stock"
          pendingLabel="Removing…"
          onClose={closeDialog}
          onConfirm={async () => {
            await removeStockListItem(detail.id, dialog.item.id);
            applyItemRemoved(dialog.item.id);
            closeDialog();
          }}
        />
      ) : null}

      {dialog.kind === "buy-windows" ? (
        <BuyWindowEditor
          listId={detail.id}
          item={dialog.item}
          onClose={closeDialog}
          onSaved={(item) => {
            applyItem(item);
            closeDialog();
          }}
        />
      ) : null}
    </PageContainer>
  );
}

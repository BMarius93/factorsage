"use client";

import type {
  StockListItemResponse,
  StockListSecurityResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import actionStyles from "../../../components/ui/actions.module.css";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import { OverflowMenu } from "../../../components/ui/OverflowMenu";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import { requestFailureMessage } from "../../../lib/api/entitlement-errors";
import {
  addStockListItems,
  deleteStockList,
  removeStockListItem,
} from "../api/stock-lists-api";
import { useStockList } from "../hooks/use-stock-list";
import { buyWindowLabel } from "../utils/buy-windows";
import { stockCountLabel } from "../utils/format";
import { BuyWindowEditor } from "./BuyWindowEditor";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ListFormDialog } from "./ListFormDialog";
import forms from "../../../components/ui/forms.module.css";
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
        <div className={styles.page}>
          <SectionCard ariaLabel="Loading list">
            <SkeletonList rows={5} />
          </SectionCard>
        </div>
      </PageContainer>
    );
  }

  if (status === "not-found") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <EmptyState
            as="h1"
            testId="list-not-found"
            title="List not found"
            body={
              <p>This list does not exist or belongs to a different account.</p>
            }
            actions={
              <Link className={forms.secondaryButton} href="/lists">
                Back to Lists
              </Link>
            }
          />
        </div>
      </PageContainer>
    );
  }

  if (status === "error" || !detail) {
    return (
      <PageContainer>
        <div className={styles.page}>
          <EmptyState
            as="h1"
            variant="error"
            title="Something went wrong"
            body={
              <p>
                The list could not be loaded right now. This is usually
                temporary.
              </p>
            }
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
        requestFailureMessage(
          error,
          "The stocks could not be added right now. Try again in a moment.",
        ),
      );
    } finally {
      setAdding(false);
    }
  };

  const columns: readonly DataTableColumn<StockListItemResponse>[] = [
    {
      key: "stock",
      header: "Stock",
      cardRole: "identity",
      render: (item) => (
        <StockIdentity
          symbol={item.security.symbol}
          name={item.security.name}
          href={`/stocks/${encodeURIComponent(item.security.symbol)}`}
        />
      ),
    },
    {
      key: "buy-window",
      header: "Buy window",
      cardRole: "status",
      nowrap: true,
      render: (item) => (
        <StatusBadge
          tone={item.buyWindowMode === "FULL" ? "neutral" : "active"}
          variant="outline"
          dataAttributes={{ "data-mode": item.buyWindowMode }}
        >
          {buyWindowLabel(item)}
        </StatusBadge>
      ),
    },
    {
      key: "exchange",
      header: "Exchange",
      nowrap: true,
      render: (item) =>
        item.security.exchangeName ?? item.security.exchangeCode,
    },
    {
      key: "actions",
      header: "Actions",
      cardRole: "actions",
      align: "right",
      nowrap: true,
      render: (item) => (
        <span className={actionStyles.group}>
          <button
            type="button"
            className={actionStyles.action}
            onClick={() => setDialog({ kind: "buy-windows", item })}
          >
            Buy windows
          </button>
          <OverflowMenu
            label={`${item.security.symbol} in this list`}
            items={[
              {
                label: "Remove from list",
                tone: "danger",
                onSelect: () => setDialog({ kind: "remove-item", item }),
              },
            ]}
          />
        </span>
      ),
    },
  ];

  return (
    <PageContainer>
      <div className={styles.page} data-testid="list-detail">
        <PageHeader
          back={{ href: "/lists", label: "Lists" }}
          title={detail.name}
          {...(detail.description ? { lead: detail.description } : {})}
          badges={
            <>
              <StatusBadge tone="neutral">
                {stockCountLabel(detail.items.length)}
              </StatusBadge>
              {detail.compliance.compliant ? null : (
                <StatusBadge
                  tone="warning"
                  title={
                    detail.compliance.symbolLimit === null
                      ? "This list exceeds your plan's symbol limit."
                      : `This list holds ${detail.compliance.symbolCount} stocks; your plan allows ${detail.compliance.symbolLimit}. Existing stocks stay readable, but new ones cannot be added.`
                  }
                >
                  Over plan limit
                </StatusBadge>
              )}
            </>
          }
          actions={
            <>
              <button
                type="button"
                className={forms.tintedButton}
                onClick={() => setDialog({ kind: "rename" })}
              >
                Edit
              </button>
              <OverflowMenu
                label={detail.name}
                testId="list-detail-actions"
                items={[
                  {
                    label: "Delete list",
                    tone: "danger",
                    onSelect: () => setDialog({ kind: "delete-list" }),
                  },
                ]}
              />
            </>
          }
        />

        <SectionCard
          id="add-stocks"
          title="Add stocks"
          caption="Search the supported catalog and add one or more stocks to this list."
        >
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
            <p
              className={`${forms.error} ${styles.addError}`}
              role="alert"
              data-testid="list-add-error"
            >
              {addError}
            </p>
          ) : null}
        </SectionCard>

        <SectionCard
          id="list-members"
          title="Stocks"
          caption="Each stock's buy window decides the dates a strategy may open a position in it."
          flush={detail.items.length > 0}
        >
          <DataTable
            label={`Stocks in ${detail.name}`}
            testId="list-items"
            rowTestId="list-item"
            columns={columns}
            rows={detail.items}
            getRowKey={(item) => item.id}
            emptyState={
              <EmptyState
                variant="compact"
                testId="list-items-empty"
                title="No stocks yet"
                body={<p>Search above to add supported stocks to this list.</p>}
              />
            }
          />
        </SectionCard>
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

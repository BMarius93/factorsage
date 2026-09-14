"use client";

import type { StockListSummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import actions from "../../../components/ui/actions.module.css";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import { CollectionFooter } from "../../../components/ui/CollectionFooter";
import { EmptyState } from "../../../components/ui/EmptyState";
import { OverflowMenu } from "../../../components/ui/OverflowMenu";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { usePagination } from "../../../components/ui/use-pagination";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { deleteStockList } from "../api/stock-lists-api";
import { useStockLists } from "../hooks/use-stock-lists";
import { formatListDate, stockCountLabel } from "../utils/format";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ListFormDialog } from "./ListFormDialog";
import forms from "../../../components/ui/forms.module.css";
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

  // Compliance is derived on every read and is false only after a downgrade or an
  // over-limit import. Reserving a column of em dashes for the usual case would be noise,
  // so the column appears exactly when it has something to report.
  const anyOverLimit = lists.some((list) => !list.compliance.compliant);

  const allColumns: readonly DataTableColumn<StockListSummaryResponse>[] = [
    {
      key: "name",
      header: "Name",
      cardRole: "identity",
      render: (list) => (
        <Link className={styles.nameLink} href={`/lists/${list.id}`}>
          <span className={styles.name}>{list.name}</span>
          {list.description ? (
            <span className={styles.description}>{list.description}</span>
          ) : null}
        </Link>
      ),
    },
    {
      key: "compliance",
      header: "Status",
      cardRole: "status",
      render: (list) =>
        // A list over the plan's symbol limit stays fully readable — the flag is derived on
        // every read, so nothing here claims the list was changed or truncated.
        list.compliance.compliant ? null : (
          <StatusBadge
            tone="warning"
            title={
              list.compliance.symbolLimit === null
                ? "This list exceeds your plan's symbol limit."
                : `This list holds ${list.compliance.symbolCount} stocks; your plan allows ${list.compliance.symbolLimit}. Existing stocks stay readable, but new ones cannot be added.`
            }
          >
            Over plan limit
          </StatusBadge>
        ),
    },
    {
      key: "stocks",
      header: "Stocks",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (list) => stockCountLabel(list.itemCount),
    },
    {
      key: "updated",
      header: "Updated",
      nowrap: true,
      render: (list) => formatListDate(list.updatedAt),
    },
    {
      key: "actions",
      header: "Actions",
      cardRole: "actions",
      align: "right",
      nowrap: true,
      render: (list) => (
        <span className={actions.group}>
          <Link className={actions.action} href={`/lists/${list.id}`}>
            Open
          </Link>
          <OverflowMenu
            label={list.name}
            testId="list-actions"
            items={[
              {
                label: "Rename",
                onSelect: () => setDialog({ kind: "rename", list }),
              },
              {
                label: "Delete",
                tone: "danger",
                separated: true,
                onSelect: () => setDialog({ kind: "delete", list }),
              },
            ]}
          />
        </span>
      ),
    },
  ];
  const columns = allColumns.filter(
    (column) => column.key !== "compliance" || anyOverLimit,
  );
  const paging = usePagination(lists);

  return (
    <PageContainer>
      <div className={styles.page} data-testid="lists-page">
        <PageHeader
          title="Lists"
          lead="Reusable stock universes for strategies, backtests, and monitors."
          actions={
            status === "ready" && lists.length > 0 ? (
              <button
                type="button"
                className={forms.tintedButton}
                data-testid="new-list-button"
                onClick={() => setDialog({ kind: "create" })}
              >
                New list
              </button>
            ) : null
          }
        />

        {status === "loading" ? (
          <SectionCard ariaLabel="Loading lists">
            <SkeletonList rows={4} />
          </SectionCard>
        ) : null}

        {status === "error" ? (
          <EmptyState
            variant="error"
            title="Your lists could not be loaded"
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

        {status === "ready" && lists.length === 0 ? (
          <EmptyState
            testId="lists-empty"
            title="No lists yet"
            body={
              <p>
                Group the stocks you care about into a named list, then restrict
                per-stock buy windows whenever a universe needs them.
              </p>
            }
            actions={
              <button
                type="button"
                className={forms.primaryButton}
                data-testid="new-list-button"
                onClick={() => setDialog({ kind: "create" })}
              >
                Create your first list
              </button>
            }
          />
        ) : null}

        {status === "ready" && lists.length > 0 ? (
          <SectionCard ariaLabel="Stock lists" flush>
            <DataTable
              label="Stock lists"
              testId="lists-grid"
              rowTestId="list-row"
              columns={columns}
              rows={paging.visibleRows}
              getRowKey={(list) => list.id}
              clickableRows
            />
            <CollectionFooter
              testId="lists-footer"
              noun="lists"
              total={paging.total}
              page={paging.page}
              pageSize={paging.pageSize}
              onPageChange={paging.setPage}
              onPageSizeChange={paging.setPageSize}
            />
          </SectionCard>
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

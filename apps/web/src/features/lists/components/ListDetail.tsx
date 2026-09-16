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
import {
  FULL_HISTORY_LABEL,
  membershipSummary,
  PRESENT_LABEL,
} from "../utils/buy-windows";
import { formatMembershipDate, stockCountLabel } from "../utils/format";
import { MembershipEditor } from "./MembershipEditor";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { ListFormDialog } from "./ListFormDialog";
import forms from "../../../components/ui/forms.module.css";
import { SecurityMultiSelect } from "./SecurityMultiSelect";
import styles from "./ListDetail.module.css";

type ListDetailProps = {
  readonly listId: string;
};

/**
 * A member's membership, as it reads in a row: `Nov 30, 1982 → Present`.
 *
 * Secondary metadata by design — it must not compete with the ticker and company name beside it,
 * so it is plain text at the table's own weight rather than a badge.
 *
 * The arrow is decoration and is hidden from assistive technology, which reads "Nov 30, 1982 to
 * Present" instead. `Present` is a real word in the accessibility tree for the same reason it is
 * one on screen: an open-ended membership is a fact about the stock, not a missing value.
 *
 * A member with more than one stored period shows the first and says how many more there are,
 * with all of them in the tooltip — the V1 editor cannot create that state, but the API can, and a
 * cell that showed only the first period would imply an eligibility the stock never had.
 */
function MembershipCell({ item }: { readonly item: StockListItemResponse }) {
  const summary = membershipSummary(item);

  if (summary.leading === null) {
    return (
      <span
        className={styles.membership}
        data-testid="membership"
        data-mode={summary.mode}
        title={summary.title}
      >
        {FULL_HISTORY_LABEL}
      </span>
    );
  }

  return (
    <span
      className={styles.membership}
      data-testid="membership"
      data-mode={summary.mode}
      title={summary.title}
    >
      <span>{formatMembershipDate(summary.leading.startDate)}</span>
      <span className={styles.membershipArrow} aria-hidden="true">
        →
      </span>
      <span className={styles.srOnly}>to</span>
      <span>
        {summary.leading.endDate === null
          ? PRESENT_LABEL
          : formatMembershipDate(summary.leading.endDate)}
      </span>
      {summary.additionalCount > 0 ? (
        <span className={styles.membershipMore}>
          +{summary.additionalCount} more
        </span>
      ) : null}
    </span>
  );
}

type DialogState =
  | { kind: "closed" }
  | { kind: "rename" }
  | { kind: "delete-list" }
  | { kind: "remove-item"; item: StockListItemResponse }
  | { kind: "membership"; item: StockListItemResponse };

/**
 * One list: identity, membership, and each member's membership period. Everything renders from
 * list data plus the local catalog identity of each member — deliberately no prices, fundamentals,
 * or other heavy stock hydration.
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
          {...(item.security.logoUrl ? { logoUrl: item.security.logoUrl } : {})}
          href={`/stocks/${encodeURIComponent(item.security.symbol)}`}
        />
      ),
    },
    {
      key: "membership",
      header: "Membership",
      cardRole: "fact",
      nowrap: true,
      render: (item) => <MembershipCell item={item} />,
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
            onClick={() => setDialog({ kind: "membership", item })}
          >
            Membership
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
          caption="Each stock's membership decides the dates a strategy may open a new position in it. Selling is never restricted."
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
              Delete <strong>{detail.name}</strong> and every stock&apos;s
              membership configuration? This cannot be undone.
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
              Remove <strong>{dialog.item.security.symbol}</strong> and its
              membership periods from this list?
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

      {dialog.kind === "membership" ? (
        <MembershipEditor
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

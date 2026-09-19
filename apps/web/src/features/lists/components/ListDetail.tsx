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
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { LimitMeter } from "../../../components/ui/LimitMeter";
import {
  isEntitlementError,
  requestFailureMessage,
} from "../../../lib/api/entitlement-errors";
import {
  addStockListItems,
  deleteStockList,
  removeStockListItem,
} from "../api/stock-lists-api";
import { useStockList } from "../hooks/use-stock-list";
import {
  ALWAYS_ELIGIBLE_LABEL,
  membershipHeadline,
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
 * A member's membership, as it reads in a row: whether the stock is a member **today**, first
 * (UI-019) — "Member now · since Sep 19, 2025" — and every stored period one tap away.
 *
 * Periods are stored oldest first, so the row used to lead with the oldest period — for a stock
 * that left an index and rejoined, one that no longer applies — and hide the one in force in a
 * tooltip a phone cannot open. The headline is derived by meaning (`membershipSummary`), and the
 * full list is a native disclosure that works by touch and keyboard. Secondary metadata by design:
 * plain text at the row's own weight, never a badge.
 */
function MembershipCell({ item }: { readonly item: StockListItemResponse }) {
  const summary = membershipSummary(item);
  const headline = membershipHeadline(summary);

  if (summary.mode === "FULL" || summary.leading === null) {
    return (
      <span
        className={styles.membership}
        data-testid="membership"
        data-mode="FULL"
      >
        {ALWAYS_ELIGIBLE_LABEL}
      </span>
    );
  }

  return (
    <span
      className={styles.membership}
      data-testid="membership"
      data-mode={summary.mode}
      data-state={summary.state ?? undefined}
    >
      <span className={styles.membershipHeadline}>{headline}</span>
      <details className={styles.membershipPeriods}>
        <summary data-testid="membership-periods-toggle">
          {summary.periods.length}{" "}
          {summary.periods.length === 1 ? "period" : "periods"}
        </summary>
        <ul data-testid="membership-periods">
          {summary.periods.map((period) => (
            <li
              key={`${period.startDate}-${period.endDate ?? "open"}`}
              data-current={period === summary.leading ? "true" : undefined}
            >
              <span>{formatMembershipDate(period.startDate)}</span>
              <span className={styles.membershipArrow} aria-hidden="true">
                {" → "}
              </span>
              <span className={styles.srOnly}> to </span>
              <span>
                {period.endDate === null
                  ? PRESENT_LABEL
                  : formatMembershipDate(period.endDate)}
              </span>
            </li>
          ))}
        </ul>
      </details>
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
  const [addRefusedByPlan, setAddRefusedByPlan] = useState(false);

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
      setAddRefusedByPlan(isEntitlementError(error));
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

  // Built-in lists are readable by everyone and changeable by administrators only; the API decides
  // `canEdit` and enforces it again on every change.
  const editable = detail.canEdit;
  const builtIn = detail.ownership === "SYSTEM";

  const columns: DataTableColumn<StockListItemResponse>[] = [
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
      // Several lines on a phone card (headline and the period list), so it reads under its
      // label, left-aligned.
      stacked: true,
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
  ];
  if (editable) {
    columns.push({
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
            aria-label={`Membership for ${item.security.symbol}`}
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
    });
  }

  return (
    <PageContainer>
      <div className={styles.page} data-testid="list-detail">
        <PageHeader
          back={
            builtIn && !editable
              ? { href: "/dashboard", label: "Dashboard" }
              : { href: "/lists", label: "Lists" }
          }
          title={detail.name}
          {...(detail.description ? { lead: detail.description } : {})}
          badges={
            <>
              {builtIn ? (
                <StatusBadge
                  tone="neutral"
                  variant="outline"
                  testId="built-in-badge"
                >
                  Built-in
                </StatusBadge>
              ) : null}
              <StatusBadge tone="neutral">
                {stockCountLabel(detail.items.length)}
              </StatusBadge>
              {detail.compliance.compliant ? null : (
                <StatusBadge tone="warning" testId="list-over-limit-badge">
                  Over plan limit
                </StatusBadge>
              )}
            </>
          }
          actions={
            editable ? (
              <>
                <button
                  type="button"
                  className={forms.tintedButton}
                  onClick={() => setDialog({ kind: "rename" })}
                >
                  Edit
                </button>
                {builtIn ? null : (
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
                )}
              </>
            ) : undefined
          }
        />

        {detail.compliance.compliant ? null : (
          // The explanation lives on the page, not in a tooltip a phone cannot open (UI-021).
          <EntitlementNotice
            announce="status"
            testId="list-over-limit-notice"
            title="This list is over your plan's stock limit"
            message={
              detail.compliance.symbolLimit === null
                ? "This list exceeds your plan's stock limit. Existing stocks stay readable; new ones cannot be added."
                : `It holds ${detail.compliance.symbolCount} stocks and your plan allows ${detail.compliance.symbolLimit} per list. Existing stocks stay readable and can be removed; new ones cannot be added until it is within the limit.`
            }
          />
        )}

        {editable ? (
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
            {detail.compliance.symbolLimit !== null ? (
              // The plan's capacity for this list, before anything is added (UI-020). The limit is
              // the one the API derived for this viewer on this read.
              <div className={styles.addMeter}>
                <LimitMeter
                  label="Stocks in this list"
                  usage={detail.items.length}
                  limit={detail.compliance.symbolLimit}
                  unit={["stock", "stocks"]}
                  testId="list-symbol-meter"
                />
                {pendingAdd.length > 0 &&
                detail.items.length + pendingAdd.length >
                  detail.compliance.symbolLimit ? (
                  <p
                    className={styles.addWarning}
                    data-testid="list-add-over-limit"
                  >
                    Adding{" "}
                    {pendingAdd.length === 1
                      ? "this stock"
                      : `these ${pendingAdd.length} stocks`}{" "}
                    would make {detail.items.length + pendingAdd.length}; your
                    plan allows {detail.compliance.symbolLimit} per list.
                  </p>
                ) : null}
              </div>
            ) : null}
            {addError && addRefusedByPlan ? (
              <EntitlementNotice
                testId="list-add-error"
                message={addError}
                recovery={
                  <span className={styles.recoveryHint}>
                    Remove stocks from the selection or from the list.
                  </span>
                }
              />
            ) : addError ? (
              <p
                className={`${forms.error} ${styles.addError}`}
                role="alert"
                data-testid="list-add-error"
              >
                {addError}
              </p>
            ) : null}
          </SectionCard>
        ) : null}

        <SectionCard
          id="list-members"
          title="Stocks"
          caption={
            builtIn
              ? "A built-in list maintained by FactorSage. Each stock's membership decides the dates a strategy may open a new position in it; selling is never restricted."
              : "Each stock's membership decides the dates a strategy may open a new position in it. Selling is never restricted."
          }
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

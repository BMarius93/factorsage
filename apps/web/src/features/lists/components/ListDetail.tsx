"use client";

import type {
  StockListItemResponse,
  StockListSecurityResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import actionStyles from "../../../components/ui/actions.module.css";
import {
  DataTable,
  type DataTableColumn,
} from "../../../components/ui/DataTable";
import {
  useCollection,
  VisuallyHidden,
  type CollectionSort,
} from "../../../components/ui/Collection";
import {
  CollectionFooter,
  formatCount,
} from "../../../components/ui/CollectionFooter";
import { EmptyState } from "../../../components/ui/EmptyState";
import { OverflowMenu } from "../../../components/ui/OverflowMenu";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SelectControl } from "../../../components/ui/SelectControl";
import { DetailSkeleton } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { StockIdentity } from "../../../components/ui/StockIdentity";
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { RunBacktestLink } from "../../backtests/components/RunBacktestLink";
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
import { DeleteListDialog } from "./DeleteListDialog";
import { ListFormDialog } from "./ListFormDialog";
import forms from "../../../components/ui/forms.module.css";
import { SecurityMultiSelect } from "./SecurityMultiSelect";
import { BuiltInEditNotice } from "../../../components/ui/BuiltInEditNotice";
import { useDocumentTitle } from "../../../lib/use-document-title";
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
const NO_ITEMS: readonly StockListItemResponse[] = [];

/**
 * Which members a list shows, by membership today. `current` is every stock a strategy may buy
 * today — a stock eligible on every date, or one inside a membership period now; `former` is a
 * stock whose every period has ended. A stock whose first period has not started yet is in neither,
 * only in `all`.
 */
type MembershipFilter = "all" | "current" | "former";

const MEMBERSHIP_FILTER_OPTIONS = [
  { value: "all", label: "All members" },
  { value: "current", label: "Current members" },
  { value: "former", label: "Former members" },
] as const;

function matchesMembership(
  item: StockListItemResponse,
  filter: MembershipFilter,
): boolean {
  if (filter === "all") {
    return true;
  }
  const { mode, state } = membershipSummary(item);
  return filter === "current"
    ? mode === "FULL" || state === "CURRENT"
    : state === "ENDED";
}

/** How long a stock just added stays tinted. */
const ADDED_HIGHLIGHT_MS = 2_400;

const NO_KEYS: ReadonlySet<string> = new Set();

/** How a list's members can be read: the list's own order first, then alphabetically. */
const MEMBER_SORTS: readonly CollectionSort<StockListItemResponse>[] = [
  { id: "list", label: "List order" },
  {
    id: "symbol",
    label: "Ticker A–Z",
    compare: (a, b) => a.security.symbol.localeCompare(b.security.symbol),
  },
  {
    id: "name",
    label: "Company A–Z",
    compare: (a, b) =>
      a.security.name.localeCompare(b.security.name, "en", {
        sensitivity: "base",
      }),
  },
];

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
  useDocumentTitle(detail?.name);
  const [pendingAdd, setPendingAdd] = useState<StockListSecurityResponse[]>([]);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addRefusedByPlan, setAddRefusedByPlan] = useState(false);

  const [membership, setMembership] = useState<MembershipFilter>("all");
  // Stocks just added: shown on whatever page holds them, then tinted for a moment.
  const [addedFocus, setAddedFocus] = useState<readonly string[] | null>(null);
  const [highlighted, setHighlighted] = useState<ReadonlySet<string>>(NO_KEYS);
  const [announcement, setAnnouncement] = useState("");

  const items = detail?.items ?? NO_ITEMS;
  const memberIds = useMemo(
    () => new Set(items.map((item) => item.security.id)),
    [items],
  );
  // Membership has a "former" only where it is dated: a point-in-time universe, or a list whose
  // members carry their own periods. A list of always-eligible stocks offers no such filter.
  const dated = useMemo(
    () => items.some((item) => item.buyWindowMode !== "FULL"),
    [items],
  );
  const filter: MembershipFilter = dated ? membership : "all";
  const shownItems = useMemo(
    () => items.filter((item) => matchesMembership(item, filter)),
    [items, filter],
  );

  // Searchable by ticker or company, sortable, and paged — a point-in-time universe holds hundreds
  // of stocks. A stock just added is brought onto the page that holds it (below).
  const members = useCollection(shownItems, {
    noun: "stocks",
    testId: "list-items",
    searchText: (item) => `${item.security.symbol} ${item.security.name}`,
    sorts: MEMBER_SORTS,
    density: "compact",
    resetKey: filter,
    ...(dated
      ? {
          filters: (
            <SelectControl
              id="list-membership-filter"
              label="Show"
              value={filter}
              onChange={(value) => setMembership(value as MembershipFilter)}
              options={MEMBERSHIP_FILTER_OPTIONS}
              testId="list-membership-filter"
            />
          ),
        }
      : {}),
  });

  // After stocks are added, take the reader to them: a filter or a search that hides them gives way,
  // the page that holds the first of them in the current order opens, and they are tinted for a
  // moment. One step per render, because each step changes what the next one reads.
  useEffect(() => {
    if (addedFocus === null) {
      return;
    }
    const added = new Set(
      items
        .filter((item) => addedFocus.includes(item.security.id))
        .map((item) => item.id),
    );
    if (added.size === 0) {
      return;
    }
    if (filter !== "all" && !shownItems.some((item) => added.has(item.id))) {
      setMembership("all");
      return;
    }
    if (members.filtering && !members.rows.some((item) => added.has(item.id))) {
      members.clear();
      return;
    }
    const index = members.rows.findIndex((item) => added.has(item.id));
    if (index < 0) {
      return;
    }
    const page = Math.floor(index / members.paging.pageSize) + 1;
    if (members.paging.page !== page) {
      members.paging.setPage(page);
      return;
    }
    setHighlighted(added);
    setAddedFocus(null);
  }, [addedFocus, items, filter, shownItems, members]);

  // The tinted rows are scrolled into view once, then the tint is let go.
  useEffect(() => {
    if (highlighted.size === 0) {
      return;
    }
    const row = document.querySelector<HTMLElement>(
      '[data-testid="list-items"] [data-highlight="true"]',
    );
    const still = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    row?.scrollIntoView?.({
      block: "center",
      behavior: still ? "auto" : "smooth",
    });
    const timer = setTimeout(() => setHighlighted(NO_KEYS), ADDED_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlighted]);

  const closeDialog = () => setDialog({ kind: "closed" });

  if (status === "loading") {
    return (
      <PageContainer>
        <DetailSkeleton
          thing="list"
          back={{ href: "/lists", label: "Lists" }}
        />
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
              <p>It may have been deleted, or it belongs to another account.</p>
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
      setAddedFocus(pendingAdd.map((entry) => entry.id));
      setAnnouncement(
        pendingAdd.length === 1
          ? `${pendingAdd[0]?.symbol ?? "The stock"} added to the list.`
          : `${pendingAdd.length} stocks added to the list.`,
      );
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
          // The owning collection (UI-016), for a built-in too.
          back={{ href: "/lists", label: "Lists" }}
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
              {detail.universe ? (
                <StatusBadge
                  tone="neutral"
                  variant="outline"
                  testId="universe-badge"
                >
                  Point-in-time · up to{" "}
                  {detail.universe.peakSimultaneousMembers} at once
                </StatusBadge>
              ) : null}
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
                {/* The list's next step, the same on a built-in and on the owner's list (UI-008). */}
                <RunBacktestLink prefill={{ stockListId: detail.id }} />
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
            ) : (
              <RunBacktestLink prefill={{ stockListId: detail.id }} />
            )
          }
        />
        {builtIn && editable ? <BuiltInEditNotice thing="list" /> : null}
        {detail.universe ? (
          // Why this built-in cannot be edited, and what its membership means for a backtest.
          <p className={styles.universeNotice} data-testid="universe-notice">
            Membership is reconstructed from the index's historical changes
            since {formatMembershipDate(detail.universe.membershipFloor)} and
            maintained automatically: {detail.universe.currentMembers} current
            members and{" "}
            {detail.universe.distinctSecurities -
              detail.universe.currentMembers}{" "}
            former ones. A backtest buys each stock only while it was a member.
          </p>
        ) : null}

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
          density="compact"
          title="Stocks"
          caption={
            builtIn
              ? "A built-in list maintained by FactorSage. Each stock's membership decides the dates a strategy may open a new position in it; selling is never restricted."
              : "Each stock's membership decides the dates a strategy may open a new position in it. Selling is never restricted."
          }
          {...(detail.items.length > 0
            ? {
                count: (
                  <span data-testid="list-items-count">
                    {members.rows.length === detail.items.length
                      ? formatCount(detail.items.length)
                      : `${formatCount(members.rows.length)} of ${formatCount(detail.items.length)}`}
                    <VisuallyHidden> stocks</VisuallyHidden>
                  </span>
                ),
                toolbar: members.toolbar,
              }
            : {})}
          flush={
            detail.items.length > 0 &&
            shownItems.length > 0 &&
            members.filteredEmpty === null
          }
        >
          {/* What was just added, said once for assistive technology. */}
          <VisuallyHidden role="status">{announcement}</VisuallyHidden>
          {detail.items.length > 0 && shownItems.length === 0 ? (
            // Filtered to nothing by membership: the stocks exist, and the way back is one press.
            <EmptyState
              variant="compact"
              testId="list-items-membership-empty"
              title={
                filter === "former" ? "No former members" : "No current members"
              }
              actions={
                <button
                  type="button"
                  className={forms.secondaryButton}
                  onClick={() => setMembership("all")}
                >
                  Show all members
                </button>
              }
            />
          ) : (
            (members.filteredEmpty ?? (
              <>
                <DataTable
                  density="compact"
                  label={`Stocks in ${detail.name}`}
                  testId="list-items"
                  rowTestId="list-item"
                  columns={columns}
                  rows={members.paging.visibleRows}
                  getRowKey={(item) => item.id}
                  highlightedRowKeys={highlighted}
                  emptyState={
                    <EmptyState
                      variant="compact"
                      testId="list-items-empty"
                      title="No stocks yet"
                      body={
                        <p>
                          Search above to add supported stocks to this list.
                        </p>
                      }
                    />
                  }
                />
                <CollectionFooter
                  density="compact"
                  testId="list-items-footer"
                  noun="stocks"
                  total={members.paging.total}
                  page={members.paging.page}
                  pageSize={members.paging.pageSize}
                  onPageChange={members.paging.setPage}
                  onPageSizeChange={members.paging.setPageSize}
                />
              </>
            ))
          )}
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
        <DeleteListDialog
          name={detail.name}
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

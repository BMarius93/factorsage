"use client";

import {
  STOCK_LIST_NAME_MAX_LENGTH,
  type StockListSummaryResponse,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import {
  byName,
  byNewest,
  reversed,
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
import { EntitlementNotice } from "../../../components/ui/EntitlementNotice";
import { useSignInPrompt } from "../../auth/hooks/use-sign-in-prompt";
import {
  PremiumBadge,
  PremiumUpgradeHint,
  premiumPlansLabel,
} from "../../billing/components/PremiumContent";
import { deleteStockList, duplicateStockList } from "../api/stock-lists-api";
import { useStockLists } from "../hooks/use-stock-lists";
import { formatListDate, stockCountLabel } from "../utils/format";
import { DeleteListDialog } from "./DeleteListDialog";
import { HistoricalUniversesSection } from "./HistoricalUniversesSection";
import { ListFormDialog } from "./ListFormDialog";
import forms from "../../../components/ui/forms.module.css";
import styles from "./ListsPage.module.css";

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "rename"; list: StockListSummaryResponse }
  | { kind: "duplicate"; list: StockListSummaryResponse }
  | { kind: "delete"; list: StockListSummaryResponse };

const SIGN_IN_TO_CREATE = {
  title: "Sign in to create a list",
  body: "Built-in lists are free to read. Your own lists are saved to your account, so creating one needs somewhere to keep it.",
};

const SIGN_IN_TO_DUPLICATE = {
  title: "Sign in to duplicate a list",
  body: "Built-in lists are free to read. A copy is a list of your own that you can edit, so making one needs an account to keep it in.",
};

/**
 * Stock lists: the viewer's own reusable universes, and FactorSage's built-in ones.
 *
 * Two sections, never one mixed table — a customer's own content first, the platform's under it —
 * because they are owned differently and only one of them can be edited. A Guest is a legitimate
 * reader here (built-ins are public product content), so they get the built-in section and are
 * asked for an account at the point of action rather than redirected on arrival. Rendering needs
 * only list metadata — never stock data hydration.
 */
/**
 * What a downgrade means for the viewer's lists, said once, with a way forward (UI-021). A list
 * over its plan's stock limit stays whole and readable; it only stops accepting new stocks.
 */
function ListComplianceNotice({
  own,
}: {
  readonly own: readonly StockListSummaryResponse[];
}) {
  const over = own.filter((list) => !list.compliance.compliant);
  if (over.length === 0) {
    return null;
  }
  const limit = over[0]?.compliance.symbolLimit;
  return (
    <EntitlementNotice
      announce="status"
      testId="lists-compliance-notice"
      title={`${over.length} ${over.length === 1 ? "list is" : "lists are"} over your plan's stock limit`}
      message={`${limit === null || limit === undefined ? "Your plan" : `Your plan allows ${limit} stocks per list`}. Nothing was removed and every list stays readable, but a monitor watching one of these lists pauses and a backtest over it is refused until it is within the limit. Remove stocks to bring a list back within the limit.`}
    />
  );
}

/** Lists by their last change, the most recent first. */
const byUpdated = byNewest<StockListSummaryResponse>((list) => list.updatedAt);

/** Lists by size, the largest first; equal sizes keep the API's newest-first order. */
function bySize(a: StockListSummaryResponse, b: StockListSummaryResponse) {
  return b.itemCount - a.itemCount;
}

/**
 * The orders a customer's own lists can be read in; the API's newest-first comes first. The Name,
 * Stocks and Updated headers sort too, each both ways, so a header and the Sort control are one
 * order.
 */
const LIST_SORTS: readonly CollectionSort<StockListSummaryResponse>[] = [
  { id: "newest", label: "Newest" },
  {
    id: "updated",
    label: "Recently updated",
    column: "updated",
    direction: "desc",
    compare: byUpdated,
  },
  {
    id: "updated-oldest",
    label: "Least recently updated",
    column: "updated",
    direction: "asc",
    compare: reversed(byUpdated),
  },
  {
    id: "name",
    label: "Name A–Z",
    column: "name",
    direction: "asc",
    compare: byName,
  },
  {
    id: "name-desc",
    label: "Name Z–A",
    column: "name",
    direction: "desc",
    compare: reversed(byName),
  },
  {
    id: "size",
    label: "Most stocks",
    column: "stocks",
    direction: "desc",
    compare: bySize,
  },
  {
    id: "size-fewest",
    label: "Fewest stocks",
    column: "stocks",
    direction: "asc",
    compare: reversed(bySize),
  },
];

export function ListsPage() {
  const router = useRouter();
  const { status, lists, retry, applyCreated, applyUpdated, applyDeleted } =
    useStockLists();
  const gate = useSignInPrompt();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });
  const create = () =>
    gate.attempt(SIGN_IN_TO_CREATE, () => setDialog({ kind: "create" }));

  // `/lists?new=1` is the "Create a stock list" destination for other surfaces (a monitor with no
  // list to watch), so that link lands on the create dialog rather than on a page to search.
  // Read once, after the session resolves, and removed from the URL so a reload does not reopen it.
  //
  // `/lists?view=congress` is handled here too. It used to select the Congress groups view, which
  // left the product on 2026-10-11; a bookmark or an old link carrying it shows the stock lists,
  // and the dead parameter is dropped so the address says what the page is.
  const newRequestHandled = useRef(false);
  useEffect(() => {
    if (!gate.resolved || newRequestHandled.current) {
      return;
    }
    newRequestHandled.current = true;
    const query = new URLSearchParams(window.location.search);
    if (query.get("new") === "1") {
      router.replace("/lists");
      create();
    } else if (query.has("view")) {
      router.replace("/lists");
    }
  });

  const { own, builtIn: allBuiltIn } = partitionByOwnership(lists);
  // The historical universes are shown by category from the catalog; the rest of the built-ins
  // stay one collection.
  const builtIn = allBuiltIn.filter((list) => !list.universe);

  // Compliance is derived on every read and is false only after a downgrade or an
  // over-limit import. Reserving a column of em dashes for the usual case would be noise,
  // so the column appears exactly when it has something to report — and never for built-ins,
  // which are platform content that no plan limit applies to.
  const columnsFor = (
    scope: "own" | "built-in",
  ): readonly DataTableColumn<StockListSummaryResponse>[] => {
    const all: readonly DataTableColumn<StockListSummaryResponse>[] = [
      {
        key: "name",
        header: "Name",
        cardRole: "identity",
        render: (list) => (
          <>
            <Link className={styles.nameLink} href={`/lists/${list.id}`}>
              <span className={styles.nameRow}>
                <span className={styles.name}>{list.name}</span>
                {list.premium ? (
                  <PremiumBadge locked={list.locked === true} size="small" />
                ) : null}
              </span>
              {list.description ? (
                <span className={styles.description}>{list.description}</span>
              ) : null}
              {list.universe ? (
                <span
                  className={styles.description}
                  data-testid="list-universe"
                >
                  Point-in-time · {list.universe.distinctSecurities} stocks over
                  time, up to {list.universe.peakSimultaneousMembers} at once
                </span>
              ) : null}
            </Link>
            {/* A locked list is still named, with its size, for discovery; what it takes to use
                it is said under it. Outside the name link, which stays the row's first link. */}
            {list.locked ? <PremiumUpgradeHint /> : null}
          </>
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
            // The reason is text beside the badge, readable on a phone, not a tooltip (UI-021).
            <span className={styles.overLimit}>
              <StatusBadge
                tone="warning"
                size="small"
                testId="list-over-limit-badge"
              >
                Over plan limit
              </StatusBadge>
              {list.compliance.symbolLimit === null ? null : (
                <span className={styles.overLimitReason}>
                  {list.compliance.symbolCount} of {list.compliance.symbolLimit}{" "}
                  stocks allowed
                </span>
              )}
            </span>
          ),
      },
      {
        key: "stocks",
        width: "8rem",
        header: "Stocks",
        // On a phone the size and the last change share one line: "80 stocks … Oct 21, 2026".
        cardRole: "summary",
        align: "right",
        numeric: true,
        nowrap: true,
        render: (list) => stockCountLabel(list.itemCount),
      },
      {
        key: "updated",
        width: "9rem",
        header: "Updated",
        cardRole: "summary",
        nowrap: true,
        render: (list) => formatListDate(list.updatedAt),
      },
      {
        // The row itself opens the list (its name is the link), so the cell holds only the menu.
        key: "actions",
        width: "3.5rem",
        header: "Actions",
        cardRole: "menu",
        align: "right",
        nowrap: true,
        render: (list) => (
          <OverflowMenu
            label={list.name}
            testId="list-actions"
            items={[
              ...(list.canEdit
                ? [
                    {
                      label: "Rename",
                      onSelect: () => setDialog({ kind: "rename", list }),
                    },
                  ]
                : []),
              // Any list the viewer can read can be copied into one they own, a built-in
              // included; a Guest is asked for an account first. A locked premium list is not
              // read in full on this plan, so it cannot be copied either, and a maintained
              // historical universe is never copied: the API refuses it on every plan.
              ...(list.universe
                ? []
                : [
                    {
                      label: "Duplicate",
                      disabled: !gate.resolved || list.locked === true,
                      onSelect: () =>
                        gate.attempt(SIGN_IN_TO_DUPLICATE, () =>
                          setDialog({ kind: "duplicate", list }),
                        ),
                    },
                  ]),
              // Built-in lists are never deleted, not even by an administrator.
              ...(list.canEdit && list.ownership !== "SYSTEM"
                ? [
                    {
                      label: "Delete",
                      tone: "danger" as const,
                      separated: true,
                      onSelect: () => setDialog({ kind: "delete", list }),
                    },
                  ]
                : []),
            ]}
          />
        ),
      },
    ];
    const showCompliance =
      scope === "own" && own.some((list) => !list.compliance.compliant);
    return all.filter(
      (column) => column.key !== "compliance" || showCompliance,
    );
  };

  // "New list" lives in the header in every state — loading, empty, error, populated — so it
  // never moves or changes weight (UI-030). It waits only for the session to resolve, because a
  // Guest's click asks for an account instead.
  const headerAction = (
    <button
      type="button"
      className={forms.tintedButton}
      data-testid="new-list-button"
      disabled={!gate.resolved}
      onClick={create}
    >
      New list
    </button>
  );

  return (
    <PageContainer>
      <div className={styles.page} data-testid="lists-page">
        <PageHeader
          variant="plain"
          title="Lists"
          lead="Reusable stock universes for strategies, backtests, and monitors."
          actions={headerAction}
        />

        {status === "ready" && gate.signedIn ? (
          <ListComplianceNotice own={own} />
        ) : null}

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

        {status === "ready" && gate.signedIn ? (
          <CollectionSection
            density="compact"
            title="Your lists"
            label="Your lists"
            noun="lists"
            testId="your-lists"
            tableTestId="lists-grid"
            rowTestId="list-row"
            footerTestId="lists-footer"
            columns={columnsFor("own")}
            rows={own}
            getRowKey={(list) => list.id}
            searchText={(list) => list.name}
            sorts={LIST_SORTS}
            clickableRows
            emptyState={
              <EmptyState
                variant="compact"
                testId="lists-empty"
                title="You haven't created any lists yet"
                body={
                  <p>
                    Group the stocks you care about into a named list, then set
                    each stock&apos;s membership whenever a universe needs it.
                    Start with <strong>New list</strong> above.
                  </p>
                }
              />
            }
          />
        ) : null}

        {status === "ready" ? (
          <HistoricalUniversesSection lists={allBuiltIn} />
        ) : null}

        {status === "ready" && builtIn.length > 0 ? (
          <CollectionSection
            density="compact"
            title="Built-in lists"
            caption={
              // "Everyone can backtest them" stops being true of a premium list, so the caption
              // says which ones it covers once there is one.
              builtIn.some((list) => list.premium)
                ? `FactorSage's own universes, changed only by FactorSage. Everyone can read and backtest the standard ones; premium lists are included in ${premiumPlansLabel()}.`
                : "FactorSage's own universes. Everyone can read and backtest them; only FactorSage changes them."
            }
            label="Built-in lists"
            noun="lists"
            testId="built-in-lists"
            tableTestId="built-in-lists-grid"
            rowTestId="list-row"
            footerTestId="built-in-lists-footer"
            columns={columnsFor("built-in")}
            rows={builtIn}
            getRowKey={(list) => list.id}
            searchText={(list) => list.name}
            clickableRows
          />
        ) : null}
      </div>

      {gate.prompt}

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

      {dialog.kind === "duplicate" ? (
        <DuplicateDialog
          thing="list"
          sourceName={dialog.list.name}
          maxNameLength={STOCK_LIST_NAME_MAX_LENGTH}
          onClose={closeDialog}
          onDuplicate={async (name) => {
            const copy = await duplicateStockList(dialog.list.id, { name });
            applyCreated(copy);
            closeDialog();
            // Straight to the copy's own page, where it is edited.
            router.push(`/lists/${copy.id}`);
          }}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <DeleteListDialog
          name={dialog.list.name}
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

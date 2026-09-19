"use client";

import type { StockListSummaryResponse } from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import actions from "../../../components/ui/actions.module.css";
import type { DataTableColumn } from "../../../components/ui/DataTable";
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

const SIGN_IN_TO_CREATE = {
  title: "Sign in to create a list",
  body: "Built-in lists are free to read. Your own lists are saved to your account, so creating one needs somewhere to keep it.",
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

export function ListsPage() {
  const router = useRouter();
  const { status, lists, retry, applyCreated, applyUpdated, applyDeleted } =
    useStockLists();
  const gate = useSignInPrompt();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const closeDialog = () => setDialog({ kind: "closed" });
  const create = () =>
    gate.attempt(SIGN_IN_TO_CREATE, () => setDialog({ kind: "create" }));

  const { own, builtIn } = partitionByOwnership(lists);

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
          <Link className={styles.nameLink} href={`/lists/${list.id}`}>
            <span className={styles.name}>
              {list.name}
              {list.ownership === "SYSTEM" ? (
                <>
                  {" "}
                  <StatusBadge tone="neutral" variant="outline">
                    Built-in
                  </StatusBadge>
                </>
              ) : null}
            </span>
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
            // The reason is text beside the badge, readable on a phone, not a tooltip (UI-021).
            <span className={styles.overLimit}>
              <StatusBadge tone="warning" testId="list-over-limit-badge">
                Over plan limit
              </StatusBadge>
              {list.compliance.symbolLimit === null ? null : (
                <span className={styles.overLimitReason}>
                  {list.compliance.symbolCount} of{" "}
                  {list.compliance.symbolLimit} stocks allowed
                </span>
              )}
            </span>
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
            <Link
              className={actions.action}
              href={`/lists/${list.id}`}
              aria-label={`Open ${list.name}`}
            >
              Open
            </Link>
            {list.canEdit ? (
              <OverflowMenu
                label={list.name}
                testId="list-actions"
                items={[
                  {
                    label: "Rename",
                    onSelect: () => setDialog({ kind: "rename", list }),
                  },
                  // Built-in lists are never deleted, not even by an administrator.
                  ...(list.ownership === "SYSTEM"
                    ? []
                    : [
                        {
                          label: "Delete",
                          tone: "danger" as const,
                          separated: true,
                          onSelect: () => setDialog({ kind: "delete", list }),
                        },
                      ]),
                ]}
              />
            ) : null}
          </span>
        ),
      },
    ];
    const showCompliance =
      scope === "own" && own.some((list) => !list.compliance.compliant);
    return all.filter((column) => column.key !== "compliance" || showCompliance);
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
            clickableRows
            emptyState={
              <EmptyState
                variant="compact"
                testId="lists-empty"
                title="You haven't created any lists yet"
                body={
                  <p>
                    Group the stocks you care about into a named list, then
                    set each stock&apos;s membership whenever a universe needs
                    it. Start with <strong>New list</strong> above.
                  </p>
                }
              />
            }
          />
        ) : null}

        {status === "ready" && builtIn.length > 0 ? (
          <CollectionSection
            title="Built-in lists"
            caption="FactorSage's own universes. Everyone can read and backtest them; only FactorSage changes them."
            label="Built-in lists"
            noun="lists"
            testId="built-in-lists"
            tableTestId="built-in-lists-grid"
            rowTestId="list-row"
            footerTestId="built-in-lists-footer"
            columns={columnsFor("built-in")}
            rows={builtIn}
            getRowKey={(list) => list.id}
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

"use client";

import {
  ACTOR_GROUP_COLLECTION_LABELS,
  type ActorGroupSummaryResponse,
  type AlternativeActorType,
} from "@intrinsic/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import actions from "../../../components/ui/actions.module.css";
import { byName, byNewest, type CollectionSort } from "../../../components/ui/Collection";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import type { DataTableColumn } from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import forms from "../../../components/ui/forms.module.css";
import { OverflowMenu } from "../../../components/ui/OverflowMenu";
import {
  CollectionSection,
  partitionByOwnership,
} from "../../../components/ui/OwnedCollection";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { useSignInPrompt } from "../../auth/hooks/use-sign-in-prompt";
import { formatListDate } from "../../lists/utils/format";
import { deleteActorGroup } from "../api/alternative-data-api";
import { useActorGroups } from "../hooks/use-actor-groups";
import { ActorGroupFormDialog } from "./ActorGroupFormDialog";
import styles from "./ActorGroupsCollection.module.css";

/**
 * One kind of actor group as a collection, inside the Lists area.
 *
 * `docs/alternative-data-signals.md` puts Institution groups and Congress groups **under Lists**
 * rather than in a new top-level section, and this is that: the same `CollectionSection`, the same
 * own-then-built-in split, the same desktop table and phone cards a Stock List collection uses. What
 * differs is only what a row means.
 */

const GROUP_SORTS: readonly CollectionSort<ActorGroupSummaryResponse>[] = [
  { id: "newest", label: "Newest" },
  {
    id: "updated",
    label: "Recently updated",
    compare: byNewest((group) => group.updatedAt),
  },
  { id: "name", label: "Name A–Z", compare: byName },
  {
    id: "size",
    label: "Most members",
    compare: (a, b) => b.memberCount - a.memberCount,
  },
];

type DialogState =
  | { kind: "closed" }
  | { kind: "create" }
  | { kind: "rename"; group: ActorGroupSummaryResponse }
  | { kind: "delete"; group: ActorGroupSummaryResponse };

function memberCountLabel(count: number): string {
  return `${count} ${count === 1 ? "member" : "members"}`;
}

export function ActorGroupsCollection({
  actorType,
}: {
  readonly actorType: AlternativeActorType;
}) {
  const router = useRouter();
  const { status, groups, retry, applyCreated, applyUpdated, applyDeleted } =
    useActorGroups(actorType);
  const gate = useSignInPrompt();
  const [dialog, setDialog] = useState<DialogState>({ kind: "closed" });

  const noun = actorType === "INSTITUTION" ? "institution" : "congress";
  const collectionLabel = ACTOR_GROUP_COLLECTION_LABELS[actorType];
  const closeDialog = () => setDialog({ kind: "closed" });
  const create = () =>
    gate.attempt(
      {
        title: `Sign in to create a ${noun} group`,
        body: "A group is saved to your account, so creating one needs somewhere to keep it.",
      },
      () => setDialog({ kind: "create" }),
    );

  const { own, builtIn } = partitionByOwnership(groups);

  const columns: readonly DataTableColumn<ActorGroupSummaryResponse>[] = [
    {
      key: "name",
      header: "Name",
      cardRole: "identity",
      render: (group) => (
        <Link
          className={styles.nameLink}
          href={`/lists/actor-groups/${group.id}`}
        >
          <span className={styles.name}>{group.name}</span>
          {group.description ? (
            <span className={styles.description}>{group.description}</span>
          ) : null}
        </Link>
      ),
    },
    {
      key: "members",
      width: "9rem",
      header: "Members",
      align: "right",
      numeric: true,
      nowrap: true,
      render: (group) => memberCountLabel(group.memberCount),
    },
    {
      key: "updated",
      width: "9rem",
      header: "Updated",
      nowrap: true,
      render: (group) => formatListDate(group.updatedAt),
    },
    {
      key: "actions",
      width: "9rem",
      header: "Actions",
      cardRole: "actions",
      align: "right",
      nowrap: true,
      render: (group) => (
        <span className={actions.group}>
          <Link
            className={actions.action}
            href={`/lists/actor-groups/${group.id}`}
            aria-label={`Open ${group.name}`}
          >
            Open
          </Link>
          <OverflowMenu
            label={group.name}
            testId="actor-group-actions"
            items={[
              ...(group.canEdit
                ? [
                    {
                      label: "Rename",
                      onSelect: () => setDialog({ kind: "rename", group }),
                    },
                  ]
                : []),
              // Built-in groups are never deleted, not even by an administrator.
              ...(group.canEdit && group.ownership !== "SYSTEM"
                ? [
                    {
                      label: "Delete",
                      tone: "danger" as const,
                      separated: true,
                      onSelect: () => setDialog({ kind: "delete", group }),
                    },
                  ]
                : []),
            ]}
          />
        </span>
      ),
    },
  ];

  return (
    <div className={styles.collection} data-testid={`${noun}-groups`}>
      <div className={styles.header}>
        <p className={styles.lead}>
          {actorType === "INSTITUTION"
            ? "Reusable sets of institutional filers, for scoping an institutional rule in a strategy."
            : "Reusable sets of members of Congress, for scoping a congressional rule in a strategy."}
        </p>
        <button
          type="button"
          className={forms.tintedButton}
          data-testid={`new-${noun}-group-button`}
          disabled={!gate.resolved}
          onClick={create}
        >
          New group
        </button>
      </div>

      {status === "loading" ? (
        <SectionCard ariaLabel={`Loading ${collectionLabel.toLowerCase()}`}>
          <SkeletonList rows={3} />
        </SectionCard>
      ) : null}

      {status === "error" ? (
        <EmptyState
          variant="error"
          title={`Your ${collectionLabel.toLowerCase()} could not be loaded`}
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
          title={`Your ${collectionLabel.toLowerCase()}`}
          label={`Your ${collectionLabel.toLowerCase()}`}
          noun="groups"
          testId={`your-${noun}-groups`}
          tableTestId={`${noun}-groups-grid`}
          rowTestId="actor-group-row"
          footerTestId={`${noun}-groups-footer`}
          columns={columns}
          rows={own}
          getRowKey={(group) => group.id}
          searchText={(group) => group.name}
          sorts={GROUP_SORTS}
          clickableRows
          emptyState={
            <EmptyState
              variant="compact"
              testId={`${noun}-groups-empty`}
              title={`You haven't created any ${collectionLabel.toLowerCase()} yet`}
              body={
                <p>
                  Group the{" "}
                  {actorType === "INSTITUTION"
                    ? "institutional filers"
                    : "members of Congress"}{" "}
                  you care about, then scope a strategy rule to the group instead
                  of to everyone. Start with <strong>New group</strong> above.
                </p>
              }
            />
          }
        />
      ) : null}

      {status === "ready" && builtIn.length > 0 ? (
        <CollectionSection
          title={`Built-in ${collectionLabel.toLowerCase()}`}
          caption="FactorSage's own groups. Everyone can read and use them; only FactorSage changes them."
          label={`Built-in ${collectionLabel.toLowerCase()}`}
          noun="groups"
          testId={`built-in-${noun}-groups`}
          tableTestId={`built-in-${noun}-groups-grid`}
          rowTestId="actor-group-row"
          footerTestId={`built-in-${noun}-groups-footer`}
          columns={columns}
          rows={builtIn}
          getRowKey={(group) => group.id}
          searchText={(group) => group.name}
          clickableRows
        />
      ) : null}

      {gate.prompt}

      {dialog.kind === "create" ? (
        <ActorGroupFormDialog
          mode="create"
          actorType={actorType}
          onClose={closeDialog}
          onCreated={(detail) => {
            applyCreated(detail);
            closeDialog();
            router.push(`/lists/actor-groups/${detail.id}`);
          }}
        />
      ) : null}

      {dialog.kind === "rename" ? (
        <ActorGroupFormDialog
          mode="rename"
          group={dialog.group}
          onClose={closeDialog}
          onUpdated={(summary) => {
            applyUpdated(summary);
            closeDialog();
          }}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <ConfirmDialog
          title="Delete group"
          confirmLabel="Delete group"
          pendingLabel="Deleting…"
          body={
            <p>
              Delete <strong>{dialog.group.name}</strong> and its{" "}
              {memberCountLabel(dialog.group.memberCount)}? The actors
              themselves are not affected. This cannot be undone.
            </p>
          }
          onClose={closeDialog}
          // `ConfirmDialog` shows the API's own 409 text, which is what names the strategy still
          // referencing the group — far more useful than a generic failure.
          onConfirm={async () => {
            await deleteActorGroup(dialog.group.id);
            applyDeleted(dialog.group.id);
            closeDialog();
          }}
        />
      ) : null}
    </div>
  );
}

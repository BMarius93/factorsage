"use client";

import {
  ACTOR_GROUP_MAX_MEMBERS,
  type ActorGroupDetailResponse,
  type AlternativeDataActorResponse,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageContainer } from "../../../components/layout/PageContainer";
import actions from "../../../components/ui/actions.module.css";
import { ConfirmDialog } from "../../../components/ui/ConfirmDialog";
import { DataTable, type DataTableColumn } from "../../../components/ui/DataTable";
import { EmptyState } from "../../../components/ui/EmptyState";
import forms from "../../../components/ui/forms.module.css";
import { PageHeader } from "../../../components/ui/PageHeader";
import { SectionCard } from "../../../components/ui/SectionCard";
import { SkeletonList } from "../../../components/ui/Skeleton";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { useDocumentTitle } from "../../../lib/use-document-title";
import {
  addActorGroupMembers,
  fetchActorGroup,
  removeActorGroupMember,
} from "../api/alternative-data-api";
import { ActorCombobox, actorMetaLabel } from "./ActorCombobox";
import styles from "./ActorGroupDetail.module.css";

/**
 * One actor group: its identity and its membership.
 *
 * It is the group counterpart of `ListDetail`, and deliberately shaped like it — a header, a
 * membership editor, and the desktop table / phone cards `DataTable` renders from one column set. A
 * group the viewer may read but not change (a built-in) simply has no editor and no row actions.
 */
export function ActorGroupDetail({ groupId }: { readonly groupId: string }) {
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [group, setGroup] = useState<ActorGroupDetailResponse | null>(null);
  const [pending, setPending] = useState<AlternativeDataActorResponse[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] =
    useState<AlternativeDataActorResponse | null>(null);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);

  useDocumentTitle(group?.name ?? "Group");

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    const controller = new AbortController();
    setStatus("loading");
    fetchActorGroup(groupId, { signal: controller.signal })
      .then((detail) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setGroup(detail);
        setStatus("ready");
      })
      .catch(() => {
        if (
          requestId !== latestRequestRef.current ||
          controller.signal.aborted
        ) {
          return;
        }
        setStatus("error");
      });
    return () => controller.abort();
  }, [attempt, groupId]);

  const addMembers = useCallback(async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // The API answers with the complete updated group, which is what the page renders: a browser
      // copy of membership would be a second source of truth that can disagree with the server's.
      const detail = await addActorGroupMembers(groupId, {
        actorIds: pending.map((actor) => actor.id),
      });
      setGroup(detail);
      setPending([]);
    } catch {
      setError("Those members could not be added. Try again in a moment.");
    } finally {
      setSaving(false);
    }
  }, [groupId, pending]);

  if (status === "loading") {
    return (
      <PageContainer>
        <div className={styles.page}>
          <SectionCard ariaLabel="Loading group">
            <SkeletonList rows={4} />
          </SectionCard>
        </div>
      </PageContainer>
    );
  }

  if (status === "error" || !group) {
    return (
      <PageContainer>
        <div className={styles.page}>
          <EmptyState
            variant="error"
            testId="actor-group-error"
            title="This group could not be loaded"
            body={
              <p>
                It may have been deleted, or the request did not reach the
                server.
              </p>
            }
            actions={
              <button
                type="button"
                className={forms.secondaryButton}
                onClick={() => setAttempt((current) => current + 1)}
              >
                Try again
              </button>
            }
          />
        </div>
      </PageContainer>
    );
  }

  const memberIds = new Set(group.members.map((member) => member.id));
  const full = group.members.length >= ACTOR_GROUP_MAX_MEMBERS;

  const columns: readonly DataTableColumn<AlternativeDataActorResponse>[] = [
    {
      key: "name",
      header: "Name",
      cardRole: "identity",
      render: (actor) => (
        <span className={styles.memberName}>{actor.displayName}</span>
      ),
    },
    {
      key: "identity",
      header: "Seat",
      nowrap: true,
      render: (actor) => (
        <span className={styles.memberMeta}>{actorMetaLabel(actor)}</span>
      ),
    },
    ...(group.canEdit
      ? [
          {
            key: "actions",
            width: "7rem",
            header: "Actions",
            cardRole: "actions" as const,
            align: "right" as const,
            nowrap: true,
            render: (actor: AlternativeDataActorResponse) => (
              <span className={actions.group}>
                <button
                  type="button"
                  className={actions.action}
                  data-testid="remove-member"
                  aria-label={`Remove ${actor.displayName}`}
                  onClick={() => setRemoving(actor)}
                >
                  Remove
                </button>
              </span>
            ),
          },
        ]
      : []),
  ];

  return (
    <PageContainer>
      <div className={styles.page} data-testid="actor-group-detail">
        <PageHeader
          back={{ href: "/lists", label: "Lists" }}
          title={group.name}
          {...(group.description ? { lead: group.description } : {})}
          badges={
            group.ownership === "SYSTEM" ? (
              <StatusBadge
                tone="neutral"
                variant="outline"
                testId="built-in-badge"
              >
                Built-in
              </StatusBadge>
            ) : undefined
          }
        />

        {group.canEdit ? (
          <SectionCard
            title="Add members"
            caption="Search the catalog and pick the actors this group holds."
          >
            <div className={styles.editor}>
              <ActorCombobox
                mode="multi"
                selected={pending}
                onChange={setPending}
                excludedIds={memberIds}
                label="Search members of Congress to add"
                testId="actor-group-add"
              />
              <p className={styles.editorHint}>
                {full
                  ? `This group holds the maximum of ${ACTOR_GROUP_MAX_MEMBERS} actors.`
                  : `A group holds up to ${ACTOR_GROUP_MAX_MEMBERS} actors. Membership is explicit — nothing is inferred from a committee or a ranking.`}
              </p>
              {error ? (
                <p className={forms.error} role="alert">
                  {error}
                </p>
              ) : null}
              <div className={forms.actions}>
                <button
                  type="button"
                  className={forms.primaryButton}
                  data-testid="add-members"
                  disabled={saving || pending.length === 0 || full}
                  onClick={() => void addMembers()}
                >
                  {pending.length === 0
                    ? "Add to group"
                    : `Add ${pending.length} to group`}
                </button>
              </div>
            </div>
          </SectionCard>
        ) : null}

        <SectionCard
          title="Members"
          caption={`${group.members.length} ${group.members.length === 1 ? "actor" : "actors"} in this group.`}
          flush={group.members.length > 0}
        >
          {group.members.length === 0 ? (
            <EmptyState
              variant="compact"
              testId="actor-group-empty"
              title="This group is empty"
              body={
                <p>
                  A rule scoped to an empty group counts nothing — which is a
                  real reading, not an error. Add actors above to give it
                  meaning.
                </p>
              }
            />
          ) : (
            <DataTable
              label="Members"
              testId="actor-group-members-grid"
              rowTestId="actor-group-member-row"
              columns={columns}
              rows={group.members}
              getRowKey={(actor) => actor.id}
            />
          )}
        </SectionCard>
      </div>

      {removing ? (
        <ConfirmDialog
          title="Remove member"
          confirmLabel="Remove"
          pendingLabel="Removing…"
          body={
            <p>
              Remove <strong>{removing.displayName}</strong> from{" "}
              <strong>{group.name}</strong>? Every strategy scoped to this group
              stops counting them. Backtests that already exist are unaffected —
              they froze the membership they ran with.
            </p>
          }
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await removeActorGroupMember(group.id, removing.id);
            setGroup({
              ...group,
              members: group.members.filter(
                (member) => member.id !== removing.id,
              ),
              memberCount: group.memberCount - 1,
            });
            setRemoving(null);
          }}
        />
      ) : null}
    </PageContainer>
  );
}

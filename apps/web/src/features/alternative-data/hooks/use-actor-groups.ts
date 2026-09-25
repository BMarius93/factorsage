"use client";

import type {
  ActorGroupDetailResponse,
  ActorGroupSummaryResponse,
  AlternativeActorType,
} from "@intrinsic/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchActorGroups } from "../api/alternative-data-api";

export type ActorGroupsStatus = "loading" | "ready" | "error";

export type ActorGroupsState = {
  readonly status: ActorGroupsStatus;
  readonly groups: readonly ActorGroupSummaryResponse[];
  readonly retry: () => void;
  readonly applyCreated: (detail: ActorGroupDetailResponse) => void;
  readonly applyUpdated: (summary: ActorGroupSummaryResponse) => void;
  readonly applyDeleted: (groupId: string) => void;
};

/** The summary shape `GET /actor-groups` would report for a freshly created group. */
export function actorGroupSummaryOf(
  detail: ActorGroupDetailResponse,
): ActorGroupSummaryResponse {
  return {
    ownership: detail.ownership,
    ...(detail.systemKey === undefined ? {} : { systemKey: detail.systemKey }),
    canEdit: detail.canEdit,
    id: detail.id,
    actorType: detail.actorType,
    name: detail.name,
    ...(detail.description === undefined
      ? {}
      : { description: detail.description }),
    memberCount: detail.members.length,
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

/**
 * Loads the viewer's actor groups of one kind and keeps them in sync with local mutations.
 *
 * It mirrors `useStockLists` exactly, including never refetching blindly after a write: the API's own
 * response is what the collection applies.
 */
export function useActorGroups(
  actorType: AlternativeActorType,
): ActorGroupsState {
  const [status, setStatus] = useState<ActorGroupsStatus>("loading");
  const [groups, setGroups] = useState<readonly ActorGroupSummaryResponse[]>([]);
  const [attempt, setAttempt] = useState(0);
  const latestRequestRef = useRef(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    setStatus("loading");
    const controller = new AbortController();

    fetchActorGroups({ actorType }, { signal: controller.signal })
      .then((result) => {
        if (requestId !== latestRequestRef.current) {
          return;
        }
        setGroups(result);
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
  }, [actorType, attempt]);

  const applyCreated = useCallback((detail: ActorGroupDetailResponse) => {
    setGroups((current) => [actorGroupSummaryOf(detail), ...current]);
  }, []);

  const applyUpdated = useCallback((summary: ActorGroupSummaryResponse) => {
    setGroups((current) =>
      current.map((entry) => (entry.id === summary.id ? summary : entry)),
    );
  }, []);

  const applyDeleted = useCallback((groupId: string) => {
    setGroups((current) => current.filter((entry) => entry.id !== groupId));
  }, []);

  return { status, groups, retry, applyCreated, applyUpdated, applyDeleted };
}

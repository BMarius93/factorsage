import type {
  ActorGroupDetailResponse,
  ActorGroupSummaryResponse,
  AddActorGroupMembersRequest,
  AlternativeDataActorResponse,
  CreateActorGroupRequest,
  UpdateActorGroupRequest,
} from "@intrinsic/contracts";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from "../../../lib/api/client";

/** The canonical actor catalog, for the searchable pickers. */
export function searchActors(
  input: { term?: string; limit?: number } = {},
  options: { signal?: AbortSignal } = {},
) {
  const query = new URLSearchParams();
  if (input.term) {
    query.set("q", input.term);
  }
  if (input.limit !== undefined) {
    query.set("limit", String(input.limit));
  }
  return apiGet<AlternativeDataActorResponse[]>(
    `/alternative-data/actors?${query.toString()}`,
    options,
  );
}

/**
 * Labels the actors a saved strategy references.
 *
 * Separate from search because the question is different: a saved scope names an id, and looking it
 * up by name would be guessing. An unknown id is simply absent from the answer.
 */
export function resolveActors(
  actorIds: readonly string[],
  options: { signal?: AbortSignal } = {},
) {
  if (actorIds.length === 0) {
    return Promise.resolve([] as AlternativeDataActorResponse[]);
  }
  const query = new URLSearchParams({ ids: actorIds.join(",") });
  return apiGet<AlternativeDataActorResponse[]>(
    `/alternative-data/actors/resolve?${query.toString()}`,
    options,
  );
}

export function fetchActorGroups(options: { signal?: AbortSignal } = {}) {
  return apiGet<ActorGroupSummaryResponse[]>("/actor-groups", options);
}

export function fetchActorGroup(
  groupId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<ActorGroupDetailResponse>(`/actor-groups/${groupId}`, options);
}

export async function createActorGroup(
  input: CreateActorGroupRequest,
): Promise<ActorGroupDetailResponse> {
  return (await apiPost<ActorGroupDetailResponse>(
    "/actor-groups",
    input,
  )) as ActorGroupDetailResponse;
}

export async function updateActorGroup(
  groupId: string,
  patch: UpdateActorGroupRequest,
): Promise<ActorGroupSummaryResponse> {
  return (await apiPatch<ActorGroupSummaryResponse>(
    `/actor-groups/${groupId}`,
    patch,
  )) as ActorGroupSummaryResponse;
}

export async function deleteActorGroup(groupId: string): Promise<void> {
  await apiDelete(`/actor-groups/${groupId}`);
}

/** Idempotent batch add; the API answers with the complete updated group. */
export async function addActorGroupMembers(
  groupId: string,
  input: AddActorGroupMembersRequest,
): Promise<ActorGroupDetailResponse> {
  return (await apiPost<ActorGroupDetailResponse>(
    `/actor-groups/${groupId}/members`,
    input,
  )) as ActorGroupDetailResponse;
}

export async function removeActorGroupMember(
  groupId: string,
  actorId: string,
): Promise<void> {
  await apiDelete(`/actor-groups/${groupId}/members/${actorId}`);
}

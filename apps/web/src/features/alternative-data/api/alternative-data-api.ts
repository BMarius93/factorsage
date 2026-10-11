import {
  ACTOR_RESOLVE_MAX_IDS,
  type ActorCatalogStatusResponse,
  type ActorGroupDetailResponse,
  type ActorGroupSummaryResponse,
  type AlternativeDataActorResponse,
} from "@intrinsic/contracts";
import { apiGet } from "../../../lib/api/client";

/** The canonical actor catalog, for the searchable picker. */
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
 * Whether the catalog has been filled from the provider's member directory.
 *
 * Asked so an empty search can be worded truthfully: nobody matches, or the member may simply not
 * be in the catalog yet. It reads one stored row; it never causes a provider request.
 */
export function fetchActorCatalogStatus(
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<ActorCatalogStatusResponse>(
    "/alternative-data/actors/catalog",
    options,
  );
}

/**
 * Labels the members a saved rule selects.
 *
 * Separate from search because the question is different: a saved scope names ids, and looking them
 * up by name would be guessing. An unknown id is simply absent from the answer, which is also how a
 * caller learns that a member it holds is no longer in the catalog.
 *
 * The ids travel in the query string and one request may name `ACTOR_RESOLVE_MAX_IDS` of them, so a
 * larger set — a rule can select two hundred and fifty members — is asked for in batches and the
 * answers are joined. The batches are independent, so they are requested together.
 */
export async function resolveActors(
  actorIds: readonly string[],
  options: { signal?: AbortSignal } = {},
): Promise<AlternativeDataActorResponse[]> {
  const unique = [...new Set(actorIds)];
  if (unique.length === 0) {
    return [];
  }
  const batches: string[][] = [];
  for (let index = 0; index < unique.length; index += ACTOR_RESOLVE_MAX_IDS) {
    batches.push(unique.slice(index, index + ACTOR_RESOLVE_MAX_IDS));
  }
  const answers = await Promise.all(
    batches.map((batch) =>
      apiGet<AlternativeDataActorResponse[]>(
        `/alternative-data/actors/resolve?${new URLSearchParams({ ids: batch.join(",") }).toString()}`,
        options,
      ),
    ),
  );
  return answers.flat();
}

/**
 * The Congress groups a viewer can read.
 *
 * Groups left the product on 2026-10-11 and nothing creates or edits one from here any more. The
 * two reads remain for strategies saved before then: this one names the group a legacy rule still
 * references, and {@link fetchActorGroup} supplies its members so the rule can be converted to a
 * selection in one step.
 */
export function fetchActorGroups(options: { signal?: AbortSignal } = {}) {
  return apiGet<ActorGroupSummaryResponse[]>("/actor-groups", options);
}

export function fetchActorGroup(
  groupId: string,
  options: { signal?: AbortSignal } = {},
) {
  return apiGet<ActorGroupDetailResponse>(`/actor-groups/${groupId}`, options);
}

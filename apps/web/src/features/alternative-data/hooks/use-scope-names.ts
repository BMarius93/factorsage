"use client";

import {
  collectActorGroupIds,
  collectActorIds,
  collectAlternativeDataMetrics,
  type StrategyDefinition,
  type StrategyScopeNames,
} from "@intrinsic/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  fetchActorGroups,
  resolveActors,
} from "../api/alternative-data-api";

/**
 * Resolves the display names behind the actor and group ids a strategy definition references.
 *
 * The stored rule names an **id**, because that is the identity; the name is presentation and is
 * resolved here. Two consequences that are the whole point:
 *
 * - A renamed group or member reads correctly everywhere the next time it is loaded, without touching
 *   a single saved strategy.
 * - A name that cannot be resolved — the reference has gone, or the request failed — simply stays
 *   unresolved, and every surface falls back to a neutral `Selected group`. Nothing invents a label.
 *
 * It re-requests only when the **set of referenced ids** changes, not on every keystroke in the
 * builder: the ids are joined into a stable key, so editing a threshold does not refetch anything.
 */
export function useStrategyScopeNames(
  definition: StrategyDefinition,
): StrategyScopeNames {
  const { actorIds, groupIds } = useMemo(() => {
    const metrics = collectAlternativeDataMetrics(definition);
    return {
      actorIds: collectActorIds(metrics),
      groupIds: collectActorGroupIds(metrics),
    };
  }, [definition]);
  const actorKey = actorIds.join(",");
  const groupKey = groupIds.join(",");

  const [names, setNames] = useState<StrategyScopeNames>({});

  useEffect(() => {
    if (actorKey === "" && groupKey === "") {
      setNames({});
      return;
    }
    const controller = new AbortController();
    const wantedActors = actorKey === "" ? [] : actorKey.split(",");
    const wantedGroups = groupKey === "" ? [] : groupKey.split(",");
    Promise.all([
      wantedActors.length === 0
        ? Promise.resolve([])
        : resolveActors(wantedActors, { signal: controller.signal }),
      // Groups are fetched as the viewer's whole collection rather than by id: there is no by-id batch
      // route, the collection is small, and it is the same request the configuration dialog makes — so
      // the two share a browser cache entry instead of issuing two shapes of request.
      wantedGroups.length === 0
        ? Promise.resolve([])
        : fetchActorGroups({ signal: controller.signal }),
    ])
      .then(([actors, groups]) => {
        const resolved: StrategyScopeNames = {};
        if (actors.length > 0) {
          resolved.actors = Object.fromEntries(
            actors.map((actor) => [actor.id, actor.displayName]),
          );
        }
        const referenced = groups.filter((group) =>
          wantedGroups.includes(group.id),
        );
        if (referenced.length > 0) {
          resolved.groups = Object.fromEntries(
            referenced.map((group) => [group.id, group.name]),
          );
        }
        setNames(resolved);
      })
      // Left unresolved on purpose: the neutral fallback is honest, and a banner for a label would be
      // out of all proportion to what failed.
      .catch(() => undefined);
    return () => controller.abort();
  }, [actorKey, groupKey]);

  return names;
}

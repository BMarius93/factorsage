/**
 * The canonical documents of the Strategy and the List a backtest **actually executed**, read from
 * its immutable snapshot (`AGENTS.md` invariant 12) — never from the current, mutable rows.
 *
 * Everything the documents need is frozen in the snapshot: the definition as submitted, the actors
 * its rules select and the membership of any legacy group (with their bioguide ids and names), and
 * the List's resolved securities with their symbols, exchanges and canonical buy windows as of
 * submission. A point-in-time universe's frozen membership is pinned by digest rather than copied.
 */

import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import { CanonicalDefinitionError } from "./issues.js";
import { serializeList, type ListMemberInput } from "./list-codec.js";
import {
  serializeStrategy,
  type StrategyActorIdentity,
} from "./strategy-codec.js";
import type {
  CanonicalListDocument,
  CanonicalProvenance,
  CanonicalStrategyDocument,
} from "./types.js";

/** The run's Strategy, as it executed. Its name is the one frozen at submission. */
export function serializeSnapshotStrategy(
  snapshot: BacktestRunSnapshot,
  provenance: CanonicalProvenance,
): CanonicalStrategyDocument {
  const actors = new Map<string, StrategyActorIdentity>();
  for (const actor of snapshot.actors ?? []) {
    actors.set(actor.actorId, {
      externalId: actor.externalId,
      displayName: actor.displayName,
    });
  }
  const actorGroups = new Map<string, readonly string[]>();
  for (const group of snapshot.actorGroups ?? []) {
    actorGroups.set(
      group.groupId,
      group.members.map((member) => member.actorId),
    );
    for (const member of group.members) {
      if (!actors.has(member.actorId)) {
        actors.set(member.actorId, {
          externalId: member.externalId,
          displayName: member.displayName,
        });
      }
    }
  }
  return serializeStrategy({
    metadata: { name: snapshot.strategy.name },
    provenance,
    definition: snapshot.strategy.definition,
    actors,
    actorGroups,
  });
}

/** The members a snapshot froze, with each security named portably. */
export function snapshotListMembers(
  snapshot: BacktestRunSnapshot,
): ListMemberInput[] {
  return snapshot.securities.map((security) => ({
    security: { symbol: security.symbol, exchange: security.exchangeCode },
    buyWindow: {
      mode: security.buyWindowMode,
      ranges: security.buyWindows.map((window) => ({
        startDate: window.startDate,
        endDate: window.endDate,
      })),
    },
  }));
}

/**
 * The run's List, as it executed: its frozen members, or — for a point-in-time universe — a pinned
 * reference to the exact membership the run froze for its period. The pin is checked against the
 * snapshot's own record of the universe, so a snapshot whose frozen windows disagree with what it
 * says it executed is refused rather than described.
 */
export function serializeSnapshotList(
  snapshot: BacktestRunSnapshot,
  provenance: CanonicalProvenance,
): CanonicalListDocument {
  const members = snapshotListMembers(snapshot);
  const universe = snapshot.stockList.universe;
  if (!universe) {
    return serializeList({
      metadata: { name: snapshot.stockList.name },
      provenance,
      membership: { kind: "members", members },
    });
  }
  const document = serializeList({
    metadata: { name: snapshot.stockList.name },
    provenance,
    membership: {
      kind: "point_in_time_index",
      index: universe.indexKey,
      period: {
        startDate: snapshot.period.startDate,
        endDate: snapshot.period.endDate,
      },
      members,
    },
  });
  const membership = document.definition.membership;
  if (
    membership.kind !== "point_in_time_index" ||
    membership.membership.peakSimultaneousMembers !==
      universe.peakSimultaneousMembers
  ) {
    throw new CanonicalDefinitionError([
      {
        code: "INDEX_MEMBERSHIP_MISMATCH",
        path: "definition.membership.membership.peakSimultaneousMembers",
        message:
          "The run's frozen membership does not match the universe size it recorded.",
      },
    ]);
  }
  return document;
}

/**
 * Supplies a pinned point-in-time membership from the snapshot that froze it: what
 * `deserializeList` asks for to reconstruct a shared run's universe. The codec checks the digest.
 */
export function snapshotIndexMembershipResolver(
  snapshot: BacktestRunSnapshot,
): () => readonly ListMemberInput[] | undefined {
  return () =>
    snapshot.stockList.universe ? snapshotListMembers(snapshot) : undefined;
}

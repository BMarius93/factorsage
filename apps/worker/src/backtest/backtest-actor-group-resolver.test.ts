import type { BacktestRunSnapshot } from "@intrinsic/contracts";
import { describe, expect, it } from "vitest";
import { frozenActorGroupResolver } from "./backtest-processor.js";

/**
 * The one function the actor-group freeze invariant rests on.
 *
 * `AGENTS.md` invariant 23: "A Strategy referencing an actor group has that group's membership frozen
 * into the backtest snapshot, so editing or deleting the group can never change a run that already
 * exists — the worker resolves a group scope from the snapshot and never from the database." The API
 * side of that is proved by `backtests.actor-groups.integration.test.ts`, which shows the snapshot and
 * its digest do not move when the group is edited, emptied, renamed or deleted.
 *
 * This is the other half, and it was untested: what the *worker* resolves when it executes. A
 * resolver that fell back to a database read would satisfy every snapshot assertion ever written and
 * still produce a run whose numbers moved when somebody edited a group.
 */

function snapshotWith(
  actorGroups: BacktestRunSnapshot["actorGroups"],
): BacktestRunSnapshot {
  // Only the field under test is meaningful; the resolver reads nothing else.
  return { actorGroups } as unknown as BacktestRunSnapshot;
}

describe("the worker's frozen actor-group resolver", () => {
  it("answers from the snapshot's own frozen membership", async () => {
    const resolve = frozenActorGroupResolver(
      snapshotWith([
        {
          groupId: "group-1",
          name: "Watchlist",
          members: [
            { actorId: "actor-a", externalId: "K000389", displayName: "A" },
            { actorId: "actor-b", externalId: "G000583", displayName: "B" },
          ],
        },
      ]),
    );

    // Member order is the group's own, frozen at submission: a projection that reordered members
    // would change nothing it computes, but a resolver that dropped one would.
    expect(await resolve("group-1")).toEqual(["actor-a", "actor-b"]);
  });

  it("resolves a group the snapshot does not carry to no members, never to a database read", async () => {
    // Counting nothing is the honest reading for a run whose strategy did not reference this group.
    // Falling back to a live read is what this test exists to forbid: it would make a completed run's
    // numbers a function of what somebody edited afterwards.
    const resolve = frozenActorGroupResolver(snapshotWith([]));
    expect(await resolve("group-1")).toEqual([]);
  });

  it("treats a snapshot with no actorGroups field at all as carrying no groups", async () => {
    // A run whose strategy references no group has no `actorGroups` field; upcasting one that
    // predates the field must not throw.
    const resolve = frozenActorGroupResolver(snapshotWith(undefined));
    expect(await resolve("anything")).toEqual([]);
  });

  it("keeps an empty frozen group empty, which counts nothing", async () => {
    const resolve = frozenActorGroupResolver(
      snapshotWith([{ groupId: "group-1", name: "Empty", members: [] }]),
    );
    expect(await resolve("group-1")).toEqual([]);
  });

  it("does not let one group's membership answer for another", async () => {
    const resolve = frozenActorGroupResolver(
      snapshotWith([
        {
          groupId: "group-1",
          name: "House",
          members: [{ actorId: "actor-a", externalId: "K000389", displayName: "A" }],
        },
        {
          groupId: "group-2",
          name: "Senate",
          members: [{ actorId: "actor-b", externalId: "W000802", displayName: "B" }],
        },
      ]),
    );
    expect(await resolve("group-1")).toEqual(["actor-a"]);
    expect(await resolve("group-2")).toEqual(["actor-b"]);
  });
});

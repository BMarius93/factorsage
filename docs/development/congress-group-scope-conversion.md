# Congress groups → direct member selection: compatibility, rollout and conversion

Since 2026-10-11 a Congressional Trading rule selects the members of Congress it counts itself.
Reusable Congress groups are gone from the product. `docs/alternative-data-signals.md` holds the
decision; this is the operator's runbook: what has to keep working for data saved before the change,
in what order to deploy, and how to convert the strategies that still name a group.

Nothing here is destructive. No table is dropped, no stored strategy version or backtest snapshot is
rewritten, and no conversion runs unless somebody runs it.

## 1. What changed, in one table

|                               | Before                                                                 | Now                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A rule narrowed to members    | `scope: { kind: "GROUP", groupId }` or `{ kind: "ACTOR", actorId }`    | `scope: { kind: "ACTORS", actorIds: [...] }`                                                                 |
| Where the members live        | In a group, edited on the Lists page                                   | In the rule, part of the strategy version                                                                    |
| Editing whose activity counts | Edit the group — every strategy naming it follows, with no new version | Edit the rule — a new strategy version                                                                       |
| What a backtest freezes       | The group's membership, in `snapshot.actorGroups`                      | The selection is already in the frozen definition; `snapshot.actors` adds each member's bioguide id and name |
| What a Monitor reads          | The group as it stands, every cycle                                    | The selection in the strategy's current version                                                              |

The evaluation is unchanged: the loader filters disclosures by a list of actor ids either way, and a
selection is pooled into one metric exactly as a group was.

## 2. What must keep working

Stored data still holds the two older scope shapes, and all of it is re-read through the canonical
validator, so the validator still accepts both.

| Stored thing                                                | Holds                                  | Guarantee                                                                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `StrategyVersion.definition`, any version                   | `GROUP`, `ACTOR` or `ACTORS`           | Readable through the API. `ACTOR` is returned as a one-entry `ACTORS`; its `definitionHash` and every Monitor latch keyed to it are unchanged. `GROUP` is returned as stored.                          |
| `BacktestRun.snapshot`, version 1                           | `GROUP` with `actorGroups`, or `ACTOR` | Readable; a queued or retried run executes. A group is resolved from the membership the snapshot froze. Trade reasons name the frozen group, or the member. Never rewritten; `snapshotHash` unchanged. |
| `BacktestRun.snapshot`, version 2                           | `ACTORS` with `actors`                 | Written only by this release onward.                                                                                                                                                                   |
| `Monitor` on a strategy whose current version names a group | —                                      | Evaluated as before, from the group as it stands.                                                                                                                                                      |
| `ActorGroup`, `ActorGroupMember`                            | —                                      | Kept. The routes are kept too: the Builder reads a legacy group's name and members through them.                                                                                                       |

What is refused: a strategy **write** holding a `GROUP` scope — on create and on edit, including a
group carried over unchanged from the version being edited. The message tells the user to open the
rule's configuration, where the group's members are already selected and one Apply converts the
rule.

A **duplicate** is not refused: the copy selects the members the group holds at that moment, and the
original is only read — same version, same hash, still naming its group. The copy is refused, with
the reason, only when the group cannot be resolved: it is gone, it is not the caller's, or it has no
members.

## 3. Deploy order

Deploy in this order. It does not assume the three tiers switch at the same moment; it assumes only
that each tier finishes before the next begins.

1. **Workers** — backtest and Monitor children.
2. **API** — every instance.
3. **Web.**

The reason is who can produce a selection and who can read one. Only the new web app writes an
`ACTORS` scope, so while it is last no such document exists until everything that must read one has
been upgraded. Every intermediate state is safe:

| State                         | What happens                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| New workers, old API, old web | Nothing new is written. New workers execute every old shape.                                              |
| New workers, new API, old web | The API can store a selection but nothing asks it to. Old-shape strategies and runs are served unchanged. |
| All new                       | Selections are written, frozen at snapshot version 2, and executed.                                       |

If the order is not followed, the failures are explicit, never a wrong result:

| Mix                                                          | What happens                                                                                                                                                               | Why it is not silent                                                                                                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Old backtest worker** claims a run holding a selection     | The run **fails** at the snapshot parse: `Unsupported backtest snapshot version 2`. The user re-runs it once workers are upgraded.                                         | An old worker would otherwise serialize the unknown scope as a group with no id, resolve it to nobody and complete the run with zero congressional activity. Writing such a run at version 2 is what makes it refuse instead. |
| **Old Monitor worker** meets a strategy holding a selection  | That Monitor is skipped for the cycle with `monitor.definition.invalid`; every other Monitor is evaluated. Its state is untouched and resumes when the worker is upgraded. | The old validator rejects the unknown scope kind.                                                                                                                                                                             |
| **Old API instance** serves a user who has saved a selection | That user's strategy list and the affected run fail with a server error on that instance.                                                                                  | Same validator. Transient: it ends when the instance is replaced.                                                                                                                                                             |

**The web deploy is the point of no return.** Once a selection has been saved, rolling the API or
the workers back to the previous release produces the right-hand column above for the strategies
that hold one. Roll forward instead.

A run that was `QUEUED` or `RUNNING` across the deploy needs nothing: it carries snapshot version 1
and the new worker executes it.

## 4. Converting strategies that still name a group

Not required for correctness — a group-scoped strategy keeps working — and never automatic. Convert
when you want the remaining strategies to stop depending on group rows, for instance before a later
cleanup removes them.

```bash
pnpm strategies:convert-group-scopes                      # dry run: reads, reports, writes nothing
pnpm strategies:convert-group-scopes --json               # the same report as one JSON document
pnpm strategies:convert-group-scopes --strategy <id>      # restrict to one strategy (repeatable)
```

The command targets `DATABASE_URL` and prints the **name** of the database it is connected to.

### What a conversion does

For each strategy whose **current** version names a group, it reads the group's members and appends
a new `StrategyVersion` in which that rule selects those members. Earlier versions are not touched —
same row, same document, same hash. Backtest runs are not read at all. The group is not modified.
A second run finds nothing left to convert.

### What it will not do

It never guesses. A strategy is **skipped**, named in the report and left exactly as it was when:

| Reason                  | Meaning                                                                                                                                 | What to do                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GROUP_MISSING`         | The group row no longer exists.                                                                                                         | The owner opens the rule and chooses its members.                                                                     |
| `GROUP_EMPTY`           | The group has no members. An empty selection is not a rule.                                                                             | Same.                                                                                                                 |
| `GROUP_INACCESSIBLE`    | The group is neither built-in nor owned by the strategy's owner — in practice a built-in strategy naming an administrator's own group.  | An administrator opens the built-in strategy and applies the rule's configuration, which selects the group's members. |
| `GROUP_TOO_LARGE`       | More members than one selection may hold (250). Cannot occur while the two bounds are equal.                                            | —                                                                                                                     |
| `CONVERSION_INVALID`    | Embedding the members would leave an invalid definition, e.g. two rules that become identical. `detail` carries the validator's reason. | The owner edits the strategy.                                                                                         |
| `DEFINITION_UNREADABLE` | The current version no longer passes the validator for an unrelated reason.                                                             | Fix that first.                                                                                                       |
| `MONITORED`             | Apply only: the strategy has a Monitor and `--include-monitored` was not given.                                                         | See below.                                                                                                            |

One strategy failing does not stop the run.

### Monitors

A Monitor keys its durable state to a fingerprint of each level's logic, and the scope is part of
it. Converting a strategy therefore changes the fingerprint of every level whose rule named the
group, and on its **next cycle** the worker resets exactly those levels:

- an `ACTIVE` level's open Signal is closed with reason `LOGIC_CHANGED`;
- a `PENDING_TRIGGER` setup is dropped;
- the level is then reconstructed from history under the same members, so a level whose conditions
  still hold is `ACTIVE` again in that same cycle, with a new Signal.

Levels whose rules did not name the group are untouched, as are other Monitors. The members are the
same, so nothing about what the Monitor matches changes — but users see a Signal close and a new one
open, and the Signal history records both.

The dry run counts this per Monitor before anything is written:

```text
monitor <id> "Hill watch" (USER, evaluated): 1 level(s) reset, 30 state row(s),
  4 active Signal(s) closed, 0 pending setup(s) dropped
```

So a strategy that has a Monitor is converted only when told to.

### Procedure

1. Run the dry run. Read the counts, every `SKIPPED` line and every `monitor` line.
2. Convert the strategies with no Monitor:

   ```bash
   pnpm strategies:convert-group-scopes --apply --confirm-database <database name>
   ```

   `--confirm-database` is required with `--apply` and must equal the name the dry run printed. A
   command pointed at the wrong environment stops there, having changed nothing.

3. For the strategies reported as `MONITORED`, decide when the one-time reset is acceptable — outside
   market hours keeps a closed-and-reopened Signal off the Dashboard during a session — then:

   ```bash
   pnpm strategies:convert-group-scopes --apply --include-monitored --confirm-database <database name>
   ```

   Optionally `pnpm monitors:scan-once` afterwards, so the reset and reconstruction happen now
   rather than on the next scheduled cycle.

4. Run the dry run again. It should report nothing convertible; what remains is the skipped list,
   which needs its owners.

The conversion writes strategy versions only. It writes no Monitor state: the reset is the worker's,
when it finds a level's fingerprint no longer matches the row.

### Rehearsing it

`intrinsic_value_matrix` holds one group-scoped fixture strategy (`A09`), so the dry run has
something to report there. The integration suite
`apps/api/src/alternative-data/group-scope-conversion.integration.test.ts` exercises every row of the
tables above against PostgreSQL.

## 5. The member catalog

Who a rule may select is its own subject and has its own runbook:
`docs/development/congress-member-catalog.md`. In short, the catalog is synchronized with the
provider's member directory — `pnpm data:congress-members:sync` — and no longer depends on which
securities' disclosures have been loaded. A conversion needs nothing from it: a group's members are
catalog rows already, and a conversion embeds their canonical ids.

## 6. Later cleanup, not part of this change

In this order, each only once the one before it is true:

1. No current strategy version names a group (section 4 reports nothing, and the skipped list is
   empty).
2. Remove the group mutation routes, then the read routes, the service and the submission-time
   freeze.
3. Drop `ActorGroup` and `ActorGroupMember` in their own migration, after a backup.

Never removable while a run snapshot holds one: the `GROUP` and `ACTOR` scope shapes in the
validator and the signature parser, `snapshot.actorGroups`, and the worker's frozen-group resolver.

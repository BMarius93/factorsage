# Built-in Dashboard signals

Implements the schema half of `docs/decisions/builtin-dashboard-signals-v1.md`.

**SYSTEM ownership.** `StockList`, `Strategy` and `Monitor` gain `ownership` (`USER | SYSTEM`), a
nullable `userId`, an immutable unique `systemKey`, an optional `displayOrder` and an
`updatedByUserId` audit column. CHECK constraints make the pairing an invariant: a USER row has an
owner and no key; a SYSTEM row has a key and no owner. Every existing row is `USER`, which the
defaults already say, so the constraints hold on deploy.

**Built-in Monitor switches.** `Monitor.isPublished` (customers can see it) and
`Monitor.isGloballyEnabled` (the worker evaluates it). Both default to true and are required to stay
true on a USER Monitor, whose `enabled` remains its only switch.
`UserBuiltInMonitorPreference` stores a customer's Dashboard-visibility override of a built-in
Monitor; absence means visible.

**Signal lifecycle.** `MonitorSignalState` gains `lifecycleState`
(`INACTIVE | PENDING_TRIGGER | ACTIVE | RESOLVED`), when/where/at what price that state was entered,
and `ruleStates`, the internal rule-local lifecycle a multi-rule FINAL EXIT needs.
`lastTriggerSignalDate` is dropped: its meaning moved into `ruleStates[*].triggerDate`.

Backfill: a state row pointing at an active Signal becomes `ACTIVE` since that Signal's activation
(its `observationDate` was the old trigger fire date, so nothing is lost); every other row becomes
`INACTIVE`. `ruleStates` starts empty and each rule inherits the level's state until the first
observation writes it. A pre-existing Conditions + Trigger row that was `INACTIVE` while its
Conditions hold becomes `PENDING_TRIGGER` on the next cycle and needs a fresh crossing — the new
semantics, applied from deploy.

`MonitorSignal` gains `signalFingerprint` (backfilled for active Signals), `resolvedObservationDate`,
`resolutionReason` and `reconstructed`. `detectedAt` and `observationDate` keep their names and are
the occurrence's activation instant and activation session.

**Transition history.** `MonitorStateTransition` records every lifecycle state change — never a
repeated scan — keyed by `(monitor, security, level)` with a nullable `signalId`, because a pending
setup exists before any Signal does.

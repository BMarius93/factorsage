import type { Prisma } from "@intrinsic/database";

/**
 * What a Monitor rebind does to its durable state, in the caller's transaction.
 *
 * The caller holds the Monitor row lock (`FOR UPDATE`) and changes the binding itself. This ends
 * every current lifecycle — recording each ending under the logic it belonged to, as an
 * administrative change — resolves every Signal still active, and discards the transition state and
 * every member's evaluation progress, so the new configuration is reconstructed from history rather
 * than caught up from the old one's checkpoints. Signal and transition history is kept.
 * `ai/product/monitors.md`, "Rebinding a Monitor".
 */
export async function crossMonitorConfigurationBoundary(
  tx: Prisma.TransactionClient,
  monitorId: string,
  now: Date,
): Promise<{ resolvedSignals: number; clearedStates: number }> {
  const current = await tx.monitorSignalState.findMany({
    where: {
      monitorId,
      lifecycleState: { in: ["ACTIVE", "PENDING_TRIGGER"] },
    },
    select: {
      securityId: true,
      levelId: true,
      levelKind: true,
      signalFingerprint: true,
      lifecycleState: true,
      activeSignalId: true,
    },
  });
  if (current.length > 0) {
    await tx.monitorStateTransition.createMany({
      data: current.map((state) => ({
        monitorId,
        securityId: state.securityId,
        levelId: state.levelId,
        levelKind: state.levelKind,
        signalFingerprint: state.signalFingerprint,
        fromState: state.lifecycleState,
        toState:
          state.lifecycleState === "ACTIVE"
            ? ("RESOLVED" as const)
            : ("INACTIVE" as const),
        reason: "MONITOR_REBOUND" as const,
        origin: "ADMINISTRATIVE" as const,
        occurredAt: now,
        signalId: state.activeSignalId,
      })),
    });
  }
  const resolvedSignals = (
    await tx.monitorSignal.updateMany({
      where: { monitorId, resolvedAt: null },
      data: { resolvedAt: now, resolutionReason: "MONITOR_REBOUND" },
    })
  ).count;
  const clearedStates = (
    await tx.monitorSignalState.deleteMany({ where: { monitorId } })
  ).count;
  await tx.monitorEvaluationCheckpoint.deleteMany({ where: { monitorId } });
  return { resolvedSignals, clearedStates };
}

/**
 * The Monitor-row fields a rebind changes, beside the binding itself: a new configuration
 * generation, no scan yet, and no initial replay — a rebound Monitor is reconstructed from history
 * at its newest session, never replayed (`docs/decisions/monitor-eod-v2.md` §5).
 */
export function reboundMonitorFields() {
  return {
    configVersion: { increment: 1 },
    lastScanAt: null,
    initialReplayRequested: false,
    replayWindowStart: null,
    replayWindowFixedAt: null,
  } as const;
}

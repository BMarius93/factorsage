import type { Prisma } from "@intrinsic/database";

/**
 * What a Monitor rebind does to its durable state, in the caller's transaction.
 *
 * The caller holds the Monitor row lock (`FOR UPDATE`) and changes the binding itself. This ends
 * every current lifecycle — recording each ending under the logic it belonged to — resolves every
 * Signal still active, and discards the transition state. Signal and transition history is kept.
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
  return { resolvedSignals, clearedStates };
}

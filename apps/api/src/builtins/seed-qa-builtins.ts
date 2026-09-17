import { strategySignalFingerprint } from "@intrinsic/contracts";
import type { PrismaClient } from "@intrinsic/database";
import { QA_SECURITIES } from "../stocks/seed-qa-securities";
import { bootstrapBuiltIns, type BuiltInCatalog } from "./builtin-bootstrap";
import { BUILT_IN_STRATEGIES } from "./builtin-catalog";

/**
 * Deterministic built-in content for the Playwright Dashboard suites.
 *
 * The real catalog needs real securities and real market data, which the deterministic E2E stack
 * never has. This one is built over the fictional QA securities with the canonical Trend
 * Confirmation logic, and its Monitor state is written directly — one security active under two
 * monitors, one setup waiting for its trigger — so the browser can be asserted against exact rows.
 * Its keys are namespaced `qa-builtin-`, and it only ever reaches `TEST_DATABASE_URL`.
 */
export const QA_BUILT_IN_KEYS = {
  listA: "qa-builtin-list-a",
  listB: "qa-builtin-list-b",
  strategy: "qa-builtin-trend",
  monitorA: "qa-builtin-monitor-a",
  monitorB: "qa-builtin-monitor-b",
} as const;

const [QA_ALPHA, QA_BETA] = QA_SECURITIES;

export const QA_BUILT_IN_CATALOG: BuiltInCatalog = {
  lists: [
    {
      systemKey: QA_BUILT_IN_KEYS.listA,
      name: "QA Built-in Leaders",
      description: "Deterministic built-in list for browser tests.",
      displayOrder: 101,
      members: [{ symbol: QA_ALPHA.symbol, eligibleFrom: null }],
    },
    {
      systemKey: QA_BUILT_IN_KEYS.listB,
      name: "QA Built-in Newcomers",
      description: "Deterministic built-in list for browser tests.",
      displayOrder: 102,
      members: [
        { symbol: QA_ALPHA.symbol, eligibleFrom: null },
        { symbol: QA_BETA.symbol, eligibleFrom: "2024-01-02" },
      ],
    },
  ],
  strategies: [
    {
      systemKey: QA_BUILT_IN_KEYS.strategy,
      name: "QA Built-in Trend",
      description: "The canonical Trend Confirmation logic, for browser tests.",
      displayOrder: 101,
      definition: BUILT_IN_STRATEGIES[1]!.definition,
    },
  ],
  monitors: [
    {
      systemKey: QA_BUILT_IN_KEYS.monitorA,
      name: "QA Built-in Monitor A",
      displayOrder: 101,
      listKey: QA_BUILT_IN_KEYS.listA,
      strategyKey: QA_BUILT_IN_KEYS.strategy,
    },
    {
      systemKey: QA_BUILT_IN_KEYS.monitorB,
      name: "QA Built-in Monitor B",
      displayOrder: 102,
      listKey: QA_BUILT_IN_KEYS.listB,
      strategyKey: QA_BUILT_IN_KEYS.strategy,
    },
  ],
};

export async function seedQaBuiltIns(prisma: PrismaClient): Promise<void> {
  await bootstrapBuiltIns(prisma, "reset", QA_BUILT_IN_CATALOG);
  const monitors = await prisma.monitor.findMany({
    where: {
      systemKey: { in: [QA_BUILT_IN_KEYS.monitorA, QA_BUILT_IN_KEYS.monitorB] },
    },
    select: { id: true, systemKey: true },
  });
  const monitorIds = monitors.map((monitor) => monitor.id);
  const byKey = new Map(
    monitors.map((monitor) => [monitor.systemKey, monitor.id]),
  );
  const securities = await prisma.security.findMany({
    where: {
      symbol: { in: [QA_ALPHA.symbol, QA_BETA.symbol] },
      exchangeCode: QA_ALPHA.exchangeCode,
    },
    select: { id: true, symbol: true },
  });
  const securityId = new Map(
    securities.map((security) => [security.symbol, security.id]),
  );
  const level = BUILT_IN_STRATEGIES[1]!.definition.buyLevels[0]!;
  const buyLevel = level.id;
  // The real logic fingerprint: a running worker treats any other value as state recorded under
  // different logic and resets it.
  const fingerprint = strategySignalFingerprint(level.signal);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    // A reconcile, not an append: every run leaves exactly the declared state and no preferences.
    await tx.monitorStateTransition.deleteMany({
      where: { monitorId: { in: monitorIds } },
    });
    await tx.monitorSignalState.deleteMany({
      where: { monitorId: { in: monitorIds } },
    });
    await tx.monitorSignal.deleteMany({
      where: { monitorId: { in: monitorIds } },
    });
    await tx.userBuiltInMonitorPreference.deleteMany({
      where: { monitorId: { in: monitorIds } },
    });
    await tx.monitor.updateMany({
      where: { id: { in: monitorIds } },
      data: { lastScanAt: now, isPublished: true, isGloballyEnabled: true },
    });

    const rows = [
      {
        monitor: QA_BUILT_IN_KEYS.monitorA,
        symbol: QA_ALPHA.symbol,
        state: "ACTIVE",
        date: "2026-09-10",
        price: 101.25,
      },
      {
        monitor: QA_BUILT_IN_KEYS.monitorB,
        symbol: QA_ALPHA.symbol,
        state: "ACTIVE",
        date: "2026-09-11",
        price: 102.5,
      },
      {
        monitor: QA_BUILT_IN_KEYS.monitorB,
        symbol: QA_BETA.symbol,
        state: "PENDING_TRIGGER",
        date: "2026-09-14",
        price: 48.75,
      },
    ] as const;
    for (const row of rows) {
      const day = new Date(`${row.date}T00:00:00.000Z`);
      const since = new Date(`${row.date}T15:00:00.000Z`);
      const monitorId = byKey.get(row.monitor)!;
      const security = securityId.get(row.symbol)!;
      const signal =
        row.state === "ACTIVE"
          ? await tx.monitorSignal.create({
              data: {
                monitorId,
                securityId: security,
                levelId: buyLevel,
                levelKind: "BUY",
                strategyVersionId: "qa-seed",
                signalFingerprint: fingerprint,
                hasTrigger: true,
                observationDate: day,
                observationPrice: row.price,
                detectedAt: since,
              },
            })
          : null;
      await tx.monitorSignalState.create({
        data: {
          monitorId,
          securityId: security,
          levelId: buyLevel,
          levelKind: "BUY",
          signalFingerprint: fingerprint,
          lastEvaluableResult: "NOT_MATCHED",
          lastEvaluableDate: day,
          lastEvaluableAt: since,
          lastOutcome: "NOT_MATCHED",
          lastOutcomeAt: since,
          lifecycleState: row.state,
          lifecycleSince: since,
          lifecycleSinceDate: day,
          lifecycleSincePrice: row.price,
          ruleStates: {
            [buyLevel]: {
              state: row.state,
              since: row.date,
              triggerDate: row.state === "ACTIVE" ? row.date : null,
            },
          },
          activeSignalId: signal?.id ?? null,
        },
      });
    }
  });
}

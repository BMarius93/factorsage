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
 * monitors, one setup waiting for its trigger, one earlier occurrence that a later session ended,
 * and one earlier occurrence that history established and a membership change ended
 * administratively — so the browser can be asserted against exact rows, and against the rule that
 * only observed changes are activity. Each change is written as the EOD evaluation
 * writes it (`docs/decisions/monitor-eod-v2.md` §3–§6): an observed transition with the version
 * that decided it and the evidence it compared, and a checkpoint at the newest seeded session so a
 * running worker has nothing left to evaluate and never moves the declared state. Its keys are
 * namespaced `qa-builtin-`, and it only ever reaches `TEST_DATABASE_URL`.
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
    select: { id: true, systemKey: true, configVersion: true },
  });
  const version = await prisma.strategyVersion.findFirstOrThrow({
    where: { strategy: { systemKey: QA_BUILT_IN_KEYS.strategy } },
    orderBy: { versionNumber: "desc" },
    select: { id: true },
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
  // The newest seeded session per security: the checkpoint every member is evaluated through.
  const newestBars = await prisma.dailyPrice.groupBy({
    by: ["securityId"],
    where: { securityId: { in: securities.map((security) => security.id) } },
    _max: { date: true },
  });
  const newestBar = new Map(
    newestBars.flatMap((row) =>
      row._max.date ? [[row.securityId, row._max.date] as const] : [],
    ),
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
    await tx.monitorEvaluationCheckpoint.deleteMany({
      where: { monitorId: { in: monitorIds } },
    });
    await tx.monitor.updateMany({
      where: { id: { in: monitorIds } },
      data: {
        lastScanAt: now,
        isPublished: true,
        isGloballyEnabled: true,
        // Declared state, not a fresh Monitor: nothing to replay.
        initialReplayRequested: false,
        replayWindowStart: null,
        replayWindowFixedAt: null,
        watchingSince: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    // What the Trend Confirmation BUY level compared on a session, as the worker records it.
    const evidence = (input: {
      golden: boolean;
      trend: boolean;
      crossed: boolean;
      price: number;
    }) => ({
      v: 1,
      rules: [
        {
          ruleId: buyLevel,
          predicates: [
            {
              id: "trend-confirmation-buy-golden",
              role: "CONDITION",
              result: input.golden ? "TRUE" : "FALSE",
              metric: 98.4,
              value: 92.1,
            },
            {
              id: "trend-confirmation-buy-trend",
              role: "CONDITION",
              result: input.trend ? "TRUE" : "FALSE",
              metric: input.price,
              value: 92.1,
            },
            {
              id: "trend-confirmation-buy-momentum",
              role: "TRIGGER",
              result: input.crossed ? "TRUE" : "FALSE",
              metric: input.price,
              value: input.price - 1.5,
              previousMetric: input.price - 3,
              previousValue: input.price - 1.4,
            },
          ],
        },
      ],
    });

    // An earlier occurrence of Monitor A that a later session ended, for the activity feed and
    // the Signal table's ended rows.
    {
      const monitorId = byKey.get(QA_BUILT_IN_KEYS.monitorA)!;
      const security = securityId.get(QA_ALPHA.symbol)!;
      const ended = await tx.monitorSignal.create({
        data: {
          monitorId,
          securityId: security,
          levelId: buyLevel,
          levelKind: "BUY",
          strategyVersionId: version.id,
          signalFingerprint: fingerprint,
          hasTrigger: true,
          observationDate: new Date("2026-09-01T00:00:00.000Z"),
          observationPrice: 97.5,
          detectedAt: new Date("2026-09-01T22:00:00.000Z"),
          resolvedAt: new Date("2026-09-08T22:00:00.000Z"),
          resolvedObservationDate: new Date("2026-09-08T00:00:00.000Z"),
          resolutionReason: "CONDITIONS_ENDED",
        },
      });
      await tx.monitorStateTransition.createMany({
        data: [
          {
            monitorId,
            securityId: security,
            levelId: buyLevel,
            levelKind: "BUY",
            signalFingerprint: fingerprint,
            fromState: "INACTIVE",
            toState: "ACTIVE",
            reason: "TRIGGER_FIRED",
            origin: "OBSERVED",
            occurredAt: new Date("2026-09-01T22:00:00.000Z"),
            observationDate: new Date("2026-09-01T00:00:00.000Z"),
            signalId: ended.id,
            strategyVersionId: version.id,
            evidence: evidence({
              golden: true,
              trend: true,
              crossed: true,
              price: 97.5,
            }),
          },
          {
            monitorId,
            securityId: security,
            levelId: buyLevel,
            levelKind: "BUY",
            signalFingerprint: fingerprint,
            fromState: "ACTIVE",
            toState: "RESOLVED",
            reason: "CONDITIONS_ENDED",
            origin: "OBSERVED",
            occurredAt: new Date("2026-09-08T22:00:00.000Z"),
            observationDate: new Date("2026-09-08T00:00:00.000Z"),
            signalId: ended.id,
            strategyVersionId: version.id,
            evidence: evidence({
              golden: true,
              trend: false,
              crossed: false,
              price: 90.25,
            }),
          },
        ],
      });
    }

    // An earlier occurrence of Monitor B on QATEST2 that a reconstruction established — history, not
    // an observation — and a membership change ended administratively. The Signal table shows it,
    // marked from history; the activity feed shows neither change (`monitor-eod-v2.md` §6).
    {
      const monitorId = byKey.get(QA_BUILT_IN_KEYS.monitorB)!;
      const security = securityId.get(QA_BETA.symbol)!;
      const reconstructed = await tx.monitorSignal.create({
        data: {
          monitorId,
          securityId: security,
          levelId: buyLevel,
          levelKind: "BUY",
          strategyVersionId: version.id,
          signalFingerprint: fingerprint,
          hasTrigger: true,
          observationDate: new Date("2026-08-20T00:00:00.000Z"),
          observationPrice: 45.5,
          detectedAt: new Date("2026-08-24T22:00:00.000Z"),
          reconstructed: true,
          resolvedAt: new Date("2026-09-12T14:00:00.000Z"),
          resolvedObservationDate: null,
          resolutionReason: "MEMBERSHIP_CHANGED",
        },
      });
      await tx.monitorStateTransition.createMany({
        data: [
          {
            monitorId,
            securityId: security,
            levelId: buyLevel,
            levelKind: "BUY",
            signalFingerprint: fingerprint,
            fromState: "INACTIVE",
            toState: "ACTIVE",
            reason: "RECONSTRUCTED",
            origin: "HISTORY",
            occurredAt: new Date("2026-08-24T22:00:00.000Z"),
            observationDate: new Date("2026-08-20T00:00:00.000Z"),
            signalId: reconstructed.id,
            strategyVersionId: version.id,
          },
          {
            monitorId,
            securityId: security,
            levelId: buyLevel,
            levelKind: "BUY",
            signalFingerprint: fingerprint,
            fromState: "ACTIVE",
            toState: "RESOLVED",
            reason: "MEMBERSHIP_CHANGED",
            origin: "ADMINISTRATIVE",
            occurredAt: new Date("2026-09-12T14:00:00.000Z"),
            observationDate: null,
            signalId: reconstructed.id,
          },
        ],
      });
    }

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
                strategyVersionId: version.id,
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
      await tx.monitorStateTransition.create({
        data: {
          monitorId,
          securityId: security,
          levelId: buyLevel,
          levelKind: "BUY",
          signalFingerprint: fingerprint,
          // Monitor A's first occurrence ended on Sep 8, so its second begins from RESOLVED.
          fromState:
            row.state === "ACTIVE" && row.monitor === QA_BUILT_IN_KEYS.monitorA
              ? "RESOLVED"
              : "INACTIVE",
          toState: row.state,
          reason: row.state === "ACTIVE" ? "TRIGGER_FIRED" : "SETUP_STARTED",
          origin: "OBSERVED",
          occurredAt: new Date(`${row.date}T22:00:00.000Z`),
          observationDate: day,
          signalId: signal?.id ?? null,
          strategyVersionId: version.id,
          evidence: evidence({
            golden: true,
            trend: true,
            crossed: row.state === "ACTIVE",
            price: row.price,
          }),
        },
      });
    }

    // Every member evaluated through its newest seeded session, under the membership it has:
    // a running worker finds nothing new to decide and leaves the declared state as it is.
    const memberships = [
      {
        monitor: QA_BUILT_IN_KEYS.monitorA,
        symbol: QA_ALPHA.symbol,
        start: null,
      },
      {
        monitor: QA_BUILT_IN_KEYS.monitorB,
        symbol: QA_ALPHA.symbol,
        start: null,
      },
      {
        monitor: QA_BUILT_IN_KEYS.monitorB,
        symbol: QA_BETA.symbol,
        start: "2024-01-02",
      },
    ] as const;
    for (const member of memberships) {
      const security = securityId.get(member.symbol)!;
      const through = newestBar.get(security);
      const monitor = monitors.find(
        (entry) => entry.systemKey === member.monitor,
      );
      if (!through || !monitor) {
        continue;
      }
      await tx.monitorEvaluationCheckpoint.create({
        data: {
          monitorId: monitor.id,
          securityId: security,
          evaluatedThrough: through,
          configVersion: monitor.configVersion,
          basisGeneration: 0,
          membershipRecorded: true,
          membershipStart: member.start
            ? new Date(`${member.start}T00:00:00.000Z`)
            : null,
        },
      });
    }
  });
}

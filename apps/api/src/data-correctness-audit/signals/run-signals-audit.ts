import { spawnSync } from "node:child_process";
import type { PrismaClient } from "@intrinsic/database";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AuthModule } from "../../auth/auth.module";
import type { AuthUser } from "@intrinsic/contracts";
import { ConfigurationModule } from "../../config/configuration.module";
import { DashboardModule } from "../../dashboard/dashboard.module";
import { DashboardService } from "../../dashboard/dashboard.service";
import { DatabaseModule } from "../../database/database.module";
import { MonitorsModule } from "../../monitors/monitors.module";
import { MonitorsService } from "../../monitors/monitors.service";
import type { AuditWriter } from "../artifacts";
import { ComparisonLedger } from "../comparison";
import { INDICATORS } from "../oracle/indicators";
import {
  levelState,
  replay,
  stepRule,
  type Observation,
  type RuleState,
} from "../oracle/monitor-lifecycle";
import type { MarketRow } from "../oracle/predicates";
import { oracleSessionClose } from "../oracle/sessions";
import {
  isPositionMetric,
  parseOracleStrategy,
  type OracleSignal,
} from "../oracle/strategy-model";
import { referenceForSecurity } from "../technicals/run-technicals-audit";

/**
 * Monitor → Signal → Dashboard on real data.
 *
 *   reference series (from raw closes) ──► reference lifecycle replay ──► expected states & Signals
 *   real Monitor cycle (worker, matrix DB) ──► MonitorSignalState / MonitorSignal
 *   DashboardService.getDashboard (the code behind GET /dashboard)
 *
 * Two consecutive sessions are scanned so transitions are exercised: reconstruction on the first,
 * then match → still match, match → no match, event → next session, and no duplicate emission.
 * Every (member, level) pair that should *not* be on the Dashboard is checked to be absent.
 */

export const AUDIT_MONITOR_PREFIX = "DCA-AUDIT-";

const AUDIT_MONITORS = [
  {
    suffix: "S01xL08-conditions",
    strategy: "QA-MATRIX-S01",
    list: "QA-MATRIX-L08",
  },
  {
    suffix: "S02xL08-triggers",
    strategy: "QA-MATRIX-S02",
    list: "QA-MATRIX-L08",
  },
  {
    suffix: "S06xL08-conditions+trigger",
    strategy: "QA-MATRIX-S06",
    list: "QA-MATRIX-L08",
  },
  {
    suffix: "S04xL10-windows",
    strategy: "QA-MATRIX-S04",
    list: "QA-MATRIX-L10",
  },
  {
    suffix: "S03xL05-weekly",
    strategy: "QA-MATRIX-S03",
    list: "QA-MATRIX-L05",
  },
  {
    suffix: "S10xL02-rsi-events",
    strategy: "QA-MATRIX-S10",
    list: "QA-MATRIX-L02",
  },
];

@Module({
  imports: [
    ConfigurationModule,
    DatabaseModule,
    AuthModule,
    MonitorsModule,
    DashboardModule,
  ],
})
class SignalsAuditModule {}

type Level = {
  id: string;
  kind: "BUY" | "SELL" | "FINAL_EXIT";
  index: number | null;
  percentage: number | null;
  rules: OracleSignal[];
};

type Expected = {
  monitorId: string;
  monitorName: string;
  securityId: string;
  symbol: string;
  level: Level;
  state: string;
  since: string | null;
  price: number | null;
  rules: RuleState[];
};

function monitoredLevels(definition: unknown): {
  levels: Level[];
  skipped: string[];
} {
  const strategy = parseOracleStrategy(definition);
  const levels: Level[] = [];
  const skipped: string[] = [];
  const usesPosition = (signal: OracleSignal): boolean =>
    signal.conditions.some((condition) => isPositionMetric(condition.metric)) ||
    (signal.trigger !== null && isPositionMetric(signal.trigger.metric));
  strategy.buyLevels.forEach((level, index) =>
    levels.push({
      id: level.id,
      kind: "BUY",
      index: index + 1,
      percentage: level.percentage,
      rules: [level.signal],
    }),
  );
  strategy.sellLevels.forEach((level, index) => {
    if (usesPosition(level.signal)) {
      skipped.push(level.id);
    } else {
      levels.push({
        id: level.id,
        kind: "SELL",
        index: index + 1,
        percentage: level.percentage,
        rules: [level.signal],
      });
    }
  });
  if (strategy.finalExit) {
    const rules = strategy.finalExit.rules.map((rule) => rule.signal);
    if (rules.some(usesPosition)) {
      skipped.push(strategy.finalExit.id);
    } else {
      levels.push({
        id: strategy.finalExit.id,
        kind: "FINAL_EXIT",
        index: null,
        percentage: null,
        rules,
      });
    }
  }
  return { levels, skipped };
}

function runScan(
  root: string,
  asOf: string,
  log: (line: string) => void,
): Record<string, unknown> {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@intrinsic/worker",
      "exec",
      "tsx",
      "src/monitor/data-correctness-scan.ts",
      "--as-of",
      asOf,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        STOCK_RECENT_PRICE_FRESHNESS_MS: String(10 * 365 * 24 * 60 * 60 * 1000),
        STOCK_FUNDAMENTALS_FRESHNESS_MS: String(10 * 365 * 24 * 60 * 60 * 1000),
        LOG_LEVEL: "warn",
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `the audit Monitor scan for ${asOf} failed:\n${result.stderr}\n${result.stdout}`,
    );
  }
  const line =
    result.stdout
      .trim()
      .split("\n")
      .filter((entry) => entry.startsWith("{"))
      .pop() ?? "{}";
  log(`  scan ${asOf}: ${line.slice(0, 400)}`);
  return JSON.parse(line) as Record<string, unknown>;
}

export async function runSignalsSection(input: {
  prisma: PrismaClient;
  root: string;
  ownerUserId: string;
  writer: AuditWriter;
  log: (line: string) => void;
}): Promise<{ ledger: ComparisonLedger; detail: Record<string, unknown> }> {
  const { prisma, writer, log } = input;
  const ledger = new ComparisonLedger(300);
  const app = await NestFactory.createApplicationContext(SignalsAuditModule, {
    logger: false,
  });
  try {
    const monitors = app.get(MonitorsService, { strict: false });
    const dashboard = app.get(DashboardService, { strict: false });
    const ownerRow = await prisma.user.findUniqueOrThrow({
      where: { id: input.ownerUserId },
      select: { id: true, email: true, role: true, plan: true },
    });
    const owner = ownerRow as unknown as AuthUser;

    // Sessions: the last two closed sessions of the execution calendar before the newest bar, so
    // both are closed days whose bars every member has.
    const sessions = (
      await prisma.$queryRawUnsafe<{ date: string }[]>(
        `select b.date::text as date from "BenchmarkDailyPrice" b join "BenchmarkSeries" s on s.id = b."seriesId"
           join "Benchmark" k on k.id = s."benchmarkId" where k.code = 'SP500' order by b.date desc limit 4`,
      )
    ).map((row) => row.date);
    const [firstSession, secondSession] = [sessions[2]!, sessions[1]!];

    // Fresh audit Monitors through the product's own service.
    for (const existing of await prisma.monitor.findMany({
      where: { userId: owner.id, name: { startsWith: AUDIT_MONITOR_PREFIX } },
      select: { id: true },
    })) {
      await monitors.deleteMonitor(owner, existing.id);
    }
    const created: {
      id: string;
      name: string;
      strategyId: string;
      stockListId: string;
    }[] = [];
    for (const spec of AUDIT_MONITORS) {
      const strategy = await prisma.strategy.findFirstOrThrow({
        where: { userId: owner.id, name: { startsWith: spec.strategy } },
        select: { id: true },
      });
      const list = await prisma.stockList.findFirstOrThrow({
        where: { userId: owner.id, name: { startsWith: spec.list } },
        select: { id: true },
      });
      const monitor = await monitors.createMonitor(owner, {
        name: `${AUDIT_MONITOR_PREFIX}${spec.suffix}`,
        strategyId: strategy.id,
        stockListId: list.id,
        enabled: true,
      });
      created.push({
        id: monitor.id,
        name: monitor.name,
        strategyId: strategy.id,
        stockListId: list.id,
      });
    }

    // Reference data per member: closes and reference indicators up to the second session.
    const rowCache = new Map<string, MarketRow[]>();
    const rowsFor = async (
      securityId: string,
      ipoDate: string | null,
    ): Promise<MarketRow[]> => {
      const cached = rowCache.get(securityId);
      if (cached) {
        return cached;
      }
      // Weekly values as the stored series defines them: a week is complete on its own last
      // trading day, so the reference is cut at the newest session, not at the audited one.
      const reference = await referenceForSecurity(
        prisma,
        securityId,
        ipoDate,
        sessions[0]!,
      );
      const closes = new Map(
        (
          await prisma.$queryRawUnsafe<{ date: string; close: string }[]>(
            `select date::text as date, close::text as close from "DailyPrice" where "securityId" = $1 and date <= $2::date order by date`,
            securityId,
            secondSession,
          )
        ).map((row) => [row.date, Number(row.close)]),
      );
      const rows: MarketRow[] = [];
      reference.dates.forEach((date, index) => {
        if (date > secondSession) {
          return;
        }
        const values = new Map<string, number>();
        for (const indicator of INDICATORS) {
          const value = reference.values.get(indicator.column)![index];
          if (value !== null && value !== undefined) {
            values.set(`series:${indicator.seriesId}`, value);
          }
        }
        rows.push({ date, close: closes.get(date) ?? Number.NaN, values });
      });
      rowCache.set(securityId, rows);
      return rows;
    };

    const expectationsAt = async (session: string): Promise<Expected[]> => {
      const expected: Expected[] = [];
      for (const monitor of created) {
        const version = await prisma.strategyVersion.findFirstOrThrow({
          where: { strategyId: monitor.strategyId },
          orderBy: { versionNumber: "desc" },
          select: { definition: true },
        });
        const { levels } = monitoredLevels(version.definition);
        const members = await prisma.stockListItem.findMany({
          where: { stockListId: monitor.stockListId },
          select: {
            securityId: true,
            buyWindowMode: true,
            security: { select: { symbol: true, ipoDate: true } },
            buyWindows: { select: { startDate: true, endDate: true } },
          },
        });
        for (const member of members) {
          const rows = (
            await rowsFor(
              member.securityId,
              member.security.ipoDate?.toISOString().slice(0, 10) ?? null,
            )
          ).filter((row) => row.date <= session);
          const windows = member.buyWindows.map((window) => ({
            start: window.startDate.toISOString().slice(0, 10),
            end: window.endDate?.toISOString().slice(0, 10) ?? null,
          }));
          for (const level of levels) {
            const observations: Observation[] = rows.map((row, index) => ({
              row,
              previous: index > 0 ? rows[index - 1]! : null,
              eligible:
                level.kind !== "BUY" ||
                member.buyWindowMode === "FULL" ||
                windows.some(
                  (window) =>
                    window.start <= row.date &&
                    (window.end === null || row.date <= window.end),
                ),
            }));
            const rules = replay(level.rules, observations);
            const state = levelState(rules);
            const since =
              state === "ACTIVE"
                ? rules
                    .filter((rule) => rule.state === "ACTIVE")
                    .map((rule) => rule.activeSince!)
                    .sort()[0]!
                : state === "PENDING_TRIGGER"
                  ? rules
                      .filter((rule) => rule.state === "PENDING_TRIGGER")
                      .map((rule) => rule.since!)
                      .sort()[0]!
                  : null;
            const priceRow = since
              ? rows.find((row) => row.date === since)
              : undefined;
            expected.push({
              monitorId: monitor.id,
              monitorName: monitor.name,
              securityId: member.securityId,
              symbol: member.security.symbol,
              level,
              state,
              since,
              price: priceRow?.close ?? null,
              rules,
            });
          }
        }
      }
      return expected;
    };

    const sinceEvidence: Record<string, unknown>[] = [];
    const compare = async (
      session: string,
      phase: string,
    ): Promise<{
      expected: Expected[];
      dashboardRows: number;
      absentChecked: number;
    }> => {
      const expected = await expectationsAt(session);
      const states = await prisma.$queryRawUnsafe<
        {
          monitorId: string;
          securityId: string;
          levelId: string;
          lifecycleState: string;
          lifecycleSinceDate: string | null;
          lifecycleSincePrice: string | null;
          activeSignalId: string | null;
          signalDate: string | null;
          signalPrice: string | null;
          signalResolved: boolean | null;
        }[]
      >(
        `select s."monitorId", s."securityId", s."levelId", s."lifecycleState"::text as "lifecycleState",
                s."lifecycleSinceDate"::text as "lifecycleSinceDate", s."lifecycleSincePrice"::text as "lifecycleSincePrice",
                s."activeSignalId", g."observationDate"::text as "signalDate", g."observationPrice"::text as "signalPrice",
                g."resolvedAt" is not null as "signalResolved"
           from "MonitorSignalState" s left join "MonitorSignal" g on g.id = s."activeSignalId"
          where s."monitorId" = any($1)`,
        created.map((monitor) => monitor.id),
      );
      const byKey = new Map(
        states.map((state) => [
          `${state.monitorId}|${state.securityId}|${state.levelId}`,
          state,
        ]),
      );
      const current = (state: string | undefined): string =>
        state === "ACTIVE" || state === "PENDING_TRIGGER" ? state : "NONE";
      for (const entry of expected) {
        const key = `${entry.monitorId}|${entry.securityId}|${entry.level.id}`;
        const stored = byKey.get(key);
        const label = `${phase} ${entry.monitorName} ${entry.symbol} ${entry.level.kind}${entry.level.percentage ? ` ${entry.level.percentage}%` : ""}`;
        ledger.check(
          "signals-state",
          `${label} state`,
          current(entry.state),
          current(stored?.lifecycleState),
          "exact-text",
        );
        if (entry.state === "ACTIVE" || entry.state === "PENDING_TRIGGER") {
          ledger.check(
            "signals-state",
            `${label} since`,
            entry.since,
            stored?.lifecycleSinceDate ?? null,
            "exact-text",
          );
        }
        if (entry.state === "ACTIVE") {
          ledger.check(
            "signals-persisted",
            `${label} active Signal present and open`,
            true,
            Boolean(stored?.activeSignalId) && stored?.signalResolved === false,
            "exact-number",
          );
          ledger.check(
            "signals-persisted",
            `${label} Signal observation date`,
            entry.since,
            stored?.signalDate ?? null,
            "exact-text",
          );
          ledger.check(
            "signals-persisted",
            `${label} Signal observation price`,
            entry.price === null ? null : String(entry.price),
            stored?.signalPrice ?? null,
            "exact-decimal",
          );
        }
      }
      // No state row for a level the Monitor must not evaluate (Gain/Loss levels).
      const expectedKeys = new Set(
        expected.map(
          (entry) => `${entry.monitorId}|${entry.securityId}|${entry.level.id}`,
        ),
      );
      const extra = states.filter(
        (state) =>
          !expectedKeys.has(
            `${state.monitorId}|${state.securityId}|${state.levelId}`,
          ) && current(state.lifecycleState) !== "NONE",
      );
      ledger.check(
        "signals-state",
        `${phase} no current state for an unmonitored level`,
        0,
        extra.length,
        "exact-number",
      );
      // At most one open Signal per (monitor, security, level) — no duplicate emission.
      const duplicates = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `select count(*) as count from (select "monitorId", "securityId", "levelId" from "MonitorSignal"
           where "monitorId" = any($1) and "resolvedAt" is null group by 1, 2, 3 having count(*) > 1) x`,
        created.map((monitor) => monitor.id),
      );
      ledger.check(
        "signals-persisted",
        `${phase} no duplicate open Signal`,
        0,
        Number(duplicates[0]?.count ?? 0),
        "exact-number",
      );

      // Dashboard: exactly the expected ACTIVE and PENDING rows of these Monitors, and nothing else.
      const response = await dashboard.getDashboard(owner as never);
      const rows = response.rows.filter((row) =>
        created.some((monitor) => monitor.id === row.monitor.id),
      );
      const rowKey = (
        monitorId: string,
        symbol: string,
        kind: string,
        index: number | null | undefined,
      ): string => `${monitorId}|${symbol}|${kind}|${index ?? "-"}`;
      const expectedRows = new Map(
        expected
          .filter(
            (entry) =>
              entry.state === "ACTIVE" || entry.state === "PENDING_TRIGGER",
          )
          .map((entry) => [
            rowKey(
              entry.monitorId,
              entry.symbol,
              entry.level.kind,
              entry.level.index,
            ),
            entry,
          ]),
      );
      const servedRows = new Map(
        rows.map((row) => [
          rowKey(
            row.monitor.id,
            row.security.symbol,
            row.levelKind,
            row.levelIndex,
          ),
          row,
        ]),
      );
      ledger.check(
        "dashboard",
        `${phase} dashboard row count`,
        expectedRows.size,
        rows.length,
        "exact-number",
      );
      ledger.check(
        "dashboard",
        `${phase} dashboard has no duplicate row`,
        rows.length,
        servedRows.size,
        "exact-number",
      );
      for (const [key, entry] of expectedRows) {
        const row = servedRows.get(key);
        const label = `${phase} dashboard ${entry.monitorName} ${entry.symbol} ${entry.level.kind} ${entry.level.index ?? ""}`;
        ledger.check(
          "dashboard",
          `${label} present`,
          true,
          row !== undefined,
          "exact-number",
        );
        if (!row) {
          continue;
        }
        ledger.check(
          "dashboard",
          `${label} state`,
          entry.state,
          row.state,
          "exact-text",
        );
        ledger.check(
          "dashboard",
          `${label} observationDate`,
          entry.since,
          row.observationDate ?? null,
          "exact-text",
        );
        ledger.check(
          "dashboard",
          `${label} price`,
          entry.price,
          row.price ?? null,
          "exact-number",
        );
        ledger.check(
          "dashboard",
          `${label} levelPercentage`,
          entry.level.percentage ?? undefined,
          row.levelPercentage,
          "exact-number",
        );
        ledger.check(
          "dashboard",
          `${label} strategy/list`,
          true,
          row.strategy.id ===
            created.find((monitor) => monitor.id === entry.monitorId)!
              .strategyId &&
            row.stockList.id ===
              created.find((monitor) => monitor.id === entry.monitorId)!
                .stockListId,
          "exact-number",
        );
      }
      // "Since" is a statement about the observation the state began on: the close of that session,
      // or the scan's own instant while that session is still open (AUD-05). So it may never be
      // later than the session's close, and for a reconstructed row — one whose activation a scan
      // found after the fact — it must be exactly that close.
      const sinceGaps = rows
        .filter((row) => row.observationDate)
        .map((row) => ({
          symbol: row.security.symbol,
          reconstructed: row.reconstructed,
          observationDate: row.observationDate!,
          since: row.since,
          close: oracleSessionClose(row.observationDate!),
          days: Math.round(
            (Date.parse(row.since) -
              Date.parse(oracleSessionClose(row.observationDate!))) /
              86_400_000,
          ),
        }));
      for (const entry of sinceGaps) {
        ledger.check(
          "dashboard",
          `${phase} since not after its session ${entry.symbol} ${entry.observationDate}`,
          true,
          Date.parse(entry.since) <= Date.parse(entry.close),
          "exact-number",
        );
        if (entry.reconstructed) {
          ledger.check(
            "dashboard",
            `${phase} reconstructed since is its session close ${entry.symbol} ${entry.observationDate}`,
            entry.close,
            entry.since,
            "exact-text",
          );
        }
      }
      sinceEvidence.push({
        phase,
        reconstructedRows: rows.filter((row) => row.reconstructed).length,
        sinceLaterThanActivation: sinceGaps.filter((entry) => entry.days > 0)
          .length,
        examples: sinceGaps.slice(0, 5),
      });
      let absentChecked = 0;
      for (const entry of expected) {
        if (entry.state === "ACTIVE" || entry.state === "PENDING_TRIGGER") {
          continue;
        }
        absentChecked += 1;
        ledger.check(
          "dashboard",
          `${phase} absent ${entry.monitorName} ${entry.symbol} ${entry.level.kind} ${entry.level.index ?? ""}`,
          false,
          servedRows.has(
            rowKey(
              entry.monitorId,
              entry.symbol,
              entry.level.kind,
              entry.level.index,
            ),
          ),
          "exact-number",
        );
      }
      return { expected, dashboardRows: rows.length, absentChecked };
    };

    const scan1 = runScan(input.root, firstSession, log);
    const first = await compare(firstSession, `[${firstSession}]`);
    const signalsBefore = await prisma.monitorSignal.findMany({
      where: { monitorId: { in: created.map((monitor) => monitor.id) } },
      select: {
        id: true,
        securityId: true,
        levelId: true,
        monitorId: true,
        resolvedAt: true,
      },
    });
    const scan2 = runScan(input.root, secondSession, log);
    const second = await compare(secondSession, `[${secondSession}]`);

    // Transitions between the two sessions: every occurrence that ended was resolved on the second
    // session with a reason; every new occurrence produced exactly one new Signal.
    const signalsAfter = await prisma.$queryRawUnsafe<
      {
        id: string;
        monitorId: string;
        securityId: string;
        levelId: string;
        resolvedObservationDate: string | null;
        resolutionReason: string | null;
        observationDate: string;
      }[]
    >(
      `select id, "monitorId", "securityId", "levelId", "resolvedObservationDate"::text as "resolvedObservationDate",
              "resolutionReason"::text as "resolutionReason", "observationDate"::text as "observationDate"
         from "MonitorSignal" where "monitorId" = any($1)`,
      created.map((monitor) => monitor.id),
    );
    const beforeIds = new Set(signalsBefore.map((signal) => signal.id));
    const transitions = {
      continued: 0,
      ended: 0,
      opened: 0,
      reopenedEvents: 0,
    };
    const firstByKey = new Map(
      first.expected.map((entry) => [
        `${entry.monitorId}|${entry.securityId}|${entry.level.id}`,
        entry,
      ]),
    );
    for (const entry of second.expected) {
      const key = `${entry.monitorId}|${entry.securityId}|${entry.level.id}`;
      const previous = firstByKey.get(key)!;
      const wasActive = previous.state === "ACTIVE";
      const isActive = entry.state === "ACTIVE";
      const sameOccurrence =
        wasActive && isActive && previous.since === entry.since;
      const signals = signalsAfter.filter(
        (signal) =>
          `${signal.monitorId}|${signal.securityId}|${signal.levelId}` === key,
      );
      const opened = signals.filter((signal) => !beforeIds.has(signal.id));
      const label = `transition ${entry.monitorName} ${entry.symbol} ${entry.level.kind} ${entry.level.index ?? ""}`;
      if (sameOccurrence) {
        transitions.continued += 1;
        ledger.check(
          "signals-transitions",
          `${label} continues without a new Signal`,
          0,
          opened.length,
          "exact-number",
        );
      } else {
        if (wasActive) {
          transitions.ended += 1;
          const ended = signals.find(
            (signal) =>
              beforeIds.has(signal.id) &&
              signal.observationDate === previous.since,
          );
          ledger.check(
            "signals-transitions",
            `${label} ended on ${secondSession}`,
            secondSession,
            ended?.resolvedObservationDate ?? null,
            "exact-text",
          );
          ledger.check(
            "signals-transitions",
            `${label} has a resolution reason`,
            true,
            Boolean(ended?.resolutionReason),
            "exact-number",
          );
        }
        if (isActive) {
          transitions.opened += 1;
          if (wasActive) {
            transitions.reopenedEvents += 1;
          }
          ledger.check(
            "signals-transitions",
            `${label} opened exactly one new Signal`,
            1,
            opened.length,
            "exact-number",
          );
        } else {
          ledger.check(
            "signals-transitions",
            `${label} opened no Signal`,
            0,
            opened.length,
            "exact-number",
          );
        }
      }
    }
    // Sanity on the reference itself: stepping the first session's state by one observation must
    // reproduce the replay (the lifecycle is Markov in its stored state).
    let markovChecked = 0;
    for (const entry of second.expected.slice(0, 200)) {
      const previous = firstByKey.get(
        `${entry.monitorId}|${entry.securityId}|${entry.level.id}`,
      )!;
      const rows = rowCache.get(entry.securityId)!;
      const index = rows.findIndex((row) => row.date === secondSession);
      if (index < 0) {
        continue;
      }
      const stepped = previous.rules.map((rule, ruleIndex) =>
        stepRule(rule, entry.level.rules[ruleIndex]!, {
          row: rows[index]!,
          previous: rows[index - 1] ?? null,
          eligible: true,
        }),
      );
      if (entry.level.kind !== "BUY") {
        markovChecked += 1;
        ledger.check(
          "signals-reference",
          `markov ${entry.symbol} ${entry.level.id}`,
          levelState(entry.rules),
          levelState(stepped),
          "exact-text",
        );
      }
    }

    const summarize = (expected: Expected[]) => ({
      pairs: expected.length,
      active: expected.filter((entry) => entry.state === "ACTIVE").length,
      pending: expected.filter((entry) => entry.state === "PENDING_TRIGGER")
        .length,
      none: expected.filter(
        (entry) =>
          entry.state !== "ACTIVE" && entry.state !== "PENDING_TRIGGER",
      ).length,
    });
    const dashboardExpectations = second.expected
      .filter(
        (entry) =>
          entry.state === "ACTIVE" || entry.state === "PENDING_TRIGGER",
      )
      .map((entry) => ({
        monitor: entry.monitorName,
        symbol: entry.symbol,
        levelKind: entry.level.kind,
        levelPercentage: entry.level.percentage,
        state: entry.state,
        price: entry.price,
        observationDate: entry.since,
      }));
    writer.writeJson("ui/dashboard-expectations.json", {
      session: secondSession,
      rows: dashboardExpectations,
    });
    const detail = {
      sessions: [firstSession, secondSession],
      monitors: created.map((monitor) => monitor.name),
      scans: [scan1, scan2],
      firstSession: {
        ...summarize(first.expected),
        dashboardRows: first.dashboardRows,
        absentChecked: first.absentChecked,
      },
      secondSession: {
        ...summarize(second.expected),
        dashboardRows: second.dashboardRows,
        absentChecked: second.absentChecked,
      },
      transitions,
      markovChecked,
      sinceEvidence,
    };
    writer.writeJson("signals/summary.json", {
      ...detail,
      comparisons: ledger.totals(),
      byCategory: ledger.byCategory(),
      differences: ledger.differences,
      expectedRows: dashboardExpectations,
    });
    writer.writeJson("dashboard/reconciliation.json", {
      session: secondSession,
      expectedRows: dashboardExpectations.length,
      comparisons: ledger.byCategory().dashboard ?? null,
      differences: ledger.differences.filter((difference) =>
        difference.path.includes("dashboard"),
      ),
    });
    return { ledger, detail };
  } finally {
    await app.close();
  }
}

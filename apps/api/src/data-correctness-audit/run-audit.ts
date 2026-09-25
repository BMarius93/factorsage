import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { resolveTestPersona } from "@intrinsic/testing";
import { useMatrixDatabase } from "../qa-matrix/matrix-environment";
import { createMatrixExecutionContext } from "../qa-matrix/matrix-execution";
import { repositoryRoot } from "../qa-matrix/matrix-paths";
import { AuditWriter, type SectionResult } from "./artifacts";
import { storedAtScale } from "./oracle/decimal";
import { reconcileBacktestApi } from "./backtests/api-reconciliation";
import { FrameProvenance } from "./backtests/frame-provenance";
import {
  latestMatrixSweep,
  runBacktestSection,
  type BacktestExpectation,
} from "./backtests/run-backtest-audit";
import { runAlternativeDataSection } from "./alternative-data/run-alternative-data-audit";
import { runIntrinsicSection } from "./intrinsic/run-intrinsic-audit";
import { runRelativeVolumeSection } from "./relative-volume/run-relative-volume-audit";
import { runFilingDateImpact } from "./lookahead/filing-date-impact";
import { ComparisonLedger } from "./comparison";
import { runBuyWindowAudit } from "./lists/buy-window-audit";
import { renderSummary } from "./report";
import { runSignalsSection } from "./signals/run-signals-audit";
import { runSourceDataAudit } from "./source/source-data-audit";
import { runStockDetailsSection } from "./stock-details/run-stock-details-audit";
import { runStrategyDifferential } from "./strategies/strategy-differential";
import { runTechnicalsSection } from "./technicals/run-technicals-audit";
import { AuditStack } from "./ui/audit-stack";
import { runUiSection } from "./ui/run-ui-audit";

/**
 * `pnpm audit:data-correctness [--sections=…] [--sweep=…] [--case=…] [--run-matrix]`
 *
 * The complete data-correctness audit (docs/data-correctness-audit/README.md). Every section runs
 * against the dedicated QA-matrix database — a frozen copy of canonical market data — so the
 * evidence is reproducible and nothing reaches the development or test databases.
 */

const ALL_SECTIONS = [
  "source",
  "technicals",
  "relative-volume",
  "alternative-data",
  "intrinsic",
  "strategies",
  "lists",
  "backtests",
  "lookahead",
  "api",
  "signals",
  "stock-details",
  "ui",
] as const;
type Section = (typeof ALL_SECTIONS)[number];

function flag(args: readonly string[], name: string): string | undefined {
  const entry = args.find((arg) => arg.startsWith(`--${name}=`));
  return entry?.slice(name.length + 3);
}

function lastClosedSession(prisma: PrismaClient): Promise<string> {
  return prisma
    .$queryRawUnsafe<{ date: string }[]>(
      `select max(b.date)::text as date from "BenchmarkDailyPrice" b join "BenchmarkSeries" s on s.id = b."seriesId"
         join "Benchmark" k on k.id = s."benchmarkId" where k.code = 'SP500'`,
    )
    .then((rows) => rows[0]!.date);
}

function section(
  name: string,
  ledger: {
    compared: number;
    passed: number;
    failed: number;
    skipped: number;
    tolerancePasses: number;
  },
  options: {
    independentOracle: boolean;
    endToEnd: boolean;
    detail: Record<string, unknown>;
    notes?: string[];
    failures?: number;
  },
): SectionResult {
  const failed = ledger.failed + (options.failures ?? 0);
  return {
    section: name,
    status: failed > 0 ? "FAIL" : ledger.compared === 0 ? "SKIPPED" : "PASS",
    comparisons: ledger.compared,
    passed: ledger.passed,
    failed: ledger.failed,
    skipped: ledger.skipped,
    tolerancePasses: ledger.tolerancePasses,
    independentOracle: options.independentOracle,
    endToEnd: options.endToEnd,
    detail: options.detail,
    notes: options.notes ?? [],
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  loadRootEnv();
  // Captured before the override below: `useMatrixDatabase` points this process at the matrix
  // database and Redis index by rewriting `DATABASE_URL` and `REDIS_URL`, and a child that
  // inherited those would see the matrix connections *as* the development ones — which is exactly
  // the mistake the matrix runner refuses to start on ("names the development database", "shares
  // the development Redis"). The sweep is spawned with both restored, so it resolves its own
  // environment the way a direct `pnpm qa:matrix:run` does.
  const developmentEnvironment = {
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
  };
  const environment = useMatrixDatabase();
  const root = repositoryRoot();
  const writer = new AuditWriter(
    join(root, "artifacts", "data-correctness-audit"),
  );
  const requested = (flag(args, "sections") ?? "all")
    .split(",")
    .map((entry) => entry.trim());
  const sections = new Set<Section>(
    requested.includes("all") ? ALL_SECTIONS : (requested as Section[]),
  );
  for (const name of sections) {
    if (!ALL_SECTIONS.includes(name)) {
      throw new Error(
        `Unknown section ${name}. Known: ${ALL_SECTIONS.join(", ")}, all`,
      );
    }
  }
  const started = Date.now();
  const log = (line: string): void => console.log(line);

  if (args.includes("--run-matrix")) {
    log(
      "Running the 1,000-case matrix with every case archived (pnpm qa:matrix:run --archive-all)…",
    );
    const run = spawnSync("pnpm", ["qa:matrix:run", "--archive-all"], {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(developmentEnvironment).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      },
    });
    if (run.status !== 0) {
      throw new Error(
        "the matrix sweep did not finish green; the audit needs its evidence",
      );
    }
  }

  const prisma = new PrismaClient();
  const results: SectionResult[] = [];
  const context: Record<string, unknown> = {};
  try {
    const asOf = await lastClosedSession(prisma);
    const securities = await prisma.$queryRawUnsafe<
      { securityId: string; symbol: string; ipoDate: string | null }[]
    >(
      `select distinct s.id as "securityId", s.symbol, s."ipoDate"::text as "ipoDate"
         from "Security" s join "DailyDerivedState" d on d."securityId" = s.id order by s.symbol`,
    );
    const horizonStart = (() => {
      const [year, month, day] = asOf.split("-").map(Number) as [
        number,
        number,
        number,
      ];
      return `${year - 30}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    })();
    // Frames start up to ten calendar days before a run so a Trigger has its t-1 value.
    const visibleFrom = new Date(
      Date.parse(`${horizonStart}T00:00:00Z`) - 12 * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    context.database = environment.databaseName;
    context.asOf = asOf;
    context.securities = securities.length;

    if (sections.has("source")) {
      log("\n== source data");
      const result = await runSourceDataAudit({
        prisma,
        writer,
        apiKey: process.env.FMP_API_KEY,
        lastClosedSession: asOf,
        log,
      });
      results.push(
        section("source-data", result.ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: { byCategory: result.ledger.byCategory() },
        }),
      );
    }

    let technicalReferences:
      Awaited<ReturnType<typeof runTechnicalsSection>>["references"] | null =
      null;
    if (sections.has("technicals") || sections.has("backtests")) {
      log("\n== technical indicators");
      const result = await runTechnicalsSection({
        prisma,
        writer,
        securities,
        horizonStart: visibleFrom,
        asOf,
        log,
      });
      technicalReferences = result.references;
      writer.writeJson("technicals/summary.json", {
        securities: securities.length,
        visibleFrom,
        comparisons: result.ledger.totals(),
        perIndicator: result.perIndicator,
        perSecurity: result.perSecurity,
        weekStartMismatches: result.weekStartMismatches,
        warmupRegion: result.warmupRegion,
        differences: result.ledger.differences,
      });
      results.push(
        section("technicals", result.ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: {
            perIndicator: result.perIndicator,
            weekStartMismatches: result.weekStartMismatches,
            warmupRegion: result.warmupRegion,
          },
        }),
      );
    }

    if (sections.has("relative-volume")) {
      log("\n== relative volume");
      const result = await runRelativeVolumeSection({
        prisma,
        writer,
        securities,
        horizonStart: visibleFrom,
        log,
      });
      writer.writeJson("relative-volume/summary.json", {
        securities: securities.length,
        visibleFrom,
        comparisons: result.ledger.totals(),
        byCategory: result.ledger.byCategory(),
        perPeriod: result.perPeriod,
        perSecurity: result.perSecurity,
        periodCollisions: result.periodCollisions,
        warmupRegion: result.warmupRegion,
        differences: result.ledger.differences,
      });
      results.push(
        section("relative-volume", result.ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: {
            perPeriod: result.perPeriod,
            periodCollisions: result.periodCollisions,
            warmupRegion: result.warmupRegion,
          },
          failures: result.periodCollisions,
        }),
      );
    }

    if (sections.has("alternative-data")) {
      log("\n== alternative data");
      const result = await runAlternativeDataSection({
        prisma,
        writer,
        securities,
        log,
      });
      writer.writeJson("alternative-data/summary.json", {
        securities: securities.length,
        comparisons: result.ledger.totals(),
        byCategory: result.ledger.byCategory(),
        rows: result.rows,
        availabilityViolations: result.availabilityViolations,
        filedBeforeTransaction: result.filedBeforeTransaction,
        observableSessionViolations: result.observableSessionViolations,
        perMetric: result.perMetric,
        coverage: result.coverage,
        differences: result.ledger.differences,
      });
      results.push(
        section("alternative-data", result.ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: {
            rows: result.rows,
            availabilityViolations: result.availabilityViolations,
            filedBeforeTransaction: result.filedBeforeTransaction,
            observableSessionViolations: result.observableSessionViolations,
            perMetric: result.perMetric,
          },
          failures:
            result.availabilityViolations + result.observableSessionViolations,
          notes: [
            `${result.filedBeforeTransaction} row(s) the provider dated as filed on or before the ` +
              "transaction they report. A provider anomaly: availability is still publication + 1 " +
              "day on every one of them, which is the only rule the product states.",
          ],
        }),
      );
    }

    let intrinsicReferences:
      Awaited<ReturnType<typeof runIntrinsicSection>>["references"] | null =
      null;
    if (sections.has("intrinsic") || sections.has("backtests")) {
      log("\n== intrinsic value");
      const result = await runIntrinsicSection({
        prisma,
        writer,
        securities,
        horizonStart: visibleFrom,
        log,
      });
      intrinsicReferences = result.references;
      writer.writeJson("intrinsic/summary.json", {
        comparisons: result.ledger.totals(),
        byCategory: result.ledger.byCategory(),
        perModel: result.perModel,
        pit: result.pit,
        perSecurity: result.perSecurity,
        differences: result.ledger.differences,
      });
      results.push(
        section("intrinsic", result.ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: { perModel: result.perModel, pit: result.pit },
          failures:
            result.pit.violations + result.pit.availabilityRuleViolations,
          notes: [
            `${result.pit.implausibleFilingDates} statements carry a provider filing date on or before their fiscal period end; their availability is derived from the statutory deadline instead (AUD-03).`,
          ],
        }),
      );
    }

    if (sections.has("strategies")) {
      log("\n== strategy evaluation (differential)");
      const result = runStrategyDifferential(writer);
      results.push(
        section("strategies", result.ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: { byCategory: result.ledger.byCategory() },
        }),
      );
    }

    if (sections.has("lists")) {
      log("\n== lists and buy windows");
      const result = await runBuyWindowAudit({ prisma, writer });
      results.push(
        section("lists-buy-windows", result.ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: { matrixEvidence: result.evidence },
        }),
      );
    }

    let expectations: Map<string, BacktestExpectation> | null = null;
    if (sections.has("backtests")) {
      log("\n== backtests (reference backtester over the matrix)");
      const sweep = flag(args, "sweep") ?? latestMatrixSweep(root);
      const provenance = new FrameProvenance(
        technicalReferences!,
        intrinsicReferences!,
      );
      const only = flag(args, "case")?.split(",");
      const { totals, audits } = await runBacktestSection({
        prisma,
        sweep,
        writer,
        only,
        log,
        onArchive: (archive) => provenance.audit(archive),
      });
      expectations = audits;
      const matrixSummary = existsSync(join(sweep, "summary.json"))
        ? JSON.parse(readFileSync(join(sweep, "summary.json"), "utf8"))
        : null;
      writer.writeJson("backtests/frame-provenance.json", {
        comparisons: provenance.ledger.totals(),
        byKey: provenance.byKey,
        differences: provenance.ledger.differences,
      });
      results.push(
        section("backtests", totals.comparisons, {
          independentOracle: true,
          endToEnd: false,
          detail: {
            ...totals,
            byCategory: undefined,
            matrixGate: matrixSummary
              ? {
                  green: matrixSummary.gate?.green,
                  completed: matrixSummary.completed,
                  invariantFailures: matrixSummary.invariantFailures,
                  determinism: matrixSummary.determinism,
                }
              : null,
          },
          failures: totals.scenariosSkipped,
        }),
      );
      results.push(
        section("frame-provenance", provenance.ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: { byKey: provenance.byKey },
        }),
      );
      // The sweep's own directory name, not its absolute path: this artifact is committed as
      // evidence, and a reviewer on another machine has no use for somebody's home directory.
      context.sweep = basename(sweep);
      context.matrixExecution = matrixSummary?.matrixExecutionId ?? null;
    }

    if (sections.has("lookahead")) {
      log("\n== look-ahead");
      const sweep = flag(args, "sweep") ?? latestMatrixSweep(root);
      const ledger = new ComparisonLedger(50);
      // The audit's own bound, written in SQL and deliberately *weaker* than the rule the product
      // applies: a statement the provider leaves undated may not be available before the deadline
      // a large accelerated filer is bound by — 40 days after a quarter, 60 after a fiscal year.
      // Counting the provider's undated filings instead, as this check used to, measured the
      // provider rather than FactorSage: 2,391 of them are undated whatever FactorSage does with
      // them, and the defect was never the count but the availability derived from it.
      const pitRows = await prisma.$queryRawUnsafe<
        {
          statements: bigint;
          implausible: bigint;
          early: bigint;
          tooEarly: bigint;
        }[]
      >(
        `select count(*) as statements,
                count(*) filter (where "filingDate" <= "fiscalDate") as implausible,
                count(*) filter (where "availableFromDate" <= "filingDate") as early,
                count(*) filter (
                  where "filingDate" <= "fiscalDate"
                    and "availableFromDate" < "fiscalDate" + (
                          case when period in ('FY', 'Q4')
                               then interval '60 days'
                               else interval '40 days'
                          end)
                ) as "tooEarly"
           from "FinancialStatement"`,
      );
      const pit = pitRows[0]!;
      ledger.check(
        "look-ahead",
        "statements available on or before their filing date",
        0,
        Number(pit.early),
        "exact-number",
      );
      ledger.check(
        "look-ahead",
        "undated filings available before the earliest deadline a filer is bound by (40 days after a quarter, 60 after a fiscal year)",
        0,
        Number(pit.tooEarly),
        "exact-number",
      );
      const impact = await runFilingDateImpact({ prisma, writer, sweep, log });
      const poison = existsSync(
        writer.path("lookahead/poisoned-future-probe.json"),
      )
        ? (JSON.parse(
            readFileSync(
              writer.path("lookahead/poisoned-future-probe.json"),
              "utf8",
            ),
          ) as Record<string, unknown>)
        : null;
      results.push(
        section("look-ahead", ledger.totals(), {
          independentOracle: true,
          endToEnd: false,
          detail: {
            statements: Number(pit.statements),
            implausibleFilingDates: Number(pit.implausible),
            filingDateImpact: impact,
            poisonedFutureProbe: poison
              ? {
                  cases: poison.cases,
                  tradesCompared: poison.tradesCompared,
                  equityCompared: poison.equityCompared,
                  failed: poison.failed,
                }
              : null,
          },
          notes: [
            "The provider leaves 2,391 statements undated; availability comes from the statutory deadline instead. See FINAL_DATA_CORRECTNESS_AUDIT.md AUD-03.",
          ],
        }),
      );
    }

    const needsNest = sections.has("api") || sections.has("signals");
    const nest = needsNest ? await createMatrixExecutionContext() : null;
    try {
      const owner = await prisma.user.findFirst({
        where: { email: resolveTestPersona("ADMIN_USER").email.toLowerCase() },
        select: { id: true },
      });
      if (sections.has("api")) {
        if (!expectations) {
          throw new Error(
            "the api section needs the backtests section in the same invocation",
          );
        }
        log("\n== backtest API (BacktestsService)");
        const result = await reconcileBacktestApi({
          prisma,
          backtests: nest!.backtests,
          ownerUserId: owner!.id,
          expectations,
          writer,
          log,
        });
        results.push(
          section("backtest-api", result.ledger.totals(), {
            independentOracle: true,
            endToEnd: false,
            detail: {
              runs: result.runs,
              summaryFields: result.summaryFields,
              annualReturns: result.annualReturns,
              curvePoints: result.curvePoints,
              tradesServed: result.tradesServed,
              maxAnnualReturnRoundingEffectPercentPoints:
                result.maxAnnualReturnRoundingEffect,
              failedRuns: result.failedRuns,
            },
          }),
        );
        writer.writeJson(
          "ui/backtest-expectations.json",
          uiBacktestExpectations(expectations),
        );
      }
      if (sections.has("signals")) {
        log("\n== monitor, signals and dashboard");
        const result = await runSignalsSection({
          prisma,
          root,
          ownerUserId: owner!.id,
          writer,
          log,
        });
        results.push(
          section("signals-dashboard", result.ledger.totals(), {
            independentOracle: true,
            endToEnd: false,
            detail: result.detail,
          }),
        );
      }
    } finally {
      await nest?.close();
    }

    if (sections.has("stock-details") || sections.has("ui")) {
      log(
        "\n== starting the audit stack (API + web on the QA-matrix database)",
      );
      const stack = new AuditStack(root, writer.path("ui/logs"));
      try {
        await stack.start(log);
        if (sections.has("stock-details")) {
          log("\n== stock details (DB → API)");
          const result = await runStockDetailsSection({
            prisma,
            writer,
            log,
            technicals: technicalReferences,
            asOf,
          });
          results.push(
            section("stock-details-api", result.ledger.totals(), {
              independentOracle: true,
              endToEnd: false,
              detail: result.detail,
            }),
          );
        }
        if (sections.has("ui")) {
          log("\n== UI reconciliation (Playwright)");
          const result = await runUiSection({ root, writer, log });
          results.push(
            section("ui", result.ledger.totals(), {
              independentOracle: true,
              endToEnd: true,
              detail: result.detail,
            }),
          );
        }
      } finally {
        await stack.stop();
        // `next dev` rewrites this generated file; the committed form is the build's.
        spawnSync("git", ["checkout", "--", "apps/web/next-env.d.ts"], {
          cwd: root,
        });
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  const git = (command: string[]): string | null => {
    try {
      return execFileSync("git", command, {
        cwd: root,
        encoding: "utf8",
      }).trim();
    } catch {
      return null;
    }
  };
  // Merge with sections recorded by an earlier invocation, so a partial rerun keeps the rest.
  const manifestPath = writer.path("manifest.json");
  const previous = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as {
        sections?: SectionResult[];
      })
    : {};
  const merged = new Map(
    (previous.sections ?? []).map((entry) => [entry.section, entry]),
  );
  for (const result of results) {
    merged.set(result.section, result);
  }
  const all = [...merged.values()];
  const totals = all.reduce(
    (sum, entry) => ({
      comparisons: sum.comparisons + entry.comparisons,
      passed: sum.passed + entry.passed,
      failed: sum.failed + entry.failed,
      skipped: sum.skipped + entry.skipped,
      tolerancePasses: sum.tolerancePasses + entry.tolerancePasses,
    }),
    { comparisons: 0, passed: 0, failed: 0, skipped: 0, tolerancePasses: 0 },
  );
  const manifest = {
    generatedAt: new Date().toISOString(),
    git: {
      commit: git(["rev-parse", "--short", "HEAD"]),
      branch: git(["rev-parse", "--abbrev-ref", "HEAD"]),
    },
    durationMs: Date.now() - started,
    context,
    totals,
    status: all.some((entry) => entry.status === "FAIL") ? "FAIL" : "PASS",
    sections: all,
  };
  writer.writeJson("manifest.json", manifest);
  writer.writeText("SUMMARY.md", renderSummary(manifest));
  log(
    `\nAudit ${manifest.status}: ${totals.comparisons} comparisons, ${totals.failed} failed, ${totals.skipped} skipped.`,
  );
  log(`Artifacts: ${writer.root}`);
  if (manifest.status !== "PASS") {
    process.exitCode = 1;
  }
}

/** The subset of runs the browser checks, with every displayed figure it must show. */
function uiBacktestExpectations(
  expectations: ReadonlyMap<string, BacktestExpectation>,
): Record<string, unknown> {
  const wanted = [
    "S01-L01-C04",
    "S04-L05-C05",
    "S10-L08-C09",
    "S05-L02-C07",
    "S08-L06-C06",
    "S02-L10-C03",
    "S09-L08-C01",
    "S03-L09-C10",
    "S07-L07-C08",
    "S06-L04-C02",
  ];
  return {
    runs: wanted
      .filter((caseId) => expectations.has(caseId))
      .map((caseId) => {
        const expectation = expectations.get(caseId)!;
        const summary = expectation.summary;
        // The numbers the API serves: money at its exact scale, ratios at the stored numeric(20,8).
        const ratio = (value: number | null): number | null =>
          value === null ? null : Number(storedAtScale(value, 8));
        return {
          caseId,
          runId: expectation.runId,
          summary: {
            portfolioReturnPercent: ratio(summary.portfolioReturnPercent),
            benchmarkReturnPercent: ratio(summary.benchmarkReturnPercent),
            alphaPercent: ratio(summary.alphaPercent),
            finalValue: Number(summary.finalValue),
            netProfit: Number(summary.netProfit),
            maxDrawdownPercent: ratio(summary.maxDrawdownPercent),
            totalTrades: summary.totalTrades,
            portfolioCagrPercent: ratio(summary.portfolioCagrPercent),
          },
          annualReturns: expectation.annualReturnsFromStoredIndex,
          tradeCount: expectation.tradeCount,
          newestTrades: expectation.newestTrades.map((trade) => ({
            date: trade.date,
            symbol: trade.symbol,
            action: trade.action,
            source: trade.source,
            levelPercentage: trade.levelPercentage,
            shares: Number(trade.shares),
            price: Number(trade.price),
            amount: Number(trade.amount),
            realizedPnl:
              trade.realizedPnl === null ? null : Number(trade.realizedPnl),
            realizedPnlPercent:
              trade.realizedPnlPercent === null
                ? null
                : Number(storedAtScale(trade.realizedPnlPercent, 8)),
          })),
          configuration: expectation.configuration,
        };
      }),
  };
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

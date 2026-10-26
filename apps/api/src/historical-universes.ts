import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getApiConfig, loadRootEnv } from "@intrinsic/config";
import { PrismaClient, type Prisma } from "@intrinsic/database";
import {
  BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS,
  BACKTEST_MAX_INDEX_UNIVERSE_SECURITIES,
} from "@intrinsic/contracts";
import {
  CATALOG_HISTORICAL_UNIVERSES,
  GICS_SECTOR_NAMES,
  HISTORICAL_UNIVERSE_LIST_ORDER_BASE,
  HISTORICAL_UNIVERSES,
  maintainedUniverseOf,
  normalizeBuyWindowRanges,
  publishedListFloor,
  requireHistoricalUniverse,
  SP500_HISTORICAL_PIT_UNIVERSE,
  type HistoricalUniverseDefinition,
  type LocalDate,
} from "@intrinsic/domain";
import { createLogger, type StructuredLogger } from "@intrinsic/observability";
import {
  generateHistoricalUniverses,
  loadGenerationPeriods,
  measurePeriods,
  type GenerationValidation,
  type MembershipRange,
} from "@intrinsic/stock-data";
import { writeIndexUniverseList } from "./index-universe/index-universe-list.js";
import { repositoryRoot } from "./qa-matrix/matrix-paths";

/**
 * The historical universes' operator command (`docs/decisions/historical-universes-v1.md` §8).
 *
 * ```bash
 * pnpm data:historical-universes -- generate --catalog        # generate and validate the 23
 * pnpm data:historical-universes -- generate --research       # the internal Top N candidates
 * pnpm data:historical-universes -- generate --keys a,b       # named universes
 * pnpm data:historical-universes -- report --out f.json       # every universe's state, in full
 * pnpm data:historical-universes -- publish <key>             # project a validated one into its List
 * pnpm data:historical-universes -- list                      # one line per universe
 * ```
 *
 * Nothing here reaches the provider: every input is PostgreSQL, loaded by `data:index-universe`.
 * Generation is idempotent — a universe whose inputs did not change writes nothing — and publishing
 * refuses a universe whose latest generation did not validate, an internal research universe, and
 * a List the engine could not run.
 */

const COMMANDS = ["generate", "report", "publish", "list"] as const;
type Command = (typeof COMMANDS)[number];

export type HistoricalUniversesArguments = {
  readonly command: Command;
  readonly keys: readonly string[];
  readonly out: string | null;
  /** `report` only: also write the summary tables as Markdown here. */
  readonly markdown: string | null;
  readonly concurrency: number;
};

export function parseHistoricalUniversesArguments(
  argv: readonly string[],
): HistoricalUniversesArguments {
  const [command, ...rest] = argv.filter((value) => value !== "--");
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    throw new Error(
      `Usage: historical-universes <${COMMANDS.join("|")}> [options]`,
    );
  }
  const keys = new Set<string>();
  let out: string | null = null;
  let markdown: string | null = null;
  let concurrency = 4;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] as string;
    const value = (): string => {
      const next = rest[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--keys":
        for (const key of value()
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)) {
          requireHistoricalUniverse(key);
          keys.add(key);
        }
        break;
      case "--catalog":
        for (const definition of CATALOG_HISTORICAL_UNIVERSES)
          keys.add(definition.key);
        break;
      case "--research":
        for (const definition of HISTORICAL_UNIVERSES) {
          if (definition.audience === "INTERNAL") keys.add(definition.key);
        }
        break;
      case "--all":
        for (const definition of HISTORICAL_UNIVERSES) keys.add(definition.key);
        break;
      case "--out":
        out = value();
        break;
      case "--markdown":
        markdown = value();
        break;
      case "--concurrency": {
        const number = Number(value());
        if (!Number.isInteger(number) || number <= 0) {
          throw new Error("--concurrency must be a positive integer");
        }
        concurrency = Math.min(16, number);
        break;
      }
      default:
        if (command === "publish" && !flag.startsWith("--")) {
          requireHistoricalUniverse(flag);
          keys.add(flag);
          break;
        }
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  if ((command === "generate" || command === "publish") && keys.size === 0) {
    throw new Error(
      `${command} needs universes: a key, --keys, --catalog, --research or --all`,
    );
  }
  return {
    command: command as Command,
    keys: [...keys],
    out,
    markdown,
    concurrency,
  };
}

/** The first day a universe's List carries (`publishedListFloor`). */
export function publishFloorOf(
  definition: Pick<HistoricalUniverseDefinition, "key">,
  validation: Pick<GenerationValidation, "publishFrom">,
): LocalDate | null {
  return publishedListFloor(definition.key, validation.publishFrom);
}

/** Periods clipped to start no earlier than `floor`; a period ending before it is dropped. */
export function clipPeriods(
  periods: ReadonlyMap<string, readonly MembershipRange[]>,
  floor: LocalDate,
): Map<string, MembershipRange[]> {
  const clipped = new Map<string, MembershipRange[]>();
  for (const [securityId, ranges] of periods) {
    const kept = ranges
      .filter((range) => range.endDate === null || range.endDate >= floor)
      .map((range) => ({
        startDate: range.startDate < floor ? floor : range.startDate,
        endDate: range.endDate,
      }));
    if (kept.length > 0) {
      clipped.set(securityId, kept);
    }
  }
  return clipped;
}

export class PublicationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationRefusedError";
  }
}

/** Projects a universe's latest, validated generation into its built-in List. */
export async function publishHistoricalUniverse(input: {
  readonly prisma: PrismaClient;
  readonly key: string;
  readonly logger: Pick<StructuredLogger, "info">;
  readonly now?: () => Date;
}): Promise<Record<string, unknown>> {
  const { prisma } = input;
  const definition = requireHistoricalUniverse(input.key);
  if (definition.audience !== "CATALOG") {
    throw new PublicationRefusedError(
      `${definition.key} is an internal research universe: it is generated and validated, never published`,
    );
  }
  const state = await prisma.historicalUniverse.findUnique({
    where: { key: definition.key },
    include: { latestGeneration: true },
  });
  if (state?.status === "BLOCKED") {
    throw new PublicationRefusedError(
      `${definition.key} is blocked: ${JSON.stringify(state.statusReasons)}`,
    );
  }
  const generation = state?.latestGeneration;
  if (!state || !generation) {
    throw new PublicationRefusedError(
      `${definition.key} has no generation: generate it first`,
    );
  }
  const validation = generation.validation as unknown as GenerationValidation;
  if (
    generation.status !== "COMPLETED" ||
    validation?.verdict !== "VALIDATED"
  ) {
    throw new PublicationRefusedError(
      `${definition.key}'s latest generation did not validate: ${JSON.stringify(validation?.reasons ?? [])}`,
    );
  }
  const floor = publishFloorOf(definition, validation);
  if (floor === null) {
    throw new PublicationRefusedError(
      `${definition.key} has no reliable period`,
    );
  }
  const periods = clipPeriods(
    await loadGenerationPeriods(prisma, generation.id),
    floor,
  );
  const measured = measurePeriods(periods);
  // The engine's ceilings are not raised for a dataset: a universe a backtest could never run over
  // its whole period is not published (`historical-universes-v1.md` §9).
  if (
    measured.peakSimultaneousMembers >
      BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS ||
    measured.distinctSecurities > BACKTEST_MAX_INDEX_UNIVERSE_SECURITIES
  ) {
    throw new PublicationRefusedError(
      `${definition.key} holds ${measured.distinctSecurities} securities and ${measured.peakSimultaneousMembers} at once, above the engine's ${BACKTEST_MAX_INDEX_UNIVERSE_SECURITIES} and ${BACKTEST_MAX_INDEX_UNIVERSE_CONSTITUENTS}`,
    );
  }
  const universe = maintainedUniverseOf(definition);
  const written = await writeIndexUniverseList({
    prisma,
    universe,
    members: [...periods.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([securityId, ranges]) => ({
        securityId,
        ranges: normalizeBuyWindowRanges(ranges),
      })),
    // The S&P 500 keeps the first place it always had; the rest follow in catalog order.
    displayOrder:
      definition.key === SP500_HISTORICAL_PIT_UNIVERSE.listSystemKey
        ? 0
        : HISTORICAL_UNIVERSE_LIST_ORDER_BASE[definition.category] +
          definition.displayOrder,
  });
  await prisma.historicalUniverse.update({
    where: { key: definition.key },
    data: {
      status: "PUBLISHED",
      publishedGenerationId: generation.id,
      publishedAt: (input.now ?? (() => new Date()))(),
      statusReasons: [] as unknown as Prisma.InputJsonValue,
    },
  });
  const summary = {
    key: definition.key,
    generationId: generation.id,
    publishFrom: floor,
    distinctSecurities: measured.distinctSecurities,
    peakSimultaneousMembers: measured.peakSimultaneousMembers,
    peakDate: measured.peakDate,
    list: written,
  };
  input.logger.info({ event: "historical-universe.published", ...summary });
  return summary;
}

export type HistoricalUniverseReportEntry = {
  readonly key: string;
  readonly name: string;
  readonly category: string;
  readonly audience: string;
  readonly methodologyVersion: number;
  readonly method: HistoricalUniverseDefinition["method"];
  readonly requires: readonly string[];
  readonly status: string;
  readonly statusReasons: unknown;
  readonly publishedAt: string | null;
  readonly publishedGenerationId: string | null;
  readonly generation: {
    readonly id: string;
    readonly completedAt: string | null;
    readonly inputDigest: string | null;
    readonly summary: unknown;
    readonly verdict: string | null;
    readonly reliableFrom: string | null;
    readonly publishFrom: string | null;
    readonly reasons: readonly unknown[];
    /** Disclosures that do not gate publication: a classified universe's coverage. */
    readonly warnings: readonly unknown[];
    readonly byYear: readonly unknown[];
  } | null;
};

/** Every universe's state, as PostgreSQL holds it. Counts and dates only, never a price. */
export async function historicalUniversesReport(
  prisma: PrismaClient,
): Promise<HistoricalUniverseReportEntry[]> {
  const states = await prisma.historicalUniverse.findMany({
    include: { latestGeneration: true },
  });
  const byKey = new Map(states.map((state) => [state.key, state]));
  return HISTORICAL_UNIVERSES.map((definition) => {
    const state = byKey.get(definition.key);
    const generation = state?.latestGeneration ?? null;
    const validation =
      generation?.validation as unknown as GenerationValidation | null;
    return {
      key: definition.key,
      name: definition.name,
      category: definition.category,
      audience: definition.audience,
      methodologyVersion: definition.methodologyVersion,
      method: definition.method,
      requires: definition.requires,
      status: state?.status ?? "DRAFT",
      statusReasons: state?.statusReasons ?? null,
      publishedAt: state?.publishedAt?.toISOString() ?? null,
      publishedGenerationId: state?.publishedGenerationId ?? null,
      generation: generation
        ? {
            id: generation.id,
            completedAt: generation.completedAt?.toISOString() ?? null,
            inputDigest: generation.inputDigest,
            summary: generation.summary,
            verdict: validation?.verdict ?? null,
            reliableFrom: validation?.reliableFrom ?? null,
            publishFrom: validation?.publishFrom ?? null,
            reasons: validation?.reasons ?? [],
            warnings: validation?.warnings ?? [],
            byYear: validation?.byYear ?? [],
          }
        : null,
    };
  });
}

function describeMethod(method: HistoricalUniverseDefinition["method"]): {
  parent: string;
  metric: string;
  n: string;
  frequency: string;
} {
  if (method.kind === "INDEX_MEMBERSHIP") {
    return {
      parent: method.indexKey,
      metric: "membership",
      n: "all",
      frequency: "as changed",
    };
  }
  if (method.kind === "SECTOR") {
    return {
      parent: method.indexKey,
      metric: `GICS ${method.sector}`,
      n: "all",
      frequency: "daily",
    };
  }
  if (method.kind === "CLASSIFICATION") {
    return {
      parent: method.indexKey,
      metric: `current sector (retrospective): ${method.sectors.map((sector) => GICS_SECTOR_NAMES[sector]).join(", ")}`,
      n: "all",
      frequency: "as changed",
    };
  }
  return {
    parent:
      method.parent.kind === "INDEX"
        ? method.parent.indexKey
        : method.parent.key,
    metric: `${method.order === "LOWEST" ? "lowest " : ""}${method.metric}`,
    n:
      "count" in method.select
        ? String(method.select.count)
        : `${Math.round(method.select.fraction * 100)}%`,
    frequency: method.reconstitution.frequency,
  };
}

type YearRow = {
  readonly year: string;
  readonly minDataCoverage: number | null;
  readonly minMetricAvailability: number | null;
  readonly failing: number;
};

const percent = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${(value * 100).toFixed(0)} %`;

/**
 * The report's summary as Markdown: one row per universe, and its coverage at five-year steps.
 * Counts, dates and ratios only.
 */
export function renderReportMarkdown(
  entries: readonly HistoricalUniverseReportEntry[],
): string {
  const lines: string[] = [];
  const years = ["1996", "2001", "2006", "2011", "2016", "2021", "2026"];
  for (const audience of ["CATALOG", "INTERNAL"] as const) {
    lines.push(
      `### ${audience === "CATALOG" ? "Catalog universes" : "Internal research candidates"}`,
      "",
      "| Universe | Parent | Metric | N | Frequency | Status | Reliable from | Distinct | Peak | Reasons |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of entries.filter((row) => row.audience === audience)) {
      const method = describeMethod(entry.method);
      const summary = entry.generation?.summary as
        | { distinctSecurities?: number; peakSimultaneousMembers?: number }
        | undefined;
      const reasons = [
        ...((entry.generation?.reasons ?? []) as { code: string }[]).map(
          (reason) => reason.code,
        ),
        ...(entry.status === "BLOCKED"
          ? ["HISTORICAL_SECTOR_CLASSIFICATION unavailable"]
          : []),
      ];
      lines.push(
        `| \`${entry.key}\` | ${method.parent} | ${method.metric} | ${method.n} | ${method.frequency} | ${entry.status} | ${entry.generation?.reliableFrom ?? "—"} | ${summary?.distinctSecurities ?? "—"} | ${summary?.peakSimultaneousMembers ?? "—"} | ${reasons.join(", ") || "—"} |`,
      );
    }
    lines.push(
      "",
      `Lowest data coverage / metric availability of the year's reconstitutions (${audience === "CATALOG" ? "catalog" : "research"}):`,
      "",
      `| Universe | ${years.join(" | ")} |`,
      `| --- | ${years.map(() => "---").join(" | ")} |`,
    );
    for (const entry of entries.filter(
      (row) => row.audience === audience && row.generation,
    )) {
      const byYear = new Map(
        ((entry.generation?.byYear ?? []) as YearRow[]).map((row) => [
          row.year,
          row,
        ]),
      );
      lines.push(
        `| \`${entry.key}\` | ${years
          .map((year) => {
            const row = byYear.get(year);
            return row
              ? `${percent(row.minDataCoverage)} / ${percent(row.minMetricAvailability)}`
              : "—";
          })
          .join(" | ")} |`,
      );
    }
    lines.push("");
  }
  lines.push(...renderClassificationMarkdown(entries));
  return `${lines.join("\n")}\n`;
}

type ClassificationReport = {
  readonly mappingVersion?: number;
  readonly asOf?: {
    readonly earliest?: string | null;
    readonly latest?: string | null;
    readonly withoutProfileSync?: number;
  };
  readonly indexSecurities?: number;
  readonly classifiedSecurities?: number;
  readonly bySector?: Readonly<Record<string, number>>;
  readonly unclassified?: readonly {
    readonly symbol: string;
    readonly name: string;
    readonly reason: string;
    readonly stored: string | null;
  }[];
  readonly byYear?: readonly {
    readonly year: string;
    readonly indexLines: number;
    readonly indexMembers: number;
    readonly classified: number;
    readonly unclassified: number;
    readonly groupMembers: number;
    readonly groupPriced: number;
    readonly constituentCoverage: number | null;
    readonly classifiedShare: number | null;
    readonly priceCoverage: number | null;
    readonly minPriceCoverage: number | null;
  }[];
};

/**
 * Each retrospectively classified universe's classification audit: its source, mapping version and
 * as-of, its members by sector, every unclassified index security, and its coverage by year.
 */
function renderClassificationMarkdown(
  entries: readonly HistoricalUniverseReportEntry[],
): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    const summary = entry.generation?.summary as
      | {
          classification?: ClassificationReport;
          distinctSecurities?: number;
          peakSimultaneousMembers?: number;
          peakDate?: string | null;
        }
      | undefined;
    const audit = summary?.classification;
    if (!audit) continue;
    const warnings = (entry.generation?.warnings ?? []) as {
      code: string;
      detail: string;
    }[];
    lines.push(
      `### \`${entry.key}\` — classification and coverage`,
      "",
      `- Classification: current FMP company-profile sector, applied retrospectively; mapping version ${audit.mappingVersion ?? "—"}; profiles synchronized ${audit.asOf?.earliest ?? "—"} to ${audit.asOf?.latest ?? "—"} (${audit.asOf?.withoutProfileSync ?? 0} classified without a recorded profile synchronization).`,
      `- Index securities ${audit.indexSecurities ?? "—"}, classified ${audit.classifiedSecurities ?? "—"}; this universe ${summary?.distinctSecurities ?? "—"} distinct, peak ${summary?.peakSimultaneousMembers ?? "—"} on ${summary?.peakDate ?? "—"}.`,
      `- By sector: ${Object.entries(audit.bySector ?? {})
        .map(([sector, count]) => `${sector} ${count}`)
        .join(", ")}.`,
      `- Unclassified (in no group): ${
        (audit.unclassified ?? [])
          .map(
            (row) =>
              `${row.symbol} (${row.name}; ${row.reason}${row.stored ? `: "${row.stored}"` : ""})`,
          )
          .join(", ") || "none"
      }.`,
      ...warnings.map((warning) => `- ${warning.code}: ${warning.detail}`),
      "",
      "| Year | Index lines | Members | Classified | Unclassified | Group | Group priced | Constituent coverage | Classified | Price coverage (min) |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...(audit.byYear ?? []).map(
        (row) =>
          `| ${row.year} | ${row.indexLines} | ${row.indexMembers} | ${row.classified} | ${row.unclassified} | ${row.groupMembers} | ${row.groupPriced} | ${percent(row.constituentCoverage)} | ${percent(row.classifiedShare)} | ${percent(row.priceCoverage)} (${percent(row.minPriceCoverage)}) |`,
      ),
      "",
    );
  }
  return lines;
}

async function main(): Promise<number> {
  loadRootEnv();
  const apiConfig = getApiConfig();
  const logger = createLogger({
    service: "api",
    level: apiConfig.logLevel,
    environment: apiConfig.environment,
    base: { component: "historical-universes" },
  });
  const args = parseHistoricalUniversesArguments(process.argv.slice(2));
  const prisma = new PrismaClient();
  const write = (value: unknown) => {
    if (args.out) {
      const path = resolve(repositoryRoot(), args.out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    }
  };
  try {
    switch (args.command) {
      case "generate": {
        const outcomes = await generateHistoricalUniverses({
          prisma,
          keys: args.keys,
          concurrency: args.concurrency,
          logger,
        });
        write(outcomes);
        print(
          outcomes.map((outcome) =>
            "validation" in outcome
              ? {
                  key: outcome.key,
                  outcome: outcome.outcome,
                  verdict: outcome.validation.verdict,
                  reliableFrom: outcome.validation.reliableFrom,
                  reasons: outcome.validation.reasons.map(
                    (reason) => reason.code,
                  ),
                  distinct: outcome.summary.distinctSecurities,
                  peak: outcome.summary.peakSimultaneousMembers,
                }
              : outcome,
          ),
        );
        break;
      }
      case "publish": {
        const results: unknown[] = [];
        for (const key of args.keys) {
          try {
            results.push(
              await publishHistoricalUniverse({ prisma, key, logger }),
            );
          } catch (error) {
            if (!(error instanceof PublicationRefusedError)) throw error;
            results.push({ key, refused: error.message });
          }
        }
        write(results);
        print(results);
        break;
      }
      case "report": {
        const report = await historicalUniversesReport(prisma);
        write({ generatedAt: new Date().toISOString(), universes: report });
        if (args.markdown) {
          const path = resolve(repositoryRoot(), args.markdown);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, renderReportMarkdown(report));
        }
        print(
          report.map((entry) => ({
            key: entry.key,
            status: entry.status,
            verdict: entry.generation?.verdict ?? null,
            reliableFrom: entry.generation?.reliableFrom ?? null,
          })),
        );
        break;
      }
      case "list": {
        for (const entry of await historicalUniversesReport(prisma)) {
          process.stdout.write(
            `${entry.key.padEnd(34)} ${entry.audience.padEnd(8)} ${entry.status.padEnd(9)} ${String(entry.generation?.verdict ?? "-").padEnd(9)} ${entry.generation?.reliableFrom ?? "-"}\n`,
          );
        }
        break;
      }
    }
    return 0;
  } catch (error) {
    logger.error({
      event: "historical-universes.failed",
      command: args.command,
      err: error,
    });
    return 1;
  } finally {
    await prisma.$disconnect();
  }
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && process.argv[1].includes("historical-universes")) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(2);
    },
  );
}

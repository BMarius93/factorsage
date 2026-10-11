import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import {
  convertGroupScopes,
  type GroupScopeConversionReport,
  type GroupScopeStrategyReport,
} from "./alternative-data/group-scope-conversion";

/**
 * `pnpm strategies:convert-group-scopes` — report, and with `--apply` perform, the conversion of
 * strategies that still name a Congress group into ones that select the members directly.
 *
 * **It is a dry run unless told otherwise.** With no flags it reads `DATABASE_URL`, writes nothing,
 * and prints what an apply would do: which strategies convert, which are skipped and why, and what
 * each Monitor bound to a converting strategy would reset.
 *
 * Writing takes three deliberate statements, because this runs against whatever database the
 * environment names:
 *
 * - `--apply` — write.
 * - `--confirm-database <name>` — required with `--apply`, and must equal the name of the database
 *   actually connected to. A run pointed at the wrong environment stops here.
 * - `--include-monitored` — also convert strategies that have a Monitor. Without it they are
 *   skipped as `MONITORED`, because converting one resets the Monitor levels the report lists.
 *
 * `--strategy <id>` (repeatable) restricts the run; `--json` prints the report as one JSON document.
 *
 * `docs/development/congress-group-scope-conversion.md` is the runbook.
 */

export type ConvertArguments = {
  readonly apply: boolean;
  readonly includeMonitored: boolean;
  readonly json: boolean;
  readonly confirmDatabase?: string;
  readonly strategyIds: readonly string[];
};

export function parseConvertArguments(
  argv: readonly string[],
): ConvertArguments {
  let apply = false;
  let includeMonitored = false;
  let json = false;
  let confirmDatabase: string | undefined;
  const strategyIds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--apply":
        apply = true;
        break;
      case "--include-monitored":
        includeMonitored = true;
        break;
      case "--json":
        json = true;
        break;
      case "--confirm-database":
        if (!value || value.startsWith("--")) {
          throw new Error("--confirm-database needs the database's name");
        }
        confirmDatabase = value;
        index += 1;
        break;
      case "--strategy":
        if (!value || value.startsWith("--")) {
          throw new Error("--strategy needs a strategy id");
        }
        strategyIds.push(value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument ${String(flag)}`);
    }
  }

  if (includeMonitored && !apply) {
    throw new Error(
      "--include-monitored only means something with --apply; a dry run already reports every Monitor",
    );
  }
  return {
    apply,
    includeMonitored,
    json,
    ...(confirmDatabase === undefined ? {} : { confirmDatabase }),
    strategyIds: [...new Set(strategyIds)],
  };
}

/** The database a connection string names, without anything else the string carries. */
export function databaseNameOf(databaseUrl: string): string {
  return databaseUrl.split("?")[0]!.split("/").pop() ?? "";
}

/**
 * Refuses a write that has not named the database it is about to change.
 *
 * The name, never the URL: the confirmation is typed by a person and printed in a terminal, and a
 * connection string carries a password.
 */
export function assertApplyConfirmed(
  args: Pick<ConvertArguments, "apply" | "confirmDatabase">,
  databaseName: string,
): void {
  if (!args.apply) {
    return;
  }
  if (args.confirmDatabase === undefined) {
    throw new Error(
      `--apply writes to the database \`${databaseName}\`. Repeat the command with ` +
        `--confirm-database ${databaseName} to confirm that is the one you mean.`,
    );
  }
  if (args.confirmDatabase !== databaseName) {
    throw new Error(
      `--confirm-database names \`${args.confirmDatabase}\`, but this environment is connected to ` +
        `\`${databaseName}\`. Nothing was changed.`,
    );
  }
}

function describeStrategy(strategy: GroupScopeStrategyReport): string[] {
  const lines = [
    `${strategy.outcome.padEnd(11)} ${strategy.strategyId}  "${strategy.name}" ` +
      `(${strategy.ownership}, version ${strategy.versionNumber}` +
      `${strategy.convertedVersionNumber === undefined ? "" : ` -> ${strategy.convertedVersionNumber}`})`,
  ];
  if (strategy.skipReasons.length > 0) {
    lines.push(`    skipped: ${strategy.skipReasons.join(", ")}`);
  }
  if (strategy.detail) {
    lines.push(`    detail:  ${strategy.detail}`);
  }
  for (const group of strategy.groups) {
    lines.push(
      `    group ${group.groupId} ${group.name === null ? "(gone)" : `"${group.name}"`}: ` +
        `${group.memberCount} member(s), ${group.status}`,
    );
  }
  for (const monitor of strategy.monitors) {
    lines.push(
      `    monitor ${monitor.monitorId} "${monitor.name}" (${monitor.ownership}, ` +
        `${monitor.evaluated ? "evaluated" : "not evaluated"}): ` +
        `${monitor.levelsReset} level(s) reset, ${monitor.statesReset} state row(s), ` +
        `${monitor.activeSignalsClosed} active Signal(s) closed, ` +
        `${monitor.pendingSetupsDropped} pending setup(s) dropped`,
    );
  }
  return lines;
}

export function describeReport(
  report: GroupScopeConversionReport,
  databaseName: string,
): string[] {
  const applied = report.mode === "APPLY";
  const row = (label: string, value: number): string =>
    `${`${label}:`.padEnd(35)}${value}`;
  const lines = [
    `Congress group scope conversion — ${applied ? "APPLIED" : "DRY RUN, nothing was changed"}`,
    `Database: ${databaseName}`,
    "",
    row("Strategies scanned", report.strategiesScanned),
    row("Naming a Congress group", report.strategiesWithGroupScope),
    applied
      ? row("Converted (new version appended)", report.converted)
      : row("Would convert", report.convertible),
    row("Skipped", report.skipped),
  ];
  for (const [reason, count] of Object.entries(report.skippedByReason)) {
    lines.push(`    ${reason.padEnd(24)} ${count}`);
  }
  lines.push(
    `${row(applied ? "Monitors reset" : "Monitors that would reset", report.monitorsAffected)} ` +
      `(${report.statesReset} state row(s), ${report.activeSignalsClosed} active Signal(s) closed as LOGIC_CHANGED)`,
  );
  if (report.strategies.length > 0) {
    lines.push("");
    for (const strategy of report.strategies) {
      lines.push(...describeStrategy(strategy));
    }
  }
  if (!applied && report.convertible > 0) {
    lines.push(
      "",
      "To convert: repeat with --apply --confirm-database <name>, and --include-monitored for " +
        "strategies that have a Monitor.",
    );
  }
  return lines;
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseConvertArguments(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  const databaseName = databaseNameOf(databaseUrl);
  assertApplyConfirmed(args, databaseName);

  const prisma = new PrismaClient();
  try {
    await prisma.$connect();
    const report = await convertGroupScopes(prisma, {
      apply: args.apply,
      includeMonitored: args.includeMonitored,
      ...(args.strategyIds.length > 0 ? { strategyIds: args.strategyIds } : {}),
    });
    if (args.json) {
      console.log(
        JSON.stringify({ database: databaseName, ...report }, null, 2),
      );
    } else {
      for (const line of describeReport(report, databaseName)) {
        console.log(line);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && process.argv[1].includes("convert-group-scopes")) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`Congress group scope conversion failed: ${message}`);
    process.exitCode = 1;
  });
}

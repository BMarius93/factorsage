import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRootEnv } from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { mapFmpStockSplits, type FmpStockSplitDto } from "@intrinsic/fmp";
import { PrismaStockDataStore } from "@intrinsic/stock-data";
import {
  createValuationOracle,
  ORACLE_VALUATION_REASONS,
  ORACLE_VALUATION_RATIO_IDS,
} from "../oracle/valuation-ratios";
import { auditCacheParity } from "./cache-parity";
import { ComparisonTally } from "./compare";
import { runDifferential } from "./differential";
import { auditRealData, readOracleRows, REAL_DATA_LAYERS } from "./real-data";

/**
 * The Valuation Ratios V1 audit's command line (`docs/valuation-ratios-audit/REPORT.md`).
 *
 * ```bash
 * pnpm audit:valuation -- generated --seeds=1-2000
 * pnpm audit:valuation -- provision-copy --database-url=<copy> --splits-dir=<dir> --synced-at=<instant>
 * pnpm audit:valuation -- real --database-url=<copy> --redis-url=redis://localhost:6379/6
 * pnpm audit:valuation -- http --database-url=<copy> --api=http://localhost:3001
 * pnpm audit:valuation -- browser-expectations --database-url=<copy> --symbols=HON,WDC
 * pnpm audit:valuation -- cache-parity --database-url=<copy> --redis-url=redis://localhost:6379/6
 * ```
 *
 * `http` asks a running API — started against the copy (`TEST_DATABASE_URL=<copy> pnpm
 * dev:api:e2e`, the hermetic launcher: fixture FMP, egress guard) — for every ratio of every security
 * over the range the `real` run served, and holds every row to the reference. `browser-expectations`
 * writes the reference's readings of the newest year of the named securities, to the git-ignored
 * `.debug/valuation-audit/`, for the Playwright audit spec
 * (`apps/web/e2e/audit/valuation-oracle.audit.spec.ts`) to hold the hover legend to.
 *
 * `generated` needs nothing but the code. `provision-copy` writes the provider's split lists, as
 * frozen JSON files (`splits-<SYMBOL>.json`, the `stable/splits` payload), into a **copy** of the
 * development database through the product's own mapper and store write, for the securities whose
 * list was never read; it refuses the development, test and QA-matrix databases. `real` only reads:
 * it compares every stored session of every security with statements, through every production
 * layer, with the reference, and never reaches the provider. Each writes its evidence as JSON under
 * `docs/valuation-ratios-audit/evidence/`.
 */

loadRootEnv();

const EVIDENCE = resolve(
  __dirname,
  "../../../../../docs/valuation-ratios-audit/evidence",
);

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function write(name: string, value: unknown): void {
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, name), `${JSON.stringify(value, null, 2)}\n`);
  console.log(`wrote ${join(EVIDENCE, name)}`);
}

function refuseSharedDatabase(url: string): void {
  const shared = [
    process.env.DATABASE_URL,
    process.env.TEST_DATABASE_URL,
    process.env.QA_MATRIX_DATABASE_URL,
  ].filter((value): value is string => Boolean(value));
  const name = (value: string) => new URL(value).pathname.replace(/^\//, "");
  if (shared.some((value) => name(value) === name(url))) {
    throw new Error(
      `refusing ${name(url)}: the valuation audit runs on a copy, never on the development, test or QA-matrix database`,
    );
  }
}

async function generated(): Promise<void> {
  const [first, last] = (option("seeds") ?? "1-2000")
    .split("-")
    .map(Number) as [number, number];
  const seeds = Array.from(
    { length: last - first + 1 },
    (_, index) => first + index,
  );
  const started = Date.now();
  const result = runDifferential(seeds, { keepFailures: 50 });
  const summary = result.tally.summary();
  write("generated.json", {
    seeds: `${first}-${last}`,
    histories: result.histories,
    sessions: result.sessions,
    modes: [
      "closed session (own statements)",
      "Monitor provisional (previous session's statements)",
    ],
    durationMs: Date.now() - started,
    ...summary,
    soleRuleCells: Object.fromEntries(
      ORACLE_VALUATION_REASONS.map((reason) => [
        reason,
        result.soleRuleCells.get(reason) ?? 0,
      ]),
    ),
    features: Object.fromEntries([...result.features.entries()].sort()),
    failures: result.tally.failures,
  });
  const failed =
    result.tally.total("FALSE_AVAILABLE") +
    result.tally.total("FALSE_UNAVAILABLE") +
    result.tally.total("VALUE_MISMATCH");
  console.log(
    `generated: ${result.tally.total()} comparisons over ${result.histories} histories, ${failed} failed`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

async function provisionCopy(): Promise<void> {
  const url = option("database-url");
  const directory = option("splits-dir");
  const syncedAt = option("synced-at");
  if (!url || !directory || !syncedAt) {
    throw new Error(
      "provision-copy needs --database-url, --splits-dir and --synced-at",
    );
  }
  refuseSharedDatabase(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const store = new PrismaStockDataStore(prisma);
    const securities = await prisma.$queryRawUnsafe<
      { id: string; symbol: string }[]
    >(
      `select s.id, s.symbol from "Security" s
        where s.id in (select distinct "securityId" from "FinancialStatement")
          and not exists (select 1 from "StockDatasetState" d
                           where d."securityId" = s.id and d.dataset = 'STOCK_SPLIT')
        order by s.symbol`,
    );
    const files = new Set(readdirSync(directory));
    for (const security of securities) {
      const file = `splits-${security.symbol}.json`;
      if (!files.has(file)) {
        throw new Error(`no frozen split list for ${security.symbol}`);
      }
      const payload = JSON.parse(
        readFileSync(join(directory, file), "utf8"),
      ) as FmpStockSplitDto[];
      const splits = mapFmpStockSplits(security.id, payload);
      await store.replaceStockSplits({
        securityId: security.id,
        splits,
        syncedAt,
      });
      console.log(`${security.symbol}: ${splits.length} entries`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function real(): Promise<void> {
  const url = option("database-url");
  const redisUrl = option("redis-url");
  if (!url || !redisUrl) {
    throw new Error("real needs --database-url and --redis-url");
  }
  refuseSharedDatabase(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const started = Date.now();
  try {
    const securities = await prisma.$queryRawUnsafe<
      { id: string; symbol: string }[]
    >(
      `select s.id, s.symbol from "Security" s
        where s.id in (select distinct "securityId" from "FinancialStatement") order by s.symbol`,
    );
    const only = option("symbols")?.split(",");
    const selected = securities.filter(
      (security) => !only || only.includes(security.symbol),
    );
    const audit = await auditRealData({
      prisma,
      redisUrl,
      namespace: `stock-data:v2:valuation-audit:${Date.now()}`,
      securityIds: selected.map((security) => security.id),
      log: (line) => console.log(line),
    });
    const layers = Object.fromEntries(
      REAL_DATA_LAYERS.map((layer) => [
        layer,
        {
          ...(audit.tallies.get(layer)?.summary() ?? {}),
          bitDisagreementsWithPure: audit.layerDisagreements.get(layer) ?? 0,
          failures: audit.tallies.get(layer)?.failures ?? [],
        },
      ]),
    );
    write(option("output") ?? "real-data.json", {
      database: new URL(url).pathname.replace(/^\//, ""),
      securities: audit.securities,
      storedSessions: audit.sessions,
      durationMs: Date.now() - started,
      providerCalls: audit.providerCalls,
      refusedReads: audit.refusedReads,
      divergences: Object.fromEntries(audit.divergences),
      layers,
      perSecurity: Object.fromEntries(audit.perSecurity),
      intervals: Object.fromEntries(audit.intervals),
    });
    let failed = 0;
    for (const layer of REAL_DATA_LAYERS) {
      const tally = audit.tallies.get(layer);
      const bad =
        (tally?.total("FALSE_AVAILABLE") ?? 0) +
        (tally?.total("FALSE_UNAVAILABLE") ?? 0) +
        (tally?.total("VALUE_MISMATCH") ?? 0);
      failed += bad;
      console.log(
        `${layer}: ${tally?.total() ?? 0} comparisons, ${bad} failed, ${audit.layerDisagreements.get(layer) ?? 0} bit disagreements with pure`,
      );
    }
    console.log(
      `refused reads: ${audit.refusedReads.length}; provider calls: ${audit.providerCalls.length}`,
    );
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

async function http(): Promise<void> {
  const url = option("database-url");
  const api = option("api") ?? "http://localhost:3001";
  if (!url) {
    throw new Error("http needs --database-url");
  }
  refuseSharedDatabase(url);
  const served = JSON.parse(
    readFileSync(join(EVIDENCE, "real-data.json"), "utf8"),
  ) as { perSecurity: Record<string, { serviceFrom: string }> };
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const tally = new ComparisonTally();
  const statuses: Record<string, number> = {};
  const refused: { symbol: string; ratio: string; status: number }[] = [];
  let rowsChecked = 0;
  let dateMismatches = 0;
  const sessionDifferences: {
    symbol: string;
    ratio: string;
    responseOnly: string[];
    storedOnly: string[];
  }[] = [];
  try {
    const securities = await prisma.$queryRawUnsafe<
      { id: string; symbol: string }[]
    >(
      `select s.id, s.symbol from "Security" s
        where s.id in (select distinct "securityId" from "FinancialStatement") order by s.symbol`,
    );
    const only = option("symbols")?.split(",");
    for (const security of securities.filter(
      (row) => !only || only.includes(row.symbol),
    )) {
      const rows = await readOracleRows(prisma, security.id);
      const oracle = createValuationOracle(rows.security);
      const from =
        served.perSecurity[rows.symbol]?.serviceFrom ?? rows.coverageEnd;
      const to = rows.coverageEnd;
      const stored = rows.sessions.filter(
        (session) => session.date >= from && session.date <= to,
      );
      for (const ratio of ORACLE_VALUATION_RATIO_IDS) {
        const response = await fetch(
          `${api}/stocks/${encodeURIComponent(rows.symbol)}/valuation-ratios/daily?from=${from}&to=${to}&ratio=${ratio}`,
        );
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
        if (response.status !== 200) {
          refused.push({ symbol: rows.symbol, ratio, status: response.status });
          continue;
        }
        const body = (await response.json()) as {
          date: string;
          value?: number;
        }[];
        if (
          body.length !== stored.length ||
          body.some((row, index) => row.date !== stored[index]?.date)
        ) {
          dateMismatches += 1;
          const bodyDates = new Set(body.map((row) => row.date));
          const storedDates = new Set(stored.map((session) => session.date));
          sessionDifferences.push({
            symbol: rows.symbol,
            ratio,
            responseOnly: [...bodyDates]
              .filter((date) => !storedDates.has(date))
              .slice(0, 5),
            storedOnly: [...storedDates]
              .filter((date) => !bodyDates.has(date))
              .slice(0, 5),
          });
        }
        const closes = new Map(
          stored.map((session) => [session.date, session.close]),
        );
        for (const row of body) {
          const close = closes.get(row.date);
          if (close === undefined) {
            continue;
          }
          rowsChecked += 1;
          tally.record(
            `${rows.symbol} ${row.date}`,
            ratio,
            row.value === undefined ? Number.NaN : row.value,
            oracle.reading(row.date, close)[ratio],
          );
        }
      }
      console.log(`${rows.symbol}: ${stored.length} sessions from ${from}`);
    }
  } finally {
    await prisma.$disconnect();
  }
  write(option("output") ?? "http.json", {
    api,
    statuses,
    refused,
    rowsChecked,
    responsesWithOtherSessions: dateMismatches,
    sessionDifferences,
    ...tally.summary(),
    failures: tally.failures,
  });
  const failed =
    tally.total("FALSE_AVAILABLE") +
    tally.total("FALSE_UNAVAILABLE") +
    tally.total("VALUE_MISMATCH") +
    dateMismatches;
  console.log(
    `http: ${tally.total()} cells, ${failed} failed, statuses ${JSON.stringify(statuses)}`,
  );
  process.exitCode = failed === 0 ? 0 : 1;
}

async function browserExpectations(): Promise<void> {
  const url = option("database-url");
  const symbols = option("symbols")?.split(",") ?? [];
  if (!url || symbols.length === 0) {
    throw new Error("browser-expectations needs --database-url and --symbols");
  }
  refuseSharedDatabase(url);
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const expectations: Record<
    string,
    Record<string, Record<string, number | null>>
  > = {};
  try {
    for (const symbol of symbols) {
      const [security] = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `select id from "Security" where symbol = $1`,
        symbol,
      );
      if (!security) {
        throw new Error(`no security ${symbol}`);
      }
      const rows = await readOracleRows(prisma, security.id);
      const oracle = createValuationOracle(rows.security);
      const recent = rows.sessions.slice(-300);
      expectations[symbol] = Object.fromEntries(
        ORACLE_VALUATION_RATIO_IDS.map((ratio) => [
          ratio,
          Object.fromEntries(
            recent.map((session) => {
              const outcome = oracle.reading(session.date, session.close)[
                ratio
              ];
              return [session.date, outcome.available ? outcome.double : null];
            }),
          ),
        ]),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
  // Thousands of ratios computed from licensed provider data: an input for the browser audit spec,
  // kept out of the repository with the other local audit inputs.
  const target = resolve(__dirname, "../../../../../.debug/valuation-audit");
  mkdirSync(target, { recursive: true });
  const path = join(target, option("output") ?? "browser-expectations.json");
  writeFileSync(path, `${JSON.stringify(expectations, null, 2)}\n`);
  console.log(`wrote ${path}`);
}

async function cacheParity(): Promise<void> {
  const url = option("database-url");
  const redisUrl = option("redis-url");
  if (!url || !redisUrl) {
    throw new Error("cache-parity needs --database-url and --redis-url");
  }
  refuseSharedDatabase(url);
  const symbols = (
    option("symbols") ?? "HON,IBM,WDC,AAPL,MMM,MRK,AXP,DIS,GOOGL,MSFT"
  ).split(",");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const securities = await prisma.$queryRawUnsafe<
      { id: string; symbol: string }[]
    >(
      `select id, symbol from "Security" where symbol = any($1) order by symbol`,
      symbols,
    );
    const report = await auditCacheParity({
      prisma,
      redisUrl,
      securityIds: securities.map((security) => security.id),
      log: (line) => console.log(line),
    });
    write(option("output") ?? "cache-parity.json", report);
    console.log(
      `cache parity: ${report.reads} reads, ${report.mismatches.length} mismatches, ${report.providerCalls.length} provider calls, ${report.valuationKeys.length} valuation keys`,
    );
    process.exitCode =
      report.mismatches.length +
        report.providerCalls.length +
        report.valuationKeys.length ===
      0
        ? 0
        : 1;
  } finally {
    await prisma.$disconnect();
  }
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  generated,
  "provision-copy": provisionCopy,
  real,
  http,
  "browser-expectations": browserExpectations,
  "cache-parity": cacheParity,
};
const run = command ? commands[command] : undefined;
if (!run) {
  console.error(
    `usage: run-valuation-audit <${Object.keys(commands).join("|")}> [options]`,
  );
  process.exit(2);
}
run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

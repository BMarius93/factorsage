import {
  getAlternativeDataConfig,
  getApiConfig,
  getFmpConfig,
  getFmpTrafficConfig,
  getRedisConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import { FmpClient } from "@intrinsic/fmp";
import { createLogger } from "@intrinsic/observability";
import {
  ALTERNATIVE_DATA_DATASETS,
  ALTERNATIVE_DATA_DOMAINS,
  CanonicalAlternativeDataService,
  createStockDataRedisClient,
  PrismaAlternativeDataStore,
  RedisFmpRequestGate,
  type AlternativeDataDomain,
} from "@intrinsic/stock-data";
import { QA_MATRIX_SECURITIES } from "@intrinsic/testing";

/**
 * Ingests insider and congressional disclosure history for a universe, through the ordinary loader.
 *
 * The counterpart of `data:resync` for the two alternative-data domains, and it exists for the same
 * reason: the product's reads are lazy, so the history a symbol holds is whatever some earlier page
 * view or backtest happened to need. That is no way to say "we intend this universe to hold its
 * disclosure history now, deliberately, before a validation sweep copies it".
 *
 * It calls `CanonicalAlternativeDataService.ensureIngested`, so the shared `RedisFmpRequestGate`, the
 * content-addressed writes, the actor upserts and the coverage bookkeeping are all the canonical
 * implementations — an ingested security is indistinguishable from one a Monitor cycle materialized.
 * It then reports what each domain now covers, because an ingest nobody verified is a claim rather
 * than a result.
 *
 * `--force` re-reads the newest pages even inside the freshness window. It never destroys anything:
 * rows are content-addressed, so a re-ingest of unchanged history inserts nothing, and the coverage
 * floor only ever moves downwards.
 *
 * Usage:
 *
 * ```bash
 * pnpm data:alt-data:ingest --matrix
 * pnpm data:alt-data:ingest --symbol AAPL --symbol NVDA --domain CONGRESS
 * pnpm data:alt-data:ingest --matrix --verify-only
 * ```
 */

type IngestArguments = {
  readonly symbols: readonly string[];
  readonly domains: readonly AlternativeDataDomain[];
  /** Report what the stored data covers without asking the provider for anything. */
  readonly verifyOnly: boolean;
  /** Ignore the freshness window and re-read the newest pages. */
  readonly force: boolean;
};

export function parseIngestArguments(
  argv: readonly string[],
  matrixSymbols: readonly string[],
): IngestArguments {
  const symbols: string[] = [];
  const domains: AlternativeDataDomain[] = [];
  let verifyOnly = false;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--symbol":
        if (!value) {
          throw new Error("--symbol needs a ticker, e.g. --symbol AAPL");
        }
        symbols.push(value.toUpperCase());
        index += 1;
        break;
      case "--matrix":
        symbols.push(...matrixSymbols);
        break;
      case "--domain": {
        const domain = value?.toUpperCase();
        if (
          !domain ||
          !(ALTERNATIVE_DATA_DOMAINS as readonly string[]).includes(domain)
        ) {
          throw new Error(
            `--domain needs one of ${ALTERNATIVE_DATA_DOMAINS.join(", ")}`,
          );
        }
        domains.push(domain as AlternativeDataDomain);
        index += 1;
        break;
      }
      case "--verify-only":
        verifyOnly = true;
        break;
      case "--force":
        force = true;
        break;
      default:
        if (flag?.startsWith("--")) {
          throw new Error(`Unknown flag ${flag}`);
        }
    }
  }

  if (symbols.length === 0) {
    throw new Error(
      "Nothing to ingest. Pass --matrix or at least one --symbol <TICKER>.",
    );
  }
  return {
    symbols: [...new Set(symbols)],
    domains:
      domains.length > 0
        ? ALTERNATIVE_DATA_DOMAINS.filter((domain) => domains.includes(domain))
        : ALTERNATIVE_DATA_DOMAINS,
    verifyOnly,
    force,
  };
}

/**
 * Refuses to run against a database that must never reach a provider.
 *
 * The same rule `assertResyncTargetAllowed` applies, for the same reason: the matrix database's whole
 * premise is that it makes no provider request — it receives its alternative-data history by being
 * provisioned from here — and the test database holds fictional fixtures a real payload would
 * overwrite.
 */
export function assertIngestTargetAllowed(databaseUrl: string): void {
  const name = databaseUrl.split("?")[0]!.split("/").pop() ?? "";
  if (/matrix|test/i.test(name)) {
    throw new Error(
      `Refusing to ingest into \`${name}\`. This asks a provider for real disclosure history; the ` +
        "matrix and test databases are copies and fixtures, and a provider payload in either of " +
        "them is a defect. Ingest into the development database and provision the matrix from it.",
    );
  }
}

const iso = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

type DomainFacts = {
  readonly domain: AlternativeDataDomain;
  readonly rows: number;
  readonly earliestAvailable: string | null;
  readonly latestAvailable: string | null;
  readonly stateEarliest: string | null;
  readonly stateLatest: string | null;
  readonly lastSyncAt: string | null;
};

async function domainFacts(
  prisma: PrismaClient,
  securityId: string,
  domain: AlternativeDataDomain,
): Promise<DomainFacts> {
  // The canonical dataset **and variant**: a superseded variant's row is deliberately invisible to
  // the loader, so reporting it here would describe coverage nothing reads.
  const { dataset, variant } = ALTERNATIVE_DATA_DATASETS[domain];
  const state = await prisma.stockDatasetState.findFirst({
    where: { securityId, dataset, variant },
  });
  const aggregate =
    domain === "INSIDER"
      ? await prisma.insiderTransaction.aggregate({
          where: { securityId },
          _count: { _all: true },
          _min: { availableFromDate: true },
          _max: { availableFromDate: true },
        })
      : await prisma.congressTrade.aggregate({
          where: { securityId },
          _count: { _all: true },
          _min: { availableFromDate: true },
          _max: { availableFromDate: true },
        });
  return {
    domain,
    rows: aggregate._count._all,
    earliestAvailable: iso(aggregate._min.availableFromDate ?? null),
    latestAvailable: iso(aggregate._max.availableFromDate ?? null),
    stateEarliest: iso(state?.earliestDate ?? null),
    stateLatest: iso(state?.latestDate ?? null),
    lastSyncAt: state?.lastSuccessfulSyncAt?.toISOString() ?? null,
  };
}

async function ingest(): Promise<void> {
  loadRootEnv();
  const apiConfig = getApiConfig();
  const logger = createLogger({
    service: "api",
    level: apiConfig.logLevel,
    environment: apiConfig.environment,
    base: { component: "alternative-data-ingest" },
  });

  const { symbols, domains, verifyOnly, force } = parseIngestArguments(
    process.argv.slice(2),
    QA_MATRIX_SECURITIES.map((entry) => entry.symbol),
  );
  assertIngestTargetAllowed(process.env.DATABASE_URL ?? "");

  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url, (err) => {
    logger.warn({ event: "stock-data.redis.error", err });
  });
  const traffic = getFmpTrafficConfig();
  const config = getAlternativeDataConfig();
  let providerRequests = 0;
  const service = new CanonicalAlternativeDataService(
    new PrismaAlternativeDataStore(prisma),
    new FmpClient(() => getFmpConfig(), fetch, {
      gate: new RedisFmpRequestGate(redis, {
        maxConcurrentRequests: traffic.maxConcurrentRequests,
        rateLimitPerWindow: traffic.rateLimitPerWindow,
        rateWindowMs: traffic.rateWindowMs,
        maxQueueDepth: traffic.maxQueueDepth,
        maxQueueWaitMs: traffic.maxQueueWaitMs,
        requestLeaseMs: traffic.timeoutMs * 2,
      }),
    }),
    {
      // `--force` expresses the intent directly rather than by editing configuration: a zero
      // freshness window makes every domain stale, which is exactly what re-reading means.
      freshnessMs: force ? 0 : config.freshnessMs,
      maxPagesPerIngest: config.maxPagesPerIngest,
      onProviderRequest: (request) => {
        providerRequests += 1;
        logger.debug({ event: "alternative-data.ingest.request", ...request });
      },
    },
  );

  let failures = 0;
  try {
    await prisma.$connect();
    console.log(
      `${verifyOnly ? "Verifying" : "Ingesting"} ${domains.join(" + ")} for ` +
        `${symbols.length} security(ies)${force ? " (forced)" : ""}.`,
    );

    for (const symbol of symbols) {
      const startedAt = Date.now();
      const before = providerRequests;
      try {
        const security = await prisma.security.findFirst({
          where: { symbol },
        });
        if (!security) {
          throw new Error(`${symbol} is not in the catalog`);
        }
        if (!verifyOnly) {
          await service.ensureIngested(
            {
              id: security.id,
              symbol: security.symbol,
              name: security.name,
              exchangeCode: security.exchangeCode,
              currency: security.currency,
              type: security.type,
              isAdr: security.isAdr,
              isActivelyTrading: security.isActivelyTrading,
              ...(security.ipoDate
                ? { ipoDate: security.ipoDate.toISOString().slice(0, 10) }
                : {}),
            },
            domains,
          );
        }
        const facts = await Promise.all(
          domains.map((domain) => domainFacts(prisma, security.id, domain)),
        );
        console.log(
          `${symbol}: ${providerRequests - before} provider request(s); ${Date.now() - startedAt}ms`,
        );
        for (const fact of facts) {
          console.log(
            `    ${fact.domain}: ${fact.rows} row(s); rows available ` +
              `${fact.earliestAvailable ?? "-"} → ${fact.latestAvailable ?? "-"}; ` +
              `coverage state ${fact.stateEarliest ?? "-"} → ${fact.stateLatest ?? "-"}; ` +
              `last sync ${fact.lastSyncAt ?? "never"}`,
          );
        }
      } catch (error) {
        failures += 1;
        logger.error({
          event: "alternative-data.ingest.failed",
          symbol,
          err: error,
        });
        console.error(
          `${symbol}: failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log("");
    console.log(`Provider requests: ${providerRequests}`);
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && process.argv[1].includes("ingest-alternative-data")) {
  void ingest();
}

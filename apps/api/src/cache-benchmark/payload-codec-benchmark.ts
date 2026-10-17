import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import {
  getRedisConfig,
  getStockDataConfig,
  loadRootEnv,
} from "@intrinsic/config";
import { PrismaClient } from "@intrinsic/database";
import type { DailyDerivedState, DailyPrice } from "@intrinsic/domain";
import {
  DAILY_STATE_CHUNK_DICTIONARY,
  PrismaStockDataStore,
  RedisPayloadCodec,
  createStockDataRedisClient,
  decodeDailyStateChunk,
  encodeDailyStateChunk,
  priceRetentionYears,
  redisPayloadDictionary,
  subtractYears,
  type RedisPayloadCodecConfig,
  type RedisPayloadDictionary,
} from "@intrinsic/stock-data";
import { repositoryRoot } from "../qa-matrix/matrix-paths";

/**
 * `pnpm --filter @intrinsic/api bench:payload-codec [--securities 40] [--memory-securities 12] [--out f]`
 *
 * Measures every candidate Redis payload encoding on **real** stored histories
 * (`docs/decisions/redis-payload-codec-v1.md`): the yearly price and daily-state chunks exactly as
 * the stock cache spells them, built from PostgreSQL for a deterministic sample of the point-in-time
 * universe's ingested securities. For each candidate and chunk family it records:
 *
 * - stored bytes and the ratio to the uncompressed text;
 * - encode and decode throughput (wall and CPU), the decode including the envelope's checksum;
 * - Redis `MEMORY USAGE` of the stored values, written under a throwaway namespace and deleted —
 *   allocator size classes make this differ from the byte count;
 * - the end-to-end read a backtest's thirty-year preparation makes per security: one `MGET` of
 *   every year of both families, envelope decode and the chunk decode into rows.
 *
 * Nothing is printed or written but aggregates: no payload, value or symbol. Timings are
 * machine-specific; the report records the machine. Run it on an otherwise idle machine.
 */

type Family = "prices" | "prices-columnar" | "daily-state";

type Candidate = {
  readonly name: string;
  readonly families: readonly Family[];
  readonly config: RedisPayloadCodecConfig;
  readonly dictionary?: (family: Family) => RedisPayloadDictionary | null;
};

const LEVELS: Record<string, number[]> = {
  zstd: [1, 3, 6, 9, 12, 15, 19],
  brotli: [1, 4, 6, 9, 11],
  gzip: [1, 6, 9],
};

const ALL_TEXT: readonly Family[] = [
  "prices",
  "prices-columnar",
  "daily-state",
];

function candidates(): Candidate[] {
  const list: Candidate[] = [
    { name: "none", families: ALL_TEXT, config: { codec: "none", level: 0 } },
  ];
  for (const [codec, levels] of Object.entries(LEVELS)) {
    for (const level of levels) {
      list.push({
        name: `${codec}-${level}`,
        families: ALL_TEXT,
        config: { codec: codec as RedisPayloadCodecConfig["codec"], level },
      });
    }
  }
  for (const level of [3, 9, 19]) {
    list.push({
      name: `zstd-${level}-dict`,
      families: ["daily-state", "prices"],
      config: { codec: "zstd", level },
      dictionary: (family) =>
        family === "daily-state"
          ? DAILY_STATE_CHUNK_DICTIONARY
          : PRICE_CHUNK_DICTIONARY,
    });
  }
  return list;
}

/** What every price chunk repeats: the row shape. Benchmark-only, measured against no dictionary. */
const PRICE_CHUNK_DICTIONARY = redisPayloadDictionary(
  '[{"securityId":"00000000-0000-0000-0000-000000000000","date":"2000-01-03","open":1,"high":1,"low":1,"close":1,"volume":1}' +
    ',{"securityId":"00000000-0000-0000-0000-000000000000","date":"2000-01-04","open":1,"high":1,"low":1,"close":1,"volume":1}]',
);

type Arguments = {
  securities: number;
  memorySecurities: number;
  repeats: number;
  out: string | null;
};

function parseArguments(argv: readonly string[]): Arguments {
  const parsed: Arguments = {
    securities: 40,
    memorySecurities: 12,
    repeats: 3,
    out: null,
  };
  const rest = argv.filter((value) => value !== "--");
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index] as string;
    const value = () => {
      const next = rest[index + 1];
      if (next === undefined) {
        throw new Error(`${flag} needs a value`);
      }
      index += 1;
      return next;
    };
    switch (flag) {
      case "--securities":
        parsed.securities = Number(value());
        break;
      case "--memory-securities":
        parsed.memorySecurities = Number(value());
        break;
      case "--repeats":
        parsed.repeats = Number(value());
        break;
      case "--out":
        parsed.out = value();
        break;
      default:
        throw new Error(`Unknown argument ${flag}`);
    }
  }
  return parsed;
}

type SecurityPayloads = {
  securityId: string;
  years: number[];
  texts: Record<Family, string[]>;
};

/** Each year's price rows exactly as `RedisStockDataCache.writeDailyPriceYears` spells them. */
function priceTexts(
  prices: readonly DailyPrice[],
  years: readonly number[],
): string[] {
  return years.map((year) =>
    JSON.stringify(
      prices
        .filter((row) => row.date.startsWith(`${year}-`))
        .sort((left, right) => left.date.localeCompare(right.date)),
    ),
  );
}

/** The same rows column by column: one candidate representation, measured beside the row form. */
function columnarPriceTexts(
  prices: readonly DailyPrice[],
  years: readonly number[],
): string[] {
  return years.map((year) => {
    const rows = prices
      .filter((row) => row.date.startsWith(`${year}-`))
      .sort((left, right) => left.date.localeCompare(right.date));
    const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))]
      .filter((field) => field !== "securityId" && field !== "date")
      .sort();
    return JSON.stringify({
      securityId: rows[0]?.securityId ?? null,
      dates: rows.map((row) => row.date),
      fields,
      columns: fields.map((field) =>
        rows.map((row) => (row as Record<string, unknown>)[field] ?? null),
      ),
    });
  });
}

function stats(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (share: number) =>
    sorted.length === 0
      ? 0
      : (sorted[
          Math.min(sorted.length - 1, Math.floor(share * sorted.length))
        ] as number);
  return {
    mean:
      sorted.length === 0
        ? 0
        : sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: at(0.5),
    p95: at(0.95),
  };
}

async function main(): Promise<void> {
  loadRootEnv();
  const args = parseArguments(process.argv.slice(2));
  const prisma = new PrismaClient();
  const redis = createStockDataRedisClient(getRedisConfig().url);
  const store = new PrismaStockDataStore(prisma);
  const productYears = getStockDataConfig().productHistoryYears;
  const today = new Date().toISOString().slice(0, 10);
  const range = {
    from: subtractYears(today, priceRetentionYears(productYears)),
    to: today,
  };
  const runNamespace = `bench:payload-codec:${process.pid}:${Date.now()}`;

  try {
    // A deterministic sample of the ingested universe: ordered by a hash of the id, not by symbol.
    const ingested = await prisma.indexUniverseIngestion.findMany({
      where: { status: "SUCCEEDED" },
      select: { securityId: true },
    });
    const sample = ingested
      .map((row) => row.securityId)
      .sort(
        (left, right) => hash(left) - hash(right) || left.localeCompare(right),
      )
      .slice(0, args.securities);

    const payloads: SecurityPayloads[] = [];
    let priceRows = 0;
    let derivedRows = 0;
    for (const securityId of sample) {
      const [prices, derived] = await Promise.all([
        store.getDailyPrices(securityId, range),
        store.getDailyDerivedState(securityId, range),
      ]);
      priceRows += prices.length;
      derivedRows += derived.length;
      const years: number[] = [];
      for (
        let year = Number(range.from.slice(0, 4));
        year <= Number(range.to.slice(0, 4));
        year += 1
      ) {
        years.push(year);
      }
      payloads.push({
        securityId,
        years,
        texts: {
          prices: priceTexts(prices, years),
          "prices-columnar": columnarPriceTexts(prices, years),
          "daily-state": years.map((year) =>
            encodeDailyStateChunk(
              securityId,
              year,
              derived.filter((row: DailyDerivedState) =>
                row.date.startsWith(`${year}-`),
              ),
            ),
          ),
        },
      });
    }

    const results: Record<string, unknown>[] = [];
    for (const candidate of candidates()) {
      for (const family of candidate.families) {
        const dictionary = candidate.dictionary?.(family) ?? null;
        const codec = new RedisPayloadCodec(
          candidate.config,
          dictionary,
          dictionary ? [dictionary] : [],
        );
        const texts = payloads.flatMap((entry) => entry.texts[family]);
        const rawBytes = texts.reduce(
          (sum, text) => sum + Buffer.byteLength(text),
          0,
        );

        // Encode and decode throughput, best of `repeats` (the least disturbed run).
        let encoded: Buffer[] = [];
        const encodeWall: number[] = [];
        const encodeCpu: number[] = [];
        const decodeWall: number[] = [];
        const decodeCpu: number[] = [];
        for (let repeat = 0; repeat < args.repeats; repeat += 1) {
          const cpu = process.cpuUsage();
          const started = performance.now();
          encoded = texts.map((text) => codec.encode(text));
          encodeWall.push(performance.now() - started);
          const used = process.cpuUsage(cpu);
          encodeCpu.push((used.user + used.system) / 1_000);

          const cpuDecode = process.cpuUsage();
          const startedDecode = performance.now();
          for (const [index, payload] of encoded.entries()) {
            const decoded = codec.decode(payload);
            if (!decoded.ok || decoded.text !== texts[index]) {
              throw new Error(
                `${candidate.name} ${family}: a payload did not round-trip`,
              );
            }
          }
          decodeWall.push(performance.now() - startedDecode);
          const usedDecode = process.cpuUsage(cpuDecode);
          decodeCpu.push((usedDecode.user + usedDecode.system) / 1_000);
        }
        const storedBytes = encoded.reduce(
          (sum, payload) => sum + payload.length,
          0,
        );

        // Redis memory of the stored values for the first `memorySecurities` securities.
        const memorySet = payloads.slice(0, args.memorySecurities);
        const keys: string[] = [];
        let memoryPayloadBytes = 0;
        const pipeline = redis.pipeline();
        for (const entry of memorySet) {
          for (const [index, year] of entry.years.entries()) {
            const key = `${runNamespace}:${candidate.name}:${family}:${entry.securityId}:${year}`;
            const payload = codec.encode(entry.texts[family][index] as string);
            memoryPayloadBytes += payload.length;
            pipeline.set(key, payload);
            keys.push(key);
          }
        }
        await pipeline.exec();
        const usage = redis.pipeline();
        for (const key of keys) {
          usage.call("MEMORY", "USAGE", key, "SAMPLES", "0");
        }
        const usageResults = (await usage.exec()) ?? [];
        const memoryBytes = usageResults.reduce(
          (sum, [, value]) => sum + Number(value ?? 0),
          0,
        );

        // The end-to-end read per security: one MGET of every year, decode, chunk decode.
        const readMs: number[] = [];
        if (family !== "prices-columnar") {
          for (const entry of memorySet) {
            const entryKeys = entry.years.map(
              (year) =>
                `${runNamespace}:${candidate.name}:${family}:${entry.securityId}:${year}`,
            );
            const started = performance.now();
            const fetched = await redis.mgetBuffer(...entryKeys);
            let rows = 0;
            for (const [index, payload] of fetched.entries()) {
              const decoded = codec.decode(payload as Buffer);
              if (!decoded.ok) {
                throw new Error(
                  `${candidate.name} ${family}: unreadable after a round trip`,
                );
              }
              if (family === "daily-state") {
                const chunk = decodeDailyStateChunk(decoded.text, {
                  securityId: entry.securityId,
                  year: entry.years[index] as number,
                });
                rows += chunk.ok ? chunk.rows.length : 0;
              } else {
                rows += (JSON.parse(decoded.text) as unknown[]).length;
              }
            }
            readMs.push(performance.now() - started);
            if (rows < 0) {
              throw new Error("unreachable");
            }
          }
        }
        for (let offset = 0; offset < keys.length; offset += 500) {
          await redis.del(...keys.slice(offset, offset + 500));
        }

        const rawMb = rawBytes / 1_048_576;
        const best = (values: number[]) => Math.min(...values);
        results.push({
          candidate: candidate.name,
          family,
          payloads: texts.length,
          rawBytes,
          storedBytes,
          ratio: round(rawBytes / storedBytes, 3),
          encodeMbPerSecond: round(rawMb / (best(encodeWall) / 1_000), 1),
          encodeCpuMsPerMb: round(best(encodeCpu) / rawMb, 2),
          decodeMbPerSecond: round(rawMb / (best(decodeWall) / 1_000), 1),
          decodeCpuMsPerMb: round(best(decodeCpu) / rawMb, 2),
          redisMemory: {
            securities: memorySet.length,
            keys: keys.length,
            payloadBytes: memoryPayloadBytes,
            memoryUsageBytes: memoryBytes,
            perSecurityBytes: Math.round(
              memoryBytes / Math.max(1, memorySet.length),
            ),
          },
          ...(readMs.length > 0
            ? {
                readPerSecurityMs: mapValues(stats(readMs), (value) =>
                  round(value, 2),
                ),
              }
            : {}),
        });
        process.stderr.write(`${candidate.name} ${family} done\n`);
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      machine: {
        cpus: cpus().length,
        cpuModel: cpus()[0]?.model ?? "unknown",
        totalMemoryBytes: totalmem(),
        node: process.version,
        redis:
          (await redis.info("server")).match(/redis_version:(\S+)/)?.[1] ??
          "unknown",
      },
      sample: {
        securities: payloads.length,
        yearsPerSecurity: payloads[0]?.years.length ?? 0,
        priceRows,
        derivedRows,
        range,
      },
      results,
    };
    if (args.out) {
      const path = resolve(repositoryRoot(), args.out);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    redis.disconnect();
    await prisma.$disconnect();
  }
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mapValues<T extends Record<string, number>>(
  value: T,
  map: (entry: number) => number,
): Record<keyof T, number> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, map(entry)]),
  ) as Record<keyof T, number>;
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});

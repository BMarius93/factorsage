import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import * as zlib from "node:zlib";
import { isDeepStrictEqual } from "node:util";
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

/** Node 22's zstd binding, typed here as the payload codec types it (`@types/node` predates it). */
const zstd = zlib as unknown as {
  zstdCompressSync(input: Buffer, options?: { params?: Record<number, number> }): Buffer;
  zstdDecompressSync(input: Buffer): Buffer;
  constants: Record<string, number>;
};

/**
 * `pnpm --filter @intrinsic/api bench:payload-codec [--securities 40] [--memory-securities 12] [--families a,b] [--out f]`
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
  /** The families to measure (`--families prices,prices-binary`); every one when absent. */
  families: string[] | null;
};

function parseArguments(argv: readonly string[]): Arguments {
  const parsed: Arguments = {
    securities: 40,
    memorySecurities: 12,
    repeats: 3,
    out: null,
    families: null,
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
      case "--families":
        parsed.families = value()
          .split(",")
          .map((family) => family.trim())
          .filter((family) => family.length > 0);
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
  /** Each year's price rows, for the binary candidates. */
  priceRows: DailyPrice[][];
};

/**
 * Binary numeric packing, measured beside the text forms: one year of prices as a row count, the
 * dates as days since 1970 (`Int32`) and every numeric field as an `Float64Array` column (`NaN` for
 * an absent `vwap`). Lossless by construction — a JSON number parses to exactly this float64 — and
 * verified on every decode. `shuffle` transposes each column's bytes (all first bytes, then all
 * second bytes…) so the exponent bytes, which repeat, sit together for the compressor.
 */
const BINARY_PRICE_FIELDS = ["open", "high", "low", "close", "volume", "vwap"] as const;

function encodeBinaryPrices(rows: readonly DailyPrice[], shuffle: boolean): Buffer {
  const count = rows.length;
  const buffer = Buffer.alloc(4 + count * 4 + BINARY_PRICE_FIELDS.length * count * 8);
  buffer.writeUInt32LE(count, 0);
  let offset = 4;
  for (const row of rows) {
    buffer.writeInt32LE(Math.round(Date.parse(`${row.date}T00:00:00Z`) / 86_400_000), offset);
    offset += 4;
  }
  for (const field of BINARY_PRICE_FIELDS) {
    const column = new Float64Array(count);
    rows.forEach((row, index) => {
      const value = (row as Record<string, unknown>)[field];
      column[index] = typeof value === "number" ? value : Number.NaN;
    });
    const bytes = new Uint8Array(column.buffer);
    if (shuffle) {
      for (let byte = 0; byte < 8; byte += 1) {
        for (let index = 0; index < count; index += 1) {
          buffer[offset + byte * count + index] = bytes[index * 8 + byte] as number;
        }
      }
    } else {
      buffer.set(bytes, offset);
    }
    offset += count * 8;
  }
  return buffer;
}

function decodeBinaryPrices(securityId: string, buffer: Buffer, shuffle: boolean): DailyPrice[] {
  const count = buffer.readUInt32LE(0);
  const dates: string[] = [];
  let offset = 4;
  for (let index = 0; index < count; index += 1) {
    dates.push(new Date(buffer.readInt32LE(offset) * 86_400_000).toISOString().slice(0, 10));
    offset += 4;
  }
  const columns = BINARY_PRICE_FIELDS.map(() => {
    const bytes = new Uint8Array(count * 8);
    if (shuffle) {
      for (let byte = 0; byte < 8; byte += 1) {
        for (let index = 0; index < count; index += 1) {
          bytes[index * 8 + byte] = buffer[offset + byte * count + index] as number;
        }
      }
    } else {
      bytes.set(buffer.subarray(offset, offset + count * 8));
    }
    offset += count * 8;
    return new Float64Array(bytes.buffer);
  });
  return dates.map((date, index) => {
    const row: Record<string, unknown> = { securityId, date };
    BINARY_PRICE_FIELDS.forEach((field, column) => {
      const value = (columns[column] as Float64Array)[index] as number;
      if (field !== "vwap" || !Number.isNaN(value)) {
        row[field] = value;
      }
    });
    return row as DailyPrice;
  });
}

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
        priceRows: years.map((year) =>
          prices
            .filter((row) => row.date.startsWith(`${year}-`))
            .sort((left, right) => left.date.localeCompare(right.date)),
        ),
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
    const measured = (family: string) =>
      args.families === null || args.families.includes(family);
    for (const candidate of candidates()) {
      for (const family of candidate.families.filter(measured)) {
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

    // Binary numeric packing for prices (see `encodeBinaryPrices`), compared with the row text.
    for (const shuffle of measured("prices-binary") ? [false, true] : []) {
      for (const level of [0, 3, 19]) {
        const name = `binary-f64${shuffle ? "-shuffle" : ""}${level === 0 ? "" : `-zstd-${level}`}`;
        const compress = (raw: Buffer) =>
          level === 0
            ? raw
            : zstd.zstdCompressSync(raw, {
                params: {
                  [zstd.constants.ZSTD_c_compressionLevel as number]: level,
                },
              });
        const decompress = (stored: Buffer) =>
          level === 0 ? stored : zstd.zstdDecompressSync(stored);
        const rawTextBytes = payloads.reduce(
          (sum, entry) =>
            sum + entry.texts.prices.reduce((inner, text) => inner + Buffer.byteLength(text), 0),
          0,
        );
        let stored: Buffer[] = [];
        const encodeWall: number[] = [];
        const encodeCpu: number[] = [];
        const decodeWall: number[] = [];
        const decodeCpu: number[] = [];
        let rawBinaryBytes = 0;
        for (let repeat = 0; repeat < args.repeats; repeat += 1) {
          const cpu = process.cpuUsage();
          const started = performance.now();
          rawBinaryBytes = 0;
          stored = payloads.flatMap((entry) =>
            entry.priceRows.map((rows) => {
              const raw = encodeBinaryPrices(rows, shuffle);
              rawBinaryBytes += raw.length;
              return compress(raw);
            }),
          );
          encodeWall.push(performance.now() - started);
          const used = process.cpuUsage(cpu);
          encodeCpu.push((used.user + used.system) / 1_000);

          const cpuDecode = process.cpuUsage();
          const startedDecode = performance.now();
          let index = 0;
          for (const entry of payloads) {
            for (const rows of entry.priceRows) {
              const decoded = decodeBinaryPrices(
                entry.securityId,
                decompress(stored[index] as Buffer),
                shuffle,
              );
              index += 1;
              if (repeat === 0 && !isDeepStrictEqual(decoded, rows.map((row) => ({ ...row })))) {
                throw new Error(`${name}: a price year did not round-trip`);
              }
            }
          }
          decodeWall.push(performance.now() - startedDecode);
          const usedDecode = process.cpuUsage(cpuDecode);
          decodeCpu.push((usedDecode.user + usedDecode.system) / 1_000);
        }
        const storedBytes = stored.reduce((sum, payload) => sum + payload.length, 0);

        const memorySet = payloads.slice(0, args.memorySecurities);
        const keys: string[] = [];
        const pipeline = redis.pipeline();
        for (const entry of memorySet) {
          entry.priceRows.forEach((rows, index) => {
            const key = `${runNamespace}:${name}:${entry.securityId}:${entry.years[index]}`;
            pipeline.set(key, compress(encodeBinaryPrices(rows, shuffle)));
            keys.push(key);
          });
        }
        await pipeline.exec();
        const usage = redis.pipeline();
        for (const key of keys) {
          usage.call("MEMORY", "USAGE", key, "SAMPLES", "0");
        }
        const memoryBytes = ((await usage.exec()) ?? []).reduce(
          (sum, [, value]) => sum + Number(value ?? 0),
          0,
        );
        const readMs: number[] = [];
        for (const entry of memorySet) {
          const entryKeys = entry.years.map(
            (year) => `${runNamespace}:${name}:${entry.securityId}:${year}`,
          );
          const started = performance.now();
          const fetched = await redis.mgetBuffer(...entryKeys);
          for (const payload of fetched) {
            decodeBinaryPrices(entry.securityId, decompress(payload as Buffer), shuffle);
          }
          readMs.push(performance.now() - started);
        }
        for (let offset = 0; offset < keys.length; offset += 500) {
          await redis.del(...keys.slice(offset, offset + 500));
        }
        const rawMb = rawTextBytes / 1_048_576;
        const best = (values: number[]) => Math.min(...values);
        results.push({
          candidate: name,
          family: "prices-binary",
          payloads: stored.length,
          // Throughput is per MB of the row *text* the same rows spell, so it compares with the
          // text candidates directly.
          rawBytes: rawTextBytes,
          rawBinaryBytes,
          storedBytes,
          ratio: round(rawTextBytes / storedBytes, 3),
          encodeMbPerSecond: round(rawMb / (best(encodeWall) / 1_000), 1),
          encodeCpuMsPerMb: round(best(encodeCpu) / rawMb, 2),
          decodeMbPerSecond: round(rawMb / (best(decodeWall) / 1_000), 1),
          decodeCpuMsPerMb: round(best(decodeCpu) / rawMb, 2),
          decodeIncludesRows: true,
          redisMemory: {
            securities: memorySet.length,
            keys: keys.length,
            memoryUsageBytes: memoryBytes,
            perSecurityBytes: Math.round(memoryBytes / Math.max(1, memorySet.length)),
          },
          readPerSecurityMs: mapValues(stats(readMs), (value) => round(value, 2)),
        });
        process.stderr.write(`${name} prices-binary done\n`);
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

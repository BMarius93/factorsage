import * as zlib from "node:zlib";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  crc32,
  gunzipSync,
  gzipSync,
} from "node:zlib";

/**
 * Node's built-in Zstandard binding (stable in Node 22.15+, which the repository pins). Typed here
 * because the installed `@types/node` predates it; the presence check makes a runtime without it
 * fail at construction with a plain message rather than on the first write.
 */
type ZstdOptions = {
  params?: Record<number, number>;
  dictionary?: Buffer;
  maxOutputLength?: number;
};
const zstd = zlib as unknown as {
  zstdCompressSync?: (input: Buffer, options?: ZstdOptions) => Buffer;
  zstdDecompressSync?: (input: Buffer, options?: ZstdOptions) => Buffer;
  constants: Record<string, number>;
};
const ZSTD_COMPRESSION_LEVEL = zstd.constants.ZSTD_c_compressionLevel as number;
const ZSTD_CHECKSUM_FLAG = zstd.constants.ZSTD_c_checksumFlag as number;

function zstdCompressSync(input: Buffer, options: ZstdOptions): Buffer {
  if (!zstd.zstdCompressSync) {
    throw new Error("This Node.js runtime has no Zstandard support");
  }
  return zstd.zstdCompressSync(input, options);
}

function zstdDecompressSync(input: Buffer, options: ZstdOptions): Buffer {
  if (!zstd.zstdDecompressSync) {
    throw new Error("This Node.js runtime has no Zstandard support");
  }
  return zstd.zstdDecompressSync(input, options);
}

/**
 * The one codec every compressible Redis payload goes through (`docs/decisions/redis-payload-codec-v1.md`).
 *
 * Redis is a projection of PostgreSQL, and its largest values are the yearly history chunks — daily
 * prices, the daily derived state, statements, benchmark bars. They are JSON text that repeats
 * itself heavily, so they are stored compressed, behind a small self-describing envelope:
 *
 * ```text
 * offset  size  field
 * 0       2     magic 0x46 0x53 ("FS")
 * 2       1     envelope version (1)
 * 3       1     codec: 0 none, 1 zstd, 2 brotli, 3 gzip
 * 4       4     dictionary id (CRC-32 of the dictionary bytes; 0 = none), little-endian
 * 8       4     uncompressed length in bytes, little-endian
 * 12      4     CRC-32 of the uncompressed bytes, little-endian
 * 16      …     the codec's frame
 * ```
 *
 * Four properties are the point of the design, each enforced here and nowhere else:
 *
 * - **Lossless and verified.** The checksum is over the exact bytes the producer encoded, and is
 *   verified on every decode, whichever codec: a payload that decompresses to anything else is
 *   refused rather than parsed. No codec rounds a number; compression is applied to the canonical
 *   text, so a value read back is the value written.
 * - **Self-describing.** The header names the codec and the dictionary, so a reader decodes any
 *   payload any configuration wrote, and a writer can change codec or level at any time without a
 *   migration.
 * - **Backward compatible.** A legacy payload — the uncompressed JSON text every cache wrote before
 *   this codec — starts with `{` or `[`, which no envelope can, and is read as it always was. A cache
 *   therefore needs no flush to adopt the codec: old chunks keep serving until they are republished.
 * - **Refuses rather than guesses.** An unknown version, codec or dictionary, a truncated frame, a
 *   length or checksum mismatch, or a size beyond {@link REDIS_PAYLOAD_MAX_DECODED_BYTES} is
 *   reported as unreadable. Every caller treats unreadable as a cache miss and rebuilds the value
 *   from PostgreSQL, so damage costs a rebuild, never wrong data.
 *
 * Coordination state is never encoded: manifests and heads are compared byte for byte by Lua and
 * decoded with `cjson`, and registries, locks, gates, counters and rate limits are native Redis
 * structures. This module is for payloads only TypeScript reads.
 */

export const REDIS_PAYLOAD_ENVELOPE_VERSION = 1;

/** Bytes of the envelope header. */
export const REDIS_PAYLOAD_HEADER_BYTES = 16;

/**
 * A decoded payload larger than this is refused before it is inflated: the largest real chunk is a
 * few megabytes, so anything beyond is damage, never data.
 */
export const REDIS_PAYLOAD_MAX_DECODED_BYTES = 256 * 1024 * 1024;

const MAGIC_0 = 0x46;
const MAGIC_1 = 0x53;

export const REDIS_PAYLOAD_CODEC_IDS = {
  none: 0,
  zstd: 1,
  brotli: 2,
  gzip: 3,
} as const;

export type RedisPayloadCodecName = keyof typeof REDIS_PAYLOAD_CODEC_IDS;

export type RedisPayloadCodecConfig = {
  readonly codec: RedisPayloadCodecName;
  /** zstd 1–22, brotli 0–11, gzip 1–9. Ignored for `none`. */
  readonly level: number;
};

/** The configuration production writes with, chosen from the measurements in the decision record. */
export const DEFAULT_REDIS_PAYLOAD_CODEC: RedisPayloadCodecConfig = {
  codec: "zstd",
  level: 3,
};

export type RedisPayloadDecoding =
  | { readonly ok: true; readonly text: string; readonly legacy: boolean }
  | { readonly ok: false; readonly reason: string };

/** A raw-content dictionary, identified by the CRC-32 of its bytes. */
export type RedisPayloadDictionary = {
  readonly id: number;
  readonly bytes: Buffer;
};

export function redisPayloadDictionary(content: string): RedisPayloadDictionary {
  const bytes = Buffer.from(content, "utf8");
  return { id: crc32(bytes) >>> 0, bytes };
}

/**
 * Encodes and decodes Redis payloads for one family of keys.
 *
 * A family may carry a dictionary — bytes its payloads repeat, such as a chunk's field dictionary —
 * which zstd primes its window with. The writer's dictionary is the one in its configuration; a
 * reader knows every dictionary it was given, so payloads written with an earlier dictionary still
 * decode while it is listed, and are refused (a miss) once it is not.
 */
export class RedisPayloadCodec {
  private readonly codecId: number;
  private readonly dictionaries: ReadonlyMap<number, Buffer>;

  constructor(
    private readonly config: RedisPayloadCodecConfig = DEFAULT_REDIS_PAYLOAD_CODEC,
    private readonly dictionary: RedisPayloadDictionary | null = null,
    readable: readonly RedisPayloadDictionary[] = [],
  ) {
    const id = REDIS_PAYLOAD_CODEC_IDS[config.codec];
    if (id === undefined) {
      throw new Error(`Unknown Redis payload codec ${String(config.codec)}`);
    }
    if (dictionary && config.codec !== "zstd") {
      throw new Error("A payload dictionary is only supported with zstd");
    }
    this.codecId = id;
    const known = new Map<number, Buffer>();
    for (const entry of [...readable, ...(dictionary ? [dictionary] : [])]) {
      known.set(entry.id, entry.bytes);
    }
    this.dictionaries = known;
  }

  get name(): string {
    return this.config.codec === "none"
      ? "none"
      : `${this.config.codec}-${this.config.level}${this.dictionary ? "-dict" : ""}`;
  }

  /** The envelope for `text`. Deterministic: the same text and configuration give the same bytes. */
  encode(text: string): Buffer {
    const raw = Buffer.from(text, "utf8");
    if (raw.length > REDIS_PAYLOAD_MAX_DECODED_BYTES) {
      throw new Error(
        `Refusing to encode a ${raw.length}-byte payload, above the ${REDIS_PAYLOAD_MAX_DECODED_BYTES}-byte bound`,
      );
    }
    const frame = this.compress(raw);
    const header = Buffer.allocUnsafe(REDIS_PAYLOAD_HEADER_BYTES);
    header[0] = MAGIC_0;
    header[1] = MAGIC_1;
    header[2] = REDIS_PAYLOAD_ENVELOPE_VERSION;
    header[3] = this.codecId;
    header.writeUInt32LE(this.dictionary?.id ?? 0, 4);
    header.writeUInt32LE(raw.length, 8);
    header.writeUInt32LE(crc32(raw) >>> 0, 12);
    return Buffer.concat([header, frame]);
  }

  /** The text a payload holds, or why it cannot be read. Never throws. */
  decode(payload: Buffer | string): RedisPayloadDecoding {
    if (typeof payload === "string") {
      return isLegacyText(payload)
        ? { ok: true, text: payload, legacy: true }
        : unreadable("a text payload that is neither legacy JSON nor an envelope");
    }
    if (payload.length === 0) {
      return unreadable("an empty payload");
    }
    const first = payload[0];
    if (first === 0x7b || first === 0x5b) {
      // `{` or `[`: the uncompressed JSON every cache wrote before the codec existed.
      return { ok: true, text: payload.toString("utf8"), legacy: true };
    }
    if (payload.length < REDIS_PAYLOAD_HEADER_BYTES) {
      return unreadable("a payload shorter than the envelope header");
    }
    if (first !== MAGIC_0 || payload[1] !== MAGIC_1) {
      return unreadable("an unknown payload format");
    }
    if (payload[2] !== REDIS_PAYLOAD_ENVELOPE_VERSION) {
      return unreadable(`envelope version ${payload[2]}, not ${REDIS_PAYLOAD_ENVELOPE_VERSION}`);
    }
    const codec = payload[3] as number;
    const dictionaryId = payload.readUInt32LE(4);
    const length = payload.readUInt32LE(8);
    const checksum = payload.readUInt32LE(12);
    if (length > REDIS_PAYLOAD_MAX_DECODED_BYTES) {
      return unreadable(`a declared length of ${length} bytes`);
    }
    let dictionary: Buffer | undefined;
    if (dictionaryId !== 0) {
      dictionary = this.dictionaries.get(dictionaryId);
      if (!dictionary) {
        return unreadable(`dictionary ${dictionaryId} is not known to this reader`);
      }
    }
    const frame = payload.subarray(REDIS_PAYLOAD_HEADER_BYTES);
    let raw: Buffer;
    try {
      raw = decompress(codec, frame, length, dictionary);
    } catch (error) {
      return unreadable(
        `the ${codecName(codec)} frame did not decompress (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (raw.length !== length) {
      return unreadable(`decompressed to ${raw.length} bytes, not ${length}`);
    }
    if ((crc32(raw) >>> 0) !== checksum) {
      return unreadable("the checksum does not match");
    }
    return { ok: true, text: raw.toString("utf8"), legacy: false };
  }

  private compress(raw: Buffer): Buffer {
    switch (this.config.codec) {
      case "none":
        return raw;
      case "zstd":
        return zstdCompressSync(raw, {
          params: {
            [ZSTD_COMPRESSION_LEVEL]: this.config.level,
            [ZSTD_CHECKSUM_FLAG]: 1,
          },
          ...(this.dictionary ? { dictionary: this.dictionary.bytes } : {}),
        });
      case "brotli":
        return brotliCompressSync(raw, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: this.config.level,
            [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
            [constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
          },
        });
      case "gzip":
        return gzipSync(raw, { level: this.config.level });
    }
  }
}

function decompress(
  codec: number,
  frame: Buffer,
  length: number,
  dictionary: Buffer | undefined,
): Buffer {
  switch (codec) {
    case REDIS_PAYLOAD_CODEC_IDS.none:
      return frame;
    case REDIS_PAYLOAD_CODEC_IDS.zstd:
      return zstdDecompressSync(frame, {
        maxOutputLength: Math.max(1, length),
        ...(dictionary ? { dictionary } : {}),
      });
    case REDIS_PAYLOAD_CODEC_IDS.brotli:
      return brotliDecompressSync(frame, { maxOutputLength: Math.max(1, length) });
    case REDIS_PAYLOAD_CODEC_IDS.gzip:
      return gunzipSync(frame, { maxOutputLength: Math.max(1, length) });
    default:
      throw new Error(`unknown codec ${codec}`);
  }
}

function codecName(codec: number): string {
  return (
    Object.entries(REDIS_PAYLOAD_CODEC_IDS).find(([, id]) => id === codec)?.[0] ??
    `codec ${codec}`
  );
}

function isLegacyText(payload: string): boolean {
  return payload.startsWith("{") || payload.startsWith("[");
}

function unreadable(reason: string): RedisPayloadDecoding {
  return { ok: false, reason };
}

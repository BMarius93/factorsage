import { describe, expect, it } from "vitest";
import {
  REDIS_PAYLOAD_HEADER_BYTES,
  RedisPayloadCodec,
  redisPayloadDictionary,
  type RedisPayloadCodecConfig,
} from "./redis-payload-codec.js";

// Values that break naive serializations: shortest round-trip doubles, sub-cent prices, negative
// zero's neighbours, the largest safe integer, exponents and non-ASCII text.
const SAMPLE = JSON.stringify({
  version: 2,
  securityId: "6f0f2a64-5d0c-4c1f-9a1e-1d1a3f4b5c6d",
  year: 2024,
  dates: ["2024-01-02", "2024-01-03"],
  columns: [
    [0.1 + 0.2, 1 / 3, 185.64000000000001, 1e-9, -0.000001, 9007199254740991],
    [["USD", 2]],
    [[3]],
    ["Société Générale — €"],
  ],
});

const CONFIGS: RedisPayloadCodecConfig[] = [
  { codec: "none", level: 0 },
  { codec: "zstd", level: 1 },
  { codec: "zstd", level: 3 },
  { codec: "zstd", level: 19 },
  { codec: "brotli", level: 5 },
  { codec: "gzip", level: 6 },
];

describe("RedisPayloadCodec", () => {
  it.each(CONFIGS)("round-trips byte for byte with $codec $level", (config) => {
    const codec = new RedisPayloadCodec(config);
    const encoded = codec.encode(SAMPLE);
    expect(encoded[0]).toBe(0x46);
    expect(encoded[1]).toBe(0x53);
    const decoded = codec.decode(encoded);
    expect(decoded).toEqual({ ok: true, text: SAMPLE, legacy: false });
    // Every number survives exactly: compression is applied to the canonical text.
    expect(JSON.parse((decoded as { text: string }).text)).toEqual(JSON.parse(SAMPLE));
  });

  it("is deterministic", () => {
    const codec = new RedisPayloadCodec({ codec: "zstd", level: 3 });
    expect(codec.encode(SAMPLE).equals(codec.encode(SAMPLE))).toBe(true);
  });

  it("reads any configuration's payload, so the writer can change codec without a migration", () => {
    const reader = new RedisPayloadCodec({ codec: "zstd", level: 3 });
    for (const config of CONFIGS) {
      expect(reader.decode(new RedisPayloadCodec(config).encode(SAMPLE))).toEqual({
        ok: true,
        text: SAMPLE,
        legacy: false,
      });
    }
  });

  it("reads a legacy uncompressed JSON payload, as bytes or as text", () => {
    const codec = new RedisPayloadCodec();
    expect(codec.decode(Buffer.from(SAMPLE))).toEqual({ ok: true, text: SAMPLE, legacy: true });
    expect(codec.decode("[1,2]")).toEqual({ ok: true, text: "[1,2]", legacy: true });
  });

  it("primes zstd with a dictionary, and refuses a payload whose dictionary it does not know", () => {
    const dictionary = redisPayloadDictionary(
      '{"version":2,"securityId":"","year":2024,"fields":["sma20d","sma50d"],"dates":[',
    );
    const writer = new RedisPayloadCodec({ codec: "zstd", level: 3 }, dictionary);
    const encoded = writer.encode(SAMPLE);
    expect(writer.decode(encoded)).toEqual({ ok: true, text: SAMPLE, legacy: false });
    // A reader that was given the dictionary as readable decodes it.
    expect(
      new RedisPayloadCodec({ codec: "zstd", level: 3 }, null, [dictionary]).decode(encoded).ok,
    ).toBe(true);
    // A reader without it refuses rather than producing garbage.
    expect(new RedisPayloadCodec().decode(encoded)).toEqual({
      ok: false,
      reason: `dictionary ${dictionary.id} is not known to this reader`,
    });
  });

  it("refuses every kind of damage instead of returning wrong bytes", () => {
    const codec = new RedisPayloadCodec({ codec: "zstd", level: 3 });
    const encoded = codec.encode(SAMPLE);

    const flipped = Buffer.from(encoded);
    flipped[flipped.length - 5] = (flipped[flipped.length - 5] as number) ^ 0xff;
    expect(codec.decode(flipped).ok).toBe(false);

    // Truncation into the content is refused; the checksum guarantees a decode is the exact bytes.
    expect(codec.decode(encoded.subarray(0, encoded.length - 12)).ok).toBe(false);
    expect(codec.decode(encoded.subarray(0, REDIS_PAYLOAD_HEADER_BYTES - 1))).toEqual({
      ok: false,
      reason: "a payload shorter than the envelope header",
    });

    const version = Buffer.from(encoded);
    version[2] = 9;
    expect(codec.decode(version)).toEqual({ ok: false, reason: "envelope version 9, not 1" });

    const unknownCodec = Buffer.from(encoded);
    unknownCodec[3] = 42;
    expect(codec.decode(unknownCodec).ok).toBe(false);

    const wrongChecksum = Buffer.from(new RedisPayloadCodec({ codec: "none", level: 0 }).encode(SAMPLE));
    wrongChecksum.writeUInt32LE((wrongChecksum.readUInt32LE(12) + 1) >>> 0, 12);
    expect(codec.decode(wrongChecksum)).toEqual({
      ok: false,
      reason: "the checksum does not match",
    });

    const bomb = Buffer.from(encoded);
    bomb.writeUInt32LE(0xffffffff, 8);
    expect(codec.decode(bomb).ok).toBe(false);

    expect(codec.decode(Buffer.from([0x00, 0x01, 0x02]))).toEqual({
      ok: false,
      reason: "a payload shorter than the envelope header",
    });
    expect(codec.decode(Buffer.alloc(0)).ok).toBe(false);
    expect(codec.decode("not json").ok).toBe(false);
  });

  it("refuses a dictionary with a codec that cannot use one", () => {
    expect(
      () =>
        new RedisPayloadCodec({ codec: "brotli", level: 5 }, redisPayloadDictionary("x")),
    ).toThrow("only supported with zstd");
  });
});

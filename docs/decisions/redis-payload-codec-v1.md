# Redis Payload Codec V1

## Status

**Accepted** with the S&P 500 point-in-time universe (`sp500-historical-pit-v1.md`), whose
protected tier (`protected-stock-tier-v1.md`) keeps ~730 full histories resident. It changes how
Redis stores the bytes of its largest values and nothing about any value: every payload decodes to
exactly the text it was written from, and a flushed or damaged payload costs a rebuild from
PostgreSQL, never data.

The implementation is `packages/stock-data/src/redis-payload-codec.ts`; the measurements are
reproduced by `pnpm --filter @intrinsic/api bench:payload-codec`.

## Context — the Redis audit

Everything the application keeps in Redis (`AGENTS.md` invariant 16), by what it is:

| Family                                                                 | Keys                          | Kind                                          | Encoded?                          |
| ---------------------------------------------------------------------- | ----------------------------- | --------------------------------------------- | --------------------------------- |
| `stock-data:v2:security:<id>:prices:1D:<year>`                         | yearly                        | price rows (JSON)                             | **yes**                           |
| `stock-data:v2:security:<id>:daily-state:v2:<year>`                    | yearly                        | columnar daily derived state                  | **yes** (with a field dictionary) |
| `stock-data:v2:security:<id>:financials:*`                             | yearly                        | statements                                    | **removed** (see below)           |
| `benchmark:v1:*` chunks                                                | content-addressed             | benchmark bars                                | **yes**                           |
| manifests, benchmark heads                                             | one per security / series     | read by Lua (`cjson`), compared byte for byte | **no**                            |
| registries, the resident LRU, the protected set, access sequence       | sets / sorted sets / counters | coordination                                  | **no**                            |
| `stock-data:load:*` locks, FMP gate, request budget, `rate-limit:v1:*` | coordination                  | coordination                                  | **no**                            |
| symbol → security identity                                             | small JSON                    | read on every request                         | **no** (tiny)                     |

Before this decision, payloads were uncompressed JSON. A full-retention security cost ~1 MB of
`MEMORY USAGE` with statements, and three quarters of its keys were statement chunks that no read
path consumed.

## Decision

### 1. One codec, one envelope

Every compressible payload goes through `RedisPayloadCodec` and is stored as a 16-byte envelope
followed by the codec's frame:

```text
offset  size  field
0       2     magic "FS"
2       1     envelope version (1)
3       1     codec: 0 none, 1 zstd, 2 brotli, 3 gzip
4       4     dictionary id (CRC-32 of the dictionary bytes; 0 = none)
8       4     uncompressed length
12      4     CRC-32 of the uncompressed bytes
16      …     frame
```

- **Lossless and verified.** Compression applies to the canonical text; the CRC is checked on every
  decode. No number is rounded — the codec never sees a number.
- **Self-describing.** A reader decodes any payload any configuration wrote; the writer can change
  codec, level or dictionary without a migration.
- **Backward compatible.** A legacy uncompressed JSON payload starts with `{` or `[`, which no
  envelope can, and is read as before; no flush is needed to adopt the codec.
- **Refuses rather than guesses.** An unknown version, codec or dictionary, a truncated frame, a
  length or checksum mismatch, or a declared size beyond 256 MB is _unreadable_; every caller
  treats that as a miss and rebuilds from PostgreSQL, and the observer logs
  `stock-data.cache.chunk-unreadable`.
- **Never coordination state.** Manifests, heads, registries, locks, gates, counters and rate
  limits are compared by Lua or are native structures; they are never encoded.

### 2. zstd level 3, with the chunk's field dictionary

Production writes **zstd level 3**; the daily-state family primes zstd with the bytes every chunk
repeats (its header and field list, `DAILY_STATE_CHUNK_DICTIONARY`), identified by CRC so a field
added to the registry changes the dictionary and old chunks are refused and rebuilt.

Why zstd-3 rather than a stronger setting is in "Measured" below: the stronger settings shrink the
tier by a further fifth at encode costs that land on every on-demand hydration, while decode speed —
what a backtest pays — is the same.

### 3. Statements are no longer projected

`FINANCIAL_STATEMENT_VERSION` 2: statement chunks are not written to Redis at all, and a manifest
from revision 1 is not current, so its next hydration deletes every registered key, statement
chunks included. Screening, charts and backtests read the unified daily state; statement reads go
to PostgreSQL. Measured on the development Redis before the change, for the 100 resident
securities: statements were 22,800 of 30,124 keys and 24.7 MB of 102 MB (with their registry
entries, ~280 KB per security).

## Measured

`bench:payload-codec` (2026-10-17) over a deterministic sample of 40 universe securities — 1,400
yearly chunks of each family, 264,005 price rows and as many derived rows, 1992-10-17 … 2026-10-17
— on the benchmark machine (4 vCPU Xeon 2.8 GHz, Node 22.23.2, Redis 7.0.15). Speeds are the best of
two passes over all chunks; `MEMORY USAGE` is measured on 12 securities (420 keys per family) and
includes key and allocator overhead; "read" is one security's whole history as the cache reads it —
one `MGET` of every year, decode, then the chunk's own parse. Every candidate round-tripped every
payload exactly.

**Daily state** (columnar chunks, 46.0 MiB of text):

| Candidate                               | Ratio | Redis per security | Encode MB/s | Decode MB/s | Decode CPU ms/MB | Read p50 / p95  |
| --------------------------------------- | ----- | ------------------ | ----------- | ----------- | ---------------- | --------------- |
| none                                    | 1.00  | 1,210 KB           | 989         | 1,280       | 0.8              | 50.4 / 176.3 ms |
| gzip-6                                  | 2.36  | 520 KB             | 31          | 183         | 6.2              | 55.9 / 168.1 ms |
| brotli-4                                | 2.52  | 506 KB             | 38          | 162         | 6.2              | 57.1 / 63.6 ms  |
| zstd-1                                  | 2.47  | 508 KB             | 138         | 213         | 5.5              | 54.5 / 67.5 ms  |
| zstd-3                                  | 2.42  | 512 KB             | 64          | 202         | 5.1              | 53.0 / 69.2 ms  |
| **zstd-3 + field dictionary** (adopted) | 2.47  | 505 KB             | 78          | 180         | 6.0              | 57.3 / 124.9 ms |
| zstd-19 + field dictionary              | 2.92  | 423 KB             | 8           | 176         | 7.0              | 53.4 / 64.0 ms  |
| brotli-11                               | 2.96  | 420 KB             | 1           | 99          | 11.2             | 60.7 / 89.4 ms  |

**Prices** (row chunks, 39.2 MiB of text):

| Candidate                               | Ratio | Redis per security | Encode MB/s | Decode MB/s | Decode CPU ms/MB | Read p50 / p95 |
| --------------------------------------- | ----- | ------------------ | ----------- | ----------- | ---------------- | -------------- |
| none                                    | 1.00  | 1,001 KB           | 559         | 1,096       | 0.9              | 8.2 / 25.7 ms  |
| gzip-6                                  | 7.03  | 152 KB             | 55          | 300         | 3.5              | 9.5 / 13.1 ms  |
| brotli-4                                | 7.05  | 152 KB             | 84          | 315         | 3.3              | 10.4 / 18.8 ms |
| zstd-1                                  | 7.12  | 151 KB             | 120         | 183         | 5.4              | 11.1 / 16.6 ms |
| **zstd-3** (adopted)                    | 6.79  | 157 KB             | 79          | 239         | 4.4              | 10.9 / 16.4 ms |
| zstd-19                                 | 9.34  | 118 KB             | 2           | 271         | 3.8              | 11.0 / 13.6 ms |
| brotli-11                               | 9.96  | 110 KB             | 1           | 224         | 4.7              | 17.6 / 22.8 ms |
| one array per field, zstd-3 (not yet)   | 9.01¹ | 122 KB             | 47          | 117         | 8.8              | —              |
| float64 columns, zstd-3²                | 7.59¹ | 143 KB             | 125         | 79²         | 13.2²            | 15.0 / 19.3 ms |
| float64 columns, byte-shuffled, zstd-3² | 5.15¹ | 197 KB             | 129         | 102²        | 10.1²            | 11.7 / 19.4 ms |
| float64 columns, zstd-19²               | 8.65¹ | 125 KB             | 11          | 100²        | 10.5²            | 10.7 / 24.4 ms |

¹ Against the row text; the columnar text itself is a third of it (13.6 MB against 41.1 MB).
² Binary numeric packing (`--families prices-binary`, a second run on the same sample, where row
JSON at zstd-3 read in 10.6 / 16.5 ms): a year as its row count, dates as days since 1970 and one
`Float64Array` per field — lossless, verified on every decode. Its decode includes building the
rows, which the text candidates' decode leaves to `JSON.parse`.

The full grid (zstd 1–19, brotli 1–11, gzip 1–9, with and without dictionaries) is in the
benchmark's JSON output (`artifacts/redis-payload-codec/benchmark.json`, git-ignored).

What the numbers decide:

- **Compressing at all is what matters**: −84 % of `MEMORY USAGE` for prices and −58 % for daily
  state at zstd-3. Among general-purpose codecs at comparable speed the sizes differ by a few
  percent; zstd decodes as fast as any of them and spans the widest range of encode speeds.
- **Decompression is not what a read costs.** A whole thirty-five-year daily-state history reads in
  ~53 ms compressed against ~50 ms raw (p50) — parsing and materializing rows is the cost — and
  compressed reads have the lower tail (raw reads move three times the bytes through the socket).
  Decompression adds 3.5–5 ms of CPU per raw MB: about 6 s of a thirty-year universe backtest's ~93 s
  of CPU, which reads ~511 MB from Redis instead of ~1.6 GB.
- **zstd-19 is not worth its encode cost on the write path.** With the dictionary it would shrink
  daily state by a further 16 % and prices by 25 % — ~95 MB of the 531 MB protected tier — but
  encodes at 8 and 2 MB/s: ~0.65 s of CPU per security on every on-demand hydration (against
  ~30 ms at zstd-3) and ~8 more CPU-minutes per `protect` of the universe. brotli-11 compresses no
  better than zstd-19 at a hundredth of zstd-3's encode speed and half its decode speed. Because
  readers accept every level, re-encoding the protected tier at a high level in the background is
  open as a later, writer-only change.
- **The field dictionary** gains 1–3 % on daily state at zstd-3 and 4 % at zstd-19, for nothing at
  read time. A price dictionary gains nothing (a price chunk repeats no header) and is not used.
- **Binary numeric packing does not pay.** Float64 columns are a third of the row text but
  compress worse than text does: 143 KB per security at zstd-3 (9 % below row JSON, 17 % above
  columnar JSON), 125 KB at zstd-19 (above row JSON's 118 KB), and transposing the bytes makes it
  worse (197 KB) — exchange prices are short decimals, which text spells in few digits and a
  float64 in eight noisy bytes. Its read was no faster. Not adopted.
- **Next format change:** prices as one array per field compress 22 % smaller than row JSON at the
  same level (122 KB against 157 KB per security), and parse like the daily-state chunk.

## Consequences

- The protected tier of 734 securities fits in ~0.54 GB (`protected-stock-tier-v1.md`).
- Reading a chunk costs a decompression and a CRC; on a backtest's frame read it is a minority of
  the decode cost, which is dominated by JSON parsing and row materialization.
- A future codec change (a level, a trained dictionary, a binary columnar price chunk) is a writer
  configuration change: readers already decode every envelope.

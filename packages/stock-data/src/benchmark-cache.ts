import type {
  BenchmarkDailyPrice,
  DateRange,
  LocalDate,
} from "@intrinsic/domain";
import type { RedisCacheClient } from "./cache.js";
import { yearsInRange } from "./cache.js";
import {
  BENCHMARK_CHUNK_ENCODING_VERSION,
  decodeBenchmarkChunk,
  encodeBenchmarkChunk,
} from "./benchmark-chunk.js";
import {
  BENCHMARK_PRICE_DATASET_VERSION,
  type BenchmarkCacheHead,
  type BenchmarkCacheRead,
  type BenchmarkDataCache,
  type BenchmarkPublishOutcome,
  type ObservedBenchmarkHead,
} from "./benchmark-ports.js";

/**
 * Redis projection of benchmark series, published as immutable generations
 * (`docs/decisions/etf-market-data-v1.md`).
 *
 * ```text
 * benchmark:v1:benchmark:<seriesId>:head                                  the current publication
 * benchmark:v1:benchmark:<seriesId>:chunks                                every chunk key written
 * benchmark:v1:benchmark:<seriesId>:daily-price:v<enc>:<year>:<digest>    one year of bars
 * ```
 *
 * The namespace is the benchmark one `AGENTS.md` invariant 16 names, and it is deliberately not the
 * stock namespace: nothing here is registered with the resident-stock LRU, so a stock eviction can
 * never remove a benchmark key, and no key a publication commits carries a TTL.
 *
 * **Why a head and immutable chunks.** A series' history is read in yearly chunks, so a reader
 * issues one `GET` for the head and one `MGET` for the years it needs. Overwriting chunks in place
 * would let a reader that read some years before a republish and some after combine two histories —
 * across a split re-base, two price bases. Here a chunk key carries the digest of the stored bars it
 * was built from, so a key is never rewritten with different content; a publication stages the
 * chunks it adds, then one script swaps the head and removes every chunk the new head no longer
 * names. A reader therefore sees all of one publication or, when the head moved under it, a missing
 * chunk, and retries against the new head. Never a mixture.
 *
 * **Interrupted publications cost nothing.** Staged chunks carry an expiry until a commit adopts
 * them, and every chunk is recorded in the series' registry, so a crashed publisher's chunks
 * expire on their own and the next commit removes their registry entries. Memory is bounded by one
 * publication per series plus whatever is mid-flight.
 *
 * **Before this protocol** the projection was `…:manifest` plus `…:daily-price:<year>` keys
 * overwritten in place. Those legacy keys are never read; a commit removes them the first time it
 * finds the legacy manifest.
 */
export const BENCHMARK_CACHE_NAMESPACE = "benchmark:v1";

/** How long a staged chunk lives if no commit adopts it. */
export const DEFAULT_BENCHMARK_STAGE_TTL_MS = 10 * 60 * 1_000;

/** Reads retried when the head moved between the `GET` and the `MGET`. */
const READ_ATTEMPTS = 3;

/** Before any stored bar: the lower bound of a read that wants everything up to a date. */
const EARLIEST_DATE: LocalDate = "0000-01-01";

/** Chunks staged per script call, so a cold full-history publication is a handful of round trips. */
const STAGE_BATCH = 8;

/** The legacy layout wrote years from whatever a caller asked for; a prewarm could reach 1927. */
const LEGACY_FIRST_YEAR = 1900;

/** Trading sessions a year holds at most, for sizing a backwards window read. */
const SESSIONS_PER_YEAR = 252;

export type BenchmarkCacheObserver = {
  /** A chunk the head names could not be decoded. It is removed, and the read reports a miss. */
  onUnreadableChunk?: (chunk: {
    seriesId: string;
    year: number;
    key: string;
    reason: string;
  }) => void;
};

/** Whether a head was published under the encoding and dataset revision this code reads. */
export function isCurrentBenchmarkHead(head: BenchmarkCacheHead): boolean {
  return (
    head.chunkEncodingVersion === BENCHMARK_CHUNK_ENCODING_VERSION &&
    head.priceDatasetVersion === BENCHMARK_PRICE_DATASET_VERSION
  );
}

/** The resident range that holds all of `range`, if any. Resident ranges are disjoint and compacted. */
export function residentRangeCovering(
  ranges: readonly Required<DateRange>[],
  range: Required<DateRange>,
): Required<DateRange> | undefined {
  return ranges.find(
    (resident) => resident.from <= range.from && resident.to >= range.to,
  );
}

export class RedisBenchmarkDataCache implements BenchmarkDataCache {
  private readonly namespace: string;
  private readonly stageTtlMs: number;
  private readonly observer: BenchmarkCacheObserver;

  constructor(
    private readonly redis: RedisCacheClient,
    options: {
      namespace?: string;
      stageTtlMs?: number;
      observer?: BenchmarkCacheObserver;
    } = {},
  ) {
    this.namespace = options.namespace ?? BENCHMARK_CACHE_NAMESPACE;
    this.stageTtlMs = options.stageTtlMs ?? DEFAULT_BENCHMARK_STAGE_TTL_MS;
    this.observer = options.observer ?? {};
    if (!Number.isInteger(this.stageTtlMs) || this.stageTtlMs <= 0) {
      throw new Error("stageTtlMs must be a positive integer");
    }
  }

  async getHead(seriesId: string): Promise<ObservedBenchmarkHead | null> {
    const key = this.headKey(seriesId);
    const raw = await this.redis.get(key);
    if (raw === null) {
      return null;
    }
    const head = parseHead(raw, seriesId);
    if (!head) {
      // A head nothing can parse can never be compared against either, so it would block every
      // later commit. It names nothing readable, so removing it costs one rebuild from PostgreSQL.
      await this.redis.eval(DELETE_IF_EQUAL, 1, key, raw);
      return null;
    }
    return { head, raw };
  }

  async publish(input: {
    expected: ObservedBenchmarkHead | null;
    head: BenchmarkCacheHead;
    stage: ReadonlyMap<number, readonly BenchmarkDailyPrice[]>;
  }): Promise<BenchmarkPublishOutcome> {
    const { head } = input;
    const seriesId = head.seriesId;
    const staged = [...input.stage.entries()].map(([year, rows]) => {
      const digest = head.chunks[String(year)];
      if (digest === undefined) {
        throw new Error(
          `Benchmark publication ${seriesId} stages year ${year}, which its head does not name`,
        );
      }
      return {
        key: this.chunkKey(seriesId, year, digest),
        payload: encodeBenchmarkChunk(seriesId, year, rows),
      };
    });
    for (let offset = 0; offset < staged.length; offset += STAGE_BATCH) {
      const batch = staged.slice(offset, offset + STAGE_BATCH);
      await this.redis.eval(
        STAGE_CHUNKS,
        1 + batch.length,
        this.registryKey(seriesId),
        ...batch.map((chunk) => chunk.key),
        String(this.stageTtlMs),
        ...batch.map((chunk) => chunk.payload),
      );
    }

    const referenced = Object.entries(head.chunks).map(([year, digest]) =>
      this.chunkKey(seriesId, Number(year), digest),
    );
    const result = await this.redis.eval(
      COMMIT_HEAD,
      2 + referenced.length,
      this.headKey(seriesId),
      this.registryKey(seriesId),
      ...referenced,
      input.expected?.raw ?? "",
      JSON.stringify(head),
    );
    if (result === 1) {
      // A commit over no head is the first in this layout, or the first after an invalidation that
      // may have left the previous layout's years behind; either way they go now.
      await this.removeLegacyLayout(seriesId, input.expected === null);
      return "COMMITTED";
    }
    return result === -1 ? "MISSING_CHUNKS" : "CONFLICT";
  }

  async invalidateManifest(seriesId: string): Promise<void> {
    // The chunks stay registered; the next commit removes every one its head does not name.
    await this.redis.del(
      this.headKey(seriesId),
      this.legacyManifestKey(seriesId),
    );
  }

  /**
   * Removes a series' whole projection — head, registry and every registered chunk — in one atomic
   * step, and returns how many chunks went. For an operator reset that also discarded the
   * PostgreSQL rows: a head left behind would keep answering historical reads with bars the
   * database no longer holds, and chunks left behind carry no expiry. Only this series' keys are
   * touched; nothing is flushed.
   */
  async discardProjection(seriesId: string): Promise<number> {
    const removed = await this.redis.eval(
      DISCARD_PROJECTION,
      3,
      this.headKey(seriesId),
      this.registryKey(seriesId),
      this.legacyManifestKey(seriesId),
    );
    await this.removeLegacyYears(seriesId);
    return typeof removed === "number" ? removed : 0;
  }

  async readDailyPrices(
    seriesId: string,
    range: Required<DateRange>,
  ): Promise<BenchmarkCacheRead | null> {
    if (range.from > range.to) {
      return null;
    }
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      const observed = await this.getHead(seriesId);
      if (!observed || !isCurrentBenchmarkHead(observed.head)) {
        return null;
      }
      // Every year the head names inside the range, and only those: a year without a chunk holds
      // no stored bar, so it contributes nothing, and coverage is the caller's to compare.
      const years = yearsInRange(range).filter(
        (year) => observed.head.chunks[String(year)] !== undefined,
      );
      const rows = await this.readYears(observed.head, years, range);
      if (rows === "MOVED") {
        continue;
      }
      if (rows === "UNREADABLE") {
        return null;
      }
      return { rows, head: observed.head };
    }
    return null;
  }

  async readSessionsThrough(
    seriesId: string,
    through: LocalDate,
    sessions: number,
  ): Promise<BenchmarkCacheRead | null> {
    if (!Number.isInteger(sessions) || sessions <= 0) {
      return null;
    }
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      const observed = await this.getHead(seriesId);
      if (!observed || !isCurrentBenchmarkHead(observed.head)) {
        return null;
      }
      const head = observed.head;
      // Newest year first, and only as many years as the window can need: a year holds at most
      // 252 sessions, so the first pass is rarely followed by a second.
      const chunkYears = Object.keys(head.chunks)
        .map(Number)
        .filter((year) => year <= Number(through.slice(0, 4)))
        .sort((left, right) => right - left);
      const collected: BenchmarkDailyPrice[] = [];
      let moved = false;
      let unreadable = false;
      let index = 0;
      while (collected.length < sessions && index < chunkYears.length) {
        const needed =
          Math.ceil((sessions - collected.length) / SESSIONS_PER_YEAR) + 1;
        const batch = chunkYears.slice(index, index + needed);
        index += batch.length;
        const rows = await this.readYears(head, batch, {
          from: EARLIEST_DATE,
          to: through,
        });
        if (rows === "MOVED") {
          moved = true;
          break;
        }
        if (rows === "UNREADABLE") {
          unreadable = true;
          break;
        }
        collected.unshift(...rows);
      }
      if (moved) {
        continue;
      }
      if (unreadable) {
        return null;
      }
      // The head holds every stored bar, so a window shorter than asked is the whole history.
      return { rows: collected.slice(-sessions), head };
    }
    return null;
  }

  async readHistoryThrough(
    seriesId: string,
    through: LocalDate,
  ): Promise<(BenchmarkCacheRead & { from: LocalDate }) | null> {
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
      const observed = await this.getHead(seriesId);
      if (!observed || !isCurrentBenchmarkHead(observed.head)) {
        return null;
      }
      const head = observed.head;
      const from = [head.residentRanges[0]?.from, head.firstDate]
        .filter((date): date is LocalDate => date !== undefined)
        .sort()[0];
      if (from === undefined || through < from) {
        return { rows: [], head, from: from ?? through };
      }
      const years = Object.keys(head.chunks)
        .map(Number)
        .filter((year) => year <= Number(through.slice(0, 4)));
      const rows = await this.readYears(head, years, { from, to: through });
      if (rows === "MOVED") {
        continue;
      }
      if (rows === "UNREADABLE") {
        return null;
      }
      return { rows, head, from };
    }
    return null;
  }

  async chunksPresent(head: BenchmarkCacheHead): Promise<boolean> {
    const keys = Object.entries(head.chunks).map(([year, digest]) =>
      this.chunkKey(head.seriesId, Number(year), digest),
    );
    if (keys.length === 0) {
      return true;
    }
    const present = await this.redis.eval(COUNT_EXISTING, keys.length, ...keys);
    return Number(present) === keys.length;
  }

  private async readYears(
    head: BenchmarkCacheHead,
    years: readonly number[],
    range: Required<DateRange>,
  ): Promise<BenchmarkDailyPrice[] | "MOVED" | "UNREADABLE"> {
    if (years.length === 0) {
      return [];
    }
    const ascending = [...years].sort((left, right) => left - right);
    const keys = ascending.map((year) =>
      this.chunkKey(head.seriesId, year, head.chunks[String(year)] as string),
    );
    const payloads = await this.redis.mget(...keys);
    if (payloads.some((payload) => payload === null)) {
      // The head moved on and its predecessor's chunks were removed. Never patched up from
      // whatever is still there: the caller reads the new head instead.
      return "MOVED";
    }
    const rows: BenchmarkDailyPrice[] = [];
    for (const [index, year] of ascending.entries()) {
      const decoded = decodeBenchmarkChunk(
        payloads[index] as string,
        { seriesId: head.seriesId, year },
        range,
      );
      if (!decoded.ok) {
        const key = keys[index] as string;
        this.observer.onUnreadableChunk?.({
          seriesId: head.seriesId,
          year,
          key,
          reason: decoded.reason,
        });
        // Removed so the next publication cannot reuse it: the head naming a missing chunk makes
        // the commit rebuild every year from PostgreSQL.
        await this.redis.del(key);
        return "UNREADABLE";
      }
      rows.push(...decoded.rows);
    }
    return rows;
  }

  private async removeLegacyLayout(
    seriesId: string,
    always: boolean,
  ): Promise<void> {
    if (
      !always &&
      (await this.redis.get(this.legacyManifestKey(seriesId))) === null
    ) {
      return;
    }
    await this.redis.del(this.legacyManifestKey(seriesId));
    await this.removeLegacyYears(seriesId);
  }

  private async removeLegacyYears(seriesId: string): Promise<void> {
    const lastYear = new Date().getUTCFullYear() + 1;
    const keys: string[] = [];
    for (let year = LEGACY_FIRST_YEAR; year <= lastYear; year += 1) {
      keys.push(`${this.seriesPrefix(seriesId)}:daily-price:${year}`);
    }
    await this.redis.del(...keys);
  }

  private seriesPrefix(seriesId: string): string {
    return `${this.namespace}:benchmark:${seriesId}`;
  }

  private headKey(seriesId: string): string {
    return `${this.seriesPrefix(seriesId)}:head`;
  }

  private registryKey(seriesId: string): string {
    return `${this.seriesPrefix(seriesId)}:chunks`;
  }

  private legacyManifestKey(seriesId: string): string {
    return `${this.seriesPrefix(seriesId)}:manifest`;
  }

  private chunkKey(seriesId: string, year: number, digest: string): string {
    return `${this.seriesPrefix(seriesId)}:daily-price:v${BENCHMARK_CHUNK_ENCODING_VERSION}:${year}:${digest}`;
  }
}

function parseHead(raw: string, seriesId: string): BenchmarkCacheHead | null {
  try {
    const parsed = JSON.parse(raw) as Partial<BenchmarkCacheHead>;
    if (
      parsed.seriesId !== seriesId ||
      typeof parsed.chunkEncodingVersion !== "number" ||
      typeof parsed.priceDatasetVersion !== "number" ||
      typeof parsed.basisGeneration !== "number" ||
      !Array.isArray(parsed.residentRanges) ||
      typeof parsed.chunks !== "object" ||
      parsed.chunks === null ||
      typeof parsed.materializedAt !== "string"
    ) {
      return null;
    }
    return parsed as BenchmarkCacheHead;
  } catch {
    return null;
  }
}

/**
 * Writes chunks that do not exist yet with an expiry, refreshes the expiry of chunks staged earlier,
 * and leaves a committed chunk — no expiry — untouched: its key names its content, so it already
 * holds exactly these bytes. Every key is recorded in the series' registry.
 *
 * KEYS[1] registry, KEYS[2..] chunk keys; ARGV[1] expiry in ms, ARGV[2..] payloads.
 */
const STAGE_CHUNKS = `
-- benchmark-stage-chunks
for i = 2, #KEYS do
  local ttl = redis.call('PTTL', KEYS[i])
  if ttl == -2 then
    redis.call('SET', KEYS[i], ARGV[i], 'PX', ARGV[1])
  elseif ttl > 0 then
    redis.call('PEXPIRE', KEYS[i], ARGV[1])
  end
  redis.call('SADD', KEYS[1], KEYS[i])
end
return #KEYS - 1
`;

/**
 * Commits a head atomically.
 *
 * Refuses (0) when the stored head is not the expected one, and (-1) when a chunk the new head names
 * does not exist. Otherwise makes every named chunk permanent, swaps the head, and deletes every
 * registered chunk the new head does not name — the previous publication's and any abandoned
 * stage's. A reader holding the previous head then finds its chunks gone and re-reads the head.
 *
 * KEYS[1] head, KEYS[2] registry, KEYS[3..] chunks the new head names; ARGV[1] expected head ('' for
 * none), ARGV[2] new head.
 */
const COMMIT_HEAD = `
-- benchmark-commit-head
local current = redis.call('GET', KEYS[1])
if ARGV[1] == '' then
  if current ~= false then return 0 end
elseif current ~= ARGV[1] then
  return 0
end
local keep = {}
for i = 3, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 0 then return -1 end
  keep[KEYS[i]] = true
end
for i = 3, #KEYS do
  redis.call('PERSIST', KEYS[i])
  redis.call('SADD', KEYS[2], KEYS[i])
end
redis.call('SET', KEYS[1], ARGV[2])
local members = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(members) do
  if not keep[key] then
    redis.call('DEL', key)
    redis.call('SREM', KEYS[2], key)
  end
end
return 1
`;

/**
 * Deletes a series' head, registry, legacy manifest and every registered chunk, atomically.
 *
 * KEYS[1] head, KEYS[2] registry, KEYS[3] legacy manifest. Returns the number of chunks removed.
 */
const DISCARD_PROJECTION = `
-- benchmark-discard-projection
local members = redis.call('SMEMBERS', KEYS[2])
for _, key in ipairs(members) do
  redis.call('DEL', key)
end
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
return #members
`;

/** Counts how many of KEYS exist. */
const COUNT_EXISTING = `
-- benchmark-count-existing
local present = 0
for i = 1, #KEYS do
  present = present + redis.call('EXISTS', KEYS[i])
end
return present
`;

const DELETE_IF_EQUAL = `
-- benchmark-delete-if-equal
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

/** In-memory double for tests and any process without Redis. Never used in production wiring. */
export class NullBenchmarkDataCache implements BenchmarkDataCache {
  async getHead(): Promise<ObservedBenchmarkHead | null> {
    return null;
  }

  async publish(): Promise<BenchmarkPublishOutcome> {
    return "COMMITTED";
  }

  async invalidateManifest(): Promise<void> {}

  async discardProjection(): Promise<number> {
    return 0;
  }

  async chunksPresent(): Promise<boolean> {
    return true;
  }

  async readDailyPrices(): Promise<BenchmarkCacheRead | null> {
    return null;
  }

  async readSessionsThrough(): Promise<BenchmarkCacheRead | null> {
    return null;
  }

  async readHistoryThrough(): Promise<
    (BenchmarkCacheRead & { from: LocalDate }) | null
  > {
    return null;
  }
}

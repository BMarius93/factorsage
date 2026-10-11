import type {
  BenchmarkDailyPrice,
  DateRange,
  LocalDate,
} from "@intrinsic/domain";

/**
 * The bytes of one benchmark series' bars for one calendar year in Redis.
 *
 * Column-oriented for the same reason the stock `daily-state` chunk is: the row form repeated the
 * series id and every field name on every bar (150 bytes a bar), and a full-history projection of
 * twenty ETFs is about 125,000 bars. One array per field is about a third of that.
 *
 * ```json
 * {"v":1,"s":"<seriesId>","y":2026,"d":["2026-01-02",…],"o":[…],"h":[…],"l":[…],"c":[…],"x":[…]}
 * ```
 *
 * A chunk is immutable once published: its Redis key carries the digest of the stored rows it was
 * built from (`benchmark-cache.ts`), so a different history is a different key. The decoder still
 * validates every structural claim — version, identity, equal column lengths, dates strictly
 * ascending inside the chunk's own year, finite prices — and reports a failure instead of returning
 * a partial or reordered history, so the caller rebuilds from PostgreSQL.
 */
export const BENCHMARK_CHUNK_ENCODING_VERSION = 1;

type EncodedChunk = {
  v: number;
  s: string;
  y: number;
  d: string[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  x: number[];
};

export type DecodedBenchmarkChunk =
  { ok: true; rows: BenchmarkDailyPrice[] } | { ok: false; reason: string };

/**
 * Encodes one year of bars. Rows outside `year` are a caller error and throw, as do two rows for one
 * date: a chunk is exactly one series' sessions in one year, each once.
 */
export function encodeBenchmarkChunk(
  seriesId: string,
  year: number,
  rows: readonly BenchmarkDailyPrice[],
): string {
  const sorted = [...rows].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  const prefix = `${year}-`;
  const chunk: EncodedChunk = {
    v: BENCHMARK_CHUNK_ENCODING_VERSION,
    s: seriesId,
    y: year,
    d: [],
    o: [],
    h: [],
    l: [],
    c: [],
    x: [],
  };
  for (const row of sorted) {
    if (!row.date.startsWith(prefix)) {
      throw new Error(
        `Benchmark chunk ${seriesId}/${year} was given a bar dated ${row.date}`,
      );
    }
    if (chunk.d.at(-1) === row.date) {
      throw new Error(
        `Benchmark chunk ${seriesId}/${year} was given two bars for ${row.date}`,
      );
    }
    chunk.d.push(row.date);
    chunk.o.push(row.open);
    chunk.h.push(row.high);
    chunk.l.push(row.low);
    chunk.c.push(row.close);
    chunk.x.push(row.volume);
  }
  return JSON.stringify(chunk);
}

/**
 * Decodes a chunk and returns its bars inside `range` (all of them when omitted), ascending.
 *
 * Every check that fails names itself in `reason`; nothing partial is ever returned.
 */
export function decodeBenchmarkChunk(
  payload: string,
  expected: { seriesId: string; year: number },
  range?: Required<DateRange>,
): DecodedBenchmarkChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { ok: false, reason: "not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "not an object" };
  }
  const chunk = parsed as Partial<EncodedChunk>;
  if (chunk.v !== BENCHMARK_CHUNK_ENCODING_VERSION) {
    return { ok: false, reason: `encoding version ${String(chunk.v)}` };
  }
  if (chunk.s !== expected.seriesId) {
    return { ok: false, reason: "series id mismatch" };
  }
  if (chunk.y !== expected.year) {
    return { ok: false, reason: "year mismatch" };
  }
  const columns = [chunk.d, chunk.o, chunk.h, chunk.l, chunk.c, chunk.x];
  if (!columns.every((column) => Array.isArray(column))) {
    return { ok: false, reason: "missing column" };
  }
  const dates = chunk.d as unknown[];
  if (
    !columns.every((column) => (column as unknown[]).length === dates.length)
  ) {
    return { ok: false, reason: "column lengths differ" };
  }

  const prefix = `${expected.year}-`;
  const rows: BenchmarkDailyPrice[] = [];
  let previous: string | undefined;
  for (let index = 0; index < dates.length; index += 1) {
    const date = dates[index];
    if (
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !date.startsWith(prefix)
    ) {
      return { ok: false, reason: `invalid date at ${index}` };
    }
    if (previous !== undefined && date <= previous) {
      return { ok: false, reason: `dates not strictly ascending at ${index}` };
    }
    previous = date;
    const values = [
      (chunk.o as unknown[])[index],
      (chunk.h as unknown[])[index],
      (chunk.l as unknown[])[index],
      (chunk.c as unknown[])[index],
      (chunk.x as unknown[])[index],
    ];
    if (
      !values.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    ) {
      return { ok: false, reason: `non-finite value at ${index}` };
    }
    if (range && (date < range.from || date > range.to)) {
      continue;
    }
    const [open, high, low, close, volume] = values as number[];
    rows.push({
      seriesId: expected.seriesId,
      date: date as LocalDate,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: volume as number,
    });
  }
  return { ok: true, rows };
}

import type { BenchmarkDailyPrice } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import {
  BENCHMARK_CHUNK_ENCODING_VERSION,
  decodeBenchmarkChunk,
  encodeBenchmarkChunk,
} from "./benchmark-chunk.js";

const SERIES = "series-1";

function bar(date: string, close: number): BenchmarkDailyPrice {
  return {
    seriesId: SERIES,
    date,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: 1_000 + close,
  };
}

describe("benchmark year chunk", () => {
  it("round-trips one year of bars, ascending, whatever order they were given in", () => {
    const rows = [
      bar("2024-03-04", 12.5),
      bar("2024-01-02", 10.25),
      bar("2024-02-01", 11),
    ];
    const decoded = decodeBenchmarkChunk(
      encodeBenchmarkChunk(SERIES, 2024, rows),
      { seriesId: SERIES, year: 2024 },
    );
    expect(decoded).toEqual({
      ok: true,
      rows: [
        bar("2024-01-02", 10.25),
        bar("2024-02-01", 11),
        bar("2024-03-04", 12.5),
      ],
    });
  });

  it("is about a third of the row form's size", () => {
    const rows = Array.from({ length: 252 }, (_, index) =>
      bar(
        `2024-${String(1 + Math.floor(index / 21)).padStart(2, "0")}-${String(1 + (index % 21)).padStart(2, "0")}`,
        670.12 + index / 100,
      ),
    ).map((row) => ({
      ...row,
      seriesId: "6f1c2e4a-8c1d-4a7b-9e3f-0a1b2c3d4e5f",
    }));
    const columnar = encodeBenchmarkChunk(
      "6f1c2e4a-8c1d-4a7b-9e3f-0a1b2c3d4e5f",
      2024,
      rows,
    ).length;
    const rowForm = JSON.stringify(rows).length;
    expect(columnar).toBeLessThan(rowForm * 0.5);
  });

  it("slices to a range without returning anything outside it", () => {
    const payload = encodeBenchmarkChunk(SERIES, 2024, [
      bar("2024-01-02", 1),
      bar("2024-06-03", 2),
      bar("2024-12-31", 3),
    ]);
    const decoded = decodeBenchmarkChunk(
      payload,
      { seriesId: SERIES, year: 2024 },
      { from: "2024-06-01", to: "2024-06-30" },
    );
    expect(decoded.ok && decoded.rows.map((row) => row.date)).toEqual([
      "2024-06-03",
    ]);
  });

  it("refuses to encode a bar from another year or two bars for one date", () => {
    expect(() =>
      encodeBenchmarkChunk(SERIES, 2024, [bar("2023-12-29", 1)]),
    ).toThrow(/2023-12-29/);
    expect(() =>
      encodeBenchmarkChunk(SERIES, 2024, [
        bar("2024-01-02", 1),
        bar("2024-01-02", 2),
      ]),
    ).toThrow(/two bars/);
  });

  it.each([
    ["not JSON", "{", /not JSON/],
    ["another encoding", JSON.stringify({ v: 99 }), /encoding version/],
    [
      "another series",
      encodeBenchmarkChunk("other", 2024, [bar("2024-01-02", 1)]),
      /series id/,
    ],
    [
      "another year",
      encodeBenchmarkChunk(SERIES, 2023, [bar("2023-01-03", 1)]),
      /year mismatch/,
    ],
    [
      "columns of different lengths",
      JSON.stringify({
        v: BENCHMARK_CHUNK_ENCODING_VERSION,
        s: SERIES,
        y: 2024,
        d: ["2024-01-02"],
        o: [],
        h: [1],
        l: [1],
        c: [1],
        x: [1],
      }),
      /column lengths/,
    ],
    [
      "dates out of order",
      JSON.stringify({
        v: BENCHMARK_CHUNK_ENCODING_VERSION,
        s: SERIES,
        y: 2024,
        d: ["2024-01-03", "2024-01-02"],
        o: [1, 1],
        h: [1, 1],
        l: [1, 1],
        c: [1, 1],
        x: [1, 1],
      }),
      /strictly ascending/,
    ],
    [
      "a non-finite close",
      JSON.stringify({
        v: BENCHMARK_CHUNK_ENCODING_VERSION,
        s: SERIES,
        y: 2024,
        d: ["2024-01-02"],
        o: [1],
        h: [1],
        l: [1],
        c: [null],
        x: [1],
      }),
      /non-finite/,
    ],
  ])(
    "reports %s instead of returning a partial history",
    (_, payload, reason) => {
      const decoded = decodeBenchmarkChunk(payload as string, {
        seriesId: SERIES,
        year: 2024,
      });
      expect(decoded.ok).toBe(false);
      expect(!decoded.ok && decoded.reason).toMatch(reason as RegExp);
    },
  );
});

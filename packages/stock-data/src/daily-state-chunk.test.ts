import type { DailyDerivedState } from "@intrinsic/domain";
import { describe, expect, it } from "vitest";
import { BACKTEST_DATA_REVISIONS } from "./backtest-data-revisions.js";
import {
  DAILY_STATE_CHUNK_FIELDS,
  DAILY_STATE_ENCODING_VERSION,
  decodeDailyStateChunk,
  encodeDailyStateChunk,
} from "./daily-state-chunk.js";
import {
  DAILY_DERIVED_STATE_VARIANT,
  DERIVED_STATE_REVISION,
} from "./derived-state.js";

const SECURITY = "security-chunk";

/**
 * Every field of the daily derived state, nested families included, with none optional. A field
 * added to `DailyDerivedState` (or a model or blend added to its registry) makes the fixtures below
 * fail to compile until they carry it — and then the round trips fail until the chunk has a column
 * for it, which is the only way a new field could otherwise silently never reach Redis.
 */
type FullRow = Required<
  Omit<DailyDerivedState, "intrinsicValues" | "intrinsicValueBlends">
> & {
  intrinsicValues: Required<NonNullable<DailyDerivedState["intrinsicValues"]>>;
  intrinsicValueBlends: Required<
    NonNullable<DailyDerivedState["intrinsicValueBlends"]>
  >;
};

/**
 * Distinct literals on every field, written in the order PostgreSQL's row mapper
 * (`dailyDerivedStateFromRow`) writes them, so a decoded row can be compared byte for byte too.
 */
function fullRow(date: string): FullRow {
  return {
    securityId: SECURITY,
    date,
    sma20d: 101.01,
    sma50d: 102.02,
    sma100d: 103.03,
    sma200d: 104.04,
    ema20d: 105.05,
    ema50d: 106.06,
    ema200d: 107.07,
    weeklySourceWeekStart: "2024-03-04",
    sma20w: 201.01,
    sma50w: 202.02,
    sma100w: 203.03,
    sma200w: 204.04,
    ema20w: 205.05,
    ema50w: 206.06,
    ema200w: 207.07,
    rsi7d: 7.77,
    rsi14d: 14.14,
    rsi21d: 21.21,
    rvol10: 0.1,
    rvol20: 0.2,
    rvol50: 0.5,
    revenueGrowthTtmYoy: 11.11,
    epsGrowthTtmYoy: 22.22,
    fcfGrowthTtmYoy: 33.33,
    grossMarginTtm: 44.44,
    operatingMarginTtm: 55.55,
    netMarginTtm: 66.66,
    fcfMarginTtm: 77.77,
    roicTtm: 88.88,
    roeTtm: 99.99,
    roaTtm: 10.01,
    debtToEquity: 1.11,
    currentRatio: 2.22,
    netDebtToEbitdaTtm: -3.33,
    interestCoverageTtm: 4.44,
    assetTurnoverTtm: 0.55,
    intrinsicValues: {
      DCF_FCFF: 301.01,
      RESIDUAL_INCOME: 302.02,
      DDM: 303.03,
      GRAHAM: 304.04,
    },
    intrinsicValueBlends: {
      BALANCED: 401.01,
      CONSERVATIVE: 402.02,
      DIVIDEND: 403.03,
    },
    dcfFcffSourceAsOf: "2024-02-01T00:00:00.000Z",
    residualIncomeSourceAsOf: "2024-02-02T00:00:00.000Z",
    ddmSourceAsOf: "2024-02-03T00:00:00.000Z",
    grahamSourceAsOf: "2024-02-04T00:00:00.000Z",
    intrinsicCurrency: "USD",
  };
}

/** The dictionary, stated independently of the registries it is built from. */
const EXPECTED_FIELDS = [
  "sma20d",
  "sma50d",
  "sma100d",
  "sma200d",
  "ema20d",
  "ema50d",
  "ema200d",
  "weeklySourceWeekStart",
  "sma20w",
  "sma50w",
  "sma100w",
  "sma200w",
  "ema20w",
  "ema50w",
  "ema200w",
  "rsi7d",
  "rsi14d",
  "rsi21d",
  "rvol10",
  "rvol20",
  "rvol50",
  "revenueGrowthTtmYoy",
  "epsGrowthTtmYoy",
  "fcfGrowthTtmYoy",
  "grossMarginTtm",
  "operatingMarginTtm",
  "netMarginTtm",
  "fcfMarginTtm",
  "roicTtm",
  "roeTtm",
  "roaTtm",
  "debtToEquity",
  "currentRatio",
  "netDebtToEbitdaTtm",
  "interestCoverageTtm",
  "assetTurnoverTtm",
  "intrinsicValues.DCF_FCFF",
  "intrinsicValues.RESIDUAL_INCOME",
  "intrinsicValues.DDM",
  "intrinsicValues.GRAHAM",
  "intrinsicValueBlends.BALANCED",
  "intrinsicValueBlends.CONSERVATIVE",
  "intrinsicValueBlends.DIVIDEND",
  "dcfFcffSourceAsOf",
  "residualIncomeSourceAsOf",
  "ddmSourceAsOf",
  "grahamSourceAsOf",
  "intrinsicCurrency",
];

/** What `fullRow` stores in each named column — literals, not read back off the fixture. */
const FULL_ROW_CELLS: Record<string, number | string> = {
  sma20d: 101.01,
  sma50d: 102.02,
  sma100d: 103.03,
  sma200d: 104.04,
  ema20d: 105.05,
  ema50d: 106.06,
  ema200d: 107.07,
  weeklySourceWeekStart: "2024-03-04",
  sma20w: 201.01,
  sma50w: 202.02,
  sma100w: 203.03,
  sma200w: 204.04,
  ema20w: 205.05,
  ema50w: 206.06,
  ema200w: 207.07,
  rsi7d: 7.77,
  rsi14d: 14.14,
  rsi21d: 21.21,
  rvol10: 0.1,
  rvol20: 0.2,
  rvol50: 0.5,
  revenueGrowthTtmYoy: 11.11,
  epsGrowthTtmYoy: 22.22,
  fcfGrowthTtmYoy: 33.33,
  grossMarginTtm: 44.44,
  operatingMarginTtm: 55.55,
  netMarginTtm: 66.66,
  fcfMarginTtm: 77.77,
  roicTtm: 88.88,
  roeTtm: 99.99,
  roaTtm: 10.01,
  debtToEquity: 1.11,
  currentRatio: 2.22,
  netDebtToEbitdaTtm: -3.33,
  interestCoverageTtm: 4.44,
  assetTurnoverTtm: 0.55,
  "intrinsicValues.DCF_FCFF": 301.01,
  "intrinsicValues.RESIDUAL_INCOME": 302.02,
  "intrinsicValues.DDM": 303.03,
  "intrinsicValues.GRAHAM": 304.04,
  "intrinsicValueBlends.BALANCED": 401.01,
  "intrinsicValueBlends.CONSERVATIVE": 402.02,
  "intrinsicValueBlends.DIVIDEND": 403.03,
  dcfFcffSourceAsOf: "2024-02-01T00:00:00.000Z",
  residualIncomeSourceAsOf: "2024-02-02T00:00:00.000Z",
  ddmSourceAsOf: "2024-02-03T00:00:00.000Z",
  grahamSourceAsOf: "2024-02-04T00:00:00.000Z",
  intrinsicCurrency: "USD",
};

type ParsedChunk = {
  version: number;
  securityId: string;
  year: number;
  fields: string[];
  dates: string[];
  columns: unknown[][];
};

function parse(payload: string): ParsedChunk {
  return JSON.parse(payload) as ParsedChunk;
}

function decoded(
  payload: string,
  year = 2024,
  range?: { from: string; to: string },
): DailyDerivedState[] {
  const result = decodeDailyStateChunk(
    payload,
    { securityId: SECURITY, year },
    range,
  );
  if (!result.ok) {
    throw new Error(`expected a readable chunk: ${result.reason}`);
  }
  return result.rows;
}

function roundTrip(
  rows: readonly DailyDerivedState[],
  year = 2024,
): DailyDerivedState[] {
  return decoded(encodeDailyStateChunk(SECURITY, year, rows), year);
}

/** Removes one dictionary path from a row: a top-level field, or one key of a nested family. */
function without(row: FullRow, path: string): DailyDerivedState {
  const copy = structuredClone(row) as Record<string, unknown>;
  const [field, key] = path.split(".") as [string, string | undefined];
  if (key === undefined) {
    delete copy[field];
  } else {
    delete (copy[field] as Record<string, unknown>)[key];
  }
  return copy as DailyDerivedState;
}

function reasonOf(payload: string, year = 2024): string {
  const result = decodeDailyStateChunk(payload, { securityId: SECURITY, year });
  if (result.ok) {
    throw new Error("expected an unreadable chunk");
  }
  return result.reason;
}

/** A readable chunk as a mutable object, for building damaged variants of it. */
function editable(
  rows: readonly DailyDerivedState[] = [fullRow("2024-03-15")],
) {
  return parse(
    encodeDailyStateChunk(SECURITY, 2024, rows),
  ) as unknown as Record<string, unknown> & {
    columns: unknown[][];
    dates: unknown[];
    fields: unknown[];
  };
}

describe("daily-state chunk encoding version", () => {
  it("is a cache encoding, separate from the derived-state methodology revision", () => {
    expect(DAILY_STATE_ENCODING_VERSION).toBe(2);
    // The methodology did not change: no value moved, so nothing durable is invalidated.
    expect(DERIVED_STATE_REVISION).toBe(7);
    expect(DAILY_DERIVED_STATE_VARIANT).toBe("daily-derived-state:r7");
    // A backtest records what can move a number it sees; a cache encoding cannot.
    expect(Object.keys(BACKTEST_DATA_REVISIONS).sort()).toEqual([
      "benchmarkPriceDatasetVersion",
      "derivedStateRevision",
      "fundamentalsVariantVersion",
      "priceBasisRevision",
      "priceDatasetVersion",
    ]);
  });

  it("carries exactly one column per field, in canonical order", () => {
    expect(DAILY_STATE_CHUNK_FIELDS).toEqual(EXPECTED_FIELDS);
    expect(new Set(DAILY_STATE_CHUNK_FIELDS).size).toBe(48);
  });
});

describe("daily-state chunk round trip", () => {
  it("returns every field of a fully populated row exactly, in PostgreSQL's key order", () => {
    const row = fullRow("2024-03-15");
    const [back] = roundTrip([row]);
    expect(back).toStrictEqual(row);
    expect(JSON.stringify(back)).toBe(JSON.stringify(row));
  });

  it("stores each named column's own value (the bytes, not only the round trip)", () => {
    const chunk = parse(
      encodeDailyStateChunk(SECURITY, 2024, [fullRow("2024-03-15")]),
    );
    expect(chunk.fields).toEqual(EXPECTED_FIELDS);
    for (const [name, value] of Object.entries(FULL_ROW_CELLS)) {
      expect(chunk.columns[chunk.fields.indexOf(name)], name).toEqual([value]);
    }
    expect(Object.keys(FULL_ROW_CELLS)).toEqual(EXPECTED_FIELDS);
  });

  it("maps all fifteen Fundamentals to their own fields", () => {
    const [back] = roundTrip([fullRow("2024-03-15")]);
    expect(back?.revenueGrowthTtmYoy).toBe(11.11);
    expect(back?.epsGrowthTtmYoy).toBe(22.22);
    expect(back?.fcfGrowthTtmYoy).toBe(33.33);
    expect(back?.grossMarginTtm).toBe(44.44);
    expect(back?.operatingMarginTtm).toBe(55.55);
    expect(back?.netMarginTtm).toBe(66.66);
    expect(back?.fcfMarginTtm).toBe(77.77);
    expect(back?.roicTtm).toBe(88.88);
    expect(back?.roeTtm).toBe(99.99);
    expect(back?.roaTtm).toBe(10.01);
    expect(back?.debtToEquity).toBe(1.11);
    expect(back?.currentRatio).toBe(2.22);
    expect(back?.netDebtToEbitdaTtm).toBe(-3.33);
    expect(back?.interestCoverageTtm).toBe(4.44);
    expect(back?.assetTurnoverTtm).toBe(0.55);
  });

  it("maps the technical, oscillator and Relative Volume periods to their own fields", () => {
    const [back] = roundTrip([fullRow("2024-03-15")]);
    expect([back?.sma20d, back?.sma50d, back?.sma100d, back?.sma200d]).toEqual([
      101.01, 102.02, 103.03, 104.04,
    ]);
    expect([back?.ema20d, back?.ema50d, back?.ema200d]).toEqual([
      105.05, 106.06, 107.07,
    ]);
    expect([back?.sma20w, back?.sma50w, back?.sma100w, back?.sma200w]).toEqual([
      201.01, 202.02, 203.03, 204.04,
    ]);
    expect([back?.ema20w, back?.ema50w, back?.ema200w]).toEqual([
      205.05, 206.06, 207.07,
    ]);
    expect([back?.rsi7d, back?.rsi14d, back?.rsi21d]).toEqual([
      7.77, 14.14, 21.21,
    ]);
    expect([back?.rvol10, back?.rvol20, back?.rvol50]).toEqual([0.1, 0.2, 0.5]);
    expect(back?.weeklySourceWeekStart).toBe("2024-03-04");
  });

  it("maps every intrinsic model, blend and provenance instant to its own slot", () => {
    const [back] = roundTrip([fullRow("2024-03-15")]);
    expect(back?.intrinsicValues).toStrictEqual({
      DCF_FCFF: 301.01,
      RESIDUAL_INCOME: 302.02,
      DDM: 303.03,
      GRAHAM: 304.04,
    });
    expect(back?.intrinsicValueBlends).toStrictEqual({
      BALANCED: 401.01,
      CONSERVATIVE: 402.02,
      DIVIDEND: 403.03,
    });
    expect(back?.dcfFcffSourceAsOf).toBe("2024-02-01T00:00:00.000Z");
    expect(back?.residualIncomeSourceAsOf).toBe("2024-02-02T00:00:00.000Z");
    expect(back?.ddmSourceAsOf).toBe("2024-02-03T00:00:00.000Z");
    expect(back?.grahamSourceAsOf).toBe("2024-02-04T00:00:00.000Z");
    expect(back?.intrinsicCurrency).toBe("USD");
  });

  it.each(EXPECTED_FIELDS)(
    "keeps %s absent when it alone is missing, and every other field intact",
    (path) => {
      const row = without(fullRow("2024-03-15"), path);
      const [back] = roundTrip([row]);
      expect(back).toStrictEqual(row);
      const [field, key] = path.split(".") as [string, string | undefined];
      const holder = back as Record<string, unknown>;
      if (key === undefined) {
        expect(field in holder).toBe(false);
      } else {
        expect(key in (holder[field] as Record<string, unknown>)).toBe(false);
      }
    },
  );

  it("omits a nested family entirely when none of its members has a value", () => {
    const row = fullRow("2024-03-15") as DailyDerivedState;
    delete row.intrinsicValues;
    delete row.intrinsicValueBlends;
    const [back] = roundTrip([row]);
    expect("intrinsicValues" in (back as object)).toBe(false);
    expect("intrinsicValueBlends" in (back as object)).toBe(false);
    expect(back).toStrictEqual(row);
  });

  it("materializes rows whose set of fields changes from session to session, and back", () => {
    // Each pair of sessions shares a pattern of absent fields and the patterns recur, so the decoder
    // both reuses a row shape and returns to one it built earlier.
    const rows = Array.from({ length: 80 }, (_, session) => {
      const date = new Date(Date.UTC(2024, 0, 1 + session))
        .toISOString()
        .slice(0, 10);
      let row = {
        ...fullRow(date),
        sma20d: 100 + session,
      } as DailyDerivedState;
      const pattern = (session >> 1) % 11;
      for (const [position, path] of EXPECTED_FIELDS.entries()) {
        if (((pattern * 7 + 3) * (position + 1)) % 11 < 3) {
          row = without(row as FullRow, path);
        }
      }
      for (const family of [
        "intrinsicValues",
        "intrinsicValueBlends",
      ] as const) {
        if (Object.keys(row[family] ?? {}).length === 0) {
          delete row[family];
        }
      }
      return row;
    });
    expect(
      new Set(rows.map((row) => JSON.stringify(Object.keys(row)))).size,
    ).toBe(11);
    const back = roundTrip(rows);
    expect(back).toStrictEqual(rows);
    expect(JSON.stringify(back)).toBe(JSON.stringify(rows));
  });

  it("returns a row that carries only its identity as exactly that", () => {
    const bare: DailyDerivedState = {
      securityId: SECURITY,
      date: "2024-03-15",
    };
    expect(roundTrip([bare])).toStrictEqual([bare]);
  });

  it("keeps zero, negative, fractional and extreme finite values exactly", () => {
    const values = [
      0,
      -1,
      -0.000_000_01,
      0.000_000_01,
      -9.090_909_09,
      27.182_795_7,
      123_456_789_012.345_67,
      999_999_999_999.999_9,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      -Number.MAX_VALUE,
      0.1 + 0.2,
    ];
    const rows = values.map((value, index) => ({
      securityId: SECURITY,
      date: `2024-01-${String(index + 2).padStart(2, "0")}`,
      roicTtm: value,
      netDebtToEbitdaTtm: -value,
      intrinsicValues: { GRAHAM: value },
    }));
    const back = roundTrip(rows);
    expect(back.map((row) => row.roicTtm)).toStrictEqual(values);
    expect(back.map((row) => row.intrinsicValues?.GRAHAM)).toStrictEqual(
      values,
    );
    back.forEach((row, index) =>
      expect(
        Object.is(row.netDebtToEbitdaTtm, -(values[index] as number)),
      ).toBe(index === 0 ? false : true),
    );
  });

  it("writes -0 as 0, exactly as the row-oriented chunk and PostgreSQL did", () => {
    const [back] = roundTrip([
      { securityId: SECURITY, date: "2024-01-02", sma20d: -0 },
    ]);
    // PostgreSQL's numeric has no negative zero, and JSON never had one: legacy JSON.stringify(-0)
    // is "0" too. What matters is that it stays a value and never becomes absence.
    expect(Object.is(back?.sma20d, 0)).toBe(true);
    expect(JSON.parse(JSON.stringify(-0))).toBe(0);
  });
});

describe("absence and zero", () => {
  const rows: DailyDerivedState[] = [
    {
      securityId: SECURITY,
      date: "2024-01-02",
      roicTtm: 0,
      rvol20: 0,
      rsi14d: 0,
    },
    { securityId: SECURITY, date: "2024-01-03" },
    {
      securityId: SECURITY,
      date: "2024-01-04",
      roicTtm: 0,
      rvol20: 0,
      rsi14d: 0,
    },
    { securityId: SECURITY, date: "2024-01-05", roicTtm: -4.5 },
    { securityId: SECURITY, date: "2024-01-08" },
    { securityId: SECURITY, date: "2024-01-09" },
    { securityId: SECURITY, date: "2024-01-10", roicTtm: 0 },
  ];

  it("keeps a real zero a value and a missing value absent, session by session", () => {
    const back = roundTrip(rows);
    expect(back).toStrictEqual(rows);
    for (const [index, row] of back.entries()) {
      const source = rows[index] as DailyDerivedState;
      for (const field of ["roicTtm", "rvol20", "rsi14d"] as const) {
        expect(field in row, `${row.date} ${field}`).toBe(field in source);
      }
    }
    expect(Object.is(back[0]?.roicTtm, 0)).toBe(true);
    expect(back[3]?.roicTtm).toBe(-4.5);
  });

  it("writes absence as a count, never as null or zero", () => {
    const payload = encodeDailyStateChunk(SECURITY, 2024, rows);
    expect(payload).not.toContain("null");
    const chunk = parse(payload);
    expect(chunk.columns[chunk.fields.indexOf("roicTtm")]).toEqual([
      0,
      [1],
      0,
      -4.5,
      [2],
      0,
    ]);
    // A column with no value anywhere is one absent run over the whole axis.
    expect(chunk.columns[chunk.fields.indexOf("roeTtm")]).toEqual([[7]]);
  });

  it("refuses a null cell rather than reading it as absence or zero", () => {
    const chunk = editable(rows);
    chunk.columns[chunk.fields.indexOf("roicTtm")] = [0, null, 0, -4.5, [2], 0];
    expect(reasonOf(JSON.stringify(chunk))).toContain("column roicTtm");
  });
});

describe("carried-forward values and their provenance", () => {
  // Three statement events: 01-02 (both models), 01-05 (DCF restated, DDM invalidated),
  // 01-09 (DDM back with a new source; DCF's value unchanged but re-sourced).
  const sessions = [
    "2024-01-02",
    "2024-01-03",
    "2024-01-04",
    "2024-01-05",
    "2024-01-08",
    "2024-01-09",
    "2024-01-10",
  ];
  const DCF = [100, 100, 100, 120, 120, 120, 120];
  const DCF_SOURCE = [
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.000Z",
    "2024-01-05T00:00:00.000Z",
    "2024-01-05T00:00:00.000Z",
    "2024-01-09T00:00:00.000Z",
    "2024-01-09T00:00:00.000Z",
  ];
  const DDM = [50, 50, 50, undefined, undefined, 55, 55];
  const DDM_SOURCE = [
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.000Z",
    undefined,
    undefined,
    "2024-01-09T00:00:00.000Z",
    "2024-01-09T00:00:00.000Z",
  ];
  const rows: DailyDerivedState[] = sessions.map((date, index) => ({
    securityId: SECURITY,
    date,
    roicTtm: index < 3 ? 12 : 18,
    intrinsicValues: {
      DCF_FCFF: DCF[index] as number,
      ...(DDM[index] === undefined ? {} : { DDM: DDM[index] }),
    },
    dcfFcffSourceAsOf: DCF_SOURCE[index] as string,
    ...(DDM_SOURCE[index] === undefined
      ? {}
      : { ddmSourceAsOf: DDM_SOURCE[index] }),
    intrinsicCurrency: "USD",
  }));

  it("reads every model's value back beside its own provenance, on its own session", () => {
    const back = roundTrip(rows);
    expect(back).toStrictEqual(rows);
    back.forEach((row, index) => {
      expect(row.intrinsicValues?.DCF_FCFF, row.date).toBe(DCF[index]);
      expect(row.dcfFcffSourceAsOf, row.date).toBe(DCF_SOURCE[index]);
      expect(row.intrinsicValues?.DDM, row.date).toBe(DDM[index]);
      expect(row.ddmSourceAsOf, row.date).toBe(DDM_SOURCE[index]);
    });
  });

  it("stores a value and its provenance as runs over the same sessions", () => {
    const chunk = parse(encodeDailyStateChunk(SECURITY, 2024, rows));
    const column = (name: string) => chunk.columns[chunk.fields.indexOf(name)];
    expect(column("intrinsicValues.DCF_FCFF")).toEqual([
      [100, 3],
      [120, 4],
    ]);
    // The re-sourced DCF keeps its value but starts a new provenance run on 01-09.
    expect(column("dcfFcffSourceAsOf")).toEqual([
      ["2024-01-01T00:00:00.000Z", 3],
      ["2024-01-05T00:00:00.000Z", 2],
      ["2024-01-09T00:00:00.000Z", 2],
    ]);
    expect(column("intrinsicValues.DDM")).toEqual([[50, 3], [2], [55, 2]]);
    expect(column("ddmSourceAsOf")).toEqual([
      ["2024-01-01T00:00:00.000Z", 3],
      [2],
      ["2024-01-09T00:00:00.000Z", 2],
    ]);
    expect(column("roicTtm")).toEqual([
      [12, 3],
      [18, 4],
    ]);
    expect(column("intrinsicCurrency")).toEqual([["USD", 7]]);
  });

  it("never carries a value into a gap: an invalidated stretch stays absent", () => {
    const back = roundTrip(rows);
    expect("DDM" in (back[3]?.intrinsicValues ?? {})).toBe(false);
    expect("DDM" in (back[4]?.intrinsicValues ?? {})).toBe(false);
    expect(back[3]?.ddmSourceAsOf).toBeUndefined();
    expect(back[4]?.ddmSourceAsOf).toBeUndefined();
  });
});

describe("determinism", () => {
  const rows = [fullRow("2024-03-14"), fullRow("2024-03-15")].map(
    (row, index) => ({
      ...row,
      sma20d: 100 + index,
    }),
  );

  it("encodes the same rows to the same bytes, every time", () => {
    const first = encodeDailyStateChunk(SECURITY, 2024, rows);
    for (let repeat = 0; repeat < 5; repeat += 1) {
      expect(encodeDailyStateChunk(SECURITY, 2024, rows)).toBe(first);
    }
  });

  it("does not depend on the order rows arrive in or the order their properties were created", () => {
    const expected = encodeDailyStateChunk(SECURITY, 2024, rows);
    const reversedProperties = rows.map(
      (row) =>
        Object.fromEntries(
          Object.entries(row)
            .reverse()
            .map(([key, value]) => [
              key,
              value !== null && typeof value === "object"
                ? Object.fromEntries(Object.entries(value).reverse())
                : value,
            ]),
        ) as DailyDerivedState,
    );
    expect(
      encodeDailyStateChunk(SECURITY, 2024, [...reversedProperties].reverse()),
    ).toBe(expected);
  });

  it("pins the layout of a small chunk byte for byte", () => {
    const small: DailyDerivedState[] = [
      {
        securityId: SECURITY,
        date: "2024-01-02",
        sma20d: 10,
        roicTtm: 15.5,
        intrinsicValues: { DCF_FCFF: 100 },
        dcfFcffSourceAsOf: "2024-01-01T00:00:00.000Z",
        intrinsicCurrency: "USD",
      },
      {
        securityId: SECURITY,
        date: "2024-01-03",
        sma20d: 11,
        roicTtm: 15.5,
        intrinsicValues: { DCF_FCFF: 100 },
        dcfFcffSourceAsOf: "2024-01-01T00:00:00.000Z",
        intrinsicCurrency: "USD",
      },
      {
        securityId: SECURITY,
        date: "2024-01-04",
        sma20d: 12,
        intrinsicValues: { DCF_FCFF: 101 },
        dcfFcffSourceAsOf: "2024-01-04T00:00:00.000Z",
        intrinsicCurrency: "USD",
      },
    ];
    const absent = "[[3]]";
    const columns = EXPECTED_FIELDS.map((name) => {
      switch (name) {
        case "sma20d":
          return "[10,11,12]";
        case "roicTtm":
          return "[[15.5,2],[1]]";
        case "intrinsicValues.DCF_FCFF":
          return "[[100,2],101]";
        case "dcfFcffSourceAsOf":
          return '[["2024-01-01T00:00:00.000Z",2],"2024-01-04T00:00:00.000Z"]';
        case "intrinsicCurrency":
          return '[["USD",3]]';
        default:
          return absent;
      }
    });
    expect(encodeDailyStateChunk(SECURITY, 2024, small)).toBe(
      `{"version":2,"securityId":"${SECURITY}","year":2024,` +
        `"fields":${JSON.stringify(EXPECTED_FIELDS)},` +
        `"dates":["2024-01-02","2024-01-03","2024-01-04"],` +
        `"columns":[${columns.join(",")}]}`,
    );
  });
});

describe("the date axis and year boundaries", () => {
  const year2024 = [
    "2024-01-02",
    "2024-01-03",
    "2024-02-28",
    "2024-02-29",
    "2024-03-01",
    "2024-07-03",
    "2024-07-05",
    "2024-12-30",
    "2024-12-31",
  ].map((date, index) => ({
    securityId: SECURITY,
    date,
    sma20d: 50 + index,
    roicTtm: index < 4 ? 9 : undefined,
  }));

  it("returns the first and last sessions of the year, the leap day and no holiday", () => {
    const back = roundTrip(year2024);
    expect(back.map((row) => row.date)).toEqual(
      year2024.map((row) => row.date),
    );
    expect(back[3]).toStrictEqual({
      securityId: SECURITY,
      date: "2024-02-29",
      sma20d: 53,
      roicTtm: 9,
    });
  });

  it("materializes only the requested range and still validates the rest", () => {
    const payload = encodeDailyStateChunk(SECURITY, 2024, year2024);
    expect(
      decoded(payload, 2024, { from: "2023-12-20", to: "2024-01-02" }).map(
        (row) => row.date,
      ),
    ).toEqual(["2024-01-02"]);
    expect(
      decoded(payload, 2024, { from: "2024-02-29", to: "2024-07-04" }),
    ).toStrictEqual(year2024.slice(3, 6).map((row) => roundTrip([row])[0]));
    expect(
      decoded(payload, 2024, { from: "2024-12-31", to: "2025-01-10" }).map(
        (row) => row.date,
      ),
    ).toEqual(["2024-12-31"]);
    expect(
      decoded(payload, 2024, { from: "2025-01-01", to: "2025-01-10" }),
    ).toEqual([]);
    expect(
      decoded(payload, 2024, { from: "2024-07-04", to: "2024-07-04" }),
    ).toEqual([]);

    const damaged = parse(payload);
    damaged.columns[damaged.fields.indexOf("sma20d")]![8] = "fifty-eight";
    const result = decodeDailyStateChunk(
      JSON.stringify(damaged),
      { securityId: SECURITY, year: 2024 },
      { from: "2024-01-02", to: "2024-01-03" },
    );
    expect(result.ok).toBe(false);
  });

  it("encodes an empty year as a readable empty chunk", () => {
    expect(roundTrip([], 1995)).toEqual([]);
  });
});

describe("encoder refusals", () => {
  const row = (overrides: Record<string, unknown>) =>
    ({
      securityId: SECURITY,
      date: "2024-01-02",
      ...overrides,
    }) as DailyDerivedState;

  it.each([
    ["NaN", { sma20d: Number.NaN }],
    ["Infinity", { roicTtm: Number.POSITIVE_INFINITY }],
    ["-Infinity", { intrinsicValues: { DDM: Number.NEGATIVE_INFINITY } }],
    ["null", { rvol20: null }],
    ["a string in a numeric field", { rsi14d: "53" }],
    ["a number in a text field", { dcfFcffSourceAsOf: 1_704_067_200_000 }],
  ])("refuses %s rather than turning it into absence", (_name, overrides) => {
    expect(() =>
      encodeDailyStateChunk(SECURITY, 2024, [row(overrides)]),
    ).toThrow(/Refusing to encode/);
  });

  it("refuses a row of another security, another year or a repeated date", () => {
    expect(() =>
      encodeDailyStateChunk(SECURITY, 2024, [
        { securityId: "someone-else", date: "2024-01-02" },
      ]),
    ).toThrow(/someone-else/);
    expect(() =>
      encodeDailyStateChunk(SECURITY, 2024, [row({ date: "2025-01-02" })]),
    ).toThrow(/2025-01-02/);
    expect(() =>
      encodeDailyStateChunk(SECURITY, 2024, [row({}), row({ sma20d: 1 })]),
    ).toThrow(/duplicate 2024-01-02/);
    expect(() => encodeDailyStateChunk(SECURITY, 2024.5, [])).toThrow(
      /integer/,
    );
  });
});

describe("unreadable chunks", () => {
  const good = () => editable();

  it("accepts the chunk it wrote", () => {
    expect(
      decodeDailyStateChunk(JSON.stringify(good()), {
        securityId: SECURITY,
        year: 2024,
      }).ok,
    ).toBe(true);
  });

  it("refuses bytes that are not a version-2 chunk", () => {
    expect(reasonOf("{not json")).toBe("the payload is not JSON");
    expect(reasonOf("")).toBe("the payload is not JSON");
    // A version-1 chunk: a row array whose rows would otherwise look perfectly plausible.
    expect(reasonOf(JSON.stringify([fullRow("2024-03-15")]))).toContain(
      "version-1 chunk is an array",
    );
    expect(reasonOf("null")).toContain("not a version-2 chunk");
    expect(reasonOf("42")).toContain("not a version-2 chunk");
  });

  it.each([
    ["missing", undefined, "missing"],
    ["1", 1, "is 1"],
    ["a future 3", 3, "is 3"],
    ['"2"', "2", 'is "2"'],
  ])("refuses a %s encoding version", (_name, version, expected) => {
    const chunk = good();
    if (version === undefined) {
      delete chunk.version;
    } else {
      chunk.version = version;
    }
    expect(reasonOf(JSON.stringify(chunk))).toContain(expected);
  });

  it("refuses a chunk of another security or year", () => {
    const payload = JSON.stringify(good());
    expect(
      decodeDailyStateChunk(payload, { securityId: "other", year: 2024 }).ok,
    ).toBe(false);
    expect(reasonOf(payload, 2023)).toContain("year 2024");
  });

  it.each([
    ["one field missing", (fields: unknown[]) => fields.slice(1)],
    ["an extra field", (fields: unknown[]) => [...fields, "peRatio"]],
    [
      "ROIC and ROE swapped",
      (fields: unknown[]) =>
        fields.map((field) =>
          field === "roicTtm"
            ? "roeTtm"
            : field === "roeTtm"
              ? "roicTtm"
              : field,
        ),
    ],
    [
      "a renamed field",
      (fields: unknown[]) =>
        fields.map((field) => (field === "roicTtm" ? "roic" : field)),
    ],
  ])("refuses a field dictionary with %s", (_name, edit) => {
    const chunk = good();
    chunk.fields = edit(chunk.fields);
    expect(reasonOf(JSON.stringify(chunk))).toContain("field dictionary");
  });

  it.each([
    ["not a list", "2024-03-15", "not a list"],
    ["a malformed date", ["2024-3-15"], '"2024-3-15"'],
    ["a date of another year", ["2023-12-29"], "outside 2024"],
    [
      "a descending axis",
      ["2024-03-15", "2024-03-14"],
      "not strictly ascending",
    ],
    ["a repeated date", ["2024-03-15", "2024-03-15"], "not strictly ascending"],
    ["a non-string date", [20_240_315], "20240315"],
  ])("refuses a date axis that is %s", (_name, dates, expected) => {
    const chunk = good();
    chunk.dates = dates as unknown[];
    expect(reasonOf(JSON.stringify(chunk))).toContain(expected);
  });

  it("refuses columns that do not cover the date axis exactly", () => {
    const short = good();
    short.dates = ["2024-03-14", "2024-03-15"];
    expect(reasonOf(JSON.stringify(short))).toContain("1 cells for 2 dates");

    const long = good();
    long.columns[0] = [101.01, 101.02];
    expect(reasonOf(JSON.stringify(long))).toContain(
      "more cells than the 1 dates",
    );

    const missingColumn = good();
    missingColumn.columns = missingColumn.columns.slice(1);
    expect(reasonOf(JSON.stringify(missingColumn))).toContain(
      "47 columns, not 48",
    );
  });

  it.each([
    ["a run of one", [[101.01, 1]], "a run of 1 sessions"],
    ["a run of zero", [[101.01, 0], 101.01], "a run of 0 sessions"],
    ["a negative absent run", [[-1]], "absent run of -1"],
    ["a fractional run", [[1.5]], "absent run of 1.5"],
    ["an empty cell", [[]], "a cell of 0 elements"],
    ["a three-element cell", [[101.01, 1, 1]], "a cell of 3 elements"],
    ["a string in a numeric column", ["101.01"], 'a string cell "101.01"'],
    ["a boolean in a numeric column", [true], "a boolean cell"],
  ])("refuses a column holding %s", (_name, cells, expected) => {
    const chunk = good();
    chunk.columns[0] = cells as unknown[];
    expect(reasonOf(JSON.stringify(chunk))).toContain(expected);
  });

  it("refuses an overflowing number rather than reading Infinity", () => {
    const payload = JSON.stringify(good()).replace("[101.01]", "[1e999]");
    expect(reasonOf(payload)).toBe(
      "column sma20d: a number cell Infinity in a number column",
    );
  });

  it("refuses a number in a text column", () => {
    const chunk = good();
    chunk.columns[chunk.fields.indexOf("dcfFcffSourceAsOf")] = [
      1_706_745_600_000,
    ];
    expect(reasonOf(JSON.stringify(chunk))).toContain(
      "column dcfFcffSourceAsOf",
    );
  });
});

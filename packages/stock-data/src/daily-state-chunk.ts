import {
  DAILY_MOVING_AVERAGES,
  DAILY_OSCILLATORS,
  DAILY_RELATIVE_VOLUMES,
  FUNDAMENTAL_METRIC_FIELDS,
  INTRINSIC_VALUE_BLEND_IDS,
  INTRINSIC_VALUE_MODELS,
  WEEKLY_MOVING_AVERAGES,
  type DailyDerivedState,
  type DateRange,
} from "@intrinsic/domain";
import { assertOneRowPerTradingDay } from "./derived-state.js";
import { INTRINSIC_MODEL_SOURCE_FIELDS } from "./intrinsic-values.js";

/**
 * Version of the Redis `daily-state` chunk encoding: how one security's yearly derived state is laid
 * out as bytes, and nothing else.
 *
 * It is **not** `DERIVED_STATE_REVISION`. The revision says which methodology produced the values
 * and is recorded in PostgreSQL coverage; this says how the cache spells those same values, so it
 * never reaches PostgreSQL, a backtest snapshot (`BACKTEST_DATA_REVISIONS` excludes cache versions
 * by design) or any value a consumer reads. Changing it costs one rebuild of the Redis projection
 * from PostgreSQL and cannot change a number.
 *
 * - 1 (implicit, never written with a marker): a JSON array of whole `DailyDerivedState` rows, every
 *   field name repeated on every row. Retired: the names were over half of every chunk.
 * - 2: one date axis and one run-length column per field, described in {@link encodeDailyStateChunk}.
 *
 * The version appears three times, and each is a separate guard: in the chunk key, so two encodings
 * never share a key; in the stock manifest, so a manifest published over version-1 chunks is not
 * current and the security is rebuilt before anything is read; and in the payload, so bytes of any
 * other shape are refused rather than guessed at.
 */
export const DAILY_STATE_ENCODING_VERSION = 2;

type ColumnKind = "number" | "text";

/**
 * One column of a chunk: where its value lives on a `DailyDerivedState` row and what it may hold.
 *
 * `key` is set for the two nested families, whose values live one level down
 * (`intrinsicValues.DDM`); every other column is a top-level field.
 */
type DailyStateColumn = {
  readonly name: string;
  readonly kind: ColumnKind;
  readonly field: keyof DailyDerivedState;
  readonly key?: string;
};

const numberColumn = (field: keyof DailyDerivedState): DailyStateColumn => ({
  name: field,
  kind: "number",
  field,
});

const textColumn = (field: keyof DailyDerivedState): DailyStateColumn => ({
  name: field,
  kind: "text",
  field,
});

const nestedColumn = (
  field: "intrinsicValues" | "intrinsicValueBlends",
  key: string,
): DailyStateColumn => ({
  name: `${field}.${key}`,
  kind: "number",
  field,
  key,
});

/**
 * Every column a chunk carries, in canonical order, built from the registries that define the
 * fields rather than from a second list of them — a series added to a registry is carried without
 * editing this file.
 *
 * The order is load-bearing twice over. It is the byte order of every encoded chunk, and it is the
 * order a decoded row receives its fields, which is exactly the order `dailyDerivedStateFromRow`
 * writes a row read from PostgreSQL. A decoded row therefore serializes byte for byte like the row
 * PostgreSQL produced, which is what the parity tests compare.
 *
 * Only the registries are trusted to be complete here. `daily-state-chunk.test.ts` builds a row
 * typed `Required<DailyDerivedState>`, so a field added to the domain type fails to compile there
 * until it has a value, and then fails the round trip until it has a column.
 */
const COLUMNS: readonly DailyStateColumn[] = [
  ...DAILY_MOVING_AVERAGES.map(({ field }) => numberColumn(field)),
  textColumn("weeklySourceWeekStart"),
  ...WEEKLY_MOVING_AVERAGES.map(({ field }) => numberColumn(field)),
  ...DAILY_OSCILLATORS.map(({ field }) => numberColumn(field)),
  ...DAILY_RELATIVE_VOLUMES.map(({ field }) => numberColumn(field)),
  ...FUNDAMENTAL_METRIC_FIELDS.map((field) => numberColumn(field)),
  ...INTRINSIC_VALUE_MODELS.map((model) =>
    nestedColumn("intrinsicValues", model),
  ),
  ...INTRINSIC_VALUE_BLEND_IDS.map((blendId) =>
    nestedColumn("intrinsicValueBlends", blendId),
  ),
  // A model's provenance is its own column beside its value, aligned to the same date axis, so the
  // two can only ever be read back on the same session.
  ...INTRINSIC_VALUE_MODELS.map((model) =>
    textColumn(INTRINSIC_MODEL_SOURCE_FIELDS[model]),
  ),
  textColumn("intrinsicCurrency"),
];

/**
 * The field dictionary every chunk carries: the column names, in order. A chunk whose dictionary is
 * not exactly this one was written for a different set of fields and is refused.
 */
export const DAILY_STATE_CHUNK_FIELDS: readonly string[] = COLUMNS.map(
  (column) => column.name,
);

const FIELDS_JSON = JSON.stringify(DAILY_STATE_CHUNK_FIELDS);

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Encodes one security's daily derived state for one calendar year as a version-2 chunk.
 *
 * ```text
 * {"version":2,"securityId":"…","year":2024,
 *  "fields":["sma20d",…,"intrinsicValues.DCF_FCFF",…,"intrinsicCurrency"],
 *  "dates":["2024-01-02","2024-01-03",…],
 *  "columns":[[187.5,188.25,…],…,[["USD",252]]]}
 * ```
 *
 * `dates` is the chunk's one axis: every session of the year that has a row, ascending, each once.
 * `columns[i]` is the column `fields[i]` names, as a list of cells that together cover every date
 * exactly once, in order:
 *
 * - a number or a string — the value on one session;
 * - `[value, count]`, with `count` at least 2 — the same value on `count` consecutive sessions;
 * - `[count]` — no value on `count` consecutive sessions.
 *
 * Absence is a count, never a `null` and never a zero: nothing in a chunk can be read as a value on
 * a session that had none. Runs only compress what the rows already repeat — a carried-forward
 * Fundamental or intrinsic value stays one value per session, and a gap stays a gap of exactly its
 * own length — so decoding reconstructs each session's own value and carries nothing anywhere.
 *
 * Deterministic: rows are ordered by date, every field is read by name through the column list, and
 * runs are always maximal, so the same rows produce the same bytes whatever order their properties
 * were created in.
 *
 * Refuses rather than reinterprets: a row of another security or year, a repeated date, a numeric
 * field that is not a finite number, or a text field that is not a string is a defect upstream, and
 * the cache is not the place to quietly turn it into absence.
 */
export function encodeDailyStateChunk(
  securityId: string,
  year: number,
  rows: readonly DailyDerivedState[],
): string {
  if (!Number.isInteger(year)) {
    throw new Error(`A daily-state chunk year must be an integer, got ${year}`);
  }
  const prefix = yearPrefix(year);
  const ordered = [...rows].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );
  assertOneRowPerTradingDay(ordered);
  for (const row of ordered) {
    if (row.securityId !== securityId) {
      throw new Error(
        `Refusing to encode a ${row.securityId} row into ${securityId}'s daily-state chunk`,
      );
    }
    if (!LOCAL_DATE.test(row.date) || !row.date.startsWith(prefix)) {
      throw new Error(
        `Refusing to encode ${row.date} into the ${year} daily-state chunk`,
      );
    }
  }
  const columns = COLUMNS.map((column) => encodeColumn(column, ordered));
  return (
    `{"version":${DAILY_STATE_ENCODING_VERSION}` +
    `,"securityId":${JSON.stringify(securityId)}` +
    `,"year":${year}` +
    `,"fields":${FIELDS_JSON}` +
    `,"dates":${JSON.stringify(ordered.map((row) => row.date))}` +
    `,"columns":${JSON.stringify(columns)}}`
  );
}

export type DailyStateChunkDecoding =
  | { readonly ok: true; readonly rows: DailyDerivedState[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Decodes a version-2 chunk back into the rows it was encoded from, or says why it cannot.
 *
 * The chunk must name the expected security and year, carry exactly the current field dictionary,
 * hold a strictly ascending date axis inside its year, and give every column cells of the right
 * kind covering every date exactly once. Anything else — a version-1 row array, another version,
 * malformed JSON, a column one session short or long — is reported as unreadable, never repaired:
 * the cache treats that as a miss and the security is rebuilt from PostgreSQL, so a damaged chunk
 * costs a rebuild rather than serving damaged history.
 *
 * With a `range`, only the rows whose dates fall inside it are materialized, but the whole chunk is
 * still validated, so a damaged session outside the window is not quietly tolerated either.
 *
 * Rows come back ascending, `securityId` and `date` first and every other field in canonical order,
 * a field present only when its column holds a value on that session — the shape
 * `dailyDerivedStateFromRow` gives the same row read from PostgreSQL.
 */
export function decodeDailyStateChunk(
  payload: string,
  expected: { securityId: string; year: number },
  range?: Required<DateRange>,
): DailyStateChunkDecoding {
  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return unreadable("the payload is not JSON");
  }
  if (!isRecord(chunk)) {
    return unreadable(
      "the payload is not a version-2 chunk object (a version-1 chunk is an array of rows)",
    );
  }
  if (chunk.version !== DAILY_STATE_ENCODING_VERSION) {
    return unreadable(
      `the encoding version is ${JSON.stringify(chunk.version) ?? "missing"}, not ${DAILY_STATE_ENCODING_VERSION}`,
    );
  }
  if (chunk.securityId !== expected.securityId) {
    return unreadable(
      `the chunk belongs to ${JSON.stringify(chunk.securityId)}, not ${expected.securityId}`,
    );
  }
  if (chunk.year !== expected.year) {
    return unreadable(
      `the chunk holds year ${JSON.stringify(chunk.year)}, not ${expected.year}`,
    );
  }
  if (!sameFieldDictionary(chunk.fields)) {
    return unreadable(
      "the field dictionary differs from this version's columns",
    );
  }
  const dates = chunk.dates;
  const datesFailure = dateAxisFailure(dates, expected.year);
  if (datesFailure) {
    return unreadable(datesFailure);
  }
  const axis = dates as string[];
  const columns = chunk.columns;
  if (!Array.isArray(columns) || columns.length !== COLUMNS.length) {
    return unreadable(
      `the chunk holds ${Array.isArray(columns) ? columns.length : "no"} columns, not ${COLUMNS.length}`,
    );
  }

  const first = range ? lowerBound(axis, range.from) : 0;
  const end = Math.max(first, range ? upperBound(axis, range.to) : axis.length);
  const values: Cell[][] = [];
  for (const [position, column] of COLUMNS.entries()) {
    const expanded = new Array<Cell>(end - first);
    const failure = expandColumn(
      column,
      columns[position],
      axis.length,
      first,
      end,
      expanded,
    );
    if (failure) {
      return unreadable(`column ${column.name}: ${failure}`);
    }
    values.push(expanded);
  }
  return {
    ok: true,
    rows: materializeRows(expected.securityId, axis, first, end, values),
  };
}

function encodeColumn(
  column: DailyStateColumn,
  rows: readonly DailyDerivedState[],
): unknown[] {
  const values = rows.map((row) => cellOf(column, row));
  const cells: unknown[] = [];
  let start = 0;
  while (start < values.length) {
    const value = values[start];
    let end = start + 1;
    while (end < values.length && values[end] === value) {
      end += 1;
    }
    const count = end - start;
    if (value === undefined) {
      cells.push([count]);
    } else {
      cells.push(count === 1 ? value : [value, count]);
    }
    start = end;
  }
  return cells;
}

/** The value one row holds for a column, `undefined` when it holds none; refuses a wrong type. */
function cellOf(
  column: DailyStateColumn,
  row: DailyDerivedState,
): number | string | undefined {
  const holder = row[column.field];
  const value =
    column.key === undefined
      ? holder
      : (holder as Record<string, unknown> | undefined)?.[column.key];
  if (value === undefined) {
    return undefined;
  }
  if (column.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `Refusing to encode ${column.name} = ${String(value)} for ${row.date}: not a finite number`,
      );
    }
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Refusing to encode ${column.name} = ${String(value)} for ${row.date}: not a string`,
    );
  }
  return value;
}

/** One session's value in one column; `undefined` when the session has none. */
type Cell = number | string | undefined;

/**
 * Walks one column's cells over the whole date axis, writing the values that fall inside
 * `[first, end)` into `expanded` (index 0 is `first`). Returns why the column is unreadable, or
 * `null` when it is sound.
 */
function expandColumn(
  column: DailyStateColumn,
  cells: unknown,
  sessions: number,
  first: number,
  end: number,
  expanded: Cell[],
): string | null {
  if (!Array.isArray(cells)) {
    return "not a list of cells";
  }
  let index = 0;
  for (const cell of cells) {
    let value: unknown;
    let count: number;
    if (!Array.isArray(cell)) {
      value = cell;
      count = 1;
    } else if (cell.length === 1) {
      value = undefined;
      count = cell[0] as number;
      if (!Number.isSafeInteger(count) || count < 1) {
        return `an absent run of ${JSON.stringify(cell[0])} sessions`;
      }
    } else if (cell.length === 2) {
      value = cell[0];
      count = cell[1] as number;
      if (!Number.isSafeInteger(count) || count < 2) {
        return `a run of ${JSON.stringify(cell[1])} sessions`;
      }
    } else {
      return `a cell of ${cell.length} elements`;
    }
    if (value !== undefined && !holdsKind(column.kind, value)) {
      const shown =
        typeof value === "number" ? String(value) : JSON.stringify(value);
      return `a ${typeof value} cell ${shown} in a ${column.kind} column`;
    }
    if (index + count > sessions) {
      return `more cells than the ${sessions} dates`;
    }
    if (value !== undefined) {
      const from = Math.max(index, first);
      const to = Math.min(index + count, end);
      for (let session = from; session < to; session += 1) {
        expanded[session - first] = value as number | string;
      }
    }
    index += count;
  }
  return index === sessions ? null : `${index} cells for ${sessions} dates`;
}

/**
 * Builds the window's rows, session by session, from the expanded columns.
 *
 * Each row is a clone of a template that already holds exactly that row's fields, in canonical
 * order, and only its values are then written. That is deliberate. V8 keeps an object's
 * properties fast only while few are added through computed keys: a row assembled field by field
 * (`row[field] = value`) degrades to a dictionary-mode object, measured at over three times the
 * heap of the same row from `JSON.parse` and slower for every consumer to read. Writing properties
 * the clone already has adds none, so every row keeps the shape a parsed row has. Rows with the same
 * fields share one template, and consecutive rows almost always do.
 */
function materializeRows(
  securityId: string,
  axis: readonly string[],
  first: number,
  end: number,
  values: readonly Cell[][],
): DailyDerivedState[] {
  const rows = new Array<DailyDerivedState>(end - first);
  const templates = new Map<string, Record<string, unknown>>();
  let template: Record<string, unknown> | undefined;
  for (let offset = 0; offset < end - first; offset += 1) {
    if (template === undefined || shapeChanged(values, offset)) {
      // Which columns hold a value, one character per column: exact for any number of columns.
      const shape = values
        .map((column) => (column[offset] === undefined ? "0" : "1"))
        .join("");
      template = templates.get(shape);
      if (template === undefined) {
        template = rowTemplate(securityId, values, offset);
        templates.set(shape, template);
      }
    }
    const row: Record<string, unknown> = { ...template };
    row.date = axis[first + offset];
    let nested: Record<string, unknown> | undefined;
    let nestedField: string | undefined;
    // An index loop, not `entries()`: this runs once per column on every row of every read, and an
    // `[index, column]` pair per step was most of the garbage a thirty-year decode produced.
    for (let position = 0; position < COLUMNS.length; position += 1) {
      const column = COLUMNS[position] as DailyStateColumn;
      const value = (values[position] as Cell[])[offset];
      if (value === undefined) {
        continue;
      }
      if (column.key === undefined) {
        row[column.field] = value;
        continue;
      }
      // A nested family's columns are adjacent: the first present one gives the row its own object.
      if (nestedField !== column.field) {
        nested = {};
        nestedField = column.field;
        row[column.field] = nested;
      }
      (nested as Record<string, unknown>)[column.key] = value;
    }
    rows[offset] = row as DailyDerivedState;
  }
  return rows;
}

/** Whether the session at `offset` holds values in different columns from the one before it. */
function shapeChanged(values: readonly Cell[][], offset: number): boolean {
  for (const column of values) {
    if ((column[offset] === undefined) !== (column[offset - 1] === undefined)) {
      return true;
    }
  }
  return false;
}

/**
 * A row holding exactly the fields present at `offset`, in canonical order. A nested family
 * appears once, where its first present member is.
 *
 * Every placeholder is `null`, never a number of the field's kind. A numeric placeholder makes V8
 * store the field as an unboxed double, so every clone allocates a box of its own per numeric
 * field; a tagged field instead lets each row hold the very number the parser produced, which a
 * run shares across all of its sessions. Measured on a thirty-year history, that is the difference
 * between more garbage than `JSON.parse` of the old rows and less.
 */
function rowTemplate(
  securityId: string,
  values: readonly Cell[][],
  offset: number,
): Record<string, unknown> {
  const entries: [string, null | string][] = [
    ["securityId", securityId],
    ["date", ""],
  ];
  let nestedField: string | undefined;
  for (const [position, column] of COLUMNS.entries()) {
    if ((values[position] as Cell[])[offset] === undefined) {
      continue;
    }
    if (column.key === undefined || nestedField !== column.field) {
      nestedField = column.key === undefined ? undefined : column.field;
      entries.push([column.field, null]);
    }
  }
  return Object.fromEntries(entries);
}

function holdsKind(kind: ColumnKind, value: unknown): boolean {
  return kind === "number"
    ? typeof value === "number" && Number.isFinite(value)
    : typeof value === "string";
}

function dateAxisFailure(dates: unknown, year: number): string | null {
  if (!Array.isArray(dates)) {
    return "the date axis is not a list";
  }
  const prefix = yearPrefix(year);
  let previous = "";
  for (const date of dates) {
    if (typeof date !== "string" || !LOCAL_DATE.test(date)) {
      return `the date axis holds ${JSON.stringify(date)}`;
    }
    if (!date.startsWith(prefix)) {
      return `the date axis holds ${date} outside ${year}`;
    }
    if (date <= previous) {
      return `the date axis is not strictly ascending at ${date}`;
    }
    previous = date;
  }
  return null;
}

function sameFieldDictionary(fields: unknown): boolean {
  return (
    Array.isArray(fields) &&
    fields.length === DAILY_STATE_CHUNK_FIELDS.length &&
    fields.every((field, index) => field === DAILY_STATE_CHUNK_FIELDS[index])
  );
}

/** The first index whose date is on or after `date`. */
function lowerBound(dates: readonly string[], date: string): number {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((dates[middle] as string) < date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/** The first index whose date is after `date`. */
function upperBound(dates: readonly string[], date: string): number {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((dates[middle] as string) <= date) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function yearPrefix(year: number): string {
  return `${String(year).padStart(4, "0")}-`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unreadable(reason: string): DailyStateChunkDecoding {
  return { ok: false, reason };
}

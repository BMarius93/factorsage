import {
  findSelectableSeries,
  type SelectableSeriesId,
} from "@intrinsic/contracts";
import type {
  DailyDerivedState,
  DailyPrice,
  LocalDate,
  Security,
} from "@intrinsic/domain";
import {
  createEvaluationFrame,
  PRICE_OPERAND,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import {
  blendSourceDataAsOf,
  intrinsicModelSourceAsOf,
} from "./intrinsic-values.js";

/**
 * Calendar days of context read before a backtest period starts.
 *
 * A Trigger needs the immediately preceding eligible value, so without at least one earlier trading
 * day every Trigger on the first simulated date would be NOT_EVALUABLE. Ten calendar days clears
 * any weekend plus holiday closure. It costs nothing to materialize: the load target is already
 * widened by the derived-series warm-up, so these rows are always resident anyway.
 */
export const TRIGGER_CONTEXT_CALENDAR_DAYS = 10;

/** How an operand column is read from the aligned price and derived rows. */
type ColumnReader = (
  price: DailyPrice,
  derived: DailyDerivedState | undefined,
) => number;

/**
 * Diagnostics a caller can log without the projector reaching for a logger.
 *
 * `datesWithoutDerivedState` should be zero: the materializer writes exactly one derived row per
 * trading day. A non-zero count means those days' derived operands were unavailable, which is
 * point-in-time honest but worth surfacing — it is a data-integrity signal, not normal.
 */
export type EvaluationFrameDiagnostics = {
  datesWithoutDerivedState: number;
};

export type ProjectedEvaluationFrame = {
  frame: EvaluationFrame;
  diagnostics: EvaluationFrameDiagnostics;
};

/**
 * Projects one security's aligned history into the compact columnar frame the evaluator consumes.
 *
 * Two properties make this the right place for the projection rather than the engine:
 *
 * 1. **The intrinsic provenance gate is applied here.** `getDailyDerivedState` returns raw rows, so
 *    a reader that forgot the per-model / per-blend gate would silently read a value whose inputs
 *    were not yet public — a no-look-ahead violation. Applying it during projection means the pure
 *    evaluator physically cannot see an ungated value.
 * 2. **Only the operands the strategy references are materialized.** Carrying raw rows for a long
 *    multi-security run costs gigabytes; these columns cost tens of megabytes.
 *
 * `NaN` is the single representation of an absent value, and it is never a substitute for zero:
 * `RSI = 0` and `Margin of Safety = 0` are real readings.
 */
export function projectEvaluationFrame(input: {
  security: Security;
  prices: readonly DailyPrice[];
  derived: readonly DailyDerivedState[];
  operands: readonly OperandKey[];
  periodStart: LocalDate;
}): ProjectedEvaluationFrame {
  const { prices, derived, operands, periodStart, security } = input;

  const derivedByDate = new Map<LocalDate, DailyDerivedState>();
  for (const row of derived) {
    derivedByDate.set(row.date, row);
  }

  // The price series is the eligible-trading-day axis: a day without a close cannot be valued,
  // executed on, or used as a `Price` operand, so it is not a day of this security's history.
  const rows = [...prices].sort((left, right) =>
    left.date < right.date ? -1 : left.date > right.date ? 1 : 0,
  );

  const dates: LocalDate[] = [];
  const closes = new Float64Array(rows.length);
  const readers = new Map<OperandKey, ColumnReader>();
  const columns = new Map<OperandKey, Float64Array>();
  for (const key of operands) {
    if (key === PRICE_OPERAND) {
      continue;
    }
    readers.set(key, columnReaderFor(key));
    columns.set(key, new Float64Array(rows.length));
  }

  let datesWithoutDerivedState = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const price = rows[index] as DailyPrice;
    dates.push(price.date);
    closes[index] = Number.isFinite(price.close) ? price.close : Number.NaN;
    const derivedRow = derivedByDate.get(price.date);
    if (!derivedRow) {
      datesWithoutDerivedState += 1;
    }
    for (const [key, read] of readers) {
      (columns.get(key) as Float64Array)[index] = read(price, derivedRow);
    }
  }

  let periodStartIndex = dates.length;
  for (let index = 0; index < dates.length; index += 1) {
    if ((dates[index] as LocalDate) >= periodStart) {
      periodStartIndex = index;
      break;
    }
  }

  return {
    frame: createEvaluationFrame({
      securityId: security.id,
      symbol: security.symbol,
      name: security.name,
      dates,
      closes,
      columns,
      periodStartIndex,
    }),
    diagnostics: { datesWithoutDerivedState },
  };
}

const SERIES_PREFIX = "series:";
const MARGIN_OF_SAFETY_PREFIX = "margin-of-safety:";

function columnReaderFor(key: OperandKey): ColumnReader {
  if (key.startsWith(SERIES_PREFIX)) {
    return seriesReader(key.slice(SERIES_PREFIX.length));
  }
  if (key.startsWith(MARGIN_OF_SAFETY_PREFIX)) {
    const readIntrinsic = seriesReader(
      key.slice(MARGIN_OF_SAFETY_PREFIX.length),
    );
    return (price, derived) => {
      const intrinsic = readIntrinsic(price, derived);
      const close = price.close;
      // Margin of Safety divides by intrinsic value, never by price, and is NOT_EVALUABLE when the
      // intrinsic value is not positive: the ratio is undefined at zero and sign-inverted below it.
      if (
        !Number.isFinite(intrinsic) ||
        intrinsic <= 0 ||
        !Number.isFinite(close)
      ) {
        return Number.NaN;
      }
      return ((intrinsic - close) / intrinsic) * 100;
    };
  }
  throw new Error(`Unsupported evaluation operand '${key}'`);
}

/**
 * Resolves a catalog series to its read, through the canonical catalog rather than by parsing an id
 * or matching a label.
 */
function seriesReader(seriesId: string): ColumnReader {
  const series = findSelectableSeries(seriesId as SelectableSeriesId);
  if (!series) {
    throw new Error(`Unknown selectable series '${seriesId}'`);
  }
  const source = series.source;
  switch (source.kind) {
    case "MOVING_AVERAGE":
    case "OSCILLATOR": {
      const field = source.field;
      return (_price, derived) => numberOrNaN(derived?.[field]);
    }
    case "INTRINSIC_VALUE_MODEL": {
      const model = source.model;
      return (_price, derived) => {
        if (
          !derived ||
          intrinsicModelSourceAsOf(derived, model) === undefined
        ) {
          // A model value is only readable together with its own provenance instant.
          return Number.NaN;
        }
        return numberOrNaN(derived.intrinsicValues?.[model]);
      };
    }
    case "INTRINSIC_VALUE_BLEND": {
      const blendId = source.blendId;
      return (_price, derived) => {
        if (!derived || blendSourceDataAsOf(derived, blendId) === undefined) {
          // Blend provenance is the maximum of the models composing it, and is undefined unless
          // every required component value and instant is present.
          return Number.NaN;
        }
        return numberOrNaN(derived.intrinsicValueBlends?.[blendId]);
      };
    }
  }
}

function numberOrNaN(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : Number.NaN;
}

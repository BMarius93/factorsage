import {
  findSelectableSeries,
  type StrategyEtfSourceCode,
} from "@intrinsic/contracts";
import { relativeVolumeDefinition } from "@intrinsic/domain";
import {
  createEvaluationFrame,
  decodeEtfOperand,
  decodeSectorOperand,
  operandRelativeVolumePeriod,
  operandSeriesId,
  PRICE_OPERAND,
  type EvaluationFrame,
  type OperandKey,
} from "@intrinsic/strategy";
import {
  benchmarkTechnicalValueOn,
  type BenchmarkTechnicalField,
  type BenchmarkTechnicalSnapshot,
} from "./benchmark-technicals.js";

/**
 * Joins ETF technical columns onto one security's evaluation frame, by exact session date.
 *
 * The frames and the evaluator stay unchanged: an ETF reading is one more operand column, exactly
 * as an alternative-data or valuation column is, so the gates, the year windows, the context rows
 * and the Monitor reducer all carry it with no special case. The join is strict: a frame session
 * the ETF has no finalized bar for reads NaN — pre-listing, a holiday the stock traded through, a
 * provider gap, a session the ETF's end-of-day bar has not been synchronized for — and the
 * evaluator reports `NOT_EVALUABLE` there, never a carried-forward reading. An ETF whose snapshot
 * is missing entirely (its coverage gate failed, or its read failed this run or cycle) joins
 * all-NaN columns, so exactly the conditions naming it degrade and nothing else does.
 *
 * **Stock's Sector** keys (`sector:…`) name no fund: they are joined from the snapshot of
 * `sectorCode`, the sector ETF this frame's security resolved to. A security with no resolved
 * sector — `null` — joins all-NaN columns, so its Stock's Sector rules are `NOT_EVALUABLE` and no
 * other fund ever stands in.
 *
 * Only keys of the ETF and Stock's Sector families are accepted, and every one must decode to a
 * snapshot field: an undecodable key is refused rather than joined as an always-absent column, the
 * same fail-closed stance the per-security projector takes on a key it does not know.
 */
export function withEtfOperandColumns(
  frame: EvaluationFrame,
  operands: readonly OperandKey[],
  snapshots: ReadonlyMap<StrategyEtfSourceCode, BenchmarkTechnicalSnapshot>,
  sectorCode: StrategyEtfSourceCode | null = null,
): EvaluationFrame {
  if (operands.length === 0) {
    return frame;
  }
  const columns = new Map(frame.columns);
  for (const key of operands) {
    const sectorBase = decodeSectorOperand(key);
    const decoded =
      sectorBase !== null
        ? { code: sectorCode, base: sectorBase }
        : decodeEtfOperand(key);
    if (!decoded) {
      throw new Error(`Unsupported ETF evaluation operand: ${key}`);
    }
    const field = etfSnapshotField(decoded.base);
    const snapshot =
      decoded.code === null ? undefined : snapshots.get(decoded.code);
    const column = new Float64Array(frame.dates.length).fill(Number.NaN);
    if (snapshot) {
      frame.dates.forEach((date, index) => {
        column[index] = benchmarkTechnicalValueOn(snapshot, date, field);
      });
    }
    columns.set(key, column);
  }
  return createEvaluationFrame({
    securityId: frame.securityId,
    symbol: frame.symbol,
    name: frame.name,
    dates: frame.dates,
    closes: frame.closes,
    columns,
    periodStartIndex: frame.periodStartIndex,
  });
}

/**
 * The snapshot field behind one stock-encoded operand: the close for `price`, the catalog's own
 * materialization field for a moving average or oscillator, the registry's field for a Relative
 * Volume period. Anything else — an intrinsic series, a fundamental, a valuation ratio — is refused:
 * no such metric is ETF-compatible and no snapshot holds a field for it.
 */
function etfSnapshotField(base: OperandKey): BenchmarkTechnicalField | "close" {
  if (base === PRICE_OPERAND) {
    return "close";
  }
  const seriesId = operandSeriesId(base);
  if (seriesId !== null) {
    const series = findSelectableSeries(seriesId);
    if (
      series &&
      (series.source.kind === "MOVING_AVERAGE" ||
        series.source.kind === "OSCILLATOR")
    ) {
      return series.source.field;
    }
    throw new Error(`Unsupported ETF evaluation operand: ${base}`);
  }
  const period = operandRelativeVolumePeriod(base);
  if (period !== null) {
    return relativeVolumeDefinition(period).field;
  }
  throw new Error(`Unsupported ETF evaluation operand: ${base}`);
}

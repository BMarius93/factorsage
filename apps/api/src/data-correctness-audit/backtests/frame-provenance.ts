import { ComparisonLedger } from "../comparison";
import { ORACLE_FUNDAMENTAL_METRICS } from "../oracle/fundamentals";
import { INDICATORS } from "../oracle/indicators";
import type { BlendId, ModelId, Valuation } from "../oracle/intrinsic";
import {
  TECHNICAL_TOLERANCE,
  type SecurityIndicators,
} from "../technicals/run-technicals-audit";
import type { BacktestArchive } from "./archive-reader";

/**
 * Frame provenance: every operand value a backtest decided from, against the reference series
 * recomputed from raw closes and raw statements.
 *
 * This is what links the reference backtester (which reads the archive's frames) back to source
 * data: a frame value that disagrees with the independent indicator or intrinsic value would make
 * the backtest oracle agree with a wrong input.
 *
 * A Fundamental Metric column (`fundamental:<id>`) is traced to the persisted `DailyDerivedState`
 * value it must be a projection of, read by the audit itself from the column its own identity table
 * names (`FUNDAMENTAL_PROVENANCE_COLUMNS`, the ADR's Scope table as the independent oracle states
 * it). The comparison is exact — the frame reads the stored decimal — so a column projected from
 * another metric's field, an absence read as zero, a value scaled by 100 either way, or a value
 * shifted onto a neighbouring session all fail. Whether the stored value itself is right is the
 * `fundamentals` section's question, answered against the oracle from raw statements. A Fundamental
 * the strategy names that a frame does not carry, an identity this table does not know, and a session
 * inside the stored history with no stored row are failures, never skips.
 */

/**
 * The audit's own identity -> `DailyDerivedState` column map for the Fundamental Metrics.
 *
 * Built from the oracle's literal table rather than from `fundamentalMetricDefinition`, because the
 * projector's mapping is exactly what this audit checks.
 */
export const FUNDAMENTAL_PROVENANCE_COLUMNS: Readonly<Record<string, string>> =
  Object.fromEntries(
    ORACLE_FUNDAMENTAL_METRICS.map((metric) => [metric.id, metric.column]),
  );

const FUNDAMENTAL_OPERAND_PREFIX = "fundamental:";

/** One security's persisted Fundamental Metrics, one entry per stored trading session. */
export type FundamentalReference = {
  readonly dates: readonly string[];
  /** Keyed by column: the stored value on `dates[i]`, or `null` where the column is `NULL`. */
  readonly stored: Readonly<Record<string, readonly (number | null)[]>>;
};

/**
 * The Fundamental Metric identities a snapshot's strategy names, read from the definition document
 * itself (plain data) rather than through the product's operand collection.
 */
export function referencedFundamentalIds(definition: unknown): string[] {
  const ids = new Set<string>();
  const document = (definition ?? {}) as {
    buyLevels?: { signal?: unknown }[];
    sellLevels?: { signal?: unknown }[];
    finalExit?: { rules?: { signal?: unknown }[]; signal?: unknown };
  };
  const signals = [
    ...(document.buyLevels ?? []).map((level) => level.signal),
    ...(document.sellLevels ?? []).map((level) => level.signal),
    ...(document.finalExit?.rules ?? []).map((rule) => rule.signal),
    ...(document.finalExit?.signal ? [document.finalExit.signal] : []),
  ];
  for (const signal of signals) {
    const { conditions = [], trigger } = (signal ?? {}) as {
      conditions?: { metric?: { kind?: string; metricId?: unknown } }[];
      trigger?: { metric?: { kind?: string; metricId?: unknown } };
    };
    for (const predicate of [...conditions, ...(trigger ? [trigger] : [])]) {
      if (predicate.metric?.kind === "FUNDAMENTAL") {
        ids.add(String(predicate.metric.metricId));
      }
    }
  }
  return [...ids].sort();
}

const INDICATOR_BY_SERIES = new Map(
  INDICATORS.map((indicator) => [indicator.seriesId, indicator.column]),
);
const MODEL_BY_SERIES: Record<string, ModelId> = {
  DCF_FCFF: "DCF_FCFF",
  RESIDUAL_INCOME: "RESIDUAL_INCOME",
  DDM: "DDM",
  GRAHAM: "GRAHAM",
};
const BLEND_BY_SERIES: Record<string, BlendId> = {
  BALANCED: "BALANCED",
  CONSERVATIVE: "CONSERVATIVE",
  DIVIDEND: "DIVIDEND",
};

export class FrameProvenance {
  readonly ledger = new ComparisonLedger(200);
  private readonly seen = new Set<string>();
  private readonly intrinsicIndex = new Map<string, Map<string, number>>();
  readonly byKey: Record<string, { compared: number; failed: number }> = {};

  private readonly fundamentalIndex = new Map<string, Map<string, number>>();

  constructor(
    private readonly technicals: ReadonlyMap<string, SecurityIndicators>,
    private readonly intrinsic: ReadonlyMap<
      string,
      { dates: string[]; valuations: Valuation[] }
    >,
    private readonly fundamentals: ReadonlyMap<
      string,
      FundamentalReference
    > = new Map(),
  ) {}

  /** The persisted value of one Fundamental column, `null` when NULL, `undefined` without a row. */
  private fundamentalValue(
    securityId: string,
    date: string,
    column: string,
  ): number | null | undefined {
    const reference = this.fundamentals.get(securityId);
    if (!reference) {
      return undefined;
    }
    let positions = this.fundamentalIndex.get(securityId);
    if (!positions) {
      positions = new Map(
        reference.dates.map((value, position) => [value, position]),
      );
      this.fundamentalIndex.set(securityId, positions);
    }
    const position = positions.get(date);
    if (position === undefined) {
      return undefined;
    }
    return reference.stored[column]?.[position] ?? null;
  }

  /**
   * Why a Fundamental on `date` has no stored value to trace, when that is itself a finding: a
   * security with no stored reference at all, or a session inside its stored history that has no
   * row. `null` for a session outside the stored history, which is a skip like any other operand's.
   */
  private fundamentalGap(securityId: string, date: string): string | null {
    const reference = this.fundamentals.get(securityId);
    if (!reference) {
      return "a stored Fundamental reference for this security";
    }
    const first = reference.dates[0];
    const last = reference.dates.at(-1);
    return first !== undefined &&
      last !== undefined &&
      date >= first &&
      date <= last
      ? "a stored DailyDerivedState row for this session"
      : null;
  }

  private intrinsicValue(
    securityId: string,
    date: string,
    seriesId: string,
  ): number | null | undefined {
    const reference = this.intrinsic.get(securityId);
    if (!reference) {
      return undefined;
    }
    let positions = this.intrinsicIndex.get(securityId);
    if (!positions) {
      positions = new Map(
        reference.dates.map((value, position) => [value, position]),
      );
      this.intrinsicIndex.set(securityId, positions);
    }
    const index = positions.get(date) ?? -1;
    if (index < 0) {
      return undefined;
    }
    const valuation = reference.valuations[index]!;
    const model = MODEL_BY_SERIES[seriesId];
    if (model) {
      const outcome = valuation.models[model];
      return outcome.status === "VALUE" ? outcome.value : null;
    }
    const blend = BLEND_BY_SERIES[seriesId];
    if (blend) {
      return valuation.blends[blend]?.value ?? null;
    }
    return undefined;
  }

  audit(archive: BacktestArchive): void {
    const { startDate, endDate } = archive.snapshot.period;
    const dateIndex = new Map<string, Map<string, number>>();
    const referencedFundamentals = referencedFundamentalIds(
      archive.snapshot.strategy.definition,
    );
    for (const frame of archive.frames) {
      // Every Fundamental the strategy names must be a column of every frame it projected: a missing
      // one reads NaN in the evaluator — NOT_EVALUABLE on every session — and would pass silently.
      for (const id of referencedFundamentals) {
        const key = `${FUNDAMENTAL_OPERAND_PREFIX}${id}`;
        if (!(key in frame.operands)) {
          this.ledger.check(
            "frame-provenance",
            `${frame.symbol} ${frame.year} ${key}`,
            "projected",
            "missing from the frame",
            "exact-text",
          );
          const stats = (this.byKey[key] ??= { compared: 0, failed: 0 });
          stats.compared += 1;
          stats.failed += 1;
        }
      }
      const technical = this.technicals.get(frame.securityId);
      if (!technical) {
        continue;
      }
      let index = dateIndex.get(frame.securityId);
      if (!index) {
        index = new Map(
          technical.dates.map((date, position) => [date, position]),
        );
        dateIndex.set(frame.securityId, index);
      }
      frame.dates.forEach((date, row) => {
        if (date < startDate || date > endDate) {
          return;
        }
        const position = index!.get(date);
        const close = frame.closes[row];
        for (const [key, column] of Object.entries(frame.operands)) {
          const signature = `${frame.securityId}|${key}|${date}`;
          if (this.seen.has(signature)) {
            continue;
          }
          this.seen.add(signature);
          const actual = column[row] ?? null;
          const stats = (this.byKey[key] ??= { compared: 0, failed: 0 });
          let expected: number | null | undefined;
          let tolerance = 0;
          if (key.startsWith("series:")) {
            const seriesId = key.slice("series:".length);
            const indicator = INDICATOR_BY_SERIES.get(seriesId);
            if (indicator) {
              expected =
                position === undefined
                  ? undefined
                  : (technical.values.get(indicator)![position] ?? null);
              tolerance =
                expected === null || expected === undefined
                  ? 0
                  : TECHNICAL_TOLERANCE(expected);
            } else {
              expected = this.intrinsicValue(frame.securityId, date, seriesId);
              tolerance =
                expected === null || expected === undefined
                  ? 0
                  : 0.5e-8 + 1e-12 * Math.abs(expected);
            }
          } else if (key.startsWith(FUNDAMENTAL_OPERAND_PREFIX)) {
            const id = key.slice(FUNDAMENTAL_OPERAND_PREFIX.length);
            const storedColumn = FUNDAMENTAL_PROVENANCE_COLUMNS[id];
            if (storedColumn === undefined) {
              // An identity the audit does not know is a finding, never a skip: a sixteenth metric
              // reaching the frames before the audit tooling knows it must be visible.
              stats.compared += 1;
              stats.failed += 1;
              this.ledger.check(
                "frame-provenance",
                `${frame.symbol} ${date} ${key}`,
                "a Fundamental Metric the audit tooling recognises",
                id,
                "exact-text",
              );
              continue;
            }
            // Exact: the frame must carry the stored decimal itself, so no tolerance is set.
            expected = this.fundamentalValue(
              frame.securityId,
              date,
              storedColumn,
            );
            const gap =
              expected === undefined
                ? this.fundamentalGap(frame.securityId, date)
                : null;
            if (gap !== null) {
              // Never a skip: the evaluator read NaN — NOT_EVALUABLE — on a session the stored
              // history should have covered, and nothing could say whether that was right.
              stats.compared += 1;
              stats.failed += 1;
              this.ledger.check(
                "frame-provenance",
                `${frame.symbol} ${date} ${key}`,
                gap,
                "none",
                "exact-text",
              );
              continue;
            }
          } else if (key.startsWith("margin-of-safety:")) {
            const iv = this.intrinsicValue(
              frame.securityId,
              date,
              key.slice("margin-of-safety:".length),
            );
            if (iv === undefined) {
              expected = undefined;
            } else if (iv === null || !(iv > 0) || typeof close !== "number") {
              expected = null;
            } else {
              expected = ((iv - close) / iv) * 100;
              // The stored IV is quantized at 8 decimals: the MOS it yields can differ by
              // |∂MOS/∂IV| x 0.5e-8 = 100 x close / IV² x 0.5e-8.
              tolerance = ((100 * Math.abs(close)) / (iv * iv)) * 1e-8 + 1e-9;
            }
          }
          if (expected === undefined) {
            this.ledger.skip(
              "frame-provenance",
              `${frame.symbol} ${date} ${key}`,
              "no reference row for this date",
            );
            continue;
          }
          stats.compared += 1;
          const ok =
            expected === null ||
            actual === null ||
            key.startsWith(FUNDAMENTAL_OPERAND_PREFIX)
              ? this.ledger.check(
                  "frame-provenance",
                  `${frame.symbol} ${date} ${key}`,
                  expected,
                  actual,
                  "exact-number",
                )
              : this.ledger.check(
                  "frame-provenance",
                  `${frame.symbol} ${date} ${key}`,
                  expected,
                  actual,
                  {
                    tolerance,
                    justification:
                      "reference series at the stored Decimal(20,8) scale",
                  },
                );
          if (!ok) {
            stats.failed += 1;
          }
        }
      });
    }
  }
}

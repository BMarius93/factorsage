import { ComparisonLedger } from "../comparison";
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
 */

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

  constructor(
    private readonly technicals: ReadonlyMap<string, SecurityIndicators>,
    private readonly intrinsic: ReadonlyMap<
      string,
      { dates: string[]; valuations: Valuation[] }
    >,
  ) {}

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
    for (const frame of archive.frames) {
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
            expected === null || actual === null
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

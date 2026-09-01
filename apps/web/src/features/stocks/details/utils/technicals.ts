import type { DailyTechnicalResponse } from "@intrinsic/contracts";

/**
 * Latest-row projection over the daily technical series for the summary panel.
 *
 * Indicators the backend has not warmed up yet are simply absent — they are never rendered as
 * zero. Values are taken from the newest technical row as-is; the only derivation is the
 * display-level position of the close relative to each average.
 */
export type TechnicalIndicatorKey = keyof Omit<DailyTechnicalResponse, "date">;

export type TechnicalReading = {
  key: TechnicalIndicatorKey;
  label: string;
  value: number;
};

export type TechnicalSnapshot = {
  date: string;
  readings: TechnicalReading[];
};

export const TECHNICAL_INDICATORS: ReadonlyArray<{
  key: TechnicalIndicatorKey;
  label: string;
}> = [
  { key: "sma20d", label: "SMA 20" },
  { key: "sma50d", label: "SMA 50" },
  { key: "sma100d", label: "SMA 100" },
  { key: "sma200d", label: "SMA 200" },
  { key: "ema20d", label: "EMA 20" },
  { key: "ema50d", label: "EMA 50" },
  { key: "ema200d", label: "EMA 200" },
];

/** Expects ascending rows; `undefined` when there are no rows or the last row has no values. */
export function selectLatestTechnicals(
  technicals: readonly DailyTechnicalResponse[],
): TechnicalSnapshot | undefined {
  const latest = technicals.at(-1);
  if (!latest) {
    return undefined;
  }
  const readings = TECHNICAL_INDICATORS.flatMap(({ key, label }) => {
    const value = latest[key];
    return value === undefined ? [] : [{ key, label, value }];
  });
  return readings.length > 0 ? { date: latest.date, readings } : undefined;
}

/**
 * Position of the close relative to an average, as a fraction of the average
 * (`0.02` means the price is 2% above it).
 */
export function priceVersusAverage(
  close: number,
  average: number,
): number | undefined {
  if (!Number.isFinite(average) || average <= 0) {
    return undefined;
  }
  return (close - average) / average;
}

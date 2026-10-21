import {
  findSelectableSeries,
  STOCK_SUMMARY_TECHNICAL_IDS,
  type StockSummaryReadingResponse,
  type StockSummaryTechnicalId,
} from "@intrinsic/contracts";

/**
 * The compact Technicals card's rows: EMA 50D, EMA 200D and RSI 14D — and only those.
 *
 * The identities are the contract's one list (`STOCK_SUMMARY_TECHNICAL_IDS`); each row's label and
 * kind come from the canonical selectable-series catalog, so the card, the `Indicators` control and
 * the chart legend cannot drift apart. Every other moving average and oscillator stays in the
 * catalog and in the chart. Values are the API's readings as-is: the only derivation is the
 * display-level position of the close against a moving average, which is never computed for an
 * oscillator — RSI is a unitless reading, not a price level.
 */
export type TechnicalRow = {
  readonly id: StockSummaryTechnicalId;
  readonly label: string;
  /** `average` is drawn as a price and compared with the close; `oscillator` is unitless. */
  readonly kind: "average" | "oscillator";
  /** The session of the reading; absent when the window holds none. */
  readonly date?: string;
  readonly value?: number;
};

export const TECHNICAL_SUMMARY_SERIES: ReadonlyArray<{
  readonly id: StockSummaryTechnicalId;
  readonly label: string;
  readonly kind: TechnicalRow["kind"];
}> = STOCK_SUMMARY_TECHNICAL_IDS.map((id) => {
  const entry = findSelectableSeries(id);
  if (
    !entry ||
    (entry.source.kind !== "MOVING_AVERAGE" &&
      entry.source.kind !== "OSCILLATOR")
  ) {
    throw new Error(`${id} must be a technical series of the catalog`);
  }
  return {
    id,
    label: entry.label,
    kind: entry.source.kind === "OSCILLATOR" ? "oscillator" : "average",
  };
});

/** The card's three rows in the contract's order, each with whatever reading the API gave it. */
export function technicalRows(
  readings: readonly StockSummaryReadingResponse<StockSummaryTechnicalId>[],
): TechnicalRow[] {
  return TECHNICAL_SUMMARY_SERIES.map((series) => {
    const reading = readings.find((candidate) => candidate.id === series.id);
    return reading?.date !== undefined && reading.value !== undefined
      ? { ...series, date: reading.date, value: reading.value }
      : { ...series };
  });
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

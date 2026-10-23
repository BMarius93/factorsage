/**
 * How one cell of the annual-returns heatmap is shaded. Presentation only: the figure itself comes
 * from the canonical `backtestAnnualReturns` and is never changed here.
 *
 * Direction is the hue — the product's positive and negative state colours — and magnitude is one
 * of four fixed steps rather than a scale stretched to each run's extremes, so a +12% year looks
 * the same in every run and one outlier year cannot wash every other cell out. The value is always
 * printed in the cell with its sign as well: the shade reinforces the number, it never replaces it.
 */
export type AnnualReturnTone = "positive" | "negative" | "neutral";

export type AnnualReturnShade =
  | {
      readonly tone: AnnualReturnTone;
      /** 0 for a flat year; 1 (smallest) to 4 (largest) otherwise. */
      readonly intensity: 0 | 1 | 2 | 3 | 4;
    }
  | { readonly tone: "unavailable"; readonly intensity: 0 };

/**
 * The lower bound, in percent of absolute annual return, of shading steps 2, 3 and 4. Step 1 is
 * anything above zero and below the first.
 */
export const ANNUAL_RETURN_SHADE_STEPS = [5, 15, 30] as const;

export function annualReturnShade(
  returnPercent: number | null,
): AnnualReturnShade {
  if (returnPercent === null || !Number.isFinite(returnPercent)) {
    return { tone: "unavailable", intensity: 0 };
  }
  if (returnPercent === 0) {
    return { tone: "neutral", intensity: 0 };
  }
  const magnitude = Math.abs(returnPercent);
  const [second, third, fourth] = ANNUAL_RETURN_SHADE_STEPS;
  const intensity =
    magnitude >= fourth
      ? 4
      : magnitude >= third
        ? 3
        : magnitude >= second
          ? 2
          : 1;
  return { tone: returnPercent > 0 ? "positive" : "negative", intensity };
}

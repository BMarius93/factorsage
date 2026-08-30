/**
 * Shared discounting primitives for the multi-period models.
 *
 * The forecast sum is evaluated period by period rather than through a closed-form geometric
 * series so the arithmetic matches the locked golden vectors exactly.
 */
export function grow(base: number, growth: number, years: number): number {
  return base * (1 + growth) ** years;
}

export function discount(value: number, rate: number, years: number): number {
  return value / (1 + rate) ** years;
}

/** Present value of `base * (1 + growth)^t` discounted at `rate`, for t = 1..years. */
export function presentValueOfGrowingSeries(
  base: number,
  growth: number,
  rate: number,
  years: number,
): number {
  let total = 0;
  for (let year = 1; year <= years; year += 1) {
    total += discount(grow(base, growth, year), rate, year);
  }
  return total;
}

/** Gordon terminal value from the final forecast flow. Caller must check the spread is positive. */
export function terminalValue(
  finalFlow: number,
  terminalGrowth: number,
  rate: number,
): number {
  return (finalFlow * (1 + terminalGrowth)) / (rate - terminalGrowth);
}
